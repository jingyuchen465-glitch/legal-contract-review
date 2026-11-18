const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateExperience } = require('../pilot/learning');
const { createGateway } = require('../pilot/model');
const { config } = require('../pilot/config');
const version = randomUUID();
const context = { blocks: [{ versionId: version, sourceBlockId: 'b1', text: '转租应取得出租方书面同意。' }], findings: [], snapshot: { typeId: 'other', skillPacks: [], rulePacks: [] }, restrictedTerms: ['转租承租方', '虚构承租方有限公司', 'PRIVATE-CONTRACT-123'] };
const proposal = () => ({ key: 'p1', kind: 'skill', title: '转租授权核对', reason: '对照授权条款', method: '核对转租承租方是否取得出租方书面同意。', evidence: [{ versionId: version, blockId: 'b1', quote: context.blocks[0].text }] });

test('cached role terms are allowed while real names, contract identifiers and contacts remain blocked', () => {
  for (const role of ['转租承租方', '合同所列出租方', '次承租方', '【我方】', 'Subtenant']) {
    assert.equal(validateExperience({ proposals: [{ ...proposal(), method: `核对${role}的转租授权。` }] }, { ...context, restrictedTerms: [...context.restrictedTerms, role] }).length, 1);
  }
  for (const value of ['虚构承租方有限公司', 'PRIVATE-CONTRACT-123', 'private@example.com', '13812345678']) {
    assert.throws(() => validateExperience({ proposals: [{ ...proposal(), examples: [`联系${value}核实授权。`] }] }, context), e => {
      assert.equal(e.code, 'LEARNING_OUTPUT_INVALID');
      assert.equal(e.diagnostics.issues[0].path, 'proposals.0.examples.0');
      assert.ok(['contract_specific_name', 'contact_information'].includes(e.diagnostics.issues[0].reason));
      assert.ok(!JSON.stringify(e.diagnostics).includes(value));
      return true;
    });
  }
  // Literal evidence remains unchanged and may contain the original name.
  const quote = '虚构承租方有限公司申请转租。';
  assert.equal(validateExperience({ proposals: [{ ...proposal(), evidence: [{ versionId: version, blockId: 'b1', quote }] }] }, { ...context, blocks: [{ ...context.blocks[0], text: quote }] }).length, 1);
});

test('privacy diagnostics identify every reusable field and schema errors never echo invalid values', () => {
  for (const field of ['title', 'method', 'instruction', 'conditions', 'exclusions', 'examples']) {
    const value = '虚构承租方有限公司';
    const array = ['conditions', 'exclusions', 'examples'].includes(field);
    assert.throws(() => validateExperience({ proposals: [{ ...proposal(), [field]: array ? [value] : value }] }, context), e => {
      assert.equal(e.diagnostics.issues[0].path, `proposals.0.${field}${array ? '.0' : ''}`); return true;
    });
  }
  assert.throws(() => validateExperience({ proposals: [{ ...proposal(), kind: 'PRIVATE_INVALID_VALUE' }] }, context), e => {
    assert.equal(e.diagnostics.issues[0].path, 'proposals.0.kind');
    assert.ok(!JSON.stringify(e.diagnostics).includes('PRIVATE_INVALID_VALUE')); return true;
  });
});
