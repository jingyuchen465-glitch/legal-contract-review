const path = require('node:path');
const AdmZip = require('adm-zip');
const { fail } = require('./errors');
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_EXPANSION = 150 * 1024 * 1024;
const mediaTypes = {
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.odp': 'application/vnd.oasis.opendocument.presentation',
};
const extensionOf = filename => path.extname(String(filename || '')).toLowerCase();
const isSupported = filename => Object.hasOwn(mediaTypes, extensionOf(filename));
const needsConversion = filename => isSupported(filename) && !['.pdf', '.docx'].includes(extensionOf(filename));
function inspectPackage(buffer, required) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { fail(400, 'INVALID_DOCUMENT', '文件已损坏或加密，请补充可打开的文件'); }
  const entries = zip.getEntries();
  if (entries.length > 20000 || entries.reduce((n, e) => n + e.header.size, 0) > MAX_EXPANSION) fail(413, 'DOCUMENT_TOO_LARGE', '文档解压内容过大，请拆分后上传');
  if (entries.some(e => /vbaproject|encryptedpackage/i.test(e.entryName))) fail(400, 'MACRO_FILE', '含宏或加密的文件需要先另存为普通文档');
  if (!zip.getEntry(required)) fail(400, 'INVALID_DOCUMENT', '文件内容与扩展名不符或已损坏');
  return zip;
}
function validateUpload(file) {
  if (!file?.buffer?.length) fail(400, 'EMPTY_FILE', '请选择非空文件');
  const ext = extensionOf(file.originalname), buffer = file.buffer;
  if (!isSupported(file.originalname)) fail(400, 'UNSUPPORTED_FILE_TYPE', '支持 PDF、Word（DOC/DOCX）、Excel（XLS/XLSX/CSV）、PPT/PPTX 和 ODT/ODS/ODP');
  if (buffer.length > MAX_FILE_SIZE) fail(413, 'FILE_TOO_LARGE', '文件不能超过 50MB');
  if (ext === '.pdf' && buffer.subarray(0, 1024).indexOf('%PDF-') < 0) fail(400, 'INVALID_PDF', '文件内容不是有效 PDF');
  if (ext === '.docx' && (buffer.length < 2 || buffer.readUInt16LE(0) !== 0x4b50)) fail(400, 'INVALID_DOCX', '文件内容不是有效 DOCX');
  if (['.doc', '.xls', '.ppt'].includes(ext)) {
    const compound = buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
    const rtf = ext === '.doc' && buffer.subarray(0, 5).toString() === '{\\rtf';
    if (!compound && !rtf) fail(400, 'INVALID_DOCUMENT', '文件内容与扩展名不符，请使用原始 Office 文件');
  }
  if (ext === '.xlsx') inspectPackage(buffer, 'xl/workbook.xml');
  if (ext === '.pptx') inspectPackage(buffer, 'ppt/presentation.xml');
  if (['.odt', '.ods', '.odp'].includes(ext)) {
    const zip = inspectPackage(buffer, 'content.xml');
    if (zip.readAsText('mimetype') !== mediaTypes[ext]) fail(400, 'INVALID_DOCUMENT', '文件内容与扩展名不符');
  }
  if (ext === '.csv' && buffer.includes(0)) fail(400, 'INVALID_DOCUMENT', 'CSV 包含二进制内容，请核对文件格式');
  return mediaTypes[ext];
}
module.exports = { mediaTypes, MAX_FILE_SIZE, MAX_EXPANSION, extensionOf, isSupported, needsConversion, inspectPackage, validateUpload };
