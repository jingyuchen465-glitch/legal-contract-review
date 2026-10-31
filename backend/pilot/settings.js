const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { config } = require('./config');
const { providerConfig, encrypt, decrypt, validateBaseUrl } = require('./model');
const { fail } = require('./errors');

const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readSetting = async (db, key) => (await db('la_settings').where({ key }).first()) || null;
const iso = value => value ? new Date(value).toISOString() : null;
async function updateSetting(db, key, expectedUpdatedAt, build) {
  return db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['settings:' + key]);
    const prior = await trx('la_settings').where({ key }).forUpdate().first();
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== iso(prior?.updated_at)) fail(409, 'SETTINGS_CHANGED', '此配置已被更新，请重新载入后再保存');
    const value = await build(prior?.value || {});
    return (await trx('la_settings').insert({ key, value: JSON.stringify(value) }).onConflict('key').merge({ value: JSON.stringify(value), updated_at: trx.fn.now() }).returning('*'))[0];
  });
}
function normalizeModelUrl(value) {
  const base = String(value).trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models|embeddings)$/i, '');
  return validateBaseUrl(base);
}
const modelInput = z.object({ baseUrl: z.string().min(1).max(2000), name: z.string().trim().min(1).max(200), apiKey: z.string().max(10000).optional() });
async function modelCandidate(db, raw) {
  const input = modelInput.parse(raw), current = await providerConfig(db), baseUrl = normalizeModelUrl(input.baseUrl), key = input.apiKey?.trim();
  if (baseUrl !== current.baseUrl && !key && current.key) fail(400, 'MODEL_KEY_REQUIRED', '更换服务地址时，请重新填写对应服务的 API 密钥');
  return { ...current, baseUrl, name: input.name, key: key || current.key || '' };
}
async function dingConfig(db) {
  const row = await readSetting(db, 'dingtalk_connection');
  if (!row) return { ...config.ding };
  const v = row.value;
  return { ...config.ding, enabled: v.enabled, clientId: v.clientId, secret: v.encryptedSecret ? decrypt(v.encryptedSecret) : config.ding.secret };
}
const dingInput = z.object({ enabled: z.boolean(), clientId: z.string().trim().max(200), clientSecret: z.string().max(10000).optional() });
async function dingCandidate(db, raw) {
  const input = dingInput.parse(raw), current = await dingConfig(db), secret = input.clientSecret?.trim();
  if (input.clientId !== current.clientId && !secret && current.secret) fail(400, 'DING_SECRET_REQUIRED', '更换应用标识时，请重新填写该应用的密钥');
  const candidate = { ...current, enabled: input.enabled, clientId: input.clientId, secret: secret || current.secret || '' };
  if (candidate.enabled && (!candidate.clientId || !candidate.secret)) fail(400, 'DING_CREDENTIALS_REQUIRED', '启用接入前，请填写应用标识和密钥');
  return candidate;
}
const archiveInput = z.object({ enabled: z.boolean().default(true), root: z.string().trim().max(1000) });
async function archiveCandidate(raw) {
  const input = archiveInput.parse({ enabled: raw?.enabled ?? true, root: raw?.root ?? '' });
  if (!input.enabled) return { enabled: false, root: '' };
  if (!input.root || !path.isAbsolute(input.root)) fail(400, 'ARCHIVE_ROOT_ABSOLUTE', '归档主目录必须填写绝对路径，例如 D:\\法务合同');
  const root = path.resolve(input.root);
  await fs.mkdir(root, { recursive: true });
  await fs.access(root, constants.R_OK | constants.W_OK);
  return { enabled: true, root };
}
async function archiveConfig(db) {
  const row = await readSetting(db, 'contract_archive');
  const value = row?.value || {};
  return { enabled: value.enabled === true && !!value.root, root: value.root || '', updatedAt: iso(row?.updated_at) };
}
function result(status, message, start, extra = {}) { return { status, message, checkedAt: new Date().toISOString(), elapsedMs: Date.now() - start, ...extra }; }
function httpMessage(status) {
  return ({ 401: '密钥未通过验证，请检查密钥是否属于此服务', 403: '应用或模型访问权限不足，请检查服务授权', 404: '接口或模型不存在，请核对服务地址和模型名称', 429: '服务限流或额度不足，请稍后重试并检查账户额度' })[status] || (status >= 500 ? '服务暂时不可用，请稍后重试' : `服务返回 HTTP ${status}，请核对配置`);
}
async function responseJson(response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('EMPTY_RESPONSE');
  const parts = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 512 * 1024) throw new Error('OVERSIZE'); parts.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function probeModel(candidate, { fetchImpl = fetch, list = false } = {}) {
  const start = Date.now(); if (!candidate.key) return result('unconfigured', '请先填写 API 密钥；无鉴权的本机服务可填写 local', start);
  try {
    const response = await fetchImpl(candidate.baseUrl + (list ? '/models' : '/chat/completions'), {
      method: list ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${candidate.key}`, ...(list ? {} : { 'Content-Type': 'application/json' }) },
      ...(list ? {} : { body: JSON.stringify({ model: candidate.name, messages: [{ role: 'user', content: '连接测试。只返回 JSON：{"ok":true}。' }], response_format: { type: 'json_object' }, max_tokens: 64 }) }),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return result('error', httpMessage(response.status), start, { httpStatus: response.status }); }
    const data = await responseJson(response);
    if (list) {
      const models = [...new Set((Array.isArray(data.data) ? data.data : []).map(m => m.id).filter(id => typeof id === 'string' && id.length <= 200))].slice(0, 200);
      return result(models.length ? 'success' : 'warning', models.length ? `读取到 ${models.length} 个可选模型，也可手动填写名称` : '服务未返回模型列表，请手动填写模型名称', start, { models });
    }
    const text = data.choices?.[0]?.message?.content; let answer;
    try { answer = JSON.parse(text); } catch {}
    if (answer?.ok !== true) return result('warning', '接口已响应，但未通过 JSON 输出检查；请确认模型支持结构化输出', start);
    return result('success', '连接与 JSON 输出检查通过；实际审查效果需通过合同样本验证', start);
  } catch { return result('error', '连接失败、超时或响应格式无效，请检查服务地址、网络及接口兼容性', start); }
}
async function probeDing(candidate, { fetchImpl = fetch } = {}) {
  const start = Date.now(); if (!candidate.clientId || !candidate.secret) return result('unconfigured', '请填写应用标识和密钥后再验证', start);
  try {
    const response = await fetchImpl('https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appKey: candidate.clientId, appSecret: candidate.secret }) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return result('error', '钉钉鉴权未通过，请核对企业内部应用标识、密钥和网络', start, { httpStatus: response.status }); }
    const data = await responseJson(response);
    return data.accessToken ? result('success', '应用凭据有效；审批及附件权限仍需用实际审批联调', start) : result('error', '钉钉未返回有效凭证，请核对应用配置', start);
  } catch { return result('error', '无法连接钉钉，请检查网络后重试', start); }
}
async function publicSettings(db) {
  const [p, ding, modelRow, connectionRow, checksRow, runtimeRow, archive] = await Promise.all([providerConfig(db), dingConfig(db), readSetting(db,'model'), readSetting(db,'dingtalk_connection'), readSetting(db,'connection_checks'), readSetting(db,'dingtalk_status'), archiveConfig(db)]);
  const checks = checksRow?.value || {}, modelCheck = checks.model;
  const bound = await db('la_dingtalk_accounts as a').join('la_users as u','a.user_id','u.id').where({'a.client_id':ding.clientId || '', 'u.active':true}).whereRaw("jsonb_exists( u.roles, 'admin' )").count('* as count').first();
  return {
    model: { baseUrl: p.baseUrl || '', name: p.name || '', hasKey: !!p.key, concurrency: config.model.concurrency, updatedAt: iso(modelRow?.updated_at), check: modelCheck?.fingerprint === fingerprint([p.baseUrl,p.name,p.key]) ? modelCheck.result : null },
    jev: { model: config.jev.name, hasKey: !!config.jev.key },
    dingtalk: { boundAccounts: Number(bound.count), callbackUrl: new URL('/dingtalk/callback', config.publicUrl).href, enabled: ding.enabled, clientId: ding.clientId || '', hasCredentials: !!ding.clientId && !!ding.secret, hasSecret: !!ding.secret, connectionUpdatedAt: iso(connectionRow?.updated_at), runtime: runtimeRow?.value || null },
    archive,
    services: { ocrConfigured: !!config.ocrUrl && !!config.ocrToken, officeConfigured: !!config.office.url && !!config.office.secret, storageRoot: config.dataRoot, milvusConfigured: !!process.env.MILVUS_ADDRESS, embeddingConfigured: !!config.embeddingModel, ocrUrl: config.ocrUrl || '', officeUrl: config.office.url || '', milvusAddress: process.env.MILVUS_ADDRESS || '', embeddingModel: config.embeddingModel || '' },
  };
}
async function saveModelCheck(db, candidate, check) {
  const saved = await providerConfig(db);
  // Testing an unsaved draft must never certify the saved provider.
  if (fingerprint([saved.baseUrl,saved.name,saved.key]) !== fingerprint([candidate.baseUrl,candidate.name,candidate.key])) return;
  await updateSetting(db, 'connection_checks', undefined, prior => ({ ...prior, model: { fingerprint: fingerprint([candidate.baseUrl,candidate.name,candidate.key]), result: check } }));
}
async function serviceDiagnostics(db, { fetchImpl = fetch } = {}) {
  const checks = [];
  const measure = async (id, name, task) => { const start = Date.now(); try { return { id, name, ...await task(start) }; } catch { return { id, name, ...result('error', '暂时无法访问，请检查部署配置和服务是否运行', start) }; } };
  checks.push(measure('database','业务数据库',async start => { await db.raw('select 1'); return result('success','数据库连接正常',start); }));
  checks.push(measure('worker','异步任务 Worker',async start => { const value = (await readSetting(db,'worker_heartbeat'))?.value; const fresh = value?.lastSeen && Date.now()-new Date(value.lastSeen).getTime() < 90000; return result(fresh?'success':'warning',fresh?'任务进程在线':'未收到近期心跳，请启动或检查 Worker',start); }));
  checks.push(measure('storage','本机文件存储',async start => { await fs.access(config.dataRoot,constants.R_OK|constants.W_OK); const stat=await fs.statfs(config.dataRoot); return result('success',`目录可读写，可用空间约 ${(Number(stat.bavail)*Number(stat.bsize)/1024**3).toFixed(1)} GB`,start); }));
  for (const [id,name,url,configured,path] of [['ocr','扫描识别 OCR',config.ocrUrl,!!config.ocrUrl&&!!config.ocrToken,'/health'],['office','在线编辑 OnlyOffice',config.office.internalUrl,!!config.office.url&&!!config.office.secret,'/healthcheck']]) {
    checks.push(measure(id,name,async start => {
      if (!configured) return result('unconfigured','尚未配置；不影响文字版合同的手动上传',start);
      const response=await fetchImpl(url.replace(/\/$/,'')+path,{redirect:'error',signal:AbortSignal.timeout(8000)});
      let valid=response.ok; if(id==='office') valid=valid&&(await response.text()).trim()==='true';else { const value=await responseJson(response);valid=valid&&value.ok===true; }
      return result(valid?'success':'error',valid?(id==='ocr'?'服务可达；扫描识别模型仍需样本验证':'文档服务可达；在线编辑与回调仍需样本验证'):'服务健康检查未通过，请检查部署',start);
    }));
  }
  checks.push(measure('milvus','知识检索 Milvus',async start => {
    if(!process.env.MILVUS_ADDRESS)return result('unconfigured','尚未配置；短规则资料仍可完整参与审查',start);
    const {MilvusClient}=require('@zilliz/milvus2-sdk-node'),client=new MilvusClient({address:process.env.MILVUS_ADDRESS,token:process.env.MILVUS_TOKEN||undefined,timeout:8000});
    try{const health=await client.checkHealth();return result(health.isHealthy?'success':'error',health.isHealthy?(config.embeddingModel?'Milvus 健康；向量生成仍需样本验证':'Milvus 健康，尚需配置 Embedding 模型'):'Milvus 未通过健康检查',start);}finally{client.closeConnection();}
  }));
  return Promise.all(checks);
}
module.exports={publicSettings,updateSetting,modelCandidate,normalizeModelUrl,probeModel,probeDing,dingCandidate,dingConfig,archiveCandidate,archiveConfig,saveModelCheck,serviceDiagnostics,fingerprint,encrypt};
