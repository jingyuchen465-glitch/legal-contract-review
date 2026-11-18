const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, timingSafeEqual, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { ENGINE, UPSTREAM_COMMIT, settings } = require('./config');
const { providerConfig } = require('../model');
const { assertActive } = require('./service');
const { AppError, fail } = require('../errors');
const { toolDefinitions } = require('./tools');
const { SYSTEM, COMPACTION } = require('./prompt');
const { hash } = require('./official-sources');
const { assertRuntimeResult } = require('./runtime-result');
const { requestTimeouts, sseProgress, modelDeadline, timeoutMessage } = require('./model-deadline');
const systemSkills = require('./system-skills');
const activeClosers = new Set();
function profile(root, baseURL, model, options) {
  const disabled = ['persistent-bash', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'tool-fs', 'tool-working-directory', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'llm-deepseek', 'deepseek-llm-api-extensions', 'image-offload', 'compaction-basic'];
  const extension = path.join(root, 'apps/cli/legal-extension');
  // Let the bridge classify its own deadlines before the SDK's fallback guard.
  const streamIdleTimeoutMs = Math.min(2147483647, requestTimeouts(model).maxDurationMs + 60000);
  return [
    ...disabled.map(id => ({ id, disabled: true })),
    { id: 'system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: SYSTEM } },
    { insert: [
      { id: 'legal-llm', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'legal-gateway': { api: 'openai-completions', apiKeyEnv: 'LEGAL_BRIDGE_TOKEN', baseURL, reasoning: options.reasoning ? 'high' : 'off', streamIdleTimeoutMs, compat: { thinkingFormat: options.thinkingFormat }, retryPolicy: { mode: 'normal', maxRetries: 1 }, models: [{ id: model.name, name: model.name, contextWindow: options.contextWindow, maxTokens: options.maxOutputTokens, reasoningEfforts: options.reasoning ? { off: null, high: 'high' } : false }] } } } },
      { id: 'legal-skills', name: '@deepseek-ai/dsh-skill' },
      { id: 'legal-tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'legal-compaction', name: pathToFileURL(path.join(extension, 'compaction.mjs')).href, config: { thresholdRatio: 0.75, headroomTokens: 4096, retainRatio: 0.35, maxTokens: 6000 } },
      { id: 'legal-tools', name: pathToFileURL(path.join(extension, 'plugin.mjs')).href },
    ] },
  ];
}
async function requestBody(req) {
  let size = 0; const chunks = [];
  for await (const part of req) { size += part.length; if (size > 4 * 1024 * 1024) fail(413, 'AGENT_BRIDGE_SIZE', '工具请求过大'); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail(400, 'AGENT_BRIDGE_JSON', '请求格式无效'); }
}
function childEnv(values) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...values, NO_COLOR: '1', NODE_ENV: 'production' };
}
async function createRuntime({ db, run, context, notify }) {
  const definitions = context.toolDefinitions || toolDefinitions;
  const options = { ...await settings(db), ...run.snapshot.agentOptions }, model = await providerConfig(db);
  const manifestPath = path.join(options.runtimeRoot, 'legal-runtime.json');
  let runtimeManifest;
  try { runtimeManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { fail(503, 'HARNESS_NOT_BUILT', '固定版本 Harness 运行时尚未构建，请运行 npm run harness:build'); }
  if (runtimeManifest.commit !== UPSTREAM_COMMIT) fail(503, 'HARNESS_VERSION_MISMATCH', 'Harness 运行时与固定源码版本不一致');
  const sdkPath = path.join(options.runtimeRoot, runtimeManifest.sdk);
  const { DeepSeekHarness } = await import(pathToFileURL(sdkPath).href);
  const token = randomBytes(32).toString('hex'), home = path.join(options.homeRoot, run.agent_session_id);
  await fs.mkdir(home, { recursive: true });
  const patchPath = path.join(home, 'legal.cordis.patch.yml');
  const counts = await db('la_agent_events').where({ review_id: run.id, type: 'model_request' }).count('* as n').first();
  let requests = Number(counts.n), closed = false, stopReason, harness, ready = false, repeated = 0, lastAction, lastModelFailure;
  let notificationTail = Promise.resolve();
  const upstreamControllers = new Set();
  const error = (code, message) => new AppError(409, code, message);
  const json = (res, code, value) => { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const received = Buffer.from(String(req.headers.authorization || ''));
      const expected = Buffer.from('Bearer ' + token);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return json(res, 403, { message: '工具调用凭据无效' });
      await assertActive(db, run.id);
      if (stopReason) throw stopReason;
      if (req.method === 'GET' && req.url === '/context') return json(res, 200, { tools: definitions, skills: context.skills.map(({ method, resources, ...s }) => s), manifest: context.manifest });
      if (req.method === 'GET' && req.url === '/active') return json(res, 200, { active: true });
      const body = await requestBody(req);
      if (req.method === 'POST' && req.url === '/ready') {
        const allowed = [...definitions.map(t => t.name), 'skill'];
        if (!Array.isArray(body.tools) || body.tools.length !== allowed.length || new Set(body.tools).size !== allowed.length || allowed.some(t => !body.tools.includes(t))) fail(503, 'HARNESS_TOOLSET_MISMATCH', '法务工具注册清单不一致');
        ready = true; await notify('tools_ready', { tools: body.tools }); return json(res, 200, { ready: true });
      }
      if (req.method === 'POST' && req.url === '/skill-loaded') { await context.recordSkillLoaded(body.name, body.versionId); return json(res, 200, { recorded: true }); }
      if (req.method === 'POST' && req.url === '/tools') {
        const result = await context.execute(body.name, body.args, body.callId);
        const action = hash(JSON.stringify([body.name, body.args, result]));
        repeated = action === lastAction ? repeated + 1 : 1; lastAction = action;
        if (repeated >= 3) stopReason = error('AGENT_NO_PROGRESS', '连续三轮重复操作且没有新结果，已保存工作，可调整目标后继续。');
        return json(res, 200, result);
      }
      if (req.method === 'POST' && req.url === '/model/chat/completions') {
        if (!ready) fail(503, 'HARNESS_TOOLS_NOT_READY', '法务工具尚未完成注册');
        if (requests >= options.maxRequests) { stopReason = error('AGENT_BUDGET', '已达到本轮模型请求上限，工作已保存，可继续审查。'); throw stopReason; }
        if (body.model !== model.name) fail(409, 'MODEL_SNAPSHOT_CHANGED', '运行时请求了非固定模型');
        await systemSkills.assertLoaded(db, run);
        const modelBody = systemSkills.inject(body, context.requiredSkills);
        requests++;
        if (context.requiredSkills.length) await notify('system_skills_injected', { requestNumber: requests, message: '本次分析已携带必读系统技能及范例', skills: context.requiredSkills.map(s => ({ name: s.name, versionId: s.versionId, resources: s.requiredResources })) });
        const timeouts = requestTimeouts(model);
        await notify('model_request', { number: requests, maxRequests: options.maxRequests, ...timeouts, timeoutMs: timeouts.maxDurationMs, message: '正在分析材料并确定下一步' });
        const controller = new AbortController(); upstreamControllers.add(controller);
        const requestNumber = requests;
        const deadline = modelDeadline(controller, timeouts), observeSse = sseProgress();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnected);
        let receivedBytes = 0, httpStatus, httpFailureRecorded = false, lastProgressNotice;
        const diagnostics = () => ({ number: requestNumber, ...deadline.diagnostics(), receivedBytes, ...(httpStatus ? { httpStatus } : {}) });
        try {
          const response = await fetch(model.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + model.key, 'Content-Type': 'application/json' }, body: JSON.stringify(modelBody), signal: controller.signal, redirect: 'error' });
          httpStatus = response.status;
          lastModelFailure = response.ok ? null : { code: 'AGENT_MODEL_HTTP', message: `模型服务返回 HTTP ${response.status}，本轮未完成。已保存审查记录，可重试。` };
          if (!response.ok) { await notify('model_failed', { ...lastModelFailure, ...diagnostics(), interruption: 'http_error' }); httpFailureRecorded = true; }
          res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
          const isSse = body.stream === true || /text\/event-stream/i.test(response.headers.get('content-type') || '');
          if (response.body) for await (const part of response.body) {
            receivedBytes += part.byteLength;
            if (closed || stopReason) break;
            if (response.ok && (isSse ? observeSse(part) : part.byteLength > 0)) {
              deadline.progress();
              if (lastProgressNotice === undefined || Date.now() - lastProgressNotice >= 10000) {
                lastProgressNotice = Date.now();
                await notify('model_progress', { ...diagnostics(), message: '模型正在持续生成审查内容' });
              }
            }
            if (!res.write(part)) await new Promise(resolve => {
              const finish = () => { res.off('drain', finish); res.off('close', finish); resolve(); };
              res.once('drain', finish); res.once('close', finish);
              if (res.destroyed) finish();
            });
          }
          deadline.close();
          if (response.ok && !closed && !stopReason) await notify('model_response', { ...diagnostics(), message: '本次模型响应已接收完成' });
          res.end();
        } catch (e) {
          if (!closed && !stopReason && !httpFailureRecorded) {
            lastModelFailure = deadline.interruption
              ? { code: 'AGENT_MODEL_TIMEOUT', message: timeoutMessage(deadline.diagnostics()) }
              : { code: 'AGENT_MODEL_CONNECTION', message: '模型连接中断，报告尚未生成。已保存审查记录，可直接继续。' };
            await notify('model_failed', { ...lastModelFailure, ...diagnostics(), interruption: deadline.interruption || 'connection' });
          }
          throw e;
        } finally { deadline.close(); res.off('close', disconnected); upstreamControllers.delete(controller); }
        return;
      }
      json(res, 404, { message: '内部工具接口不存在' });
    } catch (e) { if (res.headersSent) res.destroy(); else json(res, e.status || 500, { code: e.code || 'AGENT_BRIDGE_FAILED', message: e.code ? e.message : '法务工具暂时不可用' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const bridge = 'http://127.0.0.1:' + server.address().port;
  try {
  await fs.writeFile(patchPath, JSON.stringify(profile(options.runtimeRoot, bridge + '/model', model, options), null, 2));
  const env = childEnv({ LEGAL_BRIDGE_URL: bridge, LEGAL_BRIDGE_TOKEN: token, LEGAL_COMPACTION_PROMPT: COMPACTION, DSH_SYSTEM_PROMPT: SYSTEM });
  harness = new DeepSeekHarness({ profile: 'sdk-minimal', patches: [patchPath], dshHome: home, cwd: home, processCwd: home, env, provider: 'legal-gateway', model: model.name, maxTokens: options.maxOutputTokens, initializeTimeoutMs: 60000, shutdownTimeoutMs: 1000, disposeEofGraceMs: 2000, disposeGraceMs: 2000 });
  } catch (e) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw e; }
  let poll, timeout;
  async function close() {
    if (closed) return; closed = true; clearInterval(poll); clearTimeout(timeout);
    activeClosers.delete(close);
    for (const c of upstreamControllers) c.abort();
    await harness.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await notificationTail;
  }
  activeClosers.add(close);
  return {
    async run(input) {
      const current = await db('la_agent_sessions').where({ id: run.agent_session_id }).first();
      const handle = current.harness_id ? await harness.resumeSession(current.harness_id) : harness.session('legal-' + randomUUID());
      await db('la_agent_sessions').where({ id: current.id }).update({ harness_id: handle.id });
      let rejectStop;
      const interrupted = new Promise((_resolve, reject) => { rejectStop = reject; });
      timeout = setTimeout(() => { stopReason = error('AGENT_TIMEOUT', '本轮审查达到时间上限，工作已保存，可继续。'); rejectStop(stopReason); void close(); }, options.maxMinutes * 60000);
      let checking = false;
      poll = setInterval(async () => {
        if (checking || closed) return; checking = true;
        try { if (stopReason) throw stopReason; await assertActive(db, run.id); }
        catch (e) { stopReason ||= e; rejectStop(stopReason); void close(); } finally { checking = false; }
      }, 1000);
      const prompt = JSON.stringify({ task: input, manifest: context.manifest, instruction: '先使用材料目录与工具核查，按系统要求提交结果或提出必要问题。' });
      const result = await Promise.race([handle.run(prompt, { onNotification: n => {
        // Raw reasoning remains in the private Harness log; the UI receives business events only.
        if (n.method === 'session.event' && n.params?.event?.data?.usage) notificationTail = notificationTail.then(() => notify('usage', { usage: n.params.event.data.usage, type: n.params.event.type }));
      } }), interrupted]);
      if (stopReason) throw stopReason;
      if (!ready) fail(503, 'HARNESS_TOOLS_NOT_READY', '运行时没有注册法务工具');
      assertRuntimeResult(result, lastModelFailure);
      return { text: result.finalResponse, finishReason: result.finishReason };
    }, close,
  };
}
module.exports = { createRuntime, profile, childEnv, closeAll: () => Promise.allSettled([...activeClosers].map(close => close())) };
