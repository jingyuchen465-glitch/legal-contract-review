const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const supertest = require('supertest');
const AdmZip = require('adm-zip');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli');
const { hashPassword } = require('../../pilot/auth');
const { createApp } = require('../../pilot/app');
const management = require('../../pilot/agent/memory-management');
const memory = require('../../pilot/agent/memory');
const service = require('../../pilot/agent/service');
const { emptyReview } = require('../helpers/agent-runtime');
let rootDb, db, database, handle, actor, client, csrf, legacyId, sourceId, contractId;
const body = (extra = {}) => ({ kind: 'skill', title: '知识管理测试-' + randomUUID(), description: '核对付款条件', content: '核验付款与验收的先后关系。', conditions: ['采购合同'], ...extra });
const req = (method, url, input) => { const q = client[method]('/api' + url).set('X-CSRF-Token', csrf); return input ? q.send(input) : q; };
async function create(input = body()) { return (await req('post', '/agent/experiences', input).expect(201)).body; }
async function action(row, name, extra = {}) { return (await req('post', `/agent/experiences/${row.id}/${name}`, { revision: row.revision, ...extra }).expect(200)).body; }
async function publish(row) { return action(await action(row, 'submit'), 'approve'); }
async function login(user) {
  const agent = supertest.agent(handle.app), session = await agent.get('/api/auth/session');
  const response = await agent.post('/api/auth/login').set('X-CSRF-Token', session.body.csrf).send({ username: user.username, password: 'memory-test-password' }).expect(200);
  return { agent, token: response.body.csrf };
}
async function upload() {
  const zip = new AdmZip(); zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>虚构采购合同。交付期限另行商议。</w:t></w:r></w:p></w:body></w:document>'));
  return (await req('post', '/contracts/upload').attach('file', zip.toBuffer(), '知识审核虚构合同.docx').expect(201)).body;
}
before(async () => {
  rootDb = createDb(); database = 'memory_test_' + randomUUID().replaceAll('-', '');
  await rootDb.raw(`CREATE DATABASE "${database}"`);
  const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
  config.dataRoot = path.resolve('.local/test-data', database); config.model = { ...config.model, key: '', baseUrl: '', name: '' };
  db = createDb();
  // Exercise the actual upgrade from the pre-management schema, including a live item.
  const directory = path.resolve('backend/pilot/migrations');
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.js') && name < '020_');
  await db.migrate.latest({ tableName: 'la_migrations', migrationSource: { getMigrations: async () => names, getMigrationName: name => name, getMigration: name => require(path.join(directory, name)) } });
  actor = { id: randomUUID(), username: 'memory-admin', display_name: '知识法务', department: '测试', roles: ['admin'], password_hash: await hashPassword('memory-test-password') };
  await db('la_users').insert({ ...actor, roles: JSON.stringify(actor.roles) });
  contractId = randomUUID(); sourceId = randomUUID(); legacyId = randomUUID();
  await db('la_contracts').insert({ id: contractId, number: 'legacy-' + contractId, title: '历史来源', department: '测试', submitter_id: actor.id });
  await db('la_agent_legal_events').insert({ id: sourceId, event_key: randomUUID(), contract_id: contractId, actor_id: actor.id, kind: 'explicit_feedback', source: '{"text":"核验付款条件"}', status: 'completed' });
  await db('la_agent_memories').insert({ id: legacyId, source_id: sourceId, department: '测试', fingerprint: 'legacy', ...body({ title: '存量生效知识' }), conditions: '["采购合同"]' });
  await migrate(db); await require('../../pilot/storage').initializeDirectories();
  handle = createApp(db); const auth = await login(actor); client = auth.agent; csrf = auth.token;
});
after(async () => {
  await handle?.close(); await db?.destroy();
  if (rootDb && database) { await rootDb.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]); await rootDb.raw(`DROP DATABASE "${database}"`); }
  await rootDb?.destroy();
});

test('upgrade preserves published knowledge and creates its official version', async () => {
  const row = (await req('get', '/agent/experiences/' + legacyId).expect(200)).body;
  assert.equal(row.version, 1); assert.equal(row.state, 'active'); assert.equal(row.draft_status, 'none');
  assert.equal(row.versions[0].body.title, '存量生效知识'); assert.equal(row.versions[0].status, 'published');
  assert.ok((await service.usableMemories(db, { department: '测试' })).some(m => m.id === legacyId));
});

