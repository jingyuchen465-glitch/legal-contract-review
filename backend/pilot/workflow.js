const agent = require('./agent/service');
const { ENGINE } = require('./agent/config');
async function enqueueReview(db, contract, actorId, options = {}) {
  if (contract.source_data?.autoReviewBatchId) return null;
  if (contract.source_data?.jointIntakeId && (contract.source_data.jointHidden || !contract.source_data.jointGroupId)) return null;
  return (await agent.createSession(db, contract, actorId, options)).reviewId;
}
async function processReview(db, reviewId, options = {}) {
  const run = await db('la_reviews').where({ id: reviewId }).first();
  if (!run) return;
  if (run.engine !== ENGINE) {
    if (!['completed', 'cancelled'].includes(run.status)) await db('la_reviews').where({ id: run.id }).update({ status: 'cancelled', stage: 'engine_retired', error_code: 'REVIEW_ENGINE_RETIRED', error_message: '旧审查引擎已退役，历史记录保留；请创建新的 Agent 审查。', updated_at: db.fn.now() });
    return;
  }
  return agent.processReview(db, reviewId, options);
}
module.exports = { enqueueReview, processReview };
