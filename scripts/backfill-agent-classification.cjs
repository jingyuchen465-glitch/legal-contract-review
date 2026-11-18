const { classificationForReport } = require('../backend/pilot/agent/classification');

async function backfill(db, { apply = false } = {}) {
  return db.transaction(async trx => {
    const contracts = await trx('la_contracts').whereNotNull('current_review_id').orderBy('id').forUpdate();
    const changes = [];
    for (const contract of contracts) {
      // Repair missing metadata only. Existing classifications remain authoritative.
      if (contract.classification?.typeId || contract.classification?.typeName) continue;
      const run = await trx('la_reviews').where({ id: contract.current_review_id, contract_id: contract.id, version_id: contract.current_version_id, engine: 'harness-v1', status: 'completed' }).first();
      if (!run) continue;
      const classification = classificationForReport(contract, run, run.agent_result || {});
      if (!classification) continue;
      changes.push({ contractId: contract.id, reviewId: run.id, classification });
      if (apply) {
        await trx('la_contracts').where({ id: contract.id }).update({ classification: JSON.stringify(classification), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
        await require('../backend/pilot/auth').audit(trx, null, 'agent.classification.backfill', contract.id, { reviewId: run.id, versionId: run.version_id, typeId: classification.typeId });
      }
    }
    return { applied: apply, changes };
  });
}

if (require.main === module) {
  const db = require('../backend/pilot/db').createDb();
  backfill(db, { apply: process.argv.includes('--apply') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.code || 'CLASSIFICATION_BACKFILL_FAILED'); process.exitCode = 1; })
    .finally(() => db.destroy());
}

module.exports = { backfill };
