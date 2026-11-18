const { randomUUID } = require('node:crypto');
const storage = require('./storage');
const { fail } = require('./errors');
const { parseDocx } = require('./parser');
const { annotatedContract } = require('./annotated-contract');
function scopeFindings(findings, versionId) {
  return findings.filter(f => f.check_status !== 'pass' && f.status !== 'pass' &&
    (!(f.evidence || []).length && !(f.edits || []).length || [...(f.evidence || []), ...(f.edits || [])].some(e => e.versionId === versionId)));
}

// Structured edits are proposals only. Automatic review always annotates the
// original package; applying a clause requires the separate human draft flow.
function draftDocument(buffer, version, run, findings) {
  const notes = scopeFindings(findings, version.id).map(f => ({ ...f,
    edits: (f.edits || []).filter(e => e.versionId === version.id),
    evidence: (f.evidence || []).filter(e => e.versionId === version.id),
  }));
  const annotated = annotatedContract(buffer, { ...version, filename: '合同.docx' }, { ...run, automaticDraft: false }, notes, 'comments');
  const unlocated = new Set(annotated.unlocatedFindingIds);
  const unresolved = notes.filter(f => unlocated.has(f.id)).map(f => ({ findingId: f.id, title: f.title, reason: '原文位置待人工核实，意见已保留在首段批注' }));
  return { buffer: annotated.buffer, locatedFindingIds: annotated.locatedFindingIds, unlocatedFindingIds: annotated.unlocatedFindingIds, unresolved, outputMode: 'comments_only', editCount: 0 };
}
function reportFindings(report, stored) {
  const remaining = [...stored];
  return report.findings.map((f, index) => {
    const n = remaining.findIndex(s => s.title === f.title && s.reason === f.reason && JSON.stringify(s.evidence) === JSON.stringify(f.evidence));
    const row = n >= 0 ? remaining.splice(n, 1)[0] : null;
    return { ...f, id: row?.id || `report-${index}`, check_status: f.status, disposition: row?.disposition };
  });
}
async function wordSource(db, v, options) {
  const original = await storage.read(v.storage_key);
  if (storage.sha256(original) !== v.sha256) fail(409, 'FILE_INTEGRITY', '原件完整性校验失败');
  if (/\.docx$/i.test(v.filename)) return original;
  let artifact;
  if (/\.pdf$/i.test(v.filename)) {
    const { config } = require('./config');
    let job = await db('la_word_conversions').where({ version_id: v.id }).orderBy('created_at', 'desc').first();
    if (!job?.artifacts?.docx && config.pdfWord.enabled) {
      const extraction = await require('./pdf-layout').extractionFor(db, v);
      if (!job) { job = { id: randomUUID(), version_id: v.id, extraction_id: extraction.id, created_by: options.actorId, status: 'queued', completed_pages: 0 }; await db('la_word_conversions').insert(job); }
      await require('./word-conversions').processWordConversion(db, job.id, options);
      job = await db('la_word_conversions').where({ id: job.id }).first();
    }
    if (job?.status !== 'completed') fail(422, 'AUTO_WORD_CONVERSION', job?.error_message || 'PDF 转 Word 未通过内容与版式核验，本文件仅提供报告');
    artifact = job.artifacts.docx;
  } else {
    const converted = await require('./conversion').ensureConverted(db, v, options);
    artifact = converted.conversion?.artifacts?.docx;
  }
  if (!artifact) fail(422, 'AUTO_WORD_UNAVAILABLE', '现有转换服务未生成可可靠修改的 DOCX，本文件仅提供报告');
  const bytes = await storage.read(artifact.storage_key);
  if (storage.sha256(bytes) !== artifact.sha256) fail(409, 'FILE_INTEGRITY', '转换文件完整性校验失败');
  return bytes;
}
async function generate(db, batch, run, active, options = {}) {
  const findings = reportFindings(run.agent_result, await db('la_findings').where({ review_id: run.id }));
  const docs = await db('la_auto_review_batch_documents').where({ batch_id: batch.id }).orderBy('created_at').orderBy('id');
  const result = [];
  if (!await db('la_auto_review_artifacts').where({ batch_id: batch.id, review_id: run.id, kind: 'report' }).first()) {
    await db.transaction(async trx => { await active(trx); await trx('la_auto_review_artifacts').insert({ id: randomUUID(), batch_id: batch.id, review_id: run.id, kind: 'report', filename: storage.safeName((batch.result.title || '自动评审') + '_审查报告.html') }); });
  }
  for (const d of docs) {
    await active();
    const old = await db('la_auto_review_artifacts').where({ batch_id: batch.id, review_id: run.id, batch_document_id: d.id }).first();
    if (old && (old.status === 'ready' || old.kind === 'tracked_revisions')) { result.push(old); continue; }
    const fileReport = { summary: run.agent_result.summary, findings: d.ingest_status === 'ready' ? scopeFindings(findings,d.version_id) : [], limitation: d.error_message || null };
    const artifact = { id: old?.id || randomUUID(), batch_id: batch.id, batch_document_id: d.id, review_id: run.id, source_version_id: d.version_id, kind: 'annotated_comments', filename: storage.safeName(d.filename.replace(/\.[^.]+$/, '') + '_批注建议稿.docx'), status: 'report_only', error_message: null, details: { report:fileReport, outputMode: 'comments_only', editCount: 0 }, located_finding_ids: [], unlocated_finding_ids: [] };
    try {
      if (!d.version_id || d.ingest_status !== 'ready') fail(422, 'AUTO_FILE_UNAVAILABLE', d.error_message || '文件未读取，无法生成改稿');
      const v = await db('la_versions').where({ id: d.version_id, sha256: d.sha256 }).first();
      if (!v) fail(409, 'FILE_INTEGRITY', '原件版本或哈希不匹配');
      const bytes = await wordSource(db, v, { ...options, actorId: batch.owner_id }); await active();
      const drafted = draftDocument(bytes, v, run, findings);
      const id = randomUUID(), key = await storage.put(drafted.buffer, v.contract_id, id, artifact.filename); await active();
      artifact.status = 'ready'; artifact.version_id = id;
      artifact.located_finding_ids = drafted.locatedFindingIds; artifact.unlocated_finding_ids = drafted.unlocatedFindingIds;
      artifact.details = { report:fileReport, sourceSha256: d.sha256, outputMode: drafted.outputMode, editCount: drafted.editCount, unresolved: drafted.unresolved, converted: !/\.docx$/i.test(v.filename) };
      await db.transaction(async trx => {
        // Match cancellation's row lock before publishing any version or artifact.
        await trx('la_auto_review_batches').where({ id: batch.id }).forUpdate().first(); await active(trx);
        await trx('la_contracts').where({ id: v.contract_id }).forUpdate().first();
        const max = await trx('la_versions').where({ contract_id: v.contract_id }).max('version_no as n').first();
        await trx('la_versions').insert({ id, contract_id: v.contract_id, version_no: Number(max.n || 0) + 1, parent_id: v.id, kind: 'contract', filename: artifact.filename, sha256: storage.sha256(drafted.buffer), storage_key: key, media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: drafted.buffer.length, source_action: 'auto_review_comments', created_by: batch.owner_id, parsed: JSON.stringify(parseDocx(drafted.buffer)) });
        await save(trx, artifact, old);
      });
    } catch (e) {
      await active();
      if (e.code === 'FILE_INTEGRITY') throw e;
      delete artifact.version_id;
      artifact.error_message = e.code ? e.message : '批注生成失败，本文件仍保留报告'; artifact.details = { report:fileReport, sourceSha256: d.sha256, outputMode: 'comments_only', editCount: 0 };
      await db.transaction(async trx => { await trx('la_auto_review_batches').where({ id: batch.id }).forUpdate().first(); await active(trx); await save(trx, artifact, old); });
    }
    result.push(artifact);
  }
  return result;
}
async function save(db, artifact, old) {
  const row = { ...artifact, details: JSON.stringify(artifact.details), located_finding_ids: JSON.stringify(artifact.located_finding_ids), unlocated_finding_ids: JSON.stringify(artifact.unlocated_finding_ids) };
  if (old) await db('la_auto_review_artifacts').where({ id: old.id }).update({ ...row, updated_at: db.fn.now() });
  else await db('la_auto_review_artifacts').insert(row);
}
function reportHtml(contract, version, run, findings) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = { amendments:'补充条款', amounts_terms:'金额与期限', precedence:'适用顺序' };
  const documents = run.snapshot.documents || [], plan = run.snapshot.autoReviewPlan || {};
  const section = `<section><h2>自动评审批次与全部材料</h2><p>批次：${escape(run.snapshot.autoReviewBatchId)}</p><ul>${documents.map(d=>`<li>${escape(d.filename)} · ${escape(d.versionId)} · SHA-256 ${escape(d.sha256)}</li>`).join('')}${(run.snapshot.unavailableDocuments||[]).map(d=>`<li>未读取：${escape(d.filename)}：${escape(d.reason)}</li>`).join('')}</ul><h2>执行计划与材料角色</h2><pre>${escape(JSON.stringify(plan,null,2))}</pre><h2>跨文件核对</h2>${(run.agent_result.crossDocumentReview||[]).map(row=>`<h3>${labels[row.category]} · ${escape(row.status)}</h3><p>${escape(row.reason)}</p>${row.evidence.map(e=>`<blockquote>${escape(documents.find(d=>d.versionId===e.versionId)?.filename)} / ${escape(e.blockId)}：${escape(e.quote)}</blockquote>`).join('')}`).join('')}<h2>观察与质量门</h2><pre>${escape(JSON.stringify(run.snapshot.autoReviewQualityGate||{},null,2))}</pre></section>`;
  return require('./reports').htmlReport(contract,version,run,findings,null).replace('</html>',section+'</html>');
}
module.exports = { draftDocument, generate, reportHtml };
