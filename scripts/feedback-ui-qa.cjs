// Runs only against scripts/ui-qa.js's isolated, explicitly labelled fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { chromium } = require('playwright');

async function main() {
  const access = JSON.parse(await fs.readFile(path.resolve(__dirname, '../.local/ui-qa/access.json'), 'utf8'));
  assert.equal(new URL(access.url).hostname, 'localhost');
  assert.equal(new URL(access.url).port, '3001');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const session = await (await context.request.get(access.url + '/api/auth/session')).json();
    const login = await context.request.post(access.url + '/api/auth/login', { headers: { 'X-CSRF-Token': session.csrf }, data: { username: access.username, password: access.password } });
    assert.equal(login.status(), 200); const { csrf } = await login.json();
    await page.goto(access.url + '/#/contracts/' + access.contractId);
    const reviews = page.locator('.version-bar select').nth(0), versions = page.locator('.version-bar select').nth(1);
    try { await reviews.waitFor({ timeout: 5000 }); } catch (error) { console.error('Page diagnostics:', errors, (await page.locator('body').innerText()).slice(0, 1600)); throw error; }
    const oldReview = await reviews.inputValue(), oldVersion = await versions.inputValue();
    const contract = await (await context.request.get(`${access.url}/api/contracts/${access.contractId}`)).json();
    const annotatedReview = contract.reviews.find(run => run.status === 'completed').id;
    const created = await context.request.post(access.url + '/api/reviews', { headers: { 'X-CSRF-Token': csrf }, data: { contractId: contract.id, revision: contract.revision } });
    assert.equal(created.status(), 202); const { reviewId } = await created.json();
    await page.waitForTimeout(7000);
    assert.equal(await reviews.inputValue(), reviewId, '正常查看当前记录时，后台新预审应自动显示');
    assert.equal(await versions.inputValue(), oldVersion);
    await reviews.selectOption(oldReview);
    await page.waitForTimeout(7000);
    assert.equal(await reviews.inputValue(), oldReview, '主动查看历史预审时应保持所选记录');
    await page.getByRole('button', { name: '返回最新版本与预审' }).click();
    await page.waitForFunction(id => document.querySelectorAll('.version-bar select')[0]?.value === id, reviewId);
    assert.equal(await reviews.inputValue(), reviewId);
    const revised = new AdmZip();
    revised.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>虚构修订稿：交付日期已明确。</w:t></w:r></w:p></w:body></w:document>'));
    const uploaded = page.waitForResponse(response => response.url().includes(`/contracts/${contract.id}/versions`) && response.request().method() === 'POST');
    await page.locator('input[type=file]').setInputFiles({ name: '虚构修订稿.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: revised.toBuffer() });
    const result = await (await uploaded).json();
    await page.waitForFunction(id => document.querySelectorAll('.version-bar select')[1]?.value === id, result.version.id);
    assert.equal(await reviews.inputValue(), result.reviewId);
    assert.notEqual(await versions.inputValue(), oldVersion);
    await reviews.selectOption(annotatedReview);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /下载批注版/ }).click();
    assert.match((await download).suggestedFilename(), /批注版\.docx$/);
    await page.screenshot({ path: path.resolve(__dirname, '../docs/screenshots/反馈问题-版本与导出验收.png'), fullPage: true });
    await page.goto(access.url + '/#/');
    await page.getByRole('button', { name: /提交合同/ }).first().click();
    await page.getByRole('dialog').getByLabel('合同类型', { exact: false }).selectOption('procurement');
    await page.getByText('将匹配 3 项正式检查', { exact: true }).waitFor();
    await page.getByRole('dialog').getByLabel('我方为', { exact: false }).selectOption('party_a');
    assert.equal(await page.getByRole('dialog').getByRole('textbox', { name: '我方主体', exact: true }).getAttribute('required'), null);
    assert.deepEqual(errors, []);
    console.log('PASS: current/history selection, revised upload, actual annotated download, rule preview and party selection.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
