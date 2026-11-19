// Isolated database + actual worker, HTTP API, and browser. All AI outputs are
// deterministic engineering fixtures; this does not evaluate legal quality.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const AdmZip = require('adm-zip');
const { config } = require('../backend/pilot/config');
const { createDb } = require('../backend/pilot/db');
const { migrate } = require('../backend/pilot/cli');
const { hashPassword } = require('../backend/pilot/auth');
const { createApp } = require('../backend/pilot/app');
const { createContract } = require('../backend/pilot/contracts');
const { processReview } = require('../backend/pilot/workflow');
const { createQueue } = require('../backend/pilot/queue');
async function main() {
  if (config.env !== 'development' || !['localhost', '127.0.0.1'].includes(new URL(config.databaseUrl).hostname)) throw Error('Requires local isolated QA');
  const root = createDb(), database = 'legal_ui_preanalysis_' + randomUUID().replaceAll('-', '');
  const output = path.resolve('.local/upstream-experience/preanalysis'); fs.mkdirSync(output, { recursive: true });
  const result = { checks: [], errors: [], deterministicFixtures: true, isolatedDatabase: true };
  let db, handle, server, browser, queue, realtime, release;
  const paragraphs = ['【虚构工程测试】数据服务终止及退款协议', '甲方：虚构数据采购有限公司（服务购买方、退款收款方）。乙方：虚构数据服务有限公司（服务提供方、退款付款方）。', '双方确认已使用服务44天，乙方应于本协议生效后5个工作日内退回剩余服务费28,846.03元。', '退款完成后注销账户，停止服务并删除个人信息。'];
  function docx() { const zip = new AdmZip(); zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="urn:word"><w:body>${paragraphs.map(t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)); return zip.toBuffer(); }
  const gateway = {
    classify: async d => ({ typeId: 'douyin', tags: ['数据处理'], evidence: [{ blockId: d.blocks[0].id, quote: paragraphs[0] }], uncertain: false }),
    preAnalyze: async d => ({ contractType: '数据服务终止及剩余服务费退款协议', parties: [{ name: '虚构数据采购有限公司', label: '甲方', role: '服务购买方 / 退款收款方', evidence: [{ blockId: 'b2', quote: paragraphs[1] }] }, { name: '虚构数据服务有限公司', label: '乙方', role: '服务提供方 / 退款付款方', evidence: [{ blockId: 'b2', quote: paragraphs[1] }] }], reviewPoints: [{ title: '核查44天服务使用期间及28,846.03元退款的计算依据', instruction: '逐项核查退款计算、已用服务期间和对账凭证', evidence: [{ blockId: 'b3', quote: paragraphs[2] }] }, { title: '明确5个工作日退款期限、账户注销与数据删除的先后顺序', instruction: '核查退款义务完成标准和服务终止后的数据交接', evidence: [{ blockId: 'b4', quote: paragraphs[3] }] }], corePurposes: ['保障我方在明确期限内足额收到退款', '确保服务退出、账户注销与数据删除顺利完成'] }),
    review: async (doc, rules, knowledge, background) => ({ checks: rules.map(r => ({ ruleId: r.id, title: r.title, status: 'uncertain', kind: 'uncertain', severity: 'medium', reason: '工程验收：待双方核实结算依据', suggestion: '在退款条款中新增：“双方应书面确认退款计算明细及收款账户。”', evidence: [{ blockId: 'b3', quote: paragraphs[2] }], legalRefIds: [] })), coverage: { totalRules: rules.length, checkedRules: rules.length, complete: true } }),
  };
  try {
    await root.raw(`CREATE DATABASE "${database}"`); const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href; config.dataRoot = path.join(output, database);
    db = createDb(); await migrate(db); await require('../backend/pilot/storage').initializeDirectories();
    const actor = { id: randomUUID(), username: 'preanalysis-qa', display_name: '工程验收', roles: ['admin'], department: '测试环境' }, password = randomUUID();
    await db('la_users').insert({ ...actor, roles: JSON.stringify(actor.roles), password_hash: await hashPassword(password) });
    const old = await db.transaction(trx => createContract(trx, actor, { originalname: '已完成的虚构合同.docx', buffer: docx() }, { title: '已完成的虚构合同', background: { ourEntity: '虚构公司', perspective: '购买方', purpose: '验证原复核功能' } }));
    await processReview(db, old.reviewId, { gateway });
    const legacyPending=await db.transaction(trx=>createContract(trx,actor,{originalname:'旧待处理合同.docx',buffer:docx()},{title:'旧待处理合同'}));
    await processReview(db,legacyPending.reviewId,{gateway});assert.equal((await db('la_reviews').where({id:legacyPending.reviewId}).first()).status,'waiting_input');
    await db('la_outbox').update({ sent_at: db.fn.now() });
    handle = createApp(db); server = require('node:http').createServer(handle.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port; config.publicUrl = base; realtime = require('../backend/pilot/realtime').setupRealtime(server, db, handle.sessionMiddleware);
    const gate = new Promise(resolve => { release = resolve; });
    queue = await createQueue(db, { preanalysisOptions: { gateway: { ...gateway, preAnalyze: async d => { await gate; return gateway.preAnalyze(d); } } }, reviewOptions: { gateway } });
    browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.on('pageerror', e => result.errors.push(e.message));
    await page.goto(base); await page.getByLabel('账号', { exact: true }).fill(actor.username); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录工作台 →' }).click();
    await page.getByRole('heading', { name: '合同与待办', exact: true }).waitFor(); assert.equal(await page.locator('.stat-card').count(), 4);
    await page.getByRole('button', { name: '＋ 提交合同', exact: true }).click(); const upload = page.getByRole('dialog', { name: '提交合同' });
    await upload.locator('input[type=file]').setInputFiles({ name: '虚构数据服务退款协议.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx() });
    const posted = page.waitForResponse(r => r.url().endsWith('/api/contracts/upload') && r.request().method() === 'POST');
    await upload.getByRole('button', { name: '提交并预分析', exact: true }).click(); const created = await (await posted).json(); assert.ok(created.preanalysisId); assert.equal(created.reviewId, undefined);
    await upload.waitFor({ state: 'hidden' }); await page.locator('.contract-title').getByText('虚构数据服务退款协议.docx', { exact: true }).click();
    await page.getByRole('heading', { name: '正在进行合同预分析。', exact: true }).waitFor(); await page.screenshot({ path: path.join(output, '01-background-preanalysis.png'), fullPage: true });
    await page.getByRole('link', { name: '返回台账，处理其他合同 ↗' }).click(); await page.locator('.contract-title').getByText('已完成的虚构合同', { exact: true }).click(); await page.locator('.risk-item').first().waitFor();
    assert.equal(await page.locator('.sidebar').count(), 1); assert.equal((await db('la_reviews').where({ contract_id: created.contract.id })).length, 0); result.checks.push('preanalysis-returns-immediately-and-existing-review-stays-usable');
    await page.goto(base+'/#/contracts/'+legacyPending.contract.id);await page.getByRole('heading',{name:'正在进行合同预分析。',exact:true}).waitFor();
    assert.ok((await db('la_contracts').where({id:legacyPending.contract.id}).first()).current_preanalysis_id);result.checks.push('opening-legacy-pending-contract-starts-guided-preanalysis-without-rewriting-old-report');
    release(); await page.goto(base + '/#/contracts/' + created.contract.id); await page.getByRole('heading', { name: '1. 选择您的审查立场', exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByRole('button', { name: '开始分析', exact: true }).isDisabled(), true);
    await page.getByLabel('审查立场与我方主体', { exact: true }).selectOption('party-1');
    const selectedText = await page.locator('#setup-party option:checked').textContent(); assert.match(selectedText, /虚构数据采购有限公司.*退款收款方/);
    await page.getByLabel('审查模板', { exact: true }).selectOption('original:service');
    await page.getByRole('button', { name: '清空', exact: true }).click();
    const checks = page.locator('.setup-points input'); await checks.first().check(); await checks.last().check();
    await page.getByLabel('审查核心目的 1', { exact: true }).fill('工程测试：退款必须在约定时间到账');
    const n = await page.locator('.setup-purposes input').count(); await page.getByRole('button', { name: '⊕ 添加目的', exact: true }).click();
    await page.getByLabel('审查核心目的 ' + (n + 1), { exact: true }).fill('工程测试：补充的目的可自由编辑');
    await page.getByRole('button', { name: '删除目的 2', exact: true }).click();
    await page.getByText('选择已自动保存', { exact: true }).waitFor();
    const draft = (await db('la_preanalyses').where({ id: created.preanalysisId }).first()).selection; assert.equal(draft.pointIds.length, 2); assert.equal(draft.templateId, 'original:service'); assert.match(draft.corePurposes[0], /约定时间到账/);
    await page.screenshot({ path: path.join(output, '02-confirmation-and-selection.png'), fullPage: true, animations: 'disabled' });
    await page.reload(); await page.getByRole('heading', { name: '1. 选择您的审查立场', exact: true }).waitFor(); assert.equal(await page.locator('.setup-points input:checked').count(), 2); assert.equal(await page.getByLabel('审查核心目的 1', { exact: true }).inputValue(), draft.corePurposes[0]);
    result.checks.push('real-parties-template-multiselect-editable-purposes-server-save-and-refresh-recovery');
    for (const width of [980, 390]) { await page.setViewportSize({ width, height: 900 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overflow ' + width); await page.screenshot({ path: path.join(output, '03-confirmation-' + width + '.png'), fullPage: true }); }
    await page.setViewportSize({ width: 1440, height: 1050 });
    const started = page.waitForResponse(r => r.url().endsWith(`/preanalyses/${created.preanalysisId}/start`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: '开始分析', exact: true }).click(); const formal = await (await started).json(); assert.ok(formal.reviewId);
    await page.locator('.risk-item').first().waitFor({ timeout: 20000 }); const run = await db('la_reviews').where({ id: formal.reviewId }).first();
    assert.deepEqual(run.snapshot.rules.map(r => r.id), draft.pointIds); assert.equal(run.snapshot.background.ourEntity, '虚构数据采购有限公司'); assert.deepEqual(run.snapshot.background.corePurposes, draft.corePurposes);
    assert.equal((await db('la_findings').where({review_id:formal.reviewId})).length,2); assert.equal(await page.locator('.risk-item').count(), 1); /* Existing duplicate-opinion grouping remains active. */ assert.equal(await page.locator('.document-view').count(), 1); assert.equal((await db('la_rule_versions')).length, 0);
    await page.screenshot({ path: path.join(output, '04-existing-review-after-confirmation.png'), fullPage: true });
    result.checks.push('confirmed-checks-reach-real-review-worker-and-original-document-human-review-layout');
    assert.deepEqual(result.errors, []); result.passed = true;
  } catch (error) { try { await browser?.contexts()[0]?.pages()[0]?.screenshot({path:path.join(output,'failure.png'),fullPage:true}); } catch {} result.passed = false; result.error = error.stack; process.exitCode = 1; }
  finally {
    release?.(); if (browser) await browser.close(); await queue?.stop(); if (realtime) await realtime.close(); else if (server) await new Promise(resolve => server.close(resolve)); await handle?.close(); await db?.destroy();
    await root.raw(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await root.destroy(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
