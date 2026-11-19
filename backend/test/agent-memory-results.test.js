const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resultFor, sourceFields } = require('../pilot/agent/memory-results');

test('empty legal decisions explain missing input without fabricating a model explanation', () => {
  const source = { status: 'completed', kind: 'legal_decision', source: { outcome: 'agree', reason: '', conditions: '  ' } };
  const result = resultFor(source, {}, { count: 0 });
  assert.equal(result.resultCode, 'NO_SUBSTANTIVE_FEEDBACK');
  assert.match(result.resultText, /未填写处理理由/);
  assert.deepEqual([result.skillCount, result.experienceCount, result.generatedCount], [0, 0, 0]);
  assert.equal(sourceFields(source)[0].value, '同意');
  assert.equal(sourceFields(source)[1].value, '');
});

test('substantive inputs returning no memories retain an honest generic outcome', () => {
  const source = { status: 'completed', kind: 'explicit_feedback', source: { text: '本次特殊安排，按实际履行情况处理。' } };
  assert.equal(resultFor(source).resultCode, 'NO_REUSABLE_CONTENT');
  assert.equal(sourceFields(source)[0].value, source.source.text);
  const legal = { ...source, kind: 'legal_decision', source: { reason: '此项目使用特别安排' } };
  assert.equal(resultFor(legal).resultCode, 'NO_REUSABLE_CONTENT');
});

test('generated kinds and completed audit totals remain visible after revocation', () => {
  const result = resultFor({ status: 'completed', revoked_at: '2026-11-06' }, { skill: '2', experience: '1' }, { count: 3 });
  assert.deepEqual([result.generatedCount, result.skillCount, result.experienceCount], [3, 2, 1]);
  assert.equal(result.resultCode, 'GENERATED');
  assert.match(result.resultText, /3 条/);
});

test('pending and failed sources do not claim a completed empty result', () => {
  for (const status of ['queued', 'running', 'failed']) {
    const result = resultFor({ status });
    assert.equal(result.resultCode, status);
    assert.notEqual(result.resultCode, 'NO_REUSABLE_CONTENT');
  }
});
