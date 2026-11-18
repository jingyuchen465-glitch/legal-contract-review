const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { report: schema } = require('../pilot/agent/schemas');
const { validateRevisionReview, compareBaseline, revisionReviewText } = require('../pilot/agent/revision-review');

function fixture() {
  const versionId = randomUUID(), previousFindingId = randomUUID(), reviewId = randomUUID();
  const evidence = [{ versionId, blockId: 'p1', quote: '乙方应于月底交付。' }];
  const documents = [{ versionId, contractId: randomUUID(), role: 'main', filename: '新稿.docx', blocks: [{ id: 'p1', text: evidence[0].quote }] }];
  const baseline = { reviewId, versionNo: 1, background: {}, documents: [], findings: [{ id: previousFindingId, title: '交付日期', disposition: null }] };
  const report = { findings: [], revisionReview: { baselineReviewId: reviewId, items: [{ previousFindingId, status: 'resolved', reason: '新稿已明确交付时间。', evidence, findingIndexes: [] }], newFindings: [] } };
  return { documents, baseline, report, evidence, changes: { backgroundChanged: false, documents: [{ kind: 'text_changed' }] } };
}
test('a corrected contract can finish without inventing another finding', () => {
  const f = fixture();
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  assert.match(revisionReviewText({ agent_result: f.report, snapshot: { revisionBaseline: f.baseline } }), /已解决 · 交付日期/);
});
test('revision cannot omit, duplicate or fabricate previous issues or the baseline', () => {
  for (const mutate of [f => delete f.report.revisionReview, f => f.report.revisionReview.baselineReviewId = randomUUID(), f => f.report.revisionReview.items = [], f => f.report.revisionReview.items.push(f.report.revisionReview.items[0]), f => f.report.revisionReview.items[0].previousFindingId = randomUUID()]) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), e => /^AGENT_REVISION_/.test(e.code));
  }
  const f = fixture();
  assert.throws(() => validateRevisionReview(f.report, null, f.documents, null), { code: 'AGENT_REVISION_BASELINE' });
});
test('resolved issues require current exact evidence; deletion needs a real change', () => {
  const f = fixture(), item = f.report.revisionReview.items[0];
  item.evidence[0].versionId = randomUUID();
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_INVALID_EVIDENCE' });
  item.evidence = [];
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_EVIDENCE' });
  item.resolutionBasis = 'clause_removed';
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  f.changes.documents = [{ kind: 'text_unchanged' }];
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_EVIDENCE' });
});
test('endorsing AI advice is not accepting a risk, and rejected/resolved issues need a reopening reason', () => {
  const f = fixture(), item = f.report.revisionReview.items[0];
  item.status = 'accepted'; f.baseline.findings[0].disposition = { action: 'accept' };
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_HUMAN_DECISION' });
  f.baseline.findings[0].disposition = { action: 'reject', reason: '已按交易背景确认可保留。' };
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  item.status = 'unresolved'; item.findingIndexes = [0]; f.report.findings = [{ status: 'fail' }];
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_REOPEN' });
  item.reopenReason = '新稿新增跨境交付条件，原处理适用条件已改变。';
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  delete item.reopenReason; f.baseline.findings[0].disposition = null; f.baseline.findings[0].previousResolution = { status: 'resolved' };
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_REOPEN' });
});
test('a deleted clause stays resolved on an unchanged later save without inventing current evidence', () => {
  const f = fixture(), item = f.report.revisionReview.items[0];
  item.evidence = []; item.resolutionBasis = 'clause_removed';
  f.baseline.findings[0].previousResolution = { status: 'resolved', resolutionBasis: 'clause_removed', reason: '上轮已删除该条款。' };
  f.changes.documents = [{ kind: 'text_unchanged' }];
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  f.changes.documents[0].kind = 'comparison_unavailable';
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_EVIDENCE' });
});
test('each current risk is classified exactly once and metadata-only changes cannot introduce a risk', () => {
  const f = fixture(); f.report.findings = [{ status: 'fail' }];
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_LINK' });
  f.report.revisionReview.newFindings = [{ findingIndex: 0, origin: 'introduced_by_edit', reason: '修改引入新责任。' }];
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  f.changes.documents = [{ kind: 'text_unchanged' }];
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_ORIGIN' });
  f.report.revisionReview.newFindings[0].origin = 'previously_missed';
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  f.report.revisionReview.newFindings.push(f.report.revisionReview.newFindings[0]);
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_LINK' });
});
test('report schema preserves structured revision results while old reports still parse', () => {
  const f = fixture(), value = { ...f.report, summary: '已落实修改。', reviewedVersionIds: f.documents.map(d => d.versionId) };
  assert.deepEqual(schema.parse(value).revisionReview, value.revisionReview);
  delete value.revisionReview;
  assert.equal(schema.parse(value).revisionReview, undefined);
});
test('duplicate prior issues may merge into one current issue without generating duplicate advice', () => {
  const f = fixture(), item = f.report.revisionReview.items[0], secondId = randomUUID();
  item.status = 'unresolved'; item.findingIndexes = [0]; f.report.findings = [{ status: 'fail' }];
  f.baseline.findings.push({ ...f.baseline.findings[0], id: secondId });
  f.report.revisionReview.items.push({ ...item, previousFindingId: secondId });
  assert.doesNotThrow(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes));
  item.findingIndexes = [0, 0];
  assert.throws(() => validateRevisionReview(f.report, f.baseline, f.documents, f.changes), { code: 'AGENT_REVISION_LINK' });
});
test('comparison uses paragraph text and preserves exact before/after changes across saved Word versions', async () => {
  const f = fixture(), beforeVersionId = randomUUID();
  const before = { id: beforeVersionId, parsed: { blocks: [{ id: 'old-p1', text: f.evidence[0].quote }] } };
  const db = () => ({ where() { return this; }, async first() { return before; } });
  f.baseline.documents = [{ versionId: beforeVersionId, contractId: f.documents[0].contractId, role: 'main', filename: '旧稿.docx', sha256: 'different-file-bytes' }];
  let changes = await compareBaseline(db, f.baseline, f.documents, {});
  assert.equal(changes.documents[0].kind, 'text_unchanged');
  f.documents[0].blocks[0].text = '乙方应于次月底交付。';
  changes = await compareBaseline(db, f.baseline, f.documents, { perspective: '采购方' });
  assert.equal(changes.backgroundChanged, true);
  assert.equal(changes.documents[0].kind, 'text_changed');
  assert.equal(changes.documents[0].edits[0].before[0].text, '乙方应于月底交付。');
  assert.equal(changes.documents[0].edits[0].after[0].text, '乙方应于次月底交付。');
});
