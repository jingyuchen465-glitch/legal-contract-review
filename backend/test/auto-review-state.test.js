const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertRuntimeResult } = require('../pilot/agent/runtime-result');

test('new comment output and historical revisions have distinct completion labels', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = {status:'completed',main_review_id:'r',review:{status:'completed'},artifacts:[{review_id:'r',kind:'annotated_comments',downloadUrl:'/comments'}]};
  let state=batchState(b);
  assert.match(state.title,/批注建议稿/); assert.match(state.description,/原文由法务调整/); assert.equal(state.downloadable,1);
  b.artifacts[0].kind='tracked_revisions'; state=batchState(b);
  assert.match(state.title,/历史修订稿/); assert.doesNotMatch(state.description,/批注建议稿/);
});

test('resolved SDK error outcomes preserve timeout and transport causes instead of becoming missing information', () => {
  assert.throws(() => assertRuntimeResult({ finishReason: 'error' }, { code: 'AGENT_MODEL_TIMEOUT', message: '响应超过300秒' }), { code: 'AGENT_MODEL_TIMEOUT', message: '响应超过300秒' });
  assert.throws(() => assertRuntimeResult({ finishReason: 'error', events: [{ type: 'turn/end', data: { reason: { error: { code: 'TRANSPORT', message: 'private diagnostic' } } } }] }), e => e.code === 'AGENT_MODEL_CONNECTION' && !e.message.includes('private diagnostic'));
  assert.throws(() => assertRuntimeResult({ finishReason: 'aborted' }), { code: 'HARNESS_RUNTIME_FAILED' });
  assert.doesNotThrow(() => assertRuntimeResult({ finishReason: 'completed' }, { code: 'AGENT_MODEL_TIMEOUT', message: 'a recovered attempt' }));
});

test('paused batch distinguishes a real question from an interruption and never implies zero risks', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'needs_attention', main_review_id: 'review', executionPlan: { reviewId: 'review', steps: [{}] }, review: { status: 'waiting_input', errorCode: 'AGENT_INCOMPLETE', questions: [], coverage: { readBlocks: 77, totalBlocks: 77, complete: false } }, artifacts: [] };
  let state = batchState(b);
  assert.equal(state.title, '审查已暂停'); assert.equal(state.question, null); assert.equal(state.action, '继续生成报告'); assert.equal(state.reportReady, false);
  assert.equal(state.phases[0].done, true); assert.equal(state.phases[2].done, false); assert.equal(state.phases[2].current, true); assert.equal(state.phases[4].done, false);
  b.review.questions = [{ id: 'q', content: '请确认收款主体。' }];
  state = batchState(b); assert.equal(state.title, '需要你确认信息'); assert.equal(state.question.content, '请确认收款主体。');
  b.status = 'queued'; assert.equal(batchState(b).question, null);
  assert.equal(batchState(null).running, false);
});

test('partial results remain downloadable while a resumed review requires its own plan', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'partial', main_review_id: 'new', executionPlan: { reviewId: 'old', steps: [{}] }, qualityGate: { observedReviewId: 'new' }, review: { status: 'completed', candidateSaved: true }, artifacts: [{ review_id: 'old', downloadUrl: '/old' }, { review_id: 'new', downloadUrl: '/new' }] };
  const state = batchState(b); assert.equal(state.downloadable, 1); assert.equal(state.reportReady, true); assert.equal(state.question, null); assert.equal(state.phases[1].done, false); assert.equal(state.phases[3].done, true);
});

test('pause explanation shows confirmed interruption, stage, attempts and saved work without inventing a provider cause', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'needs_attention', main_review_id: 'review', executionPlan: { reviewId: 'review', steps: [{}] },
    review: { status: 'waiting_input', errorCode: 'AGENT_MODEL_TIMEOUT', questions: [], coverage: { readBlocks: 77, totalBlocks: 77 } },
    activity: [
      { type: 'tool', data: { name: 'create_review_plan', ok: true } },
      ...[8, 9].map(number => ({ type: 'model_failed', created_at: '2026-11-11T06:00:00Z', data: { code: 'AGENT_MODEL_TIMEOUT', number, elapsedMs: 300107, timeoutMs: 300000, receivedBytes: 800, interruption: 'request_deadline' } })),
    ] };
  const details = batchState(b).pauseDetails;
  assert.equal(details.reason, '模型响应超时');
  assert.equal(details.stage, '审查条款与整理报告');
  assert.equal(details.lastOperation, '制定审查计划');
  assert.match(details.savedWork, /77 \/ 77/);
  assert.equal(details.attempts.length, 2);
  assert.equal(details.attempts[0].duration, '300.1 秒');
  assert.match(details.trigger, /系统.*300 秒.*中止/);
  assert.match(details.unknown, /尚未确认/);
  assert.ok(!JSON.stringify(details).includes('800'));
  b.review.questions = [{ id: 'q', content: '需要确认付款事实' }];
  assert.equal(batchState(b).pauseDetails, null);
  b.review.questions = []; b.status = 'queued';
  assert.equal(batchState(b).pauseDetails, null);
});

