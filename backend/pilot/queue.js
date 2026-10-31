const { PgBoss } = require('pg-boss');
const { config } = require('./config');
const { processReview } = require('./workflow');
const { processEvaluation } = require('./evaluation');
async function createQueue(db, options = {}) {
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'legal_queue' });
  boss.on('error', e => console.error(JSON.stringify({ service: 'queue', error: e.code || 'QUEUE_ERROR' })));
  await boss.start();
  const integrationQueues = ['integration', 'integration-live', 'integration-reconcile'];
  for (const queue of ['review', 'evaluation', ...integrationQueues]) { const settings = { retryLimit: 2, retryDelay: 10, heartbeatSeconds: 30, expireInSeconds: 7200, retentionSeconds: 30 * 86400 }; await boss.createQueue(queue, settings); await boss.updateQueue(queue, settings); }
  let dispatching = false;
  async function dispatch() {
    if (dispatching) return; dispatching = true;
    try {
      // Fixed UUID job IDs make send-before-mark crash recovery idempotent.
      await db.transaction(async trx => {
        const rows = await trx('la_outbox').whereNull('sent_at').orderBy('created_at').limit(50).forUpdate().skipLocked();
        for (const row of rows) { await boss.send(row.queue, row.payload, { id: row.id, retryLimit: 2, retryDelay: 10, heartbeatSeconds: 30, expireInSeconds: 7200 }); await trx('la_outbox').where({ id: row.id }).update({ sent_at: trx.fn.now() }); }
      });
    } catch (e) { console.error(JSON.stringify({ service: 'outbox', error: e.code || 'DISPATCH_FAILED' })); } finally { dispatching = false; }
  }
  if (options.work !== false) {
    await boss.work('review', { batchSize: 1, localConcurrency: config.model.concurrency, pollingIntervalSeconds: 1 }, async jobs => { for (const job of jobs) { try { await processReview(db, job.data.reviewId, options.reviewOptions); } catch { /* Already recorded as failed. Network retries are bounded inside the gateway. */ } } });
    await boss.work('evaluation', { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async jobs => { for (const job of jobs) await processEvaluation(db, job.data.evaluationId, options.evaluationOptions); });
    if (options.integrationHandler) for (const queue of integrationQueues) await boss.work(queue, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 3 }, async jobs => { for (const job of jobs) await options.integrationHandler(job.data.eventId); });
  }
  const timer = setInterval(dispatch, 2000); await dispatch();
  return { boss, dispatch, stop: async () => { clearInterval(timer); await boss.stop({ graceful: true, timeout: 30000 }); } };
}
module.exports = { createQueue };
