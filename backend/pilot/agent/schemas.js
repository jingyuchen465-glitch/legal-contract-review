const { z } = require('zod');
const { fail } = require('../errors');
const text = z.string().trim().min(1);
const evidence = z.object({ versionId: z.string().uuid(), blockId: text, quote: text.max(20000) });
const finding = z.object({
  title: text.max(300), status: z.enum(['fail', 'uncertain', 'pass']).default('fail'),
  severity: z.enum(['high', 'medium', 'low']), kind: z.enum(['clause', 'missing', 'uncertain']),
  reason: text.max(12000), suggestion: z.string().max(20000).default(''),
  evidence: z.array(evidence).max(30), legalSourceIds: z.array(z.string().uuid()).max(30).default([]),
  legalEvidence: z.array(z.object({ sourceId: z.string().uuid(), quote: text.max(20000) })).max(30).default([]),
  edits: z.array(z.object({ versionId: z.string().uuid(), blockId: text, operation: z.enum(['replace', 'insert_after', 'delete']), originalText: z.string().min(1).max(20000), newText: z.string().max(20000), reason: text.max(3000) })).max(12).optional(),
});
const report = z.object({
  summary: text.max(20000), contractType: z.string().max(200).default(''),
  findings: z.array(finding).max(200), limitations: z.array(text.max(3000)).max(100).default([]),
  reviewedVersionIds: z.array(z.string().uuid()).min(1),
  crossDocumentReview: z.array(z.object({ category: z.enum(['amendments', 'amounts_terms', 'precedence']), scope: z.enum(['within_document', 'across_documents', 'not_applicable']).optional(), status: z.enum(['consistent', 'conflict', 'uncertain', 'not_applicable']), reason: text.max(4000), evidence: z.array(evidence).max(30) })).max(3).optional(),
  revisionReview: z.object({
    baselineReviewId: z.string().uuid(),
    items: z.array(z.object({
      previousFindingId: z.string().uuid(), status: z.enum(['resolved', 'partial', 'unresolved', 'accepted', 'uncertain']),
      reason: text.max(12000), evidence: z.array(evidence).max(30),
      findingIndexes: z.array(z.number().int().min(0)).max(200),
      resolutionBasis: z.enum(['current_text', 'clause_removed', 'scope_changed']).optional(),
      reopenReason: text.max(12000).optional(),
    })).max(2000),
    newFindings: z.array(z.object({ findingIndex: z.number().int().min(0), origin: z.enum(['introduced_by_edit', 'previously_missed', 'new_material', 'changed_assessment']), reason: text.max(12000) })).max(200),
  }).optional(),
});
function verifyEvidence(items, documents) {
  return items.map(item => {
    const doc = documents.find(d => d.versionId === item.versionId);
    const block = doc?.blocks.find(b => b.id === item.blockId);
    if (!block || !block.text.includes(item.quote)) fail(422, 'AGENT_INVALID_EVIDENCE', '引用必须对应本次固定文件版本的逐字原文');
    return { ...item, ...(block.page ? { page: block.page } : {}) };
  });
}
function mergeRanges(ranges = [], next) {
  const list = [...ranges, next].sort((a, b) => a[0] - b[0]), result = [];
  for (const r of list) {
    const last = result.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else result.push([...r]);
  }
  return result;
}
const rangeKey = (versionId, blockId) => JSON.stringify([versionId, blockId]);
function coverage(documents, ranges) {
  const missing = [], total = documents.reduce((n, d) => n + d.blocks.length, 0);
  for (const d of documents) for (const b of d.blocks) {
    const r = ranges[rangeKey(d.versionId, b.id)] || [];
    if (b.text.length && !(r.length === 1 && r[0][0] === 0 && r[0][1] >= b.text.length)) missing.push({ versionId: d.versionId, blockId: b.id });
  }
  return { totalBlocks: total, readBlocks: total - missing.length, unreadBlocks: missing, complete: missing.length === 0, meaning: '原文读取覆盖，不代表风险全部识别' };
}
module.exports = { evidence, report, verifyEvidence, mergeRanges, rangeKey, coverage };
