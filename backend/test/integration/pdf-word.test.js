const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const supertest=require('supertest');
const AdmZip=require('adm-zip');
const {config}=require('../../pilot/config');
const {createDb}=require('../../pilot/db');
const {migrate}=require('../../pilot/cli');
const {hashPassword}=require('../../pilot/auth');
const {createApp}=require('../../pilot/app');
const {processWordConversion}=require('../../pilot/word-conversions');
const {AppError}=require('../../pilot/errors');
const storage=require('../../pilot/storage');
let db,root,name,handle,owner,other,csrf;
const pdf=Buffer.from('%PDF-1.4\nsynthetic source only');
function zip(entries){const z=new AdmZip();for(const [n,v] of Object.entries(entries))z.addFile(n,Buffer.from(v));return z.toBuffer();}
function assemble(source,pages){
 const content=pages.map(p=>p.blocks.map(b=>`<w:p><w:r><w:t>${b.text}</w:t></w:r></w:p>`).join('')).join('');
 return zip({'document.docx':zip({'[Content_Types].xml':'<Types/>','word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}</w:body></w:document>`}),'preview.pdf':'%PDF-1.4\npreview','quality.json':JSON.stringify({editable:true,contentRoundTrip:true,visualVerified:false,renderedPages:pages.length,issues:[]})});
}
const options={render:async(buffer,page)=>({width:600,height:800,pageCount:2,image:String(page),nativeItems:[],imageRegions:[[0,0,1000,1000]]}),vision:async(db,image,system)=>({usage:{retryCount:1,total_tokens:10},result:system.startsWith('核对')?{issues:[]}:{blocks:[{kind:'paragraph',bbox:[30,30,900,30],text:`Synthetic page ${image} amount 12345.67`}],issues:[]}}),assemble};
async function upload(){return (await owner.post('/api/contracts/upload').set('X-CSRF-Token',csrf).field('background',JSON.stringify({ourEntity:'测试主体',perspective:'采购方',purpose:'验证转换'})).attach('file',pdf,'测试扫描合同.pdf').expect(201)).body;}
before(async()=>{
 root=createDb();name='legal_test_pdf_'+randomUUID().replaceAll('-','');await root.raw(`CREATE DATABASE "${name}"`);
 const url=new URL(config.databaseUrl);url.pathname='/'+name;config.databaseUrl=url.href;config.dataRoot=path.resolve(__dirname,'../../../.local/test-data',name);config.pdfWord.enabled=true;Object.assign(config.model,{name:'test-vision',baseUrl:'https://example.invalid/v1',key:'synthetic-test'});
 db=createDb();await migrate(db);await storage.initializeDirectories();handle=createApp(db);
 for(const username of ['owner','other']){await db('la_users').insert({id:randomUUID(),username,display_name:username,department:username,roles:JSON.stringify(['business']),password_hash:await hashPassword('test-password-1234')});const agent=supertest.agent(handle.app);const session=await agent.get('/api/auth/session');const login=await agent.post('/api/auth/login').set('X-CSRF-Token',session.body.csrf).send({username,password:'test-password-1234'}).expect(200);if(username==='owner'){owner=agent;csrf=login.body.csrf;}else other=agent;}
});
after(async()=>{await handle?.close();await db?.destroy();if(root&&name){await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()',[name]);await root.raw(`DROP DATABASE "${name}"`);}await root?.destroy();});
test('conversion is deduplicated, resumable, access controlled and becomes a new version only on explicit adoption',async()=>{
 const uploaded=await upload(),versionId=uploaded.version.id;
 const create=()=>owner.post(`/api/versions/${versionId}/word-conversions`).set('X-CSRF-Token',csrf).send({});
 const job=(await create().expect(202)).body;assert.equal((await create().expect(202)).body.id,job.id);
 const previous=await db('la_contracts').where({id:uploaded.contract.id}).first();
 await processWordConversion(db,job.id,{...options,render:async(b,n)=>{if(n===2)throw new AppError(503,'PDF_MODEL_TIMEOUT','synthetic timeout');return options.render(b,n);}});
 assert.equal((await db('la_word_conversions').where({id:job.id}).first()).status,'failed');assert.equal((await db('la_pdf_pages')).length,1);
 await owner.post(`/api/word-conversions/${job.id}/retry`).set('X-CSRF-Token',csrf).send({}).expect(202);
 let recognized=[];await processWordConversion(db,job.id,{...options,render:async(b,n)=>{recognized.push(n);return options.render(b,n);}});assert.deepEqual(recognized,[2]);
 const detail=(await owner.get(`/api/word-conversions/${job.id}`).expect(200)).body;assert.equal(detail.status,'needs_verification');assert.deepEqual(detail.quality.metrics,{requests:4,retries:4,totalTokens:40,problemPages:0,pageCount:2});assert.ok(!JSON.stringify(detail).includes('storage_key'));assert.ok(!JSON.stringify(detail).includes('synthetic-test'));
 await other.get(`/api/word-conversions/${job.id}`).expect(404);await other.get(detail.artifacts.docx.url).expect(404);await supertest(handle.app).get(detail.artifacts.docx.url).expect(401);
 await owner.get(detail.artifacts.docx.url).expect(200);assert.equal((await db('la_contracts').where({id:previous.id}).first()).current_version_id,versionId);
 const adopt=body=>owner.post(`/api/contracts/${previous.id}/versions/from-conversion`).set('X-CSRF-Token',csrf).send(body);
 await adopt({conversionId:job.id,revision:previous.revision,acknowledged:false}).expect(400);
 const adopted=(await adopt({conversionId:job.id,revision:previous.revision,acknowledged:true}).expect(201)).body;
 assert.notEqual(adopted.version.id,versionId);assert.equal((await adopt({conversionId:job.id,revision:previous.revision,acknowledged:true}).expect(200)).body.version.id,adopted.version.id);
 assert.equal((await db('la_versions').where({contract_id:previous.id})).length,2);assert.equal((await db('la_versions').where({id:versionId}).first()).sha256,storage.sha256(pdf));
});
test('model changes require a new cache entry; stale source adoption and disabled task creation are blocked',async()=>{
 const uploaded=await upload();const url=`/api/versions/${uploaded.version.id}/word-conversions`;
 const first=(await owner.post(url).set('X-CSRF-Token',csrf).send({}).expect(202)).body;
 config.model.name='other-vision';const second=(await owner.post(url).set('X-CSRF-Token',csrf).send({}).expect(202)).body;assert.notEqual(first.id,second.id);
 await processWordConversion(db,first.id,options);assert.equal((await db('la_word_conversions').where({id:first.id}).first()).error_code,'MODEL_SNAPSHOT_CHANGED');
 await processWordConversion(db,second.id,options);
 const c=await db('la_contracts').where({id:uploaded.contract.id}).first();await db('la_contracts').where({id:c.id}).update({current_version_id:null});
 await owner.post(`/api/contracts/${c.id}/versions/from-conversion`).set('X-CSRF-Token',csrf).send({conversionId:second.id,revision:c.revision,acknowledged:true}).expect(409);
 config.pdfWord.enabled=false;await owner.post(url).set('X-CSRF-Token',csrf).send({}).expect(503);await owner.get(`/api/word-conversions/${second.id}/files/docx`).expect(200);config.pdfWord.enabled=true;
});
