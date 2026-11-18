const { fail } = require('./errors');
const { capture } = require('./validation-issues');
const { validateDraft } = require('./clause-drafts');

// Shared by ordinary reviews, automatic reviews and their observation step.
// Validate edit targets/operations; never infer legal meaning from wording.
function validateEdits(report, documents, issues) {
  for (const [index, finding] of report.findings.entries()) {
    const grouped = new Map();
    for (const [editIndex, edit] of (finding.edits || []).entries()) {
      const path = `findings.${index}.edits.${editIndex}`;
      const document = documents.find(d => d.versionId === edit.versionId);
      capture(issues, path, () => {
        if (!document) fail(422, 'AUTO_EDIT_SCOPE', '改稿目标不在本次固定材料中');
        if (finding.status !== 'fail') fail(422, 'AUTO_UNCERTAIN_EDIT', '无法判断或符合项只保留批注，不自动修改');
        if (finding.kind === 'missing' && edit.operation !== 'insert_after') fail(422, 'AUTO_MISSING_INSERT', '缺失条款只能新增');
        if (finding.kind !== 'missing' && !finding.evidence.some(e => e.versionId === edit.versionId && e.blockId === edit.blockId)) fail(422, 'AUTO_EDIT_EVIDENCE', '改稿目标段落须包含在本项 evidence 中；涉及多段时逐段提供原文证据');
      });
      if (!document) continue;
      const group = grouped.get(document.versionId) || { edits: [], indexes: [] };
      group.edits.push(edit); group.indexes.push(editIndex); grouped.set(document.versionId, group);
    }
    for (const [versionId, group] of grouped) capture(issues, `findings.${index}`, () => {
      try { validateDraft({ explanation: '核验报告中的结构化改稿', edits: group.edits }, documents.find(d => d.versionId === versionId).blocks); }
      catch (error) {
        if (error.issues) error.issues = error.issues.map(issue => ({ ...issue, path: issue.path.replace(/^edits\.(\d+)/, (_, n) => `edits.${group.indexes[Number(n)]}`) }));
        throw error;
      }
    });
  }
}

function withReportEdits(findings, run) {
  const remaining = [...(run.agent_result?.findings || [])];
  return findings.map(finding => {
    const index = remaining.findIndex(f => f.title === finding.title && f.reason === finding.reason && JSON.stringify(f.evidence) === JSON.stringify(finding.evidence));
    const source = index < 0 ? null : remaining.splice(index, 1)[0];
    return { ...finding, edits: finding.edits || source?.edits || [] };
  });
}

// Older report formats expose one text field. Include exact proposed wording
// there without forcing the Agent to duplicate it in the original short note.
function suggestionForDisplay(finding) {
  if (finding.disposition?.suggestion != null) return finding.disposition.suggestion;
  return [finding.suggestion, ...(finding.edits || []).map(edit => `${edit.versionId} / ${edit.blockId} · ${{ replace: '替换正文', insert_after: '在此段后新增', delete: '删除该段正文' }[edit.operation]}${edit.operation === 'delete' ? '' : '\n' + edit.newText}`)].filter(Boolean).join('\n\n');
}

module.exports = { validateEdits, withReportEdits, suggestionForDisplay };
