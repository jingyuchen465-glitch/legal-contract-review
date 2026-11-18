// Legal version/save regressions against a disposable database and local DocsAPI/model doubles.
// node scripts/test-agent.mjs scripts/qa/legal-flows.cjs
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const AdmZip=require('adm-zip'),jwt=require('jsonwebtoken');
const ROOT=process.cwd(), req=name=>require(path.join(ROOT,'backend/pilot',name));
const {config}=req('config'),{createDb}=req('db'),{createContract,addVersion}=req('contracts');
const {parseDocx}=req('parser'),storage=req('storage');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let db,handle,server,officeServer,browser,base,actor;
const pageErrors=[];
const results=[],out=path.join(ROOT,'.local/legal-fixes');
const original='虚构采购合同。交付期限另行商议。';
function docx(text=original){const zip=new AdmZip();zip.addFile('[Content_Types].xml',Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));zip.addFile('word/document.xml',Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));return zip.toBuffer();}
async function completed(f){await db('la_versions').where({id:f.version.id}).update({parsed:JSON.stringify(parseDocx(await storage.read(f.version.storage_key)))});await db('la_reviews').where({id:f.reviewId}).update({status:'completed',stage:'completed',engine:'harness-v1',agent_result:JSON.stringify({summary:'采购合同审查完成',limitations:[]})});await db('la_findings').insert({id:randomUUID(),review_id:f.reviewId,rule_id:'qa-delivery',title:'交付期限不明确',reason:'缺少明确的交付日期',suggestion:'双方应明确交付日期',check_status:'fail',kind:'clause',severity:'high',evidence:JSON.stringify([{versionId:f.version.id,blockId:'b1',quote:'交付期限另行商议'}])});return f;}
async function fresh(){return completed(await db.transaction(trx=>createContract(trx,actor,{originalname:'法务流程虚构合同.docx',buffer:docx()})));}
async function nextVersion(f){const c=await db('la_contracts').where({id:f.contract.id}).first();const v=await db.transaction(trx=>addVersion(trx,c,{originalname:'双方谈判后新稿.docx',buffer:docx('虚构采购合同。交付期限已明确为三十日。')},actor.id));await db('la_versions').where({id:v.version.id}).update({parsed:JSON.stringify(parseDocx(await storage.read(v.version.storage_key)))});return v;}
async function pageFor(f){const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(12000);page.on('pageerror',e=>pageErrors.push(e.message));await page.addInitScript(()=>{window.DocsAPI={DocEditor:function(id,config){window.__qaOffice={config,destroyed:false};this.destroyEditor=()=>{window.__qaOffice.destroyed=true;};setTimeout(()=>config.events.onDocumentReady(),30);}};});const s=await(await page.request.get(base+'/api/auth/session')).json();const login=await page.request.post(base+'/api/auth/login',{headers:{Origin:base,'X-CSRF-Token':s.csrf},data:{username:'audit-legal',password:'isolated-audit-password'}});assert.equal(login.status(),200);await page.goto(base+'/#/contracts/'+f.contract.id);await page.getByRole('heading',{name:'法务流程虚构合同.docx',exact:true}).waitFor();return page;}
async function capture(page,name,result){results.push({name,...result});await fs.writeFile(path.join(out,'legal-flows-results.json'),JSON.stringify(results,null,2));await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});console.log('QA_EVIDENCE '+name+' '+JSON.stringify(result));}
before(async()=>{
 await fs.mkdir(out,{recursive:true});
 config.dataRoot=path.join(out,'flows-data-'+randomUUID());config.office.secret='isolated-office-audit-secret-at-least-32-characters';
 db=createDb();await req('cli').migrate(db);await storage.initializeDirectories();
 actor={id:randomUUID(),username:'audit-legal',display_name:'模拟法务',department:'测试',roles:JSON.stringify(['admin']),password_hash:await req('auth').hashPassword('isolated-audit-password')};await db('la_users').insert(actor);
 officeServer=http.createServer(async(request,response)=>{
  if(request.method==='GET'){response.end(docx('虚构采购合同。法务手工补充验收条件。'));return;}
  response.setHeader('content-type','application/json');
  if(request.url==='/v1/chat/completions'){
   const parts=[];for await(const part of request)parts.push(part);
   const input=JSON.parse(JSON.parse(Buffer.concat(parts).toString()).messages[1].content);
   const block=input.blocks.find(b=>b.id===input.allowedBlockIds[0]);
   const draft={explanation:'请双方确认交付期限',edits:[{operation:'replace',blockId:block.id,originalText:block.text,newText:'乙方应在合同生效后三十日内完成交付。'}]};
   response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(draft)}}]}));return;
  }
  response.end(JSON.stringify({error:4}));
 });
 await new Promise(r=>officeServer.listen(0,'127.0.0.1',r));config.office.url=config.office.internalUrl='http://127.0.0.1:'+officeServer.address().port;
 config.model={...config.model,key:'isolated-fixture',baseUrl:config.office.internalUrl+'/v1',name:'isolated-draft-model'};
 handle=req('app').createApp(db);server=http.createServer(handle.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 base='http://127.0.0.1:'+server.address().port;config.publicUrl=config.office.backendUrl=base;browser=await chromium.launch({channel:'msedge',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));if(officeServer)await new Promise(r=>officeServer.close(r));await handle?.close();await db?.destroy();assert.deepEqual(pageErrors,[],'No unhandled Vue/browser errors');});

