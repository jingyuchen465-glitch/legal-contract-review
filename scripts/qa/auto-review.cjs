// Real API/database/browser acceptance with fictional contracts and a bounded
// Harness tool fixture. Run through scripts/test-agent.mjs (disposable Postgres).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { randomUUID } = require('node:crypto'), AdmZip = require('adm-zip');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const pilot = name => require(path.resolve('backend/pilot', name));
const { config } = pilot('config'), batches = pilot('auto-review-batch');
let db, handle, server, browser, page, base, actor;
const errors = [], checks = [], output = path.resolve('.local/auto-review-qa');
function docx(text) {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  z.addFile('_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  z.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'));
  z.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`));
  return z.toBuffer();
}
const runtimeFactory = async ({ context, documents, run }) => ({ async run() {
  await pilot('agent/service').event(db, run.agent_session_id, run.id, 'skill_loaded', { name: 'legal-auto-review', versionId: 'auto-review-1' });
  for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
  const plan = { goal: '核查主合同、补充协议和跨文件约定', documents: documents.map(d => ({ versionId:d.versionId, role:'uncertain', confidence:0.4, reason:'需核实签署与适用关系', evidence:[] })), steps:[{id:'all',title:'核查金额、期限、优先顺序和附加条款',versionIds:documents.map(d=>d.versionId)}],skillNames:['legal-auto-review'] };
  assert.equal((await context.execute('create_review_plan',{plan},randomUUID())).saved,true);
  const report={summary:'已完成全部可读材料审查，交付约定需明确。',reviewedVersionIds:documents.map(d=>d.versionId),findings:documents.map((d,i)=>({title:i?'补充协议需核实':'交付日期不明确',status:i?'uncertain':'fail',kind:i?'uncertain':'clause',severity:'high',reason:i?'签署时间与优先适用关系待核实':'交付日期未明确',suggestion:i?'':'条款正文：乙方应于2026年12月1日前交付全部货物。',evidence:[{versionId:d.versionId,blockId:d.blocks[0].id,quote:d.blocks[0].text}],...(i?{}:{edits:[{versionId:d.versionId,blockId:d.blocks[0].id,originalText:d.blocks[0].text,newText:'乙方应于2026年12月1日前交付全部货物。',operation:'replace',reason:'明确交付日期'}]})})),crossDocumentReview:['amendments','amounts_terms','precedence'].map(category=>({category,status:'uncertain',reason:'需双方确认文件间变更关系',evidence:documents.map(d=>({versionId:d.versionId,blockId:d.blocks[0].id,quote:d.blocks[0].text}))}))};
  assert.equal((await context.execute('submit_review',{report},randomUUID())).candidateSaved,true);
  assert.equal((await context.execute('observe_review',{summary:'已核对覆盖、原文证据和三类文件关系',remainingIssues:[]},randomUUID())).submitted,true); return {};
}, async close() {} });
before(async()=>{
  await fs.mkdir(output,{recursive:true});config.dataRoot=path.join(output,'data-'+randomUUID());config.model={...config.model,key:'',baseUrl:'',name:''};
  db=pilot('db').createDb();await pilot('cli').migrate(db);await pilot('storage').initializeDirectories();
  actor={id:randomUUID(),username:'auto-browser',display_name:'虚构验收法务',department:'验收',roles:['admin'],password_hash:await pilot('auth').hashPassword('auto-browser-test-password')};await db('la_users').insert({...actor,roles:JSON.stringify(actor.roles)});
  handle=pilot('app').createApp(db);server=http.createServer(handle.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;config.publicUrl=base;
  browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const session=await(await page.request.get(base+'/api/auth/session')).json();assert.equal((await page.request.post(base+'/api/auth/login',{headers:{Origin:base,'X-CSRF-Token':session.csrf},data:{username:actor.username,password:'auto-browser-test-password'}})).status(),200);
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));await handle?.close();await db?.destroy();await fs.writeFile(path.join(output,'browser-results.json'),JSON.stringify({checks,errors},null,2));assert.deepEqual(errors,[]);});
afterEach(async context => {
  if (context.passed || !page) return;
  console.error(JSON.stringify({ test: context.name, url: page.url(), pageErrors: errors, body: (await page.locator('body').innerText()).slice(0, 5000) }));
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
});
test('browser: manual multiple upload, progress persistence, plans, grouped risks, downloads and mobile refresh',async()=>{
  await page.goto(base+'/#/auto-review');await page.getByRole('button',{name:'＋ 新建自动评审',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles([{name:'主合同.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx('采购合同：交付日期另议。')},{name:'补充协议.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx('补充协议：付款日期另议。')}]);
  await page.getByText('已选择 2 份',{exact:false}).waitFor();
  const dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('textbox').count(),1);
  await page.getByLabel('我方主体（可选）',{exact:true}).fill('虚构采购公司');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/auto-review-batches')&&r.request().method()==='POST');await page.getByRole('button',{name:'上传并自动评审',exact:true}).click();const batch=await(await response).json();await page.waitForURL('**/#/auto-review/'+batch.id);
  assert.equal(batch.result.title,'主合同.docx');assert.equal(batch.background.ourEntity,'虚构采购公司');assert.equal(batch.background.perspective,'');assert.equal(batch.background.purpose,'');
  await page.reload();await page.getByRole('heading',{name:'主合同.docx',exact:true}).waitFor();checks.push('simplified-multi-upload-auto-name-and-refresh-queued');
  await batches.processBatch(db,batch.id,{runtimeFactory});await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await page.getByRole('link',{name:'下载报告',exact:true}).waitFor();
  await page.getByRole('heading',{name:'审查计划',exact:true}).waitFor();await page.getByRole('heading',{name:'本次审查方法',exact:true}).waitFor();await page.getByRole('heading',{name:'多文件自动合同评审',exact:true}).waitFor();assert.equal(await page.getByText('legal-auto-review',{exact:true}).isVisible(),false);await page.getByRole('heading',{name:'待核实事项 · 1',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'下载带修订 DOCX',exact:true}).count(),2);
  let download=page.waitForEvent('download');await page.getByRole('link',{name:'下载报告',exact:true}).click();await(await download).saveAs(path.join(output,'report.html'));
  download=page.waitForEvent('download');await page.getByRole('link',{name:'下载带修订 DOCX',exact:true}).first().click();await(await download).saveAs(path.join(output,'browser-draft.docx'));
  assert.match(new AdmZip(await fs.readFile(path.join(output,'browser-draft.docx'))).readAsText('word/document.xml'),/<w:ins /);
  await page.getByText('未自动改写的意见',{exact:true}).click();await page.getByText('补充协议需核实：',{exact:false}).waitFor();checks.push('plan-skills-observation-grouped-risks-downloads-unresolved');
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.reload();await page.getByRole('link',{name:'下载报告',exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});checks.push('mobile-refresh-no-page-overflow');
  const source=batch.documents[0];await page.goto(base+`/#/contracts/${source.contract_id}?version=${source.version_id}&block=b1`);await page.getByRole('link',{name:'进入自动评审批次 →',exact:true}).waitFor();await page.getByRole('link',{name:'进入自动评审批次 →',exact:true}).click();await page.waitForURL('**/#/auto-review/'+batch.id);checks.push('contract-detail-batch-entry');
  // Same attachment model as the real DingTalk ingestion integration test.
  const intakeId=randomUUID();await db('la_dingtalk_intakes').insert({id:intakeId,client_id:'browser-fixture',instance_id:randomUUID(),recipient_id:actor.id,container_id:batch.container_id});
  for(const d of batch.documents)await db('la_intake_documents').insert({id:randomUUID(),intake_id:intakeId,file_id:d.id,filename:d.filename,field:'附件',status:'collected',contract_id:d.contract_id});
  const dingId=await batches.ensureBatchFromIntake(db,intakeId);await batches.processBatch(db,dingId,{runtimeFactory});await page.goto(base+'/#/auto-review/'+dingId);await page.getByText('钉钉审批收件',{exact:false}).waitFor();await page.getByRole('link',{name:'下载报告',exact:true}).waitFor();checks.push('dingtalk-source-detail');
  await page.goto(base+'/#/auto-review');await page.getByRole('table').waitFor();assert.ok(await page.getByRole('link',{name:'主合同.docx',exact:true}).count()>=1);checks.push('batch-list');
  await page.getByRole('button',{name:'＋ 新建自动评审',exact:true}).click();assert.equal(await page.getByLabel('我方主体（可选）',{exact:true}).inputValue(),'');
  await page.locator('input[type=file]').setInputFiles([{name:'无需填写背景.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx('本文件用于验证直接上传即可评审。')}]);
  const emptyResponse=page.waitForResponse(r=>r.url().endsWith('/api/auto-review-batches')&&r.request().method()==='POST');await page.getByRole('button',{name:'上传并自动评审',exact:true}).click();const emptyBatch=await(await emptyResponse).json();assert.equal(emptyBatch.status,'queued');assert.equal(emptyBatch.background.ourEntity,'');assert.equal(emptyBatch.result.title,'无需填写背景.docx');checks.push('upload-without-any-background-fields');
});

test('browser: automatic drafts open inside the app, preserve handled comments and revisions on save and reload', async () => {
  const batch = await batches.createBatch(db, actor, [
    { originalname: '内嵌审阅主合同.docx', buffer: docx('采购合同：交付日期另议。') },
    { originalname: '内嵌审阅补充协议.docx', buffer: docx('补充协议：付款日期另议。') },
  ], { sourceKey: randomUUID() });
  await batches.processBatch(db, batch.id, { runtimeFactory });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(base + '/#/auto-review/' + batch.id);
  const links = page.getByRole('link', { name: '在程序中审阅', exact: true });
  await links.first().waitFor(); assert.equal(await links.count(), 2);
  await page.getByRole('link', { name: '打开合同审阅 →', exact: true }).waitFor();
  const detail = await batches.publicBatch(db, actor, batch.id);
  const noteArtifact = detail.artifacts.find(a => a.unlocatedFindingIds.length && a.version_id);
  const noteUrl = base + `/#/auto-review/${batch.id}/artifacts/${noteArtifact.id}`;
  await page.locator(`a[href="#/auto-review/${batch.id}/artifacts/${noteArtifact.id}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.comment').length > 0);
  assert.equal(page.url(), noteUrl);
  assert.equal(await page.getByRole('button', { name: '打开原 ONLYOFFICE 编辑器' }).count(), 0);
  await page.locator('.review-margin-card.comment').first().getByRole('button', { name: '标记为已处理', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForFunction(() => /已保存为 v/.test(document.querySelector('.margin-file-group p')?.textContent));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.comment.resolved').length === 1);
  const noteVersion = await db('la_versions').where({ id: (await db('la_contracts').where({ id: detail.documents.find(d => d.id === noteArtifact.batch_document_id).contract_id }).first()).current_version_id }).first();
  assert.equal(noteVersion.parent_id, noteArtifact.version_id);
  const statusSource = await db('la_agent_legal_events').where({ kind: 'review_revision' }).whereJsonSupersetOf('source', { afterVersionId: noteVersion.id }).first();
  assert.ok(statusSource);
  assert.equal(statusSource.status, 'completed');
  assert.equal(statusSource.source.review.substantive, false, JSON.stringify(statusSource.source.review));
  assert.equal(statusSource.source.review.commentStates.length, 1);
  await page.screenshot({ path: path.join(output, 'embedded-review.png') });
  await page.getByTitle('保存并返回', { exact: true }).click();
  await page.waitForURL(base + '/#/auto-review/' + batch.id);
  await page.getByRole('link', { name: '打开合同审阅 →', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.change').length === 1);
  const change = page.locator('.review-margin-card.change');
  assert.equal(await change.locator('.review-margin-avatar').count(), 1);
  assert.equal(await change.locator('header button').count(), 0);
  await change.locator('footer').getByRole('button', { name: '接受此处修订', exact: true }).waitFor();
  await page.getByRole('button', { name: '接受此处修订', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已接受修订' }).waitFor();
  await page.getByRole('button', { name: '撤销此次操作', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.change').length === 1);
  await page.getByRole('button', { name: '接受此处修订', exact: true }).click();
  await page.getByTitle('保存并返回', { exact: true }).click();
  await page.waitForURL(base + '/#/auto-review/' + batch.id);
  await page.getByRole('link', { name: '打开合同审阅 →', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ts-page') && !document.querySelector('.margin-loading'));
  assert.equal(await page.locator('.review-margin-card.change').count(), 0);
  assert.match(await page.locator('.margin-editor-host').innerText(), /乙方应于2026年12月1日前交付全部货物/);
  const decisionSource = await db('la_agent_legal_events').where({ kind: 'review_revision', review_id: detail.main_review_id }).whereJsonSupersetOf('source', { batchId: batch.id }).where('status', 'queued').first();
  assert.ok(decisionSource);
  assert.equal(decisionSource.source.review.decisions.length, 1, JSON.stringify(decisionSource.source.review));
  assert.equal(decisionSource.source.review.decisions[0].action, 'accept');
  assert.deepEqual(decisionSource.source.review.body.added, []);
  await page.getByTitle('保存并返回', { exact: true }).click();
  await page.goto(noteUrl);
  await page.waitForFunction(() => document.querySelectorAll('.review-margin-card.comment').length > 0);
  const comment = page.locator('.review-margin-card.comment').first();
  await comment.getByRole('button', { name: '重新打开', exact: true }).click();
  await comment.getByRole('button', { name: '回复', exact: true }).click();
  const feedback = '合同未明确签署日期，应先核实签署事实再判断补充协议的适用顺序。';
  await page.getByRole('textbox', { name: '批注内容', exact: true }).fill(feedback);
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await page.getByText('沉淀本次法务经验 · 可补充修改理由', { exact: true }).click();
  await page.getByLabel('本次修改理由与适用条件（可选）', { exact: true }).fill('仅适用于签署先后影响补充协议效力的情形。');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('link', { name: '查看整理记录 →', exact: true }).waitFor();
  const replyVersion = (await db('la_contracts').where({ id: noteVersion.contract_id }).first()).current_version_id;
  const replySource = await db('la_agent_legal_events').where({ kind: 'review_revision' }).whereJsonSupersetOf('source', { afterVersionId: replyVersion }).first();
  assert.ok(replySource.source.review.comments.some(c => c.kind === 'reply' && c.text === feedback), JSON.stringify(replySource.source.review));
  assert.ok(replySource.source.review.humanEvidence.includes(feedback));
  assert.equal(replySource.source.review.reason, '仅适用于签署先后影响补充协议效力的情形。');
  await page.getByRole('link', { name: '查看整理记录 →', exact: true }).click();
  await page.waitForURL('**/#/experience?source=' + replySource.id);
  await page.getByRole('heading', { name: '本次保存的法务处理', exact: true }).waitFor();
  assert.match(await page.locator('.source-detail').innerText(), /本次新增批注与回复/);
  assert.match(await page.locator('.source-detail').innerText(), /合同未明确签署日期/);
  await pilot('agent/memory').processMemory(db, replySource.id, { distill: async () => ({ memories: [{ kind: 'skill', title: '核实补充协议生效顺序', description: '比较文件前先核实签署事实', content: '比较主合同与补充协议前，核实签署事实及约定的效力顺序；日期不明确时列为待核实，不推定优先顺序。', conditions: ['存在补充协议且签署先后影响适用顺序'], sourceQuotes: [feedback] }] }) });
  await page.locator('.detail-generated').getByText('核实补充协议生效顺序', { exact: true }).waitFor();
  assert.match(await page.locator('.detail-generated').innerText(), /初次提炼依据/);
  await page.screenshot({ path: path.join(output, 'review-learning-source.png') });
  await page.goto(base + '/#/auto-review/' + batch.id);
  await page.getByRole('heading', { name: '本次法务经验整理', exact: true }).waitFor();
  assert.ok(await page.locator('.auto-learning article').count() >= 3);
  await page.getByRole('link', { name: '查看并审核草稿 →', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'review-learning-batch.png'), fullPage: true });
  checks.push('review-learning-native-decisions-replies-optional-reason-source-details-and-batch-progress');
  checks.push('embedded-auto-draft-shared-card-style-undo-save-resolved-comments-accept-revision-refresh-and-return');
});

test('browser: technical pause has an honest workflow and a direct continuation without mandatory background', async () => {
  const batch = await batches.createBatch(db, actor, [
    { originalname: '暂停恢复验收合同.docx', buffer: docx('采购合同：交付日期另议。') },
    { originalname: '暂停恢复补充协议.docx', buffer: docx('补充协议：付款日期另议。') },
  ], { background: { ourEntity: '虚构采购公司', purpose: '已有交易背景' }, sourceKey: randomUUID() });
  await batches.processBatch(db, batch.id, { runtimeFactory: async (args) => {
    const fixture = await runtimeFactory(args);
    return { async run() {
      for (const d of args.documents) await args.context.execute('read_document', { versionId: d.versionId }, randomUUID());
      const run = await db('la_reviews').where({ id: args.run.id }).first();
      assert.equal(run.coverage.readBlocks, 2); // visible while the runtime is active
      await pilot('agent/service').event(db, args.run.agent_session_id, args.run.id, 'skill_loaded', { name: 'legal-auto-review' });
      const plan = { goal: '全面审查采购合同', documents: args.documents.map(d => ({ versionId: d.versionId, role: 'uncertain', confidence: 0.5, reason: '交易角色需核实', evidence: [] })), steps: [{ id: 'all', title: '核查条款及文件关系', versionIds: args.documents.map(d=>d.versionId) }], skillNames: ['legal-auto-review'] };
      assert.equal((await args.context.execute('create_review_plan', { plan }, randomUUID())).saved, true);
      for (const number of [8, 9]) await pilot('agent/service').event(db, args.run.agent_session_id, args.run.id, 'model_failed', { code: 'AGENT_MODEL_TIMEOUT', number, elapsedMs: 300107, timeoutMs: 300000, httpStatus: 200, receivedBytes: 1600, interruption: 'request_deadline' });
      throw new (pilot('errors').AppError)(502, 'AGENT_MODEL_TIMEOUT', '模型单次响应超过 300 秒，报告尚未生成。已保存审查记录，可继续生成报告，无需补充信息。');
    }, close: fixture.close };
  } });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/#/auto-review/' + batch.id);
  await page.getByRole('heading', { name: '审查已暂停', exact: true }).waitFor();
  await page.getByRole('heading', { name: '为什么暂停：模型响应超时', exact: true }).waitFor();
  const diagnosis = page.getByRole('region', { name: '为什么暂停：模型响应超时', exact: true });
  assert.match(await diagnosis.innerText(), /系统在单次请求达到 300 秒的时限后中止/);
  assert.equal(await diagnosis.getByRole('listitem').count(), 2);
  assert.equal(await diagnosis.getByText('耗时 300.1 秒', { exact: true }).count(), 2);
  assert.match(await diagnosis.innerText(), /审查条款与整理报告/);
  assert.match(await diagnosis.innerText(), /尚未确认/);
  assert.ok(!(await diagnosis.innerText()).includes('AGENT_MODEL_TIMEOUT'));
  await page.reload(); await page.getByRole('heading', { name: '为什么暂停：模型响应超时', exact: true }).waitFor();
  checks.push('pause-reason-stage-failed-attempts-durations-visible-by-default-and-survive-refresh');
  await page.getByText('当前没有需要你回答的问题，直接继续即可。无需重新上传合同。', { exact: true }).waitFor();
  assert.equal(await page.locator('#auto-report').count(), 0);
  assert.equal(await page.locator('#batch-background').isVisible(), false);
  const workflow = page.getByRole('list', { name: '审查流程' });
  assert.equal(await workflow.locator('li.done').count(), 2); assert.equal(await workflow.locator('li.paused').count(), 1);
  await page.screenshot({ path: path.join(output, 'pause-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({ path: path.join(output, 'pause-mobile.png'), fullPage: true });
  let response = page.waitForResponse(r=>r.url().endsWith('/'+batch.id+'/resume')&&r.request().method()==='POST');
  await page.getByRole('button', { name: '继续生成报告', exact: true }).click();
  const resumedResponse = await response, resumed = await resumedResponse.json();
  assert.deepEqual(resumedResponse.request().postDataJSON(), {}); assert.equal(resumed.status, 'queued');
  assert.deepEqual(resumed.background, batch.background);
  await batches.processBatch(db, batch.id, { runtimeFactory });
  await page.getByRole('button', { name: '↻ 刷新', exact: true }).click();
  await page.getByRole('button', { name: '查看并下载文件', exact: false }).waitFor();
  assert.equal(await page.locator('.auto-pause-details').count(), 0);
  checks.push('timeout-is-pause-readable-steps-direct-resume-without-background-and-results-downloadable');
  // Supplementary business facts have an explicit destination and a distinct action.
  await page.getByText('有新的合同外事实？在这里补充（可选）', { exact: true }).click();
  await page.getByLabel('补充背景信息', { exact: true }).fill('银行流水确认尚未支付预付款。');
  response = page.waitForResponse(r=>r.url().endsWith('/'+batch.id+'/resume')&&r.request().method()==='POST');
  await page.getByRole('button', { name: '提交补充信息并重新审查', exact: true }).click();
  const supplemented = await (await response).json();
  assert.equal(supplemented.background.purpose, '银行流水确认尚未支付预付款。');
  assert.equal(supplemented.background.ourEntity, '虚构采购公司');
  const saved = await db('la_reviews').where({ id: supplemented.main_review_id }).first();
  assert.equal(saved.snapshot.background.purpose, supplemented.background.purpose);
  checks.push('optional-facts-explicit-form-and-action-reach-review-snapshot');
});

test('browser: continuation keeps saved reading and shows the actual pause at plan renewal', async () => {
  const batch = await batches.createBatch(db, actor, [{ originalname: '续审进度验收.docx', buffer: docx('采购合同：付款时间待约定。') }], { sourceKey: randomUUID() });
  await batches.processBatch(db, batch.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await pilot('agent/service').event(db, run.agent_session_id, run.id, 'skill_loaded', { name: 'legal-auto-review' });
    await context.execute('create_review_plan', { plan: { goal: '核对采购合同', documents: documents.map(d => ({ versionId: d.versionId, role: 'uncertain', confidence: 0.5, reason: '核实交易关系', evidence: [] })), steps: [{ id: 'terms', title: '核查付款与交付', versionIds: documents.map(d => d.versionId) }], skillNames: ['legal-auto-review'] } }, randomUUID());
    return {};
  }, async close() {} }) });
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(base + '/#/auto-review/' + batch.id);
  await page.getByRole('button', { name: '继续生成报告', exact: true }).click();
  await page.getByRole('heading', { name: '排队中', exact: true }).waitFor();
  const workflow = page.getByRole('list', { name: '审查流程' });
  assert.match(await workflow.locator('li').nth(0).innerText(), /已完成/);
  assert.match(await workflow.locator('li').nth(1).innerText(), /上轮.*本轮待更新/);
  assert.match(await workflow.locator('li').nth(1).innerText(), /等待继续/);
  await batches.processBatch(db, batch.id, { runtimeFactory: async () => ({ async run() { throw new (pilot('errors').AppError)(502, 'AGENT_MODEL_TIMEOUT', '模型响应超时'); }, async close() {} }) });
  await page.getByRole('button', { name: '↻ 刷新', exact: true }).click();
  await page.getByRole('heading', { name: '为什么暂停：模型响应超时', exact: true }).waitFor();
  assert.equal(await workflow.locator('li.done').count(), 1);
  assert.match(await workflow.locator('li.paused').innerText(), /制定计划/);
  assert.match(await workflow.locator('li').nth(2).innerText(), /待进行/);
  assert.equal(await workflow.locator('li').nth(2).getAttribute('aria-current'), null);
  assert.match(await page.locator('.auto-pause-facts').innerText(), /制定计划/);
  assert.match(await page.locator('.auto-overview').innerText(), /1 \/ 1 段/);
  await page.getByText('橙色标记暂停的位置，表示该步骤尚未完成。已完成的步骤保留勾选，后续步骤显示“待进行”。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'continuation-progress-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.getByRole('heading', { name: '为什么暂停：模型响应超时', exact: true }).waitFor();
  assert.match(await workflow.locator('li.paused').innerText(), /制定计划/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(output, 'continuation-progress-mobile.png'), fullPage: true });
  checks.push('continuation-keeps-read-progress-and-old-plan-label-with-evidence-based-pause-location');
});

test('browser: old timeout records show verified timings and explicitly disclose missing evidence', async () => {
  const batch = await batches.createBatch(db, actor, [{ originalname: '历史暂停诊断验收.docx', buffer: docx('采购合同：交付时间待约定。') }], { sourceKey: randomUUID() });
  await batches.processBatch(db, batch.id, { runtimeFactory: async () => ({ async run() { throw new (pilot('errors').AppError)(502, 'AGENT_MODEL_TIMEOUT', '模型响应超时'); }, async close() {} }) });
  const saved = await db('la_auto_review_batches').where({ id: batch.id }).first();
  const attempts = [{ started: 1794375284760, ended: 1794375584867, duration: 300107 }, { started: 1794375585354, ended: 1794375885461, duration: 300107 }];
  await pilot('auth').audit(db, null, 'auto_review_batch.timeout_diagnosed', batch.id, { reviewId: saved.main_review_id, timeouts: attempts });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(base + '/#/auto-review/' + batch.id);
  const diagnosis = page.getByRole('region', { name: '为什么暂停：模型响应超时', exact: true });
  await diagnosis.waitFor(); assert.equal(await diagnosis.getByText('耗时 300.1 秒', { exact: true }).count(), 2);
  assert.match(await diagnosis.innerText(), /历史诊断记录/); assert.ok(!(await diagnosis.innerText()).includes('系统在单次请求'));
  await diagnosis.screenshot({ path: path.join(output, 'pause-historical-evidence.png') });
  await db('la_audit').where({ entity_id: batch.id, action: 'auto_review_batch.timeout_diagnosed' }).delete();
  await page.reload(); await diagnosis.getByText('旧记录未保存逐次请求的耗时，无法展示准确次数和时长。', { exact: true }).waitFor();
  assert.equal(await diagnosis.getByRole('listitem').count(), 0);
  checks.push('historical-verified-pause-timing-and-missing-evidence-fallback');
});

test('browser: saved plain and choice questions show the exact question and submit answers to the same session', async () => {
  for (const structured of [false, true]) {
    const batch = await batches.createBatch(db, actor, [{ originalname: '问题恢复验收.docx', buffer: docx('验收采购合同：付款待确认。') }], { sourceKey: randomUUID() });
    await batches.processBatch(db, batch.id, { runtimeFactory: async ({ run }) => ({ async run() {
      await db('la_agent_messages').insert({ id: randomUUID(), session_id: run.agent_session_id, review_id: run.id, role: 'assistant', kind: 'question', content: '请确认预付款是否已支付。', data: JSON.stringify(structured ? { questions: [{ id: 'paid', question: '预付款是否已支付？', options: [{ label: '已支付' }, { label: '未支付' }] }] } : {}) });
      return {};
    }, async close() {} }) });
    await page.goto(base + '/#/auto-review/' + batch.id);
    await page.getByRole('heading', { name: '需要你确认信息', exact: true }).waitFor();
    await page.getByRole('button', { name: '回答问题并继续', exact: false }).click();
    await page.reload();
    await page.getByText('请确认预付款是否已支付。', { exact: true }).waitFor();
    if (structured) {
      await page.getByText('未支付', { exact: true }).click();
    } else {
      assert.equal(await page.getByRole('button', { name: '提交回答并继续审查', exact: true }).isEnabled(), false);
      await page.getByLabel('你的回答', { exact: false }).fill('银行流水确认尚未支付。');
    }
    const response = page.waitForResponse(r=>r.url().endsWith('/'+batch.id+'/resume')&&r.request().method()==='POST');
    await page.getByRole('button', { name: structured ? '确认并继续' : '提交回答并继续审查', exact: !structured }).click();
    const resumed = await (await response).json();
    assert.equal(resumed.status, 'queued');
    const message = await db('la_agent_messages').where({ review_id: resumed.main_review_id, kind: 'answer' }).first();
    assert.match(message.content, /未支付/); assert.ok(message.data.questionId);
    await page.getByRole('button', { name: '↻ 刷新', exact: true }).click();
    assert.equal(await page.locator('#batch-answer').count(), 0);
    checks.push(structured ? 'choice-answer-reload-validated-and-saved' : 'plain-answer-reload-required-and-saved');
  }
});

test('browser: readable task cards, frozen Chinese method names and optional execution diagnostics', async () => {
  const batch = await batches.createBatch(db, actor, [{ originalname: '模拟健身器材采购合同_页面布局验收_20261111.docx', buffer: docx('虚构采购合同：供货、交付、验收及付款条件需要核实。') }], { sourceKey: randomUUID() });
  const titles = ['采购付款与验收衔接核查','交付期限与违约责任核查','产品质量与售后保障核查','主体授权与收款账户核查','合同解除与结算安排核查','争议解决与通知送达核查'];
  const memories = titles.map(title => ({ id: randomUUID(), kind: 'skill', title, description: '结合合同原文及交易背景核实相关条件，保留不确定事项。', content: '工程样例方法正文', version: 1 }));
  await batches.processBatch(db, batch.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    await db('la_reviews').where({ id: run.id }).update({ snapshot: JSON.stringify({ ...run.snapshot, memories }) });
    for (const name of ['legal-auto-review', ...memories.map(m=>'legal-'+m.id)]) await pilot('agent/service').event(db, run.agent_session_id, run.id, 'skill_loaded', { name });
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    const tasks = ['核实主体授权、签约权限与收款账户信息','核算分项金额与付款条件，联查到仓交付、风险转移与安装验收','审查质量救济、质保召回、知识产权及违约解除结算','核对通知、争议解决及文本优先顺序，核查正文与后续文件的适用关系','submit_review 后核对证据、遗漏及修改建议，再 observe_review'];
    const plan = { goal: '以采购方立场全面审查全部材料，核对实际签署条件并完成 submit_review 和 observe_review。', documents: documents.map(d=>({ versionId: d.versionId, role: 'uncertain', confidence: 0.5, reason: '根据原文识别交易关系', evidence: [] })), steps: tasks.map((title,i)=>({ id: 'task-'+i, title, versionIds: documents.map(d=>d.versionId) })), skillNames: ['legal-auto-review'] };
    assert.equal((await context.execute('create_review_plan', { plan }, randomUUID())).saved, true);return {};
  }, async close() {} }) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base+'/#/auto-review/'+batch.id);
  const plan = page.locator('.review-plan-layout');
  await page.getByRole('heading', { name: '审查计划', exact: true }).waitFor();
  assert.equal(await plan.locator('.plan-task').count(), 5);assert.equal(await plan.locator('.review-method').count(), 3);
  assert.ok(!(await plan.innerText()).match(/legal-|submit_review|observe_review|置信度/));
  await page.getByRole('heading', { name: titles[0], exact: true }).waitFor();
  const firstTask = plan.locator('.plan-task').first();await firstTask.locator('summary').click();
  const link = firstTask.getByRole('link');assert.match(await link.getAttribute('href'),new RegExp(batch.documents[0].contract_id));
  await firstTask.locator('summary').click();
  await plan.screenshot({ path: path.join(output, 'plan-desktop.png') });
  checks.push('readable-task-cards-and-frozen-chinese-method-names');
  const detail = await (await page.request.get(base+'/api/auto-review-batches/'+batch.id)).json();
  const methodCount = detail.skills.length; assert.ok(methodCount >= titles.length + 1);
  await page.getByRole('button', { name: `查看全部 ${methodCount} 项方法`, exact: false }).click();
  assert.equal(await plan.locator('.review-method').count(), methodCount);await page.getByRole('heading', { name: titles[5], exact: true }).waitFor();
  const refreshed = page.waitForResponse(r=>r.url().endsWith('/auto-review-batches/'+batch.id)&&r.request().method()==='GET');
  await page.getByRole('button', { name: '↻ 刷新', exact: true }).click();await refreshed;
  await page.getByRole('heading', { name: titles[5], exact: true }).waitFor();assert.equal(await plan.locator('.review-method').count(),methodCount);
  await page.getByRole('button', { name: '收起方法列表', exact: false }).click();checks.push('task-material-links-and-full-method-list');
  await page.getByText('查看执行记录与诊断信息', { exact: true }).click();
  await page.getByText('方法原始标识（供排查使用）', { exact: true }).click();
  assert.equal(await page.getByText('legal-'+memories[0].id, { exact: true }).isVisible(), true);
  await page.getByText('查看执行记录与诊断信息', { exact: true }).click();checks.push('raw-identifiers-only-in-expandable-diagnostics');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await plan.screenshot({ path: path.join(output, 'plan-mobile.png') });checks.push('mobile-readable-plan-and-methods');
});


test('browser: active continuation shows model wait, elapsed seconds and retry through automatic polling', async () => {
  const batch = await batches.createBatch(db, actor, [{ originalname: '运行状态验收.docx', buffer: docx('采购合同：交付日期另议。') }], { sourceKey: randomUUID() });
  await batches.processBatch(db, batch.id, { runtimeFactory: async ({ context, documents }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    return {};
  }, async close() {} }) });
  const session = await (await page.request.get(base + '/api/auth/session')).json();
  const resumedResponse = await page.request.post(base + '/api/auto-review-batches/' + batch.id + '/resume', { headers: { Origin: base, 'X-CSRF-Token': session.csrf }, data: {} });
  assert.equal(resumedResponse.status(), 202);
  const resumed = await resumedResponse.json();
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const processing = batches.processBatch(db, batch.id, { runtimeFactory: async ({ run }) => ({ async run() {
    await pilot('agent/service').event(db, run.agent_session_id, run.id, 'model_request', { number: 1, timeoutMs: 300000 });
    entered(); await hold;
    throw new (pilot('errors').AppError)(502, 'AGENT_MODEL_TIMEOUT', '模型响应超时');
  }, async close() {} }) });
  try {
    await ready;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base + '/#/auto-review/' + batch.id);
    await page.getByRole('heading', { name: '等待模型响应', exact: true }).waitFor();
    assert.equal(await page.locator('.auto-detail-head .badge').innerText(), '制定计划');
    assert.match(await page.locator('.auto-stepper li.current').innerText(), /制定计划[\s\S]*等待模型/);
    const note = page.locator('.auto-model-wait');
    await note.waitFor();
    await page.waitForFunction(() => /已用时 (\d+) 秒/.test(document.querySelector('.auto-model-wait')?.textContent || ''));
    const initial = Number((await note.innerText()).match(/已用时 (\d+) 秒/)[1]);
    await page.waitForFunction(n => Number(document.querySelector('.auto-model-wait')?.textContent.match(/已用时 (\d+) 秒/)?.[1]) > n, initial);
    checks.push('running-continuation-leaves-queue-and-pending-model-seconds-update');
    await pilot('agent/service').event(db, resumed.review.sessionId, resumed.main_review_id, 'model_failed', { number: 1, code: 'AGENT_MODEL_TIMEOUT' });
    await pilot('agent/service').event(db, resumed.review.sessionId, resumed.main_review_id, 'model_request', { number: 2, timeoutPolicy: 'stream_progress', timeoutMs: 900000, firstResponseTimeoutMs: 300000, idleTimeoutMs: 120000 });
    await page.getByRole('heading', { name: '正在重试模型请求', exact: true }).waitFor();
    assert.match(await page.locator('.auto-status-description').innerText(), /上一次模型请求超时/);
    assert.match(await note.innerText(), /第 2 次模型请求/);
    await page.screenshot({ path: path.join(output, 'active-retry-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await page.getByRole('heading', { name: '正在重试模型请求', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'active-retry-mobile.png'), fullPage: true });
    checks.push('retry-visible-by-auto-polling-and-retained-on-mobile-reload');
    await pilot('agent/service').event(db, resumed.review.sessionId, resumed.main_review_id, 'model_progress', { number: 2, elapsedMs: 360000, message: '模型正在持续生成审查内容' });
    await page.getByRole('heading', { name: '正在生成审查内容', exact: true }).waitFor();
    assert.match(await note.innerText(), /开始输出后，连续 120 秒无新内容/);
    assert.match(await note.innerText(), /单次最长 900 秒/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'active-stream-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(output, 'active-stream-desktop.png'), fullPage: true });
    checks.push('content-progress-is-visible-with-idle-and-total-limits-on-mobile-and-desktop');
    await pilot('agent/service').event(db, resumed.review.sessionId, resumed.main_review_id, 'model_response', { number: 2 });
    await page.getByRole('heading', { name: '制定计划', exact: true }).waitFor();
    assert.equal(await page.locator('.auto-model-wait').count(), 0);
    checks.push('completed-response-removes-stream-wait-without-marking-a-report-complete');
  } finally { release(); await processing; }
  await page.getByRole('button', { name: '↻ 刷新', exact: true }).click();
  await page.getByRole('heading', { name: '审查已暂停', exact: true }).waitFor();
  assert.equal(await page.locator('.auto-model-wait').count(), 0);
  checks.push('terminal-pause-removes-active-request-timer');
});
