const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const supertest = require('supertest');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli');
const { hashPassword } = require('../../pilot/auth');
const { createApp } = require('../../pilot/app');
const { startBinding, completeBinding } = require('../../pilot/dingtalk-account');
const { persistEvent, processIntegration, reconcileKnownApprovals } = require('../../pilot/dingtalk');
const { processReview } = require('../../pilot/workflow');
let root, db, name, handle, alice, bob, admin, aliceAgent, csrf;
const pdf = Buffer.from('%PDF-1.4\n% test-only fixture');
const resolve = async () => ({ userId: 'ding-alice', displayName: 'Alice 钉钉' });
const bindingInput = async user => { const url = new URL((await startBinding(db, user)).url); return { code: 'fixture-code', state: url.searchParams.get('state') }; };
const files = [{ fileId: 'pdf', fileName: '合同.PDF' }, { fileId: 'docx', fileName: 'invalid.docx' }, { fileId: 'xlsx', fileName: '清单.xlsx' }];
const detail = (userIds = ['ding-alice'], attachments = files) => ({ status: 'RUNNING', tasks: userIds.map(userId => ({ userId, status: 'NEW', result: 'NONE' })), formComponentValues: [{ name: '任意附件名称', value: JSON.stringify(attachments) }] });
async function intake(instance, info, attachment = async () => pdf, app = 'test-app') {
  const id = await persistEvent(db, { processInstanceId: instance, staffId: 'ding-alice', eventType: 'bpms_task_change' }, randomUUID(), app);
  await processIntegration(db, id, { detail: async () => info, attachment });
  return db('la_integration_events').where({ id }).first();
}
async function bind(user, identity) { await completeBinding(db, user, await bindingInput(user), { resolve: identity ? async () => identity : resolve }); }
before(async () => {
  root = createDb(); name = 'legal_test_ding_' + randomUUID().replaceAll('-', ''); await root.raw(`CREATE DATABASE "${name}"`);
  const url = new URL(config.databaseUrl); url.pathname = '/' + name; config.databaseUrl = url.href;
  config.dataRoot = path.resolve(__dirname, '../../../.local/test-data', name);
  Object.assign(config.ding, { enabled: true, clientId: 'test-app', secret: 'fixture-secret' });
  db = createDb(); await migrate(db); await require('../../pilot/storage').initializeDirectories();
  const password = 'test-only-password-1234';
  for (const username of ['alice', 'bob', 'admin']) {
    const row = { id: randomUUID(), username, display_name: username, roles: [username === 'admin' ? 'admin' : 'business'], department: username };
    await db('la_users').insert({ ...row, roles: JSON.stringify(row.roles), password_hash: await hashPassword(password) });
    if (username === 'alice') alice = row; else if (username === 'bob') bob = row; else admin = row;
  }
  handle = createApp(db); aliceAgent = supertest.agent(handle.app);
  const session = await aliceAgent.get('/api/auth/session');
  const login = await aliceAgent.post('/api/auth/login').set('X-CSRF-Token', session.body.csrf).send({ username: 'alice', password }).expect(200); csrf = login.body.csrf;
});
after(async () => { await handle?.close(); await db?.destroy(); if (root && name) { await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [name]); await root.raw(`DROP DATABASE "${name}"`); } await root?.destroy(); });

test('binding routes enforce login, recipient role and CSRF; status never discloses UserID', async () => {
  await supertest(handle.app).get('/api/dingtalk/account').expect(401);
  await aliceAgent.post('/api/dingtalk/account/start').send({}).expect(403);
  const input = await bindingInput(alice);
  await assert.rejects(completeBinding(db, bob, input, { resolve }), e => e.code === 'DING_BIND_STATE');
  await completeBinding(db, alice, input, { resolve });
  await assert.rejects(completeBinding(db, alice, input, { resolve }), e => e.code === 'DING_BIND_STATE');
  const status = (await aliceAgent.get('/api/dingtalk/account').expect(200)).body;
  assert.equal(status.account.displayName, 'Alice 钉钉'); assert.ok(!JSON.stringify(status).includes('ding-alice')); assert.equal(status.enabled, true);
  await assert.rejects(completeBinding(db, bob, await bindingInput(bob), { resolve }), e => e.code === 'DING_ACCOUNT_BOUND');
  await completeBinding(db, admin, await bindingInput(admin), { resolve: async () => ({ userId: 'admin-ding', displayName: 'admin' }) });
});