test('historical timeout evidence is displayed without guessing missing timing or leaking earlier reviews', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'needs_attention', main_review_id: 'current', review: { status: 'waiting_input', errorCode: 'AGENT_MODEL_TIMEOUT',
    timeoutDiagnosis: { attempts: [{ started: 1794375284760, ended: 1794375584867, duration: 300107 }, { started: 1794375585354, ended: 1794375885461, duration: 300107 }] } } };
  let details = batchState(b).pauseDetails;
  assert.equal(details.attempts.length, 2); assert.equal(details.attempts[1].duration, '300.1 秒');
  assert.match(details.attempts[0].source, /历史诊断/);
  assert.ok(!details.trigger.includes('系统主动'));
  delete b.review.timeoutDiagnosis;
  details = batchState(b).pauseDetails;
  assert.equal(details.attempts.length, 0); assert.match(details.recordNote, /未保存.*耗时/);
  b.review.errorCode = 'AGENT_NO_PROGRESS';
  assert.match(batchState(b).pauseDetails.reason, /重复操作/);
  b.review.errorCode = 'AGENT_MODEL_HTTP';
  b.activity = [{ review_id: 'old', type: 'model_failed', data: { code: 'AGENT_MODEL_HTTP', httpStatus: 401 } }, { review_id: 'current', type: 'model_failed', data: { code: 'AGENT_MODEL_HTTP', httpStatus: 429, elapsedMs: 2000 } }];
  details = batchState(b).pauseDetails;
  assert.match(details.trigger, /429/); assert.ok(!JSON.stringify(details).includes('401'));
  b.review.errorCode = 'AGENT_MODEL_TIMEOUT';
  b.activity = [{ type: 'model_request', created_at: '2026-11-11T08:39:31.369Z', data: { number: 2 } }, { type: 'model_failed', created_at: '2026-11-11T08:44:31.375Z', data: { number: 2, code: 'AGENT_MODEL_TIMEOUT' } }];
  details = batchState(b).pauseDetails;
  assert.equal(details.attempts[0].duration, '约 300 秒'); assert.match(details.attempts[0].source, /运行事件计时/);
});

test('resuming retains verified reading progress, labels the previous plan and pauses at the first unfinished step', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'needs_attention', main_review_id: 'next', executionPlan: { reviewId: 'prior', steps: [{}, {}, {}, {}, {}] },
    review: { status: 'waiting_input', errorCode: 'AGENT_MODEL_TIMEOUT', coverage: {}, savedCoverage: { sourceReviewId: 'prior', totalBlocks: 77, readBlocks: 77 } } };
  const state = batchState(b);
  assert.equal(state.read, 77); assert.equal(state.total, 77);
  assert.equal(state.phases[0].done, true); assert.equal(state.phases[0].current, false);
  assert.equal(state.phases[1].done, false); assert.equal(state.phases[1].current, true);
  assert.match(state.phases[1].detail, /上轮.*5.*本轮待更新/);
  assert.equal(state.phases[1].status, '已暂停'); assert.equal(state.phases[2].current, false);
  assert.equal(state.phases[2].status, '待进行');
  assert.equal(state.pauseDetails.stage, '制定计划'); assert.match(state.pauseDetails.savedWork, /77 \/ 77/);
  b.status = 'queued'; const queued = batchState(b);
  assert.equal(queued.phases[0].done, true); assert.equal(queued.phases[1].status, '等待继续');
});

test('pause location follows evidence instead of always highlighting clause review', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'needs_attention', main_review_id: 'run', review: { status: 'waiting_input', errorCode: 'AGENT_MODEL_TIMEOUT' } };
  let state = batchState(b);
  assert.equal(state.phases[0].current, true); assert.equal(state.phases[2].current, false);
  b.review.coverage = { readBlocks: 2, totalBlocks: 2 }; b.executionPlan = { reviewId: 'run', steps: [{}] };
  state = batchState(b); assert.equal(state.phases[2].current, true); assert.equal(state.phases[0].done, true);
  b.review.candidateSaved = true;
  state = batchState(b); assert.equal(state.phases[3].current, true); assert.equal(state.phases[2].done, true);
  b.review.status = 'completed';
  state = batchState(b); assert.equal(state.phases[4].current, true); assert.equal(state.phases.filter(p => p.current).length, 1);
  b.status = 'cancelled'; assert.equal(batchState(b).phases[4].status, '已停止');
});

