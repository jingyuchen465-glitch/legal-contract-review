const { test, before, after }=require('node:test');
const assert=require('node:assert/strict');
const { randomUUID }=require('node:crypto');
const path=require('node:path');
const supertest=require('supertest');
const jwt=require('jsonwebtoken');
const AdmZip=require('adm-zip');
const {config}=require('../../pilot/config');
const {createDb}=require('../../pilot/db');
const {migrate}=require('../../pilot/cli');
const {hashPassword}=require('../../pilot/auth');
const {createApp}=require('../../pilot/app');
const {createDraft}=require('../../pilot/rules');
const {processReview}=require('../../pilot/workflow');
const {persistEvent,processIntegration}=require('../../pilot/dingtalk');
const {createQueue}=require('../../pilot/queue');
const {documentToken}=require('../../pilot/office');
const {createGateway}=require('../../pilot/model');
const password='test-only-password-1234',background={ourEntity:'虚构采购公司',perspective:'采购方',purpose:'测试设备采购'};
function docx(text='虚构采购合同。乙方供货，甲方支付100万元。交付期限另行商议。'){const zip=new AdmZip();zip.addFile('word/document.xml',Buffer.from(`<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));zip.getEntry('word/document.xml').header.time=new Date('2020-01-01T00:00:00Z');return zip.toBuffer();}
const gateway={classify:async d=>({typeId:'procurement',tags:[],evidence:[{blockId:d.blocks[0].id,quote:'虚构采购合同'}],confirmed:false}),review:async(d,rules)=>({checks:rules.map(r=>({ruleId:r.id,title:r.title,status:'fail',kind:'clause',severity:'high',reason:'交付期限不明确',suggestion:'约定明确交付日期',evidence:[{blockId:d.blocks[0].id,quote:'交付期限另行商议'}],legalRefIds:[]})),coverage:{complete:true,totalRules:rules.length,checkedRules:rules.length,coveredBlockIds:d.blocks.map(b=>b.id)}})};
let rootDb,db,appHandle,agents={},users={},tokens={},queue,created,ruleVersion,testDatabase;
const getC=()=>db('la_contracts').where({id:created.contract.id}).first();
function requestAs(name,method,url,body){let request=agents[name][method](url).set('X-CSRF-Token',tokens[name]);return body?request.send(body):request;}
async function publish(p){await requestAs('publisher','post',`/api/rule-pack-versions/${p.id}/submit`,{revision:p.revision}).expect(200);await requestAs('publisher','post',`/api/rule-pack-versions/${p.id}/publish`,{revision:p.revision+1}).expect(200);}
before(async()=>{
  rootDb=createDb();testDatabase='legal_test_'+randomUUID().replaceAll('-','');await rootDb.raw(`CREATE DATABASE "${testDatabase}"`);
  const url=new URL(config.databaseUrl);url.pathname='/'+testDatabase;config.databaseUrl=url.href;config.dataRoot=path.resolve(__dirname,'../../../.local/test-data',testDatabase);db=createDb();await migrate(db);await require('../../pilot/storage').initializeDirectories();
  for(const [name,roles]of Object.entries({business:['business'],other:['business'],legal:['legal'],publisher:['publisher'],admin:['admin']})){const row={id:randomUUID(),username:name,display_name:name,department:name==='other'?'其他部门':'测试部门',password_hash:await hashPassword(password),roles:JSON.stringify(roles)};await db('la_users').insert(row);users[name]={...row,roles};}
  appHandle=createApp(db);
  for(const name of Object.keys(users)){const agent=supertest.agent(appHandle.app);agents[name]=agent;const s=await agent.get('/api/auth/session').expect(200);const login=await agent.post('/api/auth/login').set('X-CSRF-Token',s.body.csrf).send({username:name,password}).expect(200);tokens[name]=login.body.csrf;}
});
after(async()=>{if(queue)await queue.stop();await appHandle?.close();await db?.destroy();if(rootDb&&testDatabase){await rootDb.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()',[testDatabase]);await rootDb.raw(`DROP DATABASE "${testDatabase}"`);}await rootDb?.destroy();});
test('authentication is mandatory, CSRF and origin are checked; admin has unified legal and publishing privileges',async()=>{
  await supertest(appHandle.app).get('/api/contracts').expect(401);
  await agents.business.post('/api/reviews').send({}).expect(403);
  await agents.business.post('/api/reviews').set('X-CSRF-Token',tokens.business).set('Origin','https://untrusted.example').send({}).expect(403);
  await requestAs('admin','post','/api/contracts/upload').expect(400);
  await requestAs('business','get','/api/users').expect(403);
  await requestAs('admin','get','/api/rule-packs').expect(200);
  await requestAs('admin','get','/api/feedback-cases').expect(200);
});
test('upload creates immutable version/outbox; anonymous and other users cannot read or download',async()=>{
  const filename='采购合同（中文测试）.docx';
  const response=await requestAs('business','post','/api/contracts/upload').field('background',JSON.stringify(background)).attach('file',docx(),filename).expect(201);created=response.body;
  assert.equal(created.contract.title,filename);assert.equal(created.version.filename,filename);
  assert.equal((await db('la_outbox')).length,1);assert.equal(created.version.version_no,1);
  await agents.other.get('/api/contracts/'+created.contract.id).set('X-User-ID',users.business.id).expect(404);
  await agents.other.get('/api/files/'+created.version.id).expect(404);
  await supertest(appHandle.app).get('/api/files/'+created.version.id).expect(401);
  await agents.business.get('/api/uploads/'+created.version.id).expect(404);
  const token=documentToken(created.version.id,users.business.id);await supertest(appHandle.app).get(`/api/files/${created.version.id}?token=${token}`).expect(200);
  await supertest(appHandle.app).get(`/api/files/${randomUUID()}?token=${token}`).expect(403);
});
test('missing published rule stops normally, does not create a complete report',async()=>{
  await processReview(db,created.reviewId,{gateway});const run=await db('la_reviews').where({id:created.reviewId}).first();assert.equal(run.status,'waiting_input');assert.equal(run.error_code,'NO_PUBLISHED_RULES');assert.equal((await getC()).legal_status,'pending_review');
});
test('UTF-8 filenames survive multipart upload, attachments and download without changing file bytes',async()=>{
  const disposition=require('content-disposition');
  for(const filename of ['采购合同_50%_é_📄.docx','plain-contract.docx','海外仓合同（扫描件）.pdf']){
    const bytes=filename.endsWith('.pdf')?Buffer.from('%PDF-1.4\n% encoding fixture'):docx();
    const result=await requestAs('business','post','/api/contracts/upload').field('background',JSON.stringify(background)).attach('file',bytes,filename).expect(201);
    assert.equal(result.body.contract.title,filename);assert.equal(result.body.version.filename,filename);
    const downloaded=await agents.business.get('/api/files/'+result.body.version.id+'?download=1').buffer(true).parse((response,done)=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>done(null,Buffer.concat(chunks)));response.on('error',done);}).expect(200);
    assert.equal(disposition.parse(downloaded.headers['content-disposition']).parameters.filename,filename);assert.deepEqual(downloaded.body,bytes);
    const c=await db('la_contracts').where({id:result.body.contract.id}).first();
    const attachment=await requestAs('business','post',`/api/contracts/${c.id}/versions`).field('revision',c.revision).field('kind','supplement').attach('file',bytes,'补充材料_'+filename).expect(201);
    assert.equal(attachment.body.version.filename,'补充材料_'+filename);
  }
});
test('unpublished specialty stops after classification without presenting zero findings as a completed review',async()=>{
  const response=await requestAs('business','post','/api/contracts/upload').field('background',JSON.stringify(background)).attach('file',docx('虚构软件服务合同。'),'软件服务合同.docx').expect(201);
  let reviewed=false;
  await processReview(db,response.body.reviewId,{gateway:{classify:async()=>({typeId:'software_license',tags:[],confirmed:false}),review:async()=>{reviewed=true;throw new Error('must not run');}}});
  const run=await db('la_reviews').where({id:response.body.reviewId}).first();
  assert.equal(run.status,'waiting_input');assert.equal(run.error_code,'NO_PUBLISHED_RULES');assert.equal(reviewed,false);
  assert.ok((await db('la_versions').where({id:response.body.version.id}).first()).parsed.blocks.length);
  assert.equal((await db('la_findings').where({review_id:run.id})).length,0);assert.equal((await db('la_decisions').where({review_id:run.id})).length,0);
});
test('Socket.IO requires a session and refuses unauthorized contract subscriptions',async()=>{
  const http=require('node:http'),{io}=require('socket.io-client'),{setupRealtime}=require('../../pilot/realtime');
  const server=http.createServer(appHandle.app),realtime=setupRealtime(server,db,appHandle.sessionMiddleware);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`,clients=[];
  const connect=(cookie)=>new Promise((resolve,reject)=>{const client=io(url,{transports:['websocket'],reconnection:false,timeout:2000,...(cookie?{extraHeaders:{Cookie:cookie}}:{})});clients.push(client);client.once('connect',()=>resolve(client));client.once('connect_error',reject);});
  try{
    await assert.rejects(()=>connect(),/unauthorized/);
    const session=await supertest(server).get('/api/auth/session').expect(200),cookie=session.headers['set-cookie'].map(s=>s.split(';')[0]).join('; ');
    const login=await supertest(server).post('/api/auth/login').set('Cookie',cookie).set('X-CSRF-Token',session.body.csrf).send({username:'other',password}).expect(200);
    const authenticatedCookie=login.headers['set-cookie'].map(s=>s.split(';')[0]).join('; '),client=await connect(authenticatedCookie);
    const result=await client.timeout(2000).emitWithAck('join-contract',created.contract.id);assert.deepEqual(result,{ok:false});
  }finally{clients.forEach(c=>c.disconnect());await realtime.close();}
});
test('publisher workflow creates immutable rule version and review remains separate from legal approval',async()=>{
  const body={name:'虚构采购专项',scope:{level:'type',typeIds:['procurement']},rules:[{id:'delivery',title:'交付期限',instruction:'核查交付时间是否明确',severity:'high',mandatory:true}],knowledge:[]};
  ruleVersion=await db.transaction(trx=>createDraft(trx,'test-procurement',body,users.publisher.id));await publish(ruleVersion);
  await processReview(db,created.reviewId,{gateway});assert.equal((await db('la_reviews').where({id:created.reviewId}).first()).status,'waiting_input');
  const before=await getC();created.reviewId=(await requestAs('legal','post','/api/reviews',{contractId:before.id,revision:before.revision}).expect(202)).body.reviewId;
  await processReview(db,created.reviewId,{gateway});const c=await getC(),run=await agents.legal.get('/api/reviews/'+created.reviewId).expect(200);assert.equal(run.body.status,'completed');assert.equal(c.legal_status,'pending_review');assert.equal(run.body.findings.length,1);
  await requestAs('legal','post',`/api/reviews/${created.reviewId}/decision`,{outcome:'agree',revision:c.revision}).expect(409);
  await requestAs('business','post',`/api/reviews/${created.reviewId}/decision`,{outcome:'agree',revision:c.revision}).expect(403);
});
test('unresolved findings and unconfirmed classification block final conclusion; record revisions prevent overwrite',async()=>{
  let c=await getC();await requestAs('legal','put',`/api/contracts/${c.id}/classification`,{revision:c.revision,typeId:'procurement',tags:[],perspectiveConfirmed:true}).expect(200);
  c=await getC();await requestAs('legal','post',`/api/reviews/${created.reviewId}/decision`,{outcome:'agree',revision:c.revision}).expect(409);
  const f=await db('la_findings').where({review_id:created.reviewId}).first();await requestAs('legal','put',`/api/reviews/${created.reviewId}/findings/${f.id}/disposition`,{revision:f.revision,action:'reject'}).expect(400);
  await db('la_findings').where({id:f.id}).update({check_status:'uncertain'});
  await requestAs('legal','put',`/api/reviews/${created.reviewId}/findings/${f.id}/disposition`,{revision:f.revision,action:'accept'}).expect(400);
  c=await getC();await requestAs('legal','post',`/api/reviews/${created.reviewId}/return`,{revision:c.revision,reason:'请业务补充交付日期与验收约定'}).expect(200);
  const returned=await agents.business.get('/api/contracts/'+c.id).expect(200);assert.equal(returned.body.returns[0].reason,'请业务补充交付日期与验收约定');
  await requestAs('legal','put',`/api/reviews/${created.reviewId}/findings/${f.id}/disposition`,{revision:f.revision,action:'accept',reason:'退回后的原预审应冻结，不能继续修改'}).expect(409);
  c=await getC(); created.reviewId=(await requestAs('legal','post','/api/reviews',{contractId:c.id,revision:c.revision}).expect(202)).body.reviewId; await processReview(db,created.reviewId,{gateway});
  c=await getC(); const newFinding=await db('la_findings').where({review_id:created.reviewId}).first(); await requestAs('legal','put',`/api/reviews/${created.reviewId}/findings/${newFinding.id}/disposition`,{revision:newFinding.revision,action:'accept',reason:'交付日期由法务记录为附条件同意的前置条件'}).expect(200);
  c=await getC();await requestAs('legal','post',`/api/reviews/${created.reviewId}/decision`,{outcome:'conditional',revision:c.revision}).expect(400);
  await requestAs('legal','post',`/api/reviews/${created.reviewId}/decision`,{outcome:'conditional',conditions:'补充约定交付日期后再签署',revision:c.revision}).expect(201);
  assert.equal((await getC()).legal_status,'finalized');
  await agents.legal.get(`/api/reviews/${created.reviewId}/report?format=docx`).expect(200).expect('Content-Type',/wordprocessingml/);
  const pdf=await agents.legal.get(`/api/reviews/${created.reviewId}/report?format=pdf`).expect(200).expect('Content-Type',/pdf/);assert.ok(Buffer.isBuffer(pdf.body));assert.equal(pdf.body.subarray(0,5).toString(),'%PDF-');
});
test('same content is deduplicated; changed file invalidates conclusion and old review cannot approve new version',async()=>{
  let c=await getC();const duplicate=await requestAs('business','post',`/api/contracts/${c.id}/versions`).field('revision',c.revision).attach('file',docx(),'same.docx').expect(200);assert.equal(duplicate.body.duplicate,true);assert.equal(duplicate.body.version.id,created.version.id);
  c=await getC();const next=await requestAs('business','post',`/api/contracts/${c.id}/versions`).field('revision',c.revision).attach('file',docx('虚构采购合同。甲方修改付款方式，交付期限另行商议。'),'采购合同_修订稿（第二版）.docx').expect(201);assert.equal(next.body.version.version_no,2);assert.equal(next.body.version.filename,'采购合同_修订稿（第二版）.docx');
  c=await getC();assert.equal(c.legal_status,'pending_review');assert.equal(c.classification.confirmed,false);assert.notEqual(c.current_review_id,created.reviewId);
  await requestAs('legal','post',`/api/reviews/${created.reviewId}/decision`,{outcome:'agree',revision:c.revision}).expect(409);
  assert.equal((await db('la_decisions').where({review_id:created.reviewId}).first()).version_id,created.version.id);
});
test('new rule publication does not mutate historical review snapshot',async()=>{
  const before=(await db('la_reviews').where({id:created.reviewId}).first()).snapshot;
  const p=await db.transaction(trx=>createDraft(trx,'test-procurement',{name:'新标准',scope:ruleVersion.scope,rules:[{...ruleVersion.rules[0],instruction:'全新审查标准'}],knowledge:[]},users.publisher.id));await publish(p);
  assert.deepEqual((await db('la_reviews').where({id:created.reviewId}).first()).snapshot,before);
  assert.equal((await db('la_rule_versions').where({id:ruleVersion.id}).first()).state,'retired');
  await requestAs('publisher','post',`/api/rule-pack-versions/${p.id}/publish`,{revision:3}).expect(409);
});
test('forged office callbacks and off-origin save URLs are rejected',async()=>{
  config.office.secret='office-test-secret-at-least-32-characters';config.office.internalUrl='http://localhost:8081';
  await supertest(appHandle.app).post('/api/onlyoffice/callback').send({key:'forged',status:2,url:'http://evil.example'}).expect(401);
  const key=randomUUID(),c=await getC();await db('la_editor_sessions').insert({key,contract_id:c.id,version_id:c.current_version_id,user_id:users.legal.id,expires_at:new Date(Date.now()+60000)});
  const payload={key,status:2,url:'http://evil.example/download'};await supertest(appHandle.app).post('/api/onlyoffice/callback').send({...payload,token:jwt.sign(payload,config.office.secret)}).expect(403);
});
test('DingTalk repeated event is durable and idempotent; same attachment updates by hash',async()=>{
  Object.assign(config.ding,{enabled:true,clientId:'test-app',secret:'fixture-secret'});
  await db('la_dingtalk_accounts').insert({user_id:users.business.id,client_id:'test-app',ding_user_id:'member-1',display_name:'收件人'});
  const event={processInstanceId:'approval-1',processCode:'test-code',eventType:'bpms_task_change'};const first=await persistEvent(db,event,'dedup-event','test-app');assert.equal(await persistEvent(db,event,'dedup-event','test-app'),first);
  const api={detail:async()=>({processCode:'test-code',tasks:[{userId:'member-1',status:'NEW',result:'NONE'}],formComponentValues:[{name:'主体',value:'虚构公司'},{name:'立场',value:'采购方'},{name:'目的',value:'采购'},{name:'附件',value:JSON.stringify([{fileId:'file-1',fileName:'approval.docx'}])}]}),attachment:async()=>docx()};
  await processIntegration(db,first,api);assert.equal((await db('la_integration_events').where({id:first}).first()).status,'completed');
  const count=(await db('la_contracts')).length;await processIntegration(db,first,api);assert.equal((await db('la_contracts')).length,count);
  const second=await persistEvent(db,event,'different-event','test-app');await processIntegration(db,second,api);assert.equal((await db('la_contracts')).length,count);
  const apiChanged={...api,detail:async()=>{const d=await api.detail();d.formComponentValues.find(f=>f.name==='附件').value=JSON.stringify([{fileId:'file-2',fileName:'approval.docx'}]);return d;},attachment:async()=>docx('虚构采购合同。修订文件内容。交付期限另行商议。')};
  const third=await persistEvent(db,event,'changed-attachment','test-app');await processIntegration(db,third,apiChanged);assert.equal((await db('la_contracts')).length,count);const associated=await db('la_source_files').where({contract_id:(await db('la_contracts').where({source:'dingtalk'}).first()).id}).first();assert.equal((await db('la_versions').where({id:associated.version_id}).first()).version_no,2);
});
test('OnlyOffice repeated save A after save B does not create or revert a version',async()=>{
  const http=require('node:http'),server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end(docx('虚构采购合同。交付期限另行商议。'+(req.url==='/a'?'修订A':'修订B')));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{config.office.internalUrl=`http://127.0.0.1:${server.address().port}`;const c=await getC(),key=randomUUID();await db('la_editor_sessions').insert({key,contract_id:c.id,version_id:c.current_version_id,user_id:users.legal.id,expires_at:new Date(Date.now()+60000)});
    const send=async path=>{const payload={key,status:6,url:config.office.internalUrl+path};return supertest(appHandle.app).post('/api/onlyoffice/callback').send({...payload,token:jwt.sign(payload,config.office.secret)}).expect(200);};
    await send('/a');await send('/b');const latest=await getC(),count=(await db('la_versions').where({contract_id:c.id})).length;await send('/a');assert.equal((await db('la_versions').where({contract_id:c.id})).length,count);assert.equal((await getC()).current_version_id,latest.current_version_id);
  }finally{await new Promise(r=>server.close(r));}
});
test('assignment and server pagination preserve ACL; signed/supplement files do not replace the reviewed version',async()=>{
  const response=await requestAs('business','post','/api/contracts/upload').field('background',JSON.stringify(background)).attach('file',docx(),'archive-fixture.docx').expect(201),item=response.body;
  await processReview(db,item.reviewId,{gateway});let c=await db('la_contracts').where({id:item.contract.id}).first();
  await requestAs('legal','put',`/api/contracts/${c.id}/assignment`,{revision:c.revision,reviewerId:users.business.id}).expect(400);
  await requestAs('legal','put',`/api/contracts/${c.id}/assignment`,{revision:c.revision,reviewerId:users.legal.id}).expect(200);
  const list=await agents.legal.get('/api/contracts?page=1&reviewer='+users.legal.id+'&type=procurement').expect(200);assert.equal(list.body.total,1);assert.equal(list.body.items[0].id,c.id);
  assert.equal((await agents.other.get('/api/contracts?page=1&reviewer='+users.legal.id).expect(200)).body.total,0);
  await agents.legal.get('/api/contracts?page=-1').expect(400);
  c=await db('la_contracts').where({id:c.id}).first();await requestAs('legal','put',`/api/contracts/${c.id}/classification`,{revision:c.revision,typeId:'procurement',tags:[],perspectiveConfirmed:true}).expect(200);
  const f=await db('la_findings').where({review_id:item.reviewId}).first();await requestAs('legal','put',`/api/reviews/${item.reviewId}/findings/${f.id}/disposition`,{revision:f.revision,action:'accept'}).expect(200);
  c=await db('la_contracts').where({id:c.id}).first();await requestAs('legal','post',`/api/reviews/${item.reviewId}/decision`,{revision:c.revision,outcome:'agree'}).expect(201);
  for(const kind of ['supplement','signed']){c=await db('la_contracts').where({id:c.id}).first();await requestAs('business','post',`/api/contracts/${c.id}/versions`).field('revision',c.revision).field('kind',kind).attach('file',docx('虚构'+kind+'文件'),'attachment.docx').expect(201);}
  c=await db('la_contracts').where({id:c.id}).first();assert.equal(c.current_version_id,item.version.id);assert.equal(c.current_review_id,item.reviewId);assert.equal(c.legal_status,'finalized');
  const signed=await db('la_versions').where({contract_id:c.id,kind:'signed'}).first();await requestAs('legal','post',`/api/contracts/${c.id}/archive`,{revision:c.revision,signedVersionId:signed.id,manuallyReturned:true,note:'虚构样本人工回传测试'}).expect(201);
  const archived=await agents.legal.get('/api/contracts/'+c.id).expect(200);assert.equal(archived.body.archives[0].signed_version_id,signed.id);assert.equal(archived.body.current_version_id,item.version.id);
});
test('cancellation accepted before finalization cannot be overwritten by completion',async()=>{
  const response=await requestAs('business','post','/api/contracts/upload').field('background',JSON.stringify(background)).attach('file',docx(),'cancel-fixture.docx').expect(201);
  let cancelled=false; await processReview(db,response.body.reviewId,{gateway,notify:async(_,event)=>{if(event.stage==='validating'&&!cancelled){cancelled=true;const c=await db('la_contracts').where({id:response.body.contract.id}).first();await requestAs('business','post','/api/reviews/'+response.body.reviewId+'/cancel',{revision:c.revision}).expect(200);}}});
  assert.equal((await db('la_reviews').where({id:response.body.reviewId}).first()).status,'cancelled');
});
test('completion committed first rejects a later cancellation',async()=>{
  const response=await requestAs('business','post','/api/contracts/upload').field('background',JSON.stringify(background)).attach('file',docx(),'complete-before-cancel.docx').expect(201);
  await processReview(db,response.body.reviewId,{gateway});
  const c=await db('la_contracts').where({id:response.body.contract.id}).first();
  await requestAs('business','post',`/api/reviews/${response.body.reviewId}/cancel`,{revision:c.revision}).expect(409).expect(res=>assert.equal(res.body.code,'CANCEL_STATE'));
  assert.equal((await db('la_reviews').where({id:response.body.reviewId}).first()).status,'completed');
});
test('export failure is recorded without downgrading a completed review',async()=>{
  const response=await requestAs('business','post','/api/contracts/upload').field('background',JSON.stringify(background)).attach('file',docx(),'export-failure.docx').expect(201);
  const storage=require('../../pilot/storage'),original=storage.exportVersion;storage.exportVersion=async()=>{throw Object.assign(new Error('export failed'),{code:'EXPORT_FAILED'});};
  try { await processReview(db,response.body.reviewId,{gateway}); } finally { storage.exportVersion=original; }
  const run=await db('la_reviews').where({id:response.body.reviewId}).first(),step=await db('la_job_steps').where({review_id:response.body.reviewId,stage:'export'}).first();
  assert.equal(run.status,'completed');assert.equal(step.status,'failed');
});
test('pg-boss survives dispatcher restart and processes transactional outbox exactly once',async()=>{
  queue=await createQueue(db,{work:false});await queue.dispatch();const row=await db('la_outbox').where({queue:'review'}).first();assert.ok(row.sent_at);assert.ok(await queue.boss.getJobById('review',row.id));
  // Simulate a crash after send but before marking the outbox delivered.
  await db('la_outbox').where({id:row.id}).update({sent_at:null});await queue.stop();queue=await createQueue(db,{work:false});await queue.dispatch();assert.ok((await db('la_outbox').where({id:row.id}).first()).sent_at);
  const jobs=await db.withSchema('legal_queue').table('job').where({id:row.id});assert.equal(jobs.length,1);
  await queue.stop();queue=await createQueue(db,{reviewOptions:{gateway}});
  for(let n=0;n<50;n++){const running=await db('la_reviews').where({status:'queued'}).first();if(!running)break;await new Promise(r=>setTimeout(r,200));}
  assert.equal((await db('la_reviews').where({status:'queued'})).length,0);
});
test('backup restores real PostgreSQL tables and immutable file hashes into an isolated empty target',async()=>{
  const {createBackup,restoreBackup}=require('../../pilot/backup');await queue.stop();queue=null;
  const backup=await createBackup(db),name='legal_restore_'+randomUUID().replaceAll('-','');await rootDb.raw(`CREATE DATABASE "${name}"`);const url=new URL(config.databaseUrl);url.pathname='/'+name;const target=createDb(url.href);
  try{const result=await restoreBackup(target,{directory:backup.directory,databaseUrl:url.href,targetRoot:config.dataRoot+'-restore'});assert.ok(result.versions>=4);assert.equal((await target('la_contracts')).length,(await db('la_contracts')).length);assert.equal((await target('la_decisions')).length,2);assert.equal((await target('la_sessions')).length,0);}finally{await target.destroy();await rootDb.raw(`DROP DATABASE "${name}"`);}
});
