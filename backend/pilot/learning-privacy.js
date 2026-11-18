// Only whole role labels are generic. A company name containing a role remains private.
function isGenericRole(value) {
  const text = String(value || '').trim();
  const label = /^【[^【】]+】$/u.test(text) ? text.slice(1, -1) : text;
  return /^(?:本合同|合同所列|合同中的|合同中|合同约定的|本次审查的)?(?:我方|对方|甲方|乙方|丙方|丁方|出租方|承租方|转租出租方|转租承租方|次承租方|转租方|原出租方|原承租方|采购方|供应商|供方|需方|买方|卖方|委托方|受托方|服务方|客户方|许可方|被许可方|借款方|贷款方)$/u.test(label)
    || /^(?:the\s+)?(?:subtenant|sublessor|sublessee|tenant|landlord|lessor|lessee|buyer|seller|supplier|customer|licensor|licensee)$/iu.test(label);
}
function restrictedNames(terms = []) {
  return [...new Set(terms.filter(t => typeof t === 'string').map(t => t.trim()).filter(t => t && !isGenericRole(t)))];
}
function privacyIssues(proposal, index, terms) {
  const fields = ['title', 'method', 'instruction'].map(key => ({ path: ['proposals', index, key], value: proposal[key] }));
  for (const key of ['conditions', 'exclusions', 'examples']) for (const [i, value] of proposal[key].entries()) fields.push({ path: ['proposals', index, key, i], value });
  const names = restrictedNames(terms).filter(t => t.length >= 3).map(t => t.toLowerCase());
  return fields.flatMap(({ path, value }) => {
    const reason = names.some(t => value.toLowerCase().includes(t)) ? 'contract_specific_name'
      : /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\d)1[3-9]\d{9}(?!\d)/iu.test(value) ? 'contact_information' : null;
    return reason ? [{ path, code: 'custom', reason }] : [];
  }).slice(0, 10);
}
module.exports = { isGenericRole, restrictedNames, privacyIssues };