test('switching back to v1 must restore its completed report and findings',async()=>{
 const f=await fresh();await nextVersion(f);const page=await pageFor(f);
 try{
  await page.getByLabel('当前材料',{exact:true}).selectOption(f.version.id);
  await page.waitForResponse(r=>r.url()===base+'/api/contracts/'+f.contract.id&&r.request().method()==='GET');await page.waitForTimeout(200);
  const state={completedV1Reports:await db('la_reviews').where({version_id:f.version.id,status:'completed'}).count().first().then(r=>Number(r.count)),uiFindings:await page.locator('.agent-finding').count(),reportSelectors:await page.getByLabel('审查报告',{exact:true}).count()};
  await capture(page,'v1-report-missing-local',state);assert.equal(state.uiFindings,1,'v1 已完成报告仍在数据库，切回后页面却没有意见');
 }finally{await page.close();}
});

test('historical v1 is read-only; explicit latest-version action opens v2',async()=>{
 const f=await fresh(),v2=await nextVersion(f),page=await pageFor(f);
 try{
  await page.getByLabel('当前材料',{exact:true}).selectOption(f.version.id);
  await page.getByText('历史版本只读，原报告与批注保留供核对。改稿请切换到最新版。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认法务结论',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'采纳',exact:true}).count(),0);
  await page.getByRole('button',{name:'切换到最新版改稿',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  const config=await page.evaluate(()=>window.__qaOffice.config),session=await db('la_editor_sessions').where({key:config.document.key}).first();
  await capture(page,'historical-editor',{selectedBefore:f.version.id,expectedEditor:v2.version.id,actualEditorVersion:session.version_id});
  assert.equal(session.version_id,v2.version.id);assert.match(await page.locator('.office-title').innerText(),/v2/);
 }finally{await page.close();}
});
test('generation saves dirty edits and waits for the new review without closing the editor',async()=>{
 const f=await fresh(),page=await pageFor(f);let saves=0,annotations=0;
 try{
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  const key=await page.evaluate(()=>window.__qaOffice.config.document.key);
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/annotated-version'))annotations++;});
  await page.route('**/api/contracts/*/editor/*/save',async route=>{
   saves++;const payload={key,status:6,url:config.office.internalUrl+'/manual.docx'};
   assert.equal((await page.request.post(base+'/api/onlyoffice/callback',{data:{...payload,token:jwt.sign(payload,config.office.secret)}})).status(),200);
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queued:true,versionId:f.version.id})});
  });
  await page.evaluate(()=>window.__qaOffice.config.events.onDocumentStateChange({data:true}));
  await page.getByRole('button',{name:'生成批注建议稿',exact:true}).click();
  await page.getByText('已保存为 v2，重新审查完成后可生成建议稿',{exact:true}).waitFor();
  const c=await db('la_contracts').where({id:f.contract.id}).first(),v=await db('la_versions').where({id:c.current_version_id}).first();
  const state={saveRequests:saves,annotationRequests:annotations,editorOpen:await page.locator('.office-workspace').count()===1,text:parseDocx(await storage.read(v.storage_key)).blocks[0].text};
  await capture(page,'dirty-annotated',state);assert.equal(saves,1);assert.equal(annotations,0);assert.equal(state.editorOpen,true);assert.match(state.text,/手工补充验收条件/);
 }finally{await page.close();}
});
test('successful annotated document generation must not show a JavaScript error',async()=>{const f=await fresh(),page=await pageFor(f);try{const responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/annotated-version'));await page.getByRole('button',{name:'生成批注建议稿',exact:true}).click();const response=await responsePromise;const artifact=await response.json();await page.getByText('下载批注建议稿 ↗',{exact:true}).waitFor();await page.waitForFunction(id=>document.querySelector('select[aria-label="当前材料"]')?.value===id,artifact.versionId);const alerts=await page.locator('.notice.danger[role=alert]').allTextContents(),c=await db('la_contracts').where({id:f.contract.id}).first();await capture(page,'annotation-success-error',{annotationHTTP:response.status(),artifactVersion:artifact.versionId,currentVersion:c.current_version_id,selectedVersion:await page.getByLabel('当前材料',{exact:true}).inputValue(),alerts});assert.deepEqual(alerts,[],'接口成功但页面报 ElMessage is not defined，刷新被跳过');}finally{await page.close();}});

test('old report cannot advance current version using text predating negotiated v2',async()=>{
 const f=await fresh(),v2=await nextVersion(f),page=await pageFor(f);
 try{
  const csrf=(await(await page.request.get(base+'/api/auth/session')).json()).csrf;
  const response=await page.request.post(base+'/api/reviews/'+f.reviewId+'/annotated-version',{headers:{Origin:base,'X-CSRF-Token':csrf},data:{mode:'comments'}});
  const result=await response.json(),c=await db('la_contracts').where({id:f.contract.id}).first();
  await capture(page,'old-report-new-version',{http:response.status(),code:result.code,currentVersion:c.current_version_id,expected:v2.version.id});
  assert.equal(response.status(),409);assert.equal(result.code,'ANNOTATION_REVIEW_STALE');assert.equal(c.current_version_id,v2.version.id);
 }finally{await page.close();}
});
test('failed manual save keeps dirty editor open and does not create another version',async()=>{
 const f=await fresh(),page=await pageFor(f);
 try{
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  await page.evaluate(()=>window.__qaOffice.config.events.onDocumentStateChange({data:true}));
  await page.route('**/api/contracts/*/editor/*/save',route=>route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({code:'OFFICE_SAVE_FAILED',message:'模拟保存失败，请保留编辑器'})}));
  await page.getByRole('button',{name:'保存并返回',exact:true}).click();await page.locator('.office-error').filter({hasText:'模拟保存失败'}).waitFor();
  const c=await db('la_contracts').where({id:f.contract.id}).first(),state={editorOpen:await page.locator('.office-workspace').count()===1,editorDestroyed:await page.evaluate(()=>window.__qaOffice.destroyed),currentVersion:c.current_version_id};
  await capture(page,'save-failure-keeps-editor',state);assert.equal(state.editorOpen,true);assert.equal(state.editorDestroyed,false);assert.equal(c.current_version_id,f.version.id);
 }finally{await page.close();}
});

test('applied revisions retain historical opinions, wait for v2 review, then generate from v2',async()=>{
 const f=await fresh(),page=await pageFor(f);
 try{
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  await page.getByRole('button',{name:'生成完整条款改稿',exact:true}).click();await page.getByRole('heading',{name:'可直接使用的条款改稿',exact:true}).waitFor();
  const appliedResponse=page.waitForResponse(r=>r.url().endsWith('/apply-draft'));
  await page.getByRole('button',{name:'应用改稿并保留修订',exact:true}).click();const applied=await(await appliedResponse).json();
  await page.getByRole('status').filter({hasText:/已保存为 v2/}).waitFor();
  await page.getByText('等待 v2 审查完成后生成建议稿',{exact:true}).waitFor();
  const button=page.getByRole('button',{name:'生成批注建议稿',exact:true});assert.equal(await button.isDisabled(),true);
  assert.match(await page.locator('.office-notes-heading').innerText(),/历史预审意见.*基于 v1/);
  const c=await db('la_contracts').where({id:f.contract.id}).first();
  await db('la_reviews').where({id:c.current_review_id}).update({status:'completed',stage:'completed',engine:'harness-v1',agent_result:JSON.stringify({summary:'新版本完成，零风险',limitations:[]})});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='生成批注建议稿'&&!b.disabled));
  const generatedResponse=page.waitForResponse(r=>r.url().endsWith('/annotated-version'));
  await button.click();const artifact=await(await generatedResponse).json(),v=await db('la_versions').where({id:artifact.versionId}).first();
  const text=parseDocx(await storage.read(v.storage_key)).blocks[0].text,finding=await db('la_findings').where({review_id:f.reviewId}).first();
  await capture(page,'post-apply-annotations',{sourceVersion:artifact.sourceVersionId,appliedVersion:applied.versionId,text,disposition:finding.disposition});
  assert.equal(artifact.sourceVersionId,applied.versionId);assert.match(text,/三十日/);assert.equal(finding.disposition,null);
 }finally{await page.close();}
});
test('typing again while save is in flight keeps editor open for another save',async()=>{
 const f=await fresh(),page=await pageFor(f);
 try{
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  const key=await page.evaluate(()=>window.__qaOffice.config.document.key);
  await page.evaluate(()=>window.__qaOffice.config.events.onDocumentStateChange({data:true}));
  let callbackHTTP;
  await page.route('**/api/contracts/*/editor/*/save',async route=>{
   const payload={key,status:6,url:config.office.internalUrl+'/manual.docx'};
   const callback=await page.request.post(base+'/api/onlyoffice/callback',{data:{...payload,token:jwt.sign(payload,config.office.secret)}});callbackHTTP=callback.status();
   await page.evaluate(()=>window.__qaOffice.config.events.onDocumentStateChange({data:true}));
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queued:true,versionId:f.version.id})});
  });
  await page.getByRole('button',{name:'保存并返回',exact:true}).click();
  await page.getByText('保存期间又有新的修改，请再次点击“保存并返回”。',{exact:true}).waitFor();
  const state={callbackHTTP,editorOpen:await page.locator('.office-workspace').count()===1,editorDestroyed:await page.evaluate(()=>window.__qaOffice.destroyed),pending:await page.getByRole('status').filter({hasText:'有修改待保存'}).count()===1};
  await capture(page,'typing-during-save',state);assert.equal(callbackHTTP,200);assert.equal(state.editorOpen,true);assert.equal(state.editorDestroyed,false);assert.equal(state.pending,true);
 }finally{await page.close();}
});

