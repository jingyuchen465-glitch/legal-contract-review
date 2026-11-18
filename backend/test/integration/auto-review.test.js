const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const supertest = require('supertest'), AdmZip = require('adm-zip');
const { config } = require('../../pilot/config'), { createDb } = require('../../pilot/db');
const { migrate } = require('../../pilot/cli'), { hashPassword } = require('../../pilot/auth'), { createApp } = require('../../pilot/app');
const batches = require('../../pilot/auto-review-batch'), service = require('../../pilot/agent/service');
let root, db, app, agent, outsider, csrf, user, database;
function docx(text) {
  const z = new AdmZip();
  z.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  // Stable archive bytes keep idempotency independent of ZIP timestamps.
  z.getEntry('word/document.xml').header.time = new Date('2026-01-01T00:00:00Z');
  return z.toBuffer();
}
const req = (method, url, body) => { const r = agent[method]('/api' + url).set('X-CSRF-Token', csrf); return body ? r.send(body) : r; };
const upload = (key = randomUUID(), text = '采购合同：交付日期另议。') => req('post', '/auto-review-batches').field('clientKey', key).attach('files', docx(text), '合同.docx').attach('files[]', docx('补充协议：甲乙双方约定付款日期另议。'), '补充.docx');
before(async () => {
  root = createDb(); database = 'legal_auto_' + randomUUID().replaceAll('-', ''); await root.raw(`CREATE DATABASE "${database}"`);
  const url = new URL(config.databaseUrl); url.pathname = '/' + database; config.databaseUrl = url.href;
  config.dataRoot = path.resolve(process.env.AUTO_REVIEW_TEST_DATA_ROOT || '.local/test-data', database); config.model = { ...config.model, key: '', baseUrl: '', name: '' };
  db = createDb(); await migrate(db); await require('../../pilot/storage').initializeDirectories(); app = createApp(db);
  for (const name of ['legal', 'outsider']) {
    const actor = { id: randomUUID(), username: name, display_name: name, department: name, roles: [name === 'legal' ? 'admin' : 'business'], password_hash: await hashPassword('auto-review-test-password') };
    await db('la_users').insert({ ...actor, roles: JSON.stringify(actor.roles) });
    const a = supertest.agent(app.app), s = await a.get('/api/auth/session');
    const login = await a.post('/api/auth/login').set('X-CSRF-Token', s.body.csrf).send({ username: name, password: 'auto-review-test-password' }).expect(200);
    if (name === 'legal') { agent = a; csrf = login.body.csrf; user = actor; } else outsider = a;
  }
});
after(async () => { await app?.close(); await db?.destroy(); if (root && database) { await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]); await root.raw(`DROP DATABASE "${database}"`); } await root?.destroy(); });
async function plan(context, documents, run) {
  const value = { goal: '核查全部材料及跨文件约定', documents: documents.map(d => ({ versionId: d.versionId, role: 'uncertain', confidence: 0.5, reason: '交易关系待核实', evidence: [] })), steps: [{ id: 'review', title: '逐份阅读并核查金额、期限、补充条款和优先顺序', versionIds: documents.map(d => d.versionId) }], skillNames: ['legal-auto-review'] };
  assert.equal((await context.execute('create_review_plan', { plan: value }, randomUUID())).error, 'AUTO_SKILL_REQUIRED');
  await service.event(db, run.agent_session_id, run.id, 'skill_loaded', { name: 'legal-auto-review', versionId: require('../../pilot/auto-review-tools').skill.versionId });
  assert.equal((await context.execute('create_review_plan', { plan: value }, randomUUID())).saved, true);
}
function report(documents) {
  return { summary: '交付和付款日期需要明确，文件适用顺序待核实。', reviewedVersionIds: documents.map(d => d.versionId), limitations: ['工程测试，非真实法律结论'],
    crossDocumentReview: ['amendments', 'amounts_terms', 'precedence'].map(category => ({ category, status: 'uncertain', reason: '合同间关系需要双方确认', evidence: documents.map(d => ({ versionId: d.versionId, blockId: d.blocks[0].id, quote: d.blocks[0].text })) })),
    findings: documents.map(d => ({ title: '期限需要明确：' + d.filename, status: 'fail', kind: 'clause', severity: 'high', reason: '未约定明确日期', suggestion: '条款正文：乙方应于2026年12月1日前交付，甲方应于验收后十日付款。', evidence: [{ versionId: d.versionId, blockId: d.blocks[0].id, quote: d.blocks[0].text }], edits: [{ versionId: d.versionId, blockId: d.blocks[0].id, originalText: d.blocks[0].text, newText: '乙方应于2026年12月1日前交付，甲方应于验收后十日付款。', operation: 'replace', reason: '明确日期' }] })) };
}

async function processCheckedBatch(database, id, options) {
  let failure;
  await batches.processBatch(database, id, { ...options, runtimeFactory: async input => {
    const runtime = await options.runtimeFactory(input);
    return { ...runtime, async run(...args) {
      try { return await runtime.run(...args); } catch (e) { failure = e; throw e; }
    } };
  } });
  if (failure) throw failure;
}

test('structured replacement text and deletion do not require duplicated clause wording in suggestions', async () => {
  const batch = (await upload().expect(202)).body;
  await processCheckedBatch(db, batch.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await plan(context, documents, run);
    const value = report(documents);
    value.findings[0].suggestion = '按下文替换。批注：确认交付安排。';
    value.findings[0].edits[0].newText = '供方应于收到采购方订单之日起十日内交付全部货物。';
    value.findings[1].suggestion = '';
    value.findings[1].edits[0].operation = 'delete';
    value.findings[1].edits[0].newText = '';
    const result = await context.execute('submit_review', { report: value }, randomUUID());
    assert.equal(result.candidateSaved, true, JSON.stringify(result));
    assert.equal((await context.execute('observe_review', { summary: '复核改稿及删除依据', remainingIssues: [] }, randomUUID())).submitted, true);
    return {};
  }, async close() {} }) });
  const detail = (await req('get', '/auto-review-batches/' + batch.id).expect(200)).body;
  assert.equal(detail.review.status, 'completed');
  const comments = detail.artifacts.filter(a => a.kind === 'annotated_comments'); assert.equal(comments.length, 2); assert.ok(comments.every(a => a.status === 'ready'));
  const downloadable = detail.artifacts.find(a => a.kind === 'report');
  const exported = await req('get', downloadable.downloadUrl.replace('/api', '')).expect(200);
  assert.match(exported.text, /供方应于收到采购方订单之日起十日内交付全部货物。/);
  assert.match(exported.text, /删除该段正文/);
});

test('report submissions accept wording without role keywords but still reject empty advice', async () => {
  const batch = (await upload().expect(202)).body;
  await processCheckedBatch(db, batch.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await plan(context, documents, run);
    const value = report(documents);
    for (const f of value.findings) { delete f.edits; f.suggestion = '供方应于收到采购方订单之日起十日内交付全部货物。'; }
    const empty = structuredClone(value); empty.findings[0].suggestion = '  ';
    assert.equal((await context.execute('submit_review', { report: empty }, randomUUID())).error, 'AGENT_SUGGESTION_REQUIRED');
    const result = await context.execute('submit_review', { report: value }, randomUUID());
    assert.equal(result.candidateSaved, true, JSON.stringify(result));
    return {};
  }, async close() {} }) });
});