test('active continuation leaves queued display and times only the pending request from this review', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'queued', main_review_id: 'next', executionPlan: { reviewId: 'prior', steps: [{}] },
    review: { status: 'queued', savedCoverage: { readBlocks: 77, totalBlocks: 77 } }, activity: [
      { review_id: 'prior', type: 'model_request', created_at: '2026-11-11T09:00:00Z', data: { number: 9 } },
    ] };
  const now = Date.parse('2026-11-11T09:12:00Z');
  let state = batchState(b, now);
  assert.equal(state.title, '排队中'); assert.equal(state.modelWait, null);
  b.review.status = 'running';
  state = batchState(b, now);
  assert.equal(state.title, '制定计划'); assert.equal(state.label, '制定计划'); assert.equal(state.phases[1].status, '进行中');
  b.activity.push({ review_id: 'next', type: 'model_request', created_at: '2026-11-11T09:11:00Z', data: { number: 1, timeoutMs: 300000 } });
  state = batchState(b, now);
  assert.equal(state.title, '等待模型响应'); assert.equal(state.modelWait.elapsed, 60); assert.equal(state.modelWait.timeout, 300);
  assert.equal(state.modelWait.retrying, false); assert.equal(state.phases[1].status, '等待模型');
  assert.equal(batchState(b, now + 1000).modelWait.elapsed, 61);
  b.activity.push({ type: 'model_failed', data: { code: 'AGENT_MODEL_TIMEOUT' } });
  assert.equal(batchState(b, now).modelWait, null);
  b.activity.push({ type: 'model_request', created_at: '2026-11-11T09:11:55Z', data: { number: 2, timeoutMs: 300000 } });
  state = batchState(b, now);
  assert.equal(state.title, '正在重试模型请求'); assert.equal(state.modelWait.elapsed, 5); assert.match(state.description, /上一次模型请求超时/);
  b.activity.push({ type: 'tool', data: { name: 'submit_review', ok: false } });
  state = batchState(b, now); assert.equal(state.modelWait, null); assert.match(state.description, /未通过校验/);
  b.executionPlan.reviewId = 'next'; b.activity.push({ type: 'tool', data: { name: 'create_review_plan', ok: true } });
  state = batchState(b, now); assert.equal(state.title, '审查中'); assert.equal(state.phases[2].status, '进行中');
  b.status = 'needs_attention'; b.review.status = 'waiting_input';
  assert.equal(batchState(b, now).modelWait, null); assert.equal(batchState(b, now).title, '审查已暂停');
  b.status = 'cancelled'; assert.equal(batchState(b, now).modelWait, null);
});

test('progress display distinguishes streaming from waiting and stops waiting after a complete response', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'executing', main_review_id: 'run', review: { status: 'running' }, activity: [
    { type: 'model_failed', data: { code: 'AGENT_MODEL_TIMEOUT' } },
    { type: 'system_skills_injected', data: {} },
    { type: 'model_request', created_at: '2026-11-11T11:00:00Z', data: { number: 2, timeoutPolicy: 'stream_progress', timeoutMs: 900000, firstResponseTimeoutMs: 300000, idleTimeoutMs: 120000 } },
  ] };
  let state = batchState(b, Date.parse('2026-11-11T11:06:00Z'));
  assert.equal(state.title, '正在重试模型请求'); assert.equal(state.modelWait.timeout, 900); assert.equal(state.modelWait.idleTimeout, 120);
  b.activity.push({ type: 'model_progress', data: { number: 2 } });
  state = batchState(b, Date.parse('2026-11-11T11:06:00Z'));
  assert.equal(state.title, '正在生成审查内容'); assert.equal(state.modelWait.streaming, true); assert.equal(state.modelWait.elapsed, 360);
  assert.equal(state.phases.find(p => p.current).status, '正在生成');
  assert.match(state.description, /持续输出.*继续生成/);
  b.activity.push({ type: 'model_response', data: { number: 2 } });
  assert.equal(batchState(b).modelWait, null);
});

test('pause details distinguish first-content wait, output stall and maximum generation duration', async () => {
  const { batchState } = await import('../../frontend/src/pilot/auto-review-state.mjs');
  const b = { status: 'needs_attention', main_review_id: 'run', review: { status: 'waiting_input', errorCode: 'AGENT_MODEL_TIMEOUT' }, activity: [] };
  for (const [interruption, timeoutMs, pattern] of [['first_response_timeout', 300000, /未收到实际生成内容/], ['stream_idle_timeout', 120000, /曾返回内容.*连续 120 秒没有新内容/], ['request_deadline', 900000, /900 秒.*总时长上限/]]) {
    b.activity = [{ type: 'model_failed', data: { code: 'AGENT_MODEL_TIMEOUT', elapsedMs: 400000, timeoutPolicy: 'stream_progress', interruption, timeoutMs } }];
    const details = batchState(b).pauseDetails;
    assert.match(details.trigger, pattern); assert.equal(details.attempts.length, 1);
    assert.ok(!details.trigger.includes('模型服务异常'));
  }
});