test('rapid file switches discard a delayed historical report response',async()=>{
 const f=await fresh(),v2=await nextVersion(f);await completed({...v2,contract:f.contract});
 await db('la_reviews').where({id:v2.reviewId}).update({agent_result:JSON.stringify({summary:'v2 专用报告',limitations:[]})});
 const page=await pageFor(f);let release,arrived;
 const held=new Promise(r=>release=r),requested=new Promise(r=>arrived=r);
 try{
  await page.route('**/api/reviews/'+f.reviewId,async route=>{arrived();await held;await route.continue();});
  await page.getByLabel('当前材料',{exact:true}).selectOption(f.version.id);await requested;
  await page.getByLabel('当前材料',{exact:true}).selectOption(v2.version.id);
  await page.getByText('v2 专用报告',{exact:true}).waitFor();release();await page.waitForTimeout(300);
  assert.equal(await page.getByLabel('当前材料',{exact:true}).inputValue(),v2.version.id);
  assert.equal(await page.getByText('v2 专用报告',{exact:true}).count(),1);
  await capture(page,'slow-response-discarded',{selectedVersion:v2.version.id,historicalResponseDiscarded:true});
 }finally{release();await page.close();}
});

test('manual report selection survives polling and a round trip between versions',async()=>{
 const f=await fresh(),v2=await nextVersion(f),old=await db('la_reviews').where({id:f.reviewId}).first(),newId=randomUUID();
 await db('la_reviews').insert({...old,id:newId,created_at:new Date(Date.now()+10000),agent_result:JSON.stringify({summary:'新的零风险报告',limitations:[]})});
 const page=await pageFor(f);
 try{
  await page.getByLabel('当前材料',{exact:true}).selectOption(f.version.id);
  await page.getByLabel('审查报告',{exact:true}).selectOption(f.reviewId);
  await page.waitForTimeout(3300);assert.equal(await page.getByLabel('审查报告',{exact:true}).inputValue(),f.reviewId);
  await page.getByLabel('当前材料',{exact:true}).selectOption(v2.version.id);
  await page.getByLabel('当前材料',{exact:true}).selectOption(f.version.id);
  await page.waitForFunction(id=>document.querySelector('select[aria-label="审查报告"]')?.value===id,f.reviewId);
  await capture(page,'manual-report-retained',{reportId:f.reviewId,retained:true});
 }finally{await page.close();}
});

