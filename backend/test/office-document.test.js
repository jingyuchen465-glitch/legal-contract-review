const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { XMLValidator } = require('fast-xml-parser');
const { parseDocx } = require('../pilot/parser');
const { editorDocument } = require('../pilot/office-document');

function fixture() {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>交付期限另行商议。</w:t></w:r><w:ins w:id="9" w:author="原法务"><w:r><w:t>原有修订</w:t></w:r></w:ins></w:p></w:body></w:document>'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="custom-settings.xml"/></Relationships>'));
  zip.addFile('word/custom-settings.xml', Buffer.from('<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="90"/><w:trackRevisions w:val="false"/><w:compat/></w:settings>'));
  zip.addFile('word/media/preserved.png', Buffer.from('unchanged image bytes'));
  return zip.toBuffer();
}

test('online editor imports anchored review comments and enables native tracked changes without replacing original text', () => {
  const source = fixture(), copy = Buffer.from(source), version = { filename: '合同.docx', version_no: 1, parsed: parseDocx(source) };
  const review = { id: 'review-fixture', status: 'completed', snapshot: {} };
  const findings = [{ id: 'finding-fixture', title: '交付期限不明确', reason: '缺少具体交付日', suggestion: '请约定具体交付日期', check_status: 'fail', severity: 'high', evidence: [{ blockId: 'b1', quote: '交付期限另行商议' }] }];
  const output = new AdmZip(editorDocument(source, version, review, findings));
  assert.deepEqual(source, copy);
  assert.deepEqual(parseDocx(output.toBuffer()).blocks, version.parsed.blocks);
  assert.match(output.readAsText('word/comments.xml'), /请约定具体交付日期/);
  assert.match(output.readAsText('word/document.xml'), /w:commentRangeStart/);
  assert.match(output.readAsText('word/document.xml'), /w:author="原法务"/);
  const settings = output.readAsText('word/custom-settings.xml');
  assert.equal(XMLValidator.validate(settings), true);
  assert.match(settings, /<w:trackRevisions(?:\s[^>]*)?>/);
  assert.doesNotMatch(settings, /w:trackRevisions[^>]*w:val="false"/);
  assert.match(settings, /w:zoom w:percent="90"/);
  assert.deepEqual(output.readFile('word/media/preserved.png'), new AdmZip(source).readFile('word/media/preserved.png'));
});

test('an unreviewed document still opens with tracked changes and a valid settings relationship', () => {
  const original = new AdmZip(fixture());
  original.deleteFile('word/_rels/document.xml.rels'); original.deleteFile('word/custom-settings.xml');
  const result = new AdmZip(editorDocument(original.toBuffer(), { filename: '合同.docx' }));
  assert.match(result.readAsText('word/settings.xml'), /w:trackRevisions/);
  assert.match(result.readAsText('word/_rels/document.xml.rels'), /relationships\/settings/);
  assert.match(result.readAsText('[Content_Types].xml'), /wordprocessingml.settings\+xml/);
  assert.ok(!result.getEntry('word/comments.xml'));
});
