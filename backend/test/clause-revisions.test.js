const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { XMLValidator } = require('fast-xml-parser');
const { applyClauseRevisions } = require('../pilot/clause-revisions');
const { validateDraft } = require('../pilot/clause-drafts');
const { parseDocx } = require('../pilot/parser');
const { createGateway } = require('../pilot/model');
const { config } = require('../pilot/config');

function fixture(first = '<w:r><w:rPr><w:b/></w:rPr><w:t>甲方应在</w:t></w:r><w:r><w:t>交付后付款。</w:t></w:r>') {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:commentRangeStart w:id="3"/>${first}<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p><w:p><w:ins w:id="7" w:author="原作者"><w:r><w:t>其他已有修订。</w:t></w:r></w:ins></w:p></w:body></w:document>`));
  zip.addFile('word/comments.xml', Buffer.from('<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="3" w:author="人工"><w:p><w:r><w:t>原有批注</w:t></w:r></w:p></w:comment></w:comments>'));
  zip.addFile('word/media/image1.png', Buffer.from([1, 2, 3]));
  return zip.toBuffer();
}
const replacement = '甲方应在验收合格且收到合法有效发票后【待双方确认】日内付款。';
const draft = (operation = 'replace') => ({ explanation: '补充验收和开票条件，付款期限待双方确认。', edits: [{ operation, blockId: 'b1', originalText: '甲方应在交付后付款。', newText: operation === 'delete' ? '' : replacement }] });

test('replacement creates real insert/delete revisions, retaining run format, comments and other package parts', () => {
  const original = fixture(), before = new AdmZip(original), result = applyClauseRevisions(original, draft(), '测试法务');
  const zip = new AdmZip(result), xml = zip.readAsText('word/document.xml');
  assert.equal(XMLValidator.validate(xml), true);
  assert.match(xml, /<w:del[^>]*w:author="测试法务"/);
  assert.match(xml, /<w:delText>甲方应在<\/w:delText>/);
  assert.match(xml, /<w:ins[^>]*w:author="测试法务"/);
  assert.match(xml, /<w:b(?:\s*\/|>)/);
  assert.match(xml, /w:id="7" w:author="原作者"/);
  assert.match(xml, /w:commentRangeStart w:id="3"/);
  assert.deepEqual(zip.readFile('word/comments.xml'), before.readFile('word/comments.xml'));
  assert.deepEqual(zip.readFile('word/media/image1.png'), before.readFile('word/media/image1.png'));
  assert.match(zip.readAsText('word/settings.xml'), /w:trackRevisions/);
  const parsed = parseDocx(result);
  assert.deepEqual(parsed.blocks.map(b => b.text), [replacement, '其他已有修订。']);
  assert.equal(parsed.revisions.filter(r => r.author === '测试法务').length, 2);
  assert.equal(parseDocx(original).blocks[0].text, draft().edits[0].originalText);
});

test('insert and delete change only the selected paragraph and retain escaped XML text', () => {
  const addition = draft('insert_after'); addition.edits[0].newText = '新增条款：A & B < C。\n中文补充条款。';
  const result = applyClauseRevisions(fixture(), addition, '法务');
  assert.deepEqual(parseDocx(result).blocks.map(b => b.text), ['甲方应在交付后付款。', addition.edits[0].newText, '其他已有修订。']);
  assert.match(new AdmZip(result).readAsText('word/document.xml'), /&amp; B &lt; C/);
  assert.deepEqual(parseDocx(applyClauseRevisions(fixture(), draft('delete'), '法务')).blocks.map(b => b.text), ['其他已有修订。']);
});

test('changed anchors, duplicate targets, empty edits and protected structures cannot be applied', () => {
  const blocks = parseDocx(fixture()).blocks;
  assert.throws(() => validateDraft({ ...draft(), edits: [{ ...draft().edits[0], originalText: '不存在的原文' }] }, blocks), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => validateDraft({ ...draft(), edits: [draft().edits[0], draft().edits[0]] }, blocks), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => validateDraft({ ...draft(), edits: [{ ...draft().edits[0], newText: ' ' }] }, blocks), { code: 'INVALID_EDIT_TEXT' });
  assert.throws(() => validateDraft({ ...draft(), edits: [{ ...draft().edits[0], newText: draft().edits[0].originalText }] }, blocks), { code: 'DRAFT_NO_CHANGE' });
  assert.throws(() => validateDraft({ ...draft('delete'), edits: [{ ...draft('delete').edits[0], newText: '删除' }] }, blocks), { code: 'INVALID_EDIT_TEXT' });
  assert.throws(() => validateDraft(draft(), blocks, ['b2']), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => applyClauseRevisions(fixture('<w:ins w:id="1"><w:r><w:t>甲方应在交付后付款。</w:t></w:r></w:ins>'), draft(), '法务'), { code: 'DRAFT_COMPLEX_PARAGRAPH' });
  assert.throws(() => applyClauseRevisions(fixture('<w:hyperlink><w:r><w:t>甲方应在交付后付款。</w:t></w:r></w:hyperlink>'), draft(), '法务'), { code: 'DRAFT_COMPLEX_PARAGRAPH' });
});

test('the drafting gateway retries invalid edit structure with exact issue paths', async () => {
  const saved = { ...config.model }, requests = [];
  Object.assign(config.model, { baseUrl: 'http://localhost:9999/v1', name: 'draft-fixture', key: 'test-only' });
  try {
    const gateway = createGateway(null, { fetchImpl: async (_, request) => {
      requests.push(JSON.parse(JSON.parse(request.body).messages[1].content));
      const value = draft(); if (requests.length === 1) value.edits[0].newText = '';
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
    } });
    const result = await gateway.draftClause({ blocks: parseDocx(fixture()).blocks, allowedBlockIds: ['b1'] });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].validationFeedback.code, 'INVALID_EDIT_TEXT');
    assert.ok(requests[1].validationFeedback.issues.some(i => i.path === 'edits.0.newText'));
    assert.equal(result.edits[0].newText, replacement);
  } finally { Object.assign(config.model, saved); }
});

test('draft validation does not classify clause meaning by role, language, prefix or minimum prose length', () => {
  const blocks = parseDocx(fixture()).blocks;
  for (const newText of ['不得转让。', '供方按约交货。', '明确双方结算责任的清单经双方签署后生效。', 'Delivery is due on the agreed date.', 'La entrega se realizará en la fecha acordada.']) {
    const value = draft(); value.edits[0].newText = newText;
    assert.equal(validateDraft(value, blocks).edits[0].newText, newText);
    assert.equal(parseDocx(applyClauseRevisions(fixture(), value, '法务')).blocks[0].text, newText);
  }
});

test('draft validation returns all independent mechanical issues and does not swallow system failures', () => {
  const value = draft();
  value.edits[0].originalText = '错误原文'; value.edits[0].newText = '';
  value.edits.push({ ...value.edits[0], operation: 'delete', newText: '非空删除内容' });
  assert.throws(() => validateDraft(value, parseDocx(fixture()).blocks), e => {
    assert.ok(e.issues.some(i => i.path === 'edits.0.originalText'));
    assert.ok(e.issues.some(i => i.path === 'edits.0.newText'));
    assert.ok(e.issues.some(i => i.path === 'edits.1.blockId'));
    assert.ok(e.issues.some(i => i.path === 'edits.1.newText'));
    return true;
  });
  const { capture } = require('../pilot/validation-issues');
  for (const code of ['AGENT_STOPPED', 'DB_FAILURE']) {
    const error = new (require('../pilot/errors').AppError)(409, code, '运行中断');
    assert.throws(() => capture([], 'test', () => { throw error; }), e => e === error);
  }
});