test('a single uploaded document may contain conflicting contract and embedded appendix clauses', async () => {
  const batch = (await req('post', '/auto-review-batches').attach('files', docx('合同正文与内嵌附件的保修期限不一致。'), '含附件合同.docx').expect(202)).body;
  await processCheckedBatch(db, batch.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await plan(context, documents, run);
    const value = report(documents); value.crossDocumentReview[0].status = 'conflict';
    const result = await context.execute('submit_review', { report: value }, randomUUID());
    assert.equal(result.candidateSaved, true, JSON.stringify(result));
    const noEvidence = structuredClone(value); noEvidence.crossDocumentReview[0].evidence = [];
    assert.equal((await context.execute('submit_review', { report: noEvidence }, randomUUID())).error, 'AUTO_CROSS_EVIDENCE');
    return {};
  }, async close() {} }) });
});

test('one submission reports independent evidence, cross-document and edit errors with exact paths', async () => {
  const batch = (await upload().expect(202)).body;
  await processCheckedBatch(db, batch.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await plan(context, documents, run);
    const value = report(documents);
    value.findings[0].evidence[0].quote = '并不存在的原文';
    value.findings[1].edits[0].blockId = 'missing-block';
    value.crossDocumentReview[0].status = 'conflict';
    value.crossDocumentReview[0].evidence = value.crossDocumentReview[0].evidence.slice(0, 1);
    const result = await context.execute('submit_review', { report: value }, randomUUID());
    assert.equal(result.error, 'AGENT_INVALID_EVIDENCE');
    assert.ok(result.issues?.some(i => i.path === 'findings.0.evidence' && i.code === 'AGENT_INVALID_EVIDENCE'), JSON.stringify(result));
    assert.ok(result.issues.some(i => i.path === 'crossDocumentReview.0.evidence' && i.code === 'AUTO_CROSS_EVIDENCE'));
    assert.ok(result.issues.some(i => i.path === 'findings.1.edits.0' && i.code === 'AUTO_EDIT_EVIDENCE'));
    assert.ok(result.issues.some(i => i.path.startsWith('findings.1.edits.') && i.code === 'INVALID_EVIDENCE'));
    assert.equal((await db('la_reviews').where({ id: run.id }).first()).agent_result, null);
    return {};
  }, async close() {} }) });
});

