import { createServer } from 'node:http';
import { copyFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createFixture, childEnvironment, projectRoot, stderrLines } from './support.mjs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const {DeepSeekHarness,stateRoot:fixtureRoot,extensionRoot}=await createFixture('product');
for(const file of ['plugin.mjs','compaction.mjs']) await copyFile(join(projectRoot,'runtime/legal-harness',file),join(extensionRoot,file));
const require=createRequire(import.meta.url);
const {toolDefinitions:definitions}=require(join(projectRoot,'backend/pilot/agent/tools.js'));
const endMode=process.env.SMOKE_END;
assert.ok(!endMode || ['question','submit'].includes(endMode),'SMOKE_END must be question or submit');
const calls=[];let requests=0,ready=false,loaded=false,resource=false,advertised=[];
const reply=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 try {
  assert.equal(req.headers.authorization,'Bearer test-only-bridge-token');
  if(req.url==='/context') return reply(res,200,{tools:definitions,skills:[{name:'legal-smoke-method',description:'A fixed legal review method for the smoke fixture.',versionId:'method-version-1',content:'Use read_skill_resource to get method. This is a test-only instruction.'}]});
  if(req.url==='/active') return reply(res,200,{active:true});
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');
  if(req.url==='/ready') {ready=true;advertised=body.tools;return reply(res,200,{ready:true});}
  if(req.url==='/skill-loaded') {loaded=true;return reply(res,200,{recorded:true});}
  if(req.url==='/tools') {calls.push(body);if(endMode){assert.equal(body.name,endMode==='question'?'request_information':'submit_review');return reply(res,200,endMode==='question'?{questionId:'question-1',question:'Who is the contracting party?'}:{submitted:true});}assert.equal(body.name,'read_skill_resource');assert.equal(body.args.skillName,'legal-smoke-method');resource=true;return reply(res,200,{content:'SMOKE_METHOD_BODY',versionId:'method-version-1'});}
  assert.equal(req.url,'/model/chat/completions');if(!ready) console.error(JSON.stringify({startupFailure:stderrLines(harness)}));assert.equal(ready,true);requests++;
  const names=(body.tools||[]).map(t=>t.function.name).sort();
  assert.deepEqual(names,[...definitions.map(t=>t.name),'skill'].sort());
  const notes=body.tools.find(t=>t.function.name==='update_task_notes').function.parameters.properties.notes;
  assert.equal(notes.additionalProperties,false);assert.equal(notes.properties.facts.items.additionalProperties,false);
  const delta=endMode?{role:'assistant',content:null,tool_calls:[{index:0,id:'end-tool',type:'function',function:{name:endMode==='question'?'request_information':'submit_review',arguments:JSON.stringify(endMode==='question'?{question:'Who is the contracting party?'}:{report:{}})}}]}:requests===1?{role:'assistant',content:null,tool_calls:[{index:0,id:'load-skill',type:'function',function:{name:'skill',arguments:JSON.stringify({name:'legal-smoke-method'})}}]}:requests===2?{role:'assistant',content:null,tool_calls:[{index:0,id:'read-method',type:'function',function:{name:'read_skill_resource',arguments:JSON.stringify({skillName:'legal-smoke-method',resource:'method'})}}]}:{role:'assistant',content:'PRODUCT_SMOKE_OK'};
  const packet=(delta,finish_reason=null)=>({id:'product-smoke',object:'chat.completion.chunk',created:1,model:'legal-test',choices:[{index:0,delta,finish_reason}]});
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify(packet(delta))}\n\ndata: ${JSON.stringify(packet({},requests<3?'tool_calls':'stop'))}\n\ndata: [DONE]\n\n`);
 }catch(error){console.error(error);reply(res,400,{message:error.message});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const bridge=`http://127.0.0.1:${server.address().port}`;
const disabled=['persistent-bash','persistent-pwsh','terminal-bash','terminal-pwsh','tool-fs','tool-working-directory','session-log-deepseek','plugin-package-inventory-deepseek','llm-deepseek','image-offload','deepseek-llm-api-extensions','compaction-basic'];
const patch=[...disabled.map(id=>({id,disabled:true})),{id:'system-prompt',config:{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'You review legal contracts using only the available legal tools.'}},{insert:[
 {id:'legal-llm',name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{'legal-gateway':{api:'openai-completions',apiKeyEnv:'LEGAL_BRIDGE_TOKEN',baseURL:bridge+'/model',models:[{id:'legal-test',name:'Legal test',contextWindow:32768,maxTokens:4096,reasoningEfforts:false}]}}}},
 {id:'legal-skills',name:'@deepseek-ai/dsh-skill'},
 {id:'legal-tool-skill',name:'@deepseek-ai/dsh-tool-skill'},
 {id:'legal-compaction',name:pathToFileURL(join(extensionRoot,'compaction.mjs')).href,config:{thresholdRatio:.8,headroomTokens:4096,retainRatio:.16,maxTokens:2048}},
 {id:'legal-tools',name:pathToFileURL(join(extensionRoot,'plugin.mjs')).href}
]}];
const patchPath=join(fixtureRoot,'legal.cordis.patch.yml');await writeFile(patchPath,JSON.stringify(patch,null,2));
const harness=new DeepSeekHarness({profile:'sdk-minimal',patches:[patchPath],dshHome:join(fixtureRoot,'home'),cwd:fixtureRoot,processCwd:fixtureRoot,provider:'legal-gateway',model:'legal-test',maxTokens:1024,initializeTimeoutMs:30000,env:childEnvironment({LEGAL_BRIDGE_URL:bridge,LEGAL_BRIDGE_TOKEN:'test-only-bridge-token',LEGAL_COMPACTION_PROMPT:'Summarize legal facts and unresolved questions.'})});
try {
 const result=await harness.run('Load legal-smoke-method then read its method resource and finish.',{sessionId:'product-smoke-'+Date.now()});
 console.log(JSON.stringify({finishReason:result.finishReason,finalResponse:result.finalResponse,requests,ready,loaded,resource,advertised,tools:result.events.filter(e=>e.type==='tool/result'),stderr:stderrLines(harness)}));
 assert.equal(result.finishReason,'completed');if(endMode){assert.equal(requests,1);assert.equal(calls.length,1);console.log(JSON.stringify({ok:true,endMode,requests,concludedByTool:true}));}else{assert.equal(result.finalResponse,'PRODUCT_SMOKE_OK');assert.equal(loaded,true);assert.equal(resource,true);assert.equal(requests,3);}assert.deepEqual(stderrLines(harness),[]);assert.equal(result.events.filter(e=>e.type==='tool/result').every(e=>!e.data.message.isError),true);
}finally{await harness.close();await new Promise(resolve=>server.close(resolve));}
