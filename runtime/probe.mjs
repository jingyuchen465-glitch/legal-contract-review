import { defineTool } from '@deepseek-ai/dsh-tools';
export const inject=['tools'];
export async function apply(ctx){
  ctx.tools.register(defineTool({name:'legal_probe_echo',description:'连通性测试：调用工具取得验证字符串，然后在最终回答逐字输出该字符串。',parameters:{value:{type:'string',required:true}},output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(args){const r=await fetch(process.env.LEGAL_BRIDGE_URL+'/probe',{method:'POST',headers:{Authorization:'Bearer '+process.env.LEGAL_BRIDGE_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(args)});if(!r.ok)throw Error('Probe rejected');return r.json();}}));
  await fetch(process.env.LEGAL_BRIDGE_URL+'/ready',{method:'POST',headers:{Authorization:'Bearer '+process.env.LEGAL_BRIDGE_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({tools:ctx.tools.schemas().map(t=>t.name)})});
}