test('both kinds support drafts, locked pending review, rejection, self approval and enable/disable', async () => {
  for (const kind of ['skill', 'experience']) {
    let row = await create(body({ kind }));
    assert.equal(row.source_id, null); assert.equal(row.origin, 'manual'); assert.equal(row.version, 0);
    assert.ok(!(await service.usableMemories(db, { department: '测试' })).some(m => m.id === row.id));
    await req('post', `/agent/experiences/${row.id}/approve`, { revision: row.revision }).expect(409);
    row = await action(row, 'submit');
    await req('put', '/agent/experiences/' + row.id, { ...body(), revision: row.revision }).expect(409);
    await req('post', `/agent/experiences/${row.id}/reject`, { revision: row.revision }).expect(400);
    row = await action(row, 'reject', { note: '请补充适用范围' });
    row = (await req('put', '/agent/experiences/' + row.id, { ...body({ kind, title: '修正知识' }), revision: row.revision }).expect(200)).body;
    row = await publish(row);
    assert.equal(row.version, 1); assert.equal(row.state, 'active'); assert.equal(row.draft_status, 'none');
    const detail = (await req('get', '/agent/experiences/' + row.id).expect(200)).body;
    assert.equal(detail.versions[0].reviewed_by, actor.id); assert.ok(detail.history.some(e => e.details.note === '请补充适用范围'));
    row = await action(row, 'disable'); assert.equal(row.state, 'disabled');
    assert.ok(!(await service.usableMemories(db, { department: '测试' })).some(m => m.id === row.id));
    row = await action(row, 'enable'); assert.equal(row.state, 'active');
    assert.ok((await service.usableMemories(db, { department: '测试' })).some(m => m.id === row.id));
    await req('delete', '/agent/experiences/' + row.id, { revision: row.revision }).expect(200);
  }
});

test('editing an official item keeps its effective body until the successor is approved', async () => {
  let row = await publish(await create(body({ content: '正式旧版付款方法' })));
  const oldRevision = row.revision;
  row = (await req('put', '/agent/experiences/' + row.id, { ...body({ content: '待审新版付款方法' }), revision: row.revision }).expect(200)).body;
  assert.equal(row.content, '正式旧版付款方法');
  assert.equal((await service.usableMemories(db, { department: '测试' })).find(m => m.id === row.id).content, '正式旧版付款方法');
  await req('put', '/agent/experiences/' + row.id, { ...body(), revision: oldRevision }).expect(409);
  row = await action(row, 'submit');
  assert.equal((await service.usableMemories(db, { department: '测试' })).find(m => m.id === row.id).version, 1);
  row = await action(row, 'approve'); assert.equal(row.version, 2); assert.equal(row.content, '待审新版付款方法');
  assert.equal((await db('la_agent_memory_versions').where({ memory_id: row.id })).length, 2);
  await req('post', `/agent/experiences/${row.id}/approve`, { revision: row.revision }).expect(409);
  await req('delete', '/agent/experiences/' + row.id, { revision: row.revision }).expect(200);
});

test('automatic learning creates non-effective drafts; deletion preserves generated totals and siblings', async () => {
  const c = await upload();
  const source = await memory.record(db, actor, { contractId: c.contract.id, reviewId: c.reviewId, kind: 'explicit_feedback', eventKey: randomUUID(), source: { text: '请核验付款条件与验收标准' } });
  await memory.processMemory(db, source, { distill: async () => ({ memories: ['skill', 'experience'].map(kind => ({ ...body({ kind }), sourceQuotes: ['请核验付款条件与验收标准'] })) }) });
  let rows = await db('la_agent_memories').where({ source_id: source }); assert.equal(rows.length, 2);
  assert.ok(rows.every(m => m.version === 0 && m.draft_status === 'draft'));
  assert.ok(!(await service.usableMemories(db, { department: '测试' })).some(m => rows.some(r => r.id === m.id)));
  const approved = await publish(rows[1]);
  await req('delete', '/agent/experiences/' + rows[0].id, { revision: rows[0].revision }).expect(200);
  await req('get', '/agent/experiences/' + rows[0].id).expect(404);
  assert.equal((await db('la_agent_memory_versions').where({ memory_id: rows[0].id })).length, 0);
  assert.equal((await req('get', '/agent/experiences/' + approved.id).expect(200)).body.state, 'active');
  const log = (await req('get', '/agent/experience-sources/' + source).expect(200)).body;
  assert.equal(log.generatedCount, 2); assert.equal(log.skillCount, 1); assert.equal(log.experienceCount, 1); assert.equal(log.memories.length, 1);
  await req('post', '/agent/experience-sources/' + source + '/revoke', { revision: log.revision, reason: '原反馈不再适用' }).expect(200);
  const revoked = (await req('get', '/agent/experiences/' + approved.id).expect(200)).body;
  await req('post', '/agent/experiences/' + approved.id + '/enable', { revision: revoked.revision }).expect(409);
});

