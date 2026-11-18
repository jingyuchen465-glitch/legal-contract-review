const path = require('node:path');
const AdmZip = require('adm-zip');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const { parseDocx } = require('./parser');
const { fail } = require('./errors');
const { groupFindings } = require('./finding-groups');
const { withReportEdits, suggestionForDisplay } = require('./report-edits');
const { wordText: textOf } = require('./word-text');

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const options = { preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false };
const parser = new XMLParser(options), builder = new XMLBuilder(options);
const element = (name, children = [], attrs = {}) => ({ [name]: children, ...(Object.keys(attrs).length ? { ':@': Object.fromEntries(Object.entries(attrs).map(([key, value]) => [`@_${key}`, String(value)])) } : {}) });
const children = (nodes, name) => nodes.find(node => name in node)?.[name];
const severityLabel = { high: '高风险', medium: '中风险', low: '低风险' };
const actionLabel = { accept: '法务采纳意见', correct: '法务修正意见', needs_information: '待补充信息', acknowledge: '已记录处理意见' };

function readXml(zip, name, fallback) {
  const xml = zip.getEntry(name) ? zip.readAsText(name) : fallback;
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) fail(422, 'INVALID_DOCX_XML', '合同中的 XML 无效，无法添加批注');
  return parser.parse(xml);
}
function paragraphs(nodes, result = []) {
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (!Array.isArray(value) || ['w:del', 'w:moveFrom'].includes(key)) continue;
    if (key === 'w:p') { if (textOf(value).trim()) result.push({ nodes, node, content: value }); }
    else paragraphs(value, result);
  }
  return result;
}
function paragraph(text, color) {
  const properties = color ? [element('w:color', [], { 'w:val': color }), element('w:rFonts', [], { 'w:ascii': 'Calibri', 'w:eastAsia': 'Microsoft YaHei' }), element('w:sz', [], { 'w:val': 20 })] : [];
  return element('w:p', [element('w:r', [...(properties.length ? [element('w:rPr', properties)] : []), element('w:t', [{ '#text': text }], { 'xml:space': 'preserve' })])]);
}
function noteLines(finding) {
  const severity = finding.disposition?.severity || finding.severity;
  return [
    `${severityLabel[severity] || '审查意见'} · ${finding.title}`,
    ...(finding.relatedFindings?.length > 1 ? [`合并相同意见，涉及检查项：${finding.relatedFindings.map(f => f.title).join('；')}`] : []),
    `判断理由：${finding.reason || '请法务核实'}`,
    `修改建议：${finding.disposition?.suggestion ?? finding.suggestion ?? '请法务补充处理意见'}`,
    `处理状态：${actionLabel[finding.disposition?.action] || 'AI 建议，待法务复核'}`,
    ...(finding.disposition?.reason ? [`法务意见：${finding.disposition.reason}`] : []),
  ];
}

