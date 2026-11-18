// Real configured provider; all contracts, standards and publications live in a disposable database.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const supertest = require('supertest');
const { config } = require('../backend/pilot/config');
const { createDb } = require('../backend/pilot/db');
const { migrate } = require('../backend/pilot/cli');
const { hashPassword } = require('../backend/pilot/auth');
const { createApp } = require('../backend/pilot/app');
const { providerConfig, createGateway } = require('../backend/pilot/model');
const { createDraft } = require('../backend/pilot/rules');
const { processLearning } = require('../backend/pilot/learning');
const { enqueueReview, processReview } = require('../backend/pilot/workflow');
async function main() {
  const offline = process.argv.includes('--offline');
  const application = createDb(), socket = process.argv.includes('--postgres-socket');
  const admin = socket ? createDb({ host: '/var/run/postgresql', user: 'postgres', database: 'postgres' }) : process.env.SKILL_SMOKE_ADMIN_DATABASE_URL ? createDb(process.env.SKILL_SMOKE_ADMIN_DATABASE_URL) : application;
  const database = 'legal_skills_smoke_' + randomUUID().replaceAll('-', ''), output = path.resolve(process.env.SKILL_SMOKE_RESULT || '.local/skills/model-smoke.json');
  let db, handle; const result = { isolatedDatabase: true, syntheticSourceOnly: true, realProvider: true, offlineComparison: offline, humanLegalQualityApproval: false, productionSkillsWritten: false, requests: [] };
  try {
    const model = await providerConfig(application); assert.ok(model.key && model.name && model.baseUrl, 'Configured provider is required'); Object.assign(config.model, model); result.model = model.name;
    await admin.raw(`CREATE DATABASE "${database}"`);
    const url = socket ? new URL('postgresql://postgres@localhost/postgres?host=%2Fvar%2Frun%2Fpostgresql') : new URL(process.env.SKILL_SMOKE_ADMIN_DATABASE_URL || config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href; config.env = 'development'; db = createDb(); await migrate(db);
    const userId = randomUUID(), password = randomUUID(); await db('la_users').insert({ id: userId, username: 'model-smoke', display_name: '虚构模型验收', roles: '["admin"]', password_hash: await hashPassword(password) });
    handle = createApp(db); const agent = supertest.agent(handle.app); const session = await agent.get('/api/auth/session'); const csrf = (await agent.post('/api/auth/login').set('X-CSRF-Token', session.body.csrf).send({ username: 'model-smoke', password }).expect(200)).body.csrf;
    const call = (method, url, body) => agent[method]('/api' + url).set('X-CSRF-Token', csrf).send(body);
    const rule = { id: 'payment', title: '采购验收与付款条件', instruction: '检查设备采购合同的验收及付款条件是否清晰可执行。', severity: 'high', mandatory: true, tags: [] };
    for (const scope of [{ level: 'common' }, { level: 'type', typeIds: ['procurement'] }]) {
      const p = await db.transaction(trx => createDraft(trx, scope.level === 'common' ? 'smoke-common' : 'smoke-procurement', { name: '虚构验收标准-' + scope.level, scope, rules: [{ ...rule, id: scope.level === 'common' ? 'consistency' : 'payment' }], knowledge: [] }, userId));
      await call('post', `/rule-pack-versions/${p.id}/submit`, { revision: p.revision }).expect(200); await call('post', `/rule-pack-versions/${p.id}/publish`, { revision: p.revision + 1 }).expect(200);
    }
    await call('put', '/learning-settings', { enabled: true, updatedAt: null }).expect(200);
    const contractId = randomUUID(), versionId = randomUUID(), reviewId = randomUUID(), findingId = randomUUID();
    const background = { ourEntity: '合同所列甲方', perspective: '设备采购方', purpose: '虚构设备采购验收：法务已纠正交付与验收混同的误报，应整理交叉检查方法，具体付款期限仍待双方确认。' };
    const document = { parserVersion: 'synthetic-smoke', blocks: [{ id: 'b1', text: '设备交付后支付全部款项，验收另行协商。' }, { id: 'b2', text: '买方可对交付设备进行检验，验收结果以双方确认的书面验收记录为准。' }] };
    const previous = structuredClone(document);
    if (offline) {
      background.purpose = '虚构设备采购验收：本机修改合同付款触发条件并重新上传，确认修改稿；没有系统内人工复核记录，未另行记录修改原因。';
      document.blocks[0].text = '设备验收合格且双方签署书面验收记录后30日内支付全部款项。';
    }
    await db('la_contracts').insert({ id: contractId, number: 'SYNTHETIC-SKILL-SMOKE', title: '完全虚构技能闭环样本', background: JSON.stringify(background), classification: JSON.stringify({ typeId: 'procurement', tags: [], confirmed: true, perspectiveConfirmed: true, versionId }) });
    await db('la_versions').insert({ id: versionId, contract_id: contractId, version_no: 1, kind: 'contract', filename: 'synthetic.docx', storage_key: 'objects/synthetic-not-a-real-upload', sha256: 'a'.repeat(64), size: 10, media_type: 'application/docx', source_action: 'isolated_model_smoke', parsed: JSON.stringify(document) });
    await db('la_reviews').insert({ id: reviewId, contract_id: contractId, version_id: versionId, status: 'completed', coverage: '{"complete":true}', snapshot: JSON.stringify({ background, classification: { typeId: 'procurement', tags: [] }, rules: [rule] }) });
    await db('la_findings').insert({ id: findingId, review_id: reviewId, rule_id: 'payment', title: '交付即付款的风险', check_status: 'fail', severity: 'high', kind: 'clause', reason: '验收和付款条件脱节', evidence: JSON.stringify([{ blockId: 'b1', quote: document.blocks[0].text }]), suggestion: '结合书面验收结果调整付款触发点', disposition: JSON.stringify({ action: 'correct', reason: '不要把存在交付事实当作验收通过；先交叉核对验收记录条款，再检查付款触发条件。此合同只附条件接受，条件未落实时不能作为认可范例。', suggestion: '将第一条替换为：设备验收合格且双方签署书面验收记录后【待双方确认期限】内支付约定款项。', severity: 'high' }) });
    let previousId;
    if (offline) {
      previousId = randomUUID();
      await db('la_versions').insert({ id: previousId, contract_id: contractId, version_no: 0, kind: 'contract', filename: 'synthetic-before.docx', storage_key: 'objects/previous', sha256: 'b'.repeat(64), size: 10, media_type: 'application/docx', source_action: 'upload', parsed: JSON.stringify(previous) });
      await db('la_versions').where({ id: versionId }).update({ parent_id: previousId });
      await db('la_findings').where({ review_id: reviewId }).update({ check_status: 'pass', disposition: null });
    }
    await db('la_contracts').where({ id: contractId }).update({ current_review_id: reviewId, current_version_id: versionId });
    let c = await db('la_contracts').where({ id: contractId }).first(); await call('post', `/reviews/${reviewId}/decision`, { revision: c.revision, outcome: 'conditional', conditions: '须把付款条件改为验收合格并签署书面验收记录后付款，付款期限由双方确认。', reason: '当前条款不能无条件接受' }).expect(201);
    let task = await db('la_learning_tasks').where({ review_id: reviewId }).first();
    const gateway = createGateway(db, { fetchImpl: async (url, options) => { const payload = JSON.parse(options.body); const input = JSON.parse(payload.messages[1].content); result.requests.push({ stage: input.existingSkills ? 'learning' : 'review', skillVersionIds: (input.skills || []).map(s => s.versionId), skills: input.skills || [], ruleCount: (input.rules || input.existingRules || []).length }); return fetch(url, options); } });
    await processLearning(db, task.id, { gateway }); task = await db('la_learning_tasks').where({ id: task.id }).first(); result.extractionStatus = task.status; result.errorCode = task.error_code; result.proposals = task.proposals;
    assert.equal(task.status, 'awaiting_confirmation', task.error_message || 'Expected useful experience from explicit synthetic human correction'); assert.ok(task.proposals.some(p => p.kind === 'skill'));
    if (offline) {
      assert.equal(task.source.comparison, 'previous_version');
      assert.ok(task.proposals.some(p => p.kind === 'skill' && p.evidence.some(e => e.versionId === previousId) && p.evidence.some(e => e.versionId === versionId)), 'A change-based skill must cite both versions');
      result.comparisonSummary = task.source.comparisonSummary;
    }
    // Simulate legal publication in the isolated fixture only; never establishes a real company standard.
    for (const p of [...task.proposals].sort((a, b) => (a.kind === 'rule' ? 0 : 1) - (b.kind === 'rule' ? 0 : 1))) {
      const pack = task.snapshot.rulePacks.find(r => p.targetPackId ? p.targetPackId === r.pack_id : p.scope === 'common' ? r.scope.level === 'common' : r.scope.level === 'type');
      await call('post', `/learning-tasks/${task.id}/proposals/${p.id}/adopt`, { revision: task.revision, commonConfirmed: true, rulePackId: pack?.pack_id }).expect(200); task = await db('la_learning_tasks').where({ id: task.id }).first();
    }
    for (const p of await db('la_rule_versions').where({ state: 'draft' })) { await call('post', `/rule-pack-versions/${p.id}/submit`, { revision: p.revision }).expect(200); await call('post', `/rule-pack-versions/${p.id}/publish`, { revision: p.revision + 1 }).expect(200); }
    const drafts = await db('la_skill_versions').where({ state: 'draft' });
    for (const p of drafts) { await call('put', `/skill-pack-versions/${p.id}`, { ...p, name: p.name + '（虚构验收编辑）' }).expect(200); await call('post', `/skill-pack-versions/${p.id}/submit`, { revision: p.revision + 1 }).expect(200); await call('post', `/skill-pack-versions/${p.id}/publish`, { revision: p.revision + 2, commonConfirmed: true }).expect(200); }
    c = await db('la_contracts').where({ id: contractId }).first(); const next = await db.transaction(trx => enqueueReview(trx, c, userId)); await db('la_contracts').where({ id: contractId }).update({ current_version_id: null });
    await processReview(db, next, { gateway }); const review = await db('la_reviews').where({ id: next }).first(); assert.equal(review.status, 'completed'); assert.ok(review.snapshot.skills.length); assert.ok(result.requests.some(r => r.stage === 'review' && r.skillVersionIds.length));
    result.loadedSkills = review.snapshot.skills.map(s => ({ id: s.id, version: s.version, name: s.name })); result.reviewFindings = await db('la_findings').where({ review_id: next }); result.finalOutcome = 'conditional'; result.passed = true;
  } finally {
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2)); await handle?.close(); await db?.destroy();
    await admin.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]); await admin.raw(`DROP DATABASE IF EXISTS "${database}"`); if (admin !== application) await admin.destroy(); await application.destroy();
  }
  console.log(JSON.stringify({ passed: result.passed, realProvider: true, model: result.model, extractionStatus: result.extractionStatus, proposals: result.proposals.length, loadedSkillPacks: result.loadedSkills.length, modelRequests: result.requests.length, isolatedDatabaseRemoved: true, productionSkillsWritten: false, legalQualityApproval: false }));
}
main().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
