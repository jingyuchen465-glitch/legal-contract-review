// Production UI in a real browser; all business requests use a local fixture.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve('frontend/dist'), output = path.resolve('.local/review-performance');
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://fixture').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') || file.endsWith('.mjs') ? 'application/javascript' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') console.error(e.text()); });
    page.on('requestfailed', req => { if (!req.url().includes('socket.io')) console.error(req.url(), req.failure()); });
    const now = Date.now(), at = ms => new Date(now + ms).toISOString();
    const version = { id: 'version', version_no: 1, kind: 'contract', filename: '虚构进度验收.docx', parsed: { blocks: [{ id: 'b1', text: '验收合格后付款。' }] } };
    const review = { id: 'review', version_id: version.id, isCurrent: true, status: 'running', stage: 'reviewing', progress: 68, created_at: at(-120000), updated_at: at(-10000), snapshot: { rules: [] }, coverage: {}, findings: [], steps: [{ stage: 'reviewing', created_at: at(-120000) }, { stage: 'review_plan', details: { totalBatches: 7, concurrency: 3 } }, ...[3, 1, 2].map(i => ({ stage: 'review_batch', status: 'completed', details: { chunkIndex: 1, ruleBatchIndex: i, chunkCount: 1, ruleBatchCount: 7 } }))] };
    const contract = { id: 'contract', title: '【虚构】预审进度验收', number: 'PROGRESS-QA', current_version_id: version.id, current_review_id: review.id, legal_status: 'pending_review', classification: { typeId: 'procurement', confirmed: true, perspectiveConfirmed: true, versionId: version.id }, versions: [version], reviews: [review], background: {}, decisions: [], returns: [], archives: [] };
    await page.route('**/socket.io/**', route => route.abort());
    await page.route(base + '/api/**', route => {
      const endpoint = new URL(route.request().url()).pathname.slice(4);
      const data = endpoint === '/auth/session' ? { user: { id: 'fixture', displayName: '虚构验收', roles: ['admin'] }, csrf: 'fixture' } : endpoint === '/catalog' ? { categories: [], tags: [] } : endpoint === '/contracts/contract' ? contract : endpoint === '/reviews/review' ? review : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(base + '/#/contracts/contract');
    const status = page.getByRole('status');
    try { await status.getByText(/已完成 3\/7 批/).waitFor({ timeout: 10000 }); }
    catch (error) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); console.error(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), errors })); throw error; }
    assert.match(await status.innerText(), /预计还需约/);
    assert.ok(!(await status.innerText()).includes('68%'));
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await status.evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    // Historical running jobs have no plan, and may still report a stage percentage.
    review.steps = review.steps.filter(s => s.stage !== 'review_plan');
    for (const s of review.steps.filter(s => s.stage === 'review_batch')) { s.details.chunkCount = 3; s.details.ruleBatchCount = 11; }
    await status.getByRole('button', { name: '刷新进度' }).click();
    await status.getByText(/已完成 3\/33 批/).waitFor();
    // Early runs have no throughput estimate yet.
    review.steps = review.steps.slice(0, 1);
    await status.getByRole('button', { name: '刷新进度' }).click();
    await status.getByText('正在准备审查批次').waitFor();
    assert.ok(!(await status.innerText()).includes('预计还需约'));
    assert.deepEqual(errors, []);
    const result = { passed: true, realBrowser: true, apiFixture: true, desktopAndMobile: true, legacyRuns: true, checkedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(output, 'ui-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
