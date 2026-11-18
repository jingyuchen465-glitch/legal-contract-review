const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { requestTimeouts, sseProgress, modelDeadline, timeoutMessage } = require('../pilot/agent/model-deadline');

const frame = delta => Buffer.from('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
test('SSE progress ignores heartbeat, empty role, usage and malformed events', () => {
  const observe = sseProgress();
  for (const value of [': ping\n\n', 'data: {"usage":{"output_tokens":1}}\n\n', 'data: not-json\n\n', 'data: [DONE]\n\n']) assert.equal(observe(Buffer.from(value)), false);
  assert.equal(observe(frame({ role: 'assistant', content: '' })), false);
  assert.equal(observe(frame({ content: ' \n\t' })), false);
  for (const delta of [{ content: '报告' }, { reasoning_content: '核查' }, { reasoning: '核查' }, { tool_calls: [{ function: { arguments: '{"report":' } }] }, { function_call: { name: 'submit_review' } }]) assert.equal(observe(frame(delta)), true);
});

test('SSE progress handles split UTF-8, split frames, CRLF and multiple events', () => {
  const observe = sseProgress(), bytes = Buffer.from('data: {"choices":[{"delta":{"content":"合同"}}]}\r\n\r\n');
  for (let index = 0; index < bytes.length - 1; index++) assert.equal(observe(bytes.subarray(index, index + 1)), false);
  assert.equal(observe(bytes.subarray(-1)), true);
  assert.equal(observe(Buffer.concat([frame({ content: '新内容' }), Buffer.from(': ping\n\n')])), true);
});

test('SSE progress bounds incomplete data and resumes parsing later events', () => {
  const observe = sseProgress();
  assert.equal(observe(Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 1))), false);
  assert.equal(observe(Buffer.from('\n\n')), false);
  assert.equal(observe(frame({ content: '有效内容' })), true);
});

test('timeout configuration validates finite positive limits and retains a longer existing first wait', () => {
  assert.deepEqual(requestTimeouts({}), { timeoutPolicy: 'stream_progress', firstResponseTimeoutMs: 300000, idleTimeoutMs: 120000, maxDurationMs: 900000 });
  assert.equal(requestTimeouts({ reviewTimeout: 1800000 }).maxDurationMs, 1800000);
  for (const value of [0, -1, Infinity, NaN, 0.5, 2147483648, 'invalid']) assert.deepEqual(requestTimeouts({ reviewTimeout: value, reviewIdleTimeout: value, reviewMaxDuration: value }), requestTimeouts({}));
  assert.equal(requestTimeouts({ reviewMaxDuration: 200 }).maxDurationMs, 200);
});

test('deadline classifies waiting for first generated content', async t => {
  const controller = new AbortController(), policy = requestTimeouts({ reviewTimeout: 30, reviewIdleTimeout: 200, reviewMaxDuration: 1000 });
  const deadline = modelDeadline(controller, policy); t.after(() => deadline.close());
  await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(deadline.interruption, 'first_response_timeout');
  assert.equal(deadline.diagnostics().timeoutMs, 30);
  assert.match(timeoutMessage(deadline.diagnostics()), /未返回实际生成内容/);
});

test('deadline classifies stalled content separately from the original first wait', async t => {
  const controller = new AbortController(), deadline = modelDeadline(controller, requestTimeouts({ reviewTimeout: 1000, reviewIdleTimeout: 30, reviewMaxDuration: 1000 }));
  t.after(() => deadline.close()); deadline.progress();
  await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(deadline.interruption, 'stream_idle_timeout');
  assert.equal(deadline.diagnostics().timeoutMs, 30);
  assert.ok(deadline.diagnostics().idleElapsedMs >= 25);
  assert.match(timeoutMessage(deadline.diagnostics()), /没有新内容/);
});

test('continued progress extends the initial wait but cannot exceed the total limit', async t => {
  const controller = new AbortController(), deadline = modelDeadline(controller, requestTimeouts({ reviewTimeout: 30, reviewIdleTimeout: 1000, reviewMaxDuration: 120 }));
  t.after(() => deadline.close()); deadline.progress();
  const interval = setInterval(() => deadline.progress(), 10); t.after(() => clearInterval(interval));
  await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(deadline.interruption, 'request_deadline');
  assert.equal(deadline.diagnostics().timeoutMs, 120);
  assert.match(timeoutMessage(deadline.diagnostics()), /总时长上限/);
});

test('completion cleans up timers; external cancellation is not classified as a timeout', async () => {
  const controller = new AbortController(), deadline = modelDeadline(controller, requestTimeouts({ reviewTimeout: 20, reviewIdleTimeout: 20, reviewMaxDuration: 40 }));
  deadline.progress(); deadline.close();
  await delay(60); assert.equal(controller.signal.aborted, false);
  controller.abort(); assert.equal(deadline.interruption, undefined);
});
