const { createGateway, providerConfig, classificationGuidance } = require('./model');
const { matchRules } = require('./rules');
const { fail } = require('./errors');
function metrics(rows) {
  const successful = rows.filter(r => !r.error), high = rows.reduce((n, r) => n + (r.highTotal||0), 0), highFound = successful.reduce((n, r) => n + r.highFound, 0);
  const tp = successful.reduce((n, r) => n + r.truePositive, 0), predicted = successful.reduce((n, r) => n + r.predictedTotal, 0);
  const ratio = (a, b) => b ? a / b : null;
  return { samples: rows.length, completed: successful.length, errors: rows.length - successful.length, classificationAccuracy: ratio(successful.filter(r => r.classificationCorrect).length, rows.length), highRiskRecall: ratio(highFound, high), precision: ratio(tp, predicted), highRiskPositives: high, verifiedReferences: successful.reduce((n, r) => n + r.references, 0), tagsMissed: successful.reduce((n, r) => n + r.tagsMissed.length, 0), evaluable: rows.length > 0 && high > 0 && predicted > 0 && successful.length === rows.length, acceptance: '需独立验收集、每类型至少20份及法务确认；本次指标不能代替上线验收' };
}
async function processEvaluation(db, id, { gateway } = {}) {
  const run = await db('la_evaluations').where({ id }).first(); if (!run || run.status === 'completed') return;
  await db('la_evaluations').where({ id }).update({ status: 'running' });
  try {
    const cases = await db('la_evaluation_cases').where({ split: run.config.split }); if (!cases.length) fail(422, 'NO_EVALUATION_CASES', '所选样本集为空');
    const published=run.config.ruleVersions || await db('la_rule_versions').where({state:'published'});
    const snapshot = { classificationGuidance: await classificationGuidance(db), model: await providerConfig(db), draftRuleVersionId: run.config.draftRuleVersionId, draftRevision: run.config.draftRevision, ruleVersions: published.map(p => ({ id: p.id, packId: p.pack_id, version: p.version_no, rules: p.rules, scope: p.scope, knowledge:p.knowledge })) }; delete snapshot.model.key; delete snapshot.model.encryptedKey;
    gateway ||= createGateway(db,{pinnedModel:snapshot.model,pinnedClassificationGuidance:snapshot.classificationGuidance});
    const result = { split: run.config.split, snapshot, adapters: {} };
    for (const adapter of run.config.adapters) {
      const rows = [];
      for (const c of cases) {
        const started = Date.now(), calls = [];
        try {
          const classification = await gateway.classify(c.document, adapter, x => calls.push(x));
          let review = { checks: [], coverage: {} };
          if (run.config.includeReview) { const matched = await matchRules(db, classification,published); const retrieved=await require('./retrieval').retrieveKnowledge(db,c.document,matched);review = await gateway.review(c.document, matched.rules, retrieved.knowledge, c.expected.background || {}, x => calls.push(x)); }
          const predicted = review.checks.filter(f => f.status === 'fail').map(f => f.ruleId), expected = c.expected.riskRuleIds || [], high = c.expected.highRiskRuleIds || [];
          rows.push({ id: c.id, name: c.name, expectedType: c.expected.typeId, predictedType: classification.typeId, classificationCorrect: classification.typeId === c.expected.typeId, tagsMissed: (c.expected.tags || []).filter(t => !classification.tags.includes(t)), highTotal: high.length, highFound: high.filter(r => predicted.includes(r)).length, truePositive: predicted.filter(r => expected.includes(r)).length, predictedTotal: predicted.length, references: review.checks.reduce((n, f) => n + f.evidence.length, 0), coverage: review.coverage, elapsedMs: Date.now() - started, calls, rawScores: classification.rawScores });
        } catch (e) { rows.push({ id: c.id, name: c.name, expectedType:c.expected.typeId, highTotal:(c.expected.highRiskRuleIds||[]).length,error: e.code || 'EVALUATION_ERROR', message: e.code ? e.message : '样本评测失败', elapsedMs: Date.now() - started }); }
      }
      result.adapters[adapter] = { rows, metrics: metrics(rows) };
    }
    await db('la_evaluations').where({ id }).update({ status: 'completed', result: JSON.stringify(result), updated_at: db.fn.now() });
  } catch (e) { await db('la_evaluations').where({ id }).update({ status: 'failed', result: JSON.stringify({ code: e.code || 'EVALUATION_ERROR', message: e.code ? e.message : '评测执行失败' }), updated_at: db.fn.now() }); }
}
module.exports = { processEvaluation, metrics };