test('search and filters operate across all pages, including draft text and literal query symbols', async () => {
  const prefix = '分页-' + randomUUID();
  const rows = [];
  for (let i = 0; i < 203; i++) rows.push(await create(body({ title: prefix + '-' + i, content: i === 202 ? '特别正文 %_ 测试' : '普通正文' })));
  const first = (await req('get', '/agent/experiences?q=' + prefix + '&pageSize=20').expect(200)).body;
  const second = (await req('get', '/agent/experiences?q=' + prefix + '&pageSize=20&page=11').expect(200)).body;
  assert.equal(first.total, 203); assert.equal(first.memories.length, 20); assert.equal(second.memories.length, 3);
  assert.equal(new Set([...first.memories, ...second.memories].map(m => m.id)).size, 23);
  assert.equal((await req('get', '/agent/experiences?q=' + encodeURIComponent('%_')).expect(200)).body.total, 1);
  assert.equal((await req('get', '/agent/experiences?q=' + prefix + '&state=active').expect(200)).body.total, 0);
  const pending = await action(rows[0], 'submit');
  const filtered = (await req('get', '/agent/experiences?q=' + prefix + '&review=pending&kind=skill').expect(200)).body;
  assert.equal(filtered.total, 1); assert.equal(filtered.memories[0].id, pending.id); assert.ok(filtered.summary.pendingReview >= 1);
  for (const row of rows) await req('delete', '/agent/experiences/' + row.id, { revision: row.id === pending.id ? pending.revision : row.revision }).expect(200);
});

test('department, role and CSRF checks apply to every read and write; legal users cannot assign another department', async () => {
  const own = await create();
  const lawyer = { ...actor, id: randomUUID(), username: 'memory-lawyer', department: '其他部门', roles: ['legal'] };
  const business = { ...lawyer, id: randomUUID(), username: 'memory-business', roles: ['business'] };
  for (const user of [lawyer, business]) await db('la_users').insert({ ...user, roles: JSON.stringify(user.roles) });
  const auth = await login(lawyer);
  assert.equal((await auth.agent.get('/api/agent/experiences').expect(200)).body.total, 0);
  await auth.agent.get('/api/agent/experiences/' + own.id).expect(404);
  for (const name of ['submit', 'approve', 'reject', 'enable', 'disable']) await auth.agent.post(`/api/agent/experiences/${own.id}/${name}`).set('X-CSRF-Token', auth.token).send({ revision: own.revision, note: 'test' }).expect(404);
  await auth.agent.put('/api/agent/experiences/' + own.id).set('X-CSRF-Token', auth.token).send({ ...body(), revision: own.revision }).expect(404);
  await auth.agent.delete('/api/agent/experiences/' + own.id).set('X-CSRF-Token', auth.token).send({ revision: own.revision }).expect(404);
  const local = (await auth.agent.post('/api/agent/experiences').set('X-CSRF-Token', auth.token).send(body({ department: '测试' })).expect(201)).body;
  assert.equal(local.department, '其他部门');
  await auth.agent.post(`/api/agent/experiences/${local.id}/submit`).send({ revision: local.revision }).expect(403);
  const basic = await login(business);
  await basic.agent.get('/api/agent/experiences').expect(403);
  await basic.agent.post('/api/agent/experiences').set('X-CSRF-Token', basic.token).send(body()).expect(403);
});

