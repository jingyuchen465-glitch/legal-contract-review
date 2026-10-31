const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const supertest = require('supertest');
const AdmZip = require('adm-zip');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli');
const { createApp } = require('../../pilot/app');
const { hashPassword } = require('../../pilot/auth');
const { seedDrafts, examplePacks } = require('../../pilot/seeds');
const { createDraft, matchRules } = require('../../pilot/rules');
const { processReview } = require('../../pilot/workflow');
const { createGateway } = require('../../pilot/model');
const { reportData } = require('../../pilot/reports');

const password = 'software-engineering-test-only';
const background = { ourEntity: '虚构采购公司', perspective: '软件采购方', purpose: '定制软件及维护' };
const text = '乙方为甲方开发合同管理软件，收取70%预付款。交付后3日未提出异议视为验收。源代码不交付。上传合同可用于模型训练。';
let rootDb, db, database, handle, agents = {}, tokens = {}, users = {}, item, trialId;
const call = (name, method, url, body) => agents[name][method]('/api' + url).set('X-CSRF-Token', tokens[name]).send(body);
async function publish(version) {
  await call('publisher', 'post', `/rule-pack-versions/${version.id}/submit`, { revision: version.revision }).expect(200);
  await call('publisher', 'post', `/rule-pack-versions/${version.id}/publish`, { revision: version.revision + 1 }).expect(200);
}
function document() {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}
function gateway() {
  return createGateway(db, { fetchImpl: async (_, request) => {
    const messages = JSON.parse(request.body).messages, input = JSON.parse(messages[1].content);
    const result = input.rules ? { checks: input.rules.map(rule => ({ ruleId: rule.id, status: 'fail', kind: 'clause', severity: rule.severity, reason: '虚构测试：请法务核实此约定与交易目的是否匹配', suggestion: '虚构测试：补充约定', evidence: [{ blockId: input.blocks[0].id, quote: '源代码不交付' }], legalRefIds: [] })) } : { typeId: 'software_license', tags: ['知识产权', '数据处理'], evidence: [{ blockId: input.blocks[0].id, quote: '开发合同管理软件' }], uncertain: false };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
}
let savedModel;
before(async () => {
  rootDb = createDb(); database = 'legal_test_software_' + randomUUID().replaceAll('-', '');
  await rootDb.raw(`CREATE DATABASE "${database}"`);
  const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
  config.dataRoot = path.resolve(__dirname, '../../../.local/test-data', database); db = createDb(); await migrate(db);
  savedModel = { ...config.model }; Object.assign(config.model, { baseUrl: 'http://localhost:9999/v1', name: 'fixture-only', key: 'fixture-only' });
  for (const name of ['business', 'legal', 'publisher']) {
    const user = { id: randomUUID(), username: name, display_name: name, department: '虚构软件部门', roles: JSON.stringify([name]), password_hash: await hashPassword(password) };
    await db('la_users').insert(user); users[name] = user;
  }
  handle = createApp(db);
  for (const name of Object.keys(users)) {
    agents[name] = supertest.agent(handle.app); const session = await agents[name].get('/api/auth/session');
    const result = await agents[name].post('/api/auth/login').set('X-CSRF-Token', session.body.csrf).send({ username: name, password }).expect(200); tokens[name] = result.body.csrf;
  }
  await seedDrafts(db);
  const result = await agents.business.post('/api/contracts/upload').set('X-CSRF-Token', tokens.business).field('background', JSON.stringify(background)).attach('file', document(), '虚构软件开发合同.docx').expect(201); item = result.body;
});
after(async () => {
  if (savedModel) Object.assign(config.model, savedModel);
  await handle?.close(); await db?.destroy();
  if (rootDb && database) { await rootDb.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]); await rootDb.raw(`DROP DATABASE "${database}"`); }
  await rootDb?.destroy();
});
test('software example installation is idempotent and does not auto-publish company rules', async () => {
  await seedDrafts(db); const versions = await db('la_rule_versions');
  assert.equal(versions.length, 4); assert.ok(versions.every(version => version.state === 'draft'));
  const software = versions.find(version => version.pack_id === 'software'); assert.equal(software.rules.length, 11);
  assert.equal(new Set(software.rules.map(rule => rule.id)).size, 11);
  const catalog = await call('business', 'get', '/catalog').expect(200);
  const type = catalog.body.categories.flatMap(c => c.types).find(t => t.id === 'software_license');
  assert.equal(type.trialAvailable, true); assert.equal(type.reviewEnabled, false);
});
test('formal software review still requires published rules; trial mode cannot be injected as a different value', async () => {
  await processReview(db, item.reviewId, { gateway: gateway() });
  const run = await db('la_reviews').where({ id: item.reviewId }).first(); assert.equal(run.error_code, 'NO_PUBLISHED_RULES'); assert.equal(run.status, 'waiting_input');
  const contract = await db('la_contracts').where({ id: item.contract.id }).first();
  await call('business', 'post', '/reviews', { contractId: contract.id, revision: contract.revision, mode: 'bypass' }).expect(400);
});
test('software trial runs all 15 common and specialty checks through the real gateway with verified references', async () => {
  const contract = await db('la_contracts').where({ id: item.contract.id }).first();
  const result = await call('business', 'post', '/reviews', { contractId: contract.id, revision: contract.revision, mode: 'trial' }).expect(202); trialId = result.body.reviewId;
  const pinned = await db('la_reviews').where({ id: trialId }).first(); assert.equal(pinned.snapshot.reviewMode, 'trial'); assert.equal(pinned.snapshot.examplePacks.length, 4);
  // Edits to company drafts do not silently change a trial's pinned built-in examples.
  await db('la_rule_versions').where({ pack_id: 'software' }).update({ rules: JSON.stringify([{ id: 'edited-draft', title: 'edited', instruction: 'edited', mandatory: true, severity: 'low' }]) });
  await processReview(db, trialId, { gateway: gateway() });
  const run = (await call('legal', 'get', '/reviews/' + trialId).expect(200)).body;
  assert.equal(run.status, 'completed'); assert.equal(run.snapshot.reviewMode, 'trial'); assert.equal(run.coverage.checkedRules, 15);
  assert.equal(run.coverage.totalRules, 15); assert.equal(run.findings.length, 15); assert.ok(run.findings.some(f => f.rule_id === 'software-data'));
  assert.equal(run.coverage.ruleBatches, 3);
  const batches = (await db('la_job_steps').where({ review_id: trialId, stage: 'model_call' })).filter(step => step.details.label === 'review');
  assert.deepEqual(batches.map(step => step.details.ruleBatchIndex), [1, 2, 3]); assert.ok(batches.every(step => step.details.ruleBatchCount === 3));
  assert.ok(!run.findings.some(f => f.rule_id === 'edited-draft'));
  assert.equal(run.snapshot.packs.length, 2); assert.ok(run.snapshot.packs.every(pack => pack.id.startsWith('example:')));
  assert.ok((await db('la_audit').where({ action: 'review.create', entity_id: trialId }).first()).details.mode === 'trial');
});
test('trial reports carry the mode label and the server rejects a final decision even after every finding is accepted', async () => {
  let contract = await db('la_contracts').where({ id: item.contract.id }).first();
  await call('legal', 'put', `/contracts/${contract.id}/classification`, { revision: contract.revision, typeId: 'software_license', tags: ['知识产权', '数据处理'], perspectiveConfirmed: true }).expect(200);
  for (const finding of await db('la_findings').where({ review_id: trialId })) await call('legal', 'put', `/reviews/${trialId}/findings/${finding.id}/disposition`, { revision: finding.revision, action: 'accept' }).expect(200);
  contract = await db('la_contracts').where({ id: item.contract.id }).first();
  const result = await call('legal', 'post', `/reviews/${trialId}/decision`, { revision: contract.revision, outcome: 'agree' }).expect(409); assert.equal(result.body.code, 'TRIAL_REVIEW_ONLY');
  const report = await agents.business.get(`/api/reviews/${trialId}/report`).expect(200); assert.match(report.text, /示例规则试审报告/); assert.match(report.text, /本报告不能用于最终结论/);
  const run = await db('la_reviews').where({ id: trialId }).first(), version = await db('la_versions').where({ id: item.version.id }).first();
  const data = reportData(contract, version, run, await db('la_findings').where({ review_id: trialId }), null);
  assert.match(data.party_review[0].description, /示例规则试审/); assert.match(data.template.name, /示例规则试审/);
  await agents.business.get(`/api/reviews/${trialId}/report?format=docx`).expect(200);
});
test('publishing a legal-confirmed software pack enables formal review without changing historical trial snapshots', async () => {
  const previous = (await db('la_reviews').where({ id: trialId }).first()).snapshot;
  for (const pack of examplePacks().filter(p => ['common', 'software'].includes(p.pack_id))) {
    const draft = await db.transaction(trx => createDraft(trx, pack.pack_id, { name: '法务测试确认-' + pack.pack_id, scope: pack.scope, rules: pack.rules, knowledge: [] }, users.publisher.id)); await publish(draft);
  }
  const catalog = await call('business', 'get', '/catalog').expect(200); assert.equal(catalog.body.categories.flatMap(c => c.types).find(t => t.id === 'software_license').reviewEnabled, true);
  const contract = await db('la_contracts').where({ id: item.contract.id }).first();
  const result = await call('business', 'post', '/reviews', { contractId: contract.id, revision: contract.revision }).expect(202);
  await processReview(db, result.body.reviewId, { gateway: gateway() });
  const run = await db('la_reviews').where({ id: result.body.reviewId }).first(); assert.equal(run.status, 'completed'); assert.equal(run.snapshot.reviewMode, 'formal'); assert.equal(run.coverage.checkedRules, 15);
  assert.ok(!run.snapshot.examplePacks); assert.deepEqual((await db('la_reviews').where({ id: trialId }).first()).snapshot, previous);
  for (const finding of await db('la_findings').where({ review_id: run.id })) await call('legal', 'put', `/reviews/${run.id}/findings/${finding.id}/disposition`, { revision: finding.revision, action: 'accept' }).expect(200);
  const updated = await db('la_contracts').where({ id: contract.id }).first(); await call('legal', 'post', `/reviews/${run.id}/decision`, { revision: updated.revision, outcome: 'agree' }).expect(201);
});
test('any catalog type can be enabled by publishing a type pack; unknown types and drafts remain blocked', async () => {
  const pack = { name: '开模测试规则', scope: { level: 'type', typeIds: ['mold'] }, rules: [{ id: 'mold-title', title: '模具权属', instruction: '核实权属约定', severity: 'high', mandatory: true }], knowledge: [] };
  const draft = await db.transaction(trx => createDraft(trx, 'mold', pack, users.publisher.id));
  await assert.rejects(() => matchRules(db, { typeId: 'mold', tags: [] }), { code: 'NO_PUBLISHED_RULES' });
  await assert.rejects(() => matchRules(db, { typeId: 'unknown', tags: [] }), { code: 'UNKNOWN_CONTRACT_TYPE' });
  await publish(draft); const matched = await matchRules(db, { typeId: 'mold', tags: [] }); assert.ok(matched.rules.some(rule => rule.id === 'mold-title'));
  await call('publisher', 'post', `/rule-pack-versions/${draft.id}/retire`, { revision: draft.revision + 2 }).expect(200);
  const catalog = await call('business', 'get', '/catalog').expect(200); const mold = catalog.body.categories.flatMap(c => c.types).find(t => t.id === 'mold'); assert.equal(mold.reviewEnabled, false); assert.equal(mold.trialAvailable, false);
  await assert.rejects(() => matchRules(db, { typeId: 'mold', tags: [] }), { code: 'NO_PUBLISHED_RULES' });
});
test('uploading a new version and correcting background preserve trial mode until an explicit formal rerun', async () => {
  const initial = await agents.business.post('/api/contracts/upload').set('X-CSRF-Token', tokens.business).field('background', JSON.stringify(background)).attach('file', document(), '版本模式测试.docx').expect(201);
  let contract = await db('la_contracts').where({ id: initial.body.contract.id }).first();
  await call('business', 'post', '/reviews', { contractId: contract.id, revision: contract.revision, mode: 'trial' }).expect(202);
  contract = await db('la_contracts').where({ id: contract.id }).first();
  const archive = new AdmZip(document()); archive.addFile('word/changed.txt', Buffer.from('changed version'));
  const version = await agents.business.post(`/api/contracts/${contract.id}/versions`).set('X-CSRF-Token', tokens.business).field('revision', contract.revision).attach('file', archive.toBuffer(), '新版本.docx').expect(201);
  assert.equal((await db('la_reviews').where({ id: version.body.reviewId }).first()).snapshot.reviewMode, 'trial');
  contract = await db('la_contracts').where({ id: contract.id }).first();
  const changed = await call('business', 'patch', `/contracts/${contract.id}/background`, { revision: contract.revision, background: { ...background, purpose: '更新需求' } }).expect(200);
  assert.equal((await db('la_reviews').where({ id: changed.body.reviewId }).first()).snapshot.reviewMode, 'trial');
  contract = await db('la_contracts').where({ id: contract.id }).first();
  const formal = await call('business', 'post', '/reviews', { contractId: contract.id, revision: contract.revision, mode: 'formal' }).expect(202);
  assert.equal((await db('la_reviews').where({ id: formal.body.reviewId }).first()).snapshot.reviewMode, 'formal');
});
test('a missing check in a later batch stops review instead of returning partial results as complete', async () => {
  let calls = 0;
  const gateway = createGateway(db, { fetchImpl: async (_, request) => {
    calls++; const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    const checks = input.rules.slice(0, calls === 2 ? -1 : undefined).map(rule => ({ ruleId: rule.id, status: 'fail', kind: 'clause', severity: 'high', reason: '虚构检查', suggestion: '虚构建议', evidence: [{ blockId: 'b1', quote: '源代码不交付' }], legalRefIds: [] }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ checks }) } }] });
  } });
  const rules = examplePacks().filter(pack => ['common', 'software'].includes(pack.pack_id)).flatMap(pack => pack.rules);
  await assert.rejects(() => gateway.review({ blocks: [{ id: 'b1', text }] }, rules, [], background), { code: 'RULE_COVERAGE' });
  assert.equal(calls, 2);
});
