// Run with the isolated PostgreSQL runner. Only fictional local data is used.
// OFFICE_QA_SSH_HOST / OFFICE_QA_SSH_KEY authorize access to an existing Office service.
// An ephemeral tunnel binds the callback port to the Docker gateway, never the public interface.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const AdmZip = require('adm-zip');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const load = name => require(path.resolve('backend/pilot', name));
const { config } = load('config'), { createDb } = load('db'), storage = load('storage');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function document() {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  z.addFile('_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  z.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>虚构采购合同。交付期限另行商议。</w:t></w:r></w:p><w:p><w:r><w:t>此文件仅用于隔离验收。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'));
  return z.toBuffer();
}
const complete = async ({ context, documents }) => ({
  async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    const report = { summary: '隔离验收：交付期限应明确。', contractType: '采购合同', reviewedVersionIds: documents.map(d => d.versionId), limitations: ['审查输出使用确定性测试响应，验证保存和版本链。'], findings: [{ title: '交付期限不明确', status: 'fail', kind: 'clause', severity: 'high', reason: '缺少明确交付日期', suggestion: '操作：替换；位置：交付条款；条款正文：乙方应在【待双方确认】日前完成交付。', evidence: [{ versionId: documents[0].versionId, blockId: documents[0].blocks.find(b => b.text.includes('交付期限另行商议')).id, quote: '交付期限另行商议' }], legalSourceIds: [] }] };
    assert.equal((await context.execute('submit_review', { report }, randomUUID())).submitted, true); return {};
  }, async close() {},
});
test('real OnlyOffice: type, force-save, review v2, annotate, and return to historical v1', { timeout: 180000 }, async t => {
  const host = process.env.OFFICE_QA_SSH_HOST, key = process.env.OFFICE_QA_SSH_KEY;
  assert.ok(host && key, 'Configure OFFICE_QA_SSH_HOST and OFFICE_QA_SSH_KEY');
  const container = process.env.OFFICE_QA_CONTAINER || 'legal-contract-review-onlyoffice';
  assert.match(container, /^[a-zA-Z0-9_.-]+$/);
  const sshArgs = ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12'];
  const metadata = JSON.parse(execFileSync('ssh', [...sshArgs, host, 'docker inspect ' + container], { encoding: 'utf8', windowsHide: true }))[0];
  const secret = metadata.Config.Env.find(v => v.startsWith('JWT_SECRET='))?.slice(11);
  const gateway = Object.values(metadata.NetworkSettings.Networks)[0].Gateway;
  assert.ok(secret); assert.match(gateway, /^\d+\.\d+\.\d+\.\d+$/);
  let root, db, handle, server, tunnel, browser, page, database;
  // Keep each attempt's evidence: a failed rerun must not overwrite a pass.
  const out = path.resolve('.local/legal-fixes/real-office-runs', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  await fs.mkdir(out, { recursive: true });
  console.log('REAL_OFFICE_QA evidence ' + out);
  const stage = async value => { await fs.writeFile(path.join(out, 'real-office-progress.json'), JSON.stringify({ stage: value, time: new Date().toISOString() })); };
  t.signal.addEventListener('abort', () => { browser?.close().catch(() => {}); tunnel?.kill(); }, { once: true });
  const result = { realOnlyOffice: true, productionDatabaseUsed: false, modelResponseIsFixture: true };
  try {
    root = createDb(); database = 'legal_test_realoffice_' + randomUUID().replaceAll('-', '');
    await root.raw(`CREATE DATABASE "${database}"`);
    const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
    config.dataRoot = path.join(out, database); config.env = 'test'; db = createDb();
    await load('cli').migrate(db); await storage.initializeDirectories();
    const password = randomUUID(), actor = { id: randomUUID(), username: 'real-office-local', display_name: '隔离验收法务', department: '测试', roles: '["admin"]', password_hash: await load('auth').hashPassword(password) };
    await db('la_users').insert(actor);
    const f = await db.transaction(trx => load('contracts').createContract(trx, actor, { originalname: '真实编辑器隔离验收.docx', buffer: document() }));
    await load('agent/service').processReview(db, f.reviewId, { runtimeFactory: complete });
    const officePort = await freePort();
    config.office.url = config.office.internalUrl = 'http://127.0.0.1:' + officePort; config.office.secret = secret;
    handle = load('app').createApp(db); server = http.createServer(handle.app); await new Promise(r => server.listen(0, '127.0.0.1', r));
    server.on('request', (req, res) => { if (req.url === '/api/onlyoffice/callback') res.on('finish', () => console.log('QA_CALLBACK '+res.statusCode)); });
    const base = 'http://127.0.0.1:' + server.address().port, callbackPort = 25000 + Math.floor(Math.random() * 15000);
    config.publicUrl = base; config.office.url = config.office.internalUrl = 'http://127.0.0.1:' + officePort;
    config.office.backendUrl = `http://${gateway}:${callbackPort}`; config.office.secret = secret;
    const remoteOfficePort = process.env.OFFICE_QA_REMOTE_PORT || '18091'; assert.match(remoteOfficePort, /^\d+$/);
    tunnel = spawn('ssh', [...sshArgs, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-N', '-L', `127.0.0.1:${officePort}:127.0.0.1:${remoteOfficePort}`, '-R', `${gateway}:${callbackPort}:127.0.0.1:${server.address().port}`, host], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 20; i++) {
      const healthy = await fetch(config.office.url + '/healthcheck', { signal: AbortSignal.timeout(3000) })
        .then(async r => r.ok && (await r.text()).trim() === 'true').catch(() => false);
      if (healthy) break;
      if (i === 19) throw Error('OnlyOffice healthcheck is not true; check the Office service and tunnel before rerunning');
      await pause(500);
    }
    await stage('tunnel-ready');
    browser = await chromium.launch({ channel: 'msedge', headless: true }); page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(45000);
    page.on('requestfailed', r => console.log('QA_NETWORK '+new URL(r.url()).pathname+' '+r.failure()?.errorText));
    page.on('response', r => { if (r.status() >= 400) console.log('QA_HTTP '+new URL(r.url()).pathname+' '+r.status()); });
    const session = await (await page.request.get(base + '/api/auth/session')).json();
    assert.equal((await page.request.post(base + '/api/auth/login', { headers: { Origin: base, 'X-CSRF-Token': session.csrf }, data: { username: actor.username, password } })).status(), 200);
    await page.goto(base + '/#/contracts/' + f.contract.id);
    await stage('contract-open');
    await page.getByRole('button', { name: '打开改稿', exact: true }).click();
    await page.locator('.office-status').filter({ hasText: /已开启修订|编辑器.*(失败|无法)/ }).waitFor({ timeout: 60000 });
    assert.equal(await page.locator('.office-error').count(), 0, 'OnlyOffice script must load');
    console.log('REAL_OFFICE_QA editor ready');
    await stage('editor-ready');
    const frame = page.frames().find(f => /documenteditor/.test(f.url())); assert.ok(frame, 'real documenteditor iframe');
    await frame.waitForFunction(() => !!window.Asc?.editor);
    await frame.locator('#editor_sdk').click({ position: { x: 360, y: 240 } });
    await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
    const marker = '隔离验收新增条款：验收合格后付款。'; await page.keyboard.insertText(marker);
    await page.getByRole('status').filter({ hasText: '有修改待保存' }).waitFor();
    console.log('REAL_OFFICE_QA keyboard edit pending');
    await stage('keyboard-edited');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存为 v2' }).waitFor({ timeout: 60000 });
    console.log('REAL_OFFICE_QA v2 saved');
    await stage('v2-saved');
    const c = await db('la_contracts').where({ id: f.contract.id }).first(), v2 = await db('la_versions').where({ id: c.current_version_id }).first();
    const bytes = await storage.read(v2.storage_key), parsed = load('parser').parseDocx(bytes);
    assert.ok(parsed.blocks.some(b => b.text.includes(marker)), 'real keyboard text must exist in saved DOCX');
    assert.match(new AdmZip(bytes).readAsText('word/document.xml'), /w:ins/);
    await page.screenshot({ path: path.join(out, 'real-office-saved-v2.png'), fullPage: true, timeout: 10000 });
    result.realKeyboardTextSaved = true; result.trackedChangesRetained = true;
    assert.equal(await page.getByRole('button', { name: '生成批注建议稿', exact: true }).isDisabled(), true);
    await load('agent/service').processReview(db, c.current_review_id, { runtimeFactory: complete });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '生成批注建议稿' && !b.disabled));
    const generated = page.waitForResponse(r => r.url().endsWith('/annotated-version') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '生成批注建议稿', exact: true }).click(); const response = await generated; assert.equal(response.status(), 201);
    const artifact = await response.json(), v3 = await db('la_versions').where({ id: artifact.versionId }).first();
    assert.equal(v3.parent_id, v2.id); assert.equal(artifact.sourceVersionId, v2.id);
    const finalBytes = await storage.read(v3.storage_key), finalParsed = load('parser').parseDocx(finalBytes);
    assert.ok(finalParsed.blocks.some(b => b.text.includes(marker))); assert.ok(finalParsed.originalComments.length > 0);
    await page.waitForFunction(id => document.querySelector('select[aria-label="当前材料"]')?.value === id, v3.id);
    await page.getByLabel('当前材料', { exact: true }).selectOption(f.version.id);
    await page.getByRole('heading', { name: '交付期限不明确', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '采纳', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(out, 'real-office-historical.png'), fullPage: true });
    Object.assign(result, { passed: true, v1: f.version.id, savedVersion: v2.id, annotatedVersion: v3.id, sourceMatchesSaved: true, historicalReportRestored: true });
    console.log('REAL_OFFICE_QA passed: real keyboard text, signed save, review v2, annotations and historical report');
  } catch (e) { result.passed = false; result.error = e.message; throw e; }
  finally {
    if (page) await page.screenshot({ path: path.join(out, 'real-office-last.png'), fullPage: true, timeout: 5000 }).catch(() => {});
    await fs.writeFile(path.join(out, 'real-office-result.json'), JSON.stringify(result, null, 2));
    await browser?.close(); tunnel?.kill();
    if (server) await new Promise(r => server.close(r)); await handle?.close(); await db?.destroy();
    if (root && database) { await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=? AND pid<>pg_backend_pid()', [database]); await root.raw(`DROP DATABASE "${database}"`); } await root?.destroy();
  }
});
