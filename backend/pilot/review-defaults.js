// Internal review points let every catalog type run without maintaining rule packages.
// Existing company standards still take precedence; nothing is auto-published to the DB.
const { packs, catalogPacks } = require('./seeds');
const defaultVersion = '2026-11-04.1';
function defaultReviewPacks() {
  return structuredClone([...packs, ...catalogPacks]).map(pack => ({
    ...pack,
    id: `builtin:${pack.pack_id}:${defaultVersion}`,
    pack_id: `builtin-${pack.pack_id}`,
    name: pack.name.replace(/（.*?）/g, '').replace(/标准$/, '要点') + '（内置）',
    version_no: 1,
    state: 'builtin',
    rules: pack.rules.map(rule => ({ ...rule, id: `builtin/${pack.pack_id}/${rule.id}` })),
    knowledge: [],
  }));
}
async function reviewPacks(db) {
  const published = await db('la_rule_versions').where({ state: 'published' }).orderBy('published_at', 'desc');
  return [...published, ...defaultReviewPacks()];
}
module.exports = { defaultReviewPacks, reviewPacks, defaultVersion };
