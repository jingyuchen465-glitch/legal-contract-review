const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { config } = require('../pilot/config');
const { createGateway } = require('../pilot/model');

const document = { blocks: [{ id: 'b1', text: '甲方验收后付款。' }] };
const rules = Array.from({ length: 26 }, (_, i) => ({ id: `r${i}`, title: `规则${i}` }));
function response(input) {
  return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: input.rules.map(r => ({ ruleId: r.id, status: 'pass', kind: 'clause', severity: 'low', reason: `批次${input.ruleBatchIndex}`, suggestion: '', evidence: [{ blockId: 'b1', quote: '甲方验收后付款。' }], legalRefIds: [] })) }) } }] });
}
async function fixture(fn) {
  const saved = { ...config.model };
  Object.assign(config.model, { baseUrl: 'http://localhost:9999/v1', name: 'performance-fixture', key: 'fixture-only', reviewConcurrency: 3, reviewRuleBatchSize: 5 });
  try { await fn(); } finally { Object.assign(config.model, saved); }
}

test('progress labels count out-of-order completions, skill groups and legacy records without using stage percentages', async () => {
  const { reviewProgress } = await import('../../frontend/src/pilot/review-progress.mjs');
  const at = n => new Date(n * 1000).toISOString();
  const batch = (index, skill = 1, cached = false) => ({ stage: 'review_batch', status: 'completed', details: { chunkIndex: 1, chunkCount: 3, ruleBatchIndex: index, ruleBatchCount: 11, skillBatchIndex: skill, skillBatchCount: 2, cached } });
  const run = { stage: 'reviewing', progress: 57, created_at: at(0), steps: [{ stage: 'reviewing', created_at: at(0) }, { stage: 'review_plan', details: { totalBatches: 66, concurrency: 3 } }, batch(3), batch(2), batch(1), batch(3)] };
  const progress = reviewProgress(run, 60000);
  assert.equal(progress.completed, 3); assert.equal(progress.total, 66);
  assert.equal(progress.text, '已完成 3/66 批');
  assert.equal(progress.remainingMs, 1260000);
  run.steps.push(batch(3, 2, true));
  assert.equal(reviewProgress(run, 60000).completed, 4);
  run.steps = run.steps.filter(s => s.stage !== 'review_plan');
  assert.equal(reviewProgress(run, 60000).total, 66);
  run.steps.push({ stage: 'reviewing', created_at: at(70) });
  assert.equal(reviewProgress(run, 71000).total, 0, 'a retry starts its own batch count');
});
