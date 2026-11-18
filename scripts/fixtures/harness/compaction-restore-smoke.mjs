import {createServer} from 'node:http';
import {writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createFixture,childEnvironment,projectRoot,stderrLines} from './support.mjs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {DeepSeekHarness,stateRoot:data,extensionRoot:extension}=await createFixture('compaction-restore');
await copyFile(join(projectRoot,'runtime/legal-harness/compaction.mjs'),join(extension,'compaction.mjs'));
let requests=0,summaries=0,compacted,stage=0,restoredInput,afterCompactInput;
const packet=(delta,finish_reason=null)=>({id:'compact-smoke',object:'chat.completion.chunk',created:1,model:'legal-test',choices:[{index:0,delta,finish_reason}]});
const server=createServer(async(req,res)=>{
 try {
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');
  if(req.url==='/test/compacted'){compacted=body;res.writeHead(200,{'content-type':'application/json'});return res.end('{}');}
  assert.equal(req.url,'/model/chat/completions');assert.equal(req.headers.authorization,'Bearer smoke-only-token');requests++;
  const isSummary=body.messages.at(-1)?.content?.includes?.('LEGAL_COMPACT_TEST')||JSON.stringify(body.messages.at(-1)).includes('LEGAL_COMPACT_TEST');
  let delta;
  if(isSummary){summaries++;delta={role:'assistant',content:'## Contract checkpoint\nCONTRACT_ALPHA fixed method-version-1. Ping completed. Continue review and preserve source evidence.'};}
  else if(stage===0){stage=1;delta={role:'assistant',content:null,tool_calls:[{index:0,id:'ping',type:'function',function:{name:'legal_ping',arguments:'{"value":"CONTRACT_ALPHA"}'}}]};}
  else if(stage===1){stage=2;delta={role:'assistant',content:'FIRST_TURN_OK'};}
  else if(stage===2){afterCompactInput=body;stage=3;delta={role:'assistant',content:'AFTER_COMPACTION_OK'};}
  else {restoredInput=body;stage=4;delta={role:'assistant',content:'RESTORED_OK'};}
  const end=packet({},delta.tool_calls?'tool_calls':'stop');end.usage={prompt_tokens:100,completion_tokens:20,total_tokens:120};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify(packet(delta))}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
 }catch(error){console.error(error);res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({message:error.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const bridge=`http://127.0.0.1:${server.address().port}`;
const plugin=join(extension,'force-compaction-smoke.mjs');
await writeFile(plugin,`import {defineTool} from '@deepseek-ai/dsh-tools';
export const inject=['tools','compaction'];
export function apply(ctx){
 let steps=0;
 ctx.tools.register(defineTool({name:'legal_ping',description:'Test-bound ping',parameters:{value:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a,value)=>[{type:'text',text:value}]},execute:async a=>a.value}));
 ctx.on('agent/pre-step',async({agent,signal},next)=>{
  steps++;if(steps===3){const r=await ctx.compaction.compactIfNeeded(agent,'context-overflow',signal);await fetch(process.env.SMOKE_BRIDGE+'/test/compacted',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(r?{compacted:true,shadowedTokenCount:r.shadowedTokenCount,shadowedSeqs:r.shadowedSeqs}:null)});}
  return next();
 });
}
`);
const disabled=['persistent-bash','persistent-pwsh','terminal-bash','terminal-pwsh','tool-fs','tool-working-directory','session-log-deepseek','plugin-package-inventory-deepseek','llm-deepseek','image-offload','deepseek-llm-api-extensions','compaction-basic'];
const patch=[...disabled.map(id=>({id,disabled:true})),{id:'system-prompt',config:{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'Review only the task-bound contract.'}},{insert:[
 {id:'legal-llm',name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{'legal-gateway':{api:'openai-completions',apiKeyEnv:'LEGAL_BRIDGE_TOKEN',baseURL:bridge+'/model',models:[{id:'legal-test',name:'Legal test',contextWindow:32768,maxTokens:4096,reasoningEfforts:false}]}}}},
 {id:'legal-compaction',name:pathToFileURL(join(extension,'compaction.mjs')).href,config:{auto:false,headroomTokens:4096,maxTokens:6000,thresholdRatio:.8,retainRatio:.16}},
 {id:'force-compaction-smoke',name:pathToFileURL(plugin).href}
]}];
const patchPath=join(data,'legal.cordis.patch.yml');await writeFile(patchPath,JSON.stringify(patch,null,2));
const options={profile:'sdk-minimal',patches:[patchPath],dshHome:join(data,'home'),cwd:data,processCwd:data,provider:'legal-gateway',model:'legal-test',maxTokens:1024,initializeTimeoutMs:30000,requestTimeoutMs:45000,env:childEnvironment({LEGAL_BRIDGE_TOKEN:'smoke-only-token',LEGAL_COMPACTION_PROMPT:'LEGAL_COMPACT_TEST: summarize exact contract facts, method version and unfinished work.',SMOKE_BRIDGE:bridge})};
let harness=new DeepSeekHarness(options);const sessionId='compact-restore-'+Date.now();
try {
 const first=await harness.run('CONTRACT_ALPHA method-version-1. Call legal_ping then finish. Historical body: '+('ARCHIVED_CLAUSE_CONTENT '.repeat(3000)),{sessionId});
 assert.equal(first.finalResponse,'FIRST_TURN_OK');
 const second=await harness.session(sessionId).run('Continue using preserved legal facts.');
 console.log(JSON.stringify({secondFinish:second.finishReason,secondText:second.finalResponse,compacted,compactionEvents:second.events.filter(e=>e.type.startsWith('compaction/')),stderr:stderrLines(harness)}));
 assert.equal(second.finalResponse,'AFTER_COMPACTION_OK');assert.equal(summaries,1);assert.equal(compacted?.compacted,true);assert.equal(JSON.stringify(afterCompactInput.messages).includes('<compacted-summary>'),true);assert.equal(JSON.stringify(afterCompactInput.messages).includes('ARCHIVED_CLAUSE_CONTENT'),false);
 const summaryEvent=second.events.find(e=>e.type==='compaction/summary');assert.deepEqual(summaryEvent.data.usage,{inputTokens:100,outputTokens:20,totalTokens:120});assert.equal(summaryEvent.data.llmStreamCall,true);
 await harness.close();harness=new DeepSeekHarness(options);
 const session=await harness.resumeSession(sessionId);const third=await session.run('Read the stored checkpoint and continue.');
 assert.equal(third.finalResponse,'RESTORED_OK');assert.equal(JSON.stringify(restoredInput.messages).includes('<compacted-summary>'),true);assert.equal(JSON.stringify(restoredInput.messages).includes('CONTRACT_ALPHA'),true);assert.equal(JSON.stringify(restoredInput.messages).includes('ARCHIVED_CLAUSE_CONTENT'),false);assert.equal(requests,5);assert.deepEqual(stderrLines(harness),[]);
 console.log(JSON.stringify({ok:true,requests,summaries,resumedSession:sessionId,restoredText:third.finalResponse,restoredCheckpoint:true,usageNotification:third.notifications.find(n=>n.method==='session.event'&&n.params.event?.data?.usage)}));
}finally{await harness.close();await new Promise(resolve=>server.close(resolve));}
