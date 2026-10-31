const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { config } = require('./config');
const { findType } = require('./catalog');
const { fail } = require('./errors');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
function safeName(name) {
  const clean = path.basename(String(name).replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160);
  return !clean || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) ? `file_${clean || 'document'}` : clean;
}
function localPath(key) {
  const result = path.resolve(config.dataRoot, key);
  const relative = path.relative(config.dataRoot, result);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(400, 'INVALID_STORAGE_KEY', '无效文件路径');
  return result;
}
async function put(buffer, contractId, versionId, filename) {
  const key = path.join('objects', contractId, versionId, safeName(filename));
  const target = localPath(key); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, buffer, { flag: 'wx' }); return key;
}
async function read(key) { return fs.readFile(localPath(key)); }
async function exportVersion(c, v, kind = '原始合同') {
  const type = findType(c.classification?.typeId);
  const base = type ? [type.categoryName, type.name] : ['待人工确认分类'];
  const target = path.join(config.dataRoot, 'classified', ...base, c.number, kind);
  await fs.mkdir(target, { recursive: true });
  const filename = `v${String(v.version_no).padStart(4, '0')}_${v.id}_${safeName(v.filename)}`;
  await fs.copyFile(localPath(v.storage_key), path.join(target, filename));
  return path.join(target, filename);
}
async function archiveClassifiedVersion(c, v, root, kind = '自动归档') {
  if (!root) return null;
  const type = findType(c.classification?.typeId);
  const base = type ? [type.categoryName, type.name] : ['待人工确认分类'];
  const target = path.resolve(root, ...base.map(safeName), safeName(c.number), kind);
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(400, 'INVALID_ARCHIVE_ROOT', '归档目录无效');
  await fs.mkdir(target, { recursive: true });
  const filename = `v${String(v.version_no).padStart(4, '0')}_${safeName(v.filename)}`;
  const destination = path.join(target, filename);
  await fs.copyFile(localPath(v.storage_key), destination);
  return destination;
}
async function exportReport(c, review, html) {
  const type = findType(c.classification?.typeId); const base = type ? [type.categoryName, type.name] : ['待人工确认分类'];
  const target = path.join(config.dataRoot, 'classified', ...base, c.number, 'AI预审报告');
  await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, `${review.id}_${sha256(Buffer.from(html)).slice(0,12)}.html`), html, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
}
async function initializeDirectories() {
  const { catalog } = require('./catalog');
  await Promise.all(['objects', 'derived', 'backups', 'classified/待人工确认分类', ...catalog.flatMap(c => c.types.map(t => `classified/${c.name}/${t.name}`))].map(p => fs.mkdir(path.join(config.dataRoot, p), { recursive: true })));
}
function validateUpload(file) {
  if (!file?.buffer?.length) fail(400, 'EMPTY_FILE', '请选择非空文件');
  const ext = path.extname(file.originalname).toLowerCase();
  if (!['.pdf', '.docx'].includes(ext)) fail(400, 'UNSUPPORTED_FILE_TYPE', '仅支持 PDF、DOCX；请将旧版 DOC 转换为 DOCX');
  if (file.buffer.length > 50 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE', '文件不能超过 50MB');
  if (ext === '.pdf' && file.buffer.subarray(0, 1024).indexOf('%PDF-') < 0) fail(400, 'INVALID_PDF', '文件内容不是有效 PDF');
  if (ext === '.docx' && (file.buffer.length < 2 || file.buffer.readUInt16LE(0) !== 0x4b50)) fail(400, 'INVALID_DOCX', '文件内容不是有效 DOCX');
  return ext === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}
module.exports = { sha256, safeName, localPath, put, read, exportVersion, archiveClassifiedVersion, exportReport, initializeDirectories, validateUpload };
