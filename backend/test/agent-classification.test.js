const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classificationForReport } = require('../pilot/agent/classification');
const run = { id: 'review-current', version_id: 'version-current' };

test('report classification uses exact catalogue names and preserves uncatalogued contract names', () => {
  const procurement = classificationForReport({}, run, { contractType: ' 采购合同 ' });
  assert.equal(procurement.typeId, 'procurement');
  assert.equal(procurement.categoryId, 'production');
  assert.equal(procurement.confirmed, false);
  assert.equal(procurement.perspectiveConfirmed, false);
  assert.equal(procurement.reviewId, run.id);
  const name = '定制软件开发及维护服务合同（甲方委托方立场；模拟预审）';
  const development = classificationForReport({}, run, { contractType: name });
  assert.equal(development.typeName, name);
  assert.equal(development.typeId, 'other');
  assert.equal(development.categoryId, 'other');
  assert.equal(classificationForReport({}, run, { contractType: '软件许可合同' }).typeId, 'software_license');
  assert.equal(classificationForReport({}, run, { contractType: '  ' }), null);
});

test('current human classification is preserved; new versions do not inherit confirmation or tags', () => {
  const previous = { typeId: 'procurement', confirmed: true, perspectiveConfirmed: true, versionId: run.version_id, tags: ['运输'] };
  assert.equal(classificationForReport({ classification: previous }, run, { contractType: '软件许可合同' }), null);
  assert.equal(classificationForReport({ classification: { ...previous, versionId: undefined } }, run, { contractType: '软件许可合同' }), null);
  const current = classificationForReport({ classification: { ...previous, versionId: 'older-version' } }, run, { contractType: '软件许可合同' });
  assert.equal(current.typeId, 'software_license');
  assert.equal(current.confirmed, false);
  assert.deepEqual(current.tags, []);
});
