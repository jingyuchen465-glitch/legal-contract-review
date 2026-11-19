export function fileFindings(findings = [], versionId, mainVersionId) {
  return findings.filter(f => (f.evidence || []).some(e => (e.versionId || mainVersionId) === versionId) || !(f.evidence || []).length && ((f.document_suggestions || []).some(s => s.versionId === versionId) || versionId === mainVersionId)).map(f => ({ ...f, evidence:(f.evidence || []).filter(e => (e.versionId || mainVersionId) === versionId), suggestion:(f.document_suggestions || []).filter(s => s.versionId === versionId).map(s => s.text).join('\n\n') || f.suggestion }));
}
