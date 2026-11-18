// Real AutoReview UI with deterministic API fixtures; never contacts production.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));

async function main() {
  const output = process.env.AUTO_REVIEW_QA_OUTPUT || 'D:/CodexData/NewFiles/auto-review-download-fix';
  const root = path.resolve(process.env.AUTO_REVIEW_QA_BUILD || path.join(output, 'build'));
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
  const checks = [], errors = [], original = Buffer.from('fictional-original-material');
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    const source = { id: 'material', filename: 'R7测算.xlsx', contract_id: 'source-contract', version_id: 'source-version', ingest_status: 'ready', role: 'reference' };
    const artifact = { id: 'failed-draft', batch_document_id: source.id, source_version_id: source.version_id, review_id: 'review', kind: 'tracked_revisions', filename: 'R7测算_自动修订.docx', status: 'report_only', error_message: '现有转换服务未生成可可靠修改的 DOCX，本文件仅提供报告', locatedFindingIds: [], unlocatedFindingIds: [], downloadUrl: null };
    const batch = { id: 'batch', source: 'dingtalk', status: 'partial', main_review_id: 'review', documents: [source], artifacts: [artifact], result: { title: '虚构钉钉审批' }, review: { status: 'completed', coverage: { readBlocks: 1, totalBlocks: 1 }, agentResult: { summary: '已核对测算表与合同金额。' } }, findings: [], events: [], activity: [] };
    await page.route(base + '/api/**', route => {
      const url = new URL(route.request().url()), endpoint = url.pathname.slice(4);
      if (endpoint === '/files/source-version') {
        assert.equal(url.searchParams.get('download'), '1');
        assert.equal(url.searchParams.has('variant'), false);
        return route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="original.xlsx"' }, body: original });
      }
      if (/\/artifacts\/(ready-draft|other-ready)\/download$/.test(endpoint)) return route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="draft.docx"' }, body: 'fictional-draft' });
      const data = endpoint === '/auth/session' ? { user: { id: 'fixture', displayName: '虚构法务', roles: ['admin'] }, csrf: 'fixture' }
        : endpoint === '/auto-review-batches/batch' ? batch : endpoint === '/auto-review-batches' ? [batch]
        : endpoint === '/auto-review-limits' ? { maxFiles: 20, maxFileBytes: 52428800, maxTotalBytes: 209715200 } : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(base + '/#/auto-review/batch');
    const row = page.locator('#auto-artifacts .artifact-list > article').first();
    await row.waitFor();
    // Exact screenshot symptom: a report-only material has no original download.
    assert.equal(await row.getByRole('link', { name: '下载原件', exact: true }).count(), 1, 'report-only material must offer its original download');
    assert.equal(await row.locator('b').innerText(), source.filename, 'do not label a nonexistent DOCX as a file');
    assert.doesNotMatch(await row.innerText(), /已自动修改 0 项|待核实 0 项/);
    assert.equal(await row.getByRole('link', { name: '在程序中审阅', exact: true }).count(), 0);
    assert.equal(await row.getByRole('link', { name: '查看原文', exact: true }).getAttribute('href'), '#/contracts/source-contract?version=source-version');
    const downloadEvent = page.waitForEvent('download');
    await row.getByRole('link', { name: '下载原件', exact: true }).click();
    const download = await downloadEvent, downloadPath = path.join(output, 'original.xlsx');
    assert.equal(await download.failure(), null); await download.saveAs(downloadPath);
    assert.deepEqual(fs.readFileSync(downloadPath), original);
    checks.push('report-only-original-download-bytes-and-frozen-version');
    const materials = page.locator('.auto-docs');
    assert.equal(await materials.getByRole('link', { name: '下载原件', exact: true }).count(), 1);
    // Re-run the screenshot's complete scenario after the minimal reproduction:
    // two source materials, one failed draft, one ready draft and one report.
    batch.documents.push({ ...source, id: 'other-material', filename: '运输协议.docx', contract_id: 'other-contract', version_id: 'other-source' });
    batch.artifacts.push({ ...artifact, id: 'other-ready', batch_document_id: 'other-material', source_version_id: 'other-source', status: 'ready', filename: '运输协议_自动修订.docx', version_id: 'other-draft', error_message: null, downloadUrl: '/api/auto-review-batches/batch/artifacts/other-ready/download', locatedFindingIds: ['edit'] });
    batch.artifacts.push({ id: 'report', kind: 'report', status: 'ready', review_id: 'review', filename: '审查报告.html', downloadUrl: '/api/auto-review-batches/batch/artifacts/report/download' });
    await page.reload(); await row.waitFor();
    assert.equal(await page.locator('#auto-artifacts .artifact-list > article').count(), 3);
    assert.match(await page.locator('#auto-artifacts .panel-heading').innerText(), /2 份产物可下载（不含原件）/);
    assert.equal(await materials.getByRole('link', { name: '下载原件', exact: true }).count(), 2);
    assert.equal(await row.getByRole('link', { name: '下载原件', exact: true }).count(), 1);
    const readyDownloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载带修订 DOCX', exact: true }).click();
    const readyDownload = await readyDownloadEvent;
    assert.equal(await readyDownload.failure(), null);
    await readyDownload.saveAs(path.join(output, 'ready-draft.docx'));
    assert.equal(fs.readFileSync(path.join(output, 'ready-draft.docx'), 'utf8'), 'fictional-draft');
    checks.push('two-materials-report-and-mixed-draft-statuses');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await row.getByRole('link', { name: '下载原件', exact: true }).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    checks.push('desktop-and-mobile-source-actions');
    artifact.status = 'ready'; artifact.version_id = 'draft-version'; artifact.id = 'ready-draft'; artifact.downloadUrl = '/api/auto-review-batches/batch/artifacts/ready-draft/download';
    artifact.locatedFindingIds = ['finding']; artifact.unlocatedFindingIds = ['uncertain']; artifact.error_message = null;
    await page.reload(); await row.getByRole('link', { name: '在程序中审阅', exact: true }).waitFor();
    assert.equal(await row.locator('b').innerText(), artifact.filename);
    assert.match(await row.innerText(), /已自动修改 1 项，待核实 1 项/);
    assert.equal(await row.getByRole('link', { name: '下载带修订 DOCX', exact: true }).count(), 1);
    checks.push('ready-draft-actions-preserved');
    artifact.kind = 'annotated_comments'; artifact.filename = 'R7测算_批注建议稿.docx';
    artifact.details = { outputMode: 'comments_only', editCount: 0 };
    await page.reload(); await row.getByRole('link', { name: '查看批注', exact: true }).waitFor();
    assert.match(await row.innerText(), /已定位 1 条批注，位置待核实 1 条；正文未自动替换/);
    assert.equal(await row.getByRole('link', { name: '下载批注版', exact: true }).count(), 1);
    assert.equal(await row.getByRole('link', { name: '下载带修订 DOCX', exact: true }).count(), 0);
    assert.equal(await row.getByRole('link', { name: '查看批注', exact: true }).getAttribute('href'), '#/auto-review/batch/artifacts/ready-draft');
    const commentsDownloadEvent = page.waitForEvent('download');
    await row.getByRole('link', { name: '下载批注版', exact: true }).click();
    const commentsDownload = await commentsDownloadEvent;
    assert.equal(await commentsDownload.failure(), null);
    await commentsDownload.saveAs(path.join(output, 'comments-only.docx'));
    assert.equal(fs.readFileSync(path.join(output, 'comments-only.docx'), 'utf8'), 'fictional-draft');
    assert.equal(await page.getByRole('link', { name: '下载带修订 DOCX', exact: true }).count(), 1);
    assert.match(await page.locator('#auto-artifacts').innerText(), /AI 默认只提供批注，原文由法务调整/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    checks.push('comments-only-download-labels-and-legacy-revision-coexist');
    artifact.status = 'report_only'; artifact.downloadUrl = null; artifact.version_id = null;
    source.ingest_status = 'failed'; source.error_message = '附件读取失败';
    await page.reload(); await row.waitFor(); assert.match(await row.innerText(), /未读取|读取失败/);
    assert.equal(await row.getByRole('link', { name: '下载原件', exact: true }).count(), 1);
    checks.push('unread-material-not-mislabeled-reviewed');
    // Missing source metadata must never create an invalid download link.
    batch.documents = []; await page.reload(); await row.waitFor();
    assert.equal(await row.getByRole('link', { name: '下载原件', exact: true }).count(), 0);
    checks.push('missing-source-no-invalid-links');
    assert.deepEqual(errors, []);
    const result = { passed: true, checks, errors, apiFixture: true };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message); console.log(JSON.stringify({ passed: false, checks, errors })); process.exitCode = 1;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
