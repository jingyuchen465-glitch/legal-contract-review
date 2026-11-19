// Isolated PostgreSQL and real browser. Model extraction is a deterministic adapter.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { config } = require('../backend/pilot/config');
const { createDb } = require('../backend/pilot/db');
const { migrate } = require('../backend/pilot/cli');
const { hashPassword } = require('../backend/pilot/auth');
const { createApp } = require('../backend/pilot/app');
const { processLearning } = require('../backend/pilot/learning');
const { createDraft } = require('../backend/pilot/rules');
async function main() {
  const root = createDb(), database = 'legal_ui_skills_' + randomUUID().replaceAll('-', ''); let db, app, server, browser;
  const output = path.resolve('.local/skills'); fs.mkdirSync(output, { recursive: true });
  const result = { isolatedDatabase: true, modelAdapter: 'deterministic', errors: [] };
  try {
    await root.raw(`CREATE DATABASE "${database}"`); const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href; config.env = 'development'; db = createDb(); await migrate(db);
    const userId = randomUUID(), password = randomUUID(); await db('la_users').insert({ id: userId, username: 'ui-skills', display_name: '虚构验收', roles: '["admin"]', password_hash: await hashPassword(password) });
    const rule = await db.transaction(trx => createDraft(trx, 'ui-procurement', { name: '验收付款检查', scope: { level: 'type', typeIds: ['procurement'] }, rules: [{ id: 'payment', title: '验收付款', instruction: '检查验收与付款约定', severity: 'medium', tags: [], mandatory: true }], knowledge: [] }, userId)); await db('la_rule_versions').where({ id: rule.id }).update({ state: 'published' });
    app = createApp(db); server = require('node:http').createServer(app.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port; config.publicUrl = base;
    browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }); page.on('pageerror', e => result.errors.push(e.message));
    const session = await (await page.request.get(base + '/api/auth/session')).json(); const login = await page.request.post(base + '/api/auth/login', { headers: { Origin: base, 'X-CSRF-Token': session.csrf }, data: { username: 'ui-skills', password } }); assert.equal(login.status(), 200);
    await page.goto(base + '/#/rules'); await page.getByText('确认新合同后，系统将自动整理经验；已发布技能用于后续预审。', { exact: true }).waitFor(); result.emptyLibrary = true;
    await page.goto(base + '/#/feedback'); await page.getByRole('button', { name: '开启自动整理', exact: true }).click(); await page.getByRole('button', { name: '关闭自动整理', exact: true }).waitFor(); result.settingsToggle = true;
    const contractId = randomUUID(), versionId = randomUUID(), reviewId = randomUUID(), findingId = randomUUID();
    await db('la_contracts').insert({ id: contractId, number: 'UI-SKILL-FIXTURE', title: '虚构经验闭环验收', background: JSON.stringify({ ourEntity: '合同所列甲方', perspective: '采购方', purpose: '验收测试' }), classification: JSON.stringify({ typeId: 'procurement', tags: [], confirmed: true, perspectiveConfirmed: true, versionId }) });
    await db('la_versions').insert({ id: versionId, contract_id: contractId, version_no: 1, kind: 'contract', filename: 'fixture.docx', storage_key: 'objects/fixture', sha256: 'a'.repeat(64), size: 10, media_type: 'application/docx', source_action: 'fixture', parsed: JSON.stringify({ blocks: [{ id: 'b1', text: '验收合格后30日付款。' }] }) });
    await db('la_reviews').insert({ id: reviewId, contract_id: contractId, version_id: versionId, status: 'completed', coverage: '{"complete":true}', snapshot: JSON.stringify({ classification: { typeId: 'procurement', tags: [] }, background: { ourEntity: '合同所列甲方' }, rules: rule.rules }) });
    await db('la_findings').insert({ id: findingId, review_id: reviewId, rule_id: 'payment', title: '验收付款', check_status: 'fail', kind: 'clause', severity: 'medium', reason: '待核对', evidence: JSON.stringify([{ blockId: 'b1', quote: '验收合格后30日付款' }]), disposition: JSON.stringify({ action: 'reject', reason: '起算点已明确' }) });
    const previousId = randomUUID();
    await db('la_versions').insert({ id: previousId, contract_id: contractId, version_no: 0, kind: 'contract', filename: '本机修改前.docx', storage_key: 'objects/previous', sha256: 'b'.repeat(64), size: 10, media_type: 'application/docx', source_action: 'upload', parsed: JSON.stringify({ blocks: [{ id: 'old-payment', text: '收到货物后立即付款。' }] }) });
    await db('la_versions').where({ id: versionId }).update({ parent_id: previousId });
    await db('la_contracts').where({ id: contractId }).update({ current_review_id: reviewId, current_version_id: versionId });
    const c = await db('la_contracts').where({ id: contractId }).first(); const token = (await (await page.request.get(base + '/api/auth/session')).json()).csrf;
    const finalized = await page.request.post(`${base}/api/reviews/${reviewId}/decision`, { headers: { Origin: base, 'X-CSRF-Token': token }, data: { revision: c.revision, outcome: 'conditional', reason: '核对起算点', conditions: '验收合格后付款' } }); assert.equal(finalized.status(), 201);
    const task = await db('la_learning_tasks').where({ review_id: reviewId }).first(); assert.ok(task); result.finalizationEnqueues = true;
    await processLearning(db, task.id, { gateway: { distill: async input => { assert.equal(input.comparison, 'previous_version'); assert.ok(input.blocks.some(b => b.versionId === previousId)); return [{ key: 'skill', kind: 'skill', title: '验收起算点交叉检查', reason: '人工驳回未考虑验收约定的误报', method: '先检查验收条件，再核对付款起算日期。', conditions: ['验收条件明确'], exclusions: ['附条件接受不得推广为无条件认可'], examples: ['验收合格后【待确认期限】付款。'], evidence: [{ versionId, blockId: 'b1', quote: '验收合格后30日付款' }], findingIds: [findingId] }]; } } });
    await page.getByRole('button', { name: '刷新', exact: true }).first().click(); const p = page.locator('.proposal').filter({ hasText: '验收起算点交叉检查' }); await p.waitFor();
    const comparison = page.locator('.offline-changes'); await comparison.locator('summary').click();
    await comparison.getByText('收到货物后立即付款。', { exact: true }).waitFor(); await comparison.getByText('验收合格后30日付款。', { exact: true }).waitFor();
    assert.equal(await comparison.getByRole('link', { name: '下载修改前文件' }).getAttribute('href'), `/api/files/${previousId}?download=1`);
    await page.screenshot({ path: output + '/本机修改对比.png', fullPage: true }); result.offlineComparison = true;
    await p.getByRole('button', { name: '编辑提案' }).click(); const dialog = page.getByRole('dialog', { name: '编辑经验提案' }); await dialog.getByLabel('具体方法').fill('先检查验收条件，再核对付款起算日期，并交叉检查引用条款。'); await dialog.getByRole('button', { name: '保存提案' }).click(); await dialog.waitFor({ state: 'hidden' });
    await p.getByRole('button', { name: '采纳为技能草稿' }).click(); await p.getByRole('link', { name: /查看 \/ 编辑草稿/ }).click(); const skillDialog = page.getByRole('dialog', { name: '审查技能包内容' }); await skillDialog.waitFor();
    await skillDialog.getByLabel('具体审查方法').fill('先检查验收条件，再核对付款起算日期，并交叉检查引用条款及例外。'); await skillDialog.getByRole('button', { name: '保存草稿', exact: true }).click(); await skillDialog.getByRole('button', { name: '提交审核', exact: true }).click(); await skillDialog.waitFor({ state: 'hidden' });
    await page.locator('.skill-row').getByRole('button', { name: '查看版本' }).click(); await skillDialog.getByRole('button', { name: '确认并发布，后续新建预审生效' }).click(); await skillDialog.waitFor({ state: 'hidden' });
    const published = await db('la_skill_versions').where({ state: 'published' }).first(); assert.match(published.skills[0].method, /条款及例外/); result.proposalEditAdoptAndDraftPublication = true;
    const preview = await (await page.request.get(base + '/api/review-plan?typeId=procurement')).json(); assert.equal(preview.skillPacks[0].id, published.id); result.previewLoadsPublished = true;
    const download = await page.request.get(base + `/api/skill-pack-versions/${published.id}/export`); assert.match(await download.text(), /条款及例外/); result.markdownExport = true;
    await page.locator('.skill-row').getByRole('button', { name: '查看版本' }).click(); await skillDialog.getByRole('button', { name: '基于此版创建新草稿' }).click(); assert.equal(await skillDialog.getByLabel('具体审查方法').isEnabled(), true); await skillDialog.getByLabel('具体审查方法').fill('新版草稿方法尚未发布，不参与审核。'); await skillDialog.getByRole('button', { name: '保存为新版本草稿' }).click(); await skillDialog.getByRole('button', { name: 'Close this dialog' }).click().catch(async () => { await skillDialog.locator('.el-dialog__headerbtn').click(); });
    assert.equal((await db('la_skill_versions').where({ state: 'draft' })).length, 1); result.versionCopyEditable = true;
    await skillDialog.waitFor({state:'hidden'}); await page.screenshot({ path: output + '/技能包管理.png', fullPage: true });
    await page.goto(base + '/#/contracts/' + contractId); await page.getByRole('heading', { name: '合同经验整理', exact: true }).waitFor(); await page.getByText('提案已处理', { exact: true }).waitFor(); result.detailStatus = true;
    await page.setViewportSize({ width: 980, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); result.narrowLayout = true;
    assert.deepEqual(result.errors, []); result.passed = true;
  } finally {
    fs.writeFileSync(output + '/ui-result.json', JSON.stringify(result, null, 2)); await browser?.close(); if (server?.listening) await new Promise(r => server.close(r)); await app?.close(); await db?.destroy();
    await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]); await root.raw(`DROP DATABASE IF EXISTS "${database}"`); await root.destroy();
  }
  console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