test('published changes and deletion invalidate old runs, retain snapshots and reset restored context', async () => {
  let row = await publish(await create(body({ content: '固定的旧版知识正文' })));
  const c = await upload(); await service.processReview(db, c.reviewId, { runtimeFactory: emptyReview });
  const run = await db('la_reviews').where({ id: c.reviewId }).first(); assert.equal(run.status, 'completed');
  assert.equal(run.snapshot.memories.find(m => m.id === row.id).content, '固定的旧版知识正文');
  await db('la_agent_sessions').where({ id: run.agent_session_id }).update({ harness_id: 'old-context', notes: '{"obsolete":true}' });
  row = (await req('put', '/agent/experiences/' + row.id, { ...body({ content: '新版知识正文' }), revision: row.revision }).expect(200)).body;
  row = await publish(row);
  assert.equal((await db('la_reviews').where({ id: run.id }).first()).coverage.requiresRecheck, true);
  const next = (await req('post', '/agent-sessions/' + run.agent_session_id + '/messages', { content: '请重新核查', clientKey: randomUUID() }).expect(202)).body;
  assert.equal((await db('la_agent_sessions').where({ id: run.agent_session_id }).first()).harness_id, null);
  assert.equal((await db('la_reviews').where({ id: next.reviewId }).first()).snapshot.memories.find(m => m.id === row.id).version, 2);
  await service.processReview(db, next.reviewId, { runtimeFactory: emptyReview });
  await db('la_agent_sessions').where({ id: run.agent_session_id }).update({ harness_id: 'fresh-context', notes: '{"valid":"保留"}' });
  const fresh = (await req('post', '/agent-sessions/' + run.agent_session_id + '/messages', { content: '继续新版本核查', clientKey: randomUUID() }).expect(202)).body;
  const restored = await db('la_agent_sessions').where({ id: run.agent_session_id }).first();
  assert.equal(restored.harness_id, 'fresh-context'); assert.deepEqual(restored.notes, { valid: '保留' });
  await req('delete', '/agent/experiences/' + row.id, { revision: row.revision }).expect(200);
  await assert.rejects(service.assertActive(db, fresh.reviewId), { code: 'AGENT_MEMORY_REVOKED' });
  const history = await db('la_reviews').where({ id: run.id }).first();
  assert.equal(history.snapshot.memories.find(m => m.id === row.id).content, '固定的旧版知识正文');
  assert.equal((await db('la_agent_memory_versions').where({ memory_id: row.id })).length, 0);
  assert.equal(JSON.stringify((await db('la_audit').where({ entity_id: row.id, action: 'agent.memory.delete' }).first()).details).includes('正文'), false);
});

test('concurrent edits/approval have one winner and stale versions cannot submit', async () => {
  let row = await create();
  const edits = await Promise.all([1, 2].map(n => req('put', '/agent/experiences/' + row.id, { ...body({ title: '并发编辑-' + n }), revision: row.revision })));
  assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
  row = edits.find(r => r.status === 200).body; row = await action(row, 'submit');
  const approvals = await Promise.all([1, 2].map(() => req('post', `/agent/experiences/${row.id}/approve`, { revision: row.revision })));
  assert.deepEqual(approvals.map(r => r.status).sort(), [200, 409]);
  row = approvals.find(r => r.status === 200).body;
  const c = await upload();
  const pending = service.processReview(db, c.reviewId, { runtimeFactory: async ({ context, documents }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    row = await action(row, 'disable'); row = await action(row, 'enable');
    await assert.rejects(context.execute('submit_review', { report: { summary: '不能提交失效上下文', reviewedVersionIds: documents.map(d => d.versionId), findings: [] } }, randomUUID()), { code: 'AGENT_MEMORY_REVOKED' }); return {};
  }, async close() {} }) });
  await pending;
  assert.notEqual((await db('la_reviews').where({ id: c.reviewId }).first()).status, 'completed');
});

