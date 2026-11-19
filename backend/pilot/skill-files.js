const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { config } = require('./config');
const { catalog, findType } = require('./catalog');
const { fail } = require('./errors');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
const compilerVersion = 'contract-skill-files-2';
function defaultEntry(key) {
  const category = catalog.find(c => c.id === key);
  if (!category && key !== 'common') fail(400, 'SKILL_ENTRY_KEY', '技能大类不存在');
  const name = key === 'common' ? '通用合同审查技能' : category.name + '审查技能';
  return { entry_key: key, name, description: key === 'common' ? '审查各类合同中已发布的通用审查经验。' : `审查${category.types.map(t => t.name).join('、')}时使用，按具体合同类型读取对应经验。`,
    body: '## 审查流程\n\n1. 核对交易实质、我方立场及已经确认的合同分类。\n2. 按具体合同类型和业务标签读取适用的审查点，逐项核对适用条件及例外。\n3. 结合正文、附件及交叉引用核实事实，保留精确原文依据。\n4. 按已发布规则形成判断与修改建议；条件缺失或存在冲突时交法务核实。\n\n## 输出要求\n\n遵循本次预审的输出协议。审查经验提供方法，判断标准使用正式规则，法律依据使用可追溯资料。未知商业条件使用【待双方确认】。' };
}
function methodMarkdown(s) {
  const lines = [`## ${s.title}`, '', s.method, ''];
  for (const [key, title] of [['conditions', '适用条件'], ['exclusions', '例外与排除条件'], ['examples', '修改范例']]) {
    if (s[key]?.length) lines.push(`### ${title}`, '', ...s[key].map(t => `- ${t}`), '');
  }
  return lines.join('\n');
}
function entryPack(key, entry, typeIds) {
  const defaults = defaultEntry(key);
  return { id: entry?.id || hash('default-skill-entry-1:' + key), pack_id:'review-entry-' + key,
    version_no:entry?.version_no || 1, name:entry?.name || defaults.name, state:'published', entry_only:true,
    scope:{level:key === 'common' ? 'common' : 'type',typeIds:key === 'common' ? [] : typeIds || catalog.find(c=>c.id===key).types.map(t=>t.id)},
    skills:[],sources:[],required_rule_versions:[] };
}
function bundleContent(pack, entry, commonEntry) {
  const type = findType(pack.scope.typeIds?.[0]);
  const key = pack.scope.level === 'common' ? 'common' : type.categoryId;
  entry ||= defaultEntry(key);
  commonEntry ||= defaultEntry('common');
  const ref = `references/${pack.scope.level === 'common' ? 'common' : type.id}/${pack.id}.md`;
  let reference = `# ${pack.name}\n\n`; const sections = [];
  for (const s of pack.skills) { const start = reference.length; reference += methodMarkdown(s) + '\n'; sections.push({ id: s.id, start, end: reference.length }); }
  const common = key === 'common' ? '' : `## 通用审查入口\n\n${commonEntry.body}\n\n## 所属大类审查入口\n\n`;
  const experience = pack.entry_only ? '本入口提供审查流程，具体审查点使用本次正式规则与适用的综合技能。' : `当具体类型为${pack.scope.level === 'common' ? '任意合同' : type.name}时，读取[${pack.name}](${ref})；仅使用满足适用条件的审查点。`;
  const root = `---\nname: contract-review-${key}\ndescription: ${JSON.stringify(entry.description)}\n---\n\n# ${entry.name}\n\n${common}${entry.body}\n\n## 本次可用经验\n\n${experience}\n`;
  return { key, sections, contents: { 'SKILL.md': root, [ref]: reference }, entryVersionId: entry.id || null, commonEntryVersionId: (key === 'common' ? entry.id : commonEntry.id) || null };
}
function rootPath(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) fail(422, 'SKILL_FILE_INVALID', '技能文件标识无效');
  return path.join(config.dataRoot, 'skills', digest);
}
async function readFiles(bundle) {
  if (!['contract-skill-files-1', compilerVersion].includes(bundle.compilerVersion) || !Array.isArray(bundle.files) || bundle.files.length !== 2) fail(422, 'SKILL_FILE_INVALID', '技能文件清单无效');
  const root = rootPath(bundle.hash), contents = {};
  for (const f of bundle.files) {
    if (!/^(SKILL\.md|references\/[a-z_]+\/[a-f0-9-]+\.md)$/.test(f.path)) fail(422, 'SKILL_FILE_INVALID', '技能引用路径无效');
    let content;
    try { content = await fs.readFile(path.join(root, f.path), 'utf8'); }
    catch { fail(422, 'SKILL_FILE_MISSING', '固定版本的技能文件缺失，请恢复文件备份后重试'); }
    if (hash(content) !== f.sha256) fail(422, 'SKILL_FILE_CHANGED', '固定版本的技能文件校验失败');
    contents[f.path] = content;
  }
  if (hash(canonical({ compilerVersion:bundle.compilerVersion, contents, sections: bundle.sections, entryVersionId: bundle.entryVersionId, ...(bundle.compilerVersion === compilerVersion ? {commonEntryVersionId:bundle.commonEntryVersionId} : {}) })) !== bundle.hash) fail(422, 'SKILL_FILE_CHANGED', '技能清单校验失败');
  return contents;
}
async function materialize(pack, entry, commonEntry) {
  const built = bundleContent(pack, entry, commonEntry);
  const digest = hash(canonical({ compilerVersion, contents: built.contents, sections: built.sections, entryVersionId: built.entryVersionId, commonEntryVersionId: built.commonEntryVersionId }));
  const bundle = { hash: digest, compilerVersion, entryKey: built.key, entryVersionId: built.entryVersionId, commonEntryVersionId: built.commonEntryVersionId, sections: built.sections,
    files: Object.entries(built.contents).map(([p, text]) => ({ path: p, sha256: hash(text) })) };
  const target = rootPath(digest);
  if (!await fs.stat(target).catch(() => null)) {
    const temp = target + '.tmp-' + randomUUID(); await fs.mkdir(temp, { recursive: true });
    try {
      for (const [p, text] of Object.entries(built.contents)) { await fs.mkdir(path.dirname(path.join(temp, p)), { recursive: true }); await fs.writeFile(path.join(temp, p), text, { flag: 'wx' }); }
      try { await fs.rename(temp, target); } catch (e) { if (!await fs.stat(target).catch(() => null)) throw e; }
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  await readFiles(bundle); return bundle;
}
async function loadSkillInput(packs) {
  return Promise.all(packs.map(async p => {
    if (!p.fileBundle) return require('./skills').skillInput([p])[0]; // Historic snapshots retain their original representation.
    const contents = await readFiles(p.fileBundle), ref = p.fileBundle.files.find(f => f.path !== 'SKILL.md');
    const ids = new Set(p.skills.map(s => s.id));
    const sections = p.fileBundle.sections.filter(s => ids.has(s.id));
    if (sections.length !== ids.size) fail(422, 'SKILL_FILE_INVALID', '技能文件未覆盖本次全部审查点');
    return { versionId: p.id, name: p.name, version: p.version, scope: p.scope, bundleHash: p.fileBundle.hash,
      entrypoint: contents['SKILL.md'], referencePath: ref.path, referenceSha256: ref.sha256,
      reference: sections.map(s => contents[ref.path].slice(s.start, s.end)).join('\n') };
  }));
}
module.exports = { defaultEntry, entryPack, methodMarkdown, materialize, readFiles, loadSkillInput, bundleContent };
