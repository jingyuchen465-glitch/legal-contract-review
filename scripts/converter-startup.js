const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function stopChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill('SIGTERM');
}

async function ensureConverter(root, env = process.env, options = {}) {
  if (!env.CONVERTER_URL) return null;
  const request = options.fetch || fetch, start = options.spawn || spawn;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || Date.now, stop = options.stop || stopChild;
  const url = env.CONVERTER_URL.replace(/\/$/, '');
  const healthy = async () => {
    let response;
    try { response = await request(`${url}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); }
    catch { return false; }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) throw Error('转换服务已响应，但引擎未就绪，请检查 LibreOffice 安装与 SOFFICE_PATH。');
    return true;
  };
  if (await healthy()) return null;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):8091$/.test(url)) throw Error('配置的转换服务不可达，请先恢复服务后再启动。');
  if (!env.CONVERTER_TOKEN || env.CONVERTER_TOKEN.length < 32) throw Error('请先配置至少 32 位的 CONVERTER_TOKEN。');
  const localPython = path.join(root, '.local', 'converter-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = env.CONVERTER_PYTHON || (fs.existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
  const child = start(python, ['-m', 'uvicorn', 'app:app', '--app-dir', 'converter', '--host', '127.0.0.1', '--port', '8091', '--no-access-log'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  let failed = false;
  child.on('error', () => { failed = true; });
  child.on('exit', () => { failed = true; });
  try {
    const deadline = now() + (options.timeoutMs ?? 30000);
    while (now() < deadline) {
      if (failed) throw Error('转换服务启动失败，请检查 Python 转换依赖。');
      if (await healthy()) {
        if (failed) throw Error('转换服务在启动时退出。');
        return child;
      }
      await sleep(250);
    }
    throw Error('转换服务启动超时，后台任务尚未启动，请检查转换服务日志。');
  } catch (error) { stop(child); throw error; }
}

module.exports = { ensureConverter, stopChild };
