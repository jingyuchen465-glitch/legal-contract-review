const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../pilot/config');
const { createGateway, validateChecks, requestJson } = require('../pilot/model');

const rules = [{ id: 'payment', title: '付款条件' }];
const document = { blocks: [{ id: 'b163', text: 'Payment is due after delivery.' }, { id: 'b164', text: '款项应在交付后支付。' }] };
const check = { ruleId: 'payment', status: 'fail', kind: 'clause', severity: 'high', reason: '付款期限不明确', suggestion: '替换为：甲方应在验收合格后【待双方确认】日内付款。', evidence: [{ blockId: 'b163', quote: '款项应在交付后支付。' }], legalRefIds: [] };
const valid = () => ({ ...structuredClone(check), evidence: [{ blockId: 'b164', quote: '款项应在交付后支付。' }] });
const response = raw => Response.json({ choices: [{ message: { content: JSON.stringify(raw) } }] });

test('HTTP 408 retries as a transient timeout with the same bounded policy and pinned configuration checks', async () => {
  let calls = 0, before = 0, after = 0; const waits = [];
  const result = await requestJson('http://localhost/model-fixture', 'fixture-only', {}, { fetchImpl: async () => ++calls < 3 ? new Response('', { status: 408 }) : Response.json({ ok: true }), sleep: async ms => waits.push(ms), beforeAttempt: async () => before++, afterResponse: async () => after++ });
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 3); assert.equal(before, 3); assert.equal(after, 3); assert.deepEqual(waits, [10000, 30000]);
  calls = 0;
  await assert.rejects(requestJson('http://localhost/model-fixture', 'fixture-only', {}, { fetchImpl: async () => { calls++; return new Response('', { status: 408 }); }, sleep: async () => {} }), { code: 'MODEL_HTTP_408', status: 503 });
  assert.equal(calls, 3);
});

async function withModel(fn) {
  const saved = { ...config.model };
  Object.assign(config.model, { baseUrl: 'http://localhost:9999/v1', name: 'recovery-test', key: 'test-only', reviewRuleBatchSize: 5 });
  try { await fn(); } finally { Object.assign(config.model, saved); }
}

test('bilingual evidence with a wrong paragraph ID is repaired only by a unique literal quote', () => {
  const raw = { checks: [structuredClone(check)] }, corrections = [];
  const checks = validateChecks(raw, rules, document, [], { onCorrection: c => corrections.push(c) });
  assert.equal(checks[0].evidence[0].blockId, 'b164');
  assert.equal(raw.checks[0].evidence[0].blockId, 'b163');
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].toBlockId, 'b164');
});

test('ambiguous, invented and out-of-chunk quotes remain rejected', () => {
  const raw = { checks: [check] };
  assert.throws(() => validateChecks(raw, rules, { blocks: [...document.blocks, { id: 'b165', text: document.blocks[1].text }] }, []), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => validateChecks({ checks: [{ ...check, evidence: [{ blockId: 'b163', quote: '凭空编写的条款' }] }] }, rules, document, []), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => validateChecks(raw, rules, { blocks: document.blocks.slice(0, 1) }, [], { allBlocks: document.blocks }), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => validateChecks(raw, rules, document, [], { allBlocks: [...document.blocks, { id: 'elsewhere', text: document.blocks[1].text }] }), { code: 'INVALID_EVIDENCE' });
});

test('invalid model fields produce a safe business error instead of an uncoded ZodError', () => {
  assert.throws(() => validateChecks({ checks: [{ ...valid(), status: 'SECRET_PROVIDER_VALUE' }] }, rules, document, []), e => {
    assert.equal(e.code, 'MODEL_OUTPUT_SCHEMA');
    assert.equal(e.status, 422);
    assert.ok(e.diagnostics.issues.some(i => i.path === 'checks.0.status'));
    assert.ok(!JSON.stringify({ message: e.message, diagnostics: e.diagnostics }).includes('SECRET_PROVIDER_VALUE'));
    return true;
  });
});

test('classification schema and evidence errors also receive bounded correction', async () => withModel(async () => {
  let calls = 0;
  const gateway = createGateway(null, { fetchImpl: async () => { calls++; return response(calls === 1 ? { typeId: 'other' } : { typeId: 'other', tags: [], uncertain: true, evidence: [{ blockId: 'b163', quote: document.blocks[1].text }] }); } });
  const result = await gateway.classify(document);
  assert.equal(calls, 2);
  assert.equal(result.evidence[0].blockId, 'b164');
}));
