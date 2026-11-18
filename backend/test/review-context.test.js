const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../pilot/config');
const { createGateway } = require('../pilot/model');

async function fixture(fn) {
  const saved = { ...config.model };
  Object.assign(config.model, { baseUrl: 'http://localhost:9999/v1', name: 'context-fixture', key: 'fixture-only', reviewRuleBatchSize: 8, reviewInputBudgetBytes: 128000 });
  try { await fn(); } finally { Object.assign(config.model, saved); }
}
function responder(requests) {
  return async (_, request) => {
    const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
    requests.push({ body, input, bytes: Buffer.byteLength(request.body) });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: input.rules.map(rule => ({ ruleId: rule.id, status: 'pass', kind: 'clause', severity: 'low', reason: '原文明确', suggestion: '', evidence: [{ blockId: input.blocks[0].id, quote: input.blocks[0].text.slice(0, 8) }], legalRefIds: [] })) }) } }] });
  };
}
const rules = Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, title: `规则${i}` }));