test('multi-file batches permit within-document comparisons and justified non-applicable relationships', async () => {
  const batch = (await upload().expect(202)).body;
  await processCheckedBatch(db, batch.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await plan(context, documents, run);
    const value = report(documents);
    value.crossDocumentReview[0] = { ...value.crossDocumentReview[0], scope: 'within_document', status: 'conflict', evidence: value.crossDocumentReview[0].evidence.slice(0, 1) };
    value.crossDocumentReview[1] = { ...value.crossDocumentReview[1], scope: 'not_applicable', status: 'not_applicable', reason: '本组材料没有相应的金额衔接事项。', evidence: [] };
    assert.equal((await context.execute('submit_review', { report: value }, randomUUID())).candidateSaved, true);
    const invalid = structuredClone(value); invalid.crossDocumentReview[0].scope = 'across_documents';
    const rejected = await context.execute('submit_review', { report: invalid }, randomUUID());
    assert.equal(rejected.error, 'AUTO_CROSS_EVIDENCE');
    assert.ok(rejected.issues.some(i => i.path === 'crossDocumentReview.0.evidence'));
    return {};
  }, async close() {} }) });
});
const complete = async ({ context, documents, run }) => ({ async run() {
  assert.ok(context.skills.some(s => s.name === 'legal-auto-review'));
  assert.equal((await context.execute('submit_review', { report: report(documents) }, randomUUID())).error, 'AGENT_DOCUMENT_UNREAD');
  for (const d of documents) { let cursor = { versionId: d.versionId }; do { const r = await context.execute('read_document', cursor, randomUUID()); assert.ok(!r.error, r.message); cursor = r.next; } while (cursor); }
  assert.equal((await context.execute('submit_review', { report: report(documents) }, randomUUID())).error, 'AUTO_PLAN_REQUIRED');
  await plan(context, documents, run);
  const bad = report(documents); bad.crossDocumentReview[0].status = 'conflict'; bad.crossDocumentReview[0].evidence = bad.crossDocumentReview[0].evidence.slice(0,1);
  assert.equal((await context.execute('submit_review', { report: bad }, randomUUID())).error, 'AUTO_CROSS_EVIDENCE');
  const invalid = report(documents); invalid.findings[0].edits[0].newText = '';
  assert.equal((await context.execute('submit_review', { report: invalid }, randomUUID())).error, 'INVALID_EDIT_TEXT');
  const r = await context.execute('submit_review', { report: report(documents) }, 'submit'); assert.equal(r.candidateSaved, true, r.message); assert.equal(r.submitted, undefined);
  assert.equal((await context.execute('submit_review', { report: report(documents) }, 'submit')).candidateSaved, true);
  assert.equal((await context.execute('observe_review', { summary: '发现尚需纠正', remainingIssues: ['需再次核查期限'] }, randomUUID())).requiresCorrection, true);
  assert.equal((await context.execute('observe_review', { summary: '已复查所有文件、证据和不确定事项', remainingIssues: [] }, 'observe')).submitted, true);
  assert.equal((await context.execute('observe_review', { summary: '已复查所有文件、证据和不确定事项', remainingIssues: [] }, 'observe')).submitted, true);
  return {};
}, async close() {} });
test('manual multipart accepts files and files[], validates idempotency, deduplicates and denies foreign access', async () => {
  const key = randomUUID(), a = (await upload(key).expect(202)).body, b = (await upload(key).expect(202)).body;
  assert.equal(a.id, b.id); assert.equal(a.documents.length, 2); assert.equal(a.source, 'manual');
  await upload(key, '不同合同').expect(409);
  const same = (await req('post', '/auto-review-batches').attach('files', docx('相同内容'), '一.docx').attach('files', docx('相同内容'), '二.docx').expect(202)).body; assert.equal(same.documents.length, 1);
  await req('post', '/auto-review-batches', {}).expect(400);
  let tooMany = req('post', '/auto-review-batches'); for (let n = 0; n < 21; n++) tooMany = tooMany.attach('files', docx('文件' + n), n + '.docx'); await tooMany.expect(413);
  await outsider.get('/api/auto-review-batches/' + a.id).expect(404); assert.equal((await outsider.get('/api/auto-review-batches').expect(200)).body.length, 0);
  assert.equal((await db('la_outbox').where({ queue: 'agent-review' }).whereRaw("payload->>'reviewId' IN (SELECT id::text FROM la_reviews WHERE contract_id = ?)", [a.documents[0].contract_id])).length, 0);
});
test('Harness plans, corrects, observes and creates immutable comment copies and downloadable report', async () => {
  const batch = (await upload().expect(202)).body;
  await batches.processBatch(db, batch.id, { runtimeFactory: complete });
  const b = (await req('get', '/auto-review-batches/' + batch.id).expect(200)).body;
  assert.equal(b.status, 'completed', JSON.stringify(b)); assert.equal(b.executionPlan.reviewId, b.main_review_id); assert.equal(b.qualityGate.evidenceValidated, true);
  assert.equal(b.artifacts.length, 3); assert.deepEqual(b.activity.filter(e => e.type === 'skill_loaded').map(e => e.data.name).sort(), ['legal-auto-review', 'legal-practical-redline']);
  assert.ok(b.executionPlan.skillNames.includes('legal-practical-redline'));
  assert.equal(b.skills.find(s => s.name === 'legal-practical-redline').title, '法务实务审改');
  for (const d of b.documents) assert.equal((await db('la_contracts').where({ id: d.contract_id }).first()).current_version_id, d.version_id);
  for (const a of b.artifacts) {
    const response = await req('get', a.downloadUrl.replace('/api', '')).expect(200);
    if (a.kind === 'report') { assert.match(response.text, /交付和付款/); continue; }
    const bytes = await require('../../pilot/storage').read((await db('la_versions').where({ id: a.version_id }).first()).storage_key);
    assert.equal(a.kind, 'annotated_comments'); assert.equal(a.details.outputMode, 'comments_only'); assert.equal(a.details.editCount, 0);
    const zip = new AdmZip(bytes), original = await db('la_versions').where({ id:a.source_version_id }).first();
    const originalBytes = await require('../../pilot/storage').read(original.storage_key);
    assert.doesNotMatch(zip.readAsText('word/document.xml'), /<w:(?:ins|del)\b/);
    assert.match(zip.readAsText('word/comments.xml'), /未约定明确日期/);
    assert.deepEqual(require('../../pilot/parser').parseDocx(bytes).blocks.map(b=>b.text), require('../../pilot/parser').parseDocx(originalBytes).blocks.map(b=>b.text));
    assert.equal(require('../../pilot/storage').sha256(originalBytes), original.sha256);
    assert.equal(a.locatedFindingIds.length, 1); assert.equal(a.unlocatedFindingIds.length, 0);
    await outsider.get(a.downloadUrl).expect(404);
  }
  await batches.processBatch(db, b.id, { runtimeFactory: () => { throw Error('completed replay'); } });
  assert.equal((await db('la_auto_review_artifacts').where({ batch_id: b.id })).length, 3);
  // Worker died after publishing files but before marking the batch completed.
  await db('la_auto_review_batches').where({id:b.id}).update({status:'drafting',stage:'drafting'});
  const versionsBefore=Number((await db('la_versions').count('* as n').first()).n);
  await batches.recover(db);await batches.processBatch(db,b.id,{runtimeFactory:()=>{throw Error('artifact replay called model');}});
  assert.equal(Number((await db('la_versions').count('* as n').first()).n),versionsBefore);
  assert.equal((await db('la_auto_review_artifacts').where({batch_id:b.id})).length,3);
});
test('comment copies open in the editor and save as descendants without overwriting originals or accepting stale copies', async () => {
  const batch = (await upload().expect(202)).body;
  await batches.processBatch(db, batch.id, { runtimeFactory: complete });
  const b = (await req('get', '/auto-review-batches/' + batch.id).expect(200)).body;
  const artifacts = b.artifacts.filter(a => a.kind === 'annotated_comments');
  assert.equal(artifacts.length, 2);
  const storage = require('../../pilot/storage');
  for (const [index, artifact] of artifacts.entries()) {
    const draft = await db('la_versions').where({ id: artifact.version_id }).first();
    const source = await db('la_versions').where({ id: artifact.source_version_id }).first();
    const original = await storage.read(source.storage_key), bytes = await storage.read(draft.storage_key);
    const endpoint = `/api/contracts/${draft.contract_id}/review-document`;
    await agent.get(`${endpoint}?versionId=${draft.id}`).expect(200);
    await outsider.get(`${endpoint}?versionId=${draft.id}`).expect(404);
    const save = client => client.post(endpoint).set('X-CSRF-Token', csrf).field('baseVersionId', draft.id).attach('file', bytes, draft.filename);
    if (index) {
      await db('la_auto_review_batches').where({ id: batch.id }).update({ main_review_id: null });
      await save(agent).expect(409);
      await db('la_auto_review_batches').where({ id: batch.id }).update({ main_review_id: b.main_review_id });
    }
    const result = (await save(agent).expect(200)).body;
    const saved = await db('la_versions').where({ id: result.versionId }).first();
    assert.equal(result.learning.status, 'recorded');
    const stateSource = await db('la_agent_legal_events').where({ id: result.learning.sourceId }).first();
    assert.equal(stateSource.review_id, b.main_review_id);
    assert.equal(stateSource.contract_id, draft.contract_id);
    assert.equal(stateSource.source.beforeVersionId, draft.id);
    assert.deepEqual(stateSource.source.review.body.added, []);
    assert.equal(stateSource.status, 'completed');
    assert.equal((await db('la_outbox').where({ queue: 'agent-memory' }).whereJsonSupersetOf('payload', { sourceId: stateSource.id })).length, 0);
    assert.equal(saved.parent_id, draft.id);
    assert.equal(saved.source_action, 'margin_review');
    assert.equal((await db('la_contracts').where({ id: draft.contract_id }).first()).current_version_id, saved.id);
    assert.deepEqual(await storage.read(draft.storage_key), bytes);
    assert.deepEqual(await storage.read(source.storage_key), original);
    await save(agent).expect(409);
    const reopened = await agent.get(`${endpoint}?versionId=${saved.id}`).expect(200);
    assert.match(reopened.headers['content-type'], /wordprocessingml/);
    // This second file has no independent current_review_id. Its human save
    // must still link to the batch review without treating AI draft text as new.
    if (index) {
      const archive = new AdmZip(bytes);
      const content = archive.readAsText('word/document.xml').replace('</w:p>', '<w:r><w:t>质保期内应提供维修。</w:t></w:r></w:p>');
      archive.updateFile('word/document.xml', Buffer.from(content));
      const edited = archive.toBuffer(), reason = '已确认本次采购包含质保，需明确维修义务。';
      const response = await agent.post(endpoint).set('X-CSRF-Token', csrf).field('baseVersionId', saved.id).field('reviewReason', reason).attach('file', edited, draft.filename).expect(200);
      assert.equal(response.body.learning.status, 'queued');
      const sourceId = response.body.learning.sourceId;
      let sourceEvent = await db('la_agent_legal_events').where({ id: sourceId }).first();
      assert.equal(sourceEvent.kind, 'review_revision');
      assert.equal(sourceEvent.source.beforeVersionId, saved.id);
      assert.equal(sourceEvent.source.reviewedVersionId, source.id);
      assert.equal(sourceEvent.source.review.reason, reason);
      assert.ok(sourceEvent.source.review.humanEvidence.includes('质保期内应提供维修。'));
      assert.deepEqual(sourceEvent.source.review.decisions, []);
      const draftMemory = { kind: 'skill', title: '核查质保维修义务', description: '约定质保时核查维修责任', content: '合同已确认包含质保时，核对维修义务及履行方式，缺失时补充。', conditions: ['已确认包含质保的采购合同'], sourceQuotes: ['质保期内应提供维修。'] };
      const memory = require('../../pilot/agent/memory');
      await memory.processMemory(db, sourceId, { distill: async input => {
        assert.match(input.system, /未处理的AI内容/);
        const sourceInput = JSON.parse(input.source);
        assert.equal(sourceInput.beforeVersionId, saved.id);
        return { memories: [draftMemory] };
      } });
      sourceEvent = await db('la_agent_legal_events').where({ id: sourceId }).first();
      assert.equal(sourceEvent.status, 'completed');
      const knowledge = await db('la_agent_memories').where({ source_id: sourceId }).first();
      assert.equal(knowledge.state, 'draft'); assert.equal(knowledge.version, 0);
      const run = await db('la_reviews').where({ id: b.main_review_id }).first();
      const contextBefore = await service.usableMemories(db, await db('la_contracts').where({ id: run.contract_id }).first());
      assert.ok(!contextBefore.some(m => m.id === knowledge.id));
      let item = (await req('get', '/agent/experiences/' + knowledge.id).expect(200)).body;
      assert.deepEqual(item.sourceQuotes, ['质保期内应提供维修。']);
      item = (await req('post', '/agent/experiences/' + knowledge.id + '/submit', { revision: item.revision }).expect(200)).body;
      await req('post', '/agent/experiences/' + knowledge.id + '/approve', { revision: item.revision }).expect(200);
      assert.ok((await service.usableMemories(db, await db('la_contracts').where({ id: run.contract_id }).first())).some(m => m.id === knowledge.id));
      const count = Number((await db('la_agent_legal_events').where({ contract_id: draft.contract_id }).count('* as n').first()).n);
      const repeat = await agent.post(endpoint).set('X-CSRF-Token', csrf).field('baseVersionId', response.body.versionId).attach('file', edited, draft.filename).expect(200);
      assert.equal(repeat.body.learning.sourceId, null);
      assert.equal(Number((await db('la_agent_legal_events').where({ contract_id: draft.contract_id }).count('* as n').first()).n), count);
      const batchDetail = (await req('get', '/auto-review-batches/' + batch.id).expect(200)).body;
      assert.ok(batchDetail.learningSources.some(s => s.id === sourceId && s.skillCount === 1));
      const detail = (await req('get', '/agent/experience-sources/' + sourceId).expect(200)).body;
      assert.match(detail.fields.find(f => f.label === '本次修改理由与适用条件').value, /维修义务/);
      assert.deepEqual(detail.memories.find(m => m.id === knowledge.id).sourceQuotes, ['质保期内应提供维修。']);
      await memory.processMemory(db, sourceId, { distill: () => { throw Error('completed source must not redistill'); } });
    }
  }
});
test('historical tracked artifacts remain byte-identical on recovery and can still be opened and saved', async () => {
  const batch=(await upload().expect(202)).body;
  await batches.processBatch(db,batch.id,{runtimeFactory:complete});
  const b=(await req('get','/auto-review-batches/'+batch.id).expect(200)).body;
  const storage=require('../../pilot/storage'), {applyClauseRevisions}=require('../../pilot/clause-revisions');
  const artifact=b.artifacts.find(a=>a.kind==='annotated_comments');
  const version=await db('la_versions').where({id:artifact.version_id}).first();
  const source=await db('la_versions').where({id:artifact.source_version_id}).first();
  const original=await storage.read(source.storage_key), block=require('../../pilot/parser').parseDocx(original).blocks[0];
  const legacy=applyClauseRevisions(original,{explanation:'历史样本',edits:[{operation:'replace',blockId:block.id,originalText:block.text,newText:'历史已生成的合同条款。'}]},'AI 历史评审');
  const key=await storage.put(legacy,version.contract_id,version.id,'历史自动修订.docx');
  await db('la_versions').where({id:version.id}).update({storage_key:key,sha256:storage.sha256(legacy),source_action:'auto_review_draft',parsed:JSON.stringify(require('../../pilot/parser').parseDocx(legacy))});
  await db('la_auto_review_artifacts').where({id:artifact.id}).update({kind:'tracked_revisions',filename:'历史自动修订.docx'});
  const before=await db('la_auto_review_artifacts').where({id:artifact.id}).first();
  const run=await db('la_reviews').where({id:b.main_review_id}).first();
  await require('../../pilot/auto-review-artifacts').generate(db,await db('la_auto_review_batches').where({id:batch.id}).first(),run,async()=>{});
  assert.deepEqual(await db('la_auto_review_artifacts').where({id:artifact.id}).first(),before);
  assert.deepEqual(await storage.read(key),legacy);
  await req('get',artifact.downloadUrl.replace('/api','')).expect(200);
  const endpoint=`/api/contracts/${version.contract_id}/review-document`;
  await agent.get(`${endpoint}?versionId=${version.id}`).expect(200);
  await agent.post(endpoint).set('X-CSRF-Token',csrf).field('baseVersionId',version.id).attach('file',legacy,'历史审阅.docx').expect(200);
  assert.deepEqual(await storage.read(source.storage_key),original);
});

