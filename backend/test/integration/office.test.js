const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');
const request = require('supertest');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli');
const { hashPassword } = require('../../pilot/auth');
const { createApp } = require('../../pilot/app');
const { createContract } = require('../../pilot/contracts');
const { parseDocx } = require('../../pilot/parser');
const storage = require('../../pilot/storage');

function docx(text = '虚构验收合同，交付期限另行商议。') {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}
let rootDb, db, app, agent, csrf, owner, outsider, other, otherCsrf, server, fixture, command, officeError = 0, database;
let draftReply;
before(async () => {
  rootDb = createDb(); database = 'legal_test_' + randomUUID().replaceAll('-', '');
  await rootDb.raw(`CREATE DATABASE "${database}"`);
  const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
  config.dataRoot = path.resolve(process.env.AUTO_REVIEW_TEST_DATA_ROOT || path.join(__dirname, '../../../.local/test-data'), database);
  config.office.secret = 'office-integration-secret-at-least-32-characters';
  server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const parts = []; for await (const part of req) parts.push(part);
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(Buffer.concat(parts).toString());
        const input = JSON.parse(body.messages[1].content);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draftReply(input)) } }] })); return;
      }
      const body = JSON.parse(Buffer.concat(parts).toString()); command = jwt.verify(body.token, config.office.secret, { algorithms: ['HS256'] });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: officeError }));
    } else res.end(docx('虚构验收合同，交付期限明确为30日。'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.office.url = config.office.internalUrl = `http://127.0.0.1:${server.address().port}`;
  db = createDb(); await migrate(db); await storage.initializeDirectories();
  const password = 'office-integration-password';
  for (const username of ['owner', 'outsider']) {
    const user = { id: randomUUID(), username, display_name: username, roles: JSON.stringify(['admin']), password_hash: await hashPassword(password) };
    await db('la_users').insert(user);
  }
  owner = await db('la_users').where({ username: 'owner' }).first(); outsider = await db('la_users').where({ username: 'outsider' }).first();
  app = createApp(db); agent = request.agent(app.app); other = request.agent(app.app);
  for (const [client, username] of [[agent, 'owner'], [other, 'outsider']]) {
    const initial = await client.get('/api/auth/session');
    const response = await client.post('/api/auth/login').set('X-CSRF-Token', initial.body.csrf).send({ username, password }).expect(200);
    if (username === 'owner') csrf = response.body.csrf; else otherCsrf = response.body.csrf;
  }
  fixture = await db.transaction(trx => createContract(trx, owner, { originalname: '虚构合同.docx', buffer: docx() }));
  await db('la_versions').where({ id: fixture.version.id }).update({ parsed: JSON.stringify(parseDocx(docx())) });
  await db('la_reviews').where({ id: fixture.reviewId }).update({ status: 'completed', stage: 'completed' });
  await db('la_findings').insert({ id: randomUUID(), review_id: fixture.reviewId, rule_id: 'manual-office-test', title: '交付期限', reason: '需约定具体日期', suggestion: '请明确交付期限', check_status: 'fail', kind: 'clause', severity: 'high', evidence: JSON.stringify([{ blockId: 'b1', quote: '交付期限另行商议' }]) });
});
after(async () => {
  await app?.close(); await db?.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  if (rootDb && database) { await rootDb.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]); await rootDb.raw(`DROP DATABASE "${database}"`); }
  await rootDb?.destroy();
});

