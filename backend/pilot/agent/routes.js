const { z } = require('zod');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { wrap, fail } = require('../errors');
const { accessible, requireRole, assertRevision, audit, hasRole } = require('../auth');
const service = require('./service');
const { ENGINE, settings, publicSettings } = require('./config');
const uuid = z.string().uuid();
const { answerItems, validateAnswers, answerText } = require('./questions');
const messageInput = z.object({ content: z.string().trim().max(20000).default(''), clientKey: z.string().min(1).max(100), questionId: uuid.optional(), learn: z.boolean().optional(), answers: answerItems.optional() }).refine(input => input.content || input.answers, { message: '请填写消息或选择答案' });
function mount(r, db) {
  require('./evaluation').mount(r, db);
  r.post('/settings/agent/test', requireRole('admin'), wrap(async (_req, res) => res.json(await require('./probe').probeGateway(db))));
  r.get('/agent/capabilities', wrap(async (_req, res) => res.json(publicSettings(await settings(db)))));
  r.get('/agent/system-skills', requireRole('legal'), wrap(async (_req, res) => res.json({ skills: await require('./system-skills').catalog() })));
  r.post('/contracts/:id/agent-sessions', requireRole('business', 'legal'), wrap(async (req, res) => {
    const result = await db.transaction(async trx => {
      const c = await accessible(trx, req.user, uuid.parse(req.params.id), true);
      if (req.body.revision !== undefined) assertRevision(c, req.body.revision);
      const active = c.current_review_id && await trx('la_reviews').where({ id: c.current_review_id, engine: ENGINE }).whereIn('status', ['queued', 'running']).first();
      if (active) fail(409, 'AGENT_BUSY', '合同正在审查，请等待或先停止');
      return service.createSession(trx, c, req.user.id, { content: req.body.content ? z.string().trim().min(1).max(20000).parse(req.body.content) : undefined, clientKey: req.body.clientKey });
    }); res.status(202).json(result);
  }));
  r.get('/contracts/:id/agent-sessions', wrap(async (req, res) => {
    await accessible(db, req.user, uuid.parse(req.params.id));
    res.json(await db('la_agent_sessions').where({ contract_id: req.params.id }).select('id', 'version_id', 'status', 'current_review_id', 'created_at', 'updated_at').orderBy('created_at', 'desc'));
  }));
  r.get('/agent-sessions/:id', wrap(async (req, res) => {
    const s = await service.sessionFor(db, req.user, uuid.parse(req.params.id));
    const reviews = await db('la_reviews').where({ agent_session_id: s.id }).select('id', 'version_id', 'status', 'stage', 'coverage', 'error_code', 'error_message', 'created_at', 'agent_result').orderBy('created_at');
    const messages = await db('la_agent_messages').where({ session_id: s.id }).orderBy('created_at').orderBy('id');
    res.json({ ...s, manifest: { documents: s.manifest.documents }, reviews, messages });
  }));
  async function postMessage(req, res, answer = false) {
    const input = messageInput.parse(req.body);
    const result = await db.transaction(async trx => {
      const initial = await service.sessionFor(trx, req.user, uuid.parse(req.params.id));
      await accessible(trx, req.user, initial.contract_id, true);
      const s = await service.sessionFor(trx, req.user, initial.id, true);
      const duplicate = await trx('la_agent_messages').where({ session_id: s.id, client_key: input.clientKey }).first();
      if (duplicate) {
        const same = input.answers
          ? answer && duplicate.kind === 'answer' && duplicate.data?.questionId === input.questionId && isDeepStrictEqual(duplicate.data.submission, { answers: input.answers, content: input.content })
          : duplicate.content === input.content;
        if (!same) fail(409, 'IDEMPOTENCY_CONFLICT', '同一个请求标识不能用于不同内容');
        return { reviewId: duplicate.review_id, sessionId: s.id, duplicate: true };
      }
      let content = input.content, data = {};
      if (answer) {
        const question = await trx('la_agent_messages').where({ id: input.questionId, session_id: s.id, kind: 'question', review_id: s.current_review_id }).first();
        if (!question || s.status !== 'waiting_input') fail(409, 'AGENT_QUESTION_STALE', '问题已不是当前待答问题');
        if (input.answers) {
          if (!question.data?.questions?.length) fail(422, 'AGENT_ANSWER_INVALID', '本问题需要文字回答');
          const answers = validateAnswers(question.data.questions, input.answers);
          content = answerText(question.data.questions, answers, input.content);
          data = { questionId: question.id, answers, submission: { answers: input.answers, content: input.content } };
        }
      }
      if (input.answers && !answer) fail(422, 'AGENT_ANSWER_INVALID', '请选择当前待答问题后提交');
      if (!content || content.length > 20000) fail(422, 'AGENT_ANSWER_INVALID', '回答不能为空，且总长度不能超过20000字');
      // A revoked memory must not survive in a restored/compacted model context.
      const affected = s.current_review_id && await trx('la_reviews').where({ agent_session_id: s.id, id: s.current_review_id }).whereJsonSupersetOf('coverage', { requiresRecheck: true }).first();
      if (affected) { s.harness_id = null; await trx('la_agent_sessions').where({ id: s.id }).update({ harness_id: null, notes: '{}' }); }
      const value = await service.beginRun(trx, s, req.user.id, content, { clientKey: input.clientKey, kind: answer ? 'answer' : 'message', data });
      if (!value.duplicate && input.learn && hasRole(req.user, 'legal')) {
        await require('./memory').record(trx, req.user, { contractId: s.contract_id, reviewId: value.reviewId, kind: 'explicit_feedback', eventKey: 'message:' + s.id + ':' + input.clientKey, source: { text: content, isExplicitUserMessage: true } });
      }
      return value;
    }); res.status(202).json(result);
  }
  r.post('/agent-sessions/:id/messages', requireRole('business', 'legal'), wrap((req, res) => postMessage(req, res)));
  r.post('/agent-sessions/:id/answers', requireRole('business', 'legal'), wrap((req, res) => postMessage(req, res, true)));
  r.post('/agent-sessions/:id/cancel', requireRole('business', 'legal'), wrap(async (req, res) => {
    await db.transaction(async trx => {
      const initial = await service.sessionFor(trx, req.user, uuid.parse(req.params.id));
      await accessible(trx, req.user, initial.contract_id, true);
      const s = await service.sessionFor(trx, req.user, initial.id, true);
      const run = await trx('la_reviews').where({ id: s.current_review_id }).forUpdate().first();
      if (run && ['queued', 'running', 'waiting_input', 'failed'].includes(run.status)) {
        await trx('la_reviews').where({ id: run.id }).update({ status: 'cancelled', stage: 'cancelled', updated_at: trx.fn.now() });
        await trx('la_agent_sessions').where({ id: s.id }).update({ status: 'cancelled', updated_at: trx.fn.now() });
        await service.event(trx, s.id, run.id, 'cancelled', { message: '本轮已停止，工作保留，可继续' });
      }
    }); res.json({ ok: true });
  }));
  r.post('/agent-sessions/:id/resume', requireRole('business', 'legal'), wrap(async (req, res) => {
    req.body = { ...req.body, content: req.body.content || '请从已保存的材料和工作继续审查，完成后提交结果。', clientKey: req.body.clientKey || randomUUID() };
    return postMessage(req, res);
  }));
  r.get('/agent-sessions/:id/events', wrap(async (req, res) => {
    const s = await service.sessionFor(db, req.user, uuid.parse(req.params.id));
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    const events = await db('la_agent_events').where({ session_id: s.id }).where('id', '>', after).orderBy('id').limit(200);
    res.json({ events, cursor: events.at(-1)?.id || after });
  }));
  r.get('/agent-sessions/:id/results/:reviewId', wrap(async (req, res) => {
    const s = await service.sessionFor(db, req.user, uuid.parse(req.params.id));
    const run = await db('la_reviews').where({ id: uuid.parse(req.params.reviewId), agent_session_id: s.id }).first();
    if (!run) fail(404, 'REVIEW_NOT_FOUND', '结果版本不存在');
    res.json({ ...run, findings: await db('la_findings').where({ review_id: run.id }).orderBy('created_at').orderBy('id'), decision: await db('la_decisions').where({ review_id: run.id }).first() || null });
  }));
  r.post('/reviews/:id/annotated-version', requireRole('business', 'legal'), wrap(async (req, res) => {
    const mode = z.object({ mode: z.enum(['comments', 'color']).default('comments') }).parse(req.body || {}).mode;
    const result = await require('../annotated-versions').createAnnotatedVersion(db, { reviewId: uuid.parse(req.params.id), user: req.user, mode });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));
  require('./memory-management').mount(r, db);
  r.get('/agent/experience-sources/:id', requireRole('legal'), wrap(async (req, res) => {
    const source = await db('la_agent_legal_events').where({ id: uuid.parse(req.params.id) }).first();
    if (!source) fail(404, 'AGENT_MEMORY_SOURCE_NOT_FOUND', '经验来源不存在');
    const contract = await accessible(db, req.user, source.contract_id);
    // Detail access follows the same department boundary as the list.
    if (!hasRole(req.user, 'admin') && req.user.department !== '*' && (req.user.department || '') !== (contract.department || '')) fail(404, 'AGENT_MEMORY_SOURCE_NOT_FOUND', '经验来源不存在');
    const results = require('./memory-results');
    const [item] = await results.enrichSources(db, [{ ...source, contract_title: contract.title }]);
    const memories = await db('la_agent_memories').where({ source_id: source.id }).orderBy('created_at').select('id', 'kind', 'is_system', 'title', 'description', 'content', 'conditions', 'state', 'version', 'draft_status');
    res.json({ ...item, fields: results.sourceFields(source), memories: memories.map(m => ({ ...m, sourceQuotes: source.source.extractions?.find(e => e.memoryId === m.id)?.sourceQuotes || [] })) });
  }));
  r.post('/agent/experience-sources/:id/revoke', requireRole('legal'), wrap(async (req, res) => {
    await require('./memory').revoke(db, uuid.parse(req.params.id), req.user, z.string().trim().min(1).max(3000).parse(req.body.reason), z.number().int().min(1).parse(req.body.revision)); res.json({ ok: true });
  }));
  r.post('/agent/experience-sources/:id/retry', requireRole('legal'), wrap(async (req, res) => {
    await db.transaction(async trx => {
      const initial = await trx('la_agent_legal_events').where({ id: uuid.parse(req.params.id) }).first();
      if (!initial) fail(404, 'AGENT_MEMORY_SOURCE_NOT_FOUND', '经验来源不存在');
      const contract = await accessible(trx, req.user, initial.contract_id, true);
      if (!hasRole(req.user, 'admin') && req.user.department !== '*' && (req.user.department || '') !== (contract.department || '')) fail(404, 'AGENT_MEMORY_SOURCE_NOT_FOUND', '经验来源不存在');
      const source = await trx('la_agent_legal_events').where({ id: initial.id }).forUpdate().first();
      if (!source) fail(404, 'AGENT_MEMORY_SOURCE_NOT_FOUND', '经验来源不存在');
      await accessible(trx, req.user, source.contract_id);
      assertRevision(source, req.body.revision);
      if (source.revoked_at || source.status !== 'failed') fail(409, 'AGENT_MEMORY_STATE', '仅失败且未撤销的整理任务可重试');
      await trx('la_agent_legal_events').where({ id: source.id }).update({ status: 'queued', error: null, revision: source.revision + 1, updated_at: trx.fn.now() });
      await trx('la_outbox').insert({ id: randomUUID(), queue: 'agent-memory', payload: JSON.stringify({ sourceId: source.id }) });
    }); res.status(202).json({ ok: true });
  }));
  r.put('/settings/agent', requireRole('admin'), wrap(async (req, res) => {
    const v = z.object({ maxRequests: z.number().int().min(2).max(200), maxMinutes: z.number().int().min(1).max(120), contextWindow: z.number().int().min(8192).max(2000000), maxOutputTokens: z.number().int().min(1024).max(64000), thinkingFormat: z.enum(['openai', 'deepseek', 'qwen', 'qwen-chat-template', 'zai']), reasoning: z.boolean(), searchKey: z.string().max(1000).optional(), clearSearchKey: z.boolean().optional() }).parse(req.body);
    if (v.maxOutputTokens > v.contextWindow / 2) fail(400, 'AGENT_MODEL_CAPACITY', '输出上限不能超过上下文容量的一半');
    await require('../settings').updateSetting(db, 'agent', req.body.expectedUpdatedAt, prior => ({ ...prior, ...Object.fromEntries(Object.entries(v).filter(([k]) => !['searchKey', 'clearSearchKey'].includes(k))), ...(v.clearSearchKey ? { encryptedSearchKey: null } : v.searchKey ? { encryptedSearchKey: require('../model').encrypt(v.searchKey) } : {}) }));
    await audit(db, req.user, 'settings.agent', 'agent', { maxRequests: v.maxRequests, maxMinutes: v.maxMinutes });
    res.json(publicSettings(await settings(db)));
  }));
}
function retireLegacy(req, _res, next) {
  if (req.path === '/review-plan') return next(Object.assign(new Error('审查点选择已退役，上传后直接开始 Agent 审查。'), { status: 410, code: 'REVIEW_ENGINE_RETIRED' }));
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const p = req.path;
  if (/^\/(?:evaluation-cases|evaluations)(?:\/|$)/.test(p) || /^\/contracts\/[^/]+\/(?:skills|skill|learning|review-plan|review-setup)/.test(p) || /^\/feedback-cases\/[^/]+\/(?:rule-draft|knowledge-draft|evaluation-case)$/.test(p) || /^\/operations\/reviews\/[^/]+\/retry$/.test(p)) return next(Object.assign(new Error('旧审查与发布接口已退役，请使用 Agent 会话和风险证据评测。'), { status: 410, code: 'REVIEW_ENGINE_RETIRED' }));
  if (/^\/(?:rule-packs|rule-pack-versions|skill-packs|skill-pack-versions|skill-entries|skill-entry-versions|learning-tasks|learning-proposals|learning-settings|learning-reorganizations|classification-guidance|classification-guidance-versions|preanalyses|feedback-cases)(?:\/|$)/.test(p) || /^\/contracts\/[^/]+\/(?:preanalysis|classification)$/.test(p) || p === '/reviews' || /^\/reviews\/[^/]+\/cancel$/.test(p)) return next(Object.assign(new Error('旧审查、规则和经验发布流程已退役，请使用 Agent 审查会话。'), { status: 410, code: 'REVIEW_ENGINE_RETIRED' }));
  next();
}
module.exports = { mount, retireLegacy };
