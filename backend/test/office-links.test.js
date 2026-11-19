const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../../frontend/src/pilot/office-links.mjs');
const finding = { id: 'risk', title: '交付期限', reason: '期限不明', suggestion: '明确交付日期', severity: 'high', evidence: [{ blockId: 'b1', quote: '另行商议' }] };
const comment = { Id: '42', Data: { UserName: 'AI 合同预审', Text: '高风险 · 交付期限\n判断理由：期限不明\n修改建议：明确交付日期\n处理状态：AI 建议，待法务复核\n原文段落：b1' } };
test('editor links only unique anchored AI comments, never a similarly named or full-document comment', async () => {
  const { commentTargets } = await modulePromise;
  assert.equal(commentTargets(finding, [comment])[0].id, '42');
  assert.equal(commentTargets(finding, [comment, { ...comment, Id: '43' }])[0].ambiguous, true);
  assert.equal(commentTargets(finding, [{ ...comment, Data: { ...comment.Data, Text: comment.Data.Text.replace('b1', 'b10') } }])[0].id, null);
  assert.equal(commentTargets(finding, [{ ...comment, Data: { ...comment.Data, UserName: '人工法务' } }])[0].id, null);
  assert.deepEqual(commentTargets({ ...finding, evidence: [] }, [comment]), []);
  const second = { ...comment, Id: '44', Data: { ...comment.Data, Text: comment.Data.Text.replace('b1', 'b2') } };
  assert.deepEqual(commentTargets({ ...finding, evidence: [...finding.evidence, { blockId: 'b2', quote: '另行商议' }] }, [comment, second]).map(t => t.id), ['42', '44']);
});
test('connector uses editor canvas coordinates and hides offscreen, stacked or invalid anchors', async () => {
  const { connectionGeometry } = await modulePromise;
  const input = { frame: { left: 200, top: 100, right: 1100, bottom: 900 }, viewport: { left: 40, top: 120, right: 860, bottom: 760 }, anchor: { x: 600, y: 80 }, layout: { left: 200, top: 100 }, card: { left: 1120, top: 400, bottom: 600 }, list: { top: 300, bottom: 850 } };
  const line = connectionGeometry(input); assert.deepEqual(line.start, { x: 640, y: 200 }); assert.deepEqual(line.end, { x: 922, y: 333 });
  assert.equal(connectionGeometry({ ...input, anchor: { x: 600, y: -20 } }), null);
  assert.equal(connectionGeometry({ ...input, card: { ...input.card, left: 200 } }), null);
  assert.equal(connectionGeometry({ ...input, anchor: { x: NaN, y: 20 } }), null);
});
test('persistent positions read every comment without selecting, scrolling, dispatching popups or retaining SDK overrides', async () => {
  const { readCommentPositions } = await modulePromise;
  const popup = () => assert.fail('Measurement dispatched a native popup');
  const hidePopup = () => assert.fail('Measurement hid a native popup');
  const prototype = { sync_ShowComment: popup, compiledShow: popup, sync_HideComment: hidePopup, compiledHide: hidePopup,
    asc_showComment(id) { if (id === 'missing') this.compiledHide(); else this.compiledShow([id], 100, id === 'first' ? 30 : 60); },
    asc_selectComment() { assert.fail('Measurement moved the selection'); }, ViewScrollToY() { assert.fail('Measurement scrolled the document'); } };
  const api = Object.create(prototype);
  Object.defineProperty(api, 'sync_ShowComment', { value: popup, configurable: true, writable: true, enumerable: false });
  const before = Object.getOwnPropertyDescriptors(api);
  assert.deepEqual([...readCommentPositions(api, ['first', 'second', 'missing'])], [['first', { x: 100, y: 30 }], ['second', { x: 100, y: 60 }]]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(api), before);
  assert.equal(api.compiledShow, popup);
  api.asc_showComment = () => { throw new Error('SDK error'); };
  assert.throws(() => readCommentPositions(api, ['first']), /SDK error/);
  assert.equal(api.sync_ShowComment, popup); assert.equal(api.compiledHide, hidePopup);
  assert.equal(Object.hasOwn(api, 'compiledShow'), false);
});
