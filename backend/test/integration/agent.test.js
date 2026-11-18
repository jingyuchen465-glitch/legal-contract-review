const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),path=require('node:path');
const supertest=require('supertest'),AdmZip=require('adm-zip');
const {config}=require('../../pilot/config'),{createDb}=require('../../pilot/db'),{migrate}=require('../../pilot/cli'),{hashPassword}=require('../../pilot/auth'),{createApp}=require('../../pilot/app');
const service=require('../../pilot/agent/service'),memory=require('../../pilot/agent/memory');
let rootDb,db,app,agent,csrf,user,database;
function docx(text='虚构采购合同。交付期限另行商议。'){const z=new AdmZip();z.addFile('word/document.xml',Buffer.from(`<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));return z.toBuffer();}
const req=(method,url,body)=>{const r=agent[method]('/api'+url).set('X-CSRF-Token',csrf);return body?r.send(body):r;};
async function upload(){return (await req('post','/contracts/upload').attach('file',docx(),'虚构合同.docx').expect(201)).body;}
const reportFor=documents=>({summary:'交付期限需要明确，未核实实时法律效力。',contractType:'采购合同',reviewedVersionIds:documents.map(d=>d.versionId),limitations:['工程模拟，仅验证流程'],findings:[{title:'交付期限不明确',status:'fail',kind:'clause',severity:'high',reason:'未明确交付日期',suggestion:'操作：替换；位置：交付条款；条款正文：乙方应在【待双方确认】日前向甲方交付全部货物。',evidence:[{versionId:documents[0].versionId,blockId:documents[0].blocks[0].id,quote:'交付期限另行商议'}],legalSourceIds:[]}]});
async function readBaseline(context) {
  if (!context.manifest.revisionReview) return null;
  let offset = 0, text = '';
  do {
    const page = await context.execute('read_revision_baseline', { offset, maxChars: 1000 }, randomUUID());
    assert.ok(!page.error, page.message); text += page.content; offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(text);
}
async function submitFixture(context, report) {
  const baseline = await readBaseline(context);
  if (baseline) report.revisionReview = { baselineReviewId: baseline.reviewId, items: baseline.findings.map((old, i) => ({ previousFindingId: old.id, status: 'unresolved', reason: '工程模拟：交付期限仍需明确。', evidence: report.findings[i]?.evidence || [], findingIndexes: [i] })), newFindings: [] };
  return context.execute('submit_review', { report }, randomUUID());
}
const complete=async({context,documents})=>({async run(){for(const d of documents)assert.ok(!(await context.execute('read_document',{versionId:d.versionId},randomUUID())).error);const value=await submitFixture(context,reportFor(documents));assert.equal(value.submitted,true,value.message);return {text:'已完成'};},async close(){}});

test('ordinary review accepts separate wording and short comments while rejecting unsafe edit targets', async () => {
  const contract = await upload(); let failure;
  await service.processReview(db, contract.reviewId, { runtimeFactory: async ({ context, documents }) => ({ async run() {
    try {
      for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
      for (const suggestion of ['不得转让。', '供方按约交货。', 'Delivery is due on the agreed date.']) {
        const value = reportFor(documents); value.findings[0].suggestion = suggestion;
        const result = await context.execute('submit_review', { report: value }, randomUUID());
        assert.equal(result.submitted, true, JSON.stringify(result));
      }
      const value = reportFor(documents), f = value.findings[0], d = documents[0];
      f.suggestion = '';
      f.edits = [{ versionId: d.versionId, blockId: 'wrong-block', operation: 'replace', originalText: d.blocks[0].text, newText: '供方按约交货。', reason: '明确交付' }];
      const invalid = await context.execute('submit_review', { report: value }, randomUUID());
      assert.equal(invalid.error, 'AUTO_EDIT_EVIDENCE');
      assert.ok(invalid.issues.some(i => i.code === 'INVALID_EVIDENCE'));
      f.edits[0].blockId = d.blocks[0].id;
      assert.equal((await context.execute('submit_review', { report: value }, randomUUID())).submitted, true);
      return {};
    } catch (e) { failure = e; throw e; }
  }, async close() {} }) });
  if (failure) throw failure;
  const review = await db('la_reviews').where({ id: contract.reviewId }).first();
  assert.equal(review.status, 'completed');
  assert.equal(review.agent_result.findings[0].edits[0].newText, '供方按约交货。');
  const c = await db('la_contracts').where({ id: review.contract_id }).first();
  const v = await db('la_versions').where({ id: review.version_id }).first();
  const findings = await db('la_findings').where({ review_id: review.id });
  const exported = require('../../pilot/reports').reportData(c, v, review, findings, null);
  assert.match(exported.modification_suggestions[0].suggested_text, /供方按约交货。/);
});

test('system skills are visible separately and every review requires the frozen entry and examples', async () => {
  const catalog = (await req('get', '/agent/system-skills').expect(200)).body.skills;
  assert.equal(catalog.find(s => s.name === 'legal-practical-redline').required, true);
  assert.ok(catalog.some(s => s.name === 'legal-auto-review'));
  const c = await upload(), run = await db('la_reviews').where({ id: c.reviewId }).first();
  const frozen = run.snapshot.systemSkills[0];
  assert.equal(frozen.name, 'legal-practical-redline');
  assert.ok(frozen.resources['references/examples.md']);
  const documents = await service.prepareDocuments(db, run, require('../../pilot/parser').parseDocument);
  const context = await require('../../pilot/agent/tools').createToolContext(db, run.id, documents);
  assert.equal((await context.execute('read_document', { versionId: documents[0].versionId })).error, 'AGENT_SYSTEM_SKILL_REQUIRED');
  assert.equal((await context.execute('submit_review', { report: reportFor(documents) })).error, 'AGENT_SYSTEM_SKILL_REQUIRED');
  await assert.rejects(context.recordSkillLoaded(frozen.name, 'forged-version'), { code: 'AGENT_SKILL_SCOPE' });
  await context.recordSkillLoaded(frozen.name, frozen.versionId);
  assert.equal((await context.execute('read_document', { versionId: documents[0].versionId })).error, 'AGENT_SYSTEM_SKILL_REQUIRED');
  assert.equal((await context.execute('read_skill_resource', { skillName: frozen.name, resource: '../../.env' })).error, 'AGENT_SKILL_RESOURCE');
  const resource = await context.execute('read_skill_resource', { skillName: frozen.name, resource: 'references/examples.md' });
  assert.equal(resource.content, frozen.resources['references/examples.md']);
  assert.ok(!(await context.execute('read_document', { versionId: documents[0].versionId })).error);
  await service.processReview(db, run.id, { runtimeFactory: complete });
  assert.equal((await db('la_reviews').where({ id: run.id }).first()).status, 'completed');
  const events = await db('la_agent_events').where({ review_id: run.id, type: 'skill_resource_read' });
  assert.ok(events.some(e => e.data.resource === 'references/examples.md' && e.data.versionId === frozen.versionId));
  const session = await db('la_agent_sessions').where({ id: run.agent_session_id }).first();
  const next = await service.beginRun(db, session, user.id, '继续核对', { clientKey: randomUUID() });
  const nextRun = await db('la_reviews').where({ id: next.reviewId }).first();
  assert.equal(nextRun.snapshot.systemSkills[0].versionId, frozen.versionId);
  const nextDocuments = await service.prepareDocuments(db, nextRun, require('../../pilot/parser').parseDocument);
  const nextContext = await require('../../pilot/agent/tools').createToolContext(db, nextRun.id, nextDocuments);
  assert.equal((await nextContext.execute('read_document', { versionId: nextDocuments[0].versionId })).error, 'AGENT_SYSTEM_SKILL_REQUIRED');
});

async function saveEditorRevision(contractId, text, metadata = '') {
  const zip = new AdmZip(docx(text));
  if (metadata) zip.addFile('docProps/core.xml', Buffer.from(`<properties>${metadata}</properties>`));
  return db.transaction(async trx => {
    const contract = await trx('la_contracts').where({ id: contractId }).forUpdate().first();
    return require('../../pilot/contracts').addVersion(trx, contract, { originalname: '改稿.docx', buffer: zip.toBuffer() }, user.id, 'onlyoffice');
  });
}

test('saved revisions reconcile prior issues, survive intermediate drafts and keep closed issues in later baselines', async () => {
  const first = await upload();
  await service.processReview(db, first.reviewId, { runtimeFactory: complete });
  const firstRun = (await req('get', '/reviews/' + first.reviewId).expect(200)).body;
  const old = firstRun.findings[0];
  await req('put', `/reviews/${first.reviewId}/findings/${old.id}/disposition`, { action: 'accept', revision: old.revision }).expect(200);
  const middle = await saveEditorRevision(first.contract.id, '虚构采购合同。交付期限另行商议。中间改稿。');
  const saved = await saveEditorRevision(first.contract.id, '虚构采购合同。乙方应于2026年12月1日前向甲方交付全部货物。');
  let run = await db('la_reviews').where({ id: saved.reviewId }).first();
  assert.equal(run.snapshot.revisionBaseline.reviewId, first.reviewId);
  assert.notEqual(run.snapshot.revisionBaseline.reviewId, middle.reviewId);
  assert.equal(run.snapshot.revisionBaseline.findings[0].disposition.action, 'accept');
  const resolved = async ({ context, documents }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    const baseline = await readBaseline(context);
    assert.equal(baseline.changes.documents[0].kind, 'text_changed');
    assert.match(baseline.changes.documents[0].edits[0].before[0].text, /交付期限另行商议/);
    const report = { summary: '本轮修改已落实，未发现新增实质风险。', reviewedVersionIds: documents.map(d => d.versionId), findings: [] };
    assert.equal((await context.execute('submit_review', { report }, randomUUID())).error, 'AGENT_REVISION_REQUIRED');
    report.revisionReview = { baselineReviewId: baseline.reviewId, items: baseline.findings.map(f => ({ previousFindingId: f.id, status: 'resolved', reason: '新稿明确了交付日期。', evidence: [{ versionId: documents[0].versionId, blockId: documents[0].blocks[0].id, quote: '乙方应于2026年12月1日前向甲方交付全部货物。' }], findingIndexes: [] })), newFindings: [] };
    assert.equal((await context.execute('submit_review', { report }, randomUUID())).submitted, true);
    return {};
  }, async close() {} });
  await service.processReview(db, saved.reviewId, { runtimeFactory: resolved });
  run = (await req('get', '/reviews/' + saved.reviewId).expect(200)).body;
  assert.equal(run.status, 'completed'); assert.equal(run.findings.length, 0);
  assert.equal(run.agent_result.revisionReview.items[0].status, 'resolved');
  assert.match((await req('get', '/reviews/' + saved.reviewId + '/report?format=html').expect(200)).text, /修改复核/);
  const next = await saveEditorRevision(first.contract.id, '虚构采购合同。乙方应于2026年12月1日前向甲方交付全部货物。', '仅包内元数据变化');
  const nextRun = await db('la_reviews').where({ id: next.reviewId }).first();
  assert.equal(nextRun.snapshot.revisionBaseline.reviewId, saved.reviewId);
  assert.equal(nextRun.snapshot.revisionBaseline.findings[0].id, old.id);
  assert.equal(nextRun.snapshot.revisionBaseline.findings[0].previousResolution.status, 'resolved');
  await service.processReview(db, next.reviewId, { runtimeFactory: async ({ context, documents }) => ({ async run() {
    await context.execute('read_document', { versionId: documents[0].versionId }, randomUUID());
    const baseline = await readBaseline(context);
    assert.equal(baseline.changes.documents[0].kind, 'text_unchanged');
    const report = { summary: '已落实修改。', reviewedVersionIds: documents.map(d => d.versionId), findings: [], revisionReview: { baselineReviewId: baseline.reviewId, items: [{ previousFindingId: old.id, status: 'resolved', reason: '交付日期保持明确。', evidence: [{ versionId: documents[0].versionId, blockId: documents[0].blocks[0].id, quote: '乙方应于2026年12月1日前向甲方交付全部货物。' }], findingIndexes: [] }], newFindings: [] } };
    assert.equal((await context.execute('submit_review', { report }, randomUUID())).submitted, true); return {};
  }, async close() {} }) });
  assert.equal((await db('la_reviews').where({ id: next.reviewId }).first()).status, 'completed');
  assert.equal((await db('la_reviews').where({ id: first.reviewId }).first()).agent_result.revisionReview, undefined);
});

test('human rejection is frozen into revision context and cannot be silently reopened', async () => {
  const first = await upload(); await service.processReview(db, first.reviewId, { runtimeFactory: complete });
  const old = (await req('get', '/reviews/' + first.reviewId).expect(200)).body.findings[0];
  await req('put', `/reviews/${first.reviewId}/findings/${old.id}/disposition`, { action: 'reject', reason: '本案交付安排已由业务确认，保留现有约定。', revision: old.revision }).expect(200);
  const saved = await saveEditorRevision(first.contract.id, '虚构采购合同。交付期限另行商议。排版后保存。');
  await service.processReview(db, saved.reviewId, { runtimeFactory: async ({ context, documents }) => ({ async run() {
    await context.execute('read_document', { versionId: documents[0].versionId }, randomUUID());
    const baseline = await readBaseline(context);
    assert.equal(baseline.findings[0].disposition.reason, '本案交付安排已由业务确认，保留现有约定。');
    const report = reportFor(documents);
    report.revisionReview = { baselineReviewId: baseline.reviewId, items: [{ previousFindingId: old.id, status: 'unresolved', reason: '仍想要求明确期限。', evidence: report.findings[0].evidence, findingIndexes: [0] }], newFindings: [] };
    assert.equal((await context.execute('submit_review', { report }, randomUUID())).error, 'AGENT_REVISION_REOPEN');
    report.findings = []; report.summary = '保留法务已明确的个案处理，未发现新增实质风险。';
    report.revisionReview.items[0] = { previousFindingId: old.id, status: 'accepted', reason: '适用条件没有变化，保留法务处理。', evidence: [], findingIndexes: [] };
    assert.equal((await context.execute('submit_review', { report }, randomUUID())).submitted, true); return {};
  }, async close() {} }) });
  const run = await db('la_reviews').where({ id: saved.reviewId }).first();
  assert.equal(run.status, 'completed'); assert.equal(run.agent_result.findings.length, 0);
  assert.equal(run.agent_result.revisionReview.items[0].status, 'accepted');
});
test('official SDK subprocess connects database tools, gateway streaming, usage and persisted continuation',async()=>{
 const http=require('node:http');let active,step=0,requests=0,continuation=false;const bodies=[];
 const server=http.createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);bodies.push(body);requests++;assert.equal(req.headers.authorization,'Bearer fictional-engineering-key');assert.ok(body.tools.every(t=>require('../../pilot/agent/tools').toolDefinitions.some(d=>d.name===t.function.name)||t.function.name==='skill'));step++;let name,args;if(step===1){name='read_document';args={versionId:active.version.id};}else{continuation=body.messages.some(m=>m.role==='tool');name='submit_review';args={report:reportFor([{versionId:active.version.id,blocks:require('../../pilot/parser').parseDocx(docx()).blocks}])};}
 const packet=(delta,finish_reason=null)=>({id:'fixture-'+requests,object:'chat.completion.chunk',created:1,model:'legal-fixture',choices:[{index:0,delta,finish_reason}]});res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify(packet({role:'assistant',content:null,tool_calls:[{index:0,id:'call-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]}))}\n\ndata: ${JSON.stringify({...packet({},'tool_calls'),usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
 }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const saved={...config.model};
 try{Object.assign(config.model,{baseUrl:'http://127.0.0.1:'+server.address().port,name:'legal-fixture',key:'fictional-engineering-key'});active=await upload();await service.processReview(db,active.reviewId);let run=await db('la_reviews').where({id:active.reviewId}).first();assert.equal(run.status,'completed',run.error_code+': '+run.error_message);assert.equal(continuation,true);assert.equal(requests,2);const session=await db('la_agent_sessions').where({id:run.agent_session_id}).first();assert.ok(session.harness_id);const next=await req('post','/agent-sessions/'+session.id+'/messages',{content:'请继续核对，并保留原版意见。',clientKey:randomUUID()}).expect(202);await service.processReview(db,next.body.reviewId);run=await db('la_reviews').where({id:next.body.reviewId}).first();assert.equal(run.status,'completed',run.error_code);assert.equal((await db('la_agent_sessions').where({id:session.id}).first()).harness_id,session.harness_id);assert.equal(requests,3);assert.ok(bodies.at(-1).messages.some(m=>JSON.stringify(m.content).includes('请继续核对')));assert.ok((await db('la_agent_events').where({type:'usage',session_id:session.id})).length>=2);
 }finally{Object.assign(config.model,saved);server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('cancelled work cannot finalize; continuing is a new version with a single concurrent winner',async()=>{const c=await upload(),r=await db('la_reviews').where({id:c.reviewId}).first();await req('post','/agent-sessions/'+r.agent_session_id+'/cancel',{}).expect(200);await service.processReview(db,r.id,{runtimeFactory:()=>{throw Error('cancelled runtime executed');}});assert.equal((await db('la_reviews').where({id:r.id}).first()).status,'cancelled');const results=await Promise.all([req('post','/agent-sessions/'+r.agent_session_id+'/messages',{content:'继续核查',clientKey:'concurrent-a'}),req('post','/agent-sessions/'+r.agent_session_id+'/messages',{content:'继续核查',clientKey:'concurrent-b'})]);assert.deepEqual(results.map(r=>r.status).sort(),[202,409]);await service.processReview(db,results.find(r=>r.status===202).body.reviewId,{runtimeFactory:complete});});
test('attachment inclusion and source changes create isolated fixed material sessions',async()=>{const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:complete});let contract=await db('la_contracts').where({id:c.contract.id}).first();const supplement=await req('post','/contracts/'+contract.id+'/versions').field('revision',contract.revision).field('kind','supplement').attach('file',docx('补充约定：双方确认本附件与主合同共同适用。'),'附件.docx').expect(201);const sr=await db('la_reviews').where({id:supplement.body.reviewId}).first();assert.equal(sr.snapshot.documents.length,2);await service.processReview(db,sr.id,{runtimeFactory:complete});contract=await db('la_contracts').where({id:c.contract.id}).first();const next=await req('post','/contracts/'+contract.id+'/versions').field('revision',contract.revision).field('kind','contract').attach('file',docx('虚构采购合同新稿。交付期限另行商议。'),'新稿.docx').expect(201);const nr=await db('la_reviews').where({id:next.body.reviewId}).first();assert.notEqual(nr.agent_session_id,sr.agent_session_id);assert.notEqual(nr.version_id,sr.version_id);await req('post','/agent-sessions/'+sr.agent_session_id+'/messages',{content:'旧稿继续',clientKey:randomUUID()}).expect(409);assert.equal((await db('la_reviews').where({id:sr.id}).first()).status,'completed');});
test('budget pauses preserve work, forged legal references fail and inaccessible official pages remain limitations',async()=>{const c=await upload();await service.processReview(db,c.reviewId,{readOfficial:async()=>{throw Object.assign(Error('官网暂不可用'),{code:'OFFICIAL_FETCH_FAILED'});},runtimeFactory:async({context,documents})=>({async run(){await context.execute('read_document',{versionId:documents[0].versionId},'r');assert.equal((await context.execute('read_official_source',{url:'https://www.gov.cn/fictional'},'law')).error,'OFFICIAL_FETCH_FAILED');const report=reportFor(documents);report.findings[0].legalSourceIds=[randomUUID()];assert.equal((await context.execute('submit_review',{report},'forged')).error,'AGENT_LEGAL_SOURCE');throw Object.assign(Error('已达到本轮请求限制'),{code:'AGENT_BUDGET'});},async close(){}})});const r=await db('la_reviews').where({id:c.reviewId}).first();assert.equal(r.status,'waiting_input');assert.equal(r.stage,'paused');assert.equal(r.agent_result,null);});
test('risk and evidence evaluations bind identical materials and preserve human label snapshots',async()=>{const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:complete});const run=await req('get','/reviews/'+c.reviewId).expect(200),f=run.body.findings[0];const saved=await req('post','/agent/evaluation-cases',{name:'工程标注',reviewId:c.reviewId,split:'development',risks:[{id:'delivery',title:'交付日期',severity:'high',evidence:f.evidence,expectedAdvice:'明确交付日'}]}).expect(201);await req('get','/agent/evaluation-cases').expect(200);const score=await req('post','/agent/evaluations',{caseId:saved.body.id,reviewId:c.reviewId,matches:[{riskId:'delivery',findingId:f.id,evidenceCorrect:true,adviceAcceptable:true}]}).expect(201);assert.equal(score.body.result.metrics.highRiskRecall,1);assert.equal(score.body.config.labelSnapshot.risks[0].id,'delivery');await req('get','/agent/evaluations').expect(200);});
before(async()=>{rootDb=createDb();database='legal_test_'+randomUUID().replaceAll('-','');await rootDb.raw(`CREATE DATABASE "${database}"`);const url=new URL(config.databaseUrl);url.pathname='/'+database;config.databaseUrl=url.href;config.dataRoot=path.resolve(process.env.AUTO_REVIEW_TEST_DATA_ROOT || '.local/test-data',database);config.model={...config.model,key:'',baseUrl:'',name:''};db=createDb();await migrate(db);await require('../../pilot/storage').initializeDirectories();user={id:randomUUID(),username:'legal',display_name:'工程法务',department:'测试',roles:['admin'],password_hash:await hashPassword('test-agent-password')};await db('la_users').insert({...user,roles:JSON.stringify(user.roles)});app=createApp(db);agent=supertest.agent(app.app);const s=await agent.get('/api/auth/session');const login=await agent.post('/api/auth/login').set('X-CSRF-Token',s.body.csrf).send({username:'legal',password:'test-agent-password'}).expect(200);csrf=login.body.csrf;});
after(async()=>{await app?.close();await db?.destroy();if(rootDb&&database){await rootDb.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()',[database]);await rootDb.raw(`DROP DATABASE "${database}"`);}await rootDb?.destroy();});
test('upload without background starts only Agent and old creation/publication endpoints are retired',async()=>{const c=await upload();assert.ok(c.reviewId);const r=await db('la_reviews').where({id:c.reviewId}).first();assert.equal(r.engine,'harness-v1');assert.deepEqual(r.snapshot.rules,[]);assert.deepEqual(r.snapshot.skills,[]);assert.equal((await db('la_preanalyses')).length,0);for(const p of ['/reviews','/rule-packs/a/versions','/skill-packs/a/versions','/contracts/'+c.contract.id+'/preanalysis'])await req('post',p,{}).expect(410);});

test('completed report persists contract type for list filters without confirming business facts', async () => {
  const c = await upload();
  assert.equal((await db('la_contracts').where({ id: c.contract.id }).first()).classification, null);
  await service.processReview(db, c.reviewId, { runtimeFactory: complete });
  const current = await db('la_contracts').where({ id: c.contract.id }).first();
  assert.equal(current.classification.typeId, 'procurement');
  assert.equal(current.classification.typeName, '采购合同');
  assert.equal(current.classification.versionId, c.version.id);
  assert.equal(current.classification.reviewId, c.reviewId);
  assert.equal(current.classification.confirmed, false);
  assert.equal(current.classification.perspectiveConfirmed, false);
  assert.ok(current.revision > c.contract.revision);
  const list = await req('get', '/contracts?view=main&page=1&type=procurement').expect(200);
  assert.ok(list.body.items.some(item => item.id === c.contract.id));
  const result = await req('get', '/reviews/' + c.reviewId).expect(200);
  assert.equal(result.body.agent_result.contractType, '采购合同');
});

test('custom report type belongs to other; current confirmed human classification remains authoritative', async () => {
  const c = await upload(), typeName = '定制软件开发及维护服务合同（模拟预审）';
  const custom = async args => ({
    async run() {
      for (const d of args.documents) await args.context.execute('read_document', { versionId: d.versionId }, randomUUID());
      const report = { ...reportFor(args.documents), contractType: typeName };
      assert.equal((await args.context.execute('submit_review', { report }, randomUUID())).submitted, true);
      return {};
    }, async close() {},
  });
  await service.processReview(db, c.reviewId, { runtimeFactory: custom });
  const listed = await req('get', '/contracts?view=main&page=1&type=other').expect(200);
  assert.equal(listed.body.items.find(item => item.id === c.contract.id).classification.typeName, typeName);
  const human = await upload();
  const confirmed = { typeId: 'procurement', versionId: human.version.id, confirmed: true, perspectiveConfirmed: true, confirmedBy: user.id };
  await db('la_contracts').where({ id: human.contract.id }).update({ classification: JSON.stringify(confirmed) });
  await service.processReview(db, human.reviewId, { runtimeFactory: custom });
  assert.deepEqual((await db('la_contracts').where({ id: human.contract.id }).first()).classification, confirmed);
});

test('classification backfill previews missing completed results and applies idempotently', async () => {
  const { backfill } = require('../../../scripts/backfill-agent-classification.cjs');
  const c = await upload();
  await service.processReview(db, c.reviewId, { runtimeFactory: complete });
  await db('la_contracts').where({ id: c.contract.id }).update({ classification: null });
  const before = await db('la_reviews').where({ id: c.reviewId }).first();
  assert.ok((await backfill(db)).changes.some(change => change.contractId === c.contract.id));
  assert.equal((await db('la_contracts').where({ id: c.contract.id }).first()).classification, null);
  assert.ok((await backfill(db, { apply: true })).changes.some(change => change.contractId === c.contract.id));
  assert.deepEqual((await backfill(db, { apply: true })).changes, []);
  assert.deepEqual(await db('la_reviews').where({ id: c.reviewId }).first(), before);
  const pending = await upload();
  assert.ok(!(await backfill(db, { apply: true })).changes.some(change => change.contractId === pending.contract.id));
});
test('report validates exact quotes and scope, tool calls are idempotent, legal decision needs no item selection',async()=>{const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:async args=>({async run(){const {context,documents}=args,d=documents[0];assert.equal((await context.execute('read_document',{versionId:randomUUID()},'outside')).error,'AGENT_DOCUMENT_SCOPE');const r=await context.execute('submit_review',{report:reportFor(documents)},'unread');assert.equal(r.error,'AGENT_DOCUMENT_UNREAD');await context.execute('read_document',{versionId:d.versionId},'read');const bad=reportFor(documents);bad.findings[0].evidence[0].quote='不存在的引用';assert.equal((await context.execute('submit_review',{report:bad},'bad')).error,'AGENT_INVALID_EVIDENCE');const body={report:reportFor(documents)};assert.equal((await context.execute('submit_review',body,'submit')).submitted,true);assert.equal((await context.execute('submit_review',body,'submit')).submitted,true);return {};},async close(){}})});const r=await req('get','/reviews/'+c.reviewId).expect(200);assert.equal(r.body.status,'completed');assert.equal(r.body.findings[0].rule_id,null);assert.equal((await db('la_agent_legal_events').where({review_id:c.reviewId})).length,0);const contract=await db('la_contracts').where({id:c.contract.id}).first();await req('post','/reviews/'+c.reviewId+'/decision',{outcome:'agree',revision:contract.revision}).expect(201);const html=await req('get','/reviews/'+c.reviewId+'/report?format=html').expect(200);assert.match(html.text,/交付期限/);});
test('necessary question releases runtime; answer continues same session and creates a frozen new result',async()=>{const c=await upload(),run=await db('la_reviews').where({id:c.reviewId}).first();let closed=false;await service.processReview(db,run.id,{runtimeFactory:async({context})=>({async run(){await context.execute('request_information',{question:'我方是采购方还是供货方？'},'question');return {};},async close(){closed=true;}})});assert.equal(closed,true);const s=await db('la_agent_sessions').where({id:run.agent_session_id}).first();assert.equal(s.status,'waiting_input');const q=await db('la_agent_messages').where({review_id:run.id,kind:'question'}).first();const next=await req('post','/agent-sessions/'+s.id+'/answers',{content:'我方是采购方',questionId:q.id,clientKey:'answer-1'}).expect(202);const duplicate=await req('post','/agent-sessions/'+s.id+'/answers',{content:'我方是采购方',questionId:q.id,clientKey:'answer-1'});assert.ok([202,409].includes(duplicate.status));await service.processReview(db,next.body.reviewId,{runtimeFactory:complete});assert.equal((await db('la_reviews').where({id:run.id}).first()).status,'waiting_input');assert.equal((await db('la_reviews').where({id:next.body.reviewId}).first()).status,'completed');assert.equal((await db('la_agent_legal_events').where({kind:'explicit_feedback'})).length,0);});

test('structured question choices survive reload and accept one validated, idempotent answer batch', async () => {
  const c = await upload(), run = await db('la_reviews').where({ id: c.reviewId }).first();
  const questions = [
    { id: 'party', header: '我方身份', question: '我方是哪一方？', options: [{ label: '甲方' }, { label: '乙方' }] },
    { id: 'mode', header: '审查场景', question: '本次审查用于什么场景？', options: [{ label: '模拟预审' }, { label: '真实签约' }] },
  ];
  await service.processReview(db, run.id, { runtimeFactory: async ({ context }) => ({
    async run() { const result = await context.execute('request_information', { question: '请确认我方身份及审查场景。', questions }, 'choice-question'); assert.equal(result.questions.length, 2); return {}; }, async close() {},
  }) });
  const s = await db('la_agent_sessions').where({ id: run.agent_session_id }).first();
  const loaded = await req('get', '/agent-sessions/' + s.id).expect(200);
  const q = loaded.body.messages.find(m => m.kind === 'question');
  assert.deepEqual(q.data.questions[0].options, questions[0].options);
  const input = { questionId: q.id, clientKey: 'choice-answer', answers: [{ id: 'party', selected: ['甲方'] }, { id: 'mode', selected: [], custom: '模拟预审，按测试条件评估' }], content: '验收样例' };
  await req('post', '/agent-sessions/' + s.id + '/answers', { ...input, answers: [{ id: 'party', selected: ['其他伪造选项'] }, input.answers[1]] }).expect(422);
  await req('post', '/agent-sessions/' + s.id + '/answers', { ...input, answers: input.answers.slice(0, 1) }).expect(422);
  assert.equal((await db('la_agent_sessions').where({ id: s.id }).first()).status, 'waiting_input');
  const next = await req('post', '/agent-sessions/' + s.id + '/answers', input).expect(202);
  const saved = await db('la_agent_messages').where({ review_id: next.body.reviewId, kind: 'answer' }).first();
  assert.deepEqual(saved.data.answers, input.answers); assert.equal(saved.data.questionId, q.id);
  assert.match(saved.content, /我方是哪一方？\n回答：甲方/); assert.match(saved.content, /模拟预审/); assert.match(saved.content, /验收样例/);
  const duplicate = await req('post', '/agent-sessions/' + s.id + '/answers', input).expect(202);
  assert.equal(duplicate.body.reviewId, next.body.reviewId); assert.equal(duplicate.body.duplicate, true);
  await req('post', '/agent-sessions/' + s.id + '/answers', { ...input, content: '不同内容' }).expect(409);
  await req('post', '/agent-sessions/' + s.id + '/answers', { ...input, clientKey: 'stale-question' }).expect(409);
  await service.processReview(db, next.body.reviewId, { runtimeFactory: complete });
  assert.equal((await db('la_reviews').where({ id: next.body.reviewId }).first()).status, 'completed');
});
test('saved submitted report survives worker interruption without another model request',async()=>{const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:async({context,documents})=>({async run(){await context.execute('read_document',{versionId:documents[0].versionId},'r');await context.execute('submit_review',{report:reportFor(documents)},'s');throw Error('simulated process interruption');},async close(){}})});assert.equal((await db('la_reviews').where({id:c.reviewId}).first()).status,'failed');await db('la_reviews').where({id:c.reviewId}).update({status:'queued'});await service.processReview(db,c.reviewId,{runtimeFactory:()=>{throw Error('must not call model again');}});assert.equal((await db('la_reviews').where({id:c.reviewId}).first()).status,'completed');assert.equal((await db('la_findings').where({review_id:c.reviewId})).length,1);});
async function approveSource(sourceId) { const manager=require('../../pilot/agent/memory-management'); for (let row of await db('la_agent_memories').where({source_id:sourceId})) { row=await manager.change(db,user,row.id,'submit',{revision:row.revision}); await manager.change(db,user,row.id,'approve',{revision:row.revision}); } }

test('human feedback creates reviewable drafts, AI judgments do not; revoked source stops reuse and flags results',async()=>{const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:complete});const source=await memory.record(db,user,{contractId:c.contract.id,reviewId:c.reviewId,kind:'explicit_feedback',eventKey:randomUUID(),source:{text:'付款条件应明确验收标准。'}});await memory.processMemory(db,source,{distill:async()=>({memories:[{kind:'skill',title:'验收条件检查',description:'核对验收与付款条件',content:'核对双方约定的验收标准及付款触发条件。',conditions:['采购合同'],sourceQuotes:['付款条件应明确验收标准。']}]})});assert.equal((await db('la_agent_legal_events').where({id:source}).first()).status,'completed');await approveSource(source);const contract=await db('la_contracts').where({id:c.contract.id}).first(),memories=await service.usableMemories(db,contract);assert.equal(memories.length,1);const next=await req('post','/agent-sessions/'+(await db('la_reviews').where({id:c.reviewId}).first()).agent_session_id+'/messages',{content:'核对付款',clientKey:randomUUID()}).expect(202);await service.processReview(db,next.body.reviewId,{runtimeFactory:complete});await memory.revoke(db,source,user,'原反馈不再适用');assert.equal((await service.usableMemories(db,contract)).length,0);assert.equal((await db('la_reviews').where({id:next.body.reviewId}).first()).coverage.requiresRecheck,true);});

test('memory records expose zero-output reasons and original fields without leaking raw source in lists', async () => {
  const c = await upload();
  await service.processReview(db, c.reviewId, { runtimeFactory: complete });
  const sourceId = await memory.record(db, user, { contractId: c.contract.id, reviewId: c.reviewId, kind: 'legal_decision', eventKey: randomUUID(), source: { outcome: 'agree', reason: '', conditions: '' } });
  await memory.processMemory(db, sourceId, { distill: async () => ({ memories: [] }) });
  const list = (await req('get', '/agent/experiences').expect(200)).body;
  const source = list.sources.find(s => s.id === sourceId);
  assert.equal(source.generatedCount, 0);
  assert.equal(source.resultCode, 'NO_SUBSTANTIVE_FEEDBACK');
  assert.equal(source.contract_title, c.contract.title);
  assert.equal('source' in source, false);
  const detail = (await req('get', '/agent/experience-sources/' + sourceId).expect(200)).body;
  assert.equal(detail.fields.find(f => f.label === '最终结论').value, '同意');
  assert.equal(detail.fields.find(f => f.label === '处理理由').value, '');
  assert.deepEqual(detail.memories, []);
  assert.equal((await db('la_audit').where({ action: 'agent.memory.learned', entity_id: sourceId }).first()).details.emptyResultCode, 'NO_SUBSTANTIVE_FEEDBACK');
});

test('memory records count generated kinds and retain history after source revocation', async () => {
  const c = await upload();
  await service.processReview(db, c.reviewId, { runtimeFactory: complete });
  const sourceId = await memory.record(db, user, { contractId: c.contract.id, reviewId: c.reviewId, kind: 'explicit_feedback', eventKey: randomUUID(), source: { text: '付款条件须核对验收标准及争议处理安排。' } });
  const proposal = { title: '验收与付款', description: '核对验收的付款条件', content: '核对付款触发条件与验收标准，并保留争议处理机制。', conditions: ['采购合同'], sourceQuotes: ['付款条件须核对验收标准及争议处理安排。'] };
  await memory.processMemory(db, sourceId, { distill: async () => ({ memories: [{ ...proposal, kind: 'skill' }, { ...proposal, kind: 'experience' }] }) });
  await approveSource(sourceId);
  const before = (await req('get', '/agent/experiences').expect(200)).body;
  const log = before.sources.find(s => s.id === sourceId);
  assert.deepEqual([log.skillCount, log.experienceCount, log.generatedCount], [1, 1, 2]);
  assert.equal(log.resultCode, 'GENERATED');
  assert.equal((await req('get', '/agent/experience-sources/' + sourceId).expect(200)).body.memories.length, 2);
  await memory.revoke(db, sourceId, user, '工程测试撤销');
  const after = (await req('get', '/agent/experiences').expect(200)).body;
  assert.equal(after.summary.skills, before.summary.skills - 1);
  assert.equal(after.summary.experiences, before.summary.experiences - 1);
  assert.equal(after.sources.find(s => s.id === sourceId).generatedCount, 2);
  assert.ok(after.sources.find(s => s.id === sourceId).revoked_at);
});

test('memory detail and summary stay inside department permissions', async () => {
  const c = await upload();
  await service.processReview(db, c.reviewId, { runtimeFactory: complete });
  const sourceId = await memory.record(db, user, { contractId: c.contract.id, reviewId: c.reviewId, kind: 'explicit_feedback', eventKey: randomUUID(), source: { text: '隔离测试反馈' } });
  const other = { id: randomUUID(), username: 'isolated-lawyer', display_name: '隔离法务', roles: JSON.stringify(['legal']), department: '其他部门', password_hash: user.password_hash };
  await db('la_users').insert(other);
  const viewer = supertest.agent(app.app), session = await viewer.get('/api/auth/session');
  await viewer.post('/api/auth/login').set('X-CSRF-Token', session.body.csrf).send({ username: other.username, password: 'test-agent-password' }).expect(200);
  const list = (await viewer.get('/api/agent/experiences').expect(200)).body;
  assert.equal(list.summary.sources, 0);
  assert.deepEqual(list.sources, []);
  assert.deepEqual(list.memories, []);
  await viewer.get('/api/agent/experience-sources/' + sourceId).expect(404);
});

test('long Unicode material requires complete cursor reads, search never fabricates reading coverage',async()=>{
 const c=(await req('post','/contracts/upload').attach('file',docx('甲'.repeat(797)+'📄'+'乙'.repeat(3200)+'。交付期限另行商议。'),'长合同.docx').expect(201)).body;
 await service.processReview(db,c.reviewId,{runtimeFactory:async({context,documents})=>({async run(){
  await context.execute('search_documents',{query:'交付期限'},randomUUID());
  assert.equal((await context.execute('list_documents',{},randomUUID())).coverage.complete,false);
  const d=documents[0];let cursor={versionId:d.versionId,maxChars:798},text='',count=0;
  do{const read=await context.execute('read_document',cursor,randomUUID());assert.ok(!read.error,read.error);for(const b of read.blocks){assert.ok(!/[\uD800-\uDBFF]$/u.test(b.text));text+=b.text;}cursor=read.next&&{...read.next,maxChars:798};count++;}while(cursor);
  assert.ok(count>4);assert.equal(text,d.blocks.map(b=>b.text).join(''));assert.equal((await context.execute('list_documents',{},randomUUID())).coverage.complete,true);
  assert.equal((await context.execute('submit_review',{report:reportFor(documents)},randomUUID())).submitted,true);return {};
 },async close(){}})});
 assert.equal((await db('la_reviews').where({id:c.reviewId}).first()).status,'completed');
});

test('supplement evidence is readable in result, annotation, legal feedback and frozen report',async()=>{
 const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:complete});const contract=await db('la_contracts').where({id:c.contract.id}).first();
 const attachment=(await req('post','/contracts/'+contract.id+'/versions').field('revision',contract.revision).field('kind','supplement').attach('file',docx('附件补充：交付期限另行商议。'),'独立附件.docx').expect(201)).body;
 await service.processReview(db,attachment.reviewId,{runtimeFactory:async args=>{const report=reportFor(args.documents);report.findings[0].evidence=[{versionId:args.documents[1].versionId,blockId:args.documents[1].blocks[0].id,quote:'交付期限另行商议'}];return {async run(){for(const d of args.documents)await args.context.execute('read_document',{versionId:d.versionId},randomUUID());assert.equal((await submitFixture(args.context,report)).submitted,true);return {};},async close(){}};}});
 const result=(await req('get','/reviews/'+attachment.reviewId).expect(200)).body;assert.equal(result.documents.length,2);
 await req('get','/reviews/'+result.id+'/annotated-contract?versionId='+attachment.version.id).expect(200);
 const human=await req('post','/reviews/'+result.id+'/findings',{title:'人工补充核对',reason:'附件需核实',severity:'medium',evidence:result.findings[0].evidence}).expect(201);assert.equal(human.body.ok,true);
 assert.match((await req('get','/reviews/'+result.id+'/report?format=html').expect(200)).text,/独立附件/);
});

test('legacy history is immutable and exportable; cutover refuses running work and marks queued jobs',async()=>{
 const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:complete});
 const legacyId=randomUUID();await db('la_reviews').insert({id:legacyId,contract_id:c.contract.id,version_id:c.version.id,created_by:user.id,engine:'legacy',status:'running',snapshot:JSON.stringify({packs:[],background:{}})});
 const cutover=require('../../pilot/agent/cutover').retireLegacy;assert.equal((await cutover(db)).runningLegacy.length,1);await assert.rejects(cutover(db,{apply:true}),e=>e.code==='LEGACY_WORKER_DRAIN_REQUIRED');
 await db('la_reviews').where({id:legacyId}).update({status:'queued'});const job=randomUUID();await db('la_outbox').insert({id:job,queue:'preanalysis',payload:'{}'});
 assert.equal((await cutover(db,{apply:true})).applied,true);assert.equal((await db('la_reviews').where({id:legacyId}).first()).stage,'engine_retired');assert.equal((await db('la_outbox').where({id:job}).first()).retired_reason,'REVIEW_ENGINE_RETIRED');
 await req('get','/reviews/'+legacyId).expect(200);await req('get','/reviews/'+legacyId+'/report?format=html').expect(200);await req('post','/reviews/'+legacyId+'/findings',{title:'修改历史',reason:'测试',severity:'low',evidence:[]}).expect(409);
 for(const p of ['/skill-entry-versions/x/publish','/classification-guidance-versions/x/publish','/learning-proposals/x/apply'])await req('post',p,{}).expect(410);
});

test('backup and isolated restore retain Harness logs, hashes and immutable legal result versions',async()=>{
 const fs=require('node:fs/promises'),{createBackup,restoreBackup}=require('../../pilot/backup');const c=await upload();await service.processReview(db,c.reviewId,{runtimeFactory:complete});
 const log=path.join(config.dataRoot,'harness',c.reviewId,'fixture.jsonl');await fs.mkdir(path.dirname(log),{recursive:true});await fs.writeFile(log,'{"event":"engineering-fixture"}\n');
 const backup=await createBackup(db);assert.ok(backup.manifest.files.some(f=>f.path.endsWith('fixture.jsonl')));
 const restored='legal_restore_'+randomUUID().replaceAll('-','');await rootDb.raw(`CREATE DATABASE "${restored}"`);const url=new URL(config.databaseUrl);url.pathname='/'+restored;const target=createDb(url.href),targetRoot=config.dataRoot+'-restore';
 try{await restoreBackup(target,{directory:backup.directory,databaseUrl:url.href,targetRoot});assert.equal((await target('la_reviews').where({id:c.reviewId}).first()).agent_result.summary,(await db('la_reviews').where({id:c.reviewId}).first()).agent_result.summary);assert.equal(await fs.readFile(path.join(targetRoot,'harness',c.reviewId,'fixture.jsonl'),'utf8'),await fs.readFile(log,'utf8'));assert.equal((await target('la_sessions')).length,0);}finally{await target.destroy();await rootDb.raw(`DROP DATABASE "${restored}"`);}
});

test('official subprocess enforces actual HTTP request budgets, no-progress pause and in-flight cancellation',async()=>{
 const http=require('node:http'),saved={...config.model},oldSetting=await db('la_settings').where({key:'agent'}).first();let mode='budget',calls=0,seenRequest;
 const server=http.createServer(async(request,response)=>{let raw='';for await(const part of request)raw+=part;JSON.parse(raw);calls++;seenRequest?.();
  if(mode==='cancel')return;
  const packet={id:'limit-'+calls,object:'chat.completion.chunk',created:1,model:'legal-limits',choices:[{index:0,delta:{role:'assistant',content:null,tool_calls:[{index:0,id:'limit-'+calls,type:'function',function:{name:'list_documents',arguments:'{}'}}]},finish_reason:null}]};
  response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(`data: ${JSON.stringify(packet)}\n\ndata: ${JSON.stringify({...packet,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  Object.assign(config.model,{baseUrl:'http://127.0.0.1:'+server.address().port,name:'legal-limits',key:'fixture-limits-key'});
  await db('la_settings').insert({key:'agent',value:'{"maxRequests":2}'}).onConflict('key').merge({value:'{"maxRequests":2}'});
  const budget=await upload();await service.processReview(db,budget.reviewId);const b=await db('la_reviews').where({id:budget.reviewId}).first();assert.equal(b.error_code,'AGENT_BUDGET');assert.equal(b.status,'waiting_input');assert.equal(calls,2);
  mode='repeat';calls=0;await db('la_settings').where({key:'agent'}).update({value:'{"maxRequests":10}'});
  const repeat=await upload();await service.processReview(db,repeat.reviewId);const n=await db('la_reviews').where({id:repeat.reviewId}).first();assert.equal(n.error_code,'AGENT_NO_PROGRESS');assert.equal(n.status,'waiting_input');assert.equal(calls,3);
  mode='cancel';calls=0;const cancelled=await upload(),run=await db('la_reviews').where({id:cancelled.reviewId}).first();let notify;const received=new Promise(r=>{notify=r;});seenRequest=notify;
  const pending=service.processReview(db,cancelled.reviewId);await Promise.race([received,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('runtime request timed out')),30000);timer.unref();})]);
  await req('post','/agent-sessions/'+run.agent_session_id+'/cancel',{}).expect(200);await pending;assert.equal((await db('la_reviews').where({id:run.id}).first()).status,'cancelled');assert.equal(calls,1);
 }finally{Object.assign(config.model,saved);server.closeAllConnections();await new Promise(r=>server.close(r));await db('la_settings').where({key:'agent'}).delete();if(oldSetting)await db('la_settings').insert(oldSetting);}
});

test('transactional Agent outbox dispatch remains idempotent after send-before-mark restart',async()=>{
 const {createQueue}=require('../../pilot/queue');const c=await upload(),row=await db('la_outbox').where({queue:'agent-review'}).whereRaw("payload->>'reviewId' = ?",[c.reviewId]).first();let queue;
 try{queue=await createQueue(db,{work:false});await queue.dispatch();assert.ok((await db('la_outbox').where({id:row.id}).first()).sent_at);assert.ok(await queue.boss.getJobById('agent-review',row.id));await db('la_outbox').where({id:row.id}).update({sent_at:null});await queue.stop();queue=null;queue=await createQueue(db,{work:false});await queue.dispatch();assert.equal((await db.withSchema('legal_queue').table('job').where({id:row.id})).length,1);assert.ok((await db('la_outbox').where({id:row.id}).first()).sent_at);}finally{await queue?.stop();}
});
