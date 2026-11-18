// Continue the isolated real-editor fixture through real preanalysis and a selected-rule review.
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
const base=path.resolve(__dirname,'..'),load=n=>require(path.join(base,'backend/pilot',n));
(async()=>{
 const {config}=load('config'),{createDb}=load('db'),root=createDb(),provider=await load('model').providerConfig(root);
 let db,handle;
 try{
  const access=JSON.parse(await fs.readFile(path.join(base,'.local/pdf-word/office-access.json'),'utf8'));
  const rows=await root.raw("SELECT datname FROM pg_database WHERE datname LIKE 'legal_pdf_office_%'");let c;
  for(const row of rows.rows){const url=new URL(config.databaseUrl);url.pathname='/'+row.datname;const candidate=createDb(url.href);const found=await candidate('la_contracts').where({id:access.contractId}).first();if(found){db=candidate;c=found;config.databaseUrl=url.href;break;}await candidate.destroy();}
  assert.ok(c,'isolated office fixture must exist');config.model={...provider};config.env='test';config.publicUrl='http://127.0.0.1:18195';config.pdfWord.enabled=true;config.dataRoot=path.join(base,'.local/office-data',new URL(config.databaseUrl).pathname.slice(1));
  console.log('Running real preanalysis of saved Word version');await load('preanalysis').processPreanalysis(db,c.current_preanalysis_id);
  const job=await db('la_preanalyses').where({id:c.current_preanalysis_id}).first();assert.equal(job.status,'ready',job.error_message||job.error_code);
  const template=job.result.templates.find(t=>t.id===job.result.templateId),party=job.result.parties.find(p=>p.name.includes('虚构甲公司'))||job.result.parties[0];assert.ok(party);
  const supertest=require(path.join(base,'node_modules/supertest'));handle=load('app').createApp(db);const agent=supertest.agent(handle.app),s=await agent.get('/api/auth/session');const login=await agent.post('/api/auth/login').set('X-CSRF-Token',s.body.csrf).send({username:access.username,password:access.password}).expect(200);
  c=await db('la_contracts').where({id:c.id}).first();
  const result=await agent.post(`/api/preanalyses/${job.id}/start`).set('X-CSRF-Token',login.body.csrf).send({revision:job.revision,contractRevision:c.revision,selection:{partyId:party.id,typeId:job.result.classification.typeId,templateId:template.id,pointIds:template.points.slice(0,2).map(p=>p.id),corePurposes:job.result.corePurposes}}).expect(202);
  await load('workflow').processReview(db,result.body.reviewId);const review=await db('la_reviews').where({id:result.body.reviewId}).first();assert.equal(review.status,'completed',review.error_message||review.error);
  assert.equal(review.version_id,c.current_version_id);assert.notEqual(review.version_id,access.sourceVersionId);
  const output={isolatedDatabase:true,fictionalDocuments:true,realModel:provider.name,preanalysisReady:true,savedWordReviewed:true,reviewCoverage:review.coverage,oldPdfReviewPreserved:!!await db('la_reviews').where({version_id:access.sourceVersionId,status:'completed'}).first(),passed:true};
  await fs.writeFile(path.join(base,'.local/pdf-word/review-result.json'),JSON.stringify(output,null,2));console.log('REAL_SAVED_WORD_REVIEW_PASSED');
 }finally{await handle?.close();await db?.destroy();await root.destroy();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
