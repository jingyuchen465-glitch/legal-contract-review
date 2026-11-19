export const scopeLabels = { common: '全部合同', category: '按合同大类', type: '按合同类型', tag: '按专项标签', template: '模板对照' };
export const newRule = () => ({ id: `rule-${crypto.randomUUID()}`, title: '', instruction: '', severity: 'high', mandatory: true, tags: [] });
export const newKnowledge = () => ({ id: `ref-${crypto.randomUUID()}`, title: '', content: '', source: '', effectiveDate: '' });
export function editPack(pack) {
  return pack ? structuredClone({ name: pack.name, scope: pack.scope, rules: pack.rules, knowledge: pack.knowledge || [] }) : { name: '', scope: { level: 'type', typeIds: [], categoryIds: [], tags: [] }, rules: [newRule()], knowledge: [] };
}
export function validatePack(form) {
  const errors = [];
  if (!form.name.trim()) errors.push('请填写规则包名称。');
  const field = { category: 'categoryIds', type: 'typeIds', template: 'typeIds', tag: 'tags' }[form.scope.level];
  if (field && !form.scope[field]?.length) errors.push(`请至少选择一个${{ categoryIds: '合同大类', typeIds: '合同类型', tags: '专项标签' }[field]}。`);
  if (!form.rules.length) errors.push('至少添加一个检查项。');
  if (new Set(form.rules.map(r => r.id)).size !== form.rules.length) errors.push('检查项编号重复，请重新打开规则后再试。');
  form.rules.forEach((r, i) => {
    if (!r.title.trim()) errors.push(`检查项 ${i + 1}：请填写名称。`);
    if (!r.instruction.trim()) errors.push(`检查项 ${i + 1}：请填写审查标准。`);
  });
  form.knowledge.forEach((k, i) => {
    if (![k.title, k.content, k.source, k.effectiveDate].every(v => typeof v === 'string' && v.trim())) errors.push(`参考资料 ${i + 1}：请补全名称、内容、来源和生效日期，或删除空白资料。`);
  });
  return errors;
}
export function scopeText(scope, catalog) {
  const types = catalog.flatMap(c => c.types);
  if (scope.level === 'common') return '全部合同';
  const values = scope.level === 'category' ? scope.categoryIds?.map(id => catalog.find(c => c.id === id)?.name || id) : scope.level === 'tag' ? scope.tags : scope.typeIds?.map(id => types.find(t => t.id === id)?.name || id);
  return `${scopeLabels[scope.level] || scope.level} · ${values?.join('、') || '未选择范围'}`;
}
