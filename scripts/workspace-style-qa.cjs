// Real browser and isolated PostgreSQL, exercising the existing business APIs.
// Review responses are explicit local fixtures; no real legal/model service is used.
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

async function main() {
  if (config.env !== 'development' || !['127.0.0.1','localhost'].includes(new URL(config.databaseUrl).hostname)) throw Error('Requires an isolated local development database');
  const root = createDb(), database = 'legal_workspace_qa_' + randomUUID().replaceAll('-','');
  const output = path.resolve('.local/upstream-experience/workspace-style'); fs.mkdirSync(output, { recursive: true });
  const result = { isolatedDatabase: true, deterministicReviewFixture: true, checks: [], errors: [] };
  let db, handle, server, realtime, browser;
  const paragraphs = ['【虚构验收样本】设备采购合同','甲方：虚构采购公司。乙方：虚构供应商。本合同仅用于工程测试。','交付时间以乙方后续通知为准，甲方不得异议。','乙方无需对任何迟延交付承担违约责任。','合同价款为人民币100,000元，甲方于验收合格后30日内付款。'];
  function document(text = paragraphs) {
    const zip = new AdmZip(); zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.map(t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)); return zip.toBuffer();
  }
  const gateway = {
    classify: async () => ({ typeId: 'procurement', tags: [], confirmed: false, evidence: [{ blockId: 'b1', quote: paragraphs[0] }] }),
    review: async (doc, rules) => ({ checks: rules.map(rule => {
      const delivery = rule.id.endsWith('/delivery'), liability = rule.id.endsWith('/liability'), index = delivery ? 2 : liability ? 3 : 4;
      return { ruleId: rule.id, title: rule.title, status: delivery || liability ? 'fail' : 'pass', kind: 'clause', severity: delivery || liability ? 'high' : 'low', reason: '工程测试预设：' + rule.title, suggestion: delivery || liability ? '乙方应按双方确认的交付日期履行交货义务，并承担约定的迟延责任。' : '', evidence: [{ blockId: 'b' + (index + 1), quote: doc.blocks[index].text }], legalRefIds: [] };
    }), coverage: { complete: true, totalRules: rules.length, checkedRules: rules.length, coveredBlockIds: doc.blocks.map(block => block.id) } }),
  };
  try {
    await root.raw(`CREATE DATABASE "${database}"`);
    const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
    config.dataRoot = path.join(output, database);
    db = createDb(); await migrate(db); await require('../backend/pilot/storage').initializeDirectories();
    const password = randomUUID(), actor = { id: randomUUID(), username: 'workspace-qa', display_name: '工程验收', department: '测试环境', roles: ['admin'] };
    await db('la_users').insert({ ...actor, roles: JSON.stringify(actor.roles), password_hash: await hashPassword(password) });
    const fixture = await db.transaction(trx => createContract(trx, actor, { originalname: '虚构设备采购合同.docx', buffer: document() }, { title: paragraphs[0], background: { ourEntity: '虚构采购公司', perspective: '采购方', purpose: '工程测试，未调用真实模型' }, source: 'test_fixture' }));
    await processReview(db, fixture.reviewId, { gateway });
    assert.equal((await db('la_reviews').where({ id: fixture.reviewId }).first()).status, 'completed');
    assert.equal(Number((await db('la_rule_versions').count('* as n').first()).n), 0);
    handle = createApp(db, { sessionName: 'workspace.qa.sid' }); server = require('node:http').createServer(handle.app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port; config.publicUrl = base;
    realtime = require('../backend/pilot/realtime').setupRealtime(server, db, handle.sessionMiddleware);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.on('pageerror', error => result.errors.push(error.message));
    await page.goto(base); await page.getByLabel('账号', { exact: true }).fill(actor.username); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录工作台 →' }).click();
    await page.getByRole('heading', { name: '合同与待办', exact: true }).waitFor();
    await page.locator('.contract-title').getByText(paragraphs[0], { exact: true }).waitFor();
    assert.equal(await page.locator('.sidebar').count(), 1); assert.equal(await page.locator('.stat-card').count(), 4); assert.equal(await page.locator('.hero-section').count(), 0);
    assert.equal(await page.locator('.sidebar').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    assert.equal(await page.locator('.sidebar a.active').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(17, 17, 17)');
    assert.equal(await page.locator('.sidebar').getByRole('link', { name: /规则/ }).count(), 0);
    await page.screenshot({ path: path.join(output, 'home.png'), fullPage: true, animations: 'disabled' });
    result.checks.push('existing-sidebar-ledger-four-stat-cards-and-upstream-palette');
    await page.getByLabel('搜索合同', { exact: true }).fill('没有这份合同'); await page.locator('.contract-title').waitFor({ state: 'hidden' });
    await page.getByLabel('搜索合同', { exact: true }).fill(''); await page.locator('.contract-title').getByText(paragraphs[0], { exact: true }).click();
    await page.getByRole('heading', { name: paragraphs[0], exact: true }).waitFor(); await page.locator('.risk-item').first().waitFor();
    const risk = await page.locator('.risk-column').boundingBox(), source = await page.locator('.original-column').boundingBox();
    assert.ok(risk.x + risk.width <= source.x, 'Existing review list stays left of the document');
    assert.equal(await page.locator('.review-report-panel').count(), 0);
    assert.ok(await page.locator('.document-view').getByText(paragraphs[2], { exact: false }).count() > 0);
    await page.screenshot({ path: path.join(output, 'review.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.risk-filters').getByRole('button', { name: '高风险', exact: true }).click(); assert.equal(await page.locator('.risk-item').count(), 2);
    await page.locator('.risk-filters').getByRole('button', { name: '全部', exact: true }).click();
    await page.locator('.risk-item').filter({ has: page.locator('.badge.completed') }).first().click();
    const finding = page.getByRole('dialog', { name: '条款意见与法务复核' }); await finding.waitFor();
    const dispositionSaved = page.waitForResponse(response => response.url().includes('/findings/') && response.url().endsWith('/disposition') && response.request().method() === 'PUT');
    await finding.getByRole('button', { name: '保存复核意见', exact: true }).click();
    assert.equal((await dispositionSaved).status(), 200);
    await finding.waitFor({ state: 'hidden' });
    assert.equal(Number((await db('la_findings').where({ review_id: fixture.reviewId }).whereNotNull('disposition').count('* as n').first()).n), 1);
    result.checks.push('original-review-structure-document-annotations-risk-filter-and-real-legal-disposition');
    await page.locator('.sidebar').getByRole('link', { name: '合同与待办' }).click();
    await page.getByRole('button', { name: '＋ 提交合同', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '提交合同' }); await upload.waitFor();
    await upload.locator('input[type=file]').setInputFiles({ name: '虚构新增采购合同.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: document() });
    await upload.getByLabel(/^合同类型/).selectOption('procurement');
    await upload.getByRole('region', { name: '适用审查要点' }).getByText(/将匹配 \d+ 项检查/).waitFor();
    await upload.getByLabel(/^我方为/).selectOption('party_a');
    await upload.getByLabel('我方主体', { exact: true }).fill('虚构采购公司'); await upload.getByLabel('我方交易立场', { exact: true }).fill('采购方');
    await upload.getByLabel('交易目的 / 重点检查项', { exact: true }).fill('工程验收：检查交付与违约责任');
    await upload.getByText('提交后先进行 AI 预分析，最终分类、主体和立场将在下一步确认。', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'upload.png'), fullPage: true, animations: 'disabled' });
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/contracts/upload') && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '提交并预分析', exact: true }).click();
    const response = await submitted; assert.equal(response.status(), 201); const created = await response.json();
    assert.ok(created.preanalysisId); assert.equal(created.reviewId,undefined);
    await require('../backend/pilot/preanalysis').processPreanalysis(db,created.preanalysisId,{gateway:{...gateway,preAnalyze:async()=>({contractType:'设备采购合同',parties:[{name:'虚构采购公司',label:'甲方',role:'采购方',evidence:[{blockId:'b2',quote:paragraphs[1]}]}],reviewPoints:[],corePurposes:['检查交付与违约责任']})}});
    const setupContract=await db('la_contracts').where({id:created.contract.id}).first(), setup=await db('la_preanalyses').where({id:created.preanalysisId}).first(), template=setup.result.templates.find(t=>t.id===setup.result.templateId);
    const browserSession=await (await page.request.get(base+'/api/auth/session')).json();
    const confirmed=await page.request.post(base+'/api/preanalyses/'+created.preanalysisId+'/start',{headers:{'X-CSRF-Token':browserSession.csrf},data:{revision:setup.revision,contractRevision:setupContract.revision,selection:{partyId:'party-1',typeId:'procurement',templateId:template.id,pointIds:template.points.map(p=>p.id),corePurposes:setup.result.corePurposes}}});
    assert.equal(confirmed.status(),202);created.reviewId=(await confirmed.json()).reviewId;
    await processReview(db, created.reviewId, { gateway });
    const contract = await db('la_contracts').where({ id: created.contract.id }).first();
    assert.equal(contract.classification.confirmed, true); assert.match(contract.background.perspective, /采购方/);
    assert.equal((await db('la_reviews').where({ id: created.reviewId }).first()).status, 'completed');
    assert.equal(Number((await db('la_rule_versions').count('* as n').first()).n), 0);
    result.checks.push('original-single-dialog-upload-and-confirmed-guided-review-with-zero-published-packages');
    for (const [route, heading] of [['/reconciliation','补查待确认'],['/dingtalk','钉钉收件'],['/experience','合同经验技能'],['/feedback','反馈与评测中心'],['/settings','接入与模型配置'],['/operations','运行与审计']]) {
      await page.goto(base + '/#' + route); await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, route + ' overflows');
      await page.screenshot({ path: path.join(output, route.slice(1) + '.png'), fullPage: true, animations: 'disabled' });
    }
    result.checks.push('feedback-learning-skills-dingtalk-reconciliation-settings-and-operations-preserved');
    for (const width of [980,390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['/', '/contracts/' + fixture.contract.id, '/settings']) {
        await page.goto(base + '/#' + route); await page.locator('.sidebar').waitFor(); await page.locator('h1').waitFor();
        if (route.startsWith('/contracts/')) await page.locator('.risk-item').first().waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, route + ' overflows ' + width);
        await page.screenshot({ path: path.join(output, (route === '/' ? 'home' : route.startsWith('/contracts/') ? 'review' : 'settings') + '-' + width + '.png'), fullPage: true, animations: 'disabled' });
      }
    }
    assert.deepEqual(result.errors, []); result.passed = true;
  } catch (error) { result.passed = false; result.error = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close(); if (realtime) await realtime.close();
    else if (server) await new Promise(resolve => server.close(resolve));
    if (handle) await handle.close(); if (db) await db.destroy();
    await root.raw(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await root.destroy();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