test('annotation save failure retains the editor and never posts a generation request',async()=>{
 const f=await fresh(),page=await pageFor(f);let annotations=0;
 try{
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  await page.evaluate(()=>window.__qaOffice.config.events.onDocumentStateChange({data:true}));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/annotated-version'))annotations++;});
  await page.route('**/api/contracts/*/editor/*/save',r=>r.fulfill({status:502,contentType:'application/json',body:JSON.stringify({message:'生成前保存失败'})}));
  await page.getByRole('button',{name:'生成批注建议稿',exact:true}).click();await page.locator('.office-error').filter({hasText:'生成前保存失败'}).waitFor();
  assert.equal(annotations,0);assert.equal(await page.locator('.office-workspace').count(),1);assert.equal(await page.evaluate(()=>window.__qaOffice.destroyed),false);
 }finally{await page.close();}
});

test('successful generation with failed refresh preserves download and reports partial success',async()=>{
 const f=await fresh(),page=await pageFor(f);let generated=false;
 try{
  await page.route('**/api/reviews/'+f.reviewId+'/annotated-version',async route=>{const response=await route.fetch();generated=true;await route.fulfill({response});});
  await page.route('**/api/contracts/'+f.contract.id,route=>generated?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'测试刷新失败'})}):route.continue());
  await page.getByRole('button',{name:'生成批注建议稿',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'生成成功，页面刷新失败'}).waitFor();
  assert.equal(await page.getByText('下载批注建议稿 ↗',{exact:true}).count(),1);
  assert.equal(await db('la_versions').where({contract_id:f.contract.id}).count().first().then(r=>Number(r.count)),2);
  await capture(page,'generation-refresh-failure',{generated:true,downloadPreserved:true});
 }finally{await page.close();}
});

