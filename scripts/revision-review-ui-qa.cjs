// Browser regression using fictional data; no live contract or model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));

async function main() {
  const root = path.resolve('frontend/dist'), output = path.resolve('.local/revision-review-qa');
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://fixture').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') console.error('browser:', entry.text()); });
  page.on('requestfailed', request => { if (!request.url().includes('socket.io')) console.error('request failed:', request.url(), request.failure()); });
  const version = { id: 'current', contract_id: 'fixture', version_no: 4, filename: '【虚构】复核改稿.docx', parsed: { blocks: Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, text: `第${i + 1}条：乙方应按双方确认的日期交付，并保留履约凭证。` })) } };
  const evidence = { versionId: version.id, blockId: 'b45', quote: version.parsed.blocks[45].text };
  const baseline = { reviewId: 'previous-review', versionNo: 2, findings: [{ id: 'resolved', title: '原交付日期不明确' }, { id: 'accepted', title: '原责任上限建议', disposition: { action: 'reject', reason: '本案保留双方已确认的责任分配。' } }] };
  const findings = [{ id: 'new-finding', title: '验收凭证需补充', check_status: 'uncertain', severity: 'medium', kind: 'uncertain', reason: '上轮未核实验收凭证。', suggestion: '', evidence: [evidence], legal_refs: [] }];
  const report = { summary: '交付问题已解决，保留法务原处理；补充一项待核实事项。', limitations: ['工程模拟，不验证法律质量。'], findings: [{ ...findings[0], status: 'uncertain' }], revisionReview: { baselineReviewId: baseline.reviewId, items: [{ previousFindingId: 'resolved', status: 'resolved', reason: '交付日期已落实。', evidence: [evidence], findingIndexes: [] }, { previousFindingId: 'accepted', status: 'accepted', reason: '原处理适用条件未变。', evidence: [], findingIndexes: [] }], newFindings: [{ findingIndex: 0, origin: 'previously_missed', reason: '该条款上轮已存在，属于上轮漏检，并非本次修改引入。' }] } };
  const review = { id: 'review', version_id: version.id, engine: 'harness-v1', status: 'completed', created_at: '2026-11-10T01:00:00Z', snapshot: { revisionBaseline: baseline }, agent_result: report, findings, coverage: {}, documents: [] };
  const contract = { id: 'fixture', title: '【虚构】修改复核验收', number: 'REVISION-QA', legal_status: 'pending_review', revision: 1, current_version_id: version.id, current_review_id: review.id, versions: [version], reviews: [review] };
  await page.route('**/socket.io/**', route => route.abort());
  await page.route(base + '/api/**', route => {
    const endpoint = new URL(route.request().url()).pathname.slice(4);
    assert.equal(route.request().method(), 'GET');
    const value = endpoint === '/auth/session' ? { user: { id: 'human', displayName: '虚构验收', roles: ['admin'] }, csrf: 'fixture' } : endpoint === '/contracts/fixture' ? contract : endpoint === '/reviews/review' ? review : [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  try {
    await page.goto(base + '/#/contracts/fixture');
    const section = page.getByRole('region', { name: '修改复核结果' });
    await section.waitFor();
    assert.match(await section.innerText(), /已解决 1 · 保留法务处理 1 · 仍待处理 0 · 新增问题 1/);
    assert.match(await section.innerText(), /上轮漏检 · 验收凭证需补充/);
    checks.push('prior resolutions and newly missed issues are visible separately');
    await section.locator('summary').filter({ hasText: '原交付日期不明确' }).click();
    await section.getByRole('button', { name: /定位当前原文/ }).click();
    await page.waitForFunction(() => {
      const root = document.querySelector('.document-view'), block = root?.querySelector('[data-block-id="b45"]');
      return root && block && block.getBoundingClientRect().top >= root.getBoundingClientRect().top && block.getBoundingClientRect().top < root.getBoundingClientRect().bottom;
    });
    checks.push('resolved issue cites and scrolls to current text without a current risk finding');
    await section.locator('summary').filter({ hasText: '原责任上限建议' }).click();
    assert.match(await section.innerText(), /原法务处理：本案保留双方已确认的责任分配/);
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    checks.push('mobile layout has no page overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base + '/#/contracts/fixture/history/review');
    await section.waitFor();
    assert.match(await section.innerText(), /上轮漏检/);
    checks.push('historical report retains revision comparison');
    report.findings = []; report.revisionReview.newFindings = []; review.findings = [];
    report.summary = '本轮修改已落实，未发现新增实质风险。';
    await page.goto(base + '/#/contracts/fixture'); await page.reload();
    await section.waitFor();
    assert.match(await section.innerText(), /未列出仍待处理或新增问题/);
    assert.equal(await page.locator('.agent-finding').count(), 0);
    checks.push('zero-risk revision completes without a fabricated finding');
    delete report.revisionReview; delete review.snapshot.revisionBaseline;
    await page.reload();
    await page.getByRole('heading', { name: '审查概览' }).waitFor();
    assert.equal(await section.count(), 0);
    checks.push('older reports without revision fields still render');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(JSON.stringify({ checks, errors, output }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 3500) }));
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    throw error;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
