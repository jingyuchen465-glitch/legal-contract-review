const { fail } = require('./errors');

// A classification or AI review is not a legal decision. Match the persisted
// decision to its exact contract, review and version, including cached retries.
function confirmationQuery(db) {
  return db('la_decisions as confirmed_decision')
    .join('la_reviews as confirmed_review', function () {
      this.on('confirmed_review.id', '=', 'confirmed_decision.review_id')
        .on('confirmed_review.version_id', '=', 'confirmed_decision.version_id');
    })
    .join('la_versions as confirmed_version', function () {
      this.on('confirmed_version.id', '=', 'confirmed_decision.version_id')
        .on('confirmed_version.contract_id', '=', 'confirmed_review.contract_id');
    })
    .join('la_users as confirmed_user', 'confirmed_user.id', 'confirmed_decision.decided_by')
    .whereNotExists(db('la_decision_withdrawals as withdrawn').select(db.raw('1')).whereColumn('withdrawn.decision_id', 'confirmed_decision.id'))
    .where('confirmed_review.status', 'completed')
    .whereIn('confirmed_decision.outcome', ['agree', 'conditional', 'disagree'])
    .whereRaw("COALESCE(confirmed_review.snapshot->>'reviewMode', '') <> 'trial'")
    .whereRaw("COALESCE(confirmed_review.snapshot->>'validationFixture', 'false') <> 'true'");
}

async function requireConfirmation(db, { contractId, reviewId, versionId, decisionId }) {
  let decision;
  if (contractId && reviewId && versionId) {
    const query = confirmationQuery(db).where({
      'confirmed_review.contract_id': contractId,
      'confirmed_decision.review_id': reviewId,
      'confirmed_decision.version_id': versionId,
    });
    if (decisionId) query.where('confirmed_decision.id', decisionId);
    decision = await query.select('confirmed_decision.*', 'confirmed_user.display_name as confirmedBy', 'confirmed_version.version_no as confirmedVersionNo').first();
  }
  if (!decision) fail(409, 'LEARNING_CONFIRMATION_REQUIRED', '该版本尚未经法务确认最终结论，不能生成或整理审查经验');
  return decision;
}

function requireTaskConfirmation(db, task) {
  return requireConfirmation(db, { contractId: task.contract_id, reviewId: task.review_id, versionId: task.version_id, decisionId: task.decision_id });
}

function confirmedContracts(db) {
  return db('la_contracts as c').whereExists(confirmationQuery(db).select(db.raw('1'))
    .whereColumn('confirmed_review.contract_id', 'c.id')
    .whereColumn('confirmed_decision.review_id', 'c.current_review_id')
    .whereColumn('confirmed_decision.version_id', 'c.current_version_id'));
}

async function requireItemConfirmations(db, items) {
  for (const id of new Set(items.flatMap(item => item.sourceIds || []))) {
    const task = await db('la_learning_tasks').where({ id }).first();
    if (!task) fail(409, 'LEARNING_CONFIRMATION_REQUIRED', '技能或规则的来源经验无法核实，请重新由法务确认');
    await requireTaskConfirmation(db, task);
  }
}

module.exports = { confirmationQuery, requireConfirmation, requireTaskConfirmation, requireItemConfirmations, confirmedContracts };
