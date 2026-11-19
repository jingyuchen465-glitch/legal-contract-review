// Real browser and production-built UI, with an in-memory API fixture.
// No production contract, decision, model or learning task is written.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ids = { contract: '00000000-0000-4000-8000-000000000201', version: '00000000-0000-4000-8000-000000000202', review: '00000000-0000-4000-8000-000000000203', finding: '00000000-0000-4000-8000-000000000204' };
const output = '.local/decision-confirmation'; fs.mkdirSync(output, { recursive: true });
async function main() {
  const root = path.resolve('frontend/dist');
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://fixture').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') || file.endsWith('.mjs') ? 'application/javascript' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = process.env.DECISION_QA_BASE || 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(5000);
  const result = { apiFixture: true, realBrowser: true, liveAssets: !!process.env.DECISION_QA_BASE, errors: [], decisionRequests: 0 };
  const version = { id: ids.version, version_no: 4, kind: 'contract', filename: '虚构验收.docx', source_action: 'upload', parsed: { blocks: [{ id: 'b1', text: '验收合格后支付价款。' }] } };
  const finding = { id: ids.finding, rule_id: 'payment', title: '付款条件', reason: '需核对验收安排', suggestion: '明确付款条件', kind: 'clause', severity: 'medium', check_status: 'fail', revision: 0, evidence: [{ blockId: 'b1', quote: '验收合格后支付价款。' }], legal_refs: [], disposition: null };
  const review = { id: ids.review, version_id: ids.version, isCurrent: true, status: 'completed', progress: 100, snapshot: { rules: [], skills: [], reviewMode: 'formal' }, coverage: { complete: true, totalRules: 1, checkedRules: 1 }, findings: [finding], steps: [], decision: null };
  const contract = { id: ids.contract, title: '【虚构浏览器验收】最终结论前置确认', number: 'DECISION-UI-QA', source: 'upload', legal_status: 'pending_review', revision: 1, current_version_id: ids.version, current_review_id: ids.review, classification: { typeId: 'procurement', tags: [], confirmed: false, perspectiveConfirmed: false, versionId: ids.version }, background: { ourEntity: '虚构甲方', perspective: '采购方', purpose: '虚构工程验收' }, versions: [version], reviews: [review], decisions: [], returns: [], archives: [] };
  let staleClassification = false;
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/socket.io/**', route => route.abort());
  await page.route(base + '/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), endpoint = url.pathname.slice(4), method = req.method();
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (endpoint === '/auth/session') return send({ user: { id: 'fixture', displayName: '虚构验收', roles: ['admin'] }, csrf: 'fixture' });
    if (endpoint === '/catalog') return send({ categories: [{ id: 'business', name: '交易合同', types: [{ id: 'procurement', name: '采购合同' }] }], tags: [] });
    if (endpoint === '/contracts/' + ids.contract && method === 'GET') return send(contract);
    if (endpoint === '/reviews/' + ids.review && method === 'GET') return send(review);
    if (endpoint === '/reviewers') return send([]);
    if (endpoint === '/review-plan') return send({ available: true, rules: [], packs: [], skillPacks: [] });
    if (endpoint === '/contracts/' + ids.contract + '/classification' && method === 'PUT') {
      const value = req.postDataJSON(); assert.equal(value.perspectiveConfirmed, true);
      Object.assign(contract.classification, value, { confirmed: true, versionId: ids.version }); contract.revision++;
      return send({ reviewId: ids.review, rerun: false, archive: { status: 'not_requested' } });
    }
    if (endpoint === '/reviews/' + ids.review + '/findings/' + ids.finding + '/disposition' && method === 'PUT') {
      finding.disposition = req.postDataJSON(); finding.revision++; return send({ ok: true });
    }
    if (endpoint === '/reviews/' + ids.review + '/decision' && method === 'POST') {
      result.decisionRequests++;
      if (staleClassification) { contract.classification.confirmed = false; staleClassification = false; }
      if (!contract.classification.confirmed || !contract.classification.perspectiveConfirmed || contract.classification.versionId !== ids.version) return send({ code: 'CLASSIFICATION_UNCONFIRMED', message: '请确认当前版本分类及我方立场' }, 409);
      if (!finding.disposition || finding.disposition.action === 'needs_information') return send({ code: 'UNRESOLVED_FINDINGS', message: '仍有未处理风险或待补充信息' }, 409);
      review.decision = { ...req.postDataJSON(), id: 'fixture-decision', created_at: new Date().toISOString() }; contract.legal_status = 'finalized'; return send(review.decision, 201);
    }
    if (endpoint === '/learning-settings') return send({ enabled: true });
    if (endpoint === '/learning-tasks') return send([]);
    result.errors.push('Unexpected fixture API: ' + method + ' ' + endpoint); return send({ message: 'Unexpected fixture API' }, 500);
  });
  try {
    await page.goto(base + '/#/contracts/' + ids.contract);
    await page.getByRole('button', { name: '确认最终结论', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认最终法务结论', exact: true });
    const submit = dialog.getByRole('button', { name: '确认并保存结论', exact: true });
    if (await submit.isEnabled()) {
      await submit.click(); await page.getByText('请确认当前版本分类及我方立场', { exact: true }).waitFor(); result.originalLateErrorReproduced = true;
    }
    assert.equal(await dialog.getByRole('button', { name: '去确认分类与立场', exact: true }).count(), 1, 'classification error must offer a direct recovery action before submission');
    assert.equal(await submit.isDisabled(), true); assert.equal(result.decisionRequests, 0);
    await dialog.getByLabel(/^理由/).fill('虚构判断理由，跳转确认时应保留');
    await dialog.getByRole('button', { name: '去确认分类与立场', exact: true }).click();
    const context = page.getByRole('dialog', { name: '分类与业务背景', exact: true });
    await context.getByLabel('已核实本版本合同类型、我方主体与交易立场').check();
    await context.getByRole('button', { name: '确认分类及立场', exact: true }).click(); await context.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '确认最终结论', exact: true }).click();
    assert.equal(await dialog.getByLabel(/^理由/).inputValue(), '虚构判断理由，跳转确认时应保留');
    assert.equal(await submit.isDisabled(), true);
    await dialog.getByRole('button', { name: '去处理审查意见', exact: true }).click();
    const opinion = page.getByRole('dialog', { name: '条款意见与法务复核', exact: true });
    await opinion.getByRole('button', { name: '保存复核意见', exact: true }).click(); await opinion.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '确认最终结论', exact: true }).click(); assert.equal(await submit.isEnabled(), true);
    result.classificationAndFindingRecovery = true;
    // A remote change between opening and submitting must retain the draft and
    // restore the recovery action, rather than throw an unhandled UI error.
    staleClassification = true; await submit.click();
    await dialog.getByRole('button', { name: '去确认分类与立场', exact: true }).waitFor();
    assert.equal(await submit.isDisabled(), true); assert.equal(await dialog.getByLabel(/^理由/).inputValue(), '虚构判断理由，跳转确认时应保留');
    result.concurrentChangeRecovery = true;
    await page.setViewportSize({ width: 720, height: 980 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: output + '/decision-prerequisites.png', fullPage: true });
    await dialog.getByRole('button', { name: '去确认分类与立场', exact: true }).click();
    await context.getByLabel('已核实本版本合同类型、我方主体与交易立场').check();
    await context.getByRole('button', { name: '确认分类及立场', exact: true }).click(); await context.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '确认最终结论', exact: true }).click();
    await dialog.getByLabel(/^最终结论/).selectOption('conditional');
    assert.equal(await dialog.getByLabel(/^条件/).getAttribute('required'), '');
    await dialog.getByLabel(/^条件/).fill('虚构条件：验收记录确认后付款。');
    await submit.click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: '合同经验整理', exact: true }).waitFor();
    assert.equal(review.decision.outcome, 'conditional'); assert.match(review.decision.reason, /跳转确认时应保留/);
    result.successfulDecisionAfterRecovery = true;
    assert.deepEqual(result.errors, []); result.passed = true; result.checkedAt = new Date().toISOString();
  } finally {
    await page.screenshot({ path: output + '/last-state.png', fullPage: true }).catch(() => {});
    fs.writeFileSync(output + '/last-state.txt', await page.locator('body').innerText());
    fs.writeFileSync(output + (process.env.DECISION_QA_BASE ? '/live-result.json' : '/browser-result.json'), JSON.stringify(result, null, 2));
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
