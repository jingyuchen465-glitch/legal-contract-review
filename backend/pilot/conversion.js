const { randomUUID } = require('node:crypto');
const AdmZip = require('adm-zip');
const { z } = require('zod');
const { config } = require('./config');
const storage = require('./storage');
const { needsConversion, extensionOf, MAX_EXPANSION, MAX_FILE_SIZE, inspectPackage } = require('./file-formats');
const { fail, AppError } = require('./errors');

const blockSchema = z.object({ id: z.string(), text: z.string(), kind: z.string(), source: z.string(), page: z.number().int().positive().nullable(), sheet: z.string().optional(), address: z.string().optional(), sheetState: z.string().optional(), row: z.number().optional(), cell: z.number().optional(), formula: z.string().nullable().optional(), value: z.string().optional(), numberFormat: z.string().optional() });
const manifestSchema = z.object({ version: z.literal(1), sourceExtension: z.string(), warnings: z.array(z.string()), notes: z.array(blockSchema).max(100000), document: z.object({ parserVersion: z.string(), format: z.literal('spreadsheet'), blocks: z.array(blockSchema).min(1).max(100000), sheets: z.array(z.object({ name: z.string(), state: z.string() })), requiresHumanVerification: z.boolean(), warnings: z.array(z.string()) }).nullable() });
function unpackConversion(buffer, filename) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { fail(502, 'CONVERTER_INVALID_RESULT', '转换服务返回了无效文件'); }
  const entries = zip.getEntries();
  if (entries.length > 3 || entries.reduce((sum, entry) => sum + entry.header.size, 0) > MAX_EXPANSION || entries.some(e => !['manifest.json', 'preview.pdf', 'document.docx'].includes(e.entryName))) fail(502, 'CONVERTER_INVALID_RESULT', '转换服务返回的文件内容无效或过大');
  const metadata = zip.getEntry('manifest.json');
  if (!metadata || metadata.header.size > 30 * 1024 * 1024) fail(502, 'CONVERTER_INVALID_RESULT', '转换服务缺少有效元数据');
  let manifest;
  try { manifest = manifestSchema.parse(JSON.parse(zip.readAsText(metadata))); } catch { fail(502, 'CONVERTER_INVALID_RESULT', '转换服务返回的文档结构无效'); }
  if (manifest.sourceExtension !== extensionOf(filename)) fail(502, 'CONVERTER_INVALID_RESULT', '转换结果与源文件不匹配');
  const pdf = zip.readFile('preview.pdf'), docx = zip.readFile('document.docx');
  if (!pdf || pdf.length > MAX_FILE_SIZE || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail(502, 'CONVERTER_INVALID_RESULT', '转换服务未生成有效的 PDF 预览');
  const ext = extensionOf(filename), sheet = ['.xls', '.xlsx', '.csv', '.ods'].includes(ext), word = ['.doc', '.odt'].includes(ext);
  if (sheet !== !!manifest.document || word !== !!docx) fail(502, 'CONVERTER_INVALID_RESULT', '转换服务未生成所需的文档内容');
  if (docx) { if (docx.length > MAX_FILE_SIZE) fail(502, 'CONVERTER_INVALID_RESULT', '转换后的 Word 文件过大'); inspectPackage(docx, 'word/document.xml'); }
  return { manifest, pdf, docx };
}
async function convertFile(buffer, filename) {
  const { url, token, timeout } = config.converter;
  if (!url || !token || token.length < 32) fail(503, 'CONVERTER_NOT_CONFIGURED', '文件已保存，自动转换服务尚未配置，请联系管理员或改传 PDF/DOCX');
  let response;
  const deadline = Date.now() + timeout;
  try {
    do {
      response = await fetch(`${url.replace(/\/$/, '')}/convert`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-File-Extension': extensionOf(filename) }, body: buffer, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), redirect: 'error' });
      if (response.status !== 503) break;
      const detail = await response.clone().json().catch(() => null);
      if (detail?.code !== 'CONVERTER_BUSY' || Date.now() + 2000 >= deadline) break;
      await response.body.cancel();
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
  } catch (e) { throw new AppError(503, e.name === 'TimeoutError' ? 'CONVERSION_TIMEOUT' : 'CONVERTER_UNAVAILABLE', e.name === 'TimeoutError' ? '文件转换超时，请重试或改传 PDF' : '文件已保存，转换服务暂不可用，请稍后重试'); }
  if (!response.ok) {
    let detail; try { detail = await response.json(); } catch {}
    throw new AppError(response.status >= 500 ? 503 : 422, typeof detail?.code === 'string' ? detail.code : 'CONVERSION_FAILED', typeof detail?.message === 'string' ? detail.message : '文件转换失败，请核对是否加密、损坏，或改传 PDF');
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > MAX_EXPANSION) { await response.body.cancel().catch(() => {}); fail(502, 'CONVERTER_INVALID_RESULT', '转换结果过大'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
// Session lock covers both review and attachment conversion; worker death releases it.
async function ensureConverted(db, version, { convert = convertFile } = {}) {
  if (!needsConversion(version.filename)) return version;
  const connection = await db.client.acquireConnection();
  try {
    await db.raw('SELECT pg_advisory_lock(hashtext(?))', [`conversion:${version.id}`]).connection(connection);
    const current = await db('la_versions').where({ id: version.id }).first();
    if (current.conversion?.status === 'completed') return current;
    await db('la_versions').where({ id: version.id }).update({ conversion: JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }) });
    try {
      const { manifest, pdf, docx } = unpackConversion(await convert(await storage.read(current.storage_key), current.filename), current.filename);
      const operationId = randomUUID(), artifacts = {};
      const save = async (name, data, media) => {
        const key = await storage.put(data, current.contract_id, `${current.id}/converted-${operationId}`, name);
        return { filename: name, storage_key: key, sha256: storage.sha256(data), size: data.length, media_type: media };
      };
      artifacts.pdf = await save('preview.pdf', pdf, 'application/pdf');
      if (docx) artifacts.docx = await save('document.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      artifacts.manifest = await save('manifest.json', Buffer.from(JSON.stringify(manifest)), 'application/json');
      if (manifest.document) artifacts.text = artifacts.manifest;
      const conversion = { status: 'completed', engine: 'LibreOffice', completedAt: new Date().toISOString(), artifacts, warnings: manifest.warnings };
      return (await db('la_versions').where({ id: current.id }).update({ conversion: JSON.stringify(conversion) }).returning('*'))[0];
    } catch (e) {
      await db('la_versions').where({ id: current.id }).update({ conversion: JSON.stringify({ status: 'failed', errorCode: e.code || 'CONVERSION_FAILED', message: e.code ? e.message : '文件转换失败，请重试或改传 PDF', failedAt: new Date().toISOString() }) });
      throw e;
    }
  } finally {
    await db.raw('SELECT pg_advisory_unlock(hashtext(?))', [`conversion:${version.id}`]).connection(connection).catch(() => {});
    await db.client.releaseConnection(connection);
  }
}
async function parseConverted(version, parser) {
  const artifacts = version.conversion.artifacts;
  const manifest = JSON.parse((await storage.read((artifacts.manifest || artifacts.text).storage_key)).toString('utf8'));
  let document;
  if (manifest.document) document = manifest.document;
  else if (artifacts.docx) document = await parser(await storage.read(artifacts.docx.storage_key), 'document.docx');
  else {
    document = await parser(await storage.read(artifacts.pdf.storage_key), 'preview.pdf');
    document.blocks.push(...manifest.notes.map((block, i) => ({ ...block, id: `b${document.blocks.length + i + 1}` })));
  }
  return { ...document, requiresHumanVerification: true, warnings: [...new Set([...(document.warnings || []), ...manifest.warnings])] };
}
async function persistDocument(db, version, document) {
  const update = { parsed: JSON.stringify(document) };
  if (version.conversion?.status === 'completed') {
    const data = Buffer.from(JSON.stringify({ document }));
    const key = await storage.put(data, version.contract_id, `${version.id}/extracted-${randomUUID()}`, 'document.json');
    update.conversion = JSON.stringify({ ...version.conversion, artifacts: { ...version.conversion.artifacts, text: { filename: 'document.json', storage_key: key, sha256: storage.sha256(data), size: data.length, media_type: 'application/json' } } });
  }
  await db('la_versions').where({ id: version.id }).update(update);
}
async function processConversion(db, versionId, options) {
  const version = await db('la_versions').where({ id: versionId }).first();
  if (!version) return;
  const converted = await ensureConverted(db, version, options);
  if (!converted.parsed && converted.conversion?.status === 'completed') {
    try {
      const document = await parseConverted(converted, options?.parser || require('./parser').parseDocument);
      await persistDocument(db, converted, document);
    } catch (e) {
      await db('la_versions').where({ id: versionId }).update({ conversion: JSON.stringify({ ...converted.conversion, status: 'failed', errorCode: e.code || 'EXTRACTION_FAILED', message: e.code ? e.message : '转换副本已生成，正文提取失败，请重试或改传 PDF' }) });
      throw e;
    }
  }
}
function publicConversion(conversion) {
  if (!conversion) return conversion;
  return { ...conversion, ...(conversion.artifacts ? { artifacts: Object.fromEntries(Object.entries(conversion.artifacts).filter(([type]) => type !== 'manifest').map(([type, { storage_key, ...artifact }]) => [type, artifact])) } : {}) };
}
module.exports = { convertFile, unpackConversion, ensureConverted, parseConverted, persistDocument, processConversion, publicConversion };
