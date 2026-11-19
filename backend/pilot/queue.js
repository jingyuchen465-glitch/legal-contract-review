const { PgBoss } = require('pg-boss');
const { config } = require('./config');
const { processReview } = require('./workflow');
const { processEvaluation } = require('./evaluation');
const { processConversion } = require('./conversion');
async function createQueue(db, options = {}) {
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'legal_queue' });
  boss.on('error', e => console.error(JSON.stringify({ service: 'queue', error: e.code || 'QUEUE_ERROR' })));
  await boss.start();
  const integrationQueues = ['integration', 'integration-live', 'integration-reconcile'];
  for (const queue of ['agent-review', 'agent-memory', 'review', 'conversion', 'pdf-word', 'evaluation', 'intake-analysis', 'auto-review-batch', ...integrationQueues]) { const settings = { retryLimit: 2, retryDelay: 10, heartbeatSeconds: 30, expireInSeconds: 7200, retentionSeconds: 30 * 86400 }; await boss.createQueue(queue, settings); await boss.updateQueue(queue, settings); }
  let dispatching = false;
  async function dispatch() {
    if (dispatching) return; dispatching = true;
    try {
      // Fixed UUID job IDs make send-before-mark crash recovery idempotent.
      await db.transaction(async trx => {
        const rows = await trx('la_outbox').whereNull('sent_at').orderBy('created_at').limit(50).forUpdate().skipLocked();
        for (const row of rows) {
          if (['preanalysis', 'learning', 'learning-reorganization'].includes(row.queue)) { await trx('la_outbox').where({ id: row.id }).update({ sent_at: trx.fn.now(), retired_at: trx.fn.now(), retired_reason: 'REVIEW_ENGINE_RETIRED' }); continue; }
          await boss.send(row.queue, row.payload, { id: row.id, retryLimit: 2, retryDelay: 10, heartbeatSeconds: 30, expireInSeconds: 7200 }); await trx('la_outbox').where({ id: row.id }).update({ sent_at: trx.fn.now() });
        }
      });
    } catch (e) { console.error(JSON.stringify({ service: 'outbox', error: e.code || 'DISPATCH_FAILED' })); } finally { dispatching = false; }
  }
  if (options.work !== false) {
    await require('./word-conversions').recover(db);
    await boss.work('pdf-word', { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async jobs => { for (const job of jobs) await require('./word-conversions').processWordConversion(db, job.data.conversionId); });
    await require('./joint-intake').recoverInterrupted(db);
    await boss.work('intake-analysis', { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async jobs => { for (const job of jobs) await require('./joint-intake').analyze(db, job.data.intakeId, job.data.token, options.intakeOptions); });
    await require('./auto-review-batch').recover(db);
    await boss.work('auto-review-batch', { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 1 }, async jobs => { for (const job of jobs) await require('./auto-review-batch').processBatch(db, job.data.batchId, options.reviewOptions); });
    await require('./agent/service').recover(db);
    await boss.work('agent-review', { batchSize: 1, localConcurrency: config.model.concurrency, pollingIntervalSeconds: 1 }, async jobs => { for (const job of jobs) await processReview(db, job.data.reviewId, options.reviewOptions); });
    await boss.work('agent-memory', { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async jobs => { for (const job of jobs) await require('./agent/memory').processMemory(db, job.data.sourceId, options.memoryOptions); });
    await boss.work('review', { batchSize: 1, localConcurrency: config.model.concurrency, pollingIntervalSeconds: 1 }, async jobs => { for (const job of jobs) { try { await processReview(db, job.data.reviewId, options.reviewOptions); } catch { /* Already recorded as failed. Network retries are bounded inside the gateway. */ } } });
    await boss.work('evaluation', { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async jobs => { for (const job of jobs) await processEvaluation(db, job.data.evaluationId, options.evaluationOptions); });
    await boss.work('conversion', { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async jobs => { for (const job of jobs) await processConversion(db, job.data.versionId, options.conversionOptions); });
    if (options.integrationHandler) for (const queue of integrationQueues) await boss.work(queue, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async jobs => { for (const job of jobs) await options.integrationHandler(job.data.eventId); });
  }
  const timer = setInterval(dispatch, 2000); await dispatch();
  return { boss, dispatch, stop: async () => { clearInterval(timer); await require('./agent/runtime').closeAll(); await boss.stop({ graceful: true, timeout: 30000 }); } };
}
module.exports = { createQueue };