test('editor imports comments with tracked changes; its token is scoped to the session and leaves original bytes intact', async () => {
  const before = await storage.read(fixture.version.storage_key);
  const response = await agent.get(`/api/contracts/${fixture.contract.id}/editor?reviewId=${fixture.reviewId}`).expect(200);
  const value = response.body;
  assert.equal(value.config.editorConfig.customization.review.trackChanges, true);
  assert.equal(value.config.editorConfig.customization.review.reviewDisplay, 'markup');
  const document = new URL(value.config.document.url);
  const downloaded = await request(app.app).get(document.pathname + document.search).buffer(true).parse((response, done) => {
    const parts = []; response.on('data', part => parts.push(part)); response.on('end', () => done(null, Buffer.concat(parts)));
  }).expect(200);
  const zip = new AdmZip(downloaded.body);
  assert.match(zip.readAsText('word/comments.xml'), /请明确交付期限/);
  assert.match(zip.readAsText('word/settings.xml'), /w:trackRevisions/);
  assert.deepEqual(await storage.read(fixture.version.storage_key), before);
  await request(app.app).get(document.pathname).expect(401);
  await request(app.app).get(document.pathname.replace(value.session.key, randomUUID()) + document.search).expect(403);
  await other.get(`/api/contracts/${fixture.contract.id}/editor/${value.session.key}`).expect(403);
  await other.post(`/api/contracts/${fixture.contract.id}/editor/${value.session.key}/save`).set('X-CSRF-Token', otherCsrf).send({}).expect(403);
  await db('la_users').where({ id: owner.id }).update({ active: false });
  await request(app.app).get(document.pathname + document.search).expect(403);
  await db('la_users').where({ id: owner.id }).update({ active: true });
});

test('force-save is signed; only a verified callback advances session and contract versions', async () => {
  const { body: value } = await agent.get(`/api/contracts/${fixture.contract.id}/editor`).expect(200);
  const endpoint = `/api/contracts/${fixture.contract.id}/editor/${value.session.key}`;
  const pending = await agent.post(endpoint + '/save').set('X-CSRF-Token', csrf).send({}).expect(200);
  assert.equal(pending.body.queued, true); assert.equal(command.c, 'forcesave'); assert.equal(command.key, value.session.key);
  assert.equal((await agent.get(endpoint).expect(200)).body.saved, false);
  const payload = { key: value.session.key, status: 6, url: config.office.internalUrl + '/saved.docx' };
  await request(app.app).post('/api/onlyoffice/callback').send({ ...payload, token: jwt.sign(payload, config.office.secret) }).expect(200);
  const status = (await agent.get(endpoint).expect(200)).body;
  assert.equal(status.saved, true); assert.equal(status.versionNo, 2); assert.equal(status.current, true);
  assert.notEqual(status.versionId, fixture.version.id);
  await agent.get(`/api/contracts/${fixture.contract.id}/editor?reviewId=${fixture.reviewId}`).expect(409);
  officeError = 4;
  assert.equal((await agent.post(endpoint + '/save').set('X-CSRF-Token', csrf).send({}).expect(200)).body.queued, false);
  officeError = 1;
  await agent.post(endpoint + '/save').set('X-CSRF-Token', csrf).send({}).expect(502);
});

async function draftFixture() {
  const result = await db.transaction(trx => createContract(trx, owner, { originalname: '改稿验收虚构合同.docx', buffer: docx() }));
  await db('la_versions').where({ id: result.version.id }).update({ parsed: JSON.stringify(parseDocx(docx())) });
  await db('la_reviews').where({ id: result.reviewId }).update({ status: 'completed', stage: 'completed' });
  const findingId = randomUUID();
  await db('la_findings').insert({ id: findingId, review_id: result.reviewId, rule_id: 'draft-test', title: '交付期限', reason: '缺少交付期限', suggestion: '请明确交付期限', check_status: 'fail', kind: 'clause', severity: 'high', evidence: JSON.stringify([{ blockId: 'b1', quote: '交付期限另行商议' }]) });
  const editor = (await agent.get(`/api/contracts/${result.contract.id}/editor?reviewId=${result.reviewId}`).expect(200)).body;
  Object.assign(config.model, { baseUrl: config.office.internalUrl + '/v1', name: 'draft-test', key: 'test-only' });
  draftReply = input => ({ explanation: '交付期限需双方确认。', edits: [{ operation: 'replace', blockId: input.allowedBlockIds[0], originalText: input.blocks.find(b => b.id === input.allowedBlockIds[0]).text, newText: '双方约定，交付期限为合同生效后【待双方确认】日。' }] });
  const endpoint = `/api/contracts/${result.contract.id}/editor/${editor.session.key}`;
  const generate = () => agent.post(endpoint + '/draft').set('X-CSRF-Token', csrf).send({ reviewId: result.reviewId, findingId });
  return { ...result, findingId, endpoint, editor, generate };
}

