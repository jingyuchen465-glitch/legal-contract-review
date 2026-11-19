const milliseconds = value => { const n = new Date(value).getTime(); return Number.isFinite(n) ? n : null; };
export function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`;
}

// Older runs have no plan event: infer their totals from the recorded batches.
export function reviewProgress(run, now = Date.now()) {
  if (!run || run.stage !== 'reviewing') return null;
  const steps = run.steps || [];
  let start = -1;
  for (let i = 0; i < steps.length; i++) if (steps[i].stage === 'reviewing') start = i;
  const current = steps.slice(start + 1);
  const plan = current.find(s => s.stage === 'review_plan')?.details;
  const batches = current.filter(s => s.stage === 'review_batch' && s.status === 'completed');
  const first = batches[0]?.details;
  const total = plan?.totalBatches || (first ? first.chunkCount * first.ruleBatchCount * (first.skillBatchCount || 1) : 0);
  const unique = new Map(batches.map(s => [JSON.stringify([s.details.chunkIndex, s.details.ruleBatchIndex, s.details.skillBatchIndex || 1]), s]));
  const completed = unique.size;
  const fresh = [...unique.values()].filter(s => !s.details.cached).length;
  const started = milliseconds(steps[start]?.created_at) ?? milliseconds(run.created_at) ?? now;
  const elapsed = Math.max(0, now - (milliseconds(run.created_at) ?? started));
  // Estimate from observed wall-clock throughput; cache hits cannot inflate it.
  const remainingMs = total > completed && fresh >= Math.max(3, plan?.concurrency || 1) ? Math.max(0, now - started) / fresh * (total - completed) : null;
  return { completed, total, elapsed, remainingMs, text: total ? `已完成 ${completed}/${total} 批` : '正在准备审查批次' };
}
