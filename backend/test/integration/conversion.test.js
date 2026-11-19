const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const supertest = require('supertest');
const AdmZip = require('adm-zip');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli');
const { hashPassword } = require('../../pilot/auth');
const { createApp } = require('../../pilot/app');
const { processReview } = require('../../pilot/workflow');
const { processConversion, convertFile } = require('../../pilot/conversion');
const { AppError } = require('../../pilot/errors');
const storage = require('../../pilot/storage');
const background = { ourEntity: '虚构公司', perspective: '采购方', purpose: '采购设备' };
let root, db, name, handle, owner, other, csrf, otherCsrf;
function archive(entries) { const zip = new AdmZip(); for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content)); return zip.toBuffer(); }
const workbook = archive({ 'xl/workbook.xml': '<workbook/>' });
function result(extension, text = '采购清单') {
  const sheet = ['.xlsx', '.xls', '.csv', '.ods'].includes(extension), word = ['.doc', '.odt'].includes(extension);
  const document = sheet ? { parserVersion: 'converter-test', format: 'spreadsheet', blocks: [{ id: 'b1', text: `工作表「隐藏报价」 / B2：${text}；公式：=SUM(B1:B1)`, page: null, kind: 'table_cell', source: 'spreadsheet', sheet: '隐藏报价', address: 'B2', sheetState: 'hidden', formula: '=SUM(B1:B1)', value: text }], sheets: [{ name: '隐藏报价', state: 'hidden' }], requiresHumanVerification: true, warnings: ['核实公式结果'] } : null;
  return archive({ 'manifest.json': JSON.stringify({ version: 1, sourceExtension: extension, document, notes: [], warnings: ['核对转换版式'] }), 'preview.pdf': '%PDF-1.4\n% conversion test', ...(word ? { 'document.docx': archive({ 'word/document.xml': '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>虚构采购合同</w:t></w:r></w:p></w:body></w:document>' }) } : {}) });
}
const {emptyReview:runtimeFactory}=require('../helpers/agent-runtime');
const upload = (bytes, filename) => owner.post('/api/contracts/upload').set('X-CSRF-Token', csrf).field('background', JSON.stringify(background)).attach('file', bytes, filename);
const download = (agent, url) => agent.get(url).buffer(true).parse((response, done) => { const parts = []; response.on('data', p => parts.push(p)); response.on('end', () => done(null, Buffer.concat(parts))); });
before(async () => {
  root = createDb(); name = 'legal_test_conversion_' + randomUUID().replaceAll('-', ''); await root.raw(`CREATE DATABASE "${name}"`);
  const url = new URL(config.databaseUrl); url.pathname = '/' + name; config.databaseUrl = url.href; config.dataRoot = path.resolve(__dirname, '../../../.local/test-data', name);
  db = createDb(); await migrate(db); await storage.initializeDirectories(); handle = createApp(db);
  for (const username of ['owner', 'other']) {
    await db('la_users').insert({ id: randomUUID(), username, display_name: username, department: username, roles: JSON.stringify(['business']), password_hash: await hashPassword('test-password-1234') });
    const agent = supertest.agent(handle.app); const session = await agent.get('/api/auth/session');
    const login = await agent.post('/api/auth/login').set('X-CSRF-Token', session.body.csrf).send({ username, password: 'test-password-1234' }).expect(200);
    if (username === 'owner') { owner = agent; csrf = login.body.csrf; } else { other = agent; otherCsrf = login.body.csrf; }
  }
});
after(async () => { await handle?.close(); await db?.destroy(); if (root && name) { await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [name]); await root.raw(`DROP DATABASE "${name}"`); } await root?.destroy(); });
test('Excel intake preserves original bytes/hash, extracts cell anchors and protects derived artifacts with the same ACL', async () => {
  const uploaded = (await upload(workbook, '报价（中文）.xlsx').expect(201)).body;
  assert.equal(uploaded.version.conversion.status, 'pending');
  let conversions = 0;
  await processReview(db, uploaded.reviewId, { runtimeFactory, convert: async () => { conversions++; return result('.xlsx'); } });
  const version = await db('la_versions').where({ id: uploaded.version.id }).first();
  assert.equal(version.filename, '报价（中文）.xlsx'); assert.equal(version.sha256, storage.sha256(workbook));
  assert.equal(version.conversion.status, 'completed'); assert.equal(version.parsed.blocks[0].address, 'B2'); assert.equal(version.parsed.blocks[0].sheetState, 'hidden'); assert.equal(version.parsed.blocks[0].formula, '=SUM(B1:B1)');
  assert.equal((await db('la_reviews').where({ id: uploaded.reviewId }).first()).status, 'completed');
  await processReview(db, uploaded.reviewId, { runtimeFactory, convert: async () => { throw new Error('must reuse conversion'); } }); assert.equal(conversions, 1);
  assert.deepEqual((await download(owner, `/api/files/${version.id}?download=1`).expect(200)).body, workbook);
  assert.match((await download(owner, `/api/files/${version.id}?variant=pdf`).expect(200)).body.toString(), /^%PDF-/);
  const metadata = (await download(owner, `/api/files/${version.id}?variant=text`).expect(200)).body;
  assert.equal(JSON.parse(metadata.toString()).document.blocks[0].address, 'B2');
  await other.get(`/api/files/${version.id}?variant=pdf`).expect(404);
  await supertest(handle.app).get(`/api/files/${version.id}?variant=pdf`).expect(401);
  await owner.get(`/api/files/${version.id}?variant=unknown`).expect(400);
  const detail = (await owner.get(`/api/contracts/${uploaded.contract.id}`).expect(200)).body;
  assert.ok(!JSON.stringify(detail.versions).includes('storage_key'));
});
test('legacy Word is reviewed through converted DOCX while its original filename and download remain intact', async () => {
  const bytes = Buffer.from('{\\rtf1 test contract}'), uploaded = (await upload(bytes, '旧版合同.doc').expect(201)).body;
  await processReview(db, uploaded.reviewId, { runtimeFactory, convert: async () => result('.doc') });
  const version = await db('la_versions').where({ id: uploaded.version.id }).first();
  assert.equal(version.parsed.format, 'docx'); assert.equal(version.parsed.blocks[0].text, '虚构采购合同'); assert.ok(version.conversion.artifacts.docx);
  assert.deepEqual((await download(owner, `/api/files/${version.id}?download=1`).expect(200)).body, bytes);
  assert.ok((await download(owner, `/api/files/${version.id}?variant=docx&download=1`).expect(200)).body.subarray(0, 2).equals(Buffer.from('PK')));
});
test('failed conversion retains original and retries without creating a new file version', async () => {
  const uploaded = (await upload(workbook, '转换重试.xlsx').expect(201)).body;
  await processReview(db, uploaded.reviewId, { runtimeFactory, convert: async () => { throw new AppError(503, 'CONVERTER_UNAVAILABLE', '转换服务暂不可用'); } });
  assert.equal((await db('la_reviews').where({id:uploaded.reviewId}).first()).error_code,'CONVERTER_UNAVAILABLE');
  let version = await db('la_versions').where({ id: uploaded.version.id }).first(); assert.equal(version.conversion.status, 'failed');
  assert.deepEqual((await download(owner, `/api/files/${version.id}?download=1`).expect(200)).body, workbook);
  await owner.get(`/api/files/${version.id}?variant=pdf`).expect(404);
  const run=await db('la_reviews').where({id:uploaded.reviewId}).first();
  const resumed=await owner.post('/api/agent-sessions/'+run.agent_session_id+'/resume').set('X-CSRF-Token',csrf).send({clientKey:randomUUID()}).expect(202);
  await processReview(db, resumed.body.reviewId, { runtimeFactory, convert: async () => result('.xlsx') });
  version = await db('la_versions').where({ id: uploaded.version.id }).first(); assert.equal(version.conversion.status, 'completed');
  assert.equal(Number((await db('la_versions').where({ contract_id: uploaded.contract.id }).count('* as n').first()).n), 1);
});
test('supplement and signed spreadsheets convert in their own jobs; retry is authorized and never replaces reviewed version', async () => {
  const uploaded = (await upload(workbook, '主合同.xlsx').expect(201)).body;
  for (const kind of ['supplement', 'signed']) {
    const contract = await db('la_contracts').where({ id: uploaded.contract.id }).first();
    const version = (await owner.post(`/api/contracts/${contract.id}/versions`).set('X-CSRF-Token', csrf).field('revision', contract.revision).field('kind', kind).attach('file', workbook, `${kind}.xlsx`).expect(201)).body.version;
    assert.ok(await db('la_outbox').where({ queue: 'conversion' }).whereRaw("payload->>'versionId' = ?", [version.id]).first());
    await assert.rejects(processConversion(db, version.id, { convert: async () => { throw new AppError(422, 'CONVERSION_FAILED', '转换失败'); } }));
    await other.post(`/api/versions/${version.id}/conversion`).set('X-CSRF-Token', otherCsrf).send({}).expect(404);
    await owner.post(`/api/versions/${version.id}/conversion`).send({}).expect(403);
    await owner.post(`/api/versions/${version.id}/conversion`).set('X-CSRF-Token', csrf).send({}).expect(202);
    await processConversion(db, version.id, { convert: async () => result('.xlsx') });
    assert.equal((await db('la_versions').where({ id: version.id }).first()).parsed.format, 'spreadsheet');
    assert.equal((await db('la_contracts').where({ id: contract.id }).first()).current_version_id, uploaded.version.id);
  }
});
test('HTTP converter client authenticates internal requests and returns readable engine failures', async () => {
  const previous = { ...config.converter }; let seen;
  const server = http.createServer(async (req, res) => { const parts = []; for await (const p of req) parts.push(p); seen = { auth: req.headers.authorization, extension: req.headers['x-file-extension'], bytes: Buffer.concat(parts) }; res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'CONVERSION_FAILED', message: '文件已加密，请补件' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(config.converter, { url: `http://127.0.0.1:${server.address().port}`, token: 'test-only-converter-token-at-least-32', timeout: 10000 });
  try {
    await assert.rejects(convertFile(workbook, '报价.XLSX'), e => e.code === 'CONVERSION_FAILED' && e.message === '文件已加密，请补件');
    assert.equal(seen.auth, `Bearer ${config.converter.token}`); assert.equal(seen.extension, '.xlsx'); assert.deepEqual(seen.bytes, workbook);
    config.converter.url = ''; await assert.rejects(convertFile(workbook, '报价.xlsx'), e => e.code === 'CONVERTER_NOT_CONFIGURED');
  } finally { Object.assign(config.converter, previous); await new Promise(resolve => server.close(resolve)); }
});
