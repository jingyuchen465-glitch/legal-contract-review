const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

async function ensureWorkspace(db, run, root, profile) {
  await fs.mkdir(root, { recursive: true });
  const existing = await db('la_agent_workspaces').where({ session_id: run.agent_session_id, review_id: run.id }).first().catch(() => null);
  if (existing) return existing;
  return (await db('la_agent_workspaces').insert({
    id: randomUUID(), session_id: run.agent_session_id, review_id: run.id,
    runtime_profile: profile, status: 'running', root_path: root,
    metadata: JSON.stringify({}),
  }).returning('*'))[0];
}

function relativeFile(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

async function listFiles(root, current = root, out = []) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await listFiles(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function captureArtifacts(db, workspace, { sessionId, reviewId } = {}) {
  const files = await listFiles(workspace.root_path);
  const result = [];
  for (const full of files) {
    const relativePath = relativeFile(workspace.root_path, full);
    if (!relativePath) continue;
    const stat = await fs.stat(full);
    if (stat.size > MAX_ARTIFACT_BYTES) continue;
    const bytes = await fs.readFile(full);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const row = {
      id: randomUUID(), workspace_id: workspace.id, session_id: sessionId || workspace.session_id,
      review_id: reviewId || workspace.review_id, relative_path: relativePath,
      filename: path.basename(full), media_type: 'application/octet-stream', size: stat.size,
      sha256, storage_path: full,
    };
    await db('la_agent_artifacts').insert(row).onConflict(['workspace_id', 'relative_path']).merge({
      filename: row.filename, media_type: row.media_type, size: row.size,
      sha256: row.sha256, storage_path: row.storage_path, updated_at: db.fn.now(),
    });
    result.push(row);
  }
  await db('la_agent_workspaces').where({ id: workspace.id }).update({ status: 'finished', finished_at: db.fn.now(), updated_at: db.fn.now() });
  return result;
}

async function artifactFor(db, user, session, artifactId) {
  const row = await db('la_agent_artifacts as a').join('la_agent_workspaces as w', 'w.id', 'a.workspace_id')
    .where({ 'a.id': artifactId, 'w.session_id': session.id }).select('a.*', 'w.root_path').first();
  if (!row) {
    const error = new Error('工作区产物不存在'); error.status = 404; error.code = 'AGENT_ARTIFACT_NOT_FOUND'; throw error;
  }
  const relativePath = relativeFile(row.root_path, path.join(row.root_path, row.relative_path));
  if (!relativePath || relativePath !== row.relative_path) {
    const error = new Error('工作区产物路径无效'); error.status = 409; error.code = 'AGENT_ARTIFACT_PATH'; throw error;
  }
  return row;
}

module.exports = { ensureWorkspace, captureArtifacts, artifactFor, relativeFile, MAX_ARTIFACT_BYTES };
