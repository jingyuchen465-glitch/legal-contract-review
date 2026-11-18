const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEdits, withReportEdits, suggestionForDisplay } = require('../pilot/report-edits');
const { report } = require('../pilot/agent/schemas');

function fixture() {
  const documents = [0, 1].map(i => ({ versionId: randomUUID(), blocks: [{ id: 'b1', text: `第${i}份原始约定。` }] }));
  const finding = { title: '修改交付约定', reason: '核对实际交付安排。', status: 'fail', kind: 'clause', severity: 'medium', suggestion: '按正文修改。',
    evidence: documents.map(d => ({ versionId: d.versionId, blockId: 'b1', quote: d.blocks[0].text })),
    edits: documents.map(d => ({ versionId: d.versionId, blockId: 'b1', operation: 'replace', originalText: d.blocks[0].text, newText: '供方按约交货。', reason: '明确义务' })),
  };
  return { documents, finding };
}

test('shared edit validation preserves global paths when a finding edits several files', () => {
  const { documents, finding } = fixture();
  finding.reason = '理由'.repeat(3000);
  const issues = []; validateEdits({ findings: [finding] }, documents, issues);
  assert.deepEqual(issues, []);
  finding.edits[1].originalText = '不在目标文件里的原文';
  validateEdits({ findings: [finding] }, documents, issues);
  assert.equal(issues[0].path, 'findings.0.edits.1.originalText');
});

test('ordinary and automatic review edits share immutable scope and uncertainty protections', () => {
  const { documents, finding } = fixture();
  for (const mutate of [f => { f.edits[0].versionId = randomUUID(); }, f => { f.status = 'uncertain'; }, f => { f.evidence = []; }, f => { f.edits[0].blockId = 'wrong'; }]) {
    const value = structuredClone(finding); mutate(value);
    const issues = []; validateEdits({ findings: [value] }, documents, issues);
    assert.ok(issues.length > 0);
  }
});

test('legacy report displays include structured replacement/deletion text while respecting human corrections', () => {
  const { finding } = fixture();
  const stored = { ...finding, id: 'saved-finding' }; delete stored.edits;
  const run = { agent_result: { findings: [finding] } };
  const [merged] = withReportEdits([stored], run);
  assert.match(suggestionForDisplay(merged), /供方按约交货。/);
  assert.equal(stored.edits, undefined);
  merged.edits[0] = { ...merged.edits[0], operation: 'delete', newText: '' };
  assert.match(suggestionForDisplay(merged), /删除该段正文/);
  merged.disposition = { action: 'correct', suggestion: '法务确认的具体改法。' };
  assert.equal(suggestionForDisplay(merged), '法务确认的具体改法。');
});

test('relationship scope survives parsing rather than being guessed from the number of uploads', () => {
  const { documents, finding } = fixture();
  const value = report.parse({ summary: '核对内嵌附件。', reviewedVersionIds: documents.map(d => d.versionId), findings: [finding],
    crossDocumentReview: [{ category: 'precedence', scope: 'within_document', status: 'conflict', reason: '同文件正文与附件存在不同约定。', evidence: finding.evidence.slice(0, 1) }],
  });
  assert.equal(value.crossDocumentReview[0].scope, 'within_document');
});

test('model-facing report schema comes from the same protocol used to accept submissions', () => {
  const tool = require('../pilot/agent/tools').toolDefinitions.find(t => t.name === 'submit_review');
  assert.deepEqual(tool.parameters.required, ['report']);
  const properties = tool.parameters.properties.report.properties;
  assert.ok(properties.findings.items.properties.edits.items.properties.newText);
  assert.deepEqual(properties.crossDocumentReview.items.properties.scope.enum, ['within_document', 'across_documents', 'not_applicable']);
  assert.ok(properties.revisionReview.properties.items.items.properties.findingIndexes);
});
