const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const supertest=require('supertest');
const {config}=require('../../pilot/config');
const {createDb}=require('../../pilot/db');
const {migrate}=require('../../pilot/cli');
const {createApp}=require('../../pilot/app');
const {hashPassword}=require('../../pilot/auth');
const {providerConfig}=require('../../pilot/model');
const {probeDing,serviceDiagnostics,dingConfig}=require('../../pilot/settings');
const {manageIntegration}=require('../../pilot/dingtalk');
let rootDb,db,name,handle,server,url,mode='ok',admin,staff,csrf,staffCsrf,staffId,adminId;
const password='only-engineering-password-123',key='fixture-only-model-secret',dingSecret='fixture-only-ding-secret';
const call=(method,route,body)=>admin[method]('/api'+route).set('X-CSRF-Token',csrf).send(body);
before(async()=>{
  rootDb=createDb();name='legal_test_settings_'+randomUUID().replaceAll('-','');await rootDb.raw(`CREATE DATABASE "${name}"`);const connection=new URL(config.databaseUrl);connection.pathname='/'+name;config.databaseUrl=connection.href;config.dataRoot=path.resolve(__dirname,'../../../.local/test-data',name);Object.assign(config.model,{baseUrl:undefined,name:undefined,key:undefined});Object.assign(config.ding,{enabled:false,clientId:undefined,secret:undefined});db=createDb();await migrate(db);await fs.mkdir(config.dataRoot,{recursive:true});
  adminId=randomUUID();staffId=randomUUID();for(const [id,username,roles]of [[adminId,'admin',['admin']],[staffId,'business',['business']]])await db('la_users').insert({id,username,display_name:username,roles:JSON.stringify(roles),password_hash:await hashPassword(password)});
  handle=createApp(db);admin=supertest.agent(handle.app);staff=supertest.agent(handle.app);
  for(const [agent,username]of [[admin,'admin'],[staff,'business']]){const s=await agent.get('/api/auth/session');const r=await agent.post('/api/auth/login').set('X-CSRF-Token',s.body.csrf).send({username,password}).expect(200);if(username==='admin')csrf=r.body.csrf;else staffCsrf=r.body.csrf;}
  server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/health'){res.end('{"ok":true}');return;}if(mode==='unauthorized'){res.statusCode=401;res.end(JSON.stringify({error:key}));return;}if(req.headers.authorization!=='Bearer '+key){res.statusCode=403;res.end('{}');return;}if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture-model'},{id:'fixture-model'},{id:'fixture-model-2'}]}));return;}res.end(JSON.stringify({choices:[{message:{content:mode==='invalid'?'plain text':JSON.stringify({ok:true})}}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}/v1`;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));await handle?.close();await db?.destroy();if(rootDb&&name){await rootDb.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()',[name]);await rootDb.raw(`DROP DATABASE "${name}"`);}await rootDb?.destroy();});

test('configuration and connection checks require administrator and CSRF',async()=>{
  for(const route of ['/settings/model/test','/settings/model/models','/settings/diagnostics','/settings/dingtalk/test'])await staff.post('/api'+route).set('X-CSRF-Token',staffCsrf).send({}).expect(403);
  await admin.post('/api/settings/diagnostics').send({}).expect(403);await supertest(handle.app).get('/api/settings').expect(401);
  const duplicate=await call('post','/users',{username:'admin',password,displayName:'重复账号',roles:['business']}).expect(409);assert.equal(duplicate.body.code,'USERNAME_EXISTS');assert.match(duplicate.body.message,/已存在/);
});
test('classification archive root is persisted, validated and can be disabled',async()=>{
  const root=path.join(config.dataRoot,'classified-export');
  const saved=await call('put','/settings/archive-root',{enabled:true,root,expectedUpdatedAt:null}).expect(200);
  assert.equal(saved.body.archive.enabled,true);assert.equal(saved.body.archive.root,root);await fs.access(root);
  const settings=(await call('get','/settings').expect(200)).body;assert.equal(settings.archive.root,root);assert.equal(settings.archive.enabled,true);
  await call('put','/settings/archive-root',{enabled:true,root:'relative-folder',expectedUpdatedAt:settings.archive.updatedAt}).expect(400);
  await call('put','/settings/archive-root',{enabled:false,root:'',expectedUpdatedAt:settings.archive.updatedAt}).expect(200);
  assert.equal((await call('get','/settings').expect(200)).body.archive.enabled,false);
});
test('draft probes do not certify saved configuration; saving normalizes endpoint and encrypts the key',async()=>{
  const draft={baseUrl:url+'/chat/completions',name:'fixture-model',apiKey:key};const test=await call('post','/settings/model/test',draft).expect(200);assert.equal(test.body.status,'success');
  assert.equal((await call('get','/settings').expect(200)).body.model.check,null);
  await call('put','/settings/model',{...draft,expectedUpdatedAt:null}).expect(200);const stored=await db('la_settings').where({key:'model'}).first();assert.equal(stored.value.baseUrl,url);assert.ok(stored.value.encryptedKey);assert.ok(!JSON.stringify(stored).includes(key));
  const current=await call('get','/settings').expect(200);assert.equal(current.body.model.hasKey,true);assert.ok(!JSON.stringify(current.body).includes(key));assert.equal(current.body.model.check,null);
  const models=await call('post','/settings/model/models',{baseUrl:url,name:'fixture-model'}).expect(200);assert.deepEqual(models.body.models,['fixture-model','fixture-model-2']);
  await call('post','/settings/model/test',{baseUrl:url,name:'fixture-model'}).expect(200);assert.equal((await call('get','/settings').expect(200)).body.model.check.status,'success');
});
test('host changes require a new key, stale saves conflict and failures never echo provider secrets',async()=>{
  const before=(await call('get','/settings').expect(200)).body.model;
  await call('put','/settings/model',{baseUrl:url+'/other',name:'fixture-model'}).expect(400);
  await call('put','/settings/model',{baseUrl:url,name:'fixture-model',expectedUpdatedAt:null}).expect(409);
  assert.equal((await providerConfig(db)).key,key);
  mode='unauthorized';const failed=await call('post','/settings/model/test',{baseUrl:url,name:'fixture-model'}).expect(200);assert.equal(failed.body.status,'error');assert.equal(failed.body.httpStatus,401);assert.ok(!JSON.stringify(failed.body).includes(key));
  mode='invalid';const invalid=await call('post','/settings/model/test',{baseUrl:url,name:'fixture-model'}).expect(200);assert.equal(invalid.body.status,'warning');mode='ok';
  await call('put','/settings/model',{baseUrl:url,name:'fixture-model-2',expectedUpdatedAt:before.updatedAt}).expect(200);assert.equal((await call('get','/settings').expect(200)).body.model.check,null);
});
test('DingTalk enables without template mappings, keeps secrets encrypted and returns no token',async()=>{
  await call('put','/settings/dingtalk-connection',{enabled:true,clientId:'fixture-app',clientSecret:dingSecret,expectedUpdatedAt:null}).expect(200);
  await call('put','/settings/dingtalk-connection',{enabled:false,clientId:'fixture-app'}).expect(200);
  const saved=(await call('get','/settings').expect(200)).body;assert.equal(saved.dingtalk.hasCredentials,true);assert.ok(!JSON.stringify(saved).includes(dingSecret));assert.ok(!JSON.stringify(await db('la_settings').where({key:'dingtalk_connection'}).first()).includes(dingSecret));
  await call('put','/settings/dingtalk-connection',{enabled:false,clientId:'different-app'}).expect(400);
  const result=await probeDing(await dingConfig(db),{fetchImpl:async()=>Response.json({accessToken:'private-token',expireIn:7200})});assert.equal(result.status,'success');assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('Worker applies connection changes and stops the prior stream without restarting API',async()=>{
  const changes=[],stops=[];const manager=manageIntegration(db,{intervalMs:60000,start:async(_,c)=>{changes.push(c.enabled);return{stop:async()=>stops.push(c.enabled)};}});
  try{await manager.ready;await call('put','/settings/dingtalk-connection',{enabled:true,clientId:'fixture-app'}).expect(200);await manager.refresh();await call('put','/settings/dingtalk-connection',{enabled:false,clientId:'fixture-app'}).expect(200);await manager.refresh();assert.deepEqual(changes,[false,true,false]);assert.equal((await db('la_settings').where({key:'dingtalk_status'}).first()).value.status,'disabled');}finally{await manager.stop();}assert.equal(stops.length,3);
});
test('service diagnostics check real database, worker and storage; OCR reachability stays distinct from model verification',async()=>{
  const offline=await serviceDiagnostics(db);assert.equal(offline.find(c=>c.id==='database').status,'success');assert.equal(offline.find(c=>c.id==='storage').status,'success');assert.equal(offline.find(c=>c.id==='worker').status,'warning');
  await db('la_settings').insert({key:'worker_heartbeat',value:JSON.stringify({lastSeen:new Date().toISOString()})});config.ocrUrl=url.replace('/v1','');config.ocrToken='fixture-internal-token';const response=await call('post','/settings/diagnostics',{}).expect(200);assert.equal(response.body.checks.find(c=>c.id==='worker').status,'success');const ocr=response.body.checks.find(c=>c.id==='ocr');assert.equal(ocr.status,'success');assert.match(ocr.message,/样本验证/);
});
