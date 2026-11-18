const fields = new Set(['proposals', 'key', 'title', 'method', 'instruction', 'conditions', 'exclusions', 'examples', 'findingIds', 'dependsOn', 'targetId', 'targetPackId', 'scope', 'checks', 'ruleId', 'status', 'kind', 'severity', 'reason', 'suggestion', 'evidence', 'blockId', 'quote', 'legalRefIds', 'typeId', 'tags', 'uncertain', 'groups', 'name', 'mainDocumentId', 'materials', 'documentId', 'role', 'excluded', 'notes', 'identifiers', 'text', 'facts', 'topic', 'summary', 'relations', 'category', 'effect', 'before', 'after', 'basis', 'explanation', 'applicableText', 'suggestions', 'versionId']);
for (const field of ['edits', 'explanation', 'operation', 'originalText', 'newText']) fields.add(field);
function schemaIssues(issues = []) {
  return issues.slice(0, 10).map(issue => ({
    path: (issue.path || []).slice(0, 8).map(part => Number.isInteger(part) ? part : fields.has(part) ? part : 'field').join('.'),
    code: ['invalid_type', 'invalid_value', 'too_small', 'too_big', 'custom'].includes(issue.code) ? issue.code : 'invalid',
    ...(['contract_specific_name', 'contact_information'].includes(issue.reason) ? { reason: issue.reason } : {}),
  }));
}
function reviewErrorDetails(error) {
  const details = {
    code: /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'PROCESSING_FAILED',
    name: ['Error', 'TypeError', 'ZodError', 'AppError', 'AbortError'].includes(error?.name) ? error.name : 'Error',
  };
  const diagnostic = error?.diagnostics || {};
  for (const key of ['chunkIndex', 'chunkCount', 'ruleBatchIndex', 'ruleBatchCount', 'attempt']) {
    if (Number.isSafeInteger(diagnostic[key]) && diagnostic[key] > 0) details[key] = diagnostic[key];
  }
  if (Array.isArray(diagnostic.issues)) details.issues = schemaIssues(diagnostic.issues.map(issue => ({ ...issue, path: String(issue.path || '').split('.').map(p => /^\d+$/.test(p) ? Number(p) : p) })));
  return details;
}
module.exports = { schemaIssues, reviewErrorDetails };
