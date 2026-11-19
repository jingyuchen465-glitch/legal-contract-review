const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const access = JSON.parse(fs.readFileSync(process.env.OFFICE_LINK_QA_ACCESS || '.local/office-links/access.json', 'utf8'));
const base = new URL(access.url).origin;
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }), errors = [], result = { liveEditor: true, candidateAssets: !process.argv.includes('--live') };
  page.on('pageerror', error => errors.push(error.message));
  try {
    if (result.candidateAssets) await page.route(base + '/**', async route => {
      const url = new URL(route.request().url()), relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (relative !== 'index.html' && !relative.startsWith('assets/')) return route.continue();
      const file = path.resolve('frontend/dist', relative);
      if (!file.startsWith(path.resolve('frontend/dist') + path.sep) || !fs.existsSync(file)) return route.continue();
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript';
      await route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    });
    await page.goto(base);
    const session = await (await page.request.get(base + '/api/auth/session')).json();
    const password = access.password;
    const login = await page.request.post(base + '/api/auth/login', { headers: { Origin: base, 'X-CSRF-Token': session.csrf }, data: { username: access.username, password } }); assert.equal(login.status(), 200);
    const fixture = {contractId:access.contractId};
    await page.goto(base + '/#/contracts/' + fixture.contractId); await page.reload({ waitUntil: 'domcontentloaded' });
    const initial = await (await page.request.get(base + '/api/contracts/' + fixture.contractId)).json(); assert.match(initial.title, /上线验收虚构样本/);
    await page.getByRole('button', { name: '在线编辑', exact: true }).click();
    await page.getByText('已开启修订，修改后请保存', { exact: true }).waitFor({ timeout: 120000 });
    const line = page.getByTestId('office-clause-connector');
    const frame = page.frames().find(f => /documenteditor/.test(f.url())); assert.ok(frame);
    const firstNote = access.persistent ? page.locator('.office-review-note').filter({ hasText: '第一页交付期限' }) : page.locator('.office-review-note').first();
    const locateFirst = () => firstNote.getByRole('button', { name: '定位原文 ↗', exact: true }).click();
    const selectedPath = () => line.locator('.connector-selected path.connector-stroke').first();
    if (access.persistent) {
      await page.waitForFunction(() => document.querySelectorAll('.office-connectors g').length >= 2);
      assert.equal(await frame.evaluate(() => window.Asc.editor.getCurrentPage()), 0);
      assert.equal(await page.locator('.office-note-selected').count(), 0);
      const count = await line.locator('g').count();
      assert.ok(count >= 2); assert.equal(await line.locator('g').evaluateAll(nodes => new Set(nodes.map(n => n.dataset.findingId)).size), count);
      await frame.evaluate(() => { window.__persistentPopupEvents = 0; for (const name of ['asc_onShowComment','asc_onHideComment']) window.Asc.editor.asc_registerCallback(name, () => window.__persistentPopupEvents++); });
      await page.waitForTimeout(600);
      assert.equal(await frame.evaluate(() => window.__persistentPopupEvents), 0);
      assert.equal(await frame.locator('.asc-window').filter({ has: frame.locator('#id-comments-popover') }).isVisible(), false);
      await page.screenshot({ path: '.local/office-links/持续连线-无需点击.png', fullPage: true });
      result.defaultMultipleLinesWithoutClick = true; result.backgroundMeasurementKeepsSelectionAndPopup = true;
    }
    await locateFirst(); await line.waitFor({ timeout: 10000 });
    if (access.multiPage) {
      const crossNote = page.locator('.office-review-note').filter({ hasText: '跨页期限' });
      if (access.persistent) await crossNote.getByRole('button', { name: '定位原文 ↗', exact: true }).click();
      await frame.waitForFunction(() => window.Asc.editor.getCurrentPage() === 1);
      await page.getByRole('button', { name: /^下一处/ }).click(); await page.waitForTimeout(300); await line.waitFor();
      await frame.waitForFunction(() => window.Asc.editor.getCurrentPage() === 2);
      await page.getByRole('button', { name: /^下一处/ }).click(); await page.waitForTimeout(300); await line.waitFor();
      await frame.waitForFunction(() => window.Asc.editor.getCurrentPage() === 1); result.multiplePageAnchors = true;
      await page.locator('.office-note-list .note-heading').filter({ hasText: '缺失条款' }).click();
      const missingId = await page.locator('.office-review-note').filter({ hasText: '缺失条款' }).getAttribute('data-link-finding-id');
      assert.equal(await page.locator(`.office-connectors g[data-finding-id="${missingId}"]`).count(), 0);
      await page.locator('.office-link-help').filter({ hasText: '结合全文核实' }).waitFor();
      await locateFirst(); await line.waitFor(); result.missingClauseHasNoFalseLine = true;
    }
    assert.equal(await frame.evaluate(() => document.documentElement.hasAttribute('data-legal-comment-link')), true);
    assert.equal(await frame.evaluate(() => getComputedStyle(document.getElementById('id-comments-popover').closest('.asc-window')).visibility), 'hidden');
    const before = await selectedPath().getAttribute('d');
    const circle = await line.locator('.connector-selected circle').first().boundingBox(), card = await firstNote.boundingBox(); assert.ok(circle.x < card.x);
    await page.screenshot({ path: '.local/office-links/连线-桌面.png', fullPage: true }); result.clickLocatesAndConnects = true;
    await frame.locator('#editor_sdk').hover(); await page.mouse.wheel(0, 45); await page.waitForTimeout(500);
    const after = await selectedPath().getAttribute('d'); assert.notEqual(after, before); result.followsDocumentScroll = true;
    for (let attempt=0;attempt<10 && await line.count();attempt++) { await page.mouse.wheel(0, 360); await page.waitForTimeout(150); }
    assert.equal(await line.count(), 0); result.hidesOffscreenAnchor = true;
    await locateFirst(); await line.waitFor();
    const beforeZoom = await selectedPath().getAttribute('d');
    await frame.evaluate(() => window.Asc.editor.zoom(80)); await page.waitForTimeout(500); await line.waitFor();
    assert.notEqual(await selectedPath().getAttribute('d'), beforeZoom); result.followsZoom = true;
    await frame.evaluate(() => window.Asc.editor.sync_HideComment()); await page.waitForTimeout(300); await line.waitFor(); result.persistsWithoutSelectedComment = true;
    await page.getByRole('button', { name: '收起审查意见', exact: true }).click(); assert.equal(await line.count(), 0);
    await page.getByRole('button', { name: '显示审查意见', exact: true }).click(); await line.waitFor(); result.hideAndRestore = true;
    await page.getByRole('button', { name: '全屏编辑', exact: true }).click(); await page.waitForFunction(() => !!document.fullscreenElement); await line.waitFor();
    await page.screenshot({ path: '.local/office-links/连线-全屏.png', fullPage: true }); result.fullscreen = true;
    await page.getByRole('button', { name: '退出全屏', exact: true }).click();
    await frame.evaluate(() => { const api = window.Asc.editor; api.goToPage(0); const human = api.pluginMethod_GetAllComments().find(c => c.Data.UserName === '验收人工批注'); api.asc_selectComment(human.Id); api.asc_showComment(human.Id); });
    await page.waitForTimeout(600);
    assert.equal(await frame.evaluate(() => document.documentElement.hasAttribute('data-legal-comment-link')), false); result.humanCommentsKeepNativePopup = true;
    assert.equal(await frame.evaluate(() => getComputedStyle(document.getElementById('id-comments-popover').closest('.asc-window')).visibility), 'visible');
    await frame.evaluate(() => { const api = window.Asc.editor, ai = api.pluginMethod_GetAllComments().find(c => c.Data.Text.includes('原文段落：')); api.asc_selectComment(ai.Id); api.asc_showComment(ai.Id); });
    await line.waitFor(); result.nativeCommentSelectsExternalCard = true;
    await page.setViewportSize({ width: 980, height: 1000 }); await page.waitForTimeout(500); assert.equal(await line.count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); result.narrowLayout = true;
    await locateFirst();
    await page.screenshot({ path: '.local/office-links/连线-窄屏.png', fullPage: true });
    const final = await (await page.request.get(base + '/api/contracts/' + fixture.contractId)).json(); assert.equal(final.current_version_id, initial.current_version_id); result.documentUnchanged = true;
    assert.deepEqual(errors, []); result.errors = errors; result.passed = true;
  } finally {
    fs.writeFileSync('.local/office-links/' + (access.persistent ? 'persistent-browser-result.json' : 'browser-result.json'), JSON.stringify(result, null, 2));
    await page.screenshot({ path: '.local/office-links/连线-最后状态.png', fullPage: true }).catch(() => {});
    await browser.close();
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
