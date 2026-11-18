// Processing rounds include chat replies and questions; only submitted results are reports.
export function reportIncludesVersion(report, versionId) {
  return report?.version_id === versionId || !!report?.snapshot?.jointGroup?.documents?.some(d => d.versionId === versionId);
}

export function completedReports(reviews = [], versionId) {
  return reviews.filter(r => reportIncludesVersion(r, versionId) && r.status === 'completed' && r.agent_result)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id.localeCompare(a.id));
}

export function selectReport(reports, selectedId, followLatest) {
  if (!followLatest && reports.some(r => r.id === selectedId)) return selectedId;
  return reports[0]?.id || '';
}