test('candidate without observation cannot publish; resume creates a new review and requires a fresh plan', async () => {
  const b = (await upload().expect(202)).body;
  await batches.processBatch(db, b.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await plan(context, documents, run); assert.equal((await context.execute('submit_review', { report: report(documents) }, 'candidate')).candidateSaved, true); return {};
  }, async close() {} }) });
  let current = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  assert.equal(current.status, 'needs_attention'); assert.equal(current.review.agentResult, null); assert.equal(current.artifacts.length, 0);
  const prior = current.main_review_id; await req('post', '/auto-review-batches/' + b.id + '/resume', { background: { ourEntity: '虚构采购方', perspective: '采购方' } }).expect(202);
  current = await db('la_auto_review_batches').where({ id: b.id }).first(); assert.notEqual(current.main_review_id, prior);
  assert.equal((await db('la_reviews').where({ id: current.main_review_id }).first()).snapshot.background.ourEntity, '虚构采购方');
  // Read ranges remain available across the session; complete() also tests the
  // unread guard, so use a lean continuation here.
  await batches.processBatch(db, b.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    assert.equal((await context.execute('submit_review', { report: report(documents) }, randomUUID())).error, 'AUTO_PLAN_REQUIRED');
    await plan(context, documents, run); await context.execute('submit_review', { report: report(documents) }, randomUUID());
    assert.equal((await context.execute('observe_review', { summary: '按补充背景重新核查', remainingIssues: [] }, randomUUID())).submitted, true); return {};
  }, async close() {} }) });
  assert.equal((await db('la_auto_review_batches').where({ id: b.id }).first()).status, 'completed');
});
test('continuation exposes saved reading for identical documents without treating the previous plan as current', async () => {
  const b = (await upload().expect(202)).body;
  await batches.processBatch(db, b.id, { runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    for (const d of documents) await context.execute('read_document', { versionId: d.versionId }, randomUUID());
    await plan(context, documents, run); return {};
  }, async close() {} }) });
  const before = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  const original = await db('la_reviews').where({ id: before.main_review_id }).first();
  await db('la_reviews').insert({ id: randomUUID(), contract_id: original.contract_id, version_id: original.version_id, created_by: original.created_by, engine: original.engine, agent_session_id: original.agent_session_id,
    snapshot: JSON.stringify({ ...original.snapshot, documents: [{ ...original.snapshot.documents[0], versionId: randomUUID() }] }), coverage: JSON.stringify({ totalBlocks: 999, readBlocks: 999 }) });
  const resumed = (await req('post', '/auto-review-batches/' + b.id + '/resume', {}).expect(202)).body;
  assert.notEqual(resumed.main_review_id, before.main_review_id);
  assert.deepEqual(resumed.review.coverage, {});
  assert.deepEqual(resumed.review.savedCoverage, { sourceReviewId: before.main_review_id, readBlocks: 2, totalBlocks: 2 });
  assert.equal(resumed.executionPlan.reviewId, before.main_review_id);
  await batches.processBatch(db, b.id, { runtimeFactory: async () => ({ async run() {
    const live = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
    assert.equal(live.status, 'planning'); assert.equal(live.review.status, 'running');
    assert.equal((await req('get', '/auto-review-batches').expect(200)).body.find(row => row.id === b.id).status, 'planning');
    throw new (require('../../pilot/errors').AppError)(502, 'AGENT_MODEL_TIMEOUT', '模型响应超时');
  }, async close() {} }) });
  const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  const { batchState } = await import('../../../frontend/src/pilot/auto-review-state.mjs');
  const state = batchState(detail);
  assert.equal(state.phases[0].done, true); assert.equal(state.phases[1].current, true); assert.equal(state.phases[2].current, false);
  assert.match(state.phases[1].detail, /上轮.*本轮待更新/); assert.equal(state.pauseDetails.stage, '制定计划');
  assert.deepEqual((await db('la_reviews').where({ id: before.main_review_id }).first()).coverage, original.coverage);
  await outsider.get('/api/auto-review-batches/' + b.id).expect(404);
});

