const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { snapshot, compare } = require('../pilot/review-learning');
const { validateMemories } = require('../pilot/agent/memory');
const { sourceFields, resultFor } = require('../pilot/agent/memory-results');

function file(paragraphs, { reply = '', resolved = false } = {}) {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="urn:word" xmlns:w14="urn:w14"><w:body>${paragraphs.map((p, i) => `<w:p w14:paraId="P${i}"><w:commentRangeStart w:id="1"/>${p}<w:commentRangeEnd w:id="1"/></w:p>`).join('')}</w:body></w:document>`));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="notes.xml"/><Relationship Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="notes-ex.xml"/></Relationships>'));
  zip.addFile('word/notes.xml', Buffer.from(`<w:comments><w:comment w:id="1" w:author="AI"><w:p w14:paraId="C1"><w:r><w:t>核实验收安排</w:t></w:r></w:p></w:comment>${reply ? `<w:comment w:id="2" w:author="法务"><w:p w14:paraId="C2"><w:r><w:t>${reply}</w:t></w:r></w:p></w:comment>` : ''}</w:comments>`));
  zip.addFile('word/notes-ex.xml', Buffer.from(`<w15:commentsEx><w15:commentEx w15:paraId="C1" w15:done="${resolved ? '1' : '0'}"/>${reply ? '<w15:commentEx w15:paraId="C2" w15:paraIdParent="C1"/>' : ''}</w15:commentsEx>`));
  return zip.toBuffer();
}
const text = value => `<w:r><w:t>${value}</w:t></w:r>`;
const proposal = text('货物') + '<w:del w:id="1" w:author="AI"><w:r><w:delText>交付</w:delText></w:r></w:del><w:ins w:id="2" w:author="AI"><w:r><w:t>验收合格</w:t></w:r></w:ins>' + text('后付款。');
const inspect = (a, b, actions, reason) => compare(snapshot(a), snapshot(b), actions, reason);

test('an untouched AI draft and formatting or comment-state changes do not create learning evidence', () => {
  const base = file([proposal]);
  const unchanged = inspect(base, base);
  assert.equal(unchanged.substantive, false);
  assert.deepEqual(unchanged.decisions, []);
  const resolved = inspect(base, file([proposal], { resolved: true }));
  assert.equal(resolved.substantive, false);
  assert.deepEqual(resolved.body.added, []);
  assert.deepEqual(resolved.commentStates, [{ text: '核实验收安排', resolved: true }]);
  assert.equal(resultFor({ kind: 'review_revision', source: { review: resolved }, status: 'completed' }).resultCode, 'REVIEW_STATUS_ONLY');
});

test('acceptance without current-text change is detected from native markup; rejection is distinct', () => {
  const base = file([proposal]);
  const accepted = inspect(base, file([text('货物验收合格后付款。')]));
  assert.equal(accepted.decisions[0].action, 'accept');
  assert.deepEqual(accepted.body.added, []);
  assert.equal(accepted.substantive, true);
  const rejected = inspect(base, file([text('货物交付后付款。')]));
  assert.equal(rejected.decisions[0].action, 'reject');
  assert.match(rejected.limitation, /原因未提供时待确认/);
});

test('undo, forged actions and ambiguous identical revisions never prove acceptance', () => {
  const base = file([proposal]), action = { action: 'accept', insertedText: '验收合格', deletedText: '交付' };
  assert.deepEqual(inspect(base, base, [action]).decisions, []);
  assert.deepEqual(inspect(base, file([text('其他内容')]), [{ ...action, insertedText: '虚构条款' }]).decisions, []);
  const duplicate = file([proposal, proposal]);
  assert.deepEqual(inspect(duplicate, file([text('货物验收合格后付款。'), proposal]), [action]).decisions, []);
});

test('human body edits and replies have evidence, pending AI material does not', () => {
  const base = file([proposal]);
  const edited = inspect(base, file([proposal + text('不合格的应返修。')], { reply: '交付不等于质量合格，付款应以验收为前提。' }), [], '适用于需要验收的采购。');
  assert.deepEqual(edited.decisions, []);
  assert.equal(edited.comments[0].kind, 'reply');
  assert.equal(edited.comments[0].context, '核实验收安排');
  assert.ok(edited.humanEvidence.includes('不合格的应返修。'));
  assert.ok(!edited.humanEvidence.includes('货物验收合格后付款。'));
  const fields = sourceFields({ kind: 'review_revision', source: { beforeVersionId: 'AI-DRAFT', afterVersionId: 'HUMAN-SAVE', review: edited } });
  assert.equal(fields[0].value, 'AI-DRAFT');
  assert.match(fields.find(f => f.label === '本次新增批注与回复').value, /交付不等于质量合格/);
});

test('moving paragraphs adds no knowledge and duplicate occurrences are counted correctly', () => {
  assert.equal(inspect(file([text('甲'), text('乙')]), file([text('乙'), text('甲')])).substantive, false);
  const result = inspect(file([text('甲'), text('甲')]), file([text('甲')]));
  assert.deepEqual(result.body.removed, ['甲']);
});

test('generated review knowledge must quote human evidence, including unescaped multiline replies', () => {
  const evidence = ['仅本次新增的验收条件。', '回复“质量”\n需要核实'];
  const memory = { kind: 'skill', title: '验收检查', description: '核实验收', content: '检查验收与付款关系。修改原因待确认。', conditions: ['适用于有验收要求的合同'], sourceQuotes: [evidence[1]] };
  assert.equal(validateMemories({ memories: [memory] }, JSON.stringify({ evidence }), [], evidence).length, 1);
  for (const quote of ['未处理的AI条款', '比较基线是法务实际打开的版本']) {
    assert.throws(() => validateMemories({ memories: [{ ...memory, sourceQuotes: [quote] }] }, JSON.stringify({ evidence, quote }), [], evidence), { code: 'MEMORY_EVIDENCE_INVALID' });
  }
});
