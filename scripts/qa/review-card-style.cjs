// Local fictional DOCX only. Exercises the same workspace used by both routes.
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), assert = require('node:assert/strict'), AdmZip = require('adm-zip');
const output = '.local/review-card-style'; fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true }), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(15000);
  async function exportDocx() {
    const done = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 DOCX', exact: true }).click();
    const download = await done; await download.saveAs(output + '/export.docx'); return new AdmZip(fs.readFileSync(output + '/export.docx'));
  }
  try {
    await page.goto('http://127.0.0.1:8080/#/review-preview');
    await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.change').length === 2);
    const change = page.locator('.review-margin-card.change').first(), comment = page.locator('.review-margin-card.comment').first();
    assert.equal(await change.locator('.review-margin-avatar').count(), 1, '正文修订必须复用 P2 的头像作者布局');
    assert.ok((await change.locator('time').innerText()).trim(), '正文修订须显示文档中的修订时间');
    const colors = await page.evaluate(() => ['change','comment'].map(kind => { const e=document.querySelector('.review-margin-card.'+kind), clone=e.cloneNode(true);clone.classList.remove('active');e.parentNode.append(clone);const s=getComputedStyle(clone),result=[s.backgroundColor,s.borderLeftColor];clone.remove();return result; }));
    assert.deepEqual(colors[0], colors[1], '两类卡片共用 P2 配色');
    assert.equal(await change.locator('header button').count(), 0, '卡片顶部不再提供勾叉');
    await change.locator('footer').getByRole('button', { name: '接受此处修订', exact: true }).waitFor();
    assert.equal(await change.locator('footer').getByRole('button', { name: '接受此处修订', exact: true }).innerText(), '接受修订');
    await change.locator('footer').getByRole('button', { name: '拒绝此处修订', exact: true }).waitFor();
    checks.push('same-avatar-author-date-color-and-footer-layout');
    await page.screenshot({ path: output + '/unified-cards.png', fullPage: true });
    const initial = await exportDocx(), initialXml = initial.readAsText('word/document.xml');
    await change.getByRole('button', { name: '接受此处修订', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.change').length === 1);
    await page.getByRole('status').filter({ hasText: '已接受修订' }).waitFor();
    const accepted = await exportDocx();assert.equal((accepted.readAsText('word/document.xml').match(/<w:ins\b/g)||[]).length, 1);
    assert.match(accepted.readAsText('word/document.xml'), /乙方迁仓前应取得甲方书面同意/);
    await page.getByRole('button', { name: '撤销此次操作', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.change').length === 2);
    assert.equal((await exportDocx()).readAsText('word/document.xml'), initialXml);
    checks.push('accept-applies-body-and-feedback-undo-restores-revision');
    await page.locator('.review-margin-card.change').first().getByRole('button', { name: '拒绝此处修订', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已拒绝修订' }).waitFor();
    await page.getByRole('button', { name: '撤销此次操作', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.change').length === 2);
    checks.push('reject-has-feedback-and-undo');
    await page.locator('.review-margin-card.comment').first().getByRole('button', { name: '标记为已处理', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.comment.resolved').length === 1);
    assert.equal(await page.locator('.review-margin-card.comment').count(), 10);
    assert.equal((await exportDocx()).readAsText('word/document.xml'), initialXml);
    checks.push('comment-mark-handled-retains-card-without-changing-body');
    await page.getByRole('button', { name: '关闭批注状态提示', exact: true }).click();
    await page.evaluate(() => { const api=document.querySelector('.margin-review').__vueParentComponent.exposed.getEditor().ui.trackChanges;window.savedAccept=api.acceptAsync;api.acceptAsync=async()=>({success:false,message:'测试接受失败'}); });
    await page.locator('.review-margin-card.change').first().getByRole('button', { name: '接受此处修订', exact: true }).click();
    await page.getByRole('alert').filter({hasText:'测试接受失败'}).waitFor();assert.equal(await page.locator('.margin-comment-feedback').count(),0);assert.equal(await page.locator('.review-margin-card.change').count(),2);
    await page.evaluate(() => { document.querySelector('.margin-review').__vueParentComponent.exposed.getEditor().ui.trackChanges.acceptAsync=window.savedAccept;delete window.savedAccept; });
    await page.getByRole('button', {name:'关闭错误提示',exact:true}).click();
    await page.locator('.review-margin-card.change').first().getByRole('button', { name: '接受此处修订', exact: true }).click();
    await page.getByRole('button', { name: '撤销此次操作', exact: true }).waitFor();
    await page.locator('.ts-para').first().click();await page.keyboard.press('End');await page.keyboard.type('后续编辑');
    await page.waitForFunction(()=>document.querySelector('.margin-editor-host')?.textContent.includes('后续编辑'));
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.margin-comment-feedback button')).some(b=>b.textContent==='撤销此次操作'));
    assert.equal(await page.getByRole('button', { name: '撤销此次操作', exact: true }).count(),0,'后续编辑后不能以撤销修订之名撤销其他编辑');
    checks.push('failed-decision-has-no-success-feedback-and-later-edits-invalidate-specific-undo');
    assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: true, checks }));
    fs.writeFileSync(output + '/result.json', JSON.stringify({ passed: true, checks, errors }, null, 2));
  } catch (e) { await page.screenshot({ path: output + '/failure.png', fullPage: true }).catch(()=>{});throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
