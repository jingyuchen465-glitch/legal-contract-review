const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomBytes}=require('node:crypto'),{pathToFileURL}=require('node:url');
const {settings,UPSTREAM_COMMIT}=require('./config'),{profile,childEnv}=require('./runtime');
const {providerConfig}=require('../model'),{fail}=require('../errors');
async function probeGateway(db){
  const opts=await settings(db),model=await providerConfig(db);
  if(!model.key||!model.name||!model.baseUrl)fail(422,'MODEL_NOT_CONFIGURED','请先保存模型配置');
  let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(opts.runtimeRoot,'legal-runtime.json'),'utf8'));}catch{fail(503,'HARNESS_NOT_BUILT','请先运行 npm run harness:build');}
  if(manifest.commit!==UPSTREAM_COMMIT)fail(503,'HARNESS_VERSION_MISMATCH','Harness 版本不匹配');
  const {DeepSeekHarness}=await import(pathToFileURL(path.join(opts.runtimeRoot,manifest.sdk)).href);
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'legal-probe-')),token=randomBytes(24).toString('hex'),nonce=randomBytes(16).toString('hex');
  const controllers=new Set();let harness,requests=0,called=false,ready=false,reasoningObserved=false;
  const server=http.createServer(async(req,res)=>{try{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(403);return res.end();}
    const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>1024*1024)throw Error('probe body');chunks.push(c);}const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    res.setHeader('Content-Type','application/json');
    if(req.url==='/ready'){ready=body.tools?.length===1&&body.tools[0]==='legal_probe_echo';return res.end('{}');}
    if(req.url==='/probe'){if(body.value!=='legal-connectivity-check')throw Error('probe args');called=true;return res.end(JSON.stringify({verification:nonce}));}
    if(req.url!=='/model/chat/completions'||!ready||++requests>5)throw Error('probe capability');
    const controller=new AbortController();controllers.add(controller);
    try{const r=await fetch(model.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+model.key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]),redirect:'error'});res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')||'application/json'});for await(const c of r.body||[])res.write(c);res.end();}finally{controllers.delete(controller);}
  }catch{if(!res.headersSent)res.writeHead(422);res.end(JSON.stringify({error:{message:'Gateway tool probe failed'}}));}});
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const bridge='http://127.0.0.1:'+server.address().port;
    const patch=profile(opts.runtimeRoot,bridge+'/model',model,opts);const insert=patch.find(p=>p.insert).insert;
    insert.splice(1);insert.push({id:'legal-probe',name:pathToFileURL(path.join(opts.runtimeRoot,'apps/cli/legal-extension/probe.mjs')).href});
    patch.find(p=>p.id==='system-prompt').config.personaPrefix='你只做工具兼容测试。必须先调用legal_probe_echo，value为legal-connectivity-check，再逐字输出工具返回的verification。';
    const patchPath=path.join(home,'probe.json');await fs.writeFile(patchPath,JSON.stringify(patch));
    harness=new DeepSeekHarness({profile:'sdk-minimal',patches:[patchPath],dshHome:home,cwd:home,processCwd:home,env:childEnv({LEGAL_BRIDGE_URL:bridge,LEGAL_BRIDGE_TOKEN:token}),provider:'legal-gateway',model:model.name,initializeTimeoutMs:60000,shutdownTimeoutMs:1000,disposeEofGraceMs:1000,disposeGraceMs:1000});
    let timer;try{const result=await Promise.race([harness.session('probe-'+nonce).run('请完成一次真实工具调用，然后输出工具返回的verification。',{onNotification:n=>{if(n.params?.event?.type==='assistant/message'&&JSON.stringify(n.params.event.data.message).includes('reasoning'))reasoningObserved=true;}}),new Promise((_r,j)=>{timer=setTimeout(()=>j(Error('probe timeout')),150000);})]);if(!ready||!called||requests<2||!result.finalResponse?.includes(nonce))fail(422,'AGENT_GATEWAY_INCOMPATIBLE','模型未完成真实工具调用与连续回传：工具清单='+ready+'，工具执行='+called+'，模型请求='+requests+'，结束原因='+result.finishReason+'。请检查模型及推理格式');return {status:'success',requests,reasoningObserved,message:`官方 Harness 已完成工具调用与连续回传（${requests} 次模型请求）。推理参数按已保存配置发送；压缩与恢复另由场景测试核验。`};}finally{clearTimeout(timer);}
  }finally{for(const c of controllers)c.abort();await harness?.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});}
}
module.exports={probeGateway};