test('expired state, app changes and unbinding during OAuth resolution prevent binding', async () => {
  const expired = await bindingInput(bob); await db('la_dingtalk_binding_requests').where({ user_id: bob.id }).update({ expires_at: new Date(0) });
  await assert.rejects(completeBinding(db, bob, expired, { resolve }), e => e.code === 'DING_BIND_STATE');
  const changed = await bindingInput(bob); config.ding.secret = 'rotated';
  await assert.rejects(completeBinding(db, bob, changed, { resolve }), e => e.code === 'DING_BIND_STATE'); config.ding.secret = 'fixture-secret';
  const pending = await bindingInput(alice);
  await assert.rejects(completeBinding(db, alice, pending, { resolve: async () => {
    await aliceAgent.delete('/api/dingtalk/account').set('X-CSRF-Token', csrf).expect(200); return resolve();
  } }), e => e.code === 'DING_BIND_STATE');
  assert.equal(await db('la_dingtalk_accounts').where({ user_id: alice.id }).first(), undefined);
  await bind(alice);
});

test('collects valid files despite one failure, skips spreadsheets, retries by hash without duplicating', async () => {
  let downloads = 0;
  const event = await intake('mixed-files', detail(), async () => { downloads++; return pdf; });
  assert.equal((await db('la_outbox').whereRaw("payload->>'eventId' = ?", [event.id]).first()).queue, 'integration-live');
  assert.equal(event.status, 'waiting_confirmation'); assert.deepEqual([event.summary.collected, event.summary.skipped, event.summary.failed], [1, 1, 1]); assert.equal(downloads, 2);
  const contract = await db('la_contracts').where({ source: 'dingtalk', submitter_id: alice.id }).first(); assert.deepEqual(contract.background, {});
  const otherFiles = [{ fileId: 'pdf', fileName: '合同.PDF' }, { fileId: 'second-pdf', fileName: '附件.pdf' }];
  const retry = await intake('mixed-files', detail(['ding-alice'], otherFiles));
  assert.equal(retry.status, 'completed'); assert.equal(retry.summary.duplicate, 1); assert.equal(retry.summary.collected, 1);
  const updated = await intake('mixed-files', detail(['ding-alice'], [otherFiles[0]]), async () => Buffer.from('%PDF-1.4\n% changed'));
  assert.equal(updated.summary.collected, 1);
  assert.equal(Number((await db('la_versions').where({ contract_id: contract.id }).count('* as n').first()).n), 2);
  // Actual background checks happen after parsing; collection itself is already complete.
  const AdmZip = require('adm-zip'), zip = new AdmZip(); zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>测试合同</w:t></w:r></w:p></w:body></w:document>'));
  await intake('docx-background', detail(['ding-alice'], [{ fileId: 'valid-docx', fileName: '测试.docx' }]), async () => zip.toBuffer());
  const c = await db('la_contracts').where({ title: '测试.docx' }).first();
  await processReview(db, c.current_review_id); assert.equal((await db('la_reviews').where({ id: c.current_review_id }).first()).error_code, 'BACKGROUND_REQUIRED');
});

test('forged event recipient, completed tasks, missing bindings and wrong app never download', async () => {
  const attachment = async () => { throw new Error('must not download'); };
  for (const [instance, info, app] of [
    ['wrong-recipient', detail(['someone-else']), 'test-app'],
    ['done-task', { ...detail(), tasks: [{ userId: 'ding-alice', status: 'COMPLETED' }] }, 'test-app'],
    ['done-instance', { ...detail(), status: 'COMPLETED' }, 'test-app'],
    ['wrong-app', detail(), 'another-app'],
  ]) assert.equal((await intake(instance, info, attachment, app)).status, 'ignored');
});

test('multiple bound recipients have independent records and same-name attachments stay separate', async () => {
  await bind(bob, { userId: 'ding-bob', displayName: 'Bob' });
  const sameNames = [{ fileId: 'one', fileName: '同名.pdf' }, { fileId: 'two', fileName: '同名.pdf' }];
  const e = await intake('parallel', detail(['ding-alice', 'ding-bob'], sameNames)); assert.equal(e.summary.collected, 4);
  const contracts = await db('la_contracts').where({ title: '同名.pdf' }); assert.equal(contracts.length, 4);
  const bobs = contracts.filter(c => c.submitter_id === bob.id); assert.equal(bobs.length, 2);
  await aliceAgent.get('/api/contracts/' + bobs[0].id).expect(404);
  const again = await intake('parallel', detail(['ding-alice', 'ding-bob'], sameNames)); assert.equal(again.summary.duplicate, 4);
});