test('publication and permanent deletion serialize with final report submission', async () => {
  for (const mutation of ['approve', 'delete']) {
    let row = await publish(await create());
    const c = await upload();
    if (mutation === 'approve') {
      row = await management.save(db, actor, row.id, { ...body({ content: '待发布的新版方法' }), revision: row.revision });
      row = await action(row, 'submit');
    }
    const holder = await db.transaction();
    let processing;
    try {
      await holder('la_agent_memories').where({ id: row.id }).forUpdate().first();
      const holderPid = Number((await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      processing = service.processReview(db, c.reviewId, { runtimeFactory: emptyReview });
      // Wait until finalization is actually blocked on the item lock, not on timing guesses.
      let blocked = false;
      for (let i = 0; i < 300 && !blocked; i++) {
        blocked = (await db.raw("SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid)) AND query LIKE '%for share%'", [holderPid])).rows.length > 0;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'final submission must hold shared knowledge locks');
      await management.change(holder, actor, row.id, mutation, { revision: row.revision });
      await holder.commit();
      await processing;
      const run = await db('la_reviews').where({ id: c.reviewId }).first();
      assert.equal(run.error_code, 'AGENT_MEMORY_REVOKED'); assert.equal(run.coverage.requiresRecheck, true); assert.notEqual(run.status, 'completed');
      assert.equal(run.snapshot.memories.find(m => m.id === row.id).version, 1);
    } finally { if (!holder.isCompleted()) await holder.rollback(); await processing; }
  }
});

test('system promotion preserves content, conditions, source and versions, and is reversible', async () => {
  let row = await create(body({ title: '条件系统方法', conditions: ['仅限示例公司采购合同'] }));
  await req('post', `/agent/experiences/${row.id}/promote`, { revision: row.revision }).expect(409);
  row = await publish(row);
  const original = { content: row.content, conditions: row.conditions, source: row.source_id, version: row.version };
  const c = await upload();
  row = await action(row, 'promote');
  assert.equal(row.is_system, true);
  assert.deepEqual({ content: row.content, conditions: row.conditions, source: row.source_id, version: row.version }, original);
  await req('post', `/agent/experiences/${row.id}/demote`, { revision: row.revision - 1 }).expect(409);
  await assert.rejects(service.assertActive(db, c.reviewId), { code: 'AGENT_MEMORY_REVOKED' });
  assert.ok((await req('get', '/agent/experiences?kind=system').expect(200)).body.memories.some(m => m.id === row.id));
  assert.ok(!(await req('get', '/agent/experiences?kind=skill').expect(200)).body.memories.some(m => m.id === row.id));
  const next = await upload();
  const frozen = await db('la_reviews').where({ id: next.reviewId }).first();
  const required = frozen.snapshot.systemSkills.find(s => s.memoryId === row.id);
  assert.equal(required.memoryVersion, original.version); assert.match(required.content, /仅限示例公司采购合同/);
  await service.processReview(db, next.reviewId, { runtimeFactory: async ({ context, documents }) => ({ async run() {
    assert.equal(context.skills.filter(s => s.name === 'legal-' + row.id).length, 1);
    assert.ok(context.requiredSkills.some(s => s.memoryId === row.id));
    return (await emptyReview({ context, documents })).run();
  }, async close() {} }) });
  assert.equal((await db('la_reviews').where({ id: next.reviewId }).first()).status, 'completed');
  assert.ok(await db('la_agent_events').where({ review_id: next.reviewId, type: 'skill_loaded' }).whereJsonSupersetOf('data', { name: required.name, mode: 'required_preload', required: true }).first());
  const other = await service.usableMemories(db, { department: '其他部门' }); assert.ok(!other.some(m => m.id === row.id));
  await req('put', '/agent/experiences/' + row.id, { ...body({ kind: 'experience' }), revision: row.revision }).expect(409);
  row = await action(row, 'disable');
  assert.ok(!(await service.usableMemories(db, { department: '测试' })).some(m => m.id === row.id));
  row = await action(row, 'demote'); assert.equal(row.is_system, false); assert.equal(row.state, 'disabled');
  const detail = (await req('get', '/agent/experiences/' + row.id).expect(200)).body;
  assert.equal(detail.versions.length, 1);
  assert.ok(detail.history.some(h => h.action === 'agent.memory.promote' && h.details.to === 'system'));
  assert.ok(detail.history.some(h => h.action === 'agent.memory.demote' && h.details.to === 'skill'));
  assert.equal(frozen.snapshot.memories.find(m => m.id === row.id).is_system, true);
  await req('delete', '/agent/experiences/' + row.id, { revision: row.revision }).expect(200);
});

test('promotion rejects pending drafts, case experience, unauthorized users, and revoked sources', async () => {
  let row = await publish(await create());
  row = (await req('put', '/agent/experiences/' + row.id, { ...body(), revision: row.revision }).expect(200)).body;
  await req('post', `/agent/experiences/${row.id}/promote`, { revision: row.revision }).expect(409);
  row = await action(row, 'submit');
  await req('post', `/agent/experiences/${row.id}/promote`, { revision: row.revision }).expect(409);
  const experience = await publish(await create(body({ kind: 'experience' })));
  await req('post', `/agent/experiences/${experience.id}/promote`, { revision: experience.revision }).expect(409);
  const legacy = (await req('get', '/agent/experiences/' + legacyId).expect(200)).body;
  const system = await action(legacy, 'promote');
  assert.equal(system.source_id, sourceId);
  await memory.revoke(db, sourceId, actor, '隔离测试撤销系统技能来源');
  await req('post', `/agent/experiences/${system.id}/demote`, { revision: system.revision + 1 }).expect(409);
  assert.ok(!(await service.usableMemories(db, { department: '测试' })).some(m => m.id === system.id));
  // Restore the fixture so the existing source-history test can still verify permanent deletion.
  await db('la_agent_legal_events').where({ id: sourceId }).update({ revoked_at: null });
  await db('la_agent_memories').where({ id: legacyId }).update({ state: 'active', is_system: false });
  for (const user of [{ id: randomUUID(), username: 'promotion-business', roles: ['business'], department: '测试' }, { id: randomUUID(), username: 'promotion-other', roles: ['legal'], department: '其他部门' }]) {
    await db('la_users').insert({ ...actor, ...user, roles: JSON.stringify(user.roles) });
    const auth = await login(user);
    for (const name of ['promote', 'demote']) await auth.agent.post(`/api/agent/experiences/${experience.id}/${name}`).set('X-CSRF-Token', auth.token).send({ revision: experience.revision }).expect(user.roles[0] === 'business' ? 403 : 404);
  }
  await client.post(`/api/agent/experiences/${experience.id}/promote`).send({ revision: experience.revision }).expect(403);
});

test('early source totals survive permanent deletion even without any learned audit', async () => {
  const legacy = (await req('get', '/agent/experiences/' + legacyId).expect(200)).body;
  await req('delete', '/agent/experiences/' + legacyId, { revision: legacy.revision }).expect(200);
  const source = (await req('get', '/agent/experience-sources/' + sourceId).expect(200)).body;
  assert.deepEqual([source.generatedCount, source.skillCount, source.experienceCount], [1, 1, 0]);
  assert.deepEqual(source.memories, []);
});

test('real browser promotes a skill, shows its scope, switches it back and paginates system skills', { skip: process.env.MEMORY_UI_QA !== '1' }, async () => {
  const { chromium } = require(path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  const output = path.resolve('.local/skill-promotion-qa'); await fs.mkdir(output, { recursive: true });
  let row = await publish(await create(body({ title: '浏览器系统切换-' + randomUUID(), conditions: ['仅限示例公司合同'] })));
  const server = http.createServer(handle.app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port; config.publicUrl = base;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const session = await (await page.request.get(base + '/api/auth/session')).json();
    assert.equal((await page.request.post(base + '/api/auth/login', { headers: { 'X-CSRF-Token': session.csrf }, data: { username: actor.username, password: 'memory-test-password' } })).status(), 200);
    await page.goto(base + '/#/experience');
    await page.getByRole('button', { name: '审查技能', exact: true }).click();
    await page.getByLabel('搜索技能或经验', { exact: true }).fill(row.title);
    const card = page.locator('.knowledge-card').filter({ has: page.getByRole('button', { name: row.title, exact: true }) });
    await card.getByRole('button', { name: '设为系统技能', exact: true }).click();
    const promote = page.getByRole('dialog', { name: '设为系统技能', exact: true });
    await promote.getByText(/按原有适用条件执行/).waitFor();
    await promote.getByRole('button', { name: '确认设为系统技能', exact: true }).click();
    await promote.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '系统技能', exact: true }).click();
    await card.getByRole('button', { name: '切回审查技能', exact: true }).waitFor();
    await card.getByText('每轮必读 · 按适用条件执行', { exact: true }).waitFor();
    await card.getByText('仅限示例公司合同', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'promoted-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'promoted-mobile.png'), fullPage: true });
    await card.getByRole('button', { name: '切回审查技能', exact: true }).click();
    const demote = page.getByRole('dialog', { name: '切回审查技能', exact: true });
    await demote.getByRole('button', { name: '确认切回审查技能', exact: true }).click();
    await demote.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '审查技能', exact: true }).click();
    await card.getByRole('button', { name: '设为系统技能', exact: true }).waitFor();
    row = await management.get(db, actor, row.id);
    const prefix = '系统分页-' + randomUUID(), rows = [];
    for (let i = 0; i < 21; i++) rows.push(await action(await publish(await create(body({ title: prefix + '-' + i }))), 'promote'));
    await page.getByLabel('搜索技能或经验', { exact: true }).fill(prefix);
    await page.getByRole('button', { name: '系统技能', exact: true }).click();
    const pagination = page.getByRole('navigation', { name: '知识分页', exact: true });
    await pagination.getByText('共 21 条 · 第 1 / 2 页', { exact: true }).waitFor();
    await pagination.getByRole('button', { name: '下一页', exact: true }).click();
    await pagination.getByText('共 21 条 · 第 2 / 2 页', { exact: true }).waitFor();
    assert.equal(await page.locator('.knowledge-card').count(), 1);
    for (const item of rows) await management.change(db, actor, item.id, 'delete', { revision: item.revision });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks: ['promotion', 'conditions', 'demotion', 'mobile', 'system-pagination'], errors }, null, 2));
  } finally { await browser.close(); await new Promise(r => server.close(r)); await management.change(db, actor, row.id, 'delete', { revision: row.revision }); }
});

