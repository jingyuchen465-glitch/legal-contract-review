const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { fail } = require('../errors');
const { assertActive, event } = require('./service');
const { report: reportSchema, evidence, verifyEvidence, mergeRanges, rangeKey, coverage } = require('./schemas');
const { settings } = require('./config');
const sources = require('./official-sources');
const systemSkills = require('./system-skills');
const { capture, throwIssues } = require('../validation-issues');
const string = description => ({ type: 'string', description });
const integer = description => ({ type: 'integer', description });
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const toolDefinitions = [
  { name: 'list_documents', description: '查看本次固定版本的合同与全部附件、角色、段落数量及读取覆盖。', parameters: object({}) },
  { name: 'read_revision_baseline', description: '读取上轮完整意见、法务处理、已解决问题、用户背景与本次正文变化。返回JSON文本，按nextOffset读完；旧原文仅作对照，当前结论必须引用本次版本。', parameters: object({ offset: integer('JSON文本字符偏移，首次0，继续用nextOffset'), maxChars: integer('单次字符数，默认30000，最大60000') }) },
  { name: 'read_document', description: '按顺序读取原文。首次从blockIndex=0,charOffset=0开始，返回next则继续读取直到null。搜索不计作完整读取覆盖。', parameters: object({ versionId: string('材料目录中的文件版本ID'), blockIndex: integer('起始段落下标，默认0'), charOffset: integer('该段起始字符偏移，默认0'), maxChars: integer('单次最多字符，默认60000') }) },
  { name: 'search_documents', description: '在本次全部合同和附件中搜索原文关键词，返回原文证据与版本定位。', parameters: object({ query: string('关键词，非正则表达式') }) },
  { name: 'search_internal_laws', description: '搜索任务开始时固定的内部法律资料。效力未经实时核实，不能视为现行官方文本。', parameters: object({ query: string('法律名称或条文关键词') }) },
  { name: 'read_internal_law', description: '读取搜索命中的内部法律全文，支持offset分页。返回来源ID用于法律引用。', parameters: object({ id: string('搜索返回的法律ID'), offset: integer('正文起始字符，默认0') }) },
  { name: 'search_official_sources', description: '检索官方法律与司法资料，查询只包含必要法律概念，不发送合同全文或个案主体。返回摘要仅为线索，须进一步读取官网正文。', parameters: object({ query: string('法律名称、条号或法律问题') }) },
  { name: 'read_official_source', description: '读取政府/司法官方HTTPS网页或PDF并固定正文。支持sourceId与offset续读。来源未核实现行效力时必须写明限制。', parameters: object({ url: string('官方HTTPS地址，首次读取时提供'), sourceId: string('续读使用首次返回的来源ID'), offset: integer('正文字符偏移，默认0') }) },
  { name: 'search_memories', description: '检索新系统中由法务已保存处理形成的可复用经验；不会读取旧规则、旧经验或旧技能。', parameters: object({ query: string('业务条件或问题关键词') }) },
  { name: 'read_skill_resource', description: '读取本次skill引用的固定版本资源。系统技能包含必读references/examples.md；长期知识技能使用method。不能读取任意磁盘路径或执行脚本。', parameters: object({ skillName: string('技能名称'), resource: string('技能列出的资源标识') }) },
  { name: 'update_task_notes', description: '保存接续用审查笔记，不是跨合同长期记忆。保留目标、事实与证据、已检查事项和待办。', parameters: object({ notes: { type: 'object', properties: { goal: string('目标'), facts: { type: 'array', items: { type: 'object', properties: { text: string('事实'), evidence: { type: 'array', items: { type: 'object', properties: { versionId: string('版本'), blockId: string('原文段落'), quote: string('逐字原文') }, required: ['versionId', 'blockId', 'quote'], additionalProperties: false } } }, required: ['text', 'evidence'], additionalProperties: false } }, checked: { type: 'array', items: { type: 'string' } }, todo: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } }) },
  { name: 'generate_annotated_docx', description: '基于本会话最近一次已完成的审查，生成带 Word 原生批注的新合同版本。原正文不自动替换，原始文件保持不变；仅可靠定位的意见写入对应段落，无法定位的意见会在返回结果中列出。生成后新版本会进入重新预审流程。', parameters: object({ mode: { type: 'string', enum: ['comments'], description: '生成 Word 原生批注，合同正文保持不变' } }) },
  { name: 'request_information', description: '仅当缺少影响判断的信息时提问；合并必要问题。提供 questions 将问题呈现为可点选的卡片，支持单选、多选和其他文字回答。调用成功后结束本轮，等待用户确认回答。', parameters: object({ question: string('本次需要补充信息的简要说明'), questions: { type: 'array', description: '最多6个问题。可枚举的答案用options，不预选或猜测用户事实。', items: { type: 'object', properties: { id: string('本批次唯一的问题标识'), header: string('简短主题，如我方身份'), question: string('一个明确的问题'), detail: string('必要说明，可省略'), options: { type: 'array', items: { type: 'object', properties: { label: string('简短选项文本'), description: string('选项说明，可省略') }, required: ['label'], additionalProperties: false } }, multiSelect: { type: 'boolean', description: '是否允许多选，默认false' } }, required: ['id', 'question'], additionalProperties: false } } }) },
  { name: 'submit_review', description: '提交本轮完整审查结果，字段遵循工具提供的结构。默认在 suggestion 中提供批注和具体改法；findings[].edits[].newText（如有）仅供批注展示，自动流程不执行正文修订。没有可靠改法时保留具体建议及限制。引用本次固定版本的逐字原文；引用法律时提供已读取sourceId及legalEvidence.quote。自动批次需提供三类crossDocumentReview并明确scope，先保存候选报告再由本Agent复核内容并调用observe_review。有复核基线时revisionReview须完整对应上轮问题及当前风险，findingIndex从0开始。程序只校验协议及证据、定位完整性，不判断法律内容。失败按issues路径一次修正已列问题，保留其余已核实内容。', parameters: { ...object({ report: z.toJSONSchema(reportSchema, { io: 'input' }) }), required: ['report'] } },
];
async function createToolContext(db, reviewId, documents, options = {}) {
  let { run, session } = await assertActive(db, reviewId);
  const config = await settings(db), memories = run.snapshot.memories || [];
  const skills = [...new Map(memories.filter(m => m.kind === 'skill' && !m.is_system).map(m => [m.fingerprint, m])).values()].map(m => ({ name: 'legal-' + m.id, description: m.description, title: m.title, versionId: m.id, version: m.version, content: `# ${m.title}\n\n适用条件：${m.conditions.join('；') || '结合本案核实'}\n\n请使用 read_skill_resource({skillName:"legal-${m.id}",resource:"method"}) 读取固定版本审查方法。`, method: m.content }));
  const requiredSkills = systemSkills.forRun(run);
  skills.unshift(...requiredSkills);
  const context = { documents, skills, report: null, question: null, manifest: { sessionId: session.id, reviewId, background: run.snapshot.background, documents: documents.map(({ blocks, ...d }) => ({ ...d, blockCount: blocks.length })), notes: session.notes } };
  context.requiredSkills = requiredSkills;
  context.manifest.systemSkills = requiredSkills.map(({ name, title, versionId, version, requiredResources }) => ({ name, title, versionId, version, requiredResources, required: true }));
  const auto = run.snapshot.autoReviewBatchId ? require('../auto-review-tools') : null;
  if (auto) {
    skills.unshift(auto.skill);
    context.manifest.autoReviewBatchId = run.snapshot.autoReviewBatchId;
    context.manifest.unavailableDocuments = run.snapshot.unavailableDocuments || [];
    context.manifest.historyVersions = session.manifest.historyVersions || [];
    context.manifest.executionPlan = (await db('la_auto_review_batches').where({ id: run.snapshot.autoReviewBatchId }).first()).execution_plan;
  }
  context.toolDefinitions = auto ? [...toolDefinitions.filter(t => t.name !== 'generate_annotated_docx'), ...auto.definitions] : toolDefinitions;
  const baseline = run.snapshot.revisionBaseline;
  const changes = baseline ? await require('./revision-review').compareBaseline(db, baseline, documents, run.snapshot.background) : null;
  if (baseline) context.manifest.revisionReview = { baselineReviewId: baseline.reviewId, versionNo: baseline.versionNo, previousIssueCount: baseline.findings.length, changes: { ...changes, documents: changes.documents.map(({ edits, ...d }) => d) }, instruction: '本轮先复核上轮问题，再说明新增实质问题；使用 read_revision_baseline 读取完整基线与正文增删对照。' };
  const baselineText = baseline ? JSON.stringify({ ...baseline, changes }) : '';
  let tail = Promise.resolve();
  async function saveSource(source) {
    const row = { id: randomUUID(), review_id: reviewId, kind: source.kind || 'official', title: source.title, content: source.content, url: source.url || null, sha256: source.sha256, validity: source.validity || 'unverified' };
    await db('la_agent_sources').insert(row).onConflict(['review_id', 'sha256']).ignore();
    return db('la_agent_sources').where({ review_id: reviewId, sha256: row.sha256 }).first();
  }
  const sliceSource = (s, offset = 0) => ({ sourceId: s.id, title: s.title, url: s.url, validity: s.validity, sha256: s.sha256, fetchedAt: s.fetched_at, offset, content: s.content.slice(offset, offset + 40000), nextOffset: offset + 40000 < s.content.length ? offset + 40000 : null, limitation: '正文已固定；现行效力与适用日期仍须核验。' });
  async function perform(name, raw) {
    ({ run, session } = await assertActive(db, reviewId));
    if (['read_document', 'search_documents', 'create_review_plan', 'submit_review', 'observe_review'].includes(name)) await systemSkills.assertLoaded(db, run);
    if (auto) {
      const result = await auto.perform(db, run, name, raw, documents, context);
      if (result !== undefined) return result;
    }
    if (name === 'list_documents') return { documents: context.manifest.documents, coverage: coverage(documents, session.read_ranges) };
    if (name === 'read_revision_baseline') {
      const { offset, maxChars } = z.object({ offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(60000).default(30000) }).parse(raw || {});
      if (!baseline) return { available: false, message: '首次审查，没有上轮复核基线。' };
      if (offset >= baselineText.length) fail(422, 'AGENT_BASELINE_CURSOR', '复核基线游标无效，请从0读取。');
      const end = Math.min(baselineText.length, offset + maxChars);
      return { available: true, baselineReviewId: baseline.reviewId, offset, content: baselineText.slice(offset, end), nextOffset: end < baselineText.length ? end : null };
    }
    if (name === 'read_document') {
      const input = z.object({ versionId: z.string().uuid(), blockIndex: z.number().int().min(0).default(0), charOffset: z.number().int().min(0).default(0), maxChars: z.number().int().min(100).max(80000).default(60000) }).parse(raw);
      const d = documents.find(x => x.versionId === input.versionId); if (!d) fail(403, 'AGENT_DOCUMENT_SCOPE', '文件不属于本次审查');
      let i = input.blockIndex, offset = input.charOffset, budget = Math.min(input.maxChars, Math.max(4000, Math.floor(config.contextWindow / 2))), next = null;
      const blocks = [], read = [];
      if (i >= d.blocks.length || offset > d.blocks[i].text.length) fail(400, 'AGENT_READ_CURSOR', '原文读取游标无效');
      while (i < d.blocks.length && budget > 0) {
        const b = d.blocks[i], text = b.text.slice(offset, offset + budget);
        // Avoid cutting a surrogate pair at the end of a partial block.
        const valid = text.length && /[\uD800-\uDBFF]/u.test(text.at(-1)) ? text.slice(0, -1) : text;
        if (!valid.length && b.text.length) break;
        blocks.push({ ...b, text: valid, charOffset: offset, partial: offset > 0 || valid.length < b.text.length });
        read.push({ key: rangeKey(d.versionId, b.id), range: [offset, offset + valid.length] });
        budget -= valid.length;
        if (offset + valid.length < b.text.length) { offset += valid.length; break; }
        i++; offset = 0;
      }
      if (i < d.blocks.length) next = { versionId: d.versionId, blockIndex: i, charOffset: offset };
      await db.transaction(async trx => {
        const current = await trx('la_agent_sessions').where({ id: session.id }).forUpdate().first();
        const ranges = current.read_ranges;
        for (const r of read) ranges[r.key] = mergeRanges(ranges[r.key], r.range);
        await trx('la_agent_sessions').where({ id: session.id }).update({ read_ranges: JSON.stringify(ranges), updated_at: trx.fn.now() });
        await trx('la_reviews').where({ id: reviewId }).update({ coverage: JSON.stringify({ ...coverage(documents, ranges), complete: false }) });
      });
      return { versionId: d.versionId, filename: d.filename, blocks, next, warnings: d.warnings, requiresHumanVerification: d.requiresHumanVerification };
    }
    if (name === 'search_documents') {
      const { query } = z.object({ query: z.string().trim().min(1).max(200) }).parse(raw);
      return { matches: documents.flatMap(d => d.blocks.filter(b => b.text.toLowerCase().includes(query.toLowerCase())).map(b => ({ versionId: d.versionId, filename: d.filename, blockId: b.id, text: b.text.slice(0, 10000), page: b.page }))).slice(0, 30) };
    }
    if (name === 'search_internal_laws') {
      const { query } = z.object({ query: z.string().trim().min(1).max(200) }).parse(raw), words = query.split(/\s+/u);
      return { results: session.manifest.laws.map(l => ({ l, score: words.reduce((n, w) => n + (l.title.includes(w) ? 10 : 0) + (l.content.includes(w) ? 1 : 0), 0) })).filter(x => x.score).sort((a, b) => b.score - a.score).slice(0, 10).map(({ l }) => ({ id: l.id, title: l.title, validity: l.validity, snippet: l.content.slice(Math.max(0, l.content.indexOf(words[0]) - 100), Math.max(0, l.content.indexOf(words[0]) - 100) + 800) })) };
    }
    if (name === 'read_internal_law') {
      const input = z.object({ id: z.string(), offset: z.number().int().min(0).default(0) }).parse(raw);
      const law = session.manifest.laws.find(x => x.id === input.id); if (!law) fail(403, 'AGENT_LAW_SCOPE', '法律资料不在本次固定目录');
      return sliceSource(await saveSource(law), input.offset);
    }
    if (name === 'search_official_sources') {
      const { query } = z.object({ query: z.string().trim().min(1).max(500) }).parse(raw);
      const entity = run.snapshot.background.ourEntity;
      if (entity && entity.length > 3 && query.includes(entity)) fail(400, 'OFFICIAL_QUERY_PRIVATE', '检索词只应包含法律概念，不包含个案主体');
      return sources.searchOfficial(query, config.searchKey, options.searchOptions);
    }
    if (name === 'read_official_source') {
      const input = z.object({ url: z.string().url().optional(), sourceId: z.string().uuid().optional(), offset: z.number().int().min(0).default(0) }).parse(raw);
      let row;
      if (input.sourceId) row = await db('la_agent_sources as s').join('la_reviews as r', 'r.id', 's.review_id').where({ 's.id': input.sourceId, 'r.agent_session_id': session.id }).select('s.*').first();
      else if (input.url) row = await saveSource(await (options.readOfficial || sources.readOfficial)(input.url));
      if (!row) fail(403, 'AGENT_SOURCE_SCOPE', '官方资料不属于本轮读取记录或未提供地址');
      return sliceSource(row, input.offset);
    }
    if (name === 'search_memories') {
      const { query } = z.object({ query: z.string().trim().min(1).max(200) }).parse(raw), words = query.split(/\s+/u);
      return { memories: memories.map(m => ({ m, score: words.reduce((n, w) => n + (m.title + m.description + m.content).includes(w), 0) })).filter(x => x.score).sort((a, b) => b.score - a.score).slice(0, 12).map(({ m }) => ({ id: m.id, title: m.title, kind: m.kind, description: m.description, conditions: m.conditions, ...(m.kind === 'skill' ? { skillName: 'legal-' + m.id } : { content: m.content }), version: m.version, sourceId: m.source_id })) };
    }
    if (name === 'read_skill_resource') {
      const { skillName, resource } = z.object({ skillName: z.string(), resource: z.string().min(1).max(200) }).parse(raw);
      const s = skills.find(x => x.name === skillName); if (!s) fail(403, 'AGENT_SKILL_SCOPE', '技能不属于本次固定目录');
      const content = s.resources && Object.hasOwn(s.resources, resource) ? s.resources[resource] : resource === 'method' ? s.method : undefined;
      if (typeof content !== 'string') fail(403, 'AGENT_SKILL_RESOURCE', '资源不属于本次固定技能');
      await recordSkillEvent('skill_resource_read', { name: s.name, resource, versionId: s.versionId, category: s.category || 'memory', message: `已读取${s.title || s.name}的${s.required ? '必读范例' : '审查方法'}` });
      return { skillName, resource, versionId: s.versionId, version: s.version, content };
    }
    if (name === 'update_task_notes') {
      const { notes } = z.object({ notes: z.object({ goal: z.string().max(4000).optional(), facts: z.array(z.object({ text: z.string().max(2000), evidence: z.array(evidence).max(10) })).max(80).optional(), checked: z.array(z.string().max(1000)).max(200).optional(), todo: z.array(z.string().max(1000)).max(100).optional() }) }).parse(raw);
      for (const f of notes.facts || []) f.evidence = verifyEvidence(f.evidence, documents);
      await db('la_agent_sessions').where({ id: session.id }).update({ notes: JSON.stringify({ ...session.notes, ...notes }), updated_at: db.fn.now() });
      return { saved: true };
    }
    if (name === 'generate_annotated_docx') {
      const input = z.object({ mode: z.enum(['comments']).default('comments') }).parse(raw || {});
      const previous = await db('la_reviews').where({ agent_session_id: session.id, status: 'completed', engine: 'harness-v1' })
        .whereNot('id', reviewId).whereNotNull('agent_result').orderBy('created_at', 'desc').first();
      if (!previous) fail(409, 'ANNOTATION_REVIEW_REQUIRED', '请先完成一次合同审查，再生成批注建议稿');
      const result = await require('../annotated-versions').createAnnotatedVersion(db, { reviewId: previous.id, actorId: run.created_by, mode: input.mode });
      context.generatedVersion = { ...result, sourceReviewId: previous.id };
      return context.generatedVersion;
    }
    if (name === 'request_information') {
      const { question, questions } = require('./questions').informationRequest.parse(raw);
      if (auto) return { deferred: true, next: '本批次自动评审不停下来等逐条确认。将缺失信息列入uncertain及limitations，不编造事实，继续可完成的核查。', missingInformation: question };
      const old = await db('la_agent_messages').where({ review_id: reviewId, kind: 'question' }).first();
      context.question = old || (await db('la_agent_messages').insert({ id: randomUUID(), session_id: session.id, review_id: reviewId, role: 'assistant', kind: 'question', content: question, data: JSON.stringify(questions ? { questions } : {}) }).returning('*'))[0];
      return { questionId: context.question.id, question: context.question.content, ...(context.question.data?.questions ? { questions: context.question.data.questions } : {}), next: '结束本轮并等待法务回答；用户确认回答后会恢复会话。' };
    }
    if (name === 'submit_review') {
      if (context.question) fail(409, 'AGENT_AWAITING_ANSWER', '本轮已经请求补充信息，请等待用户回答后继续');
      const value = reportSchema.parse(raw.report), read = coverage(documents, session.read_ranges);
      if (!read.complete) fail(422, 'AGENT_DOCUMENT_UNREAD', `仍有 ${read.unreadBlocks.length} 段原文未完整读取；请调用 list_documents 查看覆盖并继续 read_document`);
      if (new Set(value.reviewedVersionIds).size !== documents.length || documents.some(d => !value.reviewedVersionIds.includes(d.versionId))) fail(422, 'AGENT_DOCUMENT_COVERAGE', '结果必须明确覆盖本次全部固定文件版本');
      const legal = await db('la_agent_sources as s').join('la_reviews as r', 'r.id', 's.review_id').where('r.agent_session_id', session.id).select('s.*');
      const issues = [];
      for (const [index, f] of value.findings.entries()) {
        const path = `findings.${index}`;
        capture(issues, path + '.evidence', () => { f.evidence = verifyEvidence(f.evidence, documents); });
        capture(issues, path + '.kind', () => {
          if (f.kind === 'clause' && !f.evidence.length) fail(422, 'AGENT_EVIDENCE_REQUIRED', '条款判断需要逐字原文证据');
          if (f.kind === 'missing' && (f.evidence.length || f.status === 'pass')) fail(422, 'AGENT_INVALID_MISSING', '缺失条款不能带虚构原文或标记符合');
          if (f.kind === 'uncertain' && f.status !== 'uncertain') fail(422, 'AGENT_INVALID_UNCERTAIN', '无法判断项需明确标记uncertain');
        });
        // Content quality belongs to the Agent's review, not phrase matching.
        // Exact edits may carry all wording while suggestion is a short note.
        capture(issues, path + '.suggestion', () => {
          if (f.status === 'fail' && !f.suggestion.trim() && !f.edits?.length) fail(422, 'AGENT_SUGGESTION_REQUIRED', '风险项须提供非空处理建议或结构化 edits；正文可只放在 edits.newText，删除使用 delete');
        });
        for (const [sourceIndex, id] of f.legalSourceIds.entries()) capture(issues, path + `.legalSourceIds.${sourceIndex}`, () => {
          const s = legal.find(x => x.id === id);
          if (!s) fail(422, 'AGENT_LEGAL_SOURCE', '法律引用未在本轮获取正文');
          if (!f.legalEvidence?.some(e => e.sourceId === id && s.content.includes(e.quote))) fail(422, 'AGENT_LEGAL_QUOTE', '法律引用需提供legalEvidence:[{sourceId,quote}]逐字正文');
        });
      }
      capture(issues, 'revisionReview', () => require('./revision-review').validateRevisionReview(value, baseline, documents, changes));
      if (auto) await auto.validateReport(db, run, value, documents, issues);
      else {
        require('../report-edits').validateEdits(value, documents, issues);
        throwIssues(issues);
      }
      const failedSources = await db('la_agent_tool_calls').where({ review_id: reviewId }).whereIn('name', ['search_official_sources', 'read_official_source']);
      const sourceLimits = failedSources.flatMap(call => call.result?.error ? ['本轮官方资料核验遇到限制：' + call.result.message] : call.result?.available === false ? [call.result.limitation] : []);
      value.limitations = [...new Set([
        ...value.limitations,
        ...(!config.searchKey ? ['官方来源搜索服务未配置；已知官网链接可读取，但未进行完整联网检索。'] : []),
        ...sourceLimits,
        ...documents.flatMap(d => d.warnings.map(w => `${d.filename}：${w}`)),
        ...legal.filter(s => value.findings.some(f => f.legalSourceIds.includes(s.id)) && s.validity !== 'verified').map(s => `${s.title}：来源正文已固定，现行效力与适用日期尚需核实。`),
      ].filter(Boolean))];
      await db('la_reviews').where({ id: reviewId }).update({ agent_result: JSON.stringify(value), updated_at: db.fn.now() });
      context.report = auto ? null : value;
      if (auto) return { candidateSaved: true, next: '候选报告已保存；自动输出为批注建议稿，合同正文保持不变。程序只校验协议、证据及建议定位，不判断建议的法律含义或可用性。请逐项核对 edits.newText 是可直接使用的条款（delete 除外）、商务条件有依据、批注与正文分开、没有遗漏及跨条款/附件冲突；调用observe_review记录复核，发现问题先纠正。' };
      return { submitted: true, findingCount: value.findings.length, next: '已保存本轮结果，结束本轮。法务可继续追问或确认结论。' };
    }
    fail(403, 'AGENT_TOOL_NOT_ALLOWED', '该工具未注册到法务审查');
  }
  context.execute = (name, args, callId = randomUUID()) => {
    const operation = tail.then(async () => {
      await assertActive(db, reviewId);
      if (auto && !context.toolDefinitions.some(t => t.name === name)) fail(403, 'AGENT_TOOL_NOT_ALLOWED', '自动批次不允许此工具');
      const argsHash = sources.hash(JSON.stringify({ name, args }));
      const cached = await db('la_agent_tool_calls').where({ review_id: reviewId, call_id: callId }).first();
      if (cached && (cached.name !== name || cached.args_hash !== argsHash)) fail(409, 'AGENT_TOOL_REPLAY_CONFLICT', '工具调用标识与原请求不一致');
      if (cached?.status === 'completed') {
        if (['submit_review', 'observe_review'].includes(name) && cached.result.submitted) context.report = (await db('la_reviews').where({ id: reviewId }).first()).agent_result;
        return cached.result;
      }
      if (!cached) await db('la_agent_tool_calls').insert({ id: randomUUID(), review_id: reviewId, call_id: callId, name, args_hash: argsHash, status: 'running' });
      let result;
      try { result = await perform(name, args); }
      catch (e) { result = { error: e.code || (e.name === 'ZodError' ? 'TOOL_INPUT_INVALID' : 'TOOL_FAILED'), message: e.name === 'ZodError' ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 3000) : e.code ? e.message : '工具暂时不可用，请保留限制或补充资料后重试。', ...(e.name === 'ZodError' ? { issues: e.issues.map(i => ({ path: i.path.join('.'), code: i.code, message: i.message })) } : e.issues ? { issues: e.issues } : {}) }; }
      await db('la_agent_tool_calls').where({ review_id: reviewId, call_id: callId }).update({ status: 'completed', result: JSON.stringify(result), updated_at: db.fn.now() });
      await options.notify?.('tool', { name, callId, ok: !result.error, message: result.error ? result.message : name === 'submit_review' ? '已提交审查意见' : name === 'request_information' ? '等待补充信息' : name === 'generate_annotated_docx' ? '已生成批注建议稿并建立新版本' : '已完成资料操作' });
      return result;
    });
    tail = operation.catch(() => {}); return operation;
  };
  async function recordSkillEvent(type, data) {
    if (options.notify) await options.notify(type, data);
    else await event(db, session.id, reviewId, type, data);
  }
  context.recordSkillLoaded = async (name, versionId, mode = 'skill_tool') => {
    await assertActive(db, reviewId);
    const skill = skills.find(s => s.name === name && s.versionId === versionId);
    if (!skill) fail(403, 'AGENT_SKILL_SCOPE', '技能版本不属于本次固定目录');
    await recordSkillEvent('skill_loaded', { name, title: skill.title, versionId, category: skill.category || 'memory', required: !!skill.required, mode, message: `已加载${skill.required ? '必读系统技能' : '审查技能'}：${skill.title || name}` });
    return skill;
  };
  context.prepareRequiredSkills = async () => {
    for (const skill of requiredSkills) {
      await context.recordSkillLoaded(skill.name, skill.versionId, 'required_preload');
      for (const resource of skill.requiredResources) {
        const result = await context.execute('read_skill_resource', { skillName: skill.name, resource });
        if (result.error) fail(503, result.error, result.message);
      }
    }
  };
  return context;
}
module.exports = { toolDefinitions, createToolContext };
