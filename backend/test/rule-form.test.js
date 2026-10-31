const { test } = require('node:test');
const assert = require('node:assert/strict');
const { packSchema } = require('../pilot/rules');
const helpers = import('../../frontend/src/pilot/rule-form.mjs');

test('规则表单复制时保留稳定编号、所有范围字段、标签及引用，不更改原版本', async () => {
  const { editPack, validatePack } = await helpers;
  const original = { name: '软件标准', scope: { level: 'type', typeIds: ['software_license'], categoryIds: ['software'], tags: ['数据处理'] }, rules: [{ id: 'stable-rule', title: '验收条件', instruction: '核查验收边界。', severity: 'medium', mandatory: false, tags: ['数据,处理', '知识产权'] }], knowledge: [{ id: 'stable-ref', title: '公司规定', content: '虚构内部制度条款', source: '测试制度第1条', effectiveDate: '2026-10-01' }] };
  const before = structuredClone(original), form = editPack(original);
  assert.deepEqual(form, original); assert.deepEqual(validatePack(form), []);
  assert.deepEqual(packSchema.parse(form), original);
  form.rules[0].instruction = '调整后的标准'; form.scope.typeIds.push('procurement'); form.knowledge[0].content = '新内容';
  assert.deepEqual(original, before); assert.equal(form.rules[0].id, original.rules[0].id);
});
test('新检查项与资料自动生成不同的可用编号', async () => {
  const { editPack, newRule, newKnowledge } = await helpers;
  const a = editPack(), b = editPack(); assert.notEqual(a.rules[0].id, b.rules[0].id);
  assert.notEqual(newRule().id, newRule().id); assert.notEqual(newKnowledge().id, newKnowledge().id);
  a.name = '采购标准'; a.scope.typeIds = ['procurement']; a.rules[0].title = '付款'; a.rules[0].instruction = '核查付款条件';
  assert.doesNotThrow(() => packSchema.parse(a));
});
test('表单阻止空标准、无适用范围、无检查项与不完整参考资料', async () => {
  const { editPack, validatePack } = await helpers;
  const form = editPack(); assert.equal(validatePack(form).length, 4);
  form.name = '标准'; form.scope.typeIds = ['procurement']; form.rules[0].title = '付款'; form.rules[0].instruction = '   ';
  assert.match(validatePack(form).join(), /审查标准/);
  form.rules = []; assert.match(validatePack(form).join(), /至少添加/);
  form.knowledge = [{ title: '标题', content: '', source: '', effectiveDate: '' }]; assert.match(validatePack(form).join(), /参考资料 1/);
});
test('全部范围模式按各自选择校验，通用规则无须选择类型', async () => {
  const { editPack, validatePack } = await helpers;
  const form = editPack(); form.name = '标准'; form.rules[0].title = '检查'; form.rules[0].instruction = '说明';
  for (const [level, field] of [['type','typeIds'],['template','typeIds'],['category','categoryIds'],['tag','tags']]) {
    form.scope = { level, [field]: [] }; assert.equal(validatePack(form).length, 1);
    form.scope[field] = ['selected']; assert.deepEqual(validatePack(form), []);
  }
  form.scope = { level: 'common' }; assert.deepEqual(validatePack(form), []);
});
test('适用范围以中文目录名展示，未知标识保留供排查', async () => {
  const { scopeText } = await helpers; const catalog = [{ id: 'software', name: '软件许可合同', types: [{ id: 'software_license', name: '软件许可合同' }] }];
  assert.equal(scopeText({ level: 'type', typeIds: ['software_license'] }, catalog), '按合同类型 · 软件许可合同');
  assert.equal(scopeText({ level: 'common' }, catalog), '全部合同');
  assert.match(scopeText({ level: 'category', categoryIds: ['software'] }, catalog), /软件许可合同/);
  assert.match(scopeText({ level: 'tag', tags: ['知识产权'] }, catalog), /知识产权/);
  assert.match(scopeText({ level: 'type', typeIds: ['legacy-id'] }, catalog), /legacy-id/);
});
