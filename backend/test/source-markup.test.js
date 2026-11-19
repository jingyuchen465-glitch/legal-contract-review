const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { parseDocx } = require('../pilot/parser');

test('source comments and tracked insertions/deletions remain readable beside the current text view', () => {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="urn:word"><w:body><w:p><w:commentRangeStart w:id="4"/><w:r><w:t>付款期限</w:t></w:r><w:del w:author="对方法务"><w:r><w:delText>30日</w:delText></w:r></w:del><w:ins w:author="对方法务"><w:r><w:t>60日</w:t></w:r></w:ins><w:commentRangeEnd w:id="4"/><w:r><w:commentReference w:id="4"/></w:r></w:p></w:body></w:document>'));
  zip.addFile('word/comments.xml', Buffer.from('<w:comments xmlns:w="urn:word"><w:comment w:id="4" w:author="对方法务"><w:p><w:r><w:t>请确认账期。</w:t></w:r></w:p></w:comment></w:comments>'));
  const parsed = parseDocx(zip.toBuffer());
  assert.equal(parsed.blocks[0].text, '付款期限60日');
  assert.deepEqual(parsed.originalComments[0], { id: '4', author: '对方法务', date: null, text: '请确认账期。', blockIds: ['b1'] });
  assert.deepEqual(parsed.revisions.map(r => [r.type, r.text, r.author]), [['delete', '30日', '对方法务'], ['insert', '60日', '对方法务']]);
  assert.equal(parsed.requiresHumanVerification, true);
});

test('Word text keeps leading zeros and reads comments from the package relationship', () => {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="urn:word"><w:body><w:p>\n<w:r><w:t>编号 </w:t></w:r>\n<w:r><w:t>00100</w:t></w:r>\n</w:p></w:body></w:document>'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="original-comments.xml"/></Relationships>'));
  zip.addFile('word/original-comments.xml', Buffer.from('<w:comments xmlns:w="urn:word"><w:comment w:id="2"><w:p><w:r><w:t>001</w:t></w:r></w:p></w:comment></w:comments>'));
  const parsed = parseDocx(zip.toBuffer());
  assert.equal(parsed.blocks[0].text, '编号 00100');
  assert.equal(parsed.originalComments[0].text, '001');
});
