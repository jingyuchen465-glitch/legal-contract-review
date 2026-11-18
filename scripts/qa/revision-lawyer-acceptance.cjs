// Real Vue/API/database/model/Harness; only the absent Word service is simulated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const AdmZip = require('adm-zip'), jwt = require('jsonwebtoken');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { config } = require('../../backend/pilot/config'), { createDb } = require('../../backend/pilot/db');
const storage = require('../../backend/pilot/storage'), { parseDocx } = require('../../backend/pilot/parser');
const service = require('../../backend/pilot/agent/service');
const sourceClause = '第三条 交付：乙方将货物运送至甲方上海市办公场所并承担运输费用和交付前毁损风险，交付期限由双方另行协商确定。';
const correctedClause = '第三条 交付：乙方应在本合同生效后三十个自然日内，将全部合格货物运送至甲方上海市办公场所并承担运输费用和交付前毁损风险。甲方应提供具体收货地址和联系人；乙方完成交付以甲方签收记录为准，签收不替代质量验收。';
const paragraphs = [
  '【虚构验收】办公展示架采购合同',
  '甲方：虚构华星采购有限公司；乙方：虚构青禾设备有限公司。本合同及主体仅用于本地软件验收，不发生真实交易。',
  '第一条 标的与质量：甲方向乙方购买十套办公展示架，每套人民币1000元，含13%增值税合同总价人民币10000元；每套尺寸长100厘米、宽40厘米、高180厘米，钢制烤漆，单层承重30千克，共五层。乙方保证货物全新、符合前述规格和适用国家质量安全要求，不侵犯第三方知识产权。',
  '第二条 付款：甲方于合同生效后三个工作日内支付20%预付款，剩余80%于交付且验收合格、收到合法有效13%增值税专用发票后十个工作日内支付。付款账户以乙方盖章书面通知为准，账户变更应书面通知并经甲方核实。',
  sourceClause,
  '第四条 验收：甲方在收到货物后五个工作日内按本合同规格、数量及外观进行验收。未签署验收合格确认书不视为质量验收通过。对隐蔽瑕疵和质量保证期内发现的质量问题，甲方有权提出异议。',
  '第五条 质保：质量保证期自验收合格之日起十二个月。乙方收到质量问题通知后两个工作日内响应，五个工作日内免费维修或更换；逾期未修复，甲方可委托第三方处理，合理费用由乙方承担。',
  '第六条 违约责任：乙方迟延交付，每逾期一日按合同总价的万分之五向甲方支付违约金，超过十五日甲方有权书面解除合同，乙方应于解除通知到达后五个工作日内退还未履行部分预付款。甲方迟延付款，对无争议逾期款按相同标准承担违约责任。普通违约赔偿总额以合同总价20%为限；故意、重大过失、知识产权侵权及人身损害不适用该限制。',
  '第七条 解除：任何一方严重违约，经书面催告后十个工作日内未改正的，守约方有权解除本合同并要求违约方承担责任。解除后五个工作日内结算已履行部分，退还未履行部分款项。',
  '第八条 保密与数据：双方对履约中知悉的商业秘密、收货联系人信息予以保密，仅用于本合同履行，并限于必要人员知悉。合同终止后依法保留必要凭证，其他资料依对方合理要求返还或删除。',
  '第九条 不可抗力：受影响方应及时通知并在十个工作日内提供证明，采取措施减少损失；仅在实际影响范围内依法免责。迟延履行后发生不可抗力不免除迟延责任。影响持续三十日以上，双方可协商解除并据实结算。',
  '第十条 通知：双方书面指定收货及合同联系人和电子邮箱作为通知地址，地址变更应提前三个工作日书面通知。通知以实际签收或可核验的到达记录为准。',
  '第十一条 争议与生效：适用中华人民共和国大陆地区法律。争议协商不成，提交甲方住所地有管辖权的人民法院解决。合同经双方盖章后生效；变更须双方书面确认。本合同不含其他附件。',
];
function docx(texts) {
  const zip = new AdmZip(), esc = v => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + texts.map(t => '<w:p><w:r><w:t xml:space="preserve">' + esc(t) + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>'));
  return zip.toBuffer();
}

test('lawyer accepts/corrects advice, saves a tracked draft and checks two real-model revision reports', { timeout: 1200000 }, async () => {
  const provider = JSON.parse(process.env.QA_LAWYER_PROVIDER || '{}'); delete process.env.QA_LAWYER_PROVIDER;
  assert.ok(provider.key, 'Run through run-lawyer-acceptance.cjs');
  const output = path.resolve('.local/lawyer-acceptance-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(output, { recursive: true });
  config.model = { ...config.model, ...provider }; config.dataRoot = path.join(output, 'data');
  config.office.secret = randomUUID() + randomUUID();
  const db = createDb(), steps = [], rounds = [], errors = [], editorBuffers = new Map();
  let browser, page, app, server, officeServer, realtime, base, contractId, passed = false;
  const actor = { id: randomUUID(), username: 'acceptance-lawyer', display_name: '模拟法务验收', department: '虚构验收', roles: ['legal', 'business'] };
  const password = 'isolated-' + randomUUID();
  async function evidence(name, detail = {}) {
    steps.push({ name, ...detail });
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed, model: provider.name, editor: 'simulated service, real signed save callback and tracked DOCX', steps, rounds, errors }, null, 2));
    if (page) await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
    console.log('LAWYER_STEP ' + JSON.stringify({ name, ...detail }));
  }
  async function runModel(reviewId, label) {
    console.log('REAL_MODEL_START ' + label);
    await service.processReview(db, reviewId, { notify: async (_id, event) => {
      if (['model_request', 'completed', 'waiting_input', 'failed', 'paused'].includes(event.type)) console.log('MODEL_PROGRESS ' + JSON.stringify({ round: label, type: event.type, number: event.number, message: event.message }));
    } });
    const run = await db('la_reviews').where({ id: reviewId }).first();
    const tools = await db('la_agent_tool_calls').where({ review_id: reviewId }).orderBy('created_at');
    rounds.push({ label, reviewId, status: run.status, errorCode: run.error_code, summary: run.agent_result?.summary, findings: (await db('la_findings').where({ review_id: reviewId })).map(f => ({ id: f.id, title: f.title, severity: f.severity })), revisionReview: run.agent_result?.revisionReview, tools: tools.map(t => ({ name: t.name, error: t.result?.error, message: t.result?.error ? t.result.message : undefined })) });
    await fs.writeFile(path.join(output, label + '-report.json'), JSON.stringify({ ...run, snapshot: { ...run.snapshot, memories: [], knowledge: [] } }, null, 2));
    assert.equal(run.status, 'completed', label + ': ' + run.error_code + ' ' + run.error_message);
    return run;
  }
  try {
    await require('../../backend/pilot/cli').migrate(db); await storage.initializeDirectories();
    await db('la_users').insert({ ...actor, roles: JSON.stringify(actor.roles), password_hash: await require('../../backend/pilot/auth').hashPassword(password) });
    await db('la_settings').insert({ key: 'agent', value: JSON.stringify({ maxRequests: 32, maxMinutes: 6, maxOutputTokens: 16000 }) });
    officeServer = http.createServer(async (request, response) => {
      try {
        if (request.method === 'GET' && request.url.startsWith('/saved/')) { const key = request.url.split('/').at(-1).replace('.docx', ''); response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); response.end(editorBuffers.get(key)); return; }
        if (request.method === 'POST' && request.url === '/coauthoring/CommandService.ashx') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString()); const signed = jwt.verify(body.token, config.office.secret);
          assert.equal(signed.key, body.key); assert.equal(signed.c, 'forcesave');
          const payload = { key: body.key, status: 6, url: config.office.internalUrl + '/saved/' + body.key + '.docx' };
          const saved = await fetch(base + '/api/onlyoffice/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, token: jwt.sign(payload, config.office.secret) }) });
          assert.equal(saved.status, 200); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: 0 })); return;
        }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: 4 }));
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: 'QA_EDITOR_SAVE_FAILED', message: error.message })); }
    });
    await new Promise(resolve => officeServer.listen(0, '127.0.0.1', resolve));
    config.office.url = config.office.internalUrl = 'http://127.0.0.1:' + officeServer.address().port;
    app = require('../../backend/pilot/app').createApp(db); server = http.createServer(app.app);
    realtime = require('../../backend/pilot/realtime').setupRealtime(server, db, app.sessionMiddleware);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
    config.publicUrl = config.office.backendUrl = base;
    browser = await chromium.launch({ channel: 'msedge', headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.DocsAPI = { DocEditor: function (id, cfg) {
      const host = document.getElementById(id), title = document.createElement('p'), input = document.createElement('textarea');
      title.textContent = '本地验收模拟 Word 编辑区域（非真实 OnlyOffice）'; input.setAttribute('aria-label', '模拟 Word 正文'); input.style.cssText = 'width:96%;height:85%;margin:10px;font-size:14px;line-height:1.8'; input.value = (window.__qaParagraphs || []).join('\n');
      input.addEventListener('input', () => cfg.events.onDocumentStateChange({ data: true })); host.replaceChildren(title, input);
      window.__qaOffice = { config: cfg }; this.destroyEditor = () => host.replaceChildren(); setTimeout(() => cfg.events.onDocumentReady(), 20);
    } }; });
    await page.goto(base);
    await page.getByPlaceholder('请输入账号').fill(actor.username); await page.getByPlaceholder('请输入密码').fill(password); await page.getByRole('button', { name: '登录工作台 →', exact: true }).click();
    await page.getByRole('button', { name: '＋ 提交合同', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '提交合同', exact: true });
    await dialog.getByLabel(/^我方为/).selectOption('party_a'); await dialog.getByLabel('我方主体', { exact: true }).fill('虚构华星采购有限公司');
    await dialog.getByLabel('我方交易立场', { exact: true }).fill('采购方');
    await dialog.getByLabel('交易目的 / 重点检查项', { exact: true }).fill('本案是软件验收中的虚构大陆地区企业采购，采购办公展示架用于自用，不涉及跨境、消费者或特殊资质。甲方为采购方，身份与文本一致；规格、价格、付款、验收、质保、赔偿上限均为模拟双方已确认的商业条件。重点核查交付期限能否执行及修改落实情况；不因纯措辞偏好新增风险。联系人和具体地址在交付前书面提供。');
    await dialog.locator('input[type=file]').setInputFiles({ name: '虚构法务复核验收合同.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx(paragraphs) });
    await dialog.getByRole('button', { name: '上传并开始审查', exact: true }).click();
    await page.getByRole('heading', { name: '虚构法务复核验收合同.docx', exact: true }).waitFor();
    let contract = await db('la_contracts').where({ title: '虚构法务复核验收合同.docx' }).first(); contractId = contract.id;
    const firstVersionId = contract.current_version_id, firstReviewId = contract.current_review_id;
    await evidence('01-upload', { version: 1 });
    await runModel(firstReviewId, 'round1');
    const findings = await db('la_findings').where({ review_id: firstReviewId }).orderBy('created_at');
    const delivery = findings.find(f => f.evidence.some(e => sourceClause.includes(e.quote) && /期限|交付|交货/.test(f.title + f.reason)));
    assert.ok(delivery, 'Real model must identify the deliberately unspecified delivery deadline');
    await page.getByRole('button', { name: '审查意见', exact: true }).click();
    const card = page.locator('.agent-finding').filter({ has: page.getByRole('button', { name: delivery.title, exact: true }) }); await card.waitFor();
    await evidence('02-initial-review', { issueCount: findings.length, deliveryIssue: delivery.title });
    await card.getByRole('button', { name: '认可意见', exact: true }).click();
    const accept = page.getByRole('dialog', { name: '认可审查意见', exact: true });
    await accept.getByLabel('法务理由').fill('认可应明确交付期限的建议，下一步补齐双方已确认的三十个自然日交付期限。');
    await accept.getByRole('button', { name: '保存复核记录', exact: true }).click(); await accept.waitFor({ state: 'hidden' });
    assert.equal((await db('la_contracts').where({ id: contractId }).first()).current_version_id, firstVersionId);
    await evidence('03-accept-does-not-edit', { versionUnchanged: true });
    await card.getByRole('button', { name: '修正意见', exact: true }).click();
    const correct = page.getByRole('dialog', { name: '修正审查意见', exact: true });
    await correct.getByLabel('法务理由').fill('虚构双方已确认本合同生效后三十个自然日内交付，不再留待另行协商。'); await correct.getByLabel('修改建议').fill(correctedClause);
    await correct.getByRole('button', { name: '保存复核记录', exact: true }).click(); await correct.waitFor({ state: 'hidden' });
    await page.evaluate(value => { window.__qaParagraphs = value; }, paragraphs);
    await page.locator('.agent-document').getByRole('button', { name: '打开改稿', exact: true }).click();
    const editor = page.getByLabel('模拟 Word 正文', { exact: true }); await editor.waitFor();
    const cfg = await page.evaluate(() => window.__qaOffice.config);
    const source = Buffer.from(await (await fetch(cfg.document.url)).arrayBuffer()); const parsed = parseDocx(source), block = parsed.blocks.find(b => b.text === sourceClause);
    assert.ok(block); const updated = paragraphs.map(text => text === sourceClause ? correctedClause : text);
    await editor.fill(updated.join('\n'));
    editorBuffers.set(cfg.document.key, require('../../backend/pilot/clause-revisions').applyClauseRevisions(source, { explanation: '模拟法务已确认并手工补齐交付期限。', edits: [{ operation: 'replace', blockId: block.id, originalText: block.text, newText: correctedClause }] }, actor.display_name));
    await evidence('04-edit-draft', { editor: 'simulated Word service', actualDocumentChanges: true });
    await page.getByRole('button', { name: '保存并返回', exact: true }).click(); await page.locator('.office-workspace').waitFor({ state: 'hidden' });
    contract = await db('la_contracts').where({ id: contractId }).first(); const secondVersionId = contract.current_version_id, secondReviewId = contract.current_review_id;
    assert.notEqual(secondVersionId, firstVersionId); const savedVersion = await db('la_versions').where({ id: secondVersionId }).first();
    const savedDoc = parseDocx(await storage.read(savedVersion.storage_key));
    assert.ok(savedDoc.blocks.some(b => b.text === correctedClause)); assert.ok(savedDoc.revisions.some(r => r.type === 'insert'));
    assert.equal(savedVersion.version_no, 2); assert.equal(savedVersion.source_action, 'onlyoffice');
    await evidence('05-saved-returned', { version: 2, trackedChanges: savedDoc.revisions.length, onlyOneNewVersion: true });
    const second = await runModel(secondReviewId, 'round2');
    const revision = second.agent_result.revisionReview;
    assert.equal(revision.baselineReviewId, firstReviewId); assert.equal(revision.items.length, findings.filter(f => f.check_status !== 'pass').length);
    const deliveryItem = revision.items.find(item => item.previousFindingId === delivery.id); assert.equal(deliveryItem.status, 'resolved', deliveryItem.reason);
    const section = page.getByRole('region', { name: '修改复核结果' }); await section.waitFor();
    assert.match(await section.innerText(), /已解决/);
    await evidence('06-real-model-revision', { deliveryStatus: deliveryItem.status, newIssues: revision.newFindings.length, statuses: revision.items.map(i => i.status) });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await evidence('07-mobile'); await page.setViewportSize({ width: 1600, height: 1100 });
    await page.getByRole('button', { name: '重新审查', exact: true }).click();
    let thirdReviewId; for (let i = 0; i < 60; i++) { thirdReviewId = (await db('la_contracts').where({ id: contractId }).first()).current_review_id; if (thirdReviewId !== secondReviewId) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.notEqual(thirdReviewId, secondReviewId);
    const third = await runModel(thirdReviewId, 'round3');
    const stable = third.agent_result.revisionReview;
    const carried = stable.items.find(item => item.previousFindingId === delivery.id);
    assert.equal(carried?.status, 'resolved', 'resolved delivery issue must survive a same-text recheck');
    assert.ok(!stable.newFindings.some(item => item.origin === 'introduced_by_edit'));
    assert.equal((await db('la_contracts').where({ id: contractId }).first()).current_version_id, secondVersionId);
    // Explicitly select the latest finished report after background processing.
    await page.getByRole('button', { name: '最新报告', exact: true }).click(); await page.waitForFunction(id => document.querySelector('select[aria-label="审查报告"]')?.value === id, thirdReviewId);
    await evidence('08-same-text-recheck', { newIssues: stable.newFindings.length, preservedResolvedIssue: true, versionRemains: 2 });
    const exportResponse = await page.request.get(base + '/api/reviews/' + thirdReviewId + '/report?format=html'); assert.equal(exportResponse.status(), 200); const html = await exportResponse.text(); assert.match(html, /修改复核/); await fs.writeFile(path.join(output, 'final-report.html'), html);
    await page.getByRole('button', { name: '确认法务结论', exact: true }).click();
    const final = page.getByRole('dialog', { name: '确认本版法务结论', exact: true });
    const pending = stable.items.filter(item => !['resolved', 'accepted'].includes(item.status)).length + stable.newFindings.length;
    await final.getByLabel(/^结论/).selectOption(pending ? 'conditional' : 'agree');
    await final.getByLabel('理由', { exact: true }).fill('虚构验收：已核对当前改稿及复核对照，本操作仅记录模拟法务结论。');
    if (pending) await final.getByLabel('需落实的条件', { exact: true }).fill('当前仍待处理事项须在签署前由模拟业务双方确认并落实，未落实前不得按本模拟结论签署。');
    await final.getByRole('button', { name: '确认结论', exact: true }).click(); await final.waitFor({ state: 'hidden' });
    await page.getByText(pending ? '法务结论：附条件同意' : '法务结论：同意', { exact: true }).waitFor();
    await evidence('09-human-conclusion', { outcome: pending ? 'conditional' : 'agree', pending });
    await page.getByLabel('当前材料', { exact: true }).selectOption(firstVersionId); await card.waitFor();
    assert.equal(await page.getByRole('button', { name: '确认法务结论', exact: true }).count(), 0);
    assert.equal(await card.getByRole('button', { name: '认可意见', exact: true }).count(), 0);
    assert.equal((await db('la_findings').where({ id: delivery.id }).first()).disposition.action, 'correct');
    await evidence('10-historical-version', { originalReportPreserved: true, originalVersionReadOnly: true });
    await page.goto(base + '/#/contracts/' + contractId + '/history/' + thirdReviewId); await page.getByRole('heading', { name: '历史审查记录', exact: true }).waitFor(); await section.waitFor();
    assert.deepEqual(errors, []); passed = true;
    await evidence('11-history-and-export', { revisionInHistoryAndExport: true });
    console.log('LAWYER_ACCEPTANCE_OUTPUT ' + output);
  } catch (error) {
    errors.push(error.message); await evidence('failure', { message: error.message }).catch(() => {}); throw error;
  } finally {
    await browser?.close(); await realtime?.close(); if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (officeServer?.listening) { officeServer.closeAllConnections(); await new Promise(resolve => officeServer.close(resolve)); }
    await app?.close(); await db.destroy();
  }
});
