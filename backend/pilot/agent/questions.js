const { z } = require('zod');
const { fail } = require('../errors');

// Same question/answer fields as Harness user-questions; persisted in message.data.
const option = z.object({ label: z.string().trim().min(1).max(200), description: z.string().trim().max(1000).optional() });
const questionItem = z.object({
  id: z.string().trim().min(1).max(80),
  header: z.string().trim().max(80).optional(),
  question: z.string().trim().min(1).max(2000),
  detail: z.string().trim().max(3000).optional(),
  options: z.array(option).max(8).default([]),
  multiSelect: z.boolean().default(false),
}).superRefine((q, ctx) => {
  if (new Set(q.options.map(o => o.label)).size !== q.options.length) ctx.addIssue({ code: 'custom', message: '选项名称不能重复' });
});
const questionItems = z.array(questionItem).min(1).max(6).superRefine((items, ctx) => {
  if (new Set(items.map(q => q.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: '问题标识不能重复' });
});
const informationRequest = z.object({ question: z.string().trim().min(1).max(5000), questions: questionItems.optional() });
const answerItems = z.array(z.object({
  id: z.string().trim().min(1).max(80),
  selected: z.array(z.string().trim().min(1).max(200)).max(8),
  custom: z.string().trim().max(3000).optional(),
})).min(1).max(6);

function validateAnswers(questions, raw) {
  const answers = answerItems.parse(raw);
  if (answers.length !== questions.length || new Set(answers.map(a => a.id)).size !== answers.length) fail(422, 'AGENT_ANSWER_INVALID', '请回答每个问题，且不要重复提交同一问题');
  return questions.map(q => {
    const a = answers.find(a => a.id === q.id);
    if (!a || (!a.selected.length && !a.custom)) fail(422, 'AGENT_ANSWER_INVALID', '请选择答案或填写其他回答');
    if (new Set(a.selected).size !== a.selected.length || a.selected.some(label => !q.options.some(o => o.label === label))) fail(422, 'AGENT_ANSWER_INVALID', '回答包含不属于本问题的选项');
    if (!q.multiSelect && (a.selected.length > 1 || (a.selected.length && a.custom))) fail(422, 'AGENT_ANSWER_INVALID', '单选问题请选择一个选项，或填写其他回答');
    return { id: q.id, selected: a.selected, ...(a.custom ? { custom: a.custom } : {}) };
  });
}
function answerText(questions, answers, supplement = '') {
  const text = questions.map((q, i) => `${i + 1}. ${q.question}\n回答：${[...answers[i].selected, answers[i].custom].filter(Boolean).join('；')}`).join('\n\n');
  return text + (supplement.trim() ? '\n\n补充说明：' + supplement.trim() : '');
}
module.exports = { informationRequest, answerItems, validateAnswers, answerText };
