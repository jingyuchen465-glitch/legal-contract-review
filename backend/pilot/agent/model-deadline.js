const { StringDecoder } = require('node:string_decoder');

const positiveMs = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647 ? Number(value) : fallback;
function requestTimeouts(model) {
  const firstResponseTimeoutMs = positiveMs(model.reviewTimeout, 300000);
  return {
    timeoutPolicy: 'stream_progress', firstResponseTimeoutMs,
    idleTimeoutMs: positiveMs(model.reviewIdleTimeout, 120000),
    maxDurationMs: positiveMs(model.reviewMaxDuration, Math.max(firstResponseTimeoutMs, 900000)),
  };
}

// Observe SSE without retaining report text. Heartbeats, role-only frames and
// usage frames do not extend the wait for actual generated content.
function sseProgress() {
  const decoder = new StringDecoder('utf8');
  let line = '', data = '', oversized = false;
  const limit = 1024 * 1024;
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  function dispatch() {
    const value = data; data = '';
    if (!value || value === '[DONE]') return false;
    try {
      const frame = JSON.parse(value);
      return frame.choices?.some(choice => {
        const delta = choice.delta || {};
        return [delta.content, delta.reasoning_content, delta.reasoning, delta.text, choice.text].some(nonempty)
          || delta.tool_calls?.some(call => [call.function?.arguments, call.function?.name].some(nonempty))
          || [delta.function_call?.arguments, delta.function_call?.name].some(nonempty);
      }) === true;
    } catch { return false; }
  }
  return part => {
    const text = decoder.write(part); let progress = false, offset = 0;
    while (offset < text.length) {
      const end = text.indexOf('\n', offset);
      const fragment = text.slice(offset, end < 0 ? text.length : end);
      if (!oversized) {
        if (line.length + fragment.length + data.length > limit) { oversized = true; line = ''; data = ''; }
        else line += fragment;
      }
      if (end < 0) break;
      offset = end + 1;
      const value = line.endsWith('\r') ? line.slice(0, -1) : line; line = '';
      if (!value) {
        if (!oversized) progress = dispatch() || progress;
        oversized = false; data = '';
      } else if (!oversized && value.startsWith('data:')) data += (data ? '\n' : '') + value.slice(5).replace(/^ /, '');
    }
    return progress;
  };
}

function modelDeadline(controller, policy) {
  const startedAt = Date.now(); let lastProgressAt, interruption, idle;
  const abort = reason => { if (!controller.signal.aborted) { interruption = reason; controller.abort(); } };
  const first = setTimeout(() => abort('first_response_timeout'), policy.firstResponseTimeoutMs);
  const total = setTimeout(() => abort('request_deadline'), policy.maxDurationMs);
  return {
    progress() {
      if (controller.signal.aborted) return;
      lastProgressAt = Date.now(); clearTimeout(first);
      if (idle) idle.refresh();
      else idle = setTimeout(() => abort('stream_idle_timeout'), policy.idleTimeoutMs);
    },
    diagnostics() {
      return { ...policy, elapsedMs: Date.now() - startedAt,
        timeoutMs: interruption === 'first_response_timeout' ? policy.firstResponseTimeoutMs : interruption === 'stream_idle_timeout' ? policy.idleTimeoutMs : policy.maxDurationMs,
        ...(lastProgressAt === undefined ? {} : { lastProgressElapsedMs: lastProgressAt - startedAt, idleElapsedMs: Date.now() - lastProgressAt }),
        ...(interruption ? { interruption } : {}) };
    },
    get interruption() { return interruption; },
    close() { clearTimeout(first); clearTimeout(total); clearTimeout(idle); },
  };
}

function timeoutMessage(diagnostics) {
  const seconds = Math.round(diagnostics.timeoutMs / 1000);
  const reason = diagnostics.interruption === 'first_response_timeout' ? `模型在 ${seconds} 秒内未返回实际生成内容`
    : diagnostics.interruption === 'stream_idle_timeout' ? `模型输出已连续 ${seconds} 秒没有新内容`
      : `模型单次生成达到 ${seconds} 秒总时长上限`;
  return `${reason}，本次请求已停止。报告尚未完成，已保存材料和审查记录，可直接继续。`;
}
module.exports = { requestTimeouts, sseProgress, modelDeadline, timeoutMessage };
