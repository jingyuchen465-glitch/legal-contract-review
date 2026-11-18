const { diffArrays } = require('diff');
const { chunks } = require('./parser');
// Preserve internal spaces, punctuation, amounts and dates. Only edge whitespace
// and line-ending representation are irrelevant to a paragraph comparison.
const key = block => String(block.text || '').replace(/\r\n?/g, '\n').trim();

function compareDocuments(current, previous) {
  const groups = [];
  const summary = { complete: !!previous, coarse: false, changed: 0, added: 0, removed: 0, modified: 0 };
  if (!previous) return { groups, summary };
  // Bound worst-case work for unrelated large documents. A coarse range still
  // preserves every original block, with an explicit warning for the reviewer.
  let parts = diffArrays(previous.blocks, current.blocks, { comparator: (a, b) => key(a) === key(b), timeout: 500, maxEditLength: 2000 });
  if (!parts) {
    summary.coarse = true;
    parts = [{ removed: true, count: previous.blocks.length }, { added: true, count: current.blocks.length }];
  }
  let before = 0, after = 0, pending;
  const flush = () => {
    if (!pending) return;
    pending.kind = pending.beforeCount && pending.afterCount ? 'modified' : pending.beforeCount ? 'removed' : 'added';
    groups.push(pending); summary.changed++; summary[pending.kind]++; pending = null;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush();
      groups.push({ kind: 'unchanged', beforeStart: before, beforeCount: part.count, afterStart: after, afterCount: part.count });
      before += part.count; after += part.count;
    } else {
      pending ||= { beforeStart: before, beforeCount: 0, afterStart: after, afterCount: 0 };
      if (part.removed) { pending.beforeCount += part.count; before += part.count; }
      else { pending.afterCount += part.count; after += part.count; }
    }
  }
  flush();
  return { groups: groups.map((g, i) => ({ ...g, id: `change-${i + 1}` })), summary };
}

function tagged(document, start, count, side, group) {
  return document.blocks.slice(start, start + count).map(block => ({ ...block, id: `${document.id}:${block.id}`, sourceBlockId: block.id, versionId: document.id, side, change: group.kind, changeId: group.id }));
}
function groupBlocks(current, previous, group) {
  return { before: previous ? tagged(previous, group.beforeStart, group.beforeCount, 'previous', group) : [], after: tagged(current, group.afterStart, group.afterCount, 'confirmed', group) };
}
function markChanges(current, previous, comparison = compareDocuments(current, previous)) {
  if (!previous) return tagged(current, 0, current.blocks.length, 'confirmed', { kind: 'comparison_unavailable', id: 'unavailable' });
  const groups = comparison.groups.map(g => groupBlocks(current, previous, g));
  return [...groups.flatMap(g => g.after), ...groups.flatMap(g => g.before)];
}
function learningChunks(current, previous, comparison = compareDocuments(current, previous), maxChars = 16000) {
  if (!previous) return chunks({ blocks: markChanges(current) }, maxChars);
  const result = []; let batch = [], size = 0;
  for (const group of comparison.groups) {
    const sides = groupBlocks(current, previous, group);
    const budget = sides.before.length && sides.after.length ? Math.floor(maxChars / 2) : maxChars;
    const before = chunks({ blocks: sides.before }, budget), after = chunks({ blocks: sides.after }, budget);
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const unit = [...(before[i] || []), ...(after[i] || [])], length = unit.reduce((n, b) => n + b.text.length, 0);
      if (batch.length && size + length > maxChars) { result.push(batch); batch = []; size = 0; }
      batch.push(...unit); size += length;
    }
  }
  if (batch.length) result.push(batch);
  return result;
}
function changePage(current, previous, comparison, offset = 0, limit = 20) {
  const changed = comparison.groups.filter(g => g.kind !== 'unchanged');
  return { summary: comparison.summary, total: changed.length, offset, items: changed.slice(offset, offset + limit).map(g => ({ id: g.id, kind: g.kind, ...groupBlocks(current, previous, g) })) };
}
module.exports = { compareDocuments, markChanges, learningChunks, changePage };