test('legacy advice can generate a preview and apply real revisions to a new version without accepting the finding', async () => {
  const f = await draftFixture(), before = await storage.read(f.version.storage_key);
  const generated = (await f.generate().expect(200)).body;
  assert.equal(generated.versionId, f.version.id);
  assert.match(generated.edits[0].newText, /【待双方确认】/);
  assert.equal((await db('la_contracts').where({ id: f.contract.id }).first()).current_version_id, f.version.id);
  await other.post(f.endpoint + '/apply-draft').set('X-CSRF-Token', otherCsrf).send({ token: generated.token }).expect(403);
  await agent.post(f.endpoint + '/apply-draft').set('X-CSRF-Token', csrf).send({ token: generated.token + 'tampered' }).expect(409);
  const applied = (await agent.post(f.endpoint + '/apply-draft').set('X-CSRF-Token', csrf).send({ token: generated.token }).expect(200)).body;
  assert.equal(applied.versionNo, 2);
  const version = await db('la_versions').where({ id: applied.versionId }).first();
  assert.equal(version.parent_id, f.version.id); assert.equal(version.source_action, 'ai_clause_revision');
  const buffer = await storage.read(version.storage_key), zip = new AdmZip(buffer), parsed = parseDocx(buffer);
  assert.match(zip.readAsText('word/document.xml'), /w:delText/);
  assert.match(zip.readAsText('word/settings.xml'), /w:trackRevisions/);
  assert.equal(parsed.blocks[0].text, generated.edits[0].newText);
  assert.ok(parsed.originalComments.some(c => c.author === 'AI 合同预审'));
  assert.deepEqual(await storage.read(f.version.storage_key), before);
  assert.equal((await db('la_findings').where({ id: f.findingId }).first()).disposition, null);
  await agent.post(f.endpoint + '/apply-draft').set('X-CSRF-Token', csrf).send({ token: generated.token }).expect(403);
  const payload = { key: f.editor.session.key, status: 6, url: config.office.internalUrl + '/late.docx' };
  await request(app.app).post('/api/onlyoffice/callback').send({ ...payload, token: jwt.sign(payload, config.office.secret) }).expect(403);
  await agent.get(`/api/contracts/${f.contract.id}/editor`).expect(200);
});

test('a preview becomes invalid when its legal disposition or saved document changes', async () => {
  const f = await draftFixture();
  let generated = (await f.generate().expect(200)).body;
  await db('la_findings').where({ id: f.findingId }).update({ revision: 2, disposition: JSON.stringify({ action: 'correct', suggestion: '以人工修正意见为准' }) });
  const changed = await agent.post(f.endpoint + '/apply-draft').set('X-CSRF-Token', csrf).send({ token: generated.token }).expect(409);
  assert.equal(changed.body.code, 'DRAFT_STALE');
  generated = (await f.generate().expect(200)).body;
  const payload = { key: f.editor.session.key, status: 6, url: config.office.internalUrl + '/manual.docx' };
  await request(app.app).post('/api/onlyoffice/callback').send({ ...payload, token: jwt.sign(payload, config.office.secret) }).expect(200);
  const stale = await agent.post(f.endpoint + '/apply-draft').set('X-CSRF-Token', csrf).send({ token: generated.token }).expect(409);
  assert.equal(stale.body.code, 'DRAFT_STALE');
  const unlocated = await f.generate().expect(409);
  assert.equal(unlocated.body.code, 'DRAFT_ANCHOR_CHANGED');
});

test('missing clauses generate insertions and cannot replace unrelated existing provisions', async () => {
  const f = await draftFixture();
  await db('la_findings').where({ id: f.findingId }).update({ kind: 'missing', evidence: '[]' });
  await f.generate().expect(422);
  draftReply = input => ({ explanation: '新增交付条款，期限待确认。', edits: [{ operation: 'insert_after', blockId: input.blocks[0].id, originalText: input.blocks[0].text, newText: '乙方应在合同生效后【待双方确认】日内完成交付。' }] });
  const generated = (await f.generate().expect(200)).body;
  const applied = (await agent.post(f.endpoint + '/apply-draft').set('X-CSRF-Token', csrf).send({ token: generated.token }).expect(200)).body;
  const version = await db('la_versions').where({ id: applied.versionId }).first();
  assert.deepEqual(parseDocx(await storage.read(version.storage_key)).blocks.map(b => b.text), ['虚构验收合同，交付期限另行商议。', generated.edits[0].newText]);
});
