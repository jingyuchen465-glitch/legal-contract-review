const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const request = require('supertest');
const AdmZip = require('adm-zip');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { createContract, addVersion } = require('../../pilot/contracts');
const storage = require('../../pilot/storage');
const { parseDocx } = require('../../pilot/parser');
let root, db, handle, agent, csrf, actor, database;
function docx(text = '虚构合同。交付期限另行商议。') {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}
async function fixture() {
  const f = await db.transaction(trx => createContract(trx, actor, { originalname: '版本保护测试.docx', buffer: docx() }));
  await db('la_versions').where({ id: f.version.id }).update({ parsed: JSON.stringify(parseDocx(docx())) });
  await db('la_reviews').where({ id: f.reviewId }).update({ engine: 'harness-v1', status: 'completed', agent_result: JSON.stringify({ summary: '测试完成' }) });
  await db('la_findings').insert({ id: randomUUID(), review_id: f.reviewId, rule_id: 'version-test', title: '交付日期', reason: '日期不明确', suggestion: '乙方应于三十日内交付。', kind: 'clause', severity: 'high', check_status: 'fail', evidence: JSON.stringify([{ blockId: 'b1', quote: '交付期限另行商议' }]) });
  return f;
}
const current = id => db('la_contracts').where({ id }).first();
const generate = (f, mode = 'comments') => agent.post(`/api/reviews/${f.reviewId}/annotated-version`).set('X-CSRF-Token', csrf).send({ mode });
before(async () => {
  root = createDb(); database = 'legal_test_versions_' + randomUUID().replaceAll('-', '');
  await root.raw(`CREATE DATABASE "${database}"`);
  const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
  config.dataRoot = path.resolve('.local/test-data', database);
  config.office.url = 'http://127.0.0.1:19999'; config.office.secret = 'isolated-version-test-office-secret';
  db = createDb(); await require('../../pilot/cli').migrate(db); await storage.initializeDirectories();
  actor = { id: randomUUID(), username: 'versions', display_name: '测试法务', roles: '["admin"]', password_hash: await require('../../pilot/auth').hashPassword('versions-test-password') };
  await db('la_users').insert(actor); handle = require('../../pilot/app').createApp(db); agent = request.agent(handle.app);
  const session = await agent.get('/api/auth/session');
  csrf = (await agent.post('/api/auth/login').set('X-CSRF-Token', session.body.csrf).send({ username: actor.username, password: 'versions-test-password' }).expect(200)).body.csrf;
});
after(async () => {
  await handle?.close(); await db?.destroy();
  if (root && database) { await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]); await root.raw(`DROP DATABASE "${database}"`); }
  await root?.destroy();
});
test('historical report cannot replace negotiated text; historical download remains available', async () => {
  const f = await fixture();
  const v2 = await db.transaction(async trx => addVersion(trx, await current(f.contract.id), { originalname: '谈判新稿.docx', buffer: docx('双方确认交付期限为三十日。') }, actor.id));
  const response = await generate(f).expect(409);
  assert.equal(response.body.code, 'ANNOTATION_REVIEW_STALE');
  assert.equal((await current(f.contract.id)).current_version_id, v2.version.id);
  assert.equal(Number((await db('la_versions').where({ contract_id: f.contract.id }).count().first()).count), 2);
  await agent.get(`/api/reviews/${f.reviewId}/annotated-contract`).expect(200);
  assert.equal((await current(f.contract.id)).current_version_id, v2.version.id);
});
test('concurrent generation and retries return the same artifact without moving current version backwards', async () => {
  const f = await fixture();
  const replies = await Promise.all([generate(f), generate(f)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 201]);
  assert.equal(replies[0].body.versionId, replies[1].body.versionId);
  const v3 = await db.transaction(async trx => addVersion(trx, await current(f.contract.id), { originalname: '再谈判.docx', buffer: docx('双方确认交付期限为六十日。') }, actor.id));
  const duplicate = await generate(f).expect(200); assert.equal(duplicate.body.duplicate, true);
  assert.equal((await current(f.contract.id)).current_version_id, v3.version.id);
  await generate(f, 'color').expect(409);
  await db('la_findings').where({ review_id: f.reviewId }).update({ suggestion: '乙方应于六十日内交付。', revision: 2 });
  await generate(f).expect(409);
});
test('editor checks expected version before creating a session, while legacy current-version requests work', async () => {
  const f = await fixture();
  const first = await agent.get(`/api/contracts/${f.contract.id}/editor?versionId=${f.version.id}`).expect(200);
  assert.equal(first.body.session.versionId, f.version.id);
  const v2 = await db.transaction(async trx => addVersion(trx, await current(f.contract.id), { originalname: '新稿.docx', buffer: docx('交付期限为三十日。') }, actor.id));
  const response = await agent.get(`/api/contracts/${f.contract.id}/editor?versionId=${f.version.id}`).expect(409);
  assert.equal(response.body.code, 'EDITOR_VERSION_CHANGED');
  assert.equal(Number((await db('la_editor_sessions').where({ contract_id: f.contract.id }).count().first()).count), 1);
  assert.equal((await agent.get(`/api/contracts/${f.contract.id}/editor`).expect(200)).body.session.versionId, v2.version.id);
});
