const { z } = require('zod');
const { fail, AppError } = require('./errors');
const { capture, throwIssues } = require('./validation-issues');

const draftSchema = z.object({
  explanation: z.string().min(1).max(4000),
  edits: z.array(z.object({
    operation: z.enum(['replace', 'insert_after', 'delete']),
    blockId: z.string().min(1),
    originalText: z.string().min(1).max(20000),
    newText: z.string().max(20000),
  })).min(1).max(2400),
});

function validateDraft(raw, blocks, allowedBlockIds, maxEdits = 12) {
  const result = draftSchema.safeParse(raw);
  if (!result.success) {
    const error = new AppError(422, 'MODEL_OUTPUT_SCHEMA', '改稿格式无效');
    error.diagnostics = { issues: require('./review-diagnostics').schemaIssues(result.error.issues) };
    throw error;
  }
  const draft = result.data, seen = new Set(), issues = [];
  if (draft.edits.length > maxEdits) fail(422, 'MODEL_OUTPUT_SCHEMA', '改稿修改数量超过本次允许范围');
  for (const [index, edit] of draft.edits.entries()) {
    const block = blocks.find(b => b.id === edit.blockId);
    const path = `edits.${index}`;
    capture(issues, path + '.originalText', () => {
      if (!block || block.text !== edit.originalText || allowedBlockIds && !allowedBlockIds.includes(edit.blockId)) fail(422, 'INVALID_EVIDENCE', '改稿必须逐字对应允许修改的完整原文段落');
    });
    capture(issues, path + '.blockId', () => {
      if (seen.has(edit.blockId)) fail(422, 'INVALID_EVIDENCE', '同一段落应合并成一次修改');
    });
    seen.add(edit.blockId);
    capture(issues, path + '.newText', () => {
      if (edit.operation === 'delete' ? edit.newText !== '' : !edit.newText.trim()) fail(422, 'INVALID_EDIT_TEXT', 'replace/insert_after 的 newText 不能为空；delete 的 newText 必须为空字符串');
      if (edit.operation === 'replace' && edit.newText === edit.originalText) fail(422, 'DRAFT_NO_CHANGE', '替换前后正文相同，请移除无变化的 replace 操作');
      if (block?.numbering?.label && edit.newText.startsWith(block.numbering.label + ' ')) fail(422, 'DRAFT_NUMBERING', 'Word 自动编号会保留，改稿正文不要重复自动编号');
    });
  }
  throwIssues(issues);
  return draft;
}

module.exports = { validateDraft };