test('cancellation stops active execution and recovery resumes queued work without publishing cancelled artifacts', async () => {
  const b = (await upload().expect(202)).body;
  await batches.processBatch(db, b.id, { runtimeFactory: async ({ context, run, documents }) => ({ async run() {
    await req('post', '/auto-review-batches/' + b.id + '/cancel', {}).expect(202);
    await assert.rejects(context.execute('read_document', { versionId: documents[0].versionId }, 'after-stop'), e => e.code === 'AGENT_STOPPED');
    return {};
  }, async close() {} }) });
  assert.equal((await db('la_auto_review_batches').where({ id: b.id }).first()).status, 'cancelled'); assert.equal((await db('la_auto_review_artifacts').where({ batch_id: b.id })).length, 0);
  await req('post', '/auto-review-batches/' + b.id + '/resume', {}).expect(202); await batches.recover(db);
  await batches.processBatch(db, b.id, { runtimeFactory: complete });
  assert.equal((await db('la_auto_review_batches').where({ id: b.id }).first()).status, 'completed');
});

test('batch detail supports a saved question and resume validates and records the actual answer', async () => {
  const b = (await upload().expect(202)).body;
  await batches.processBatch(db, b.id, { runtimeFactory: async ({ context, run }) => ({ async run() {
    const question = '请确认实际付款情况。', questions = [{ id: 'paid', question: '预付款是否已支付？', options: [{ label: '已支付' }, { label: '未支付' }] }];
    // Normal automatic reviews defer missing facts instead of blocking. Retain
    // support for an already saved question if an interrupted session has one.
    assert.equal((await context.execute('request_information', { question, questions }, 'ask-paid')).deferred, true);
    assert.equal((await db('la_agent_messages').where({ review_id: run.id, kind: 'question' })).length, 0);
    await db('la_agent_messages').insert({ id: randomUUID(), session_id: run.agent_session_id, review_id: run.id, role: 'assistant', kind: 'question', content: question, data: JSON.stringify({ questions }) });
    return {};
  }, async close() {} }) });
  const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  assert.equal(detail.review.stage, 'awaiting_answer');
  const q = detail.review.questions[0]; assert.equal(q.data.questions[0].question, '预付款是否已支付？');
  await req('post', '/auto-review-batches/' + b.id + '/resume', {}).expect(409);
  await req('post', '/auto-review-batches/' + b.id + '/resume', { questionId: q.id, content: ' ' }).expect(422);
  await req('post', '/auto-review-batches/' + b.id + '/resume', { questionId: q.id, answers: [{ id: 'paid', selected: ['伪造选项'] }] }).expect(422);
  assert.equal((await db('la_auto_review_batches').where({ id: b.id }).first()).main_review_id, detail.main_review_id);
  const next = (await req('post', '/auto-review-batches/' + b.id + '/resume', { questionId: q.id, answers: [{ id: 'paid', selected: ['未支付'] }], content: '以银行流水为准' }).expect(202)).body;
  const answer = await db('la_agent_messages').where({ review_id: next.main_review_id, kind: 'answer' }).first();
  assert.equal(answer.data.questionId, q.id); assert.match(answer.content, /预付款是否已支付？\n回答：未支付/); assert.match(answer.content, /以银行流水为准/);
  assert.equal(next.review.questions.length, 0); assert.equal(next.status, 'queued');
  await batches.processBatch(db, b.id, { runtimeFactory: complete });
  assert.equal((await db('la_auto_review_batches').where({ id: b.id }).first()).status, 'completed');
});

test('method labels come from frozen review memory, deduplicate loads and retain unknown identifiers for diagnostics', async () => {
  const b = (await upload().expect(202)).body, memoryId = randomUUID(), unknown = 'legal-' + randomUUID();
  await batches.processBatch(db, b.id, { runtimeFactory: async ({ run }) => ({ async run() {
    const memories = [{ id: memoryId, kind: 'skill', title: '采购付款与验收衔接核查', description: '核对验收条件、付款节点及退款安排。', content: '此处为不应出现在展示摘要中的方法正文', version: 2 }];
    await db('la_reviews').where({ id: run.id }).update({ snapshot: JSON.stringify({ ...run.snapshot, memories }) });
    for (const name of ['legal-auto-review', 'legal-' + memoryId, 'legal-' + memoryId, unknown]) await service.event(db, run.agent_session_id, run.id, 'skill_loaded', { name });
    return {};
  }, async close() {} }) });
  const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  assert.equal(detail.skills.length, 4);
  const practical = detail.skills.find(s => s.name === 'legal-practical-redline');
  assert.equal(practical.title, '法务实务审改'); assert.equal(practical.source, 'builtin');
  const builtin = detail.skills.find(s => s.name === 'legal-auto-review');
  assert.equal(builtin.title, '多文件自动合同评审'); assert.equal(builtin.source, 'builtin');
  const learned = detail.skills.find(s => s.name === 'legal-' + memoryId);
  assert.equal(learned.title, '采购付款与验收衔接核查'); assert.equal(learned.source, 'experience');
  assert.equal(learned.versionId, memoryId);
  assert.equal(detail.skills.find(s => s.name === unknown).title, '历史审查方法'); assert.equal(detail.skills.find(s => s.name === unknown).source, 'unknown');
  assert.ok(!JSON.stringify(detail.skills).includes('不应出现在展示摘要中的方法正文'));
});