// Add native comments to a copy of the original OOXML package. Other package
// parts (images, headers, styles, numbering and existing revisions) stay intact.
function annotatedContract(buffer, version, run, findings, mode = 'comments') {
  findings = groupFindings(withReportEdits(findings, run).map(finding => ({ ...finding, suggestion: suggestionForDisplay(finding) })));
  if (!version.filename?.toLowerCase().endsWith('.docx')) fail(422, 'ANNOTATION_DOCX_ONLY', '带批注原合同下载仅支持 DOCX；PDF 可在网页查看旁批');
  if (!['comments', 'color'].includes(mode)) fail(400, 'INVALID_ANNOTATION_MODE', '不支持的原文批注模式');
  if (run.status !== 'completed') fail(409, 'REVIEW_INCOMPLETE', '预审完成后才能下载带建议的原合同');
  const parsed = parseDocx(buffer), zip = new AdmZip(buffer);
  const document = readXml(zip, 'word/document.xml');
  const sourceParagraphs = paragraphs(document);
  if (sourceParagraphs.length !== parsed.blocks.length) fail(422, 'ANNOTATION_ANCHORS', '原文结构无法可靠定位，请下载原件和审核报告核查');
  const relationships = readXml(zip, 'word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  const rels = children(relationships, 'Relationships');
  const existingRel = rels?.find(node => node.Relationship && node[':@']?.['@_Type'] === COMMENTS);
  if (!rels || existingRel?.[':@']?.['@_TargetMode'] === 'External') fail(422, 'INVALID_COMMENTS_PART', '合同批注关系无效');
  const target = existingRel?.[':@']?.['@_Target'];
  const commentsPath = target ? path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('word', target)) : 'word/comments.xml';
  if (!commentsPath.startsWith('word/') || commentsPath.includes('\\')) fail(422, 'INVALID_COMMENTS_PART', '合同批注路径无效');
  if (!existingRel && zip.getEntry(commentsPath)) fail(422, 'INVALID_COMMENTS_PART', '合同包含未关联的批注文件，请先在 Word 中另存后重试');
  const comments = readXml(zip, commentsPath, `<w:comments xmlns:w="${WORD}"/>`);
  const commentNodes = children(comments, 'w:comments');
  if (!commentNodes) fail(422, 'INVALID_COMMENTS_PART', '合同已有批注格式暂不支持');
  // Existing comments may declare w locally. New nodes always have a binding.
  comments.find(node => 'w:comments' in node)[':@'] = { ...comments.find(node => 'w:comments' in node)[':@'], '@_xmlns:w': WORD };
  let nextId = 0;
  function collectIds(nodes) {
    for (const node of nodes) {
      if (['w:comment', 'w:commentReference', 'w:commentRangeStart', 'w:commentRangeEnd'].some(key => key in node)) {
        const id = Number(node[':@']?.['@_w:id']); if (Number.isSafeInteger(id) && id >= nextId) nextId = id + 1;
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) collectIds(value);
    }
  }
  collectIds(comments); collectIds(document);
  const byId = new Map(parsed.blocks.map((block, index) => [block.id, { block, paragraph: sourceParagraphs[index] }]));
  const storedById = new Map((version.parsed?.blocks || []).map(block => [block.id, block]));
  const first = sourceParagraphs[0], date = new Date().toISOString(), inserts = new Map();
  let located = 0, unlocated = 0;
  const locatedFindingIds = [], unlocatedFindingIds = [];
  const findingIds = finding => (finding.relatedFindings || [{ id: finding.id }]).map(item => item.id).filter(Boolean);
  function addNote(anchor, lines, color, inline = false) {
    const id = nextId++;
    commentNodes.push(element('w:comment', lines.flatMap(line => String(line).split(/\r?\n/).map(text => paragraph(text))), { 'w:id': id, 'w:author': 'AI 合同预审', 'w:initials': 'AI', 'w:date': date }));
    const pr = anchor.content.findIndex(node => 'w:pPr' in node);
    anchor.content.splice(pr === -1 ? 0 : pr + 1, 0, element('w:commentRangeStart', [], { 'w:id': id }));
    anchor.content.push(element('w:commentRangeEnd', [], { 'w:id': id }), element('w:r', [element('w:rPr', [element('w:rStyle', [], { 'w:val': 'CommentReference' })]), element('w:commentReference', [], { 'w:id': id })]));
    if (inline && mode === 'color') {
      const list = inserts.get(anchor) || [];
      for (const line of ['【审查建议 · 未改写合同正文】', ...lines]) for (const text of String(line).split(/\r?\n/)) list.push(paragraph(text, color));
      inserts.set(anchor, list);
    }
  }
  const modeNotice = run.snapshot?.reviewMode === 'trial' ? '【示例规则试审】内置参考规则未经公司法务发布确认，不能用于最终结论。' : 'AI 辅助预审意见，需法务复核。';
  addNote(first, ['全文审查说明', modeNotice, `文件版本：v${version.version_no}；预审记录：${run.id}`, run.automaticDraft ? '可靠定位且通过校验的正文修改以 Word 修订显示；其余意见以批注保留。全文意见及无法定位项挂在首段并明确标记。' : '正文未自动替换。批注按原文段落定位；全文意见及无法定位项挂在首段并明确标记。法务驳回的意见不导出。']);
  for (const finding of findings) {
    if (finding.check_status === 'pass' || finding.disposition?.action === 'reject') continue;
    const evidence = finding.evidence || [], anchors = new Map(), unmatched = [];
    for (const item of evidence) {
      const current = byId.get(item.blockId), stored = storedById.get(item.blockId);
      if (current && stored?.text === current.block.text && item.quote && current.block.text.includes(item.quote)) anchors.set(item.blockId, current.paragraph);
      else unmatched.push(item);
    }
    const lines = noteLines(finding), color = (finding.disposition?.severity || finding.severity) === 'high' ? 'B34438' : '245EAA';
    for (const [blockId, anchor] of anchors) { addNote(anchor, [...lines, `原文段落：${blockId}`], color, true); located++; }
    if (!anchors.size || unmatched.length) {
      const label = finding.kind === 'missing' && !evidence.length ? '全文意见 · 缺失条款，无原文位置' : '全文意见 · 原文位置待人工核实';
      addNote(first, [label, ...lines, ...unmatched.map(item => `未定位引用：${item.blockId}：${item.quote}`)], color, true); unlocated++;
    }
    const ids = findingIds(finding);
    if (anchors.size && !unmatched.length) locatedFindingIds.push(...ids);
    else unlocatedFindingIds.push(...ids);
  }
  for (const [anchor, additions] of inserts) anchor.nodes.splice(anchor.nodes.indexOf(anchor.node) + 1, 0, ...additions);
  if (!existingRel) {
    const ids = new Set(rels.map(node => node[':@']?.['@_Id'])); let id = 'rIdAIComments', n = 1;
    while (ids.has(id)) id = `rIdAIComments${n++}`;
    rels.push(element('Relationship', [], { Id: id, Type: COMMENTS, Target: 'comments.xml' }));
  }
  const types = readXml(zip, '[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const typeNodes = children(types, 'Types');
  if (!typeNodes) fail(422, 'INVALID_DOCX_XML', '合同缺少文件类型声明');
  if (!typeNodes.some(node => node.Override && node[':@']?.['@_PartName'] === `/${commentsPath}`)) typeNodes.push(element('Override', [], { PartName: `/${commentsPath}`, ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml' }));
  zip.updateFile('word/document.xml', Buffer.from(builder.build(document)));
  zip.addFile(commentsPath, Buffer.from(builder.build(comments)));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(builder.build(relationships)));
  zip.addFile('[Content_Types].xml', Buffer.from(builder.build(types)));
  return { buffer: zip.toBuffer(), located, unlocated, locatedFindingIds, unlocatedFindingIds };
}

module.exports = { annotatedContract };
