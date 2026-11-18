export const batchLabels = { queued: '排队中', ingesting: '读取材料', planning: '制定计划', executing: '审查中', observing: '复核中', drafting: '生成批注稿', completed: '已完成', partial: '已出结果 · 有待处理项', needs_attention: '需处理', failed: '执行失败', cancelled: '已停止' };
export const isBatchActive = status => ['queued', 'ingesting', 'planning', 'executing', 'observing', 'drafting'].includes(status);

const operationNames = { read_document: '读取合同正文', list_documents: '查看材料目录', create_review_plan: '制定审查计划', submit_review: '提交候选报告', observe_review: '复核审查结果', search_legal_sources: '检索法律依据', fetch_official_source: '读取官方法律资料', generate_annotated_docx: '生成 Word 批注建议稿', request_information: '提出待确认问题' };
const seconds = ms => Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 100) / 10} 秒` : '未记录';
const interruptionLabels = { first_response_timeout: '等待首次生成内容超时', stream_idle_timeout: '输出停滞，系统中止', request_deadline: '达到请求总时限，系统中止', connection: '连接中断' };

function pauseDetails(batch, state) {
  if (!state.canResume || state.question || ['partial', 'cancelled'].includes(batch.status)) return null;
  const review = batch.review || {};
  const activity = (batch.activity || []).filter(e => !e.review_id || e.review_id === batch.main_review_id);
  const failures = activity.filter(e => e.type === 'model_failed');
  const last = failures.at(-1)?.data || {};
  const code = review.errorCode || last.code;
  const reasons = { AGENT_MODEL_TIMEOUT: '模型响应超时', AGENT_MODEL_CONNECTION: '模型连接中断', AGENT_MODEL_HTTP: '模型服务返回错误', AGENT_TIMEOUT: '本轮审查达到时间上限', AGENT_BUDGET: '本轮模型请求次数达到上限', AGENT_NO_PROGRESS: '连续重复操作，没有取得新进展', AGENT_INCOMPLETE: '本轮尚未提交完整结果' };
  const attempts = failures.map(e => {
    const request = e.data.number != null ? activity.find(r => r.type === 'model_request' && r.data.number === e.data.number) : null;
    const interval = request ? Date.parse(e.created_at) - Date.parse(request.created_at) : NaN;
    const estimated = !Number.isFinite(e.data.elapsedMs) && Number.isFinite(interval) && interval >= 0;
    return {
      number: e.data.number ?? null, at: e.created_at, duration: estimated ? `约 ${seconds(interval)}` : seconds(e.data.elapsedMs),
      result: reasons[e.data.code] || '模型请求失败', source: estimated ? '运行事件计时（请求开始至失败）' : '运行记录',
      detail: interruptionLabels[e.data.interruption] || (e.data.httpStatus ? `HTTP ${e.data.httpStatus}` : '已记录请求失败'),
    };
  });
  if (!attempts.length && code === 'AGENT_MODEL_TIMEOUT') {
    for (const attempt of review.timeoutDiagnosis?.attempts || []) attempts.push({
      number: null, at: Number.isFinite(attempt.ended) ? new Date(attempt.ended).toISOString() : null,
      duration: seconds(attempt.duration), result: '模型响应超时', source: '历史诊断记录', detail: '经保存的会话日志核实',
    });
  }
  let trigger = review.errorMessage || batch.error_message || '运行记录未提供更具体的中断说明。';
  if (code === 'AGENT_MODEL_TIMEOUT') trigger = last.interruption === 'request_deadline' && Number.isFinite(last.timeoutMs)
    ? `系统在单次请求达到 ${seconds(last.timeoutMs)}的时限后中止了请求，模型响应未能完整完成。`
    : attempts.length ? '保存的记录确认模型请求超时，响应未能完整完成。' : '记录显示模型响应超时；本次请求的详细计时未保存。';
  if (code === 'AGENT_MODEL_TIMEOUT' && Number.isFinite(last.timeoutMs)) {
    if (last.interruption === 'first_response_timeout') trigger = `等待 ${seconds(last.timeoutMs)}仍未收到实际生成内容，系统暂停了请求。连接心跳不算生成内容。`;
    if (last.interruption === 'stream_idle_timeout') trigger = `模型曾返回内容，随后连续 ${seconds(last.timeoutMs)}没有新内容，系统暂停了请求。`;
    if (last.interruption === 'request_deadline' && last.timeoutPolicy === 'stream_progress') trigger = `本次生成达到 ${seconds(last.timeoutMs)}的总时长上限，系统中止了请求。该上限与输出停滞超时分别计时。`;
  }
  if (code === 'AGENT_MODEL_CONNECTION') trigger = '请求模型期间连接中断，系统未收到完整响应。';
  if (code === 'AGENT_MODEL_HTTP' && last.code === code && last.httpStatus) trigger = `模型服务返回 HTTP ${last.httpStatus}，本次请求未成功完成。`;
  const tool = activity.findLast(e => e.type === 'tool' && e.data?.ok);
  const currentPhase = state.phases.find(p => p.current);
  const stage = currentPhase?.title === '审查条款' ? '审查条款与整理报告' : currentPhase?.title || '审查执行';
  return {
    reason: reasons[code] || '审查执行中断', trigger, stage,
    lastOperation: tool ? operationNames[tool.data.name] || '完成资料核查操作' : '未保存可确认的操作记录',
    savedWork: `${state.total ? `正文已读取 ${state.read} / ${state.total} 段；` : ''}${state.reportReady ? '审查报告已生成' : review.candidateSaved ? '候选报告已保存，尚未完成复核' : '审查报告尚未生成'}。`,
    attempts,
    recordNote: attempts.length ? `本轮记录了 ${attempts.length} 次失败请求。以下为已保存的记录。` : code?.startsWith('AGENT_MODEL_') ? '旧记录未保存逐次请求的耗时，无法展示准确次数和时长。' : '',
    unknown: ['AGENT_MODEL_TIMEOUT', 'AGENT_MODEL_CONNECTION'].includes(code) ? '模型响应慢或连接中断的更深层原因尚未确认，现有记录无法判定是否为模型排队或网关异常。' : '',
    nextAction: state.reportReady ? '可以查看已生成的报告和文件，再重试未完成项。' : '材料和已有审查记录已保存，可以点击上方按钮继续，无需重新上传。',
    code: code || 'UNKNOWN',
  };
}

export function batchState(batch, now = Date.now()) {
  const review = batch?.review;
  const running = isBatchActive(batch?.status);
  const question = !running && review?.status === 'waiting_input' ? review.questions?.[0] || null : null;
  const artifacts = (batch?.artifacts || []).filter(a => a.review_id === batch.main_review_id);
  const legacyOutput = artifacts.some(a => a.kind === 'tracked_revisions') && !artifacts.some(a => a.kind === 'annotated_comments');
  const downloadable = artifacts.filter(a => a.downloadUrl).length;
  const reportReady = review?.status === 'completed';
  const observed = batch?.qualityGate?.observedReviewId === batch?.main_review_id && !!batch?.main_review_id;
  const hasPlan = !!batch?.executionPlan?.steps?.length;
  const planned = hasPlan && batch.executionPlan.reviewId === batch.main_review_id;
  const previousPlan = hasPlan && !planned;
  const coverage = review?.savedCoverage || review?.coverage;
  const read = Number(coverage?.readBlocks || 0), total = Number(coverage?.totalBlocks || 0);
  const readAll = total > 0 && read === total;
  const activity = (batch?.activity || []).filter(e => !e.review_id || e.review_id === batch?.main_review_id);
  const lastActivity = activity.at(-1);
  const lastModel = activity.findLast(e => e.type === 'model_request');
  // Older workers can leave a resumed batch queued even after its review starts.
  const started = running && review?.status === 'running';
  const status = batch?.status === 'queued' && started ? review.candidateSaved ? 'observing' : planned ? 'executing' : 'planning' : batch?.status;
  const waitingModel = running && started && !!lastModel && ['model_request', 'model_progress'].includes(lastActivity?.type);
  const prior = waitingModel ? activity.slice(0, activity.indexOf(lastModel)).findLast(e => ['model_request', 'model_failed', 'model_response'].includes(e.type)) : null;
  const retrying = prior?.type === 'model_failed';
  const elapsedMs = now - Date.parse(lastModel?.created_at);
  const modelWait = waitingModel ? { number: lastModel.data?.number, elapsed: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.floor(elapsedMs / 1000) : null,
    timeout: Number.isFinite(lastModel.data?.timeoutMs) ? lastModel.data.timeoutMs / 1000 : null, retrying,
    streaming: lastActivity?.type === 'model_progress',
    progressPolicy: lastModel.data?.timeoutPolicy === 'stream_progress',
    idleTimeout: Number.isFinite(lastModel.data?.idleTimeoutMs) ? lastModel.data.idleTimeoutMs / 1000 : null } : null;
  const canResume = ['failed', 'partial', 'needs_attention', 'cancelled'].includes(batch?.status);
  let title = batchLabels[batch?.status] || '准备审查', tone = 'working', description = '材料已保存，系统将依次读取、审查并生成报告与 Word 批注建议稿。';
  if (question) { title = '需要你确认信息'; tone = 'attention'; description = '请在下方直接回答列出的问题，提交后继续审查。'; }
  else if (batch?.status === 'completed') { title = legacyOutput ? '审查与历史修订稿已完成' : '审查与批注建议稿已完成'; tone = 'success'; description = legacyOutput ? '报告和历史 Word 修订稿已生成，可以继续审阅和下载文件。' : '报告和 Word 批注建议稿已生成，原文由法务调整；可以查看批注并下载文件。'; }
  else if (batch?.status === 'partial') { title = '审查结果已生成，仍有待处理项'; tone = 'attention'; description = '已生成的文件可以直接下载。请查看材料读取情况与批注定位限制。'; }
  else if (canResume) {
    title = batch.status === 'cancelled' ? '审查已停止' : '审查已暂停'; tone = 'attention';
    description = review?.errorMessage || (review?.errorCode === 'AGENT_INCOMPLETE' ? (review.candidateSaved ? '候选报告已保存，结果复核尚未完成。可以直接继续。' : '报告提交未完成。已读取的材料和执行记录已保存，可以直接继续。') : batch.error_message || '本轮执行中断，已保存的材料和审查记录可继续使用。');
  } else if (batch?.status === 'executing') description = readAll ? '全文已读取，正在分析条款并整理审查报告。此时无需补充信息。' : '正在读取合同、核对条款及相关依据。';
  else if (batch?.status === 'observing') description = '候选报告已保存，正在复核证据、遗漏和修改建议。';
  else if (batch?.status === 'drafting') description = '审查报告已完成，正在生成 Word 原生批注，合同正文保持不变。';
  if (running) {
    title = batchLabels[status] || title;
    if (status === 'queued') description = '任务已进入队列，等待后台开始执行。';
    else if (status === 'planning') description = previousPlan ? '后台已开始执行，正在更新本轮审查计划。上轮读取记录和计划已保留。' : '后台已开始执行，正在读取材料并制定本轮审查计划。';
    if (modelWait) {
      title = modelWait.streaming ? '正在生成审查内容' : retrying ? '正在重试模型请求' : '等待模型响应';
      description = modelWait.streaming ? '模型正在返回内容，完整响应尚未接收完。持续输出时会继续生成，不会因最初的等待时限到期而中断。'
        : retrying ? `${prior.data?.code === 'AGENT_MODEL_TIMEOUT' ? '上一次模型请求超时' : '上一次模型请求失败'}，系统已发起重试。当前尚未收到完整响应，报告尚未生成。` : '后台正在等待模型分析完成并返回下一步操作，当前尚未收到完整响应。';
    } else if (started && lastActivity?.type === 'tool' && lastActivity.data?.ok === false) description = '上一步操作未通过校验，系统正在调整审查步骤，报告尚未生成。';
  }
  const action = reportReady ? '重试未完成项' : review?.candidateSaved ? '继续复核并生成批注稿' : readAll ? '继续生成报告' : '继续审查';
  const planDescription = planned ? `已制定 ${batch.executionPlan.steps.length} 项任务` : previousPlan ? `上轮 ${batch.executionPlan.steps.length} 项计划已保存，本轮待更新` : '尚未制定';
  const phaseIndex = running || canResume ? reportReady ? 4 : review?.candidateSaved ? 3 : !readAll ? 0 : !planned ? 1 : 2 : -1;
  const phases = [
    { title: '读取材料', done: readAll, detail: total ? `${read} / ${total} 段已读取` : '保存并解析全部文件' },
    { title: '制定计划', done: planned, detail: hasPlan ? planDescription : '识别角色与审查范围' },
    { title: '审查条款', done: reportReady || !!review?.candidateSaved, detail: reportReady ? '报告已提交' : review?.candidateSaved ? '候选报告已保存' : '核对风险与修改建议' },
    { title: '复核结果', done: observed, detail: observed ? '证据与结果已复核' : '检查证据和遗漏' },
    { title: '生成文件', done: ['completed', 'partial'].includes(batch?.status) && downloadable > 0, detail: downloadable ? `${downloadable} 份文件可下载` : '生成报告与 Word 批注建议稿' },
  ].map((phase, index) => {
    const current = index === phaseIndex && !phase.done;
    const phaseStatus = phase.done ? '已完成' : !current ? '待进行' : batch.status === 'cancelled' ? '已停止' : question ? '等待回答' : running ? status === 'queued' ? hasPlan || read > 0 ? '等待继续' : '等待开始' : modelWait ? modelWait.streaming ? '正在生成' : retrying ? '正在重试' : '等待模型' : '进行中' : '已暂停';
    return { ...phase, current, status: phaseStatus };
  });
  const state = { title, tone, description, status, label: batchLabels[status], running, question, canResume, reportReady, downloadable, read, total, lastModel, lastActivity, modelWait, action, phases, planDescription };
  return { ...state, pauseDetails: pauseDetails(batch, state) };
}
