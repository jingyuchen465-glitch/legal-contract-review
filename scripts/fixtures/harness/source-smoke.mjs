import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, childEnvironment, stderrLines } from './support.mjs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const {DeepSeekHarness, stateRoot:checkRoot, extensionRoot} = await createFixture('source');
let requests = 0;
let advertised;
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer smoke-not-a-real-key');
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body); requests++;
  advertised = input.tools?.map(t => t.function.name) || [];
  console.log(JSON.stringify({request:requests,keys:Object.keys(input),advertised}));
  const delta = requests === 1
    ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call-ping', type: 'function', function: { name: 'legal_ping', arguments: '{"value":"contract-check"}' } }] }
    : { role: 'assistant', content: 'LEGAL_SMOKE_OK' };
  const chunk = data => `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'legal-test', choices: [{ index: 0, delta: data, finish_reason: null }] })}\n\n`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(chunk(delta) + `data: ${JSON.stringify({ id:'smoke',object:'chat.completion.chunk',created:1,model:'legal-test',choices:[{index:0,delta:{},finish_reason:requests===1?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}})}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const disabled = ['persistent-bash','persistent-pwsh','terminal-bash','terminal-pwsh','tool-fs','tool-working-directory','session-log-deepseek','plugin-package-inventory-deepseek','llm-deepseek','image-offload','deepseek-llm-api-extensions'];
const pluginPath = join(extensionRoot, 'legal-smoke-plugin.mjs');
await writeFile(pluginPath, `import {defineTool} from '@deepseek-ai/dsh-tools';\nexport const name='legal-test';export const inject=['tools'];export function apply(ctx){ctx.tools.register(defineTool({name:'legal_ping',description:'Check one task-bound value',parameters:{value:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async a=>a.value}));}\n`);
const patchPath = join(checkRoot, 'legal.patch.yml');
await writeFile(patchPath, JSON.stringify([
  ...disabled.map(id => ({id,disabled:true})),
  { id:'system-prompt',config:{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'You review contracts using available legal tools.'}},
  {id:'compaction-basic',config:{headroomTokens:4096,maxTokens:2048,thresholdRatio:0.8,retainRatio:0.16}},
  {insert:[{id:'legal-model',name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{'legal-gateway':{api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:'LEGAL_MODEL_KEY',models:[{id:'legal-test',name:'Legal test',contextWindow:32768,maxTokens:4096}]}}}},{id:'legal-test',name:pathToFileURL(pluginPath).href}]}
], null, 2));
const harness = new DeepSeekHarness({profile:'sdk-minimal',patches:[patchPath],dshHome:join(checkRoot,'home'),cwd:checkRoot,processCwd:checkRoot,provider:'legal-gateway',model:'legal-test',maxTokens:1024,initializeTimeoutMs:30000,requestTimeoutMs:45000,env:childEnvironment({LEGAL_MODEL_KEY:'smoke-not-a-real-key'})});
try {
  const result = await harness.run('Call legal_ping with value contract-check, then report completion.',{sessionId:'legal-smoke-'+Date.now()});
  if (result.finishReason !== 'completed') console.error(JSON.stringify({ finishReason: result.finishReason, errors: result.events.filter(e => e.type === 'turn/end').map(e => e.data.reason), stderr: stderrLines(harness) }));
  assert.equal(result.finishReason,'completed');
  assert.equal(result.finalResponse,'LEGAL_SMOKE_OK');
  console.log(JSON.stringify({events:result.events.filter(e=>e.type==='tool/call'||e.type==='tool/result'),usageNotifications:result.notifications.filter(n=>n.method==='session.event'&&n.params.event?.data?.usage),stderr:stderrLines(harness)}));
  assert.equal(requests,2); assert.deepEqual(advertised,['legal_ping']);
  assert.deepEqual(stderrLines(harness),[]);
  assert.equal(result.events.filter(e=>e.type==='tool/result').every(e=>!e.data.message.isError),true);
  console.log(JSON.stringify({ok:true,requests,advertised,finishReason:result.finishReason,eventTypes:[...new Set(result.events.map(e=>e.type))]}));
} finally {await harness.close(); await new Promise(resolve=>server.close(resolve));}
