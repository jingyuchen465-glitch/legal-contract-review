const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const supertest = require('supertest');
const { config } = require('../../pilot/config');
const { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli');
const { hashPassword } = require('../../pilot/auth');
const { createApp } = require('../../pilot/app');
const { createDraft } = require('../../pilot/rules');
const { createGateway } = require('../../pilot/model');
const { processEvaluation } = require('../../pilot/evaluation');
const { enqueueReview, processReview } = require('../../pilot/workflow');
const { examplePacks } = require('../../pilot/seeds');
const { matchRules } = require('../../pilot/rules');
let root, db, database, handle, agent, csrf, userId, contractId, versionId, reviewId, findingId, original;
const background = { ourEntity: '虚构公司', perspective: '采购方', purpose: '设备采购' };
const document = { blocks: [{ id: 'b1', text: '验收合格后30日内付款。' }], parserVersion: 'fixture' };
const rule = { id: 'payment', title: '付款期限', instruction: '检查付款期限', severity: 'high', mandatory: true, tags: [] };
const call = (method, url, body) => agent[method]('/api'+url).set('X-CSRF-Token', csrf).send(body);
const makeFeedback = async kind => (await call('post','/feedback-cases',{reviewId,findingId,kind,content:'法务确认：已约定验收后30日付款，应当通过。'}).expect(201)).body;
const publish = async p => { await call('post',`/rule-pack-versions/${p.id}/submit`,{revision:p.revision}).expect(200); await call('post',`/rule-pack-versions/${p.id}/publish`,{revision:p.revision+1}).expect(200); };
before(async () => {
  root=createDb();database='legal_test_feedback_'+randomUUID().replaceAll('-','');await root.raw(`CREATE DATABASE "${database}"`);
  const url=new URL(config.databaseUrl);url.pathname='/'+database;config.databaseUrl=url.href;db=createDb();
  // Seed a real legacy account before the unification migration.
  await db.migrate.up({directory:path.resolve(__dirname,'../../pilot/migrations'),tableName:'la_migrations',name:'001_core.js'});
  userId=randomUUID();const password='feedback-test-password-123';
  await db('la_users').insert({id:userId,username:'legacy-legal',display_name:'测试法务',department:'旧部门',roles:JSON.stringify(['legal']),password_hash:await hashPassword(password)});
  await migrate(db);assert.deepEqual((await db('la_users').where({id:userId}).first()).roles,['admin']);
  handle=createApp(db);agent=supertest.agent(handle.app);const session=await agent.get('/api/auth/session');const login=await agent.post('/api/auth/login').set('X-CSRF-Token',session.body.csrf).send({username:'legacy-legal',password}).expect(200);csrf=login.body.csrf;
  original=await db.transaction(trx=>createDraft(trx,'feedback-pack',{name:'付款审查',scope:{level:'type',typeIds:['procurement']},rules:[rule],knowledge:[]},userId));await publish(original);
  contractId=randomUUID();versionId=randomUUID();reviewId=randomUUID();findingId=randomUUID();
  await db('la_contracts').insert({id:contractId,number:'FEEDBACK-TEST',title:'测试合同',department:'其他部门',background:JSON.stringify(background),classification:JSON.stringify({typeId:'procurement',tags:[],confirmed:true,versionId})});
  await db('la_versions').insert({id:versionId,contract_id:contractId,version_no:1,kind:'contract',filename:'fixture.docx',sha256:'a'.repeat(64),storage_key:'objects/fixture',media_type:'application/docx',size:10,source_action:'fixture',parsed:JSON.stringify(document)});
  await db('la_reviews').insert({id:reviewId,contract_id:contractId,version_id:versionId,status:'completed',snapshot:JSON.stringify({rules:[{...rule,packVersionId:original.id}],packs:[{id:original.id,packId:original.pack_id}],classification:{typeId:'software_license',tags:[]},background})});
  await db('la_contracts').where({id:contractId}).update({current_review_id:reviewId,current_version_id:versionId});
  await db('la_findings').insert({id:findingId,review_id:reviewId,rule_id:rule.id,title:rule.title,check_status:'fail',severity:'high',kind:'clause',evidence:JSON.stringify([{blockId:'b1',quote:'验收合格后30日内付款'}]),reason:'未约定付款期限',disposition:JSON.stringify({action:'reject',reason:'已明确付款期限'})});
});
after(async()=>{await handle?.close();await db?.destroy();if(root&&database){await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()',[database]);await root.raw(`DROP DATABASE "${database}"`);}await root?.destroy();});

test('unified admin reads all contracts, creates only admin accounts and retains audit identity',async()=>{
  await call('get','/contracts/'+contractId).expect(200);const list=(await call('get','/contracts?page=1').expect(200)).body;assert.equal(list.total,1);
  for(const route of ['/users','/rule-packs','/feedback-cases','/evaluation-cases','/evaluations','/settings','/operations','/dingtalk/account'])await call('get',route).expect(200);
  const account=(await call('post','/users',{username:'second-admin',displayName:'第二位法务',password:'test-password-second-123',department:'法务'}).expect(201)).body;assert.deepEqual(account.roles,['admin']);
  assert.equal((await db('la_audit').where({action:'user.create',entity_id:account.id}).first()).actor_id,userId);
  const disabled=(await call('post','/users',{username:'disabled-admin',displayName:'停用账号',password:'disabled-password-123',active:false}).expect(201)).body;assert.equal(disabled.active,false);
});
test('feedback draft is idempotent, editable with revision, publishes actual edited content and preserves history',async()=>{
  const f=await makeFeedback('false_positive');const [a,b]=await Promise.all([call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201),call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201)]);
  assert.equal(a.body.draft.id,b.body.draft.id);assert.equal(a.body.sourcePublishedVersionId,original.id);
  const draft=a.body.draft;assert.equal((await db('la_rule_versions').where({id:original.id}).first()).state,'published');
  const content={name:draft.name,scope:draft.scope,rules:[{...rule,instruction:'验收通过后30日付款属于正常约定'}],knowledge:[],revision:draft.revision};
  const edited=(await call('put',`/rule-pack-versions/${draft.id}`,content).expect(200)).body;
  await call('put',`/rule-pack-versions/${draft.id}`,content).expect(409);await publish(edited);
  const saved=await db('la_feedback').where({id:f.id}).first();assert.equal(saved.state,'published');assert.equal(saved.rule_version_id,draft.id);
  assert.equal((await db('la_rule_versions').where({id:draft.id}).first()).rules[0].instruction,content.rules[0].instruction);
  assert.equal((await db('la_reviews').where({id:reviewId}).first()).snapshot.rules[0].instruction,rule.instruction);
});
test('unmatched findings require explicit pack selection and retired feedback cannot change rules',async()=>{
  const manualId=randomUUID();await db('la_findings').insert({id:manualId,review_id:reviewId,rule_id:'manual-test',title:'人工漏报',check_status:'fail',severity:'high',kind:'uncertain',reason:'人工新增'});
  const f=(await call('post','/feedback-cases',{reviewId,findingId:manualId,kind:'false_negative',content:'补充质保期限检查'}).expect(201)).body;
  const rejected=await call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(409);assert.equal(rejected.body.code,'RULE_SELECTION_REQUIRED');
  const result=(await call('post',`/feedback-cases/${f.id}/rule-draft`,{packId:'feedback-pack'}).expect(201)).body;assert.equal(result.draft.rules.length,2);assert.notEqual(result.ruleId,'manual-test');
  assert.equal((await call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201)).body.ruleId,result.ruleId);
  const current=await db('la_feedback').where({id:f.id}).first();await call('patch',`/feedback-cases/${f.id}`,{state:'retired',revision:current.revision}).expect(200);
  await call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(409);
});
test('trial feedback with example version IDs requests an official pack without querying UUIDs',async()=>{
  const matched=await matchRules(db,{typeId:'software_license',tags:[]},examplePacks(),{mode:'trial'});
  const trialId=randomUUID(),trialFindingId=randomUUID();
  await db('la_reviews').insert({id:trialId,contract_id:contractId,version_id:versionId,status:'completed',snapshot:JSON.stringify({...matched,reviewMode:'trial',background})});
  await db('la_findings').insert({id:trialFindingId,review_id:trialId,rule_id:'payment',title:'付款条件',check_status:'fail',severity:'high',kind:'clause',reason:'测试反馈'});
  for (const kind of ['rule','normal_expression']) {
    const f=(await call('post','/feedback-cases',{reviewId:trialId,findingId:trialFindingId,kind,content:'应当结合验收条件判断付款风险'}).expect(201)).body;
    const endpoint=kind==='rule'?'rule-draft':'knowledge-draft';
    const rejected=await call('post',`/feedback-cases/${f.id}/${endpoint}`,{});
    assert.equal(rejected.status,409,JSON.stringify(rejected.body));
    assert.equal(rejected.body.code,'RULE_SELECTION_REQUIRED');
    assert.doesNotMatch(rejected.body.message,/select |uuid|invalid input/i);
    assert.equal((await db('la_feedback').where({id:f.id}).first()).draft_rule_version_id,null);
    const result=(await call('post',`/feedback-cases/${f.id}/${endpoint}`,{packId:'feedback-pack'}).expect(201)).body;
    assert.equal(result.packId,'feedback-pack');assert.equal(result.draft.state,'draft');
  }
});
test('trial feedback resolves the exact published pack from its snapshot and keeps examples unchanged',async()=>{
  const examples=examplePacks();
  const matched=await matchRules(db,{typeId:'software_license',tags:[]},examples,{mode:'trial'});
  const trialId=randomUUID();
  await db('la_reviews').insert({id:trialId,contract_id:contractId,version_id:versionId,status:'completed',snapshot:JSON.stringify({...matched,reviewMode:'trial',background})});
  const official=[];
  try {
    for (const packId of ['common','software']) {
      const example=examples.find(p=>p.pack_id===packId);
      const source=await db.transaction(trx=>createDraft(trx,packId,example,userId));official.push(source);await publish(source);
      const sourceRule=example.rules[0],trialFindingId=randomUUID();
      await db('la_findings').insert({id:trialFindingId,review_id:trialId,rule_id:sourceRule.id,title:sourceRule.title,check_status:'fail',severity:sourceRule.severity,kind:'clause',reason:'测试反馈'});
      const f=(await call('post','/feedback-cases',{reviewId:trialId,findingId:trialFindingId,kind:'rule',content:'法务补充适用边界'}).expect(201)).body;
      const result=(await call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201)).body;
      assert.equal(result.packId,packId);assert.equal(result.sourcePublishedVersionId,source.id);assert.equal(result.ruleId,sourceRule.id);
      assert.equal(result.draft.state,'draft');assert.notEqual(result.draft.id,source.id);
      assert.equal((await call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201)).body.draft.id,result.draft.id);
      assert.equal((await db('la_rule_versions').where({id:source.id}).first()).state,'published');
    }
    assert.deepEqual((await db('la_reviews').where({id:trialId}).first()).snapshot.rules,matched.rules);
  } finally {
    await db('la_rule_versions').whereIn('id',official.map(p=>p.id)).update({state:'retired'});
  }
});
test('normal-expression feedback requires unambiguous target and knowledge stays draft until publication',async()=>{
  const f=await makeFeedback('normal_expression');const result=(await call('post',`/feedback-cases/${f.id}/knowledge-draft`,{}).expect(201)).body;
  assert.equal(result.draft.state,'draft');assert.match(result.draft.knowledge[0].source,/FEEDBACK-TEST/);assert.equal(result.draft.knowledge[0].content,f.content);
  const repeated=(await call('post',`/feedback-cases/${f.id}/knowledge-draft`,{}).expect(201)).body;assert.equal(repeated.draft.id,result.draft.id);
});
test('feedback samples prefer human type and rejected false positives, require confirmation, deduplicate by source',async()=>{
  const f=await makeFeedback('false_positive');const p=(await call('get',`/feedback-cases/${f.id}/evaluation-preview`).expect(200)).body;
  assert.equal(p.expected.typeId,'procurement');assert.deepEqual(p.expected.riskRuleIds,[]);assert.deepEqual(p.document,document);
  const body={name:'法务样本',split:'development',expected:p.expected};await call('post',`/feedback-cases/${f.id}/evaluation-case`,body).expect(400);
  const saved=(await call('post',`/feedback-cases/${f.id}/evaluation-case`,{...body,confirmed:true}).expect(201)).body;
  const repeated=(await call('post',`/feedback-cases/${f.id}/evaluation-case`,{...body,confirmed:true}).expect(201)).body;assert.equal(saved.id,repeated.id);
  await call('post',`/feedback-cases/${f.id}/evaluation-case`,{...body,confirmed:true,expected:{...p.expected,highRiskRuleIds:['payment']}}).expect(400);
});
test('classification correction edits corrected type, enforces revision and only published guidance enters model prompt',async()=>{
  const f=await makeFeedback('classification');const draft=(await call('post',`/feedback-cases/${f.id}/classification-draft`,{}).expect(201)).body.draft;assert.equal(draft.type_id,'procurement');
  const input={description:'设备采购按采购分类',include:['设备供货'],exclude:['纯软件许可'],examples:['采购设备'],revision:draft.revision};
  const edited=(await call('put',`/classification-guidance-versions/${draft.id}`,input).expect(200)).body;
  await call('put',`/classification-guidance-versions/${draft.id}`,input).expect(409);
  Object.assign(config.model,{name:'fixture',key:'fixture',baseUrl:'http://127.0.0.1:1/v1'});let prompt;
  const gateway=createGateway(db,{fetchImpl:async(url,options)=>{prompt=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({typeId:'procurement',tags:[],evidence:[{blockId:'b1',quote:'验收合格后30日内付款'}],uncertain:false})}}]});}});
  await gateway.classify(document);assert.ok(!prompt.messages[1].content.includes(input.description));
  await call('post',`/classification-guidance-versions/${draft.id}/publish`,{revision:edited.revision}).expect(200);
  await gateway.classify(document);assert.ok(prompt.messages[1].content.includes(input.description));
  const feedback=await db('la_feedback').where({id:f.id}).first();assert.equal(feedback.classification_version_id,draft.id);assert.equal(feedback.state,'published');
});
test('draft evaluation uses captured draft without publishing, and holdout rejects drafts',async()=>{
  const f=await makeFeedback('rule');const draft=(await call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201)).body.draft;
  await call('post','/evaluations',{split:'holdout',adapters:['llm'],draftRuleVersionId:draft.id}).expect(400);
  const run=(await call('post','/evaluations',{split:'development',adapters:['llm'],includeReview:true,draftRuleVersionId:draft.id}).expect(202)).body;
  let seen;await processEvaluation(db,run.id,{gateway:{classify:async()=>({typeId:'procurement',tags:[]}),review:async(doc,rules)=>{seen=rules;return{checks:rules.map(r=>({ruleId:r.id,status:'pass',evidence:[]})),coverage:{complete:true}};}}});
  assert.equal(seen[0].id,'payment');const evaluation=await db('la_evaluations').where({id:run.id}).first();assert.equal(evaluation.status,'completed');assert.equal(evaluation.result.snapshot.draftRuleVersionId,draft.id);assert.equal((await db('la_rule_versions').where({id:draft.id}).first()).state,'draft');
});
test('competing rule publication fails without replacing a newer official standard',async()=>{
  const one=await makeFeedback('rule'),two=await makeFeedback('rule');const a=(await call('post',`/feedback-cases/${one.id}/rule-draft`,{}).expect(201)).body.draft,b=(await call('post',`/feedback-cases/${two.id}/rule-draft`,{}).expect(201)).body.draft;
  await publish(a);await call('post',`/rule-pack-versions/${b.id}/submit`,{revision:b.revision}).expect(200);
  const rejected=await call('post',`/rule-pack-versions/${b.id}/publish`,{revision:b.revision+1}).expect(409);assert.equal(rejected.body.code,'RULE_BASE_CHANGED');
  assert.equal((await db('la_rule_versions').where({pack_id:'feedback-pack',state:'published'}).first()).id,a.id);
});

