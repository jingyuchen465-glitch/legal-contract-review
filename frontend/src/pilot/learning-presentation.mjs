export function proposalStatus(proposal) {
  if (proposal.state === 'duplicate') return {label:'已有内容覆盖',tone:'muted'};
  if (proposal.state === 'ignored') return { label: '已忽略', tone: 'muted' };
  if (proposal.state !== 'adopted') return { label: '待确认', tone: 'pending' };
  return {
    draft: { label: '草稿待发布', tone: 'draft' },
    pending: { label: '已提交审核', tone: 'draft' },
    published: { label: '已发布', tone: 'published' },
    retired: { label: '已停用', tone: 'muted' },
  }[proposal.draftState] || { label: '已生成草稿', tone: 'draft' };
}
export function proposalCounts(task) {
  return (task.proposals || []).reduce((counts, p) => {
    if (p.state === 'pending') counts.pending++;
    else if (p.state === 'adopted' && p.draftState === 'published') counts.published++;
    else if (p.state === 'adopted' && p.draftState !== 'retired') counts.drafts++;
    return counts;
  }, { pending: 0, drafts: 0, published: 0 });
}
export function evidenceVersion(task, id) {
  const source = task.sourceContext;
  const versions = [source?.currentVersion, source?.previousVersion,
    ...(source?.documentPairs || []).flatMap(p => [p.currentVersion, p.previousVersion])];
  const version = versions.find(v => v?.id === id);
  return version ? `文件 v${version.versionNo} · ${version.filename}` : '来源文件';
}
