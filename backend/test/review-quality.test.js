const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateChecks } = require('../pilot/model');

test('legacy report compatibility checks structure without imposing phrase or language rules', () => {
  const check = suggestion => ({ checks: [{ ruleId: 'r', status: 'fail', kind: 'clause', severity: 'high', reason: '缺少具体约定', suggestion, evidence: [{ blockId: 'b1', quote: '甲方付款。' }], legalRefIds: [] }] });
  const rules = [{ id: 'r' }], document = { blocks: [{ id: 'b1', text: '甲方付款。' }] };
  for (const suggestion of ['不得转让。', '供方按约交货。', '明确双方结算责任的清单经双方签署后生效。', 'Delivery is due on the agreed date.']) {
    assert.equal(validateChecks(check(suggestion), rules, document, [])[0].suggestion, suggestion);
  }
  assert.throws(() => validateChecks(check('  '), rules, document, []), { code: 'SUGGESTION_REQUIRED' });
});
