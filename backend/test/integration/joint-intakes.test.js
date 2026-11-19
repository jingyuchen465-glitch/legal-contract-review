const { test, before, after } = require('node:test');
// Explicitly exercise the retained manual grouping mode.
process.env.AUTO_REVIEW_DINGTALK_ENABLED = 'false';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const supertest = require('supertest');
const AdmZip = require('adm-zip');
const jwt = require('jsonwebtoken');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli');
const { createApp } = require('../../pilot/app');
const { hashPassword } = require('../../pilot/auth');
const { startBinding, completeBinding } = require('../../pilot/dingtalk-account');
const { persistEvent, processIntegration } = require('../../pilot/dingtalk');
const { processPreanalysis } = require('../../pilot/preanalysis');
const { processReview } = require('../../pilot/workflow');
const joint = require('../../pilot/joint-intake');
const { rules: crossRules } = require('../../pilot/joint-review');
const { processLearning } = require('../../pilot/learning');
let root, db, database, handle, owner, outsider, csrf, otherCsrf, actor, pack, groups, reviews = [];
const contents = { main:'虚构采购合同。甲方：虚构甲有限公司。乙方：虚构乙有限公司。付款期限为验收后30日，币种人民币；有效期一年。本合同优先于其他文件。', supplement:'补充协议：修改虚构采购合同付款期限为验收后60日，币种人民币。补充协议优先于原合同。', quote:'报价清单：同一采购总价1000美元，含税；交付期限另行协商。', second:'另一独立采购合同。付款期限为验收后30日。' };
function docx(text) {const z=new AdmZip();z.addFile('[Content_Types].xml',Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'));z.addFile('word/document.xml',Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));for(const e of z.getEntries())e.header.time=new Date(2020,0,1);return z.toBuffer();}
const files=Object.keys(contents).map((key,i)=>({fileId:key,fileName:i===3?'独立合同.docx':i===2?'报价.docx':'同名协议.docx'}));
const gateway={
 classify:async d=>({typeId:'procurement',tags:[],evidence:[{blockId:d.blocks[0].id,quote:d.blocks[0].text}],uncertain:false}),
 preAnalyze:async d=>({contractType:'采购合同',parties:[{name:'虚构甲有限公司',role:'采购方',label:'甲方',evidence:[]}],reviewPoints:[{title:'核对付款期限',instruction:'明确付款条件',evidence:[]}],corePurposes:['保障付款与交付安排']}),
 groupDocuments:async profiles=>({groups:[{name:'AI 建议交易组',mainDocumentId:profiles[0].documentId,materials:[]}],excluded:[],notes:'其余附件待确认'}),
 review:async(d,rules)=>({checks:rules.map(r=>({ruleId:r.id,title:r.title,status:'uncertain',kind:'uncertain',severity:'medium',reason:'待核实交易条件',suggestion:'在付款条款中明确【待双方确认】的付款条件。',evidence:[{blockId:d.blocks[0].id,quote:d.blocks[0].text}],legalRefIds:[]})),coverage:{complete:true,totalRules:rules.length,checkedRules:rules.length}}),
 jointFacts:async blocks=>({facts:blocks.flatMap(b=>['amendments','amounts_terms','precedence'].map(topic=>({topic,summary:'测试要素',evidence:[{blockId:b.id,quote:b.text}]})))}),
 jointCompare:async input=>({checks:crossRules.map(r=>({ruleId:r.id,status:'uncertain',kind:'uncertain',severity:'high',reason:'跨文件约定存在差异，生效依据待核实',suggestion:'在双方确认后，于主合同补充适用范围和变更约定。',evidence:input.blocks.map(b=>({blockId:b.id,quote:b.text})),legalRefIds:[]})),relations:['amendments','amounts_terms','precedence'].map(category=>({category,effect:'uncertain',before:input.blocks.slice(0,1).map(b=>({blockId:b.id,quote:b.text})),after:input.blocks.slice(1,2).map(b=>({blockId:b.id,quote:b.text})),basis:[],explanation:'双方原文可核对，但效力关系待确认',applicableText:''})),suggestions:[{versionId:input.documents[0].versionId,text:'补充双方明确确认的适用约定。'}]})
};
async function receive(instance, attachments=files, override={}) {const id=await persistEvent(db,{processInstanceId:instance,eventType:'bpms_task_change'},randomUUID(),'fixture-app');await processIntegration(db,id,{detail:async()=>({title:'虚构多附件审批',tasks:[{userId:'fixture-user',status:'NEW',result:'NONE'}],formComponentValues:[{name:'审批附件',value:JSON.stringify(attachments)}]}),attachment:async(_id,file)=>{if(override[file.fileId] instanceof Error)throw override[file.fileId];return docx(override[file.fileId]||contents[file.fileId]||'虚构新附件');}});return db('la_integration_events').where({id}).first();}
const getIntake=async()=> (await owner.get('/api/dingtalk/intakes/'+pack.id).expect(200)).body;
const getContract=async id=>(await owner.get('/api/contracts/'+id).expect(200)).body;
async function analyze(p=pack){const row=await db('la_dingtalk_intakes').where({id:p.id}).first();await joint.analyze(db,p.id,row.analysis_token,{gateway});}
async function startGroup(g){let c=await getContract(g.contractId);await processPreanalysis(db,c.current_preanalysis_id,{gateway});c=await getContract(g.contractId);const j=c.preanalysis,t=j.result.templates.find(t=>t.id===j.result.templateId);return(await owner.post(`/api/preanalyses/${j.id}/start`).set('X-CSRF-Token',csrf).send({revision:j.revision,contractRevision:c.revision,selection:{partyId:j.result.parties[0].id,typeId:'procurement',templateId:t.id,pointIds:[t.points[0].id],corePurposes:['保障付款和交付']}}).expect(202)).body.reviewId;}
before(async()=>{
 root=createDb();database='legal_test_joint_'+randomUUID().replaceAll('-','');await root.raw(`CREATE DATABASE "${database}"`);const url=new URL(config.databaseUrl);url.pathname='/'+database;config.databaseUrl=url.href;config.dataRoot=path.resolve(__dirname,'../../../.local/test-data',database);Object.assign(config.ding,{enabled:true,clientId:'fixture-app',secret:'fixture-secret'});db=createDb();await migrate(db);await require('../../pilot/storage').initializeDirectories();handle=createApp(db);
 for(const name of ['admin','outsider']){const user={id:randomUUID(),username:name,display_name:name,department:name,roles:[name==='admin'?'admin':'business']};await db('la_users').insert({...user,roles:JSON.stringify(user.roles),password_hash:await hashPassword('fixture-only-password-1234')});const agent=supertest.agent(handle.app),s=await agent.get('/api/auth/session');const login=await agent.post('/api/auth/login').set('X-CSRF-Token',s.body.csrf).send({username:name,password:'fixture-only-password-1234'}).expect(200);if(name==='admin'){owner=agent;csrf=login.body.csrf;actor=user;}else{outsider=agent;otherCsrf=login.body.csrf;}}
 const request=new URL((await startBinding(db,actor)).url);await completeBinding(db,actor,{code:'fixture',state:request.searchParams.get('state')},{resolve:async()=>({userId:'fixture-user',displayName:'虚构收件人'})});
});
after(async()=>{await handle?.close();await db?.destroy();if(root&&database){await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()',[database]);await root.raw(`DROP DATABASE "${database}"`);}await root?.destroy();});

test('flag is off by default; legacy approvals and later attachments stay legacy after enabling',async()=>{
 assert.equal((await joint.settings(db)).enabled,false);await receive('legacy',[files[0]]);assert.equal((await db('la_dingtalk_intakes')).length,0);
 await owner.put('/api/dingtalk/intake-settings').send({enabled:true,updatedAt:null}).expect(403);
 const setting=(await owner.put('/api/dingtalk/intake-settings').set('X-CSRF-Token',csrf).send({enabled:true,updatedAt:null}).expect(200)).body;assert.equal(setting.enabled,true);
 await owner.put('/api/dingtalk/intake-settings').set('X-CSRF-Token',csrf).send({enabled:false,updatedAt:null}).expect(409);
 await owner.put('/api/dingtalk/intake-settings').set('X-CSRF-Token',csrf).send({enabled:true,updatedAt:setting.updatedAt}).expect(200);
 await receive('legacy',files.slice(0,2));assert.equal((await db('la_dingtalk_intakes')).length,0);
});
test('new approval collects every attachment once, including unsupported and failed files; raw files cannot bypass confirmation',async()=>{
 const event=await receive('new-approval',[...files,{fileId:'bad',fileName:'损坏.docx'},{fileId:'zip',fileName:'附件.zip'}],{bad:new Error('fixture download failure')});assert.equal(event.summary.collected,4);assert.equal(event.summary.failed,1);
 pack=await db('la_dingtalk_intakes').where({instance_id:'new-approval'}).first();let p=await getIntake();assert.equal(p.documents.length,6);assert.equal(p.documents.filter(d=>d.filename==='同名协议.docx').length,2);assert.equal(p.documents.find(d=>d.file_id==='bad').status,'failed');assert.equal(p.documents.find(d=>d.file_id==='zip').status,'unsupported');
 const ids=p.documents.map(d=>d.contract_id).filter(Boolean);assert.equal((await db('la_preanalyses').whereIn('contract_id',ids)).length,0);assert.equal((await db('la_reviews').whereIn('contract_id',ids)).length,0);
 const list=(await owner.get('/api/contracts?view=main&page=1').expect(200)).body.items;assert.ok(list.some(c=>c.entryType==='dingtalk_intake'));assert.ok(!list.some(c=>ids.includes(c.id)));
 for(const id of [pack.container_id,...ids]){const c=await getContract(id);await owner.post('/api/contracts/'+id+'/agent-sessions').set('X-CSRF-Token',csrf).send({revision:c.revision}).expect(409);}
 await outsider.get('/api/dingtalk/intakes/'+pack.id).expect(404);assert.equal((await outsider.get('/api/dingtalk/intakes').expect(200)).body.length,0);
 await outsider.post('/api/dingtalk/intakes/'+pack.id+'/confirm').set('X-CSRF-Token',otherCsrf).send({revision:p.revision,selection:{groups:[]}}).expect(403);
});
test('background parsing suggests groups; confirmation requires explicit assignment/exclusion and concurrency protection',async()=>{
 await analyze();let p=await getIntake();assert.equal(p.status,'ready');assert.equal(p.analysis.groups.length,1);assert.equal(p.documents.filter(d=>d.version?.parsed?.blocks.length).length,4);
 const by=key=>p.documents.find(d=>d.file_id===key).id;const selection={groups:[{name:'采购及补充协议',mainDocumentId:by('main'),materials:[{documentId:by('supplement'),role:'supplement'},{documentId:by('quote'),role:'schedule'}]},{name:'独立采购',mainDocumentId:by('second'),materials:[{documentId:by('quote'),role:'reference'}]}],excluded:[{documentId:by('bad'),reason:'已核实为无关材料，下载失败'},{documentId:by('zip'),reason:'压缩包与本次交易无关'}]};
 await owner.post(`/api/dingtalk/intakes/${p.id}/confirm`).set('X-CSRF-Token',csrf).send({revision:p.revision,selection:{...selection,excluded:[]}}).expect(400);
 await owner.put(`/api/dingtalk/intakes/${p.id}/groups`).set('X-CSRF-Token',csrf).send({revision:p.revision,selection}).expect(200);
 await owner.post(`/api/dingtalk/intakes/${p.id}/confirm`).set('X-CSRF-Token',csrf).send({revision:p.revision,selection}).expect(409);p=await getIntake();
 groups=(await owner.post(`/api/dingtalk/intakes/${p.id}/confirm`).set('X-CSRF-Token',csrf).send({revision:p.revision,selection}).expect(200)).body.groups;assert.equal(groups.length,2);
 p=await getIntake();await owner.post(`/api/dingtalk/intakes/${p.id}/confirm`).set('X-CSRF-Token',csrf).send({revision:p.revision,selection}).expect(200);assert.equal((await db('la_review_groups').where({intake_id:p.id})).length,2);assert.equal((await db('la_preanalyses').whereIn('contract_id',groups.map(g=>g.contractId))).length,0);assert.equal((await db('la_reviews').whereIn('contract_id',groups.map(g=>g.contractId)).where({engine:'harness-v1'})).length,2);
});

test('assigned counsel can open related materials across departments, but cannot cross approval boundaries',async()=>{
 const lawyer={id:randomUUID(),username:'assigned-lawyer',display_name:'跨部门承办法务',department:'independent-legal',roles:['legal']};
 await db('la_users').insert({...lawyer,roles:JSON.stringify(lawyer.roles),password_hash:await hashPassword('fixture-only-password-1234')});
 const agent=supertest.agent(handle.app),session=await agent.get('/api/auth/session');
 await agent.post('/api/auth/login').set('X-CSRF-Token',session.body.csrf).send({username:lawyer.username,password:'fixture-only-password-1234'}).expect(200);
 const g=await db('la_review_groups').where({intake_id:pack.id,active:true}).first(),main=await db('la_intake_documents').where({id:g.main_document_id}).first();
 await db('la_contracts').where({id:main.contract_id}).update({reviewer_id:lawyer.id});
 const p=(await agent.get('/api/dingtalk/intakes/'+pack.id).expect(200)).body;
 const support=p.documents.find(d=>d.file_id==='supplement');await agent.get('/api/contracts/'+support.contract_id).expect(200);
 await receive('long-approval',[files[0]]);
 const other=await db('la_dingtalk_intakes').where({instance_id:'long-approval'}).first();
 await agent.get('/api/dingtalk/intakes/'+other.id).expect(404);
 await db('la_review_groups').where({id:g.id}).update({active:false});
 await agent.get('/api/dingtalk/intakes/'+pack.id).expect(404);
 await db('la_review_groups').where({id:g.id}).update({active:true});
});

test('one Agent session reviews all grouped files and a shared update starts isolated new results',async()=>{
 const {emptyReview}=require('../helpers/agent-runtime');
 for(const group of groups){await processReview(db,group.reviewId,{runtimeFactory:emptyReview});const r=(await owner.get('/api/reviews/'+group.reviewId).expect(200)).body;assert.equal(r.status,'completed',r.error_code);assert.equal(r.snapshot.documents.length,group===groups[0]?3:2);assert.equal(r.coverage.complete,true);reviews.push(r);}
 const c=await getContract(groups[0].contractId);
 const decision=(await owner.post('/api/reviews/'+reviews[0].id+'/decision').set('X-CSRF-Token',csrf).send({revision:c.revision,outcome:'agree'}).expect(201)).body;
 assert.equal(decision.materials_snapshot.documents.length,3);
 const p=await getIntake(),quote=p.documents.find(d=>d.file_id==='quote'),support=await getContract(quote.contract_id);
 await owner.post('/api/contracts/'+support.id+'/versions').set('X-CSRF-Token',csrf).field('revision',support.revision).attach('file',docx('虚构报价新版本：交付期限应当另行约定。'),'报价新稿.docx').expect(201);
 for(const group of groups){const current=await getContract(group.contractId);assert.ok(current.current_review_id);assert.notEqual(current.current_review_id,group.reviewId);await processReview(db,current.current_review_id,{runtimeFactory:emptyReview});assert.equal((await db('la_reviews').where({id:current.current_review_id}).first()).status,'completed');}
 assert.equal((await owner.get('/api/reviews/'+reviews[0].id).expect(200)).body.isCurrent,false);
 assert.equal((await db('la_decisions').where({id:decision.id}).first()).review_id,reviews[0].id);
});
