const { randomUUID, createHash } = require('node:crypto');
const { z } = require('zod');
const { fail, wrap } = require('./errors');
const { accessible, hasRole, requireRole, assertRevision, audit } = require('./auth');
const { providerConfig, publicModelSnapshot, assertModelSnapshot, createGateway } = require('./model');
const { parseDocument, parserVersion } = require('./parser');
const { needsConversion, isSupported } = require('./file-formats');
const { ensureConverted, parseConverted, persistDocument, publicConversion } = require('./conversion');
const storage = require('./storage');
const uuid = z.string().uuid();
const roles = ['supplement', 'schedule', 'reference'];
const groupSchema = z.object({ groups: z.array(z.object({ name: z.string().trim().min(1).max(300), mainDocumentId: uuid,
  materials: z.array(z.object({ documentId: uuid, role: z.enum(roles) })).max(100).default([]) })).max(100),
  excluded: z.array(z.object({ documentId: uuid, reason: z.string().trim().min(1).max(2000) })).max(500).default([]) });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicVersion = v => { const { storage_key, ...rest } = v; return { ...rest, conversion: publicConversion(v.conversion) }; };
async function settings(db) { const row = await db('la_settings').where({ key: 'dingtalk_joint_intakes' }).first(); return { enabled: row?.value?.enabled === true, autoReviewEnabled: process.env.AUTO_REVIEW_DINGTALK_ENABLED !== 'false', enabledAt: row?.value?.enabledAt || null, updatedAt: row?.updated_at || null }; }
async function lockIntake(db, id) { await db.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['joint-intake:' + id]); }
async function readIntake(db, user, id, lock = false) {
  if (lock) await lockIntake(db, id);
  const intake = await db('la_dingtalk_intakes').where({ id: uuid.parse(id) }).first();
  if (!intake) fail(404, 'INTAKE_NOT_FOUND', '审批收件不存在');
  await accessible(db, user, intake.container_id, lock); return intake;
}
async function documents(db, intakeId) {
  const docs = await db('la_intake_documents').where({ intake_id: intakeId }).orderBy('created_at').orderBy('id');
  const contracts = docs.length ? await db('la_contracts').whereIn('id', docs.map(d => d.contract_id).filter(Boolean)) : [];
  const versions = contracts.length ? await db('la_versions').whereIn('id', contracts.map(c => c.current_version_id).filter(Boolean)) : [];
  return docs.map(d => { const c = contracts.find(c => c.id === d.contract_id); const v = versions.find(v => v.id === c?.current_version_id); return { ...d, version: v ? publicVersion(v) : null }; });
}
async function detail(db, user, id) {
  const intake = await readIntake(db, user, id), container = await accessible(db, user, intake.container_id);
  const groups = await db('la_review_groups').where({ intake_id: id, active: true }).orderBy('created_at');
  const links = groups.length ? await db('la_review_group_documents').whereIn('group_id', groups.map(g => g.id)) : [];
  const docs = await documents(db, id);
  const auto = await db('la_auto_review_batches').where({ intake_id: id }).orderBy('created_at', 'desc').first();
  return { ...intake, autoReviewBatchId: auto?.id || null, title: container.title, number: container.number, documents: docs, groups: groups.map(g => ({ ...g,
    contractId: docs.find(d => d.id === g.main_document_id)?.contract_id,
    mainDocumentId: g.main_document_id, materials: links.filter(l => l.group_id === g.id && l.role !== 'main').map(l => ({ documentId: l.document_id, role: l.role })) })) };
}
async function manifest(db, c, { required = true } = {}) {
  if (!c.source_data?.jointIntakeId) return null;
  if (!c.source_data.jointGroupId) {
    if (required) fail(409, 'INTAKE_CONFIRMATION_REQUIRED', '请先确认同一审批的主合同与关联材料，并从主合同进入审查'); return null;
  }
  const intake = await db('la_dingtalk_intakes').where({ id: c.source_data.jointIntakeId }).first();
  const group = await db('la_review_groups').where({ id: c.source_data.jointGroupId, active: true }).first();
  if (!group || !intake || intake.status !== 'confirmed') {
    if (required) fail(409, 'INTAKE_CONFIRMATION_REQUIRED', '请先确认同一审批的主合同与关联材料'); return null;
  }
  const docs = await documents(db, intake.id), links = await db('la_review_group_documents').where({ group_id: group.id }).orderBy('document_id');
  const entries = links.map(link => {
    const d = docs.find(d => d.id === link.document_id);
    if (!d?.version || d.status !== 'collected' || !d.present) fail(409, 'JOINT_DOCUMENT_UNAVAILABLE', '选入的附件缺失或读取失败，请回到审批附件总览处理');
    return { documentId: d.id, contractId: d.contract_id, versionId: d.version.id, sha256: d.version.sha256, filename: d.version.filename, role: link.role };
  });
  if (entries.filter(e => e.role === 'main').length !== 1 || entries.find(e => e.role === 'main').contractId !== c.id) fail(409, 'JOINT_MAIN_REQUIRED', '请从合同组主合同发起联合审查');
  const excludedDocuments = (intake.confirmed_selection?.excluded || []).map(e => ({ ...e, filename: docs.find(d => d.id === e.documentId)?.filename })).sort((a, b) => a.documentId.localeCompare(b.documentId));
  return { intakeId: intake.id, groupId: group.id, groupName: group.name, documents: entries, excludedDocuments, hash: digest({ documents: entries, excludedDocuments }) };
}
async function assertCurrent(db, c, snapshot) {
  if (!snapshot?.jointGroup) { if (c.source_data?.jointIntakeId) await manifest(db, c); return; }
  const live = await manifest(db, c);
  if (live.hash !== snapshot.jointGroup.hash) fail(409, 'JOINT_REVIEW_STALE', '组内文件已有新版本，请重新联合审查后确认');
}
async function reviewDocument(db, user, run, versionId = run.version_id) {
  const entry = (run.snapshot?.documents || run.snapshot?.jointGroup?.documents || []).find(d => d.versionId === versionId);
  if (versionId !== run.version_id && !entry) fail(404, 'VERSION_NOT_FOUND', '文件不属于本次审查材料');
  const v = await db('la_versions').where({ id: versionId, contract_id: entry?.contractId || run.contract_id }).first();
  if (!v || entry && entry.sha256 !== v.sha256) fail(409, 'JOINT_DOCUMENT_UNAVAILABLE', '审查材料版本不可核实');
  await accessible(db, user, v.contract_id); return v;
}
async function verifyReviewEvidence(db, user, run, evidence) {
  for (const id of new Set(evidence.map(e => e.versionId || run.version_id))) {
    const v = await reviewDocument(db, user, run, id);
    require('./model').verifyEvidence(evidence.filter(e => (e.versionId || run.version_id) === id), v.parsed?.blocks || []);
  }
  if (run.snapshot?.jointGroup) return evidence.map(e => ({ ...e, versionId: e.versionId || run.version_id }));
  return evidence;
}
async function recoverInterrupted(db) {
  const rows = await db('la_dingtalk_intakes').where({ status: 'analyzing' });
  for (const row of rows) await db.transaction(async trx => {
    await lockIntake(trx, row.id);
    const lock = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS acquired', ['joint-analysis:' + row.id]);
    if (!lock.rows[0].acquired) return;
    const current = await trx('la_dingtalk_intakes').where({ id: row.id, status: 'analyzing' }).first();
    if (current) await scheduleAnalysis(trx, current, current.recipient_id);
  });
}
async function readDocument(db, entry, { parser = parseDocument, convert } = {}) {
  let v = await db('la_versions').where({ id: entry.versionId, contract_id: entry.contractId, sha256: entry.sha256 }).first();
  if (!v) fail(409, 'JOINT_DOCUMENT_UNAVAILABLE', '本次联合审查的文件版本不可核实');
  const original = await storage.read(v.storage_key);
  if (storage.sha256(original) !== entry.sha256) fail(409, 'FILE_INTEGRITY', `文件校验未通过：${v.filename}`);
  if (!v.parsed && needsConversion(v.filename)) v = await ensureConverted(db, v, { convert });
  const stale = (v.filename.toLowerCase().endsWith('.docx') || v.conversion?.artifacts?.docx) && String(v.parsed?.parserVersion || '').startsWith('structured-') && v.parsed.parserVersion !== parserVersion;
  const parsed = !stale && v.parsed || (needsConversion(v.filename) ? await parseConverted(v, parser) : await require('./pdf-layout').parseVersion(db, v, parser));
  if (!v.parsed || stale) await persistDocument(db, v, parsed);
  if (!parsed.blocks?.some(b => b.text?.trim())) fail(422, 'JOINT_DOCUMENT_EMPTY', `文件未识别到正文：${v.filename}，请补传可读取版本或排除`);
  return { ...entry, blocks: parsed.blocks, warnings: parsed.warnings || [], requiresHumanVerification: !!parsed.requiresHumanVerification };
}
async function scheduleAnalysis(db, intake, actorId) {
  const token = randomUUID();
  const row = intake.container_id ? intake : await db('la_dingtalk_intakes').where({ id: intake.id }).first();
  const container = row && await db('la_contracts').where({ id: row.container_id }).first();
  if (container) await db('la_contracts').where({ id: container.id }).update({ source_data: JSON.stringify({ ...container.source_data, jointHidden: false }) });
  await db('la_dingtalk_intakes').where({ id: intake.id }).update({ status: 'queued', analysis_token: token, error: null, revision: db.raw('revision + 1'), updated_at: db.fn.now() });
  await db('la_outbox').insert({ id: randomUUID(), queue: 'intake-analysis', payload: JSON.stringify({ intakeId: intake.id, token, actorId }) });
}
async function invalidateDocument(db, c, actorId) {
  if (!c.source_data?.jointDocumentId) return;
  await db('la_dingtalk_intakes').where({ id: c.source_data.jointIntakeId }).update({ revision: db.raw('revision + 1'), updated_at: db.fn.now() });
  const rows = await db('la_review_group_documents as l').join('la_review_groups as g', 'g.id', 'l.group_id').where({ 'l.document_id': c.source_data.jointDocumentId, 'g.active': true }).select('g.*');
  for (const group of rows) {
    const d = await db('la_intake_documents').where({ id: group.main_document_id }).first();
    let main = await db('la_contracts').where({ id: d.contract_id }).first();
    await db('la_contracts').where({ id: main.id }).update({ current_preanalysis_id: null, current_review_id: null, legal_status: 'pending_review', classification: main.classification ? JSON.stringify({ ...main.classification, confirmed: false, perspectiveConfirmed: false }) : null, revision: db.raw('revision + 1') });
    await db('la_review_groups').where({ id: group.id }).update({ revision: db.raw('revision + 1'), updated_at: db.fn.now() });
    const intake = await db('la_dingtalk_intakes').where({ id: group.intake_id }).first();
    if (intake.status === 'confirmed') {
      main = await db('la_contracts').where({ id: main.id }).first();
      await require('./workflow').enqueueReview(db, main, actorId);
    }
  }
}
async function collect(db, { connection, account, instanceId, event, detail: approval, files, api, signature, summary }) {
  const { dingConfig, fingerprint } = require('./settings');
  let intake = await db('la_dingtalk_intakes').where({ client_id: connection.clientId, instance_id: instanceId, recipient_id: account.user_id }).first();
  if (!intake) {
    intake = await db.transaction(async trx => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['joint-source:' + digest([connection.clientId, instanceId, account.user_id])]);
      const existing = await trx('la_dingtalk_intakes').where({ client_id: connection.clientId, instance_id: instanceId, recipient_id: account.user_id }).first(); if (existing) return existing;
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['settings:dingtalk_connection']);
      const actor = await trx('la_users').where({ id: account.user_id, active: true }).forShare().first();
      const binding = await trx('la_dingtalk_accounts').where({ user_id: account.user_id, client_id: connection.clientId, ding_user_id: account.ding_user_id }).forShare().first();
      if (fingerprint(await dingConfig(trx)) !== signature) fail(409, 'DING_CHANGED', '钉钉连接已变更');
      if (!binding || !hasRole(actor, 'business', 'legal')) fail(403, 'DING_UNBOUND', '接收账号已停用或解绑');
      const identity = { client_id: connection.clientId, instance_id: instanceId, recipient_id: account.user_id };
      let mode = await trx('la_dingtalk_intake_modes').where(identity).first();
      if (!mode) {
        const flag = await settings(trx);
        const legacy = await trx('la_contracts').where({ source: 'dingtalk', submitter_id: account.user_id }).whereRaw("source_data->>'processInstanceId' = ? AND source_data->>'jointIntakeId' IS NULL", [instanceId]).whereRaw("(source_data->>'clientId' IS NULL OR source_data->>'clientId' = ?)", [connection.clientId]).first();
        const oldEvent = flag.enabledAt && await trx('la_integration_events').where({ client_id: connection.clientId }).whereRaw("COALESCE(payload->>'processInstanceId', payload->>'ProcessInstanceId') = ?", [instanceId]).where('created_at', '<', flag.enabledAt).first();
        mode = { ...identity, mode: legacy || oldEvent ? 'legacy' : process.env.AUTO_REVIEW_DINGTALK_ENABLED !== 'false' ? 'auto' : flag.enabled ? 'joint' : 'legacy' }; await trx('la_dingtalk_intake_modes').insert(mode);
      }
      if (mode.mode === 'legacy') return null;
      const id = randomUUID(), containerId = randomUUID();
      const reconciliation = event.event_type === 'reconciliation';
      await trx('la_contracts').insert({ id: containerId, number: 'DD-' + id.slice(0, 8).toUpperCase(), title: approval.title || '钉钉审批附件待确认', submitter_id: actor.id, department: actor.department, reviewer_id: actor.id, source: 'dingtalk', intake_mode: reconciliation ? 'reconciliation' : 'live', intake_review_status: reconciliation ? 'pending' : 'confirmed', source_data: JSON.stringify({ processInstanceId: instanceId, title: approval.title, jointContainer: true, jointIntakeId: id }) });
      return (await trx('la_dingtalk_intakes').insert({ id, client_id: connection.clientId, instance_id: instanceId, recipient_id: actor.id, container_id: containerId }).returning('*'))[0];
    });
    if (!intake) return false;
  }
  let membershipChanged = false;
  const known = await db('la_intake_documents').where({ intake_id: intake.id });
  for (const old of known.filter(d => d.present && !d.file_id.startsWith('manual:') && !files.some(f => f.fileId === d.file_id))) {
    await db.transaction(async trx => { await lockIntake(trx, intake.id); await trx('la_intake_documents').where({ id: old.id }).update({ present: false }); await trx('la_dingtalk_intakes').where({ id: intake.id }).update({ status: 'collecting', revision: trx.raw('revision + 1') }); }); membershipChanged = true;
  }
  for (const file of files) {
    let doc = await db('la_intake_documents').where({ intake_id: intake.id, file_id: file.fileId }).first();
    if (!doc) {
      await db.transaction(async trx => { await lockIntake(trx, intake.id); await trx('la_intake_documents').insert({ id: randomUUID(), intake_id: intake.id, file_id: file.fileId, filename: file.fileName, field: file.field, status: isSupported(file.fileName) ? 'pending' : 'unsupported', error: isSupported(file.fileName) ? null : '格式不支持，请补传支持的格式或说明排除原因' }).onConflict(['intake_id', 'file_id']).ignore(); await trx('la_dingtalk_intakes').where({ id: intake.id }).update({ status: 'collecting', revision: trx.raw('revision + 1') }); });
      doc = await db('la_intake_documents').where({ intake_id: intake.id, file_id: file.fileId }).first(); membershipChanged = true;
    }
    if (!isSupported(file.fileName)) { if (!doc.present) membershipChanged = true; await db('la_intake_documents').where({ id: doc.id }).update({ present: true, filename: file.fileName, status: 'unsupported', error: '格式不支持，请补传支持的格式或说明排除原因' }); continue; }
    try {
      const buffer = await api.attachment(instanceId, file), upload = { originalname: file.fileName, buffer }; storage.validateUpload(upload);
      const duplicate = await db.transaction(async trx => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['settings:dingtalk_connection']);
        if (fingerprint(await dingConfig(trx)) !== signature) fail(409, 'DING_CHANGED', '钉钉连接已变更');
        const binding = await trx('la_dingtalk_accounts').where({ user_id: account.user_id, client_id: connection.clientId, ding_user_id: account.ding_user_id }).forShare().first();
        const actor = await trx('la_users').where({ id: account.user_id, active: true }).forShare().first();
        if (!binding || !hasRole(actor, 'business', 'legal')) fail(403, 'DING_UNBOUND', '接收账号已解绑或停用');
        await lockIntake(trx, intake.id);
        const current = await trx('la_intake_documents').where({ id: doc.id }).first();
        const hash = storage.sha256(buffer);
        if (current.remote_sha256 === hash && current.contract_id) { await trx('la_intake_documents').where({ id: doc.id }).update({ present: true, status: 'collected', error: null }); return true; }
        const { createContract, addVersion } = require('./contracts');
        let result;
        await trx('la_intake_documents').where({ id: doc.id }).update({ status: 'collected', present: true, error: null });
        if (current.contract_id) result = await addVersion(trx, await trx('la_contracts').where({ id: current.contract_id }).first(), upload, actor.id, 'dingtalk');
        else result = await createContract(trx, actor, upload, { source: 'dingtalk', guidedReview: true, sourceData: { processInstanceId: instanceId, clientId: connection.clientId, title: approval.title, jointIntakeId: intake.id, jointDocumentId: doc.id, jointHidden: true } });
        await trx('la_intake_documents').where({ id: doc.id }).update({ contract_id: current.contract_id || result.contract.id, remote_sha256: hash, status: 'collected', present: true, filename: file.fileName, error: null, updated_at: trx.fn.now() });
        return false;
      });
      summary[duplicate ? 'duplicate' : 'collected']++;
      if (!doc.present) membershipChanged = true;
    } catch (error) {
      summary.failed++; summary.lastError = error.code ? error.code + ': ' + error.message : '附件读取失败，请重试';
      await db.transaction(async trx => { await lockIntake(trx, intake.id); await trx('la_intake_documents').where({ id: doc.id }).update({ status: 'failed', error: summary.lastError, updated_at: trx.fn.now() }); await trx('la_dingtalk_intakes').where({ id: intake.id }).update({ status: 'collecting', revision: trx.raw('revision + 1') }); }); membershipChanged = true;
    }
  }
  const mode = await db('la_dingtalk_intake_modes').where({ client_id: intake.client_id, instance_id: intake.instance_id, recipient_id: intake.recipient_id }).first();
  if (mode?.mode === 'auto') {
    await require('./auto-review-batch').ensureBatchFromIntake(db, intake.id);
    return true;
  }
  await db.transaction(async trx => {
    await lockIntake(trx, intake.id); const current = await trx('la_dingtalk_intakes').where({ id: intake.id }).first();
    if (membershipChanged || current.status !== 'confirmed') {
      const c = await trx('la_contracts').where({ id: intake.container_id }).first();
      await trx('la_contracts').where({ id: c.id }).update({ source_data: JSON.stringify({ ...c.source_data, jointHidden: false }), updated_at: trx.fn.now() });
      await scheduleAnalysis(trx, current, account.user_id);
    }
  });
  return true;
}
function validateGroups(raw, docs, complete = false) {
  const value = groupSchema.parse(raw), used = new Set(), mains = new Set(), excluded = new Set();
  for (const group of value.groups) {
    if (mains.has(group.mainDocumentId)) fail(400, 'DUPLICATE_MAIN', '同一文件不能作为多组主合同'); mains.add(group.mainDocumentId);
    const members = [{ documentId: group.mainDocumentId, role: 'main' }, ...group.materials];
    if (new Set(members.map(m => m.documentId)).size !== members.length) fail(400, 'DUPLICATE_MATERIAL', '同组不能重复选择同一文件');
    for (const member of members) {
      const doc = docs.find(d => d.id === member.documentId); if (!doc) fail(400, 'FOREIGN_DOCUMENT', '只能选择同一审批收件中的附件');
      if (complete && (!doc.present || doc.status !== 'collected' || !doc.version?.parsed?.blocks?.some(b => b.text?.trim()))) fail(409, 'JOINT_DOCUMENT_UNAVAILABLE', '选入的附件尚未成功读取，请重试、补传或明确排除');
      used.add(doc.id);
    }
  }
  for (const item of value.excluded) {
    if (!docs.some(d => d.id === item.documentId) || used.has(item.documentId) || excluded.has(item.documentId)) fail(400, 'INVALID_EXCLUSION', '排除文件不存在、重复或已参与审查'); excluded.add(item.documentId);
  }
  if (complete && (!value.groups.length || docs.some(d => !used.has(d.id) && !excluded.has(d.id)))) fail(400, 'UNASSIGNED_DOCUMENTS', '每份附件须归入合同组或填写排除原因');
  return value;
}
async function analyze(db, id, token, { gateway, parser, convert } = {}) {
  let intake = await db('la_dingtalk_intakes').where({ id }).first(); if (!intake || intake.analysis_token !== token || intake.status === 'confirmed') return;
  const connection = await db.client.acquireConnection();
  const profiles = [], sources = [], calls = [], trace = async details => { calls.push(details); };
  try {
    await db.raw('SELECT pg_advisory_lock(hashtext(?))', ['joint-analysis:' + id]).connection(connection);
    intake = await db('la_dingtalk_intakes').where({ id }).first(); if (intake.analysis_token !== token || intake.status === 'confirmed') return;
    await db('la_dingtalk_intakes').where({ id, analysis_token: token }).update({ status: 'analyzing', error: null });
    const provider = await providerConfig(db), pinned = publicModelSnapshot(provider), custom = !!gateway;
    gateway ||= createGateway(db, { pinnedModel: pinned });
    const docs = await documents(db, id);
    for (const doc of docs.filter(d => d.present && d.status === 'collected' && d.version)) {
      try {
        const source = await readDocument(db, { documentId: doc.id, contractId: doc.contract_id, versionId: doc.version.id, filename: doc.filename, sha256: doc.version.sha256 }, { parser, convert });
        sources.push(source);
        profiles.push({ documentId: doc.id, versionId: source.versionId, filename: doc.filename, blockCount: source.blocks.length });
      } catch (error) { profiles.push({ documentId: doc.id, filename: doc.filename, error: error.status ? error.message : '文件预分析失败，请重试', errorCode: error.code, diagnostics: error.diagnostics }); }
    }
    const suggestion = profiles.filter(p => !p.error).length ? await gateway.groupDocuments(profiles, sources, trace) : { groups: [], excluded: [], notes: '暂无可读取附件，请重试或补传。' };
    validateGroups(suggestion, docs);
    if (!custom) assertModelSnapshot(await providerConfig(db), pinned);
    await db('la_dingtalk_intakes').where({ id, analysis_token: token }).whereNot('status', 'confirmed').update({ status: 'ready', analysis: JSON.stringify({ ...suggestion, profiles, calls }), revision: db.raw('revision + 1'), error: null, updated_at: db.fn.now() });
  } catch (error) {
    await db('la_dingtalk_intakes').where({ id, analysis_token: token }).update({ status: 'failed', analysis: JSON.stringify({ profiles, calls, groups: [], excluded: [], diagnostics: error.diagnostics }), error: error.status ? error.message : '附件分组分析失败，可重试或手动分组', revision: db.raw('revision + 1'), updated_at: db.fn.now() });
  } finally { await db.raw('SELECT pg_advisory_unlock(hashtext(?))', ['joint-analysis:' + id]).connection(connection).catch(() => {}); await db.client.releaseConnection(connection); }
}
async function confirm(db, user, id, revision, raw) {
  return db.transaction(async trx => {
    const intake = await readIntake(trx, user, id, true); assertRevision(intake, revision);
    const docs = await documents(trx, id), value = validateGroups(raw || intake.draft || intake.analysis || {}, docs, true);
    const oldGroups = await trx('la_review_groups').where({ intake_id: id });
    await trx('la_dingtalk_intakes').where({ id }).update({ status: 'confirmed', draft: JSON.stringify(value), confirmed_selection: JSON.stringify(value), analysis_token: null, error: null, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
    // Retire omitted groups without deleting their historical reviews or decisions.
    for (const old of oldGroups.filter(g => !value.groups.some(g2 => g2.mainDocumentId === g.main_document_id))) await trx('la_review_groups').where({ id: old.id }).update({ active: false });
    for (const doc of docs.filter(d => d.contract_id)) {
      const c = await trx('la_contracts').where({ id: doc.contract_id }).first();
      await trx('la_contracts').where({ id: c.id }).update({ source_data: JSON.stringify({ ...c.source_data, jointHidden: true, jointGroupId: null }) });
    }
    const result = [];
    for (const chosen of value.groups) {
      const old = oldGroups.find(g => g.main_document_id === chosen.mainDocumentId), groupId = old?.id || randomUUID();
      const doc = docs.find(d => d.id === chosen.mainDocumentId);
      if (old) await trx('la_review_groups').where({ id: old.id }).update({ name: chosen.name, active: true, revision: trx.raw('revision + 1') });
      else await trx('la_review_groups').insert({ id: groupId, intake_id: id, main_document_id: chosen.mainDocumentId, name: chosen.name });
      await trx('la_review_group_documents').where({ group_id: groupId }).delete();
      await trx('la_review_group_documents').insert([{ group_id: groupId, document_id: doc.id, role: 'main' }, ...chosen.materials.map(m => ({ group_id: groupId, document_id: m.documentId, role: m.role }))]);
      let c = await trx('la_contracts').where({ id: doc.contract_id }).first();
      await trx('la_contracts').where({ id: c.id }).update({ source_data: JSON.stringify({ ...c.source_data, jointHidden: false, jointGroupId: groupId }) });
      c = await trx('la_contracts').where({ id: c.id }).first(); const current = await manifest(trx, c);
      let reviewId = c.current_review_id;
      if (!old?.active || old.confirmed_manifest?.hash !== current.hash) {
        await trx('la_contracts').where({ id: c.id }).update({ current_review_id: null, legal_status: 'pending_review' });
        reviewId = await require('./workflow').enqueueReview(trx, c, user.id);
      }
      await trx('la_review_groups').where({ id: groupId }).update({ confirmed_manifest: JSON.stringify(current), updated_at: trx.fn.now() });
      result.push({ groupId, contractId: c.id, reviewId });
    }
    const container = await trx('la_contracts').where({ id: intake.container_id }).first();
    await trx('la_contracts').where({ id: container.id }).update({ source_data: JSON.stringify({ ...container.source_data, jointHidden: true }) });
    await audit(trx, user, 'joint_intake.confirm', id, { groups: result.map(g => g.groupId), excluded: value.excluded });
    return result;
  });
}
function mountRoutes(r, db) {
  r.get('/dingtalk/intake-settings', requireRole('business', 'legal'), wrap(async (req, res) => res.json(await settings(db))));
  r.put('/dingtalk/intake-settings', requireRole('admin'), wrap(async (req, res) => {
    const enabled = z.boolean().parse(req.body.enabled);
    await db.transaction(async trx => { await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['joint-settings']); const old = await settings(trx); if ((old.updatedAt ? new Date(old.updatedAt).toISOString() : null) !== (req.body.updatedAt || null)) fail(409, 'REVISION_CONFLICT', '设置已更新，请刷新'); await trx('la_settings').insert({ key: 'dingtalk_joint_intakes', value: JSON.stringify({ enabled, enabledAt: old.enabledAt || (enabled ? new Date().toISOString() : null) }) }).onConflict('key').merge({ value: JSON.stringify({ enabled, enabledAt: old.enabledAt || (enabled ? new Date().toISOString() : null) }), updated_at: trx.fn.now() }); await audit(trx, req.user, 'joint_intake.settings', null, { enabled }); }); res.json(await settings(db));
  }));
  r.get('/dingtalk/intakes', wrap(async (req, res) => {
    const rows = await db('la_dingtalk_intakes').orderBy('updated_at', 'desc'); const result = [];
    for (const row of rows) { try { const c = await accessible(db, req.user, row.container_id); const auto = await db('la_auto_review_batches').where({ intake_id: row.id }).orderBy('created_at', 'desc').first(); result.push({ id: row.id, title: c.title, status: auto?.status || row.status, autoReviewBatchId: auto?.id || null, revision: row.revision, created_at: row.created_at }); } catch (e) { if (e.status !== 404) throw e; } }
    res.json(result);
  }));
  r.get('/dingtalk/intakes/:id', wrap(async (req, res) => res.json(await detail(db, req.user, req.params.id))));
  r.put('/dingtalk/intakes/:id/groups', requireRole('legal'), wrap(async (req, res) => {
    await db.transaction(async trx => { const intake = await readIntake(trx, req.user, req.params.id, true); assertRevision(intake, req.body.revision); const value = validateGroups(req.body.selection, await documents(trx, intake.id)); await trx('la_dingtalk_intakes').where({ id: intake.id }).update({ draft: JSON.stringify(value), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() }); }); res.json(await detail(db, req.user, req.params.id));
  }));
  r.post('/dingtalk/intakes/:id/confirm', requireRole('legal'), wrap(async (req, res) => res.json({ groups: await confirm(db, req.user, req.params.id, req.body.revision, req.body.selection) })));
  r.post('/dingtalk/intakes/:id/analyze', requireRole('legal'), wrap(async (req, res) => {
    await db.transaction(async trx => { const intake = await readIntake(trx, req.user, req.params.id, true); assertRevision(intake, req.body.revision); await scheduleAnalysis(trx, intake, req.user.id); }); res.status(202).json({ queued: true });
  }));
  r.post('/dingtalk/intakes/:id/retry', requireRole('legal'), wrap(async (req, res) => {
    const intake = await readIntake(db, req.user, req.params.id); assertRevision(intake, req.body.revision);
    await require('./dingtalk').persistEvent(db, { processInstanceId: intake.instance_id, eventType: 'joint_retry' }, 'joint-retry:' + randomUUID(), intake.client_id); res.status(202).json({ queued: true });
  }));
}
module.exports = { roles, groupSchema, settings, readIntake, detail, documents, manifest, assertCurrent, readDocument, collect, analyze, confirm, validateGroups, invalidateDocument, mountRoutes, lockIntake, reviewDocument, verifyReviewEvidence, recoverInterrupted, scheduleAnalysis };
