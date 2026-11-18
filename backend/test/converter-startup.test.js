const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ensureConverter } = require('../../scripts/converter-startup');
const env = { CONVERTER_URL: 'http://127.0.0.1:8091', CONVERTER_TOKEN: 'fixture-converter-token-at-least-32' };
const ready = async () => ({ ok: true, json: async () => ({ ok: true }) });
const offline = async () => { throw Error('offline'); };

test('startup reuses a healthy converter without spawning or owning it', async () => {
  assert.equal(await ensureConverter('.', env, { fetch: ready, spawn: () => assert.fail('must reuse') }), null);
});
test('startup refuses an unhealthy engine or unreachable remote service', async () => {
  await assert.rejects(ensureConverter('.', env, { fetch: async () => ({ ok: true, json: async () => ({ ok: false }) }), spawn: () => assert.fail('port already owned') }), /LibreOffice/);
  await assert.rejects(ensureConverter('.', { ...env, CONVERTER_URL: 'https://converter.example' }, { fetch: offline, spawn: () => assert.fail('remote') }), /不可达/);
});
test('startup resolves only once converter is healthy', async () => {
  let attempts = 0, settled = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const child = new EventEmitter();
  const result = ensureConverter('.', env, { fetch: async () => { if (++attempts < 3) throw Error('starting'); return ready(); }, spawn: () => child, sleep: () => gate }).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); release(); assert.equal(await result, child);
});
test('startup timeout cleans up only its own child', async () => {
  let time = 0, stopped;
  const child = new EventEmitter();
  await assert.rejects(ensureConverter('.', env, { fetch: offline, spawn: () => child, sleep: async () => { time += 250; }, now: () => time, timeoutMs: 500, stop: value => { stopped = value; } }), /超时/);
  assert.equal(stopped, child);
});
