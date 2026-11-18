const { AppError } = require('./errors');

// Collect independent protocol/integrity failures without swallowing runtime,
// database or cancellation errors. Paths let the Agent repair specific fields.
function capture(issues, path, check) {
  try { return check(); }
  catch (error) {
    if (!(error instanceof AppError) || error.status !== 422) throw error;
    const nested = error.issues || [{ code: error.code, message: error.message, path: '' }];
    issues.push(...nested.map(issue => ({ ...issue, path: [path, issue.path].filter(Boolean).join('.') })));
  }
}

function throwIssues(issues) {
  if (!issues.length) return;
  const first = issues[0];
  const error = new AppError(422, first.code, `${first.path ? first.path + '：' : ''}${first.message}${issues.length > 1 ? `（共 ${issues.length} 项校验问题，请一次修正 issues 中列出的字段）` : ''}`);
  error.issues = issues;
  throw error;
}

module.exports = { capture, throwIssues };