test('queued reviews pin rule and classification guidance at creation, and pending feedback is reused during publication',async()=>{
  const f=await makeFeedback('rule'),draft=(await call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201)).body.draft;
  const old=await db('la_rule_versions').where({pack_id:'feedback-pack',state:'published'}).first();
  const c=await db('la_contracts').where({id:contractId}).first();
  const queued=await db.transaction(trx=>enqueueReview(trx,c,userId));
  const changed=(await call('put',`/rule-pack-versions/${draft.id}`,{...draft,rules:[{...rule,instruction:'新发布的审查标准'}]}).expect(200)).body;
  await call('post',`/rule-pack-versions/${draft.id}/submit`,{revision:changed.revision}).expect(200);
  const responses=await Promise.all([call('post',`/rule-pack-versions/${draft.id}/publish`,{revision:changed.revision+1}).expect(200),call('post',`/feedback-cases/${f.id}/rule-draft`,{}).expect(201)]);
  assert.ok(responses[1].body.draft.id);
  const g=(await call('post','/classification-guidance/procurement/versions',{description:'新发布的分类边界'}).expect(201)).body;
  await call('post',`/classification-guidance-versions/${g.id}/publish`,{revision:g.revision}).expect(200);
  const next=await db.transaction(trx=>enqueueReview(trx,c,userId));
  const oldSnapshot=(await db('la_reviews').where({id:queued}).first()).snapshot,nextSnapshot=(await db('la_reviews').where({id:next}).first()).snapshot;
  assert.equal(oldSnapshot.publishedPacks.find(p=>p.pack_id==='feedback-pack').id,old.id);
  assert.equal(nextSnapshot.publishedPacks.find(p=>p.pack_id==='feedback-pack').id,draft.id);
  assert.notEqual(oldSnapshot.classificationGuidance.procurement.versionId,g.id);assert.equal(nextSnapshot.classificationGuidance.procurement.versionId,g.id);
  // These tasks finish after the current file changed, avoiding fixture file export.
  await db('la_contracts').where({id:contractId}).update({current_version_id:null});
  const seen=[];const gateway={classify:async()=>({typeId:'procurement',tags:[]}),review:async(doc,rules)=>{seen.push(rules);return {checks:[],coverage:{complete:true}};}};
  await processReview(db,queued,{gateway});await processReview(db,next,{gateway});
  assert.equal(seen[0][0].instruction,old.rules[0].instruction);assert.equal(seen[1][0].instruction,'新发布的审查标准');
});
