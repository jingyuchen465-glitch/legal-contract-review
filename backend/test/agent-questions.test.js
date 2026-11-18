const { test } = require('node:test');
const assert = require('node:assert/strict');
const { informationRequest, validateAnswers, answerText } = require('../pilot/agent/questions');
const questions = [
  { id: 'party', question: '我方是哪一方？', options: [{ label: '甲方' }, { label: '乙方' }], multiSelect: false },
  { id: 'focus', question: '补充关注哪些事项？', options: [{ label: '付款' }, { label: '验收' }], multiSelect: true },
];
test('question requests accept legacy text and structured choices, rejecting duplicate identifiers and options', () => {
  assert.deepEqual(informationRequest.parse({ question: '我方是谁？' }), { question: '我方是谁？' });
  assert.equal(informationRequest.parse({ question: '请确认', questions }).questions.length, 2);
  for (const invalid of [[], [questions[0], questions[0]], [{ ...questions[0], options: [{ label: '甲方' }, { label: '甲方' }] }]]) {
    assert.throws(() => informationRequest.parse({ question: '请确认', questions: invalid }));
  }
});
test('answers must cover the exact question batch and only select offered options', () => {
  const good = [{ id: 'party', selected: ['甲方'] }, { id: 'focus', selected: ['付款', '验收'], custom: '关注数据处理' }];
  const answers = validateAnswers(questions, [...good].reverse());
  assert.deepEqual(answers, good);
  assert.match(answerText(questions, answers, '模拟测试'), /我方是哪一方？\n回答：甲方/);
  assert.match(answerText(questions, answers, '模拟测试'), /付款；验收；关注数据处理/);
  assert.match(answerText(questions, answers, '模拟测试'), /补充说明：模拟测试/);
  for (const bad of [
    good.slice(0, 1), [good[0], good[0]],
    [{ id: 'wrong', selected: ['甲方'] }, good[1]],
    [{ id: 'party', selected: ['不存在的选项'] }, good[1]],
    [{ id: 'party', selected: ['甲方', '乙方'] }, good[1]],
    [{ id: 'party', selected: ['甲方'], custom: '同时填其他' }, good[1]],
    [good[0], { id: 'focus', selected: ['付款', '付款'] }],
    [good[0], { id: 'focus', selected: [], custom: '  ' }],
  ]) assert.throws(() => validateAnswers(questions, bad), { code: 'AGENT_ANSWER_INVALID' });
});
test('custom answers work for unlisted roles and free text questions', () => {
  assert.deepEqual(validateAnswers([questions[0]], [{ id: 'party', selected: [], custom: '  第三方顾问  ' }]), [{ id: 'party', selected: [], custom: '第三方顾问' }]);
  assert.equal(validateAnswers([{ id: 'detail', question: '项目背景', options: [] }], [{ id: 'detail', selected: [], custom: '模拟合同预审' }])[0].custom, '模拟合同预审');
});
