const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../errors');
const { accessible } = require('../auth');
const { compareDocuments, changePage } = require('../document-changes');
const { verifyEvidence } = require('./schemas');

// Follow the actual version ancestry, including versions saved before a review
// finished. Never use another branch or an unfinished report as the baseline.
async function createBaseline(db, contract, actorId) {
  let versionId = contract.current_version_id;
  const visited = new Set();
  while (versionId && !visited.has(versionId)) {
    visited.add(versionId);
    const version = await db('la_versions').where({ id: versionId, contract_id: contract.id }).first();
    if (!version) break;
    const prior = await db('la_reviews').where({ contract_id: contract.id, version_id: versionId, engine: 'harness-v1', status: 'completed' })
      .whereNotNull('agent_result').orderBy('created_at', 'desc').orderBy('id', 'desc').first();
    if (prior) {
      const actor = await db('la_users').where({ id: actorId }).first();
      const accessContractIds = [...new Set([...(prior.snapshot.documents || []).map(d => d.contractId), ...(prior.snapshot.revisionBaseline?.accessContractIds || [])])];
      let readable = true;
      for (const id of accessContractIds) try { await accessible(db, actor, id); } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        readable = false; break;
      }
      if (!readable) { versionId = version.parent_id; continue; }
      const findings = (await db('la_findings').where({ review_id: prior.id }).orderBy('created_at').orderBy('id'))
        .filter(f => f.check_status !== 'pass').map(f => {
          const index = (prior.agent_result.findings || []).findIndex(item => item.title === f.title && item.reason === f.reason && item.suggestion === f.suggestion);
          const reconciliation = prior.agent_result.revisionReview?.items.find(item => item.findingIndexes.includes(index));
          const source = prior.snapshot.revisionBaseline?.findings.find(item => item.id === reconciliation?.previousFindingId);
          return { id: f.id, title: f.title, status: f.check_status, severity: f.severity, kind: f.kind, reason: f.reason, suggestion: f.suggestion, evidence: f.evidence, disposition: f.disposition,
            ...(!f.disposition && (source?.disposition || source?.priorDisposition) ? { priorDisposition: source.disposition || source.priorDisposition } : {}),
            ...(reconciliation?.reopenReason ? { previousReopenReason: reconciliation.reopenReason } : {}) };
        });
      // Closed issues survive the next revision, so they cannot silently become
      // "new" issues just because they no longer appear in the findings table.
      for (const item of prior.agent_result.revisionReview?.items || []) {
        if (item.findingIndexes.length) continue;
        const old = prior.snapshot.revisionBaseline?.findings.find(f => f.id === item.previousFindingId);
        if (old) findings.push({ ...old, previousResolution: { status: item.status, reason: item.reason, ...(item.resolutionBasis ? { resolutionBasis: item.resolutionBasis } : {}) } });
      }
      const messages = await db('la_agent_messages').where({ session_id: prior.agent_session_id, role: 'user' }).orderBy('created_at').orderBy('id');
      const decision = await db('la_decisions').where({ review_id: prior.id }).first();
      const withdrawal = decision && await db('la_decision_withdrawals').where({ decision_id: decision.id }).first();
      return { reviewId: prior.id, versionId: prior.version_id, versionNo: version.version_no, summary: prior.agent_result.summary, accessContractIds,
        background: prior.snapshot.background || {}, documents: prior.snapshot.documents || [], findings,
        userContext: [...new Map([...(prior.snapshot.revisionBaseline?.userContext || []), ...messages.map(m => ({ kind: m.kind, content: m.content }))].map(m => [JSON.stringify(m), m])).values()],
        decision: decision ? { outcome: decision.outcome, reason: decision.reason, conditions: decision.conditions, withdrawn: !!withdrawal } : null };
    }
    versionId = version.parent_id;
  }
  return null;
}

async function compareBaseline(db, baseline, documents, background) {
  const changes = [];
  const unmatched = [...documents];
  for (const before of baseline.documents) {
    const index = unmatched.findIndex(d => d.versionId === before.versionId);
    const replacement = index >= 0 ? index : unmatched.findIndex(d => d.contractId === before.contractId && d.role === before.role);
    const after = replacement >= 0 ? unmatched.splice(replacement, 1)[0] : null;
    if (!after) { changes.push({ kind: 'removed_material', beforeVersionId: before.versionId, filename: before.filename }); continue; }
    const old = await db('la_versions').where({ id: before.versionId, contract_id: before.contractId, sha256: before.sha256 }).first();
    const compared = old?.parsed ? compareDocuments(after, old.parsed) : null;
    const comparison = compared?.summary || { complete: false };
    changes.push({ kind: comparison.complete ? comparison.changed ? 'text_changed' : 'text_unchanged' : 'comparison_unavailable',
      beforeVersionId: before.versionId, afterVersionId: after.versionId, filename: after.filename, ...comparison,
      ...(compared ? { edits: changePage({ ...after, id: after.versionId }, { ...old.parsed, id: before.versionId }, compared, 0, compared.groups.length).items } : {}) });
  }
  for (const after of unmatched) changes.push({ kind: 'added_material', afterVersionId: after.versionId, filename: after.filename });
  return { backgroundChanged: !isDeepStrictEqual(baseline.background, background || {}), documents: changes };
}

