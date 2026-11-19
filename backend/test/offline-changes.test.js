const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareDocuments, learningChunks, changePage } = require('../pilot/document-changes');
const doc = (id, texts) => ({ id, versionNo: id === 'old' ? 1 : 2, blocks: texts.map((text, i) => ({ id: `b${i + 1}`, text })) });

test('offline comparison keeps additions, deletions, replacements and duplicate paragraphs with their actual version anchors', () => {
  const previous = doc('old', ['合同', '重复条款', '重复条款', '收货后付款', '结束']);
  const current = doc('new', ['合同', '重复条款', '验收合格后付款', '结束', '新增保密义务']);
  const comparison = compareDocuments(current, previous);
  assert.equal(comparison.summary.complete, true);
  const changes = changePage(current, previous, comparison, 0, 20);
  assert.ok(changes.items.some(c => c.before.some(b => b.text === '收货后付款') && c.after.some(b => b.text === '验收合格后付款')));
  assert.ok(changes.items.some(c => c.kind === 'added' && c.after[0].text === '新增保密义务'));
  assert.equal(changes.items.flatMap(c => c.before).filter(b => b.text === '重复条款').length, 1);
  assert.ok(changes.items.flatMap(c => c.before).every(b => b.versionId === 'old'));
  assert.ok(changes.items.flatMap(c => c.after).every(b => b.versionId === 'new'));
  const all = learningChunks(current, previous, comparison).flat();
  for (const d of [current, previous]) for (const b of d.blocks) assert.equal(all.filter(p => p.versionId === d.id && p.sourceBlockId === b.id).map(p => p.text).join(''), b.text);
});

test('changed old and new text share model chunks even when unchanged text crosses the request limit', () => {
  const previous = doc('old', ['不变条款'.repeat(5000), '收到货物即付款', '原有末尾条款']);
  const current = doc('new', ['不变条款'.repeat(5000), '验收合格后付款', '原有末尾条款']);
  const comparison = compareDocuments(current, previous), parts = learningChunks(current, previous, comparison);
  assert.ok(parts.every(part => part.reduce((n, b) => n + b.text.length, 0) <= 16000));
  assert.ok(parts.some(part => part.some(b => b.text === '收到货物即付款') && part.some(b => b.text === '验收合格后付款')));
  assert.ok(parts.flat().every(b => b.changeId && b.sourceBlockId && b.versionId));
});

test('repeated text, reordered paragraphs, punctuation and meaningful inner spaces are not silently lost', () => {
  const previous = doc('old', ['A B', '付款义务。', '保密义务。', '重复', '重复']);
  const current = doc('new', ['AB', '保密义务。', '付款义务！', '重复']);
  const comparison = compareDocuments(current, previous), page = changePage(current, previous, comparison, 0, 1);
  assert.ok(comparison.summary.changed > 0); assert.equal(page.items.length, 1); assert.ok(page.total > 1);
  assert.ok(changePage(current, previous, comparison, 1, 20).items.length > 0);
  assert.equal(changePage(current, previous, comparison, page.total, 20).items.length, 0);
});

test('unchanged documents yield no changes, and missing baselines remain explicitly unavailable', () => {
  const current = doc('new', ['合同正文']);
  assert.equal(compareDocuments(current, doc('old', ['合同正文'])).summary.changed, 0);
  const missing = compareDocuments(current);
  assert.equal(missing.summary.complete, false);
  assert.equal(learningChunks(current, null, missing)[0][0].change, 'comparison_unavailable');
});

test('large unrelated versions fall back to an explicit range comparison without dropping either version', () => {
  const previous = doc('old', Array.from({ length: 1001 }, (_, i) => '原始' + i));
  const current = doc('new', Array.from({ length: 1001 }, (_, i) => '修改' + i));
  const comparison = compareDocuments(current, previous);
  assert.equal(comparison.summary.coarse, true);
  const all = learningChunks(current, previous, comparison).flat();
  assert.equal(all.filter(b => b.side === 'previous').length, 1001); assert.equal(all.filter(b => b.side === 'confirmed').length, 1001);
});
