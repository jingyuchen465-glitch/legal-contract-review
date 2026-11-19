// Built Vue UI in a real browser. All contract/API data is an in-memory fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const PDFDocument = require('pdfkit');

async function main() {
  const root = path.resolve('frontend/dist'), output = path.resolve(process.env.NAVIGATION_QA_OUTPUT || '.local/evidence-navigation');
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://fixture').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') || file.endsWith('.mjs') ? 'application/javascript' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1032 } });
  page.setDefaultTimeout(5000);
  const errors = [], checks = [];
  let passed = false;
  page.on('pageerror', error => errors.push(error.message));
  const makeVersion = id => ({ id, version_no: id === 'main' ? 1 : 2, filename: `虚构定位验收-${id}.docx`, parsed: { blocks: Array.from({ length: 60 }, (_, i) => ({ id: 'b' + (i + 1), text: `${id} 第${i + 1}条：双方应核实交付期限、验收条件及付款安排。` })) } });
  const main = makeVersion('main'), attachment = makeVersion('attachment');
  const evidence = (v, i) => ({ versionId: v.id, blockId: 'b' + i, quote: v.parsed.blocks[i - 1].text });
  const finding = (id, title, citations, extra = {}) => ({ id, title, reason: '虚构审查依据', suggestion: '请双方确认具体条款。', severity: 'high', kind: 'clause', check_status: 'fail', revision: 0, evidence: citations, legal_refs: [], ...extra });
  const findings = [finding('payment', '付款与验收条件', [evidence(main, 4), evidence(main, 45), evidence(attachment, 40)]), finding('missing', '缺少保密条款', []), finding('rejected', '已驳回的意见', [evidence(main, 55)], { disposition: { action: 'reject' } })];
  const review = { id: 'review', version_id: main.id, status: 'completed', created_at: '2026-11-10T00:00:00Z', snapshot: { jointGroup: { documents: [{ versionId: main.id }, { versionId: attachment.id }] } }, agent_result: { summary: '虚构定位验收', limitations: [] }, coverage: {}, findings, documents: [{ versionId: attachment.id, version: attachment }] };
  review.snapshot = {};
  const attachmentReview = { ...review, id: 'attachment-review', version_id: attachment.id };
  const pdf = { id: 'pdf', version_no: 3, filename: '虚构分页验收.pdf', parsed: { format: 'pdf', blocks: [1, 2].map(i => ({ id: 'p' + i, page: i, text: 'Fixture page ' + i, bbox: [50, 50, 200, 30], width: 612, height: 792 })) } };
  const pdfFinding = finding('pdf-finding', 'PDF 付款条件', pdf.parsed.blocks.map(b => ({ versionId: pdf.id, blockId: b.id, quote: b.text })));
  const pdfReview = { ...review, id: 'pdf-review', version_id: pdf.id, findings: [pdfFinding] };
  const pdfBytes = await new Promise(resolve => {
    const doc = new PDFDocument(), chunks = [];
    doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.text('Fixture page 1'); doc.addPage().text('Fixture page 2'); doc.end();
  });
  const contract = { id: 'contract', title: '【虚构】意见与原文跳转验收', number: 'NAVIGATION-QA', legal_status: 'pending_review', revision: 1, current_version_id: main.id, current_review_id: review.id, versions: [main, attachment, pdf], reviews: [review, attachmentReview, pdfReview] };
  await page.route('**/socket.io/**', route => route.abort());
  await page.route(base + '/api/**', async route => {
    const endpoint = new URL(route.request().url()).pathname.slice(4);
    assert.equal(route.request().method(), 'GET', 'navigation must not write business data');
    if (endpoint === '/files/pdf') {
      await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ contentType: 'application/pdf', body: pdfBytes });
    }
    const data = endpoint === '/auth/session' ? { user: { id: 'fixture', displayName: '虚构验收', roles: ['admin'] }, csrf: 'fixture' } : endpoint === '/contracts/contract' ? contract : endpoint === '/reviews/review' ? review : endpoint === '/reviews/attachment-review' ? attachmentReview : endpoint === '/reviews/pdf-review' ? pdfReview : [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  const reader = () => page.locator('.document-view');
  async function resetScroll() {
    await reader().evaluate(el => { const previous = el.style.scrollBehavior; el.style.scrollBehavior = 'auto'; el.scrollTop = el.scrollHeight; el.style.scrollBehavior = previous; });
  }
  async function atBlock(id, message) {
    await page.waitForFunction(id => {
      const root = document.querySelector('.document-view'), target = root?.querySelector(`[data-block-id="${id}"] .original-text`);
      if (!root || !target) return false;
      const r = root.getBoundingClientRect(), t = target.getBoundingClientRect();
      const atEnd = root.scrollTop >= root.scrollHeight - root.clientHeight - 2;
      return t.top >= r.top + 40 && (t.top < r.top + 170 || atEnd) && t.bottom < r.bottom;
    }, id, { timeout: 4000 }).catch(error => { throw new Error(message + ': ' + error.message); });
    checks.push(message);
  }
  try {
    await page.goto(base + '/#/contracts/contract');
    const card = page.locator('.agent-finding').filter({ has: page.getByRole('heading', { name: '付款与验收条件', exact: true }) });
    await card.waitFor();
    await resetScroll();
    await card.locator('blockquote').nth(0).click();
    await atBlock('b4', 'first citation scrolls the left reader');
    // Once navigation finishes, polling must not replay it while the lawyer
    // scrolls elsewhere. Observe both real wheel input and the native scrollbar.
    await page.waitForTimeout(700);
    await reader().evaluate(el => {
      const original = el.scrollTo.bind(el);
      el.__navigationCalls = 0;
      el.scrollTo = (...args) => { el.__navigationCalls++; return original(...args); };
    });
    async function staysAfterPolling(name) {
      const before = await reader().evaluate(el => ({ top: el.scrollTop, calls: el.__navigationCalls }));
      for (let i = 0; i < 2; i++) await page.waitForResponse(r => new URL(r.url()).pathname === '/api/reviews/review');
      await page.waitForTimeout(500);
      const after = await reader().evaluate(el => ({ top: el.scrollTop, calls: el.__navigationCalls }));
      assert.equal(after.calls, before.calls, name + ': background refresh must not replay navigation');
      assert.ok(Math.abs(after.top - before.top) <= 2, name + ': manual reading position must remain stable');
      checks.push(name);
    }
    const bounds = await reader().boundingBox();
    await page.mouse.move(bounds.x + 160, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 1100); await page.waitForTimeout(500);
    assert.ok(await reader().evaluate(el => el.scrollTop > 700));
    await staysAfterPolling('wheel scrolling stays in place across two refreshes');
    const thumb = await reader().evaluate(el => {
      const r = el.getBoundingClientRect(), track = el.clientHeight;
      const height = Math.max(20, track * el.clientHeight / el.scrollHeight);
      return { x: r.right - (el.offsetWidth - el.clientWidth) / 2, y: r.top + (track - height) * el.scrollTop / (el.scrollHeight - el.clientHeight) + height / 2, top: el.scrollTop };
    });
    await page.mouse.move(thumb.x, thumb.y); await page.mouse.down();
    await page.mouse.move(thumb.x, thumb.y + 140, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(300);
    assert.ok(await reader().evaluate((el, before) => el.scrollTop > before + 100, thumb.top), 'native scrollbar drag must move the reader');
    await staysAfterPolling('scrollbar dragging stays in place across two refreshes');
    await resetScroll();
    await card.locator('blockquote').nth(0).click();
    await atBlock('b4', 'repeat click repositions the same finding');
    await card.locator('blockquote').nth(1).click();
    await atBlock('b45', 'second citation navigates to its own clause');
    await resetScroll();
    await card.getByRole('heading', { name: '付款与验收条件', exact: true }).click();
    await atBlock('b4', 'title navigates to the primary clause');
    await resetScroll();
    await card.getByRole('heading', { name: '付款与验收条件', exact: true }).click();
    await atBlock('b4', 'repeated title click repositions the reader');
    await card.locator('blockquote').nth(1).press('Enter');
    await atBlock('b45', 'keyboard activates the selected citation');
    await card.getByRole('button', { name: '付款与验收条件', exact: true }).press('Space');
    await atBlock('b4', 'keyboard activates the title');
    // Read-only controls must not bubble into title/card navigation.
    await resetScroll();
    await card.getByRole('button', { name: '认可意见', exact: true }).click();
    await page.getByRole('dialog', { name: '认可审查意见', exact: true }).waitFor();
    assert.ok(await reader().evaluate(el => el.scrollTop > 1000));
    await page.getByRole('dialog').getByRole('button', { name: 'Close this dialog' }).click();
    checks.push('review action does not trigger navigation');
    // Main report retains citations to another material; opening it must navigate
    // after the keyed DocumentView mounts, even before any subsequent click.
    await card.locator('blockquote').nth(2).click();
    await atBlock('b40', 'cross-material citation locates after reader mounts');
    assert.equal(await page.getByLabel('当前材料').inputValue(), attachment.id);
    await card.getByRole('heading', { name: '付款与验收条件', exact: true }).click();
    await atBlock('b40', 'title prefers a citation in the current material');
    await page.getByLabel('当前材料').selectOption('main');
    await page.getByRole('heading', { name: '缺少保密条款', exact: true }).click();
    await page.waitForFunction(() => { const r = document.querySelector('.document-view').getBoundingClientRect(), t = document.querySelector('.unanchored-notes').getBoundingClientRect(); return t.top >= r.top && t.top < r.bottom; });
    checks.push('missing clause navigates to the unanchored notes');
    await page.getByRole('heading', { name: '已驳回的意见', exact: true }).click();
    await atBlock('b55', 'rejected finding can still locate its source');
    await page.goto(base + '/#/contracts/contract/history/review');
    const historicalCard = page.locator('.agent-finding').first();
    await historicalCard.locator('blockquote').nth(1).click();
    await atBlock('b45', 'historical report locates the clicked citation');
    await resetScroll();
    await historicalCard.locator('blockquote').nth(1).click();
    await atBlock('b45', 'historical report supports repeated navigation');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.goto(base + '/#/contracts/contract');
    await page.getByLabel('当前材料').selectOption('pdf');
    const pdfCard = page.locator('.agent-finding').filter({ hasText: 'PDF 付款条件' });
    await pdfCard.locator('blockquote').nth(1).click();
    await page.waitForFunction(() => document.querySelector('.reader-pager b')?.textContent === '02' && !document.querySelector('.reader-loading'));
    checks.push('PDF citation survives asynchronous document loading');
    await page.locator('.reader-pager button').first().click();
    await page.waitForFunction(() => document.querySelector('.reader-pager b')?.textContent === '01');
    await pdfCard.locator('blockquote').nth(1).click();
    await page.waitForFunction(() => document.querySelector('.reader-pager b')?.textContent === '02');
    checks.push('repeated PDF citation navigates back to its own page');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('当前材料').selectOption('main');
    await card.locator('blockquote').nth(1).click();
    await atBlock('b45', 'mobile citation scrolls the document reader');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    await page.screenshot({ path: path.join(output, 'last-state.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(output, 'browser-result.json'), JSON.stringify({ passed, checks, errors }, null, 2));
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ passed: true, checks }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
