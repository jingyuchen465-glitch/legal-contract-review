const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const children = [
  spawn(process.execPath, ['backend/index.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['backend/pilot/worker.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: path.join(root, 'frontend'), stdio: 'inherit' }),
];
// Vite's binary is in the root workspace node_modules.
children[2].on('error', stop);
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); }
for (const child of children) child.on('exit', code => { if (code) stop(); });
process.once('SIGINT', stop); process.once('SIGTERM', stop);