test('new upload between editor navigation and request is rejected without an editor session',async()=>{
 const f=await fresh(),page=await pageFor(f);
 try{
  await page.route('**/api/contracts/'+f.contract.id+'/editor?*',async route=>{await nextVersion(f);await route.continue();});
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();
  await page.locator('.office-error').filter({hasText:'合同已有新版本'}).waitFor();
  assert.equal(await db('la_editor_sessions').where({contract_id:f.contract.id}).count().first().then(r=>Number(r.count)),0);
  assert.equal(await page.evaluate(()=>!!window.__qaOffice),false);
 }finally{await page.close();}
});

test('joint attachment selection retains its report across polling and filters findings by file',async()=>{
 const f=await fresh(),attachment=await fresh(),page=await pageFor(f);
 try{
  const v=await db('la_versions').where({id:attachment.version.id}).first();v.parsed=parseDocx(await storage.read(v.storage_key));
  const docs=[{versionId:f.version.id,contractId:f.contract.id},{versionId:v.id,contractId:attachment.contract.id}];
  const patchReport=r=>({...r,snapshot:{...r.snapshot,jointGroup:{documents:docs}},findings:[{id:'attachment-opinion',title:'附件专属意见',reason:'测试附件作用域',suggestion:'请核对交付日期',severity:'medium',check_status:'fail',kind:'clause',legal_refs:[],evidence:[{versionId:v.id,blockId:'b1',quote:'交付期限另行商议'}]},{id:'main-opinion',title:'主合同专属意见',reason:'测试主合同作用域',severity:'low',check_status:'fail',kind:'missing',legal_refs:[],evidence:[]}]});
  await page.route('**/api/contracts/'+f.contract.id,async route=>{const response=await route.fetch(),c=await response.json();c.reviews=c.reviews.map(patchReport);c.jointDocuments=[{version:v}];await route.fulfill({json:c});});
  await page.route('**/api/reviews/'+f.reviewId,async route=>{const response=await route.fetch(),r=patchReport(await response.json());r.documents=[{versionId:v.id,version:v}];await route.fulfill({json:r});});
  await page.reload();await page.getByLabel('当前材料',{exact:true}).selectOption(v.id);
  await page.getByRole('heading',{name:'附件专属意见',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'主合同专属意见',exact:true}).count(),0);
  await page.waitForTimeout(3300);assert.equal(await page.getByLabel('当前材料',{exact:true}).inputValue(),v.id);
  assert.equal(await page.getByLabel('审查报告',{exact:true}).inputValue(),f.reviewId);
  await capture(page,'joint-attachment',{version:v.id,report:f.reviewId,pollRetained:true});
 }finally{await page.close();}
});

