// Only Word text nodes contribute text. XML indentation between runs is not
// document content; whitespace within w:t remains significant.
function wordText(nodes, inText = false) {
  return (nodes || []).map(node => Object.entries(node).map(([key, value]) => {
    if (['w:del', 'w:moveFrom', 'w:instrText'].includes(key)) return '';
    if (key === '#text') return inText ? String(value) : '';
    if (key === 'w:tab') return '\t';
    if (key === 'w:br' || key === 'w:cr') return '\n';
    return Array.isArray(value) ? wordText(value, key === 'w:t' || key === 'w:delText') : '';
  }).join('')).join('');
}
module.exports = { wordText };
