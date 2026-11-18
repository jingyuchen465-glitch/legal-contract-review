// Read the saved provider without changing it; isolate every business write.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createDb } = require('../../backend/pilot/db');
(async () => {
  const source = createDb();
  let provider;
  try { provider = await require('../../backend/pilot/model').providerConfig(source); }
  finally { await source.destroy(); }
  if (!provider.key || !provider.baseUrl || !provider.name) throw Error('MODEL_NOT_CONFIGURED');
  const child = spawn(process.execPath, [path.resolve('scripts/test-agent.mjs'), path.resolve('scripts/qa/revision-lawyer-acceptance.cjs')], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, QA_LAWYER_PROVIDER: JSON.stringify(provider) },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
