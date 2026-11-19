const AdmZip = require('adm-zip');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const { diffArrays, diffChars } = require('diff');
const { parseDocx } = require('./parser');
const { wordText } = require('./word-text');
const { fail } = require('./errors');

const options = { preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false, processEntities: true };
const normal = text => String(text || '').replace(/\s+/gu, ' ').trim();
const attrs = node => node?.[':@'] || {};
function elements(nodes, name, result = []) {
  for (const node of nodes || []) for (const [key, value] of Object.entries(node)) {
    if (key === name) result.push(node);
    else if (Array.isArray(value)) elements(value, name, result);
  }
  return result;
}
function readXml(zip, name) {
  if (!zip.getEntry(name)) return [];
  const xml = zip.readAsText(name);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail(422, 'INVALID_DOCX_XML', '审阅文件含不支持的 XML 实体');
  return new XMLParser(options).parse(xml);
}
function originalText(nodes) {
  return (nodes || []).map(node => Object.entries(node).map(([key, value]) => {
    if (['w:ins', 'w:moveTo', 'w:instrText'].includes(key)) return '';
    if (['w:t', 'w:delText'].includes(key)) return value.map(n => n['#text'] ?? '').join('');
    if (key === 'w:tab') return '\t';
    if (key === 'w:br' || key === 'w:cr') return '\n';
    return Array.isArray(value) ? originalText(value) : '';
  }).join('')).join('');
}

// Read the actual saved package, including markup that is invisible in the
// current-text view. Document text and authors are evidence, never instructions.
function snapshot(buffer) {
  const parsed = parseDocx(buffer), zip = new AdmZip(buffer);
  const paragraphs = elements(readXml(zip, 'word/document.xml'), 'w:p').map((node, index) => {
    const content = node['w:p'];
    const revisions = ['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'].flatMap(type => elements(content, type).map(r => ({
      type, id: attrs(r)['@_w:id'], author: attrs(r)['@_w:author'] || '', text: wordText(r[type]),
    })));
    return { index, paraId: attrs(node)['@_w14:paraId'] || null, text: wordText(content).trim(), original: originalText(content).trim(), revisions };
  });
  const relations = elements(readXml(zip, 'word/_rels/document.xml.rels'), 'Relationship');
  function part(type, fallback) {
    const relation = relations.find(r => String(attrs(r)['@_Type']).endsWith('/' + type));
    if (!relation) return fallback;
    if (attrs(relation)['@_TargetMode'] === 'External') fail(422, 'INVALID_XML', '批注资源不能是外部文件');
    const target = String(attrs(relation)['@_Target'] || '').replace(/\\/g, '/');
    const name = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'word/' + target);
    if (name.startsWith('../')) fail(422, 'INVALID_XML', '批注资源路径无效');
    return name;
  }
  const extended = elements(readXml(zip, part('commentsExtended', 'word/commentsExtended.xml')), 'w15:commentEx');
  const native = elements(readXml(zip, part('comments', 'word/comments.xml')), 'w:comment');
  const comments = parsed.originalComments.map(c => {
    const node = native.find(n => String(attrs(n)['@_w:id']) === c.id);
    const pids = elements(node?.['w:comment'], 'w:p').map(p => attrs(p)['@_w14:paraId']).filter(Boolean);
    const extra = extended.find(e => pids.includes(attrs(e)['@_w15:paraId']));
    return { ...c, paraIds: pids, parentParaId: attrs(extra)['@_w15:paraIdParent'] || null, resolved: ['1', 'true'].includes(String(attrs(extra)['@_w15:done'])) };
  });
  return { paragraphs, comments };
}
const revisionKey = r => JSON.stringify([r.type, normal(r.text), r.author]);
function counts(items, key) {
  const result = new Map();
  for (const item of items) { const k = key(item); result.set(k, (result.get(k) || 0) + 1); }
  return result;
}
function changedParagraphs(before, after) {
  const a = before.map(p => p.text).filter(Boolean), b = after.map(p => p.text).filter(Boolean);
  // Cancel moved/unchanged occurrences, retaining multiplicity for duplicates.
  const old = counts(a, x => x), next = counts(b, x => x);
  const removed = [], added = [];
  for (const [text, n] of old) for (let i = next.get(text) || 0; i < n; i++) removed.push(text);
  for (const [text, n] of next) for (let i = old.get(text) || 0; i < n; i++) added.push(text);
  const changes = diffArrays(a, b).filter(d => d.added || d.removed).map(d => ({ kind: d.added ? 'added' : 'removed', texts: d.value }));
  // Minimal fragments prevent untouched AI clauses in a changed paragraph
  // from masquerading as a new human contribution.
  const fragments = diffChars(removed.join('\n'), added.join('\n')).filter(d => d.added || d.removed).map(d => ({ kind: d.added ? 'added' : 'removed', text: d.value })).filter(d => d.text.trim());
  return { removed, added, fragments, context: changes };
}

