const AdmZip = require('adm-zip');
const escape = value => String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// This is explicitly a text reconstruction, never a faithful PDF layout conversion.
function editableWord(version) {
  const paragraph = text => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
  const body = [paragraph('PDF 文字重建稿（可编辑）'), paragraph(`来源：${version.filename} · v${version.version_no}`), paragraph('此稿基于已识别文字重建，不保留原 PDF 的表格、签章、图片及精确版式；请对照原件核对金额、主体和日期。修改后请作为新版本上传重新预审。')];
  let previousPage;
  for (const block of version.parsed.blocks) {
    if (block.page && block.page !== previousPage) { body.push(paragraph(`—— 原 PDF 第 ${block.page} 页 ——`)); previousPage = block.page; }
    for (const line of block.text.split(/\r?\n/)) body.push(paragraph(line));
  }
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`));
  return zip.toBuffer();
}
module.exports = { editableWord };