function validateRevisionReview(report, baseline, documents, changes) {
  if (!baseline) {
    if (report.revisionReview) fail(422, 'AGENT_REVISION_BASELINE', '本轮没有复核基线，不能编造上轮问题。');
    return;
  }
  const review = report.revisionReview;
  if (!review || review.baselineReviewId !== baseline.reviewId) fail(422, 'AGENT_REVISION_REQUIRED', '请读取 read_revision_baseline，并提交 revisionReview，绑定本轮 baselineReviewId。');
  const ids = new Set(), linked = new Set();
  const link = (index, allowMerged = false) => {
    if (!report.findings[index] || report.findings[index].status === 'pass' || !allowMerged && linked.has(index)) fail(422, 'AGENT_REVISION_LINK', '当前意见下标须有效；新增问题不得与上轮问题或其他新增问题重复关联。findingIndex 从0开始。');
    linked.add(index);
  };
  for (const item of review.items) {
    const old = baseline.findings.find(f => f.id === item.previousFindingId);
    if (!old || ids.has(old.id)) fail(422, 'AGENT_REVISION_COVERAGE', '上轮问题标识不存在或重复。');
    ids.add(old.id);
    item.evidence = verifyEvidence(item.evidence, documents);
    if (new Set(item.findingIndexes).size !== item.findingIndexes.length) fail(422, 'AGENT_REVISION_LINK', '同一上轮问题不能重复关联同一当前意见。');
    for (const index of item.findingIndexes) link(index, true);
    const closed = ['resolved', 'accepted'].includes(item.status);
    if (closed && item.findingIndexes.length || !closed && !item.findingIndexes.length) fail(422, 'AGENT_REVISION_STATUS', '已解决或保留法务处理的问题不得重复列为当前风险；其余问题须关联当前意见。');
    if (item.status === 'resolved' && !item.evidence.length) {
      const textChanged = changes.documents.some(d => ['text_changed', 'removed_material'].includes(d.kind));
      const unchangedResolution = old.previousResolution?.status === 'resolved' && old.previousResolution.resolutionBasis === item.resolutionBasis && !changes.backgroundChanged && changes.documents.length > 0 && changes.documents.every(d => d.kind === 'text_unchanged');
      if (!['clause_removed', 'scope_changed'].includes(item.resolutionBasis) || !(textChanged || changes.backgroundChanged || unchangedResolution)) fail(422, 'AGENT_REVISION_EVIDENCE', '已解决问题须引用当前原文；条款删除或适用范围变化时须填写 resolutionBasis，并有实际变化或已解决且材料背景未变的记录。');
    }
    const disposition = old.disposition || old.priorDisposition;
    if (item.status === 'accepted' && disposition?.action !== 'reject') fail(422, 'AGENT_REVISION_HUMAN_DECISION', '只有法务明确驳回的意见才可标为保留法务处理；认可修改建议不代表接受风险。');
    if (!closed && (disposition?.action === 'reject' || ['resolved', 'accepted'].includes(old.previousResolution?.status)) && !item.reopenReason?.trim()) fail(422, 'AGENT_REVISION_REOPEN', '重新提出法务已驳回或已解决的问题，必须在 reopenReason 说明新事实、依据或原判断错误，不能仅更换措辞。');
  }
  if (ids.size !== baseline.findings.length) fail(422, 'AGENT_REVISION_COVERAGE', '必须逐项说明上轮全部问题的处理状态，不能用意见消失代替已解决。');
  for (const item of review.newFindings) {
    link(item.findingIndex);
    if (item.origin === 'introduced_by_edit' && !changes.documents.some(d => d.kind === 'text_changed')) fail(422, 'AGENT_REVISION_ORIGIN', '没有确认正文变化，不能声称风险由本次修改引入。');
    if (item.origin === 'new_material' && !changes.backgroundChanged && !changes.documents.some(d => ['added_material', 'removed_material'].includes(d.kind))) fail(422, 'AGENT_REVISION_ORIGIN', '材料与背景没有新增或移除，不能将新增意见归因于新增材料。');
  }
  if (report.findings.some((f, i) => f.status !== 'pass' && !linked.has(i))) fail(422, 'AGENT_REVISION_LINK', '所有当前风险或待确认意见都须说明与上轮问题的关系或新增原因。');
}

function revisionReviewText(run) {
  const review = run.agent_result?.revisionReview, baseline = run.snapshot?.revisionBaseline;
  if (!review) return '';
  const states = { resolved: '已解决', partial: '部分解决', unresolved: '未解决', accepted: '保留法务处理', uncertain: '待核实' };
  const origins = { introduced_by_edit: '修改引入', previously_missed: '上轮漏检', new_material: '材料或背景变化', changed_assessment: '判断修正' };
  return [`对照 v${baseline?.versionNo || ''}；基线报告：${review.baselineReviewId}`,
    ...review.items.map(item => `${states[item.status]} · ${baseline?.findings.find(f => f.id === item.previousFindingId)?.title || '上轮问题'}\n${item.reason}${item.reopenReason ? '\n重新提出的依据：' + item.reopenReason : ''}${item.evidence.map(e => '\n当前原文：' + e.quote).join('')}`),
    ...review.newFindings.map(item => `新增 · ${origins[item.origin]} · ${run.agent_result.findings[item.findingIndex]?.title || ''}\n${item.reason}`),
    '复核结果不代替最终法务结论。'].join('\n\n');
}

module.exports = { createBaseline, compareBaseline, validateRevisionReview, revisionReviewText };