test('official SDK stream timeout is reported as a technical pause and can resume without invented background', async () => {
  const http = require('node:http'), saved = { ...config.model };
  const server = http.createServer(async (request, response) => {
    for await (const _part of request) {};
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    Object.assign(config.model, { baseUrl: 'http://127.0.0.1:' + server.address().port, key: 'timeout-test-key', name: 'timeout-test-model', reviewTimeout: 120 });
    const b = (await upload().expect(202)).body;
    await batches.processBatch(db, b.id);
    const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
    assert.equal(detail.status, 'needs_attention'); assert.equal(detail.review.errorCode, 'AGENT_MODEL_TIMEOUT'); assert.equal(detail.review.questions.length, 0);
    assert.match(detail.error_message, /未返回实际生成内容/); assert.ok(detail.activity.some(e => e.type === 'model_failed' && e.data.code === 'AGENT_MODEL_TIMEOUT'));
    const failure = detail.activity.find(e => e.type === 'model_failed').data;
    assert.equal(failure.interruption, 'first_response_timeout'); assert.equal(failure.timeoutMs, 120);
    assert.ok(failure.elapsedMs >= 100 && failure.elapsedMs < 5000); assert.ok(failure.receivedBytes > 0); assert.equal(failure.httpStatus, 200);
    const next = (await req('post', '/auto-review-batches/' + b.id + '/resume', {}).expect(202)).body;
    assert.equal(next.status, 'queued'); assert.notEqual(next.main_review_id, detail.main_review_id); assert.deepEqual(next.background, detail.background);
  } finally { Object.assign(config.model, saved); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('official SDK keeps a progressing report stream beyond the initial response deadline without retrying', async () => {
  const http = require('node:http'), saved = { ...config.model };
  const { createRuntime } = require('../../pilot/agent/runtime');
  let requests = 0, completed = false, receivedReport;
  const pieces = ['{"report":{', '"summary":', '"持续生成报告",', '"findings":[],', '"limitations":[],', '"reviewedVersionIds":[],', '"contractType":"测试"', '}}'];
  const server = http.createServer(async (request, response) => {
    for await (const _part of request) {};
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'report-call', type: 'function', function: { name: 'submit_review', arguments: '' } }] }, finish_reason: null }] }) + '\n\n');
    let index = 0;
    const timer = setInterval(() => {
      if (index < pieces.length) response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: pieces[index++] } }] }, finish_reason: null }] }) + '\n\n');
      else {
        clearInterval(timer);
        response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
      }
    }, 70);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    Object.assign(config.model, { baseUrl: 'http://127.0.0.1:' + server.address().port, key: 'stream-test-key', name: 'stream-test-model', reviewTimeout: 250, reviewIdleTimeout: 200, reviewMaxDuration: 1500 });
    const b = (await upload().expect(202)).body;
    await batches.processBatch(db, b.id, { runtimeFactory: async args => {
      const context = { ...args.context, toolDefinitions: [{ name: 'submit_review', description: 'Transport-only report fixture', parameters: { type: 'object', properties: { report: { type: 'object', additionalProperties: true } } } }],
        async execute(name, value) { assert.equal(name, 'submit_review'); receivedReport = value; return { submitted: true }; } };
      const runtime = await createRuntime({ ...args, context });
      return { async run(input) { const result = await runtime.run(input); completed = true; return result; }, close: () => runtime.close() };
    } });
    assert.equal(completed, true, 'the real SDK must receive the whole stream instead of a five-minute-style cutoff');
    assert.equal(requests, 1, 'a progressing stream must not be restarted');
    assert.deepEqual(receivedReport, JSON.parse(pieces.join('')), 'a tool call must execute only after all JSON arguments arrive');
    const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
    assert.equal(detail.activity.filter(e => e.type === 'model_failed').length, 0);
    assert.ok(detail.activity.some(e => e.type === 'model_progress'));
    assert.ok(detail.activity.some(e => e.type === 'model_response' && e.data.elapsedMs > 250));
    // This transport fixture deliberately bypasses business report persistence.
    assert.equal(detail.review.errorCode, 'AGENT_INCOMPLETE');
  } finally { Object.assign(config.model, saved); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

for (const scenario of [
  { name: 'heartbeats without generated content', initial: false, heartbeat: true, interruption: 'first_response_timeout', first: 240, idle: 160, total: 1200 },
  { name: 'stalled generated content despite heartbeats', initial: true, heartbeat: true, interruption: 'stream_idle_timeout', first: 600, idle: 180, total: 1200 },
  { name: 'continuous content reaching the total cap', initial: true, heartbeat: false, interruption: 'request_deadline', first: 300, idle: 240, total: 600 },
  { name: 'a transport disconnect during generation', initial: true, heartbeat: false, interruption: 'connection', first: 600, idle: 300, total: 1200, disconnect: true },
]) test('official SDK correctly pauses ' + scenario.name, async () => {
  const http = require('node:http'), saved = { ...config.model };
  let requests = 0;
  const content = 'data: {"choices":[{"index":0,"delta":{"content":"内容"},"finish_reason":null}]}\n\n';
  const server = http.createServer(async (request, response) => {
    for await (const _part of request) {};
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (scenario.initial) response.write(content);
    const timer = setInterval(() => response.write(scenario.heartbeat ? ': ping\n\n' : content), 40);
    const disconnect = scenario.disconnect ? setTimeout(() => response.destroy(), 100) : null;
    response.on('close', () => { clearInterval(timer); clearTimeout(disconnect); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    Object.assign(config.model, { baseUrl: 'http://127.0.0.1:' + server.address().port, key: 'deadline-test-key', name: 'deadline-test-model', reviewTimeout: scenario.first, reviewIdleTimeout: scenario.idle, reviewMaxDuration: scenario.total });
    const b = (await upload().expect(202)).body;
    await batches.processBatch(db, b.id);
    const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
    assert.equal(detail.status, 'needs_attention');
    assert.equal(detail.review.errorCode, scenario.disconnect ? 'AGENT_MODEL_CONNECTION' : 'AGENT_MODEL_TIMEOUT');
    assert.equal(detail.review.questions.length, 0); assert.equal(detail.artifacts.length, 0);
    const failures = detail.activity.filter(e => e.type === 'model_failed');
    assert.equal(failures.length, 2); assert.equal(requests, 2, 'the configured single retry remains effective');
    for (const { data } of failures) {
      assert.equal(data.interruption, scenario.interruption); assert.equal(data.httpStatus, 200); assert.ok(data.receivedBytes > 0);
      if (scenario.initial) assert.ok(Number.isFinite(data.lastProgressElapsedMs));
      if (scenario.interruption === 'stream_idle_timeout') assert.ok(data.idleElapsedMs >= scenario.idle - 10);
      if (scenario.interruption === 'request_deadline') assert.ok(data.elapsedMs >= scenario.total - 10 && data.idleElapsedMs < scenario.idle);
    }
    if (!scenario.initial) assert.equal(detail.activity.filter(e => e.type === 'model_progress').length, 0);
  } finally { Object.assign(config.model, saved); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('cancelling a real SDK stream closes the upstream and does not invent a model timeout', async () => {
  const http = require('node:http'), saved = { ...config.model };
  const { createRuntime } = require('../../pilot/agent/runtime');
  let active = 0, cancelled = false;
  const server = http.createServer(async (request, response) => {
    for await (const _part of request) {};
    active++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const timer = setInterval(() => response.write('data: {"choices":[{"index":0,"delta":{"content":"内容"},"finish_reason":null}]}\n\n'), 40);
    response.on('close', () => { active--; clearInterval(timer); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    Object.assign(config.model, { baseUrl: 'http://127.0.0.1:' + server.address().port, key: 'cancel-test-key', name: 'cancel-test-model', reviewTimeout: 1500, reviewIdleTimeout: 1500, reviewMaxDuration: 5000 });
    const b = (await upload().expect(202)).body;
    await batches.processBatch(db, b.id, { runtimeFactory: args => createRuntime({ ...args, notify: async (type, data) => {
      await args.notify(type, data);
      if (type === 'model_progress' && !cancelled) { cancelled = true; await req('post', '/auto-review-batches/' + b.id + '/cancel', {}).expect(202); }
    } }) });
    const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
    assert.equal(cancelled, true); assert.equal(detail.status, 'cancelled'); assert.equal(active, 0);
    assert.equal(detail.activity.filter(e => e.type === 'model_failed').length, 0); assert.equal(detail.artifacts.length, 0);
  } finally { Object.assign(config.model, saved); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('historical pause exposes only verified timings for the current review and keeps raw audit private', async () => {
  const b = (await upload().expect(202)).body;
  await batches.processBatch(db, b.id, { runtimeFactory: async () => ({ async run() { throw new (require('../../pilot/errors').AppError)(502, 'AGENT_MODEL_TIMEOUT', '模型响应超时'); }, async close() {} }) });
  const before = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  const attempts = [{ started: 1794375284760, ended: 1794375584867, duration: 300107 }];
  const { audit } = require('../../pilot/auth');
  await audit(db, null, 'auto_review_batch.timeout_diagnosed', b.id, { reviewId: before.main_review_id, timeouts: attempts, logSha256: 'private-log-hash', internal: 'never-expose' });
  await audit(db, null, 'auto_review_batch.timeout_diagnosed', b.id, { reviewId: randomUUID(), timeouts: [{ started: 1, ended: 2, duration: 1 }] });
  const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  assert.deepEqual(detail.review.timeoutDiagnosis, { attempts });
  assert.ok(!JSON.stringify(detail).includes('private-log-hash')); assert.ok(!JSON.stringify(detail).includes('never-expose'));
  await outsider.get('/api/auto-review-batches/' + b.id).expect(404);
  const next = (await req('post', '/auto-review-batches/' + b.id + '/resume', {}).expect(202)).body;
  assert.equal(next.review.timeoutDiagnosis, undefined);
});
test('partial parsing failure still reviews readable materials and records report-only files', async () => {
  const b = (await req('post', '/auto-review-batches').attach('files', docx('采购合同。交付另议。'), '可读.docx').attach('files', docx('无法解析的正文'), '失败.docx').expect(202)).body;
  const parse = require('../../pilot/parser').parseDocument;
  await batches.processBatch(db, b.id, { parser: async (bytes, filename) => { if (filename === '失败.docx') throw Object.assign(Error('解析失败'), { code: 'TEST_PARSE' }); return parse(bytes, filename); }, runtimeFactory: async ({ context, documents, run }) => ({ async run() {
    assert.equal(documents.length, 1); await context.execute('read_document', { versionId: documents[0].versionId }, 'read'); await plan(context, documents, run);
    const r = report(documents); r.crossDocumentReview.forEach(c => c.status = 'not_applicable'); await context.execute('submit_review', { report: r }, 'submit'); await context.execute('observe_review', { summary: '核查已读材料并保留失败限制', remainingIssues: [] }, 'observe'); return {};
  }, async close() {} }) });
  const result = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  assert.equal(result.status, 'partial', JSON.stringify(result)); assert.ok(result.review.agentResult.limitations.some(l => l.includes('失败.docx'))); assert.equal(result.artifacts.filter(a => a.status === 'report_only').length, 1);
  await req('post','/auto-review-batches/'+b.id+'/retry',{}).expect(202);
  await batches.processBatch(db,b.id,{runtimeFactory:complete});
  const retried=(await req('get','/auto-review-batches/'+b.id).expect(200)).body;
  assert.equal(retried.status,'completed',JSON.stringify(retried));assert.notEqual(retried.main_review_id,result.main_review_id);
  assert.equal(retried.artifacts.length,6);assert.ok(result.artifacts.every(a=>retried.artifacts.some(next=>next.id===a.id)));
});
test('file and total-size limits reject oversize requests before creating any records', async()=>{
  const before=Number((await db('la_auto_review_batches').count('* as n').first()).n);
  const oversized=Buffer.alloc(50*1024*1024+1);
  await req('post','/auto-review-batches').attach('files',oversized,'超限.docx').expect(413);
  // Reuse one actual 41MB byte buffer to exercise aggregate size validation.
  const part=Buffer.alloc(41*1024*1024);
  await assert.rejects(batches.createBatch(db,user,Array.from({length:5},(_,i)=>({buffer:part,originalname:i+'.docx'}))),e=>e.code==='AUTO_REVIEW_TOTAL_LIMIT');
  assert.equal(Number((await db('la_auto_review_batches').count('* as n').first()).n),before);
});
test('report-only spreadsheet is reviewed and its frozen original remains downloadable with authorization', async () => {
  const source = Buffer.from('项目,金额\n运费,10000\n', 'utf8');
  const b = (await req('post', '/auto-review-batches').attach('files', source, '测算.csv').attach('files', docx('运输合同：费用另议。'), '运输合同.docx').expect(202)).body;
  const convert = async () => {
    const zip = new AdmZip();
    const block = { id: 'b1', text: '运费：10000元，付款日期另议。', kind: 'cell', source: 'spreadsheet', page: null, sheet: '测算', address: 'A1' };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ version: 1, sourceExtension: '.csv', notes: [], warnings: [], document: { parserVersion: 'fixture', format: 'spreadsheet', blocks: [block], sheets: [{ name: '测算', state: 'visible' }], requiresHumanVerification: true, warnings: [] } })));
    zip.addFile('preview.pdf', Buffer.from('%PDF-1.4\n%fictional-spreadsheet'));
    return zip.toBuffer();
  };
  await batches.processBatch(db, b.id, { convert, runtimeFactory: complete });
  const detail = (await req('get', '/auto-review-batches/' + b.id).expect(200)).body;
  const material = detail.documents.find(d => d.filename === '测算.csv');
  const artifact = detail.artifacts.find(a => a.batch_document_id === material.id);
  assert.equal(material.ingest_status, 'ready');
  assert.equal(detail.review.status, 'completed');
  assert.equal(detail.review.coverage.complete, true);
  assert.ok(detail.findings.some(f => f.evidence.some(e => e.versionId === material.version_id)));
  assert.equal(artifact.status, 'report_only');
  assert.match(artifact.error_message, /DOCX/);
  assert.equal(artifact.downloadUrl, null);
  const endpoint = '/files/' + material.version_id + '?download=1';
  const response = await req('get', endpoint).expect(200);
  assert.match(response.headers['content-disposition'], /^attachment;/);
  assert.deepEqual(Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text), source);
  await outsider.get('/api' + endpoint).expect(404);
  await supertest(app.app).get('/api' + endpoint).expect(401);
});

test('non-DOCX Word conversion generates a comment copy and preserves the original binary',async()=>{
  const source=Buffer.from('d0cf11e0a1b11ae100112233','hex');
  const b=(await req('post','/auto-review-batches').attach('files',source,'旧版合同.doc').attach('files',docx('补充协议：付款时间另议。'),'附加条款.docx').expect(202)).body;
  let conversions=0;
  const convert=async()=>{conversions++;const z=new AdmZip();z.addFile('manifest.json',Buffer.from(JSON.stringify({version:1,sourceExtension:'.doc',document:null,notes:[],warnings:['转换版式需抽查']})));z.addFile('preview.pdf',Buffer.from('%PDF-1.4\n%fixture'));z.addFile('document.docx',docx('采购合同：交付时间另议。'));return z.toBuffer();};
  await batches.processBatch(db,b.id,{convert,runtimeFactory:complete});
  const result=(await req('get','/auto-review-batches/'+b.id).expect(200)).body;assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(conversions,1);
  const original=await db('la_versions').where({id:b.documents.find(d=>d.filename==='旧版合同.doc').version_id}).first();
  assert.deepEqual(await require('../../pilot/storage').read(original.storage_key),source);
  const artifact=result.artifacts.find(a=>a.source_version_id===original.id);assert.equal(artifact.details.converted,true);
  const version=await db('la_versions').where({id:artifact.version_id}).first(), zip=new AdmZip(await require('../../pilot/storage').read(version.storage_key)); assert.doesNotMatch(zip.readAsText('word/document.xml'),/<w:(?:ins|del)\b/); assert.match(zip.readAsText('word/comments.xml'),/未约定明确日期/); assert.equal(artifact.kind,'annotated_comments');
});
test('official Harness SDK loads the skill, persists a plan, corrects tool errors and observes before concluding', async () => {
  const http = require('node:http'); let requests = 0, current;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests++;
      assert.ok(body.messages[0].role === 'system' && body.messages[0].content.includes('legal-practical-redline'));
      assert.ok(body.messages[0].content.includes('必读参考：legal-practical-redline/references/examples.md'));
      assert.ok(body.messages[0].content.includes('用一句限制代理权限'));
      assert.equal(request.headers.authorization, 'Bearer fictional-auto-sdk-key');
      assert.ok(body.tools.some(t => t.function.name === 'observe_review'));
      assert.ok(!body.tools.some(t => t.function.name === 'generate_annotated_docx'));
      const docs = [];
      for (const d of current.documents) { const v = await db('la_versions').where({ id: d.version_id }).first(); docs.push({ versionId: v.id, filename: v.filename, blocks: v.parsed.blocks }); }
      let name, args;
      if (requests === 1) { name = 'skill'; args = { name: 'legal-auto-review' }; }
      else if (requests <= 3) { name = 'read_document'; args = { versionId: docs[requests - 2].versionId }; }
      else if (requests === 4) { name = 'create_review_plan'; args = { plan: { goal: '全文核查及跨文件比较', documents: docs.map(d => ({ versionId: d.versionId, role: 'uncertain', confidence: 0.5, reason: '适用关系待确认', evidence: [] })), steps: [{ id: 'all', title: '核查金额、期限、补充条款及适用顺序', versionIds: docs.map(d => d.versionId) }], skillNames: ['legal-auto-review'] } }; }
      else if (requests <= 6) { name = 'submit_review'; args = { report: report(docs) }; if (requests === 5) args.report.findings[0].evidence[0].quote = '不在原件的错误证据'; }
      else if (requests === 7) { name = 'observe_review'; args = { summary: '已纠正证据并复查材料覆盖和三类跨文件问题', remainingIssues: [] }; }
      else throw Error('observe_review should conclude the turn');
      const packet = (delta, finish_reason = null) => ({ id: 'auto-' + requests, object: 'chat.completion.chunk', created: 1, model: 'auto-sdk-fixture', choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(packet({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'sdk-auto-' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }))}\n\ndata: ${JSON.stringify({ ...packet({}, 'tool_calls'), usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const saved = { ...config.model };
  try {
    Object.assign(config.model, { baseUrl: 'http://127.0.0.1:' + server.address().port, key: 'fictional-auto-sdk-key', name: 'auto-sdk-fixture' });
    current = (await upload().expect(202)).body; await batches.processBatch(db, current.id);
    const b = (await req('get', '/auto-review-batches/' + current.id).expect(200)).body;
    assert.equal(b.status, 'completed', JSON.stringify(b)); assert.equal(requests, 7); assert.equal(b.artifacts.length, 3);
    assert.ok(b.activity.some(e => e.type === 'skill_loaded' && e.data.name === 'legal-auto-review'));
    assert.ok((await db('la_agent_tool_calls').where({ review_id: b.main_review_id })).some(c => c.result.error === 'AGENT_INVALID_EVIDENCE'));
  } finally { Object.assign(config.model, saved); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('DingTalk sends a whole attachment package into the same model without manual grouping and deduplicates re-delivery', async () => {
  const saved = { ...config.ding }, enabled = process.env.AUTO_REVIEW_DINGTALK_ENABLED;
  const { startBinding, completeBinding } = require('../../pilot/dingtalk-account');
  const { persistEvent, processIntegration } = require('../../pilot/dingtalk');
  try {
    process.env.AUTO_REVIEW_DINGTALK_ENABLED = 'true'; Object.assign(config.ding, { enabled: true, clientId: 'auto-ding-fixture', secret: 'fixture-secret' });
    const binding = new URL((await startBinding(db, user)).url);
    await completeBinding(db, user, { code: 'fixture', state: binding.searchParams.get('state') }, { resolve: async () => ({ userId: 'auto-recipient', displayName: '虚构收件法务' }) });
    const files = [{ fileId:'main', fileName:'主合同.docx' }, { fileId:'supplement', fileName:'补充协议.docx' }, { fileId:'failed', fileName:'失败.docx' }, { fileId:'zip', fileName:'原始资料.zip' }];
    const receive = async (changed = false) => {
      const id = await persistEvent(db, { processInstanceId:'auto-approval', eventType:'bpms_task_change' }, randomUUID(), 'auto-ding-fixture');
      await processIntegration(db, id, { detail:async()=>({ title:'自动审批附件包', tasks:[{userId:'auto-recipient',status:'NEW',result:'NONE'}], formComponentValues:[{name:'附件',value:JSON.stringify(files)}] }), attachment:async(_id,f)=>{if(f.fileId==='failed')throw Error('download failed');return docx(f.fileId==='main' ? '采购合同：交付日期另议。'+(changed?'新版本。':'') : '补充协议：付款日期另议。');} });
      return db('la_integration_events').where({ id }).first();
    };
    assert.equal((await receive()).summary.collected,2);
    const intake = await db('la_dingtalk_intakes').where({ instance_id:'auto-approval' }).first();
    let rows = await db('la_auto_review_batches').where({ intake_id:intake.id }); assert.equal(rows.length,1);
    const first=rows[0]; assert.equal(first.source,'dingtalk'); assert.equal((await db('la_auto_review_batch_documents').where({batch_id:first.id})).length,4);
    assert.equal((await db('la_review_groups').where({intake_id:intake.id})).length,0);
    await receive(); assert.equal((await db('la_auto_review_batches').where({intake_id:intake.id})).length,1);
    const changedEvent=await receive(true); rows=await db('la_auto_review_batches').where({intake_id:intake.id}); assert.equal(rows.length,2,JSON.stringify({event:changedEvent,docs:await require('../../pilot/joint-intake').documents(db,intake.id)}));
    await assert.rejects(batches.assertCurrent(db,first.id),e=>e.code==='AUTO_REVIEW_MATERIAL_CHANGED');
    const latest=rows.find(b=>b.id!==first.id); await batches.processBatch(db,latest.id,{runtimeFactory:complete});
    const b=(await req('get','/auto-review-batches/'+latest.id).expect(200)).body;
    assert.equal(b.status,'partial',JSON.stringify(b)); assert.equal(b.documents.length,4); assert.equal(b.artifacts.filter(a=>a.status==='report_only').length,2);
    const inbox=(await req('get','/dingtalk/intakes').expect(200)).body; assert.equal(inbox.find(i=>i.id===intake.id).autoReviewBatchId,latest.id);
  } finally {Object.assign(config.ding,saved); if(enabled===undefined)delete process.env.AUTO_REVIEW_DINGTALK_ENABLED;else process.env.AUTO_REVIEW_DINGTALK_ENABLED=enabled;}
});
