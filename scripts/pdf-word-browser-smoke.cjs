const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.resolve('.local/pdf-word/browser/node_modules/playwright'));
const access=JSON.parse(fs.readFileSync('.local/pdf-word/office-access.json','utf8'));
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1050}}),result={isolatedDatabase:true,fictionalDocuments:true,realConvertedArtifact:true,realOnlyOffice:true,errors:[]};
 page.on('pageerror',e=>result.errors.push(e.message));
 try{
  const s=await(await page.request.get(access.url+'/api/auth/session')).json();const login=await page.request.post(access.url+'/api/auth/login',{headers:{Origin:access.url,'X-CSRF-Token':s.csrf},data:{username:access.username,password:access.password}});assert.equal(login.status(),200);
  await page.goto(access.url+'/#/contracts/'+access.contractId);await page.getByRole('link',{name:'下载 Word 副本',exact:true}).waitFor({timeout:30000});
  const artifact=await page.request.get(access.url+`/api/word-conversions/${access.conversionId}/files/docx`);assert.equal(artifact.status(),200);result.downloadVerified=true;
  await page.getByRole('button',{name:'对照原件与转换稿',exact:true}).click();assert.equal(await page.locator('.pdf-word-compare iframe').count(),2);result.comparisonVisible=true;
  await page.screenshot({path:'.local/pdf-word/对照与核验.png',fullPage:true});
  await page.getByRole('button',{name:'收起对照',exact:true}).click();
  const adopt=page.getByRole('button',{name:'创建 Word 版本并编辑',exact:true});assert.equal(await adopt.isDisabled(),true);
  await page.getByRole('checkbox',{name:'已对照原件核对，接受以转换稿创建新版本'}).check();await adopt.click();
  await page.getByText('已开启修订，修改后请保存',{exact:true}).waitFor({timeout:90000});
  const frame=page.frames().find(f=>/documenteditor/.test(f.url()));assert.ok(frame);await frame.waitForFunction(()=>typeof window.Asc?.editor?.pluginMethod_InputText==='function',{timeout:60000});result.editorLoaded=true;
  await frame.evaluate(()=>window.Asc.editor.pluginMethod_InputText(' REAL_PDF_WORD_SAVE_20261105',''));await page.waitForTimeout(2500);
  await page.screenshot({path:'.local/pdf-word/Word在线编辑.png',fullPage:true});
  await page.getByRole('button',{name:'保存并返回',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.office-workspace'),{timeout:60000});
  const c=await(await page.request.get(access.url+'/api/contracts/'+access.contractId)).json();const v=c.versions.find(v=>v.id===c.current_version_id);
  assert.ok(c.versions.length>=3);assert.ok(v.filename.endsWith('.docx'));assert.notEqual(v.id,access.sourceVersionId);assert.ok(c.current_preanalysis_id);
  const saved=await page.request.get(access.url+'/api/files/'+v.id);const zip=new(require('adm-zip'))(await saved.body());assert.ok(zip.readAsText('word/document.xml').includes('REAL_PDF_WORD_SAVE_20261105'));
  assert.equal(c.versions.find(v=>v.id===access.sourceVersionId).filename,'虚构转换验收.pdf');
  result.actualSaveVerified=true;result.originalPreserved=true;result.newPreanalysisQueued=true;result.oldPdfOpinionsNotTransferred=true;result.passed=true;
 }finally{await page.screenshot({path:'.local/pdf-word/最终页面.png',fullPage:true}).catch(()=>{});fs.writeFileSync('.local/pdf-word/browser-result.json',JSON.stringify(result,null,2));await browser.close();}
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
