const { z } = require('zod');
const { accessible, hasRole, audit } = require('./auth');
const { fail } = require('./errors');
const { activeTask } = require('./knowledge-catalog');

// Retain the original decision and evidence; a new review must obtain a new
// legal decision. This service is also used for explicitly authorized repairs.
async function withdrawForReconfirmation(db, user, decisionId, reason) {
  if (!hasRole(user, 'legal')) fail(403, 'FORBIDDEN', '仅法务人员可撤回最终结论');
  z.string().uuid().parse(decisionId); reason = z.string().trim().min(1).max(2000).parse(reason);
  return db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['decision-withdrawal:' + decisionId]);
    const decision = await trx('la_decisions').where({ id: decisionId }).first();
    if (!decision) fail(404, 'DECISION_NOT_FOUND', '最终结论不存在');
    const run = await trx('la_reviews').where({ id: decision.review_id }).first();
    const contract = await accessible(trx, user, run.contract_id, true);
    if (await trx('la_decision_withdrawals').where({ decision_id: decisionId }).first()) return { decisionId, withdrawn: true, idempotent: true };
    const agentSources = await trx('la_agent_legal_events').where({ contract_id: contract.id, review_id: run.id }).whereNull('revoked_at');
    for (const source of agentSources) await require('./agent/memory').revoke(trx, source.id, user, '法务结论撤回：' + reason);
    const tasks = await trx('la_learning_tasks').where({ decision_id: decisionId }).forUpdate();
    const ids = new Set(tasks.map(t => t.id)), draftIds = new Set(tasks.flatMap(t => activeTask(t).proposals.map(p => p.draftVersionId).filter(Boolean)));
    const retired = [];
    for (const [table, field] of [['la_skill_versions', 'skills'], ['la_rule_versions', 'rules']]) {
      const versions = await trx(table).whereIn('state', ['draft', 'pending', 'published']).forUpdate();
      for (const version of versions) {
        if (!draftIds.has(version.id) && !version[field].some(item => (item.sourceIds || []).some(id => ids.has(id)))) continue;
        // A shared publication needs its unrelated content preserved explicitly.
        if (version.state === 'published' && version[field].some(item => !(item.sourceIds || []).length || item.sourceIds.some(id => !ids.has(id)))) fail(409, 'SHARED_PUBLICATION_REVIEW_REQUIRED', '相关正式版本含其他来源内容，须先拆分核对后撤回');
        await trx(table).where({ id: version.id }).update({ state: 'retired', state_reason: 'confirmation_withdrawn', revision: trx.raw('revision + 1'), updated_at: trx.fn.now() }); retired.push({ table, id: version.id });
      }
    }
    await trx('la_decision_withdrawals').insert({ decision_id: decisionId, created_by: user.id, reason });
    if (ids.size) await trx('la_learning_tasks').whereIn('id', [...ids]).update({ status: 'failed', error_code: 'LEARNING_CONFIRMATION_REQUIRED', error_message: '原最终结论已撤回，等待法务重新复核并确认；原始经验依据保留。', revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
    await trx('la_learning_reorganizations').where({ contract_id: contract.id, version_id: decision.version_id }).whereIn('status', ['queued', 'running', 'ready']).update({ status: 'superseded', error_message: '最终结论已撤回，等待法务重新确认', revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
    if (contract.current_review_id === run.id && contract.current_version_id === decision.version_id) {
      if (contract.current_preanalysis_id) await trx('la_preanalyses').where({ id: contract.current_preanalysis_id }).whereIn('status', ['queued', 'running', 'ready']).update({ status: 'superseded', revision: trx.raw('revision + 1') });
      await trx('la_contracts').where({ id: contract.id }).update({ legal_status: 'pending_review', review_flow: 'agent', current_review_id: null, current_preanalysis_id: null, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
    }
    await audit(trx, user, 'review.decision_withdrawn', decisionId, { reason, contractId: contract.id, versionId: decision.version_id, learningTaskIds: [...ids], retiredVersions: retired, requiresNewReview: true });
    return { decisionId, contractId: contract.id, withdrawn: true, pausedTasks: ids.size, retiredVersions: retired, requiresNewReview: true };
  });
}

module.exports = { withdrawForReconfirmation };