test('force-save callback timeout keeps pending edits and editor open',async()=>{
 const f=await fresh(),page=await pageFor(f);page.setDefaultTimeout(45000);
 try{
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  await page.evaluate(()=>window.__qaOffice.config.events.onDocumentStateChange({data:true}));
  await page.route('**/api/contracts/*/editor/*/save',r=>r.fulfill({json:{queued:true,versionId:f.version.id}}));
  await page.getByRole('button',{name:'保存并返回',exact:true}).click();
  await page.locator('.office-error').filter({hasText:'尚未收到保存确认'}).waitFor();
  assert.equal(await page.locator('.office-workspace').count(),1);assert.equal(await page.evaluate(()=>window.__qaOffice.destroyed),false);
  assert.equal((await db('la_contracts').where({id:f.contract.id}).first()).current_version_id,f.version.id);
  await capture(page,'save-timeout',{editorRetained:true,currentVersionUnchanged:true});
 }finally{await page.close();}
});

test('force-save no-change reply during editor flush must retry until a version is confirmed',async()=>{
 const f=await fresh(),page=await pageFor(f);let saves=0;
 try{
  await page.locator('.agent-document').getByRole('button',{name:'打开改稿',exact:true}).click();await page.getByRole('status').filter({hasText:'已开启修订'}).waitFor();
  const key=await page.evaluate(()=>window.__qaOffice.config.document.key);
  await page.route('**/api/contracts/*/editor/*/save',async route=>{
   saves++;
   if(saves>1){const payload={key,status:6,url:config.office.internalUrl+'/manual.docx'};assert.equal((await page.request.post(base+'/api/onlyoffice/callback',{data:{...payload,token:jwt.sign(payload,config.office.secret)}})).status(),200);}
   await route.fulfill({json:{queued:saves>1,versionId:f.version.id}});
  });
  await page.evaluate(()=>window.__qaOffice.config.events.onDocumentStateChange({data:true}));
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByRole('status').filter({hasText:'已保存为 v2'}).waitFor();
  assert.ok(saves>=2);assert.notEqual((await db('la_contracts').where({id:f.contract.id}).first()).current_version_id,f.version.id);
  await capture(page,'force-save-flush-retry',{saveRequests:saves,confirmedVersion:2});
 }finally{await page.close();}
});