test('real browser completes management, paging, conflict handling and mobile layout', { skip: process.env.MEMORY_UI_QA !== '1' }, async () => {
  const { chromium } = require(path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  const output = path.resolve('.local/memory-management'); await fs.mkdir(output, { recursive: true });
  const server = http.createServer(handle.app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port; config.publicUrl = base;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.setDefaultTimeout(12000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const session = await (await page.request.get(base + '/api/auth/session')).json();
    assert.equal((await page.request.post(base + '/api/auth/login', { headers: { 'X-CSRF-Token': session.csrf }, data: { username: actor.username, password: 'memory-test-password' } })).status(), 200);
    await page.goto(base + '/#/experience');
    await page.getByRole('heading', { name: '法务经验', exact: true }).waitFor();
    await page.getByRole('button', { name: '系统技能', exact: true }).click();
    await page.getByRole('button', { name: '法务实务审改', exact: true }).waitFor();
    assert.equal(await page.locator('.knowledge-card').count(), 2);
    assert.equal(await page.locator('.knowledge-card').getByRole('button', { name: '删除', exact: true }).count(), 0);
    await page.getByRole('button', { name: '法务实务审改', exact: true }).click();
    const builtin = page.getByRole('dialog', { name: '系统技能详情', exact: true });
    await builtin.getByRole('heading', { name: '必读范例', exact: true }).waitFor();
    assert.ok((await builtin.innerText()).includes('用一句限制代理权限'));
    await builtin.getByRole('button', { name: 'Close this dialog', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.el-overlay')].every(el => getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.getByRole('button', { name: '系统技能', exact: true }).evaluate(el => el.getBoundingClientRect().right <= el.closest('.knowledge-panel').getBoundingClientRect().right));
    await page.screenshot({ path: path.join(output, 'system-skills-mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.screenshot({ path: path.join(output, 'system-skills-desktop.png'), fullPage: true });
    await page.getByLabel('搜索技能或经验', { exact: true }).fill('用一句限制代理权限');
    await page.waitForResponse(r => r.url().includes('/api/agent/experiences?') && r.url().includes('q='));
    await page.waitForFunction(() => document.querySelectorAll('.knowledge-card').length === 1);
    assert.equal(await page.locator('.knowledge-card').count(), 1);
    await page.getByLabel('搜索技能或经验', { exact: true }).fill('');
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.getByRole('button', { name: '新增知识', exact: true }).first().click();
    let dialog = page.getByRole('dialog', { name: '新增知识', exact: true });
    const title = '浏览器验收知识-' + randomUUID();
    await dialog.getByLabel('标题', { exact: true }).fill(title);
    await dialog.getByLabel('摘要', { exact: true }).fill('浏览器验证付款条件');
    await dialog.getByLabel('完整内容', { exact: true }).fill('核验付款触发条件与验收标准。');
    await dialog.getByLabel('适用条件', { exact: false }).fill('采购合同\n存在验收安排');
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '知识详情', exact: true });
    await detail.getByRole('heading', { name: title, exact: true }).first().waitFor();
    async function operate(name, confirm, note) {
      await detail.getByRole('button', { name, exact: true }).click();
      const op = page.getByRole('dialog', { name: name + '知识', exact: true });
      if (note) await op.locator('textarea').fill(note);
      await op.getByRole('button', { name: confirm, exact: true }).click();
      await op.waitFor({ state: 'hidden' });
    }
    await operate('提交审核', '确认提交审核');
    await operate('退回修改', '确认退回修改', '补充适用条件后重提');
    await detail.getByRole('button', { name: '编辑', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '编辑知识草稿', exact: true });
    await dialog.getByLabel('完整内容', { exact: true }).fill('核验验收条件并保留争议处理机制。');
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await operate('提交审核', '确认提交审核'); await operate('审核通过', '确认审核通过', '已核对来源与适用条件');
    await detail.getByRole('heading', { name: /当前正式版本 · v1/ }).waitFor();
    await operate('停用', '确认停用'); await operate('启用', '确认启用');
    await page.screenshot({ path: path.join(output, 'knowledge-detail.png'), fullPage: true });
    await detail.getByRole('button', { name: '编辑', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '编辑知识草稿', exact: true });
    const item = (await management.list(db, actor, { q: title })).memories[0];
    await management.save(db, actor, item.id, { ...body(), revision: item.revision });
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '记录已更新' }).waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await detail.getByRole('button', { name: 'Close this dialog', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByLabel('搜索技能或经验', { exact: true }).fill(title);
    const card = page.locator('.knowledge-card').filter({ hasText: title }); await card.waitFor();
    await page.waitForResponse(r => r.url().includes('/api/agent/experiences?') && r.url().includes('q='));
    await page.waitForFunction(() => document.querySelectorAll('.knowledge-card').length === 1);
    assert.equal(await page.locator('.knowledge-card').count(), 1);
    await page.screenshot({ path: path.join(output, 'knowledge-management.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'knowledge-mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await card.getByRole('button', { name: '删除', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '删除知识', exact: true });
    await deletion.getByText(/无法恢复/).waitFor(); await deletion.getByRole('button', { name: '确认永久删除', exact: true }).click();
    await deletion.waitFor({ state: 'hidden' }); await page.getByRole('heading', { name: '没有找到相关知识', exact: true }).waitFor();
    const pagingTitle = '浏览器分页-' + randomUUID();
    for (let i = 0; i < 21; i++) await management.create(db, actor, body({ kind: 'experience', title: pagingTitle + '-' + i }));
    await page.getByLabel('搜索技能或经验', { exact: true }).fill(pagingTitle);
    await page.getByLabel('审核状态', { exact: true }).selectOption('draft');
    await page.getByRole('button', { name: '案例经验', exact: true }).click();
    const pagination = page.getByRole('navigation', { name: '知识分页', exact: true });
    await pagination.getByText('共 21 条 · 第 1 / 2 页', { exact: true }).waitFor();
    await pagination.getByRole('button', { name: '下一页', exact: true }).click();
    await pagination.getByText('共 21 条 · 第 2 / 2 页', { exact: true }).waitFor();
    assert.equal(await page.locator('.knowledge-card').count(), 1);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, checks: ['create', 'edit', 'reject', 'submit', 'self-approve', 'disable', 'enable', 'conflict', 'search', 'filters', 'paging', 'mobile', 'permanent-delete'], pageErrors: errors }, null, 2));
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
});
