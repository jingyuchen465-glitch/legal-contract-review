// Integrates with the pinned DeepSeek Harness tool/skill services. This file is
// installed beside the upstream CLI so it shares the same Cordis dependency tree.
import { defineTool } from '@deepseek-ai/dsh-tools';
export const inject = ['tools', 'skills', 'workingDirectory'];
async function rpc(route, body, signal) {
  const response = await fetch(process.env.LEGAL_BRIDGE_URL + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + process.env.LEGAL_BRIDGE_TOKEN, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || 'Legal tool bridge rejected request');
  return value;
}
function schema(node, required = false) {
  if (node.additionalProperties && node.type === 'object') return { type: 'json', ...(required ? { required: true } : {}), ...(node.description ? { description: node.description } : {}) };
  const value = { type: node.type, ...(node.description ? { description: node.description } : {}), ...(required ? { required: true } : {}) };
  if (node.type === 'object') { value.properties = Object.fromEntries(Object.entries(node.properties || {}).map(([k, v]) => [k, schema(v, node.required?.includes(k))])); value.additionalProperties = Boolean(node.additionalProperties); }
  if (node.enum) value.enum = node.enum;
  if (node.const !== undefined) value.const = node.const;
  if (node.type === 'array') value.items = schema(node.items);
  return value;
}
export async function apply(ctx) {
  const data = await rpc('/context');
  const candidates = data.skills.map(s => ({
    name: s.name, description: s.description, provider: 'legal-memory', source: 'runtime', rank: 0,
    invocation: { modelInvocable: true, userInvocable: true }, locator: s.versionId,
  }));
  ctx.skills.registerProvider(() => ({
    name: 'legal-memory',
    async list() { await rpc('/active'); return candidates; },
    async get(candidate) {
      await rpc('/active');
      const found = data.skills.find(s => s.name === candidate.name && s.versionId === candidate.locator);
      if (!found) return undefined;
      await rpc('/skill-loaded', { name: found.name, versionId: found.versionId });
      return { ...candidate, content: found.content, resourceBase: { kind: 'opaque', description: '使用 read_skill_resource 读取本技能的 method 资源；不支持文件访问或脚本执行。' } };
    },
  }));
  for (const def of data.tools) ctx.tools.register(defineTool({
    name: def.name, description: def.description,
    parameters: Object.fromEntries(Object.entries(def.parameters.properties).map(([k, v]) => [k, schema(v, def.parameters.required?.includes(k))])),
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const value = await rpc('/tools', { name: def.name, args, callId: exec.callId }, exec.signal);
      if ((def.name === 'request_information' && value.questionId) || (['submit_review', 'observe_review'].includes(def.name) && value.submitted) || (def.name === 'generate_annotated_docx' && value.generated)) exec.concludeTurn();
      return value;
    },
  }));
  const allowed = new Set([...data.tools.map(t => t.name), 'skill']);
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Tool is outside the legal task capability set');
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const visible = ctx.tools.schemas(agent).map(t => t.name);
    if (visible.some(name => !allowed.has(name))) throw new Error('Unexpected model-facing capability in legal profile');
    await rpc('/active');
    return next();
  });
  await rpc('/ready', { tools: ctx.tools.schemas().map(t => t.name) });
}
