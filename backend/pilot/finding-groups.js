// Keep every rule result for coverage/audit; combine only exactly equivalent
// opinions in the reading, disposition and export interfaces.
function groupFindings(findings = []) {
  const groups = new Map(), result = [];
  for (const finding of findings) {
    const disposition = finding.disposition || {};
    const key = JSON.stringify([
      finding.check_status, finding.kind, disposition.severity || finding.severity,
      String(finding.reason || '').trim(), String(disposition.suggestion ?? finding.suggestion ?? '').trim(),
      [...new Set((finding.evidence || []).map(e => JSON.stringify([e.versionId || '', e.blockId, e.quote])))].sort(),
      finding.document_suggestions || [],
      (finding.legal_refs || []).map(k => JSON.stringify(k)).sort(),
      disposition.action || '', disposition.reason || '',
    ]);
    const existing = finding.check_status !== 'pass' && groups.get(key);
    const related = { id: finding.id, ruleId: finding.rule_id, title: finding.title };
    if (existing) existing.relatedFindings.push(related);
    else {
      const group = { ...finding, relatedFindings: [related] }; result.push(group);
      if (finding.check_status !== 'pass') groups.set(key, group);
    }
  }
  return result;
}
module.exports = { groupFindings };
