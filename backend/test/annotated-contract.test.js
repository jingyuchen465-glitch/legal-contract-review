const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { XMLValidator, XMLParser } = require('fast-xml-parser');
const { annotatedContract } = require('../pilot/annotated-contract');
const { parseDocx } = require('../pilot/parser');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const C = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
function fixture() {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/existing-comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdAIComments" Type="${C}" Target="existing-comments.xml"/></Relationships>`));
  zip.addFile('word/existing-comments.xml', Buffer.from(`<w:comments xmlns:w="${W}"><w:comment w:id="12" w:author="原法务"><w:p><w:r><w:t>原有意见 &amp; 保留</w:t></w:r></w:p></w:comment></w:comments>`));
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>虚构测试合同</w:t></w:r></w:p><w:p><w:commentRangeStart w:id="12"/><w:r><w:rPr><w:color w:val="112233"/></w:rPr><w:t xml:space="preserve"> 001 付款</w:t></w:r><w:r><w:t>期限另议。</w:t></w:r><w:commentRangeEnd w:id="12"/><w:r><w:commentReference w:id="12"/></w:r></w:p><w:p><w:r><w:t>001 付款期限另议。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>金额 &amp; 税费</w:t></w:r><w:ins w:id="3" w:author="原法务"><w:r><w:t>另议</w:t></w:r></w:ins><w:del w:id="4" w:author="原法务"><w:r><w:delText>旧文本</w:delText></w:r></w:del></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`));
  for (const file of ['word/media/image1.png', 'word/styles.xml', 'word/numbering.xml', 'word/header1.xml']) zip.addFile(file, Buffer.from(`unchanged:${file}`));
  return zip.toBuffer();
}
function inputs(buffer) {
  return { version: { id: 'v1', filename: '测试.docx', version_no: 3, parsed: parseDocx(buffer) }, run: { id: 'r1', status: 'completed', snapshot: { reviewMode: 'trial' } } };
}
const finding = (values = {}) => ({ id: 'f1', title: '付款时间', check_status: 'fail', severity: 'high', reason: '未约定明确日期', suggestion: '请在交付后30日内付款。', kind: 'clause', evidence: [{ blockId: 'b2', quote: '付款期限另议' }], ...values });
function validateZip(zip) { for (const entry of zip.getEntries().filter(e => /\.xml$|\.rels$/.test(e.entryName) && !['word/styles.xml', 'word/numbering.xml', 'word/header1.xml'].includes(e.entryName))) assert.equal(XMLValidator.validate(zip.readAsText(entry)), true, entry.entryName); }
test('native comments preserve body text, split runs, original comments, tables, revisions and other package parts', () => {
  const buffer = fixture(), original = Buffer.from(buffer), { version, run } = inputs(buffer);
  const output = annotatedContract(buffer, version, run, [finding(), finding({ id: 'f2', title: '税费', evidence: [{ blockId: 'b4', quote: '税费另议' }] })]);
  const before = new AdmZip(buffer), after = new AdmZip(output.buffer); validateZip(after);
  assert.deepEqual(buffer, original); assert.deepEqual(parseDocx(output.buffer).blocks, version.parsed.blocks);
  for (const entry of before.getEntries()) if (!['word/document.xml', 'word/existing-comments.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml'].includes(entry.entryName)) assert.deepEqual(after.readFile(entry), before.readFile(entry));
  const xml = after.readAsText('word/document.xml'), comments = after.readAsText('word/existing-comments.xml');
  assert.match(comments, /原有意见 &amp; 保留/); assert.match(comments, /示例规则试审/); assert.match(comments, /w:id="13"/); assert.match(xml, /w:color w:val="112233"/); assert.match(xml, /w:delText>旧文本/);
  const tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false }).parse(xml), body = tree.find(n => n['w:document'])['w:document'].find(n => n['w:body'])['w:body'];
  assert.ok(body.filter(n => n['w:p'])[1]['w:p'].some(n => n['w:commentRangeStart'] && n[':@']['@_w:id'] === '14'));
  assert.ok(!body.filter(n => n['w:p'])[2]['w:p'].some(n => n['w:commentRangeStart']));
  assert.equal(output.located, 2); assert.equal(output.unlocated, 0);
});
test('missing clauses, stale anchors and partly invalid evidence are explicitly retained as whole-document notes', () => {
  const buffer = fixture(), { version, run } = inputs(buffer);
  const changed = structuredClone(version); changed.parsed.blocks[1].text = '旧版本';
  const output = annotatedContract(buffer, changed, run, [finding(), finding({ id: 'missing', title: '缺少保密条款', kind: 'missing', evidence: [] }), finding({ id: 'partial', evidence: [{ blockId: 'b4', quote: '税费' }, { blockId: 'b999', quote: '无法找到' }] })]);
  const comments = new AdmZip(output.buffer).readAsText('word/existing-comments.xml');
  assert.match(comments, /全文意见 · 缺失条款，无原文位置/); assert.match(comments, /原文位置待人工核实/); assert.match(comments, /b999：无法找到/);
  assert.equal(output.located, 1); assert.equal(output.unlocated, 3);
});
test('exports omit passes and rejected findings and prefer corrected legal suggestions and severity', () => {
  const buffer = fixture(), { version, run } = inputs(buffer);
  const result = annotatedContract(buffer, version, run, [finding({ title: '不应出现通过项', check_status: 'pass' }), finding({ title: '不应出现驳回项', disposition: { action: 'reject' } }), finding({ disposition: { action: 'correct', suggestion: '修正文本 <条款> & 双方\n第二行', severity: 'low', reason: '法务确认' } })], 'color');
  const zip = new AdmZip(result.buffer); validateZip(zip);
  const comments = zip.readAsText('word/existing-comments.xml'), xml = zip.readAsText('word/document.xml');
  assert.doesNotMatch(comments, /不应出现/); assert.match(comments, /低风险/); assert.match(comments, /法务修正意见/); assert.match(comments, /修正文本 &lt;条款&gt; &amp; 双方/);
  assert.match(xml, /【审查建议 · 未改写合同正文】/); assert.match(xml, /w:color w:val="245EAA"/); assert.doesNotMatch(xml, /请在交付后30日内付款/);
  assert.ok(parseDocx(result.buffer).blocks.some(block => block.text === '001 付款期限另议。'));
});
test('a document without comments receives a comments relationship and content type without ID collisions', () => {
  const zip = new AdmZip(fixture()); zip.deleteFile('word/existing-comments.xml');
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdAIComments" Type="other" Target="other.xml"/></Relationships>'));
  const buffer = zip.toBuffer(), { version, run } = inputs(buffer), output = new AdmZip(annotatedContract(buffer, version, run, [finding()]).buffer);
  validateZip(output); assert.match(output.readAsText('word/_rels/document.xml.rels'), /Id="rIdAIComments1"/); assert.match(output.readAsText('[Content_Types].xml'), /PartName="\/word\/comments.xml"/); assert.ok(output.getEntry('word/comments.xml'));
});
test('unsupported sources, unfinished runs and invalid XML are rejected', () => {
  const buffer = fixture(), { version, run } = inputs(buffer);
  assert.throws(() => annotatedContract(buffer, { ...version, filename: '合同.pdf' }, run, []), e => e.code === 'ANNOTATION_DOCX_ONLY');
  assert.throws(() => annotatedContract(buffer, version, { ...run, status: 'running' }, []), e => e.code === 'REVIEW_INCOMPLETE');
  assert.throws(() => annotatedContract(buffer, version, run, [], 'replace'), e => e.code === 'INVALID_ANNOTATION_MODE');
  const zip = new AdmZip(buffer); zip.updateFile('word/existing-comments.xml', Buffer.from('<!DOCTYPE a><w:comments/>'));
  assert.throws(() => annotatedContract(zip.toBuffer(), version, run, []), e => e.code === 'INVALID_DOCX_XML');
});
test('web color mode marks literal evidence and preserves text while honoring rejections and corrected severity', async () => {
  const { activeAnnotations, quoteSegments, annotationText } = await import('../../frontend/src/pilot/annotations.mjs');
  const block = { id: 'b2', text: '<原文>付款期限另议；付款期限另议。' }, rejected = finding({ disposition: { action: 'reject' } });
  assert.equal(activeAnnotations([rejected, finding({ check_status: 'pass' })]).length, 0);
  const corrected = finding({ disposition: { action: 'correct', severity: 'low', suggestion: '' } });
  const segments = quoteSegments(block, [finding(), corrected, rejected]);
  assert.equal(segments.map(s => s.text).join(''), block.text); assert.equal(segments.filter(s => s.severity === 'high').length, 2);
  assert.ok(quoteSegments(block, [corrected]).some(s => s.severity === 'low')); assert.equal(annotationText(corrected), '');
});
test('each review opinion has one primary margin note and other cited clauses link to that same note', async () => {
  const { annotationIndex, quoteSegments } = await import('../../frontend/src/pilot/annotations.mjs');
  const blocks = [{ id: 'b1', text: '服务范围及付款期限' }, { id: 'b2', text: '付款期限另行协商' }];
  const shared = finding({ evidence: [{ blockId: 'b2', quote: '付款期限' }, { blockId: 'b2', quote: '协商' }, { blockId: 'b1', quote: '付款期限' }] });
  const missing = finding({ id: 'missing', kind: 'missing', evidence: [] });
  const partial = finding({ id: 'partial', evidence: [{ blockId: 'b1', quote: '服务范围' }, { blockId: 'b99', quote: '不存在' }] });
  const result = annotationIndex(blocks, [shared, missing, partial, finding({ id: 'rejected', disposition: { action: 'reject' } })]);
  assert.equal(result.primary.get(shared.id), 'b2');
  assert.equal([...result.primaryByBlock.values()].flat().filter(f => f.id === shared.id).length, 1);
  assert.deepEqual(result.byBlock.get('b2').map(f => f.id), [shared.id]);
  assert.deepEqual(result.byBlock.get('b1').map(f => f.id), [shared.id, partial.id]);
  assert.deepEqual(result.unanchored.map(f => f.id), ['missing', 'partial']);
  assert.equal(result.numbers.get('partial'), 3);
  assert.ok(quoteSegments(blocks[1], [shared]).find(s => s.text === '付款期限').findingIds.includes(shared.id));
});
