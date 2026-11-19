const { hasRole } = require('../auth');

function emptyResultCode(source) {
  const input = source.source || {};
  if (source.kind === 'review_revision' && !input.review?.substantive) return 'REVIEW_STATUS_ONLY';
  return source.kind === 'legal_decision' && !String(input.reason || '').trim() && !String(input.conditions || '').trim()
    ? 'NO_SUBSTANTIVE_FEEDBACK' : 'NO_REUSABLE_CONTENT';
}

function resultFor(source, counts = {}, audit = {}) {
  const skillCount = Number.isInteger(audit.skillCount) ? audit.skillCount : Number(counts.skill || 0), experienceCount = Number.isInteger(audit.experienceCount) ? audit.experienceCount : Number(counts.experience || 0);
  const generatedCount = Number.isInteger(audit.count) ? audit.count : skillCount + experienceCount;
  let resultCode = source.status, resultText = '';
  if (source.status === 'completed') {
    resultCode = generatedCount ? 'GENERATED' : emptyResultCode(source);
    resultText = generatedCount ? `已生成 ${generatedCount} 条可复用内容；新生成内容须审核后生效。`
      : resultCode === 'REVIEW_STATUS_ONLY' ? '仅保存批注处理状态、格式或未改变审阅内容，不据此推定认可或生成技能。'
      : resultCode === 'NO_SUBSTANTIVE_FEEDBACK' ? '仅保存了最终结论，未填写处理理由或附加条件，缺少可提炼的判断依据。'
        : '本次整理未提炼出可复用内容。可补充具体处理理由、审查方法和适用条件。';
  } else if (source.status === 'failed') resultText = '自动整理未完成，可查看错误后重试。';
  else resultText = source.status === 'running' ? '正在根据已保存的法务处理提炼技能和经验。' : '已保存来源，等待后台自动整理。';
  return { generatedCount, skillCount, experienceCount, resultCode, resultText };
}

function sourceFields(event) {
  const s = event.source || {}, label = value => ({ agree: '同意', conditional: '附条件同意', disagree: '不同意', accept: '采纳', reject: '驳回', correct: '已修正', needs_information: '待补充' }[value] || value || '未填写');
  if (event.kind === 'legal_decision') return [
    { label: '最终结论', value: label(s.outcome) }, { label: '处理理由', value: s.reason || '' }, { label: '附加条件', value: s.conditions || '' },
  ];
  if (event.kind === 'finding_disposition') return [
    { label: '处理的意见', value: s.title || '' }, { label: '法务处理', value: label(s.legalAction?.action) },
    { label: '处理理由', value: s.legalAction?.reason || '' }, { label: '修正内容', value: s.legalAction?.correction || s.legalAction?.suggestion || '' },
  ];
  if (event.kind === 'saved_revision') return [
    { label: '改稿来源', value: '已保存的新稿与前一版本进行正文比较；未填写修改理由时，修改原因仍待确认。' },
    { label: '前一版本', value: s.beforeVersionId || '' }, { label: '保存版本', value: s.afterVersionId || '' },
  ];
  if (event.kind === 'review_revision') {
    const r = s.review || {}, decisions = r.decisions || [], comments = r.comments || [];
    return [
      { label: '审阅基线', value: s.beforeVersionNo ? `v${s.beforeVersionNo} · ${s.baselineKind || '本次打开的版本'}` : s.beforeVersionId || '' }, { label: '保存版本', value: s.afterVersionNo ? `v${s.afterVersionNo}` : s.afterVersionId || '' },
      { label: '本次修改理由与适用条件', value: r.reason || '未填写；修改原因待确认' },
      { label: '正文变化', value: [...(r.body?.removed || []).map(t => '修改前：' + t), ...(r.body?.added || []).map(t => '修改后：' + t)].join('\n') || '正文未变化' },
      { label: '经文件核验的修订处理', value: decisions.map(d => `${d.action === 'accept' ? '接受' : '拒绝'}修订（第 ${d.paragraph} 段）\n原文：${d.before}\n提议：${d.proposed}\n保存：${d.saved}`).join('\n\n') || '无可确定的修订决策；未处理修订不视为认可' },
      { label: '本次新增批注与回复', value: comments.map(c => `${c.kind === 'reply' ? '回复' : '批注'}：${c.text}${c.context ? '\n对应批注：' + c.context : ''}`).join('\n\n') || '无' },
      { label: '批注状态变化', value: (r.commentStates || []).map(c => `${c.resolved ? '标记已处理' : '重新打开'}：${c.text}`).join('\n') || '无' },
      { label: '未能确定的修订处理', value: (r.unresolved || []).filter(u => !decisions.some(d => d.paragraph === u.paragraph)).map(u => `第 ${u.paragraph} 段：${u.message}`).join('\n') || '无' },
      { label: '提炼边界', value: r.limitation || '' },
    ];
  }
  return [{ label: '明确反馈', value: s.text || s.reason || '' }, ...(s.title ? [{ label: '意见标题', value: s.title }] : []), ...(s.suggestion ? [{ label: '修改建议', value: s.suggestion }] : [])];
}

async function enrichSources(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const [counts, audits] = await Promise.all([
    db('la_agent_memories').whereIn('source_id', ids).select('source_id', 'kind').count('* as count').select(db.raw("count(*) FILTER (WHERE draft_status IN ('draft','pending','rejected') AND state <> 'revoked')::int as review_count")).groupBy('source_id', 'kind'),
    db('la_audit').where({ action: 'agent.memory.learned' }).whereIn('entity_id', ids).select('entity_id', 'details').orderBy('created_at', 'desc').orderBy('id', 'desc'),
  ]);
  return rows.map(row => {
    const { source, ...safe } = row;
    const byKind = Object.fromEntries(counts.filter(c => c.source_id === row.id).map(c => [c.kind, Number(c.count)]));
    const result = resultFor(row, byKind, { ...row.generated_counts, ...audits.find(a => a.entity_id === row.id)?.details });
    const pendingKnowledgeCount = counts.filter(c => c.source_id === row.id).reduce((n, c) => n + Number(c.review_count), 0);
    return { ...safe, ...result, pendingKnowledgeCount, ...(pendingKnowledgeCount && row.status === 'completed' ? { resultText: `已生成 ${result.generatedCount} 条内容，其中 ${pendingKnowledgeCount} 条待提交或审核，审核通过后生效。` } : {}) };
  });
}

function sourceQuery(db, user) {
  const query = db('la_agent_legal_events as e').join('la_contracts as c', 'c.id', 'e.contract_id');
  if (!hasRole(user, 'admin') && user.department !== '*') query.where('c.department', user.department || '');
  return query;
}

async function listSources(db, user) {
  const query = sourceQuery(db, user);
  const rows = await query.clone().select('e.*', 'c.title as contract_title').orderBy('e.created_at', 'desc').limit(100);
  const states = await query.clone().select('e.status', 'e.revoked_at').count('* as count').groupBy('e.status', 'e.revoked_at');
  return { sources: await enrichSources(db, rows), sourceCount: states.reduce((sum, row) => sum + Number(row.count), 0), pendingCount: states.filter(row => !row.revoked_at && ['queued', 'running'].includes(row.status)).reduce((sum, row) => sum + Number(row.count), 0) };
}

module.exports = { emptyResultCode, resultFor, sourceFields, enrichSources, listSources };
