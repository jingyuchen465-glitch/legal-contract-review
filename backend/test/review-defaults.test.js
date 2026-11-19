const { test } = require('node:test');
const assert = require('node:assert/strict');
const { catalog } = require('../pilot/catalog');
const { defaultReviewPacks } = require('../pilot/review-defaults');
const { matchRules } = require('../pilot/rules');
const noDatabaseRead = () => { throw Error('A pinned snapshot must not read current standards'); };

test('all fourteen catalog types can review using immutable built-in points and no published package', async () => {
  const pinned = defaultReviewPacks(), before = structuredClone(pinned);
  const types = catalog.flatMap(category => category.types); assert.equal(types.length, 14);
  for (const type of types) {
    const matched = await matchRules(noDatabaseRead, { typeId: type.id, tags: [] }, pinned);
    assert.equal(matched.packs.length, 2);
    assert.ok(matched.packs.every(pack => pack.source === 'builtin'));
    assert.ok(matched.rules.length >= 7);
    assert.equal(new Set(matched.rules.map(rule => rule.id)).size, matched.rules.length);
    assert.deepEqual(matched.knowledge, []);
  }
  assert.deepEqual(pinned, before);
  pinned[0].rules[0].title = 'edited';
  assert.notEqual(defaultReviewPacks()[0].rules[0].title, 'edited');
});

test('company specialty standards keep precedence while draft changes cannot affect the built-in fallback', async () => {
  const company = { id: 'company-v1', pack_id: 'company', version_no: 1, name: '公司采购标准', state: 'published', scope: { level: 'type', typeIds: ['procurement'] }, rules: [{ id: 'company-delivery', title: '交付', instruction: '核查交付', severity: 'high' }], knowledge: [] };
  const pinned = [company, ...defaultReviewPacks()];
  const procurement = await matchRules(noDatabaseRead, { typeId: 'procurement', tags: [] }, pinned);
  assert.deepEqual(procurement.rules.map(rule => rule.id), ['company-delivery']);
  const other = await matchRules(noDatabaseRead, { typeId: 'other', tags: [] }, [{ ...company, state: 'draft', scope: { level: 'type', typeIds: ['other'] } }, ...defaultReviewPacks()]);
  assert.ok(other.packs.every(pack => pack.source === 'builtin'));
  assert.ok(!other.rules.some(rule => rule.id === 'company-delivery'));
  await assert.rejects(() => matchRules(noDatabaseRead, { typeId: 'invalid', tags: [] }, pinned), { code: 'UNKNOWN_CONTRACT_TYPE' });
  await assert.rejects(() => matchRules(noDatabaseRead, { typeId: 'procurement', tags: [] }, []), { code: 'NO_PUBLISHED_RULES' });
});
