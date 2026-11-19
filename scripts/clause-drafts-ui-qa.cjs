// Isolated local browser acceptance: real API/database/OOXML, editor and model
// service doubles. No production contracts, accounts or model calls are used.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const AdmZip = require('adm-zip');
const { chromium } = require('playwright');
const { config } = require('../backend/pilot/config');
const { createDb } = require('../backend/pilot/db');
const { migrate } = require('../backend/pilot/cli');
const { hashPassword } = require('../backend/pilot/auth');
const { createApp } = require('../backend/pilot/app');
const { createContract } = require('../backend/pilot/contracts');
const { parseDocx } = require('../backend/pilot/parser');
const storage = require('../backend/pilot/storage');

async function main() {
  const rootDb = createDb(), database = 'legal_test_' + randomUUID().replaceAll('-', '');
  let db, app, web, office, browser, modelCalls = 0;
  const output = path.resolve('.local/clause-drafts'); fs.mkdirSync(output, { recursive: true });
  try {
    await rootDb.raw(`CREATE DATABASE "${database}"`);
    const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
    config.env = 'development'; config.dataRoot = path.join(output, database);
    office = http.createServer(async (req, res) => {
      const parts = []; for await (const part of req) parts.push(part);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/chat/completions') {
        modelCalls++;
        const input = JSON.parse(JSON.parse(Buffer.concat(parts).toString()).messages[1].content);
        const block = input.blocks.find(b => b.id === input.allowedBlockIds[0]);
        const newText = block.text.includes('交付') ? '乙方应在合同生效后【待双方确认】日内交付全部设备。' : '合同解除后，乙方应于【待双方确认】日内退还未履行部分对应款项。';
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ explanation: '提供完整合同条款，期限由双方确认。', edits: [{ operation: 'replace', blockId: block.id, originalText: block.text, newText }] }) } }] }));
      } else res.end(JSON.stringify({ error: 4 }));
    });
    await new Promise(resolve => office.listen(0, '127.0.0.1', resolve));
    config.office.url = config.office.internalUrl = `http://127.0.0.1:${office.address().port}`;
    config.office.secret = 'clause-browser-test-office-secret-32-characters';
    Object.assign(config.model, { baseUrl: config.office.url + '/v1', name: 'draft-browser-test', key: 'fixture-only' });
    db = createDb(); await migrate(db); await storage.initializeDirectories();
    const password = 'clause-browser-test-password', user = { id: randomUUID(), username: 'draft-browser-test', display_name: '改稿验收法务', roles: JSON.stringify(['admin']), password_hash: await hashPassword(password) };
    await db('la_users').insert(user);
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
    const texts = ['乙方交付期限另行商议。', '合同解除后的退款期限另行商议。'];
    zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${texts.map(t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`));
    const buffer = zip.toBuffer();
    const fixture = await db.transaction(trx => createContract(trx, user, { originalname: '【虚构样本】条款改稿验收.docx', buffer }));
    await db('la_versions').where({ id: fixture.version.id }).update({ parsed: JSON.stringify(parseDocx(buffer)) });
    await db('la_reviews').where({ id: fixture.reviewId }).update({ status: 'completed', stage: 'completed', coverage: JSON.stringify({ complete: true, totalRules: 2, checkedRules: 2 }) });
    for (const [i, text] of texts.entries()) await db('la_findings').insert({ id: randomUUID(), review_id: fixture.reviewId, rule_id: 'draft-browser-' + i, title: i ? '退款期限' : '交付期限', check_status: 'fail', kind: 'clause', severity: 'high', reason: '期限未明确，存在履约争议。', suggestion: '补齐期限并明确履约安排。', evidence: JSON.stringify([{ blockId: 'b' + (i + 1), quote: text }]) });
    app = createApp(db);
    web = http.createServer(app.app); await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${web.address().port}`; config.publicUrl = base; config.office.backendUrl = base;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.DocsAPI = { DocEditor: function (id, options) {
        const host = document.getElementById(id);
        host.textContent = '【编辑器测试替身】' + options.document.title;
        host.style.padding = '36px';
        queueMicrotask(() => options.events.onDocumentReady());
        return { destroyEditor() { host.textContent = ''; } };
      } };
    });
    await page.goto(base);
    const session = await (await page.request.get(base + '/api/auth/session')).json();
    assert.equal((await page.request.post(base + '/api/auth/login', { headers: { Origin: base, 'X-CSRF-Token': session.csrf }, data: { username: user.username, password } })).status(), 200);
    await page.goto(base + '/#/contracts/' + fixture.contract.id); await page.reload();
    await page.getByRole('button', { name: '在线编辑', exact: true }).click();
    await page.getByText('已开启修订，修改后请保存', { exact: true }).waitFor();
    const note = title => page.locator('.office-review-note').filter({ has: page.getByRole('button', { name: new RegExp(title) }) });
    const first = note('交付期限');
    await first.getByRole('button', { name: '生成完整条款改稿' }).click();
    await first.getByRole('region', { name: '条款改稿预览' }).waitFor();
    assert.match(await first.locator('.draft-after').innerText(), /乙方应在合同生效后【待双方确认】日内交付/);
    await page.screenshot({ path: path.join(output, '完整条款改稿预览.png'), fullPage: true });
    let failOnce = true;
    await page.route('**/apply-draft', async route => {
      if (failOnce) { failOnce = false; await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_RETRY', message: '验收模拟：应用暂时失败，请重试。' }) }); }
      else await route.continue();
    });
    await first.getByRole('button', { name: '应用改稿并保留修订' }).click();
    await page.getByText('验收模拟：应用暂时失败，请重试。').waitFor();
    assert.equal((await db('la_contracts').where({ id: fixture.contract.id }).first()).current_version_id, fixture.version.id);
    assert.equal(await first.locator('.office-draft').count(), 1);
    await first.getByRole('button', { name: '应用改稿并保留修订' }).click();
    await first.getByRole('button', { name: '已应用改稿' }).waitFor();
    await page.getByText('已保存为 v2，可继续编辑', { exact: true }).waitFor();
    assert.equal(await first.getByRole('button', { name: '已应用改稿' }).isDisabled(), true);
    const second = note('退款期限');
    await second.getByRole('button', { name: '生成完整条款改稿' }).click();
    await second.locator('.office-draft').waitFor();
    await second.getByRole('button', { name: '应用改稿并保留修订' }).click();
    await page.getByText('已保存为 v3，可继续编辑', { exact: true }).waitFor();
    await page.setViewportSize({ width: 900, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '保存并返回', exact: true }).click();
    await page.getByText(/已保存为 v3，Word 修订和批注已保留/).waitFor();
    const current = await db('la_contracts').where({ id: fixture.contract.id }).first(), version = await db('la_versions').where({ id: current.current_version_id }).first();
    const final = parseDocx(await storage.read(version.storage_key));
    assert.equal(final.revisions.filter(r => r.type === 'insert').length, 2);
    assert.match(final.blocks[0].text, /交付全部设备/); assert.match(final.blocks[1].text, /退还未履行部分/);
    assert.equal(modelCalls, 2); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, editorDouble: true, realDatabaseAndApi: true, modelCalls, sequentialRevisions: 2, applyFailureRetainsPreview: true, narrowLayout: true, closePreservesSavedVersion: true, errors }, null, 2));
    console.log('Browser acceptance passed: preview, apply/retry, sequential edits, reopen, narrow layout, saved-version return.');
  } finally {
    await browser?.close();
    if (web) await new Promise(resolve => web.close(resolve));
    await app?.close(); await db?.destroy();
    if (office) await new Promise(resolve => office.close(resolve));
    await rootDb.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]);
    await rootDb.raw(`DROP DATABASE IF EXISTS "${database}"`); await rootDb.destroy();
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
