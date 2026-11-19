const AdmZip = require('adm-zip');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const { parseDocx } = require('./parser');
const { wordText } = require('./word-text');
const { editorDocument } = require('./office-document');
const { validateDraft } = require('./clause-drafts');
const { fail } = require('./errors');

const options = { preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false };
const element = (name, children = [], attrs = {}) => ({ [name]: children, ...(Object.keys(attrs).length ? { ':@': Object.fromEntries(Object.entries(attrs).map(([k, v]) => ['@_' + k, String(v)])) } : {}) });
const clone = value => structuredClone(value);

function paragraphs(nodes, result = []) {
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (!Array.isArray(value) || ['w:del', 'w:moveFrom'].includes(key)) continue;
    if (key === 'w:p') { if (wordText(value).trim()) result.push({ parent: nodes, node, content: value }); }
    else paragraphs(value, result);
  }
  return result;
}

// Write explicit OOXML revisions into a new immutable version. Never silently
// flatten fields, pictures, existing revisions or rich document structures.
function applyClauseRevisions(buffer, draft, author, date = new Date().toISOString(), maxEdits = 12) {
  const parsed = parseDocx(buffer);
  validateDraft(draft, parsed.blocks, undefined, maxEdits);
  const zip = new AdmZip(buffer), xml = zip.readAsText('word/document.xml');
  if (XMLValidator.validate(xml) !== true) fail(422, 'INVALID_DOCX_XML', '合同 XML 无效');
  const tree = new XMLParser(options).parse(xml), anchors = paragraphs(tree);
  if (anchors.length !== parsed.blocks.length) fail(422, 'DRAFT_ANCHOR', '段落结构无法可靠定位，请在编辑器中人工修改');
  let nextId = 0;
  function collect(nodes) {
    for (const node of nodes) {
      const id = Number(node[':@']?.['@_w:id']);
      if (Number.isSafeInteger(id) && id >= nextId) nextId = id + 1;
      for (const value of Object.values(node)) if (Array.isArray(value)) collect(value);
    }
  }
  collect(tree);
  const revision = (name, nodes) => element(name, nodes, { 'w:id': nextId++, 'w:author': author, 'w:date': date });
  for (const edit of draft.edits) {
    const index = parsed.blocks.findIndex(b => b.id === edit.blockId), anchor = anchors[index];
    const props = anchor.content.find(n => 'w:pPr' in n);
    const runProps = anchor.content.find(n => n['w:r']?.some(c => 'w:rPr' in c))?.['w:r'].find(n => 'w:rPr' in n);
    const runs = () => [element('w:r', [...(runProps ? [clone(runProps)] : []), ...edit.newText.split(/\r?\n/).flatMap((line, i) => [...(i ? [element('w:br')] : []), element('w:t', [{ '#text': line }], { 'xml:space': 'preserve' })])])];
    if (edit.operation === 'insert_after') {
      anchor.parent.splice(anchor.parent.indexOf(anchor.node) + 1, 0, element('w:p', [...(props ? [clone(props)] : []), revision('w:ins', runs())]));
      continue;
    }
    const allowed = new Set(['w:pPr', 'w:r', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:proofErr']);
    const allowedRun = new Set(['w:rPr', 'w:t', 'w:tab', 'w:br', 'w:cr', 'w:commentReference']);
    if (anchor.content.some(n => Object.keys(n).some(k => k !== ':@' && !allowed.has(k))) || anchor.content.some(n => n['w:r']?.some(c => Object.keys(c).some(k => k !== ':@' && !allowedRun.has(k))))) fail(422, 'DRAFT_COMPLEX_PARAGRAPH', '该条款含未处理修订、域或复杂对象，请在 Word 中核实后人工修改；其他内容已保留');
    const oldRuns = [], markers = [];
    for (const node of anchor.content) {
      if ('w:pPr' in node) continue;
      if (!node['w:r'] || node['w:r'].some(c => 'w:commentReference' in c)) { markers.push(clone(node)); continue; }
      const run = clone(node);
      for (const part of run['w:r']) if ('w:t' in part) { part['w:delText'] = part['w:t']; delete part['w:t']; }
      oldRuns.push(run);
    }
    anchor.node['w:p'] = [...(props ? [clone(props)] : []), ...markers.filter(n => n['w:commentRangeStart'] || n['w:bookmarkStart']), revision('w:del', oldRuns), ...(edit.operation === 'replace' ? [revision('w:ins', runs())] : []), ...markers.filter(n => !n['w:commentRangeStart'] && !n['w:bookmarkStart'])];
  }
  zip.updateFile('word/document.xml', Buffer.from(new XMLBuilder(options).build(tree)));
  return editorDocument(zip.toBuffer(), { filename: '修订稿.docx' });
}

module.exports = { applyClauseRevisions };