test('disable, role removal and unbind while downloading prevent new records at commit', async () => {
  const initial = Number((await db('la_contracts').count('* as n').first()).n);
  await intake('unbind-in-flight', detail(), async () => { await aliceAgent.delete('/api/dingtalk/account').set('X-CSRF-Token', csrf).expect(200); return pdf; });
  assert.equal(Number((await db('la_contracts').count('* as n').first()).n), initial); await bind(alice);
  const disabled = await intake('disable-in-flight', detail(), async () => { config.ding.enabled = false; return pdf; }); assert.equal(disabled.status, 'waiting_confirmation'); config.ding.enabled = true;
  await db('la_users').where({ id: alice.id }).update({ roles: JSON.stringify([]) });
  const demoted = await intake('demoted', detail(['ding-alice'], [files[0]])); assert.equal(demoted.summary.collected, 0);
  await db('la_users').where({ id: alice.id }).update({ roles: JSON.stringify(['business']) });
  await db('la_users').where({ id: alice.id }).update({ active: false });
  const inactive = await intake('inactive', detail(['ding-alice'], [files[0]])); assert.equal(inactive.summary.collected, 0);
  await db('la_users').where({ id: alice.id }).update({ active: true });
  assert.equal(Number((await db('la_contracts').count('* as n').first()).n), initial);
});

test('concurrent delivery creates one contract, while application-scoped event keys stay independent', async () => {
  const info = detail(['ding-alice'], [files[0]]);
  const events = await Promise.all([intake('concurrent-instance', info), intake('concurrent-instance', info)]);
  assert.equal(events.reduce((n, e) => n + e.summary.collected, 0), 1);
  assert.equal(events.reduce((n, e) => n + e.summary.duplicate, 0), 1);
  const payload = { processInstanceId: 'separate-apps', eventType: 'bpms_task_change' };
  const a = await persistEvent(db, payload, 'same-id', 'test-app');
  assert.equal(await persistEvent(db, payload, 'same-id', 'test-app'), a);
  assert.notEqual(await persistEvent(db, payload, 'same-id', 'other-app'), a);
});

test('reconciliation pauses when unprocessed integration events are backlogged', async () => {
  const before = Number((await db('la_integration_events').count('* as n').first()).n);
  for (let i = 0; i < 101; i++) {
    await db('la_integration_events').insert({
      id: randomUUID(), client_id: 'test-app', dedup_key: randomUUID(), event_type: 'approval',
      status: 'received', payload: JSON.stringify({ processInstanceId: `backlog-${i}` }), summary: JSON.stringify({}),
    });
  }
  const result = await reconcileKnownApprovals(db, { clientId: 'test-app' }, { now: new Date('2026-10-31T00:00:00Z') });
  assert.equal(result.skipped, 'backlog');
  assert.equal(Number((await db('la_integration_events').count('* as n').first()).n), before + 101);
});

test('reconciliation intake stays out of the main ledger until legal confirms it', async () => {
  const eventId = await persistEvent(db, { processInstanceId: 'reconciliation-ui', eventType: 'reconciliation' }, randomUUID(), 'test-app');
  await processIntegration(db, eventId, { detail: async () => detail(['ding-alice'], [{ fileId: 'reconciliation-pdf', fileName: '历史补查待确认.pdf' }]), attachment: async () => pdf });
  const contract = await db('la_contracts').where({ title: '历史补查待确认.pdf' }).first();
  assert.equal(contract.intake_mode, 'reconciliation');
  assert.equal(contract.intake_review_status, 'pending');
  assert.equal((await aliceAgent.get('/api/contracts?page=1&q=历史补查待确认').expect(200)).body.total, 0);
  const pending = await aliceAgent.get('/api/contracts?view=reconciliation-pending&page=1&q=历史补查待确认').expect(200);
  assert.equal(pending.body.total, 1);
  assert.equal(pending.body.items[0].attachmentCount, 1);

  await db('la_users').where({ id: alice.id }).update({ roles: JSON.stringify(['legal']) });
  const confirmed = await aliceAgent.post(`/api/contracts/${contract.id}/intake-confirm`).set('X-CSRF-Token', csrf).send({ revision: contract.revision }).expect(200);
  assert.equal(confirmed.body.intake_review_status, 'confirmed');
  assert.equal((await aliceAgent.get('/api/contracts?page=1&q=历史补查待确认').expect(200)).body.total, 1);

  const dismissedEventId = await persistEvent(db, { processInstanceId: 'reconciliation-dismiss', eventType: 'reconciliation' }, randomUUID(), 'test-app');
  await processIntegration(db, dismissedEventId, { detail: async () => detail(['ding-alice'], [{ fileId: 'dismiss-pdf', fileName: '历史补查无需处理.pdf' }]), attachment: async () => pdf });
  const dismissed = await db('la_contracts').where({ title: '历史补查无需处理.pdf' }).first();
  await aliceAgent.post(`/api/contracts/${dismissed.id}/intake-dismiss`).set('X-CSRF-Token', csrf).send({ revision: dismissed.revision }).expect(200);
  assert.equal((await aliceAgent.get('/api/contracts?page=1&q=历史补查无需处理').expect(200)).body.total, 0);
  const history = await aliceAgent.get('/api/contracts?view=all&intakeMode=reconciliation&intakeReviewStatus=dismissed&q=历史补查无需处理').expect(200);
  assert.equal(history.body.length, 1);
});
