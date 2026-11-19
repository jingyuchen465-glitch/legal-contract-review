const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const entrySource = `
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.env.RUNNER_RUNTIME_ROOT || '/opt/legal-harness';
const manifest = JSON.parse(await fs.readFile(root + '/legal-runtime.json', 'utf8'));
const { DeepSeekHarness } = await import(pathToFileURL(root + '/' + manifest.sdk).href);
const options = {
  profile: 'sdk-minimal',
  patches: [process.env.RUNNER_PATCH || '/task/legal.cordis.patch.yml'],
  dshHome: process.env.RUNNER_DSH_HOME || '/task/.dsh',
  cwd: process.env.RUNNER_WORKSPACE || '/task/workspace',
  processCwd: process.env.RUNNER_WORKSPACE || '/task/workspace',
  env: process.env,
  provider: 'legal-gateway',
  model: process.env.RUNNER_MODEL,
  maxTokens: Number(process.env.RUNNER_MAX_TOKENS || 12000),
  initializeTimeoutMs: 60000,
  shutdownTimeoutMs: 1000,
  disposeEofGraceMs: 2000,
  disposeGraceMs: 2000,
};
const harness = new DeepSeekHarness(options);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input || '{}');
const sessionId = request.sessionId || 'legal-runner-' + Date.now();
try {
  const session = request.resume ? await harness.resumeSession(sessionId) : harness.session(sessionId);
  process.stdout.write(JSON.stringify({ type: 'session', id: session.id }) + '\\n');
  const result = await session.run(request.prompt, {
    onNotification: notification => process.stdout.write(JSON.stringify({ type: 'notification', notification }) + '\\n'),
  });
  process.stdout.write(JSON.stringify({ type: 'result', result }) + '\\n');
  await harness.close();
} catch (error) {
  process.stdout.write(JSON.stringify({ type: 'error', error: { message: error?.message || String(error), code: error?.code } }) + '\\n');
  await harness.close().catch(() => {});
  process.exitCode = 1;
}
`;

async function ensureEntry(runtimeRoot) {
  const pathName = path.join(runtimeRoot, 'agent-container-entry.mjs');
  const current = await fs.readFile(pathName, 'utf8').catch(() => null);
  if (current !== entrySource) await fs.writeFile(pathName, entrySource, { mode: 0o644 });
  return pathName;
}

function runContainer({ image, runtimeRoot, taskRoot, patchPath, bridge, token, model, maxTokens, sessionId, resume, prompt, onNotification, onProcess }) {
  return new Promise(async (resolve, reject) => {
    const entry = await ensureEntry(runtimeRoot);
    const name = `legal-agent-${randomUUID()}`;
    const args = [
      'run', '--rm', '--init', '--name', name, '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway',
      '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
      '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '-e', `LEGAL_BRIDGE_URL=${bridge}`, '-e', `LEGAL_BRIDGE_TOKEN=${token}`,
      '-e', `LEGAL_COMPACTION_PROMPT=${process.env.LEGAL_COMPACTION_PROMPT || ''}`,
      '-e', `DSH_SYSTEM_PROMPT=${process.env.DSH_SYSTEM_PROMPT || ''}`,
      '-e', 'RUNNER_RUNTIME_ROOT=/opt/legal-harness', '-e', 'RUNNER_DSH_HOME=/task/.dsh', '-e', 'RUNNER_WORKSPACE=/task/workspace',
      '-e', `RUNNER_PATCH=/task/${path.basename(patchPath)}`, '-e', `RUNNER_MODEL=${model}`,
      '-e', `RUNNER_MAX_TOKENS=${maxTokens}`, '-v', `${runtimeRoot}:/opt/legal-harness:ro`,
      '-v', `${taskRoot}:/task:rw`, '-v', `${entry}:/runner/entry.mjs:ro`, image, 'node', '/runner/entry.mjs',
    ];
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '', DOCKER_CONFIG: process.env.DOCKER_CONFIG || '', HOME: '/tmp', LANG: process.env.LANG || 'C.UTF-8' } });
    onProcess?.({ child, name });
    let stdout = '', stderr = '', settled = false, session;
    const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      let index;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index).trim(); stdout = stdout.slice(index + 1); if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'session') session = message.id;
        else if (message.type === 'notification') onNotification?.(message.notification);
        else if (message.type === 'result') finish(resolve, { ...message.result, sessionId: session });
        else if (message.type === 'error') finish(reject, Object.assign(new Error(message.error.message), message.error));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => finish(reject, error));
    child.on('close', code => { setImmediate(() => { if (!settled) finish(reject, new Error(`full-dsh 容器退出（${code}）：${stderr || '无诊断信息'}`)); }); });
    child.stdin.end(JSON.stringify({ sessionId, resume: Boolean(resume), prompt }));
  });
}

function createContainerRunner(options) {
  let closed = false;
  let active = null, activeControl = null;
  return {
    async run(input, onNotification) {
      if (closed) throw new Error('full-dsh 容器运行器已关闭');
      active = runContainer({ ...input, image: options.runnerImage, runtimeRoot: options.runtimeRoot, taskRoot: options.taskRoot, patchPath: options.patchPath, bridge: options.bridge, token: options.token, model: options.model, maxTokens: options.maxTokens, onNotification, onProcess: control => { activeControl = control; } });
      try { return await active; } finally { active = null; activeControl = null; }
    },
    async close() {
      closed = true;
      const control = activeControl;
      if (!control) { active = null; return; }
      control.child.kill('SIGTERM');
      await new Promise(resolve => {
        const cleanup = spawn('docker', ['rm', '-f', control.name], { stdio: 'ignore', env: { PATH: process.env.PATH || '', DOCKER_CONFIG: process.env.DOCKER_CONFIG || '', HOME: '/tmp' } });
        cleanup.once('close', resolve); cleanup.once('error', resolve);
      });
      active = null; activeControl = null;
    },
  };
}

module.exports = { createContainerRunner, ensureEntry, entrySource };
