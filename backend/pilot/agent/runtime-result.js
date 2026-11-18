const { AppError } = require('../errors');

// SDK run() can resolve with an error outcome instead of rejecting. Never turn
// that outcome into a request for business facts or a successful empty report.
function assertRuntimeResult(result, lastFailure) {
  if (result.finishReason !== 'error' && result.finishReason !== 'aborted') return;
  if (lastFailure) throw new AppError(502, lastFailure.code, lastFailure.message);
  const end = (result.events || []).findLast(e => e.type === 'turn/end');
  const code = end?.data?.reason?.error?.code;
  if (code === 'TIMEOUT') throw new AppError(502, 'AGENT_MODEL_TIMEOUT', '模型响应超时，报告尚未生成。已保存审查记录，可继续生成报告，无需补充信息。');
  if (code === 'TRANSPORT') throw new AppError(502, 'AGENT_MODEL_CONNECTION', '模型连接中断，报告尚未生成。已保存审查记录，可直接继续。');
  throw new AppError(502, 'HARNESS_RUNTIME_FAILED', '审查执行中断，已保存审查记录。请重试；若再次中断，请联系管理员检查模型服务。');
}

module.exports = { assertRuntimeResult };
