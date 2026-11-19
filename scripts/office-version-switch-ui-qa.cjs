// Uses only the explicitly labelled deployment fixture; never edits a real contract.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const access = JSON.parse(fs.readFileSync(process.env.OFFICE_LINK_QA_ACCESS || '.local/office-links/access-persistent.json', 'utf8'));
const base = new URL(access.url).origin;
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [], result = { candidateAssets: !process.argv.includes('--live') };
  page.on('pageerror', error => errors.push(error.message));
  try {
    if (result.candidateAssets) await page.route(base + '/**', async route => {
      const relative = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (relative !== 'index.html' && !relative.startsWith('assets/')) return route.continue();
      const file = path.resolve('frontend/dist', relative);
      if (!file.startsWith(path.resolve('frontend/dist') + path.sep) || !fs.existsSync(file)) return route.continue();
      await route.fulfill({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript', body: fs.readFileSync(file) });
    });
    await page.goto(base);
    const session = await (await page.request.get(base + '/api/auth/session')).json();
    const login = await page.request.post(base + '/api/auth/login', { headers: { Origin: base, 'X-CSRF-Token': session.csrf }, data: { username: access.username, password: access.password } });
    assert.equal(login.status(), 200);
    const contract = await (await page.request.get(base + '/api/contracts/' + access.contractId)).json();
    assert.match(contract.title, /上线验收虚构样本/);
    await page.goto(base + '/#/contracts/' + contract.id); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '在线编辑', exact: true }).click();
    await page.getByText('已开启修订，修改后请保存', { exact: true }).waitFor({ timeout: 120000 });
    const selectors = page.locator('.version-bar select');
    assert.equal(await selectors.nth(1).isEnabled(), true, '原文版本下拉框在在线编辑时应该可以操作');
    assert.equal(await selectors.nth(0).isEnabled(), true, '预审记录下拉框在在线编辑时应该可以操作');
    result.editorSelectorsEnabled = true;
    // Exercise save failures and edits arriving during save against the actual
    // Vue components, with isolated browser-only API/DocsAPI doubles. These
    // responses never write a version or invoke a model on the server.
    const original = await (await page.request.get(base + '/api/reviews/' + contract.current_review_id)).json();
    const historicalId = '00000000-0000-4000-8000-000000000101', historicalReviewId = '00000000-0000-4000-8000-000000000102';
    const savedId = '00000000-0000-4000-8000-000000000103', savedReviewId = '00000000-0000-4000-8000-000000000104';
    const initialId = contract.current_version_id, initialReviewId = contract.current_review_id;
    const currentVersion = contract.versions.find(v => v.id === initialId);
    const fixture = structuredClone(contract), historic = { ...structuredClone(currentVersion), id: historicalId, version_no: 0, filename: '【浏览器测试替身】历史版本.docx', parent_id: null };
    fixture.versions.push(historic);
    const oldReview = { ...structuredClone(original), id: historicalReviewId, version_id: historicalId, isCurrent: false, created_at: '2026-01-01T00:00:00Z' };
    fixture.reviews.push(oldReview);
    const savedReview = { ...structuredClone(original), id: savedReviewId, version_id: savedId, isCurrent: true };
    let saveMode = 'fail', saveCalls = 0, editDuringSave = false, saved = false;
    await page.addInitScript(() => {
      window.DocsAPI = { DocEditor: function (id, options) {
        window.__versionSwitchEditor = options;
        document.getElementById(id).textContent = '【浏览器测试替身】编辑内容保持中';
        queueMicrotask(() => options.events.onDocumentReady());
        this.destroyEditor = () => {};
      } };
    });
    const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    await page.route(base + '/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/contracts/' + contract.id) return fulfill(route, fixture);
      const review = [original, oldReview, savedReview].find(r => url.pathname === '/api/reviews/' + r.id);
      if (review) return fulfill(route, review);
      const editorPath = '/api/contracts/' + contract.id + '/editor';
      if (url.pathname === editorPath) return fulfill(route, { session: { key: 'browser-version-switch' }, serverUrl: base + '/onlyoffice', config: {} });
      if (url.pathname === editorPath + '/browser-version-switch/save') {
        saveCalls++;
        if (saveMode === 'fail') return fulfill(route, { message: '验收模拟保存失败，编辑内容已保留' }, 503);
        if (editDuringSave) await page.evaluate(() => window.__versionSwitchEditor.events.onDocumentStateChange({ data: true }));
        if (!saved) {
          fixture.versions.unshift({ ...structuredClone(currentVersion), id: savedId, version_no: currentVersion.version_no + 1, parent_id: initialId, filename: '【浏览器测试替身】已保存版本.docx' });
          fixture.reviews.unshift(savedReview); fixture.current_version_id = savedId; fixture.current_review_id = savedReviewId; saved = true;
        }
        return fulfill(route, { queued: false, versionId: initialId });
      }
      if (url.pathname === editorPath + '/browser-version-switch') return fulfill(route, { saved, versionId: saved ? savedId : initialId, versionNo: currentVersion.version_no + (saved ? 1 : 0) });
      return route.continue();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const openEditor = async () => {
      await page.getByRole('button', { name: '在线编辑', exact: true }).click();
      await page.getByText('已开启修订，修改后请保存', { exact: true }).waitFor();
    };
    const settled = () => page.waitForFunction(() => !document.querySelectorAll('.version-bar select')[1].disabled);
    await openEditor();
    await page.evaluate(() => window.__versionSwitchEditor.events.onDocumentStateChange({ data: true }));
    await selectors.nth(1).selectOption(historicalId); await settled();
    assert.equal(saveCalls, 1); assert.equal(await selectors.nth(1).inputValue(), initialId);
    assert.equal(await selectors.nth(0).inputValue(), initialReviewId); assert.equal(await page.locator('.office-workspace').count(), 1);
    result.failedSaveKeepsEditorAndSelection = true;
    saveMode = 'success'; editDuringSave = true;
    await selectors.nth(1).selectOption(historicalId); await settled();
    assert.equal(await selectors.nth(1).inputValue(), initialId); assert.equal(await page.locator('.office-workspace').count(), 1);
    await page.getByText('保存期间又有新的修改，请稍后再次切换。', { exact: true }).waitFor();
    result.editDuringSaveBlocksSwitch = true;
    editDuringSave = false;
    await selectors.nth(1).selectOption(historicalId); await settled();
    assert.equal(await page.locator('.office-workspace').count(), 0); assert.equal(await selectors.nth(1).inputValue(), historicalId);
    await page.waitForTimeout(6500); assert.equal(await selectors.nth(1).inputValue(), historicalId);
    result.saveThenSwitchKeepsHistoricalVersion = true;
    await page.getByRole('button', { name: '返回最新版本与预审', exact: true }).click(); await settled();
    assert.equal(await selectors.nth(1).inputValue(), savedId); assert.equal(await selectors.nth(0).inputValue(), savedReviewId);
    await openEditor(); await selectors.nth(0).selectOption(historicalReviewId); await settled();
    assert.equal(await selectors.nth(1).inputValue(), historicalId); assert.equal(await selectors.nth(0).inputValue(), historicalReviewId);
    assert.equal(await page.locator('.office-workspace').count(), 0); result.reviewSwitchSelectsMatchingVersion = true;
    await page.screenshot({ path: '.local/office-links/版本切换-浏览器替身验收.png', fullPage: true });
    const final = await (await page.request.get(base + '/api/contracts/' + contract.id)).json();
    assert.equal(final.current_version_id, contract.current_version_id); result.serverContractUnchanged = true;
    result.saveCasesUseBrowserDoubles = true;
    assert.deepEqual(errors, []); result.errors = errors; result.passed = true;
  } finally {
    fs.writeFileSync('.local/office-links/version-switch-browser-result.json', JSON.stringify(result, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
