const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./official-sources');

const root = path.resolve(process.env.LEGAL_VENDOR_SKILL_ROOT || path.join(__dirname, '../../../skills/vendor'));

function frontmatter(text) {
  const body = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] || '';
  const value = key => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body)?.[1]?.trim() || '';
  return { name: value('name'), description: value('description') };
}

async function snapshot() {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
  } catch (error) {
    const wrapped = new Error('full-dsh skill manifest unavailable');
    wrapped.code = 'AGENT_VENDOR_SKILL_MANIFEST';
    wrapped.cause = error;
    throw wrapped;
  }
  const enabled = manifest.skills.filter(skill => skill.runtimeEnabled);
  return Promise.all(enabled.map(async entry => {
    const directory = path.join(root, entry.path);
    const content = await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8');
    const metadata = frontmatter(content);
    if (!metadata.name || !metadata.description) {
      const error = new Error(`invalid vendor skill metadata: ${entry.id}`);
      error.code = 'AGENT_VENDOR_SKILL_METADATA';
      throw error;
    }
    const name = `vendor-${entry.id}`;
    const runtimeInstructions = [
      `\n运行时技能目录：${directory}`,
      '需要执行本技能脚本时，先切换到上述目录，再使用 SKILL.md 中的相对脚本路径。',
      '脚本只能处理本次任务工作区内的材料；不要读取宿主应用、其他任务或环境密钥。',
    ].join('\n');
    const skill = {
      name,
      title: metadata.name,
      description: metadata.description,
      category: 'vendor',
      required: false,
      scope: 'full_dsh_tasks',
      vendorId: entry.id,
      runtimeDirectory: directory,
      runtimeScripts: entry.scripts,
      runtimeReferences: entry.references,
      content: content + runtimeInstructions,
      resources: {},
      requiredResources: [],
    };
    const fingerprint = hash(JSON.stringify([skill.name, skill.content, skill.runtimeScripts]));
    return { ...skill, versionId: `vendor-${fingerprint}`, version: fingerprint.slice(0, 12) };
  }));
}

module.exports = { root, snapshot };