function compare(before, after, actions = [], reason = '') {
  const body = changedParagraphs(before.paragraphs, after.paragraphs);
  const remaining = counts(after.paragraphs.flatMap(p => p.revisions), revisionKey);
  const initial = counts(before.paragraphs.flatMap(p => p.revisions), revisionKey);
  const decisions = [], unresolved = [];
  const locate = p => {
    const exact = after.paragraphs.filter(q => p.paraId && q.paraId === p.paraId);
    if (exact.length === 1) return exact[0];
    // Exporters may regenerate paragraph IDs. Text fallback must be unique;
    // paragraph order alone cannot prove which clause was accepted.
    const matches = after.paragraphs.filter(q => normal(q.text) === normal(p.text) || normal(q.text) === normal(p.original));
    return matches.length === 1 ? matches[0] : null;
  };
  for (const p of before.paragraphs.filter(p => p.revisions.length)) {
    // Ambiguous duplicate revisions are deliberately not assigned a decision.
    const gone = p.revisions.every(r => !remaining.get(revisionKey(r)) && initial.get(revisionKey(r)) === 1);
    if (!gone) continue;
    const q = locate(p);
    const insertedText = p.revisions.filter(r => r.type === 'w:ins').map(r => r.text).join('');
    const deletedText = p.revisions.filter(r => r.type === 'w:del').map(r => r.text).join('');
    const moved = p.revisions.some(r => ['w:moveFrom', 'w:moveTo'].includes(r.type));
    const action = !moved && q && normal(p.text) !== normal(p.original)
      ? normal(q.text) === normal(p.text) ? 'accept' : normal(q.text) === normal(p.original) ? 'reject' : null : null;
    if (action) decisions.push({ action, paragraph: p.index + 1, before: p.original, proposed: p.text, saved: q.text, insertedText, deletedText });
    else unresolved.push({ paragraph: p.index + 1, message: '修订标记发生变化，无法仅凭文件确定逐项接受或拒绝；不能推定认可。' });
  }
  // Optional UI actions help identify individual decisions within a paragraph.
  // They are accepted only when the original native revision and final text
  // corroborate them; undo restores markup and automatically excludes them.
  for (const a of actions) {
    if (!['accept', 'reject'].includes(a.action) || (!a.insertedText && !a.deletedText)) continue;
    const matches = before.paragraphs.filter(p => {
      const revisions = p.revisions.filter(r => ['w:ins', 'w:del'].includes(r.type));
      return (!a.insertedText || revisions.some(r => r.type === 'w:ins' && normal(r.text) === normal(a.insertedText)))
        && (!a.deletedText || revisions.some(r => r.type === 'w:del' && normal(r.text) === normal(a.deletedText)));
    });
    if (matches.length !== 1) continue;
    const p = matches[0];
    if (decisions.some(d => d.paragraph === p.index + 1 && (normal(d.insertedText) === normal(a.insertedText) && normal(d.deletedText) === normal(a.deletedText)))) continue;
    const selected = p.revisions.filter(r => r.type === 'w:ins' ? a.insertedText && normal(r.text) === normal(a.insertedText) : r.type === 'w:del' && a.deletedText && normal(r.text) === normal(a.deletedText));
    if (selected.some(r => remaining.get(revisionKey(r)))) continue;
    const q = locate(p);
    if (!q) continue;
    const kept = a.action === 'accept' ? a.insertedText : a.deletedText, absent = a.action === 'accept' ? a.deletedText : a.insertedText;
    if (kept && !normal(q.text).includes(normal(kept)) || absent && normal(q.text).includes(normal(absent))) continue;
    decisions.push({ action: a.action, paragraph: p.index + 1, before: p.original, proposed: p.text, saved: q.text, insertedText: a.insertedText || '', deletedText: a.deletedText || '' });
  }
  const comments = [], states = [], unused = [...before.comments];
  for (const c of after.comments) {
    let index = unused.findIndex(old => old.id === c.id && old.author === c.author && old.text === c.text);
    if (index < 0) index = unused.findIndex(old => old.author === c.author && old.text === c.text);
    const old = index < 0 ? null : unused.splice(index, 1)[0];
    const parent = after.comments.find(root => root.paraIds.includes(c.parentParaId));
    if (!old) comments.push({ kind: c.parentParaId ? 'reply' : 'comment', text: c.text, context: parent?.text || '', blockIds: parent?.blockIds || c.blockIds });
    if (old && old.resolved !== c.resolved) states.push({ text: c.text, resolved: c.resolved });
  }
  const humanEvidence = [...body.fragments.map(f => f.text), ...decisions.map(d => d.action === 'accept' ? d.insertedText || d.deletedText : d.deletedText || d.insertedText), ...comments.map(c => c.text), reason].filter(t => t?.trim());
  return { schemaVersion: 1, body, decisions, comments, commentStates: states, unresolved, reason,
    humanEvidence, substantive: !!humanEvidence.length,
    limitation: '比较基线是法务实际打开的版本。未处理的 AI 修订和原有批注不是法务认可；已处理批注仅表示状态。接受或拒绝仅适用于本处文字，原因未提供时待确认，不能推定全合同同意。个案数字不得升级为公司标准。' };
}

module.exports = { snapshot, compare };
