export const activeAnnotations = findings => (findings || []).filter(f => f.check_status !== 'pass' && f.disposition?.action !== 'reject');
export const annotationSeverity = finding => finding.disposition?.severity || finding.severity;
export const annotationText = finding => finding.disposition?.suggestion ?? (finding.suggestion || finding.reason || '请结合审查意见核实');
// A finding can cite many clauses. Render its full note once and link the other
// citations back to it, so the reader does not repeat the same advice on each row.
export function annotationIndex(blocks, findings) {
  const annotations = activeAnnotations(findings), source = new Map(blocks.map(block => [block.id, block]));
  const byBlock = new Map(), primaryByBlock = new Map(), primary = new Map(), unanchored = [], numbers = new Map();
  for (const [i, finding] of annotations.entries()) {
    numbers.set(finding.id, i + 1);
    const evidence = finding.evidence || [], valid = [...new Set(evidence.filter(e => e.quote && source.get(e.blockId)?.text.includes(e.quote)).map(e => e.blockId))];
    for (const blockId of valid) byBlock.set(blockId, [...(byBlock.get(blockId) || []), finding]);
    if (valid.length) {
      primary.set(finding.id, valid[0]);
      primaryByBlock.set(valid[0], [...(primaryByBlock.get(valid[0]) || []), finding]);
    }
    if (!valid.length || evidence.some(e => !e.quote || !source.get(e.blockId)?.text.includes(e.quote))) unanchored.push(finding);
  }
  return { annotations, byBlock, primaryByBlock, primary, unanchored, numbers };
}
export function quoteSegments(block, findings) {
  const text = block.text || '', ranges = [], rank = { high: 3, medium: 2, low: 1 };
  for (const finding of activeAnnotations(findings)) for (const evidence of finding.evidence || []) {
    if (evidence.blockId !== block.id || !evidence.quote) continue;
    let start = text.indexOf(evidence.quote);
    while (start !== -1) {
      ranges.push({ start, end: start + evidence.quote.length, severity: annotationSeverity(finding), findingId: finding.id });
      start = text.indexOf(evidence.quote, start + evidence.quote.length);
    }
  }
  const points = [...new Set([0, text.length, ...ranges.flatMap(range => [range.start, range.end])])].sort((a, b) => a - b);
  return points.slice(0, -1).map((start, i) => {
    const end = points[i + 1], matches = ranges.filter(range => range.start <= start && range.end >= end).sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0));
    return { start, text: text.slice(start, end), severity: matches[0]?.severity, findingIds: [...new Set(matches.map(match => match.findingId))] };
  });
}
