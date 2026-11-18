const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { hash } = require('./official-sources');
const { ENGINE } = require('./config');
const { hasRole, accessible, assertRevision, audit, requireRole } = require('../auth');
const { fail, wrap } = require('../errors');

const text = max => z.string().trim().min(1).max(max);
const bodySchema = z.object({ kind: z.enum(['skill', 'experience']), title: text(200), description: text(500), content: text(12000), conditions: z.array(text(1000)).max(20).default([]) });
const revisionSchema = z.object({ revision: z.number().int().min(1) });
const fingerprint = body => hash(JSON.stringify([body.kind, body.content, body.conditions]));
const bodyOf = row => Object.fromEntries(['kind', 'title', 'description', 'content', 'conditions'].map(k => [k, row[k]]));
const draftStates = ['draft', 'pending', 'rejected'];

function scoped(db, user) {
  const q = db('la_agent_memories as m').leftJoin('la_agent_legal_events as e', 'e.id', 'm.source_id');
  if (!hasRole(user, 'admin') && user.department !== '*') q.where('m.department', user.department || '');
  return q;
}
function effective(q, state) {
  if (state === 'active') q.where('m.state', 'active').where('m.version', '>', 0).whereNull('e.revoked_at');
  else if (state === 'disabled') q.where(function () { this.whereIn('m.state', ['disabled', 'revoked']).orWhereNotNull('e.revoked_at'); });
  else if (state === 'unpublished') q.where('m.version', 0);
  return q;
}
async function list(db, user, input) {
  const filters = z.object({ q: z.string().trim().max(500).default(''), kind: z.enum(['all', 'skill', 'experience', 'system']).default('all'), state: z.enum(['all', 'active', 'disabled', 'unpublished']).default('all'), review: z.enum(['all', 'none', ...draftStates]).default('all'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(input);
  const base = scoped(db, user);
  const counts = await effective(base.clone(), 'active').select('m.kind', 'm.is_system').count('* as count').groupBy('m.kind', 'm.is_system');
  const pending = await base.clone().where('m.draft_status', 'pending').whereNot('m.state', 'revoked').whereNull('e.revoked_at').count('* as count').first();
  const q = base.clone().leftJoin('la_agent_memory_versions as d', function () { this.on('d.memory_id', 'm.id').onIn('d.status', draftStates); });
  if (filters.kind === 'system') q.where('m.is_system', true);
  else if (filters.kind !== 'all') q.where('m.is_system', false).whereRaw("COALESCE(d.body->>'kind', m.kind) = ?", [filters.kind]);
  effective(q, filters.state);
  if (filters.review !== 'all') q.where('m.draft_status', filters.review);
  if (filters.q) q.where(function () {
    // Position performs literal, case-insensitive matching, including % and _.
    this.whereRaw("strpos(lower(concat_ws(' ', m.title, m.description, m.content, m.conditions::text, d.body::text)), lower(?)) > 0", [filters.q]);
  });
  const total = Number((await q.clone().count('* as n').first()).n);
  const page = Math.min(filters.page, Math.max(1, Math.ceil(total / filters.pageSize)));
  const memories = await q.select('m.*', 'e.contract_id', 'e.review_id', 'e.kind as source_kind', 'e.revoked_at', 'd.body as draft', 'd.review_note').orderBy('m.updated_at', 'desc').orderBy('m.id').limit(filters.pageSize).offset((page - 1) * filters.pageSize);
  const logs = await require('./memory-results').listSources(db, user);
  return { memories, ...logs, total, page, pageSize: filters.pageSize, summary: { skills: Number(counts.find(c => c.kind === 'skill' && !c.is_system)?.count || 0), systemSkills: Number(counts.find(c => c.is_system)?.count || 0), experiences: Number(counts.find(c => c.kind === 'experience')?.count || 0), sources: logs.sourceCount, pending: logs.pendingCount, pendingReview: Number(pending.count) }, legacyDisabled: true };
}
async function get(db, user, id, lock = false) {
  // Source revocation and management lock contract -> source -> memory.
  if (lock) {
    const initial = await scoped(db, user).where('m.id', id).select('m.id', 'e.contract_id', 'm.source_id').first();
    if (!initial) fail(404, 'AGENT_MEMORY_NOT_FOUND', '知识不存在或没有访问权限');
    if (initial.source_id) {
      await accessible(db, user, initial.contract_id, true);
      await db('la_agent_legal_events').where({ id: initial.source_id }).forUpdate().first();
    }
  }
  const q = scoped(db, user).where('m.id', id).select('m.*', 'e.revoked_at', 'e.contract_id');
  if (lock) q.forUpdate('m');
  const row = await q.first();
  if (!row) fail(404, 'AGENT_MEMORY_NOT_FOUND', '知识不存在或没有访问权限');
  if (row.source_id) await accessible(db, user, row.contract_id);
  return row;
}
async function detail(db, user, id) {
  return db.transaction(async trx => {
    const row = await get(trx, user, id);
    const versions = await trx('la_agent_memory_versions').where({ memory_id: id }).orderBy('version', 'desc');
    const history = await trx('la_audit as a').leftJoin('la_users as u', 'u.id', 'a.actor_id').where('a.entity_id', id).where('a.action', 'like', 'agent.memory.%').select('a.action', 'a.details', 'a.created_at', 'u.display_name as actor').orderBy('a.created_at', 'desc').orderBy('a.id', 'desc');
    const source = row.source_id && await trx('la_agent_legal_events').where({ id: row.source_id }).first('source');
    const sourceQuotes = source?.source?.extractions?.find(e => e.memoryId === row.id)?.sourceQuotes || [];
    return { ...row, draft: versions.find(v => draftStates.includes(v.status))?.body || null, versions, history, sourceQuotes };
  });
}
async function create(db, actor, input) {
  const body = bodySchema.parse(input);
  const requested = z.string().trim().max(200).optional().parse(input.department);
  const department = hasRole(actor, 'admin') || actor.department === '*' ? requested ?? (actor.department === '*' ? '' : actor.department || '') : actor.department || '';
  if (department === '*') fail(400, 'MEMORY_DEPARTMENT', '请选择具体所属部门');
  return db.transaction(async trx => {
    const id = randomUUID();
    await trx('la_agent_memories').insert({ id, ...body, conditions: JSON.stringify(body.conditions), department, source_id: null, origin: 'manual', created_by: actor.id, fingerprint: fingerprint(body), state: 'draft', version: 0, draft_status: 'draft' });
    await trx('la_agent_memory_versions').insert({ id: randomUUID(), memory_id: id, version: 1, status: 'draft', body: JSON.stringify(body), created_by: actor.id });
    await audit(trx, actor, 'agent.memory.create', id, { department });
    return get(trx, actor, id);
  });
}
async function save(db, actor, id, input) {
  const body = bodySchema.parse(input), { revision } = revisionSchema.parse(input);
  return db.transaction(async trx => {
    const row = await get(trx, actor, id, true); assertRevision(row, revision);
    if (row.revoked_at || row.state === 'revoked') fail(409, 'AGENT_MEMORY_STATE', '来源已撤销，不能编辑或发布');
    if (row.draft_status === 'pending') fail(409, 'AGENT_MEMORY_STATE', '待审核内容已锁定，请先退回修改');
    if (row.is_system && body.kind !== 'skill') fail(409, 'AGENT_MEMORY_STATE', '请先切回审查技能，再修改知识类型');
    const draft = await trx('la_agent_memory_versions').where({ memory_id: id }).whereIn('status', draftStates).first();
    if (draft) await trx('la_agent_memory_versions').where({ id: draft.id }).update({ body: JSON.stringify(body), status: 'draft', updated_at: trx.fn.now() });
    else await trx('la_agent_memory_versions').insert({ id: randomUUID(), memory_id: id, version: row.version + 1, status: 'draft', body: JSON.stringify(body), created_by: actor.id });
    await trx('la_agent_memories').where({ id }).update({ draft_status: 'draft', revision: row.revision + 1, updated_at: trx.fn.now() });
    await audit(trx, actor, 'agent.memory.edit', id, { version: row.version + 1 });
    return get(trx, actor, id);
  });
}
async function invalidate(trx, ids) {
  if (!ids.length) return;
  // Same memory -> review lock order as final submission. Snapshots remain immutable.
  const runs = await trx('la_reviews').where({ engine: ENGINE }).where(function () {
    for (const id of ids) this.orWhereJsonSupersetOf('snapshot', { memoryIds: [id] });
  }).orderBy('id').forUpdate();
  for (const run of runs) {
    const affected = ids.filter(id => run.snapshot.memoryIds?.includes(id));
    await trx('la_reviews').where({ id: run.id }).update({ coverage: JSON.stringify({ ...run.coverage, complete: false, requiresRecheck: true, revokedMemoryIds: [...new Set([...(run.coverage.revokedMemoryIds || []), ...affected])] }) });
  }
}
async function change(db, actor, id, action, input) {
  const { revision } = revisionSchema.parse(input);
  const note = z.string().trim().max(3000).default('').parse(input.note);
  if (action === 'reject' && !note) fail(400, 'MEMORY_REVIEW_NOTE', '请填写退回原因');
  return db.transaction(async trx => {
    const row = await get(trx, actor, id, true); assertRevision(row, revision);
    const update = { revision: row.revision + 1, updated_at: trx.fn.now() };
    if (action !== 'delete' && (row.revoked_at || row.state === 'revoked')) fail(409, 'AGENT_MEMORY_STATE', '来源已撤销，不能操作该知识');
    if (['submit', 'approve', 'reject'].includes(action)) {
      const draft = await trx('la_agent_memory_versions').where({ memory_id: id }).whereIn('status', draftStates).first();
      if (!draft || (action === 'submit' ? !['draft', 'rejected'].includes(draft.status) : draft.status !== 'pending')) fail(409, 'AGENT_MEMORY_STATE', '审核状态已变化，请刷新后重试');
      const status = { submit: 'pending', approve: 'published', reject: 'rejected' }[action];
      await trx('la_agent_memory_versions').where({ id: draft.id }).update({ status, updated_at: trx.fn.now(), ...(action === 'submit' ? {} : { reviewed_by: actor.id, reviewed_at: trx.fn.now(), review_note: note }) });
      update.draft_status = action === 'approve' ? 'none' : status;
      if (action === 'approve') {
        if (row.source_id && await trx('la_agent_memories').where({ source_id: row.source_id, fingerprint: fingerprint(draft.body) }).whereNot({ id }).first()) fail(409, 'AGENT_MEMORY_DUPLICATE', '同一来源已存在相同内容的知识');
        Object.assign(update, bodySchema.parse(draft.body), { conditions: JSON.stringify(draft.body.conditions), version: draft.version, state: row.state === 'disabled' ? 'disabled' : 'active', fingerprint: fingerprint(draft.body) });
        await invalidate(trx, [id]);
      }
    } else if (action === 'promote' || action === 'demote') {
      if (row.kind !== 'skill' || !row.version || (action === 'promote' ? row.is_system || row.state !== 'active' || row.draft_status !== 'none' : !row.is_system)) fail(409, 'AGENT_MEMORY_STATE', '仅无待处理草稿的生效审查技能可设为系统技能；已有系统技能可切回审查技能');
      update.is_system = action === 'promote';
      await invalidate(trx, [id]);
    } else if (action === 'enable' || action === 'disable') {
      if (!row.version || row.state !== (action === 'enable' ? 'disabled' : 'active')) fail(409, 'AGENT_MEMORY_STATE', '仅已发布知识可启停，请刷新状态');
      update.state = action === 'enable' ? 'active' : 'disabled';
      if (action === 'disable') await invalidate(trx, [id]);
    } else if (action === 'delete') {
      await invalidate(trx, [id]);
      await trx('la_agent_memories').where({ id }).delete();
      await audit(trx, actor, 'agent.memory.delete', id, { version: row.version, department: row.department });
      return { ok: true };
    } else fail(400, 'AGENT_MEMORY_ACTION', '未知知识操作');
    await trx('la_agent_memories').where({ id }).update(update);
    await audit(trx, actor, 'agent.memory.' + action, id, { version: update.version ?? row.version, ...(['promote', 'demote'].includes(action) ? { from: row.is_system ? 'system' : 'skill', to: update.is_system ? 'system' : 'skill', department: row.department, sourceId: row.source_id } : {}), ...(note ? { note } : {}) });
    return get(trx, actor, id);
  });
}
async function addGenerated(trx, actor, source, department, body) {
  const fp = fingerprint(body), id = randomUUID();
  const added = await trx('la_agent_memories').insert({ id, ...bodyOf(body), conditions: JSON.stringify(body.conditions), source_id: source.id, department, origin: 'generated', created_by: actor.id, fingerprint: fp, state: 'draft', version: 0, draft_status: 'draft' }).onConflict(['source_id', 'fingerprint']).ignore().returning('id');
  if (!added.length) return;
  await trx('la_agent_memory_versions').insert({ id: randomUUID(), memory_id: id, version: 1, status: 'draft', body: JSON.stringify(bodyOf(body)), created_by: actor.id });
  await audit(trx, actor, 'agent.memory.create', id, { sourceId: source.id, origin: 'generated' });
  return id;
}
function mount(r, db) {
  const uuid = z.string().uuid();
  r.get('/agent/experiences', requireRole('legal'), wrap(async (req, res) => res.json(await list(db, req.user, req.query))));
  r.get('/agent/experiences/:id', requireRole('legal'), wrap(async (req, res) => res.json(await detail(db, req.user, uuid.parse(req.params.id)))));
  r.post('/agent/experiences', requireRole('legal'), wrap(async (req, res) => res.status(201).json(await create(db, req.user, req.body))));
  r.put('/agent/experiences/:id', requireRole('legal'), wrap(async (req, res) => res.json(await save(db, req.user, uuid.parse(req.params.id), req.body))));
  r.delete('/agent/experiences/:id', requireRole('legal'), wrap(async (req, res) => res.json(await change(db, req.user, uuid.parse(req.params.id), 'delete', req.body))));
  for (const action of ['submit', 'approve', 'reject', 'enable', 'disable', 'promote', 'demote']) r.post('/agent/experiences/:id/' + action, requireRole('legal'), wrap(async (req, res) => res.json(await change(db, req.user, uuid.parse(req.params.id), action, req.body))));
}
module.exports = { mount, list, detail, get, create, save, change, invalidate, addGenerated, bodySchema };
