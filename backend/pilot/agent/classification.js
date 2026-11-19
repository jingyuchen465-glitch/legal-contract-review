const { catalog, findType } = require('../catalog');

function classificationForReport(contract, run, report) {
  const previous = contract.classification;
  if (previous?.confirmed && (!previous.versionId || previous.versionId === run.version_id)) return null;
  const typeName = report.contractType?.trim();
  if (!typeName) return null;
  // A free-form report name is not evidence for a broader catalogue category.
  const type = catalog.flatMap(c => c.types).find(t => t.name === typeName);
  const entry = findType(type?.id || 'other');
  return {
    typeId: entry.id, categoryId: entry.categoryId, typeName,
    tags: previous?.versionId === run.version_id ? previous.tags || [] : [],
    adapter: 'harness-v1', identifiedBy: 'agent', reviewId: run.id,
    versionId: run.version_id, confirmed: false, perspectiveConfirmed: false,
  };
}

module.exports = { classificationForReport };
