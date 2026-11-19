const test = require('node:test');
const assert = require('node:assert/strict');
const vendorSkills = require('../pilot/agent/vendor-skills');
const { profile } = require('../pilot/agent/runtime');

test('full-dsh vendor manifest exposes enabled skills and excludes direct ZHIHE clients', async () => {
  const skills = await vendorSkills.snapshot();
  assert.equal(skills.length, 58);
  assert.ok(skills.every(skill => skill.name.startsWith('vendor-')));
  assert.ok(skills.every(skill => !skill.runtimeScripts.some(script => /zhihe|ZHIHE|ZHIEXA/.test(script))));
  assert.ok(skills.some(skill => skill.runtimeScripts.length > 0));
});

test('full-dsh profile keeps native terminal, filesystem and working-directory services', () => {
  const patch = profile('/tmp/legal-runtime', 'http://127.0.0.1:1/model', { name: 'test-model' }, {
    maxDurationMs: 1000, contextWindow: 8192, maxOutputTokens: 1024,
    reasoning: false, thinkingFormat: 'openai', runtimeProfile: 'full-dsh',
  });
  const disabled = new Set(patch.filter(item => item.id && item.disabled).map(item => item.id));
  for (const id of ['persistent-bash', 'terminal-bash', 'tool-fs', 'tool-working-directory']) assert.equal(disabled.has(id), false, id);
});
