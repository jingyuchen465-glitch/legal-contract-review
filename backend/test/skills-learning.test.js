const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { matchSkills, skillInput, markdown, validatePack } = require('../pilot/skills');
const { validateExperience, markChanges } = require('../pilot/learning');
const { chunks } = require('../pilot/parser');
const { config } = require('../pilot/config');
const { createGateway } = require('../pilot/model');
const item = { id: 'payment', title: '付款检查', method: '结合验收条件检查付款起算点。', conditions: [], exclusions: [], examples: [], sourceIds: [randomUUID()] };
const pack = (level, type = 'procurement', state = 'published') => ({ id: randomUUID(), pack_id: 'pack-' + randomUUID(), version_no: 1, name: '检查方法', state, scope: { level, typeIds: level === 'common' ? [] : [type] }, skills: [item] });
const version = randomUUID(), findingId = randomUUID();
const context = { blocks: [{ versionId: version, sourceBlockId: 'b1', text: '验收合格后30日内付款。' }], findings: [{ id: findingId, disposition: { action: 'reject', reason: '已有起算点' } }], snapshot: { typeId: 'procurement', skillPacks: [], rulePacks: [] }, restrictedTerms: ['甲方虚构公司'] };
const proposal = () => ({ key: 'a', kind: 'skill', title: '核对付款起算点', reason: '人工驳回误报，需结合验收约定判断', method: item.method, evidence: [{ versionId: version, blockId: 'b1', quote: '验收合格后30日内付款' }] });
test('only common and matching published skills load; missing rules, drafts, retired and other types excluded', () => {
  const common = pack('common'), purchase = pack('type'), draft = pack('type', 'procurement', 'draft'), retired = pack('type', 'procurement', 'retired'), other = pack('type', 'software_license'), dependency = pack('type'); dependency.required_rule_versions = ['rule-version'];
  assert.deepEqual(matchSkills({ typeId: 'procurement' }, [common, purchase, draft, retired, other, dependency]).map(p => p.id), [common.id, purchase.id]);
  assert.equal(matchSkills({ typeId: 'procurement' }, [dependency], [{ id: 'rule-version' }]).length, 1);
  assert.deepEqual(matchSkills({ typeId: 'procurement' }), []);
  assert.equal(skillInput(matchSkills({ typeId: 'procurement' }, [purchase]))[0].skills[0].sourceIds, undefined);
});
test('skills validate taxonomy and Markdown carries methods, conditions and source references', () => {
  assert.throws(() => validatePack({ name: 'bad', scope: { level: 'type', typeIds: ['invented'] }, skills: [item] }), { code: 'SKILL_SCOPE' });
  const p = pack('common'); assert.match(markdown(p), /结合验收条件/); assert.match(markdown(p), /来源经验任务/);
});
test('extraction validates literal versioned evidence and genuine human dispositions', () => {
  assert.equal(validateExperience({ proposals: [proposal()] }, context)[0].scope, 'type');
  for (const change of [{ evidence: [] }, { evidence: [{ versionId: version, blockId: 'b1', quote: '虚构内容' }] }, { evidence: [], findingIds: [randomUUID()] }, { method: '联系甲方虚构公司核实' }, { method: '致电13812345678' }, { targetId: 'nonexistent' }, { dependsOn: ['invented'] }]) assert.throws(() => validateExperience({ proposals: [{ ...proposal(), ...change }] }, context), { code: 'LEARNING_OUTPUT_INVALID' });
  assert.equal(validateExperience({ proposals: [{ ...proposal(), evidence: [], findingIds: [findingId] }] }, context).length, 1);
  assert.deepEqual(validateExperience({ proposals: [] }, context), []);
});
test('document comparison follows literal text across paragraph renumbering and chunk splits preserve source IDs', () => {
  const current = { id: version, blocks: [{ id: 'b2', text: '条款不变' }, { id: 'b3', text: '新增条款内容' }] }, previous = { id: randomUUID(), blocks: [{ id: 'b1', text: '条款不变' }] };
  const marked = markChanges(current, previous); assert.equal(marked[0].change, 'unchanged'); assert.equal(marked[1].change, 'added');
  assert.equal(markChanges(current)[0].change, 'comparison_unavailable');
  const parts = chunks({ blocks: marked }, 4).flat(); assert.equal(parts[0].sourceBlockId, 'b2'); assert.equal(parts[0].versionId, version);
});
