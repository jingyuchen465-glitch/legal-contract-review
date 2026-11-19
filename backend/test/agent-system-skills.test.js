const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const skills = require('../pilot/agent/system-skills');

test('system skill bundles its real entry and mandatory examples; missing resources fail closed', async () => {
  const [skill] = await skills.snapshot();
  assert.equal(skill.name, 'legal-practical-redline');
  assert.equal(skill.required, true);
  assert.deepEqual(skill.requiredResources, ['references/examples.md']);
  assert.match(skill.content, /保留原文/);
  assert.match(skill.resources['references/examples.md'], /对私支付/);
  await assert.rejects(skills.snapshot(path.join(os.tmpdir(), 'missing-system-skill-bundle')), { code: 'AGENT_SYSTEM_SKILL_UNAVAILABLE' });
});

test('each model request receives entry and examples even without a skill tool call or after compaction', async () => {
  const bundle = await skills.snapshot();
  for (const body of [{ messages: [{ role: 'user', content: '审查合同' }], model: 'fixture' }, { messages: [{ role: 'system', content: '压缩摘要' }, { role: 'user', content: '继续' }], model: 'fixture' }]) {
    const injected = skills.inject(body, bundle);
    assert.equal(injected.messages[0].role, 'system');
    assert.ok(injected.messages[0].content.includes(bundle[0].content));
    assert.ok(injected.messages[0].content.includes(bundle[0].resources['references/examples.md']));
    assert.deepEqual(injected.messages.slice(1), body.messages);
    assert.equal(injected.model, body.model);
    assert.equal(body.messages.length, injected.messages.length - 1);
  }
});

test('frozen system skills survive source updates and reject altered or missing snapshots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legal-system-skills-'));
  try {
    const [original] = await skills.snapshot();
    const folder = path.join(root, original.name);
    await fs.mkdir(path.join(folder, 'references'), { recursive: true });
    await fs.writeFile(path.join(folder, 'SKILL.md'), original.content);
    await fs.writeFile(path.join(folder, 'references/examples.md'), original.resources['references/examples.md'] + '\n更新的范例\n');
    const [changed] = await skills.snapshot(root);
    assert.notEqual(original.versionId, changed.versionId);
    const run = { snapshot: { promptVersion: 'legal-harness-1.2', systemSkills: [original] } };
    assert.equal(skills.forRun(run)[0].versionId, original.versionId);
    assert.throws(() => skills.forRun({ snapshot: { promptVersion: 'legal-harness-1.2' } }), { code: 'AGENT_SYSTEM_SKILL_SNAPSHOT' });
    assert.throws(() => skills.forRun({ snapshot: { systemSkills: [{ ...original, content: '被修改的正文' }] } }), { code: 'AGENT_SYSTEM_SKILL_SNAPSHOT' });
    assert.deepEqual(skills.forRun({ snapshot: {} }), []);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('legal-system-skills-') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('catalog separates mandatory review method and batch-specific system method', async () => {
  const catalog = await skills.catalog();
  assert.equal(catalog.find(s => s.name === 'legal-practical-redline').scope, 'all_reviews');
  assert.equal(catalog.find(s => s.name === 'legal-auto-review').scope, 'auto_review_batches');
  assert.ok(catalog.every(s => s.category === 'system'));
});

test('promoted methods carry conditions into every request and require their frozen snapshot', async () => {
  const memory = { id: 'test-memory', kind: 'skill', is_system: true, title: '默认我方立场', description: '识别主体', content: '指定主体优先。', conditions: ['仅限示例公司合同'], department: '测试', version: 3, source_id: 'source' };
  const required = [...await skills.snapshot(), ...skills.promoted([memory])];
  const run = { snapshot: { promptVersion: 'legal-harness-1.2', memories: [memory], systemSkills: required } };
  assert.equal(skills.forRun(run).length, 2);
  assert.match(skills.inject({ messages: [] }, required).messages[0].content, /仅限示例公司合同/);
  assert.match(required[1].content, /不满足时不得套用/);
  assert.equal(required[1].memoryVersion, 3);
  assert.throws(() => skills.forRun({ snapshot: { ...run.snapshot, systemSkills: required.slice(0, 1) } }), { code: 'AGENT_SYSTEM_SKILL_SNAPSHOT' });
  assert.throws(() => skills.forRun({ snapshot: { ...run.snapshot, memories: [{ ...memory, conditions: ['扩大适用条件'] }] } }), { code: 'AGENT_SYSTEM_SKILL_SNAPSHOT' });
  assert.deepEqual(skills.promoted([{ ...memory, is_system: false }]), []);
});
