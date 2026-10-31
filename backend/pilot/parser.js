const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const { config } = require('./config');
const { fail, AppError } = require('./errors');
const parserVersion = 'structured-1.2';
function parseDocx(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { fail(422, 'INVALID_DOCX', 'DOCX 已损坏或加密'); }
  const entries = zip.getEntries();
  if (entries.reduce((n, e) => n + e.header.size, 0) > 150 * 1024 * 1024) fail(422, 'DOCX_EXPANSION_LIMIT', 'DOCX 解压内容过大');
  const entry = zip.getEntry('word/document.xml'); if (!entry) fail(422, 'INVALID_DOCX', 'DOCX 缺少正文');
  const xml = zip.readAsText(entry);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail(422, 'INVALID_XML', '不支持包含外部实体的文档');
  const tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false, processEntities: true }).parse(xml);
  const textOf = nodes => nodes.map(node => Object.entries(node).map(([key, value]) => ['w:del','w:moveFrom','w:instrText'].includes(key) ? '' : key === '#text' ? String(value) : key === 'w:tab' ? '\t' : key === 'w:br' ? '\n' : Array.isArray(value) ? textOf(value) : '').join('')).join('');
  const prop=(nodes,key)=>nodes?.find(n=>key in n), val=node=>node?.[':@']?.['@_w:val'];
  const numberingXml=zip.getEntry('word/numbering.xml')&&zip.readAsText('word/numbering.xml');
  const numbering=numberingXml?new XMLParser({ignoreAttributes:false}).parse(numberingXml)['w:numbering']:null;
  const list=v=>v?(Array.isArray(v)?v:[v]):[], counters=new Map();
  function numberOf(value){const pr=prop(value,'w:pPr')?.['w:pPr'],num=prop(pr,'w:numPr')?.['w:numPr'];if(!num)return{};const numId=val(prop(num,'w:numId')),level=Number(val(prop(num,'w:ilvl'))||0);const mapping=list(numbering?.['w:num']).find(n=>String(n['@_w:numId'])===String(numId));const abstractId=mapping?.['w:abstractNumId']?.['@_w:val'];const definition=list(numbering?.['w:abstractNum']).find(n=>String(n['@_w:abstractNumId'])===String(abstractId));const levels=list(definition?.['w:lvl']);const lv=levels.find(n=>Number(n['@_w:ilvl'])===level);const values=counters.get(numId)||[];values[level]=(values[level]??Number(lv?.['w:start']?.['@_w:val']||1)-1)+1;values.length=level+1;counters.set(numId,values);const pattern=lv?.['w:lvlText']?.['@_w:val'];const numberLabel=pattern?String(pattern).replace(/%([1-9])/g,(_,n)=>String(values[Number(n)-1]||1)):null;return{numbering:{numId,level,format:lv?.['w:numFmt']?.['@_w:val']||'unknown',label:numberLabel}};}
  const blocks = []; let tableSequence=0;
  function walk(nodes, table = null, row=null, cell = null) {
    let rowSequence=0,cellSequence=0;
    for (const node of nodes || []) for (const [key, value] of Object.entries(node)) {
      if (!Array.isArray(value)) continue;
      if (key === 'w:p') {
        const raw = textOf(value).trim(), style=val(prop(prop(value,'w:pPr')?.['w:pPr'],'w:pStyle')); const metadata=numberOf(value);const text=raw && metadata.numbering?.label?`${metadata.numbering.label} ${raw}`:raw;
        if (text) blocks.push({ id: `b${blocks.length + 1}`, text, page: null, kind: table ? 'table_cell' : /heading|标题/i.test(style||'')?'heading':'paragraph', style, table, row, cell, ...metadata, paragraph: blocks.length + 1, source: 'docx' });
      } else if (['w:del','w:moveFrom'].includes(key)) continue;
      else if (key === 'w:tbl') walk(value, ++tableSequence, null, null);
      else if (key === 'w:tr') walk(value, table, ++rowSequence, null);
      else if (key === 'w:tc') walk(value, table, row, ++cellSequence);
      else walk(value, table, row, cell);
    }
  }
  walk(tree);
  if (!blocks.length) fail(422, 'EMPTY_TEXT', 'DOCX 未提取到正文，请补充文字版合同');
  const hasRevisions=/<w:(ins|del|moveFrom|moveTo)\b/.test(xml);
  return { parserVersion, format: 'docx', blocks, requiresHumanVerification:hasRevisions, warnings: ['DOCX 位置按段落及表格编号显示，页码随编辑器排版变化。',...(hasRevisions?['文档包含修订标记；预审使用当前文本视图（含插入、不含删除），请法务在 Word 或编辑器核实修订内容。']:[])] };
}
async function ocrPage(buffer, page) {
  if (!config.ocrUrl || !config.ocrToken) fail(422, 'OCR_NOT_CONFIGURED', '检测到扫描页，请配置 OCR 服务或补充文字版合同');
  const form = new FormData(); form.set('file', new Blob([buffer], { type: 'application/pdf' }), 'document.pdf'); form.set('page', String(page));
  let response;
  try { response = await fetch(`${config.ocrUrl.replace(/\/$/, '')}/parse-page`, { method: 'POST', headers: { Authorization: `Bearer ${config.ocrToken}` }, body: form, signal: AbortSignal.timeout(180000) }); }
  catch { throw new AppError(503, 'OCR_UNAVAILABLE', 'OCR 服务暂不可用'); }
  if (!response.ok) throw new AppError(response.status >= 500 ? 503 : 422, 'OCR_FAILED', '扫描页识别失败，请人工处理或补件');
  return response.json();
}
async function parsePdf(buffer, ocr = ocrPage) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let pdf, loadingTask;
  try { loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true }); pdf = await loadingTask.promise; }
  catch (e) { fail(422, e.name === 'PasswordException' ? 'ENCRYPTED_FILE' : 'INVALID_PDF', 'PDF 已加密或损坏，请补件'); }
  const blocks = [], warnings = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n); const viewport = page.getViewport({ scale: 1 }); const content = await page.getTextContent();
      const textItems = content.items.filter(i => typeof i.str === 'string' && i.str.trim());
      const operators = await page.getOperatorList();
      const imageOps = new Set([pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageMaskXObjectRepeat, pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintInlineImageXObjectGroup, pdfjs.OPS.paintSolidColorImageMask]);
      const hasImage = operators.fnArray.some(fn => imageOps.has(fn));
      const hasDrawableContent = operators.fnArray.some(fn => ![pdfjs.OPS.transform, pdfjs.OPS.save, pdfjs.OPS.restore].includes(fn));
      if (!textItems.length && !hasDrawableContent) {
        page.cleanup();
        continue;
      }
      if (!textItems.length && hasDrawableContent) {
        const result = await ocr(buffer, n);
        if (!result.blocks?.length) fail(422, 'OCR_EMPTY', `第 ${n} 页无法识别，请补件`);
        for (const item of result.blocks) {
          if (!item.text?.trim()) continue;
          blocks.push({ id: `b${blocks.length + 1}`, text: item.text, page: n, bbox: item.bbox, width: result.width, height: result.height, confidence: item.confidence, source: 'ocr', kind: 'paragraph' });
          if (item.confidence < 0.9) warnings.push(`第 ${n} 页存在识别存疑内容，金额、主体和日期需要人工核实。`);
        }
      } else {
        for (const item of textItems) {
          const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
          blocks.push({ id: `b${blocks.length + 1}`, text: item.str, page: n, bbox: [x, Math.max(0, y - item.height), item.width, item.height], width: viewport.width, height: viewport.height, source: 'pdf', kind: 'text' });
        }
      }
      page.cleanup();
    }
    if (!blocks.length) fail(422, 'EMPTY_TEXT', 'PDF 正文为空');
    return { parserVersion, format: 'pdf', pageCount: pdf.numPages, blocks, requiresHumanVerification: warnings.length>0, warnings: [...new Set(warnings)] };
  } finally { await loadingTask.destroy(); }
}
async function parseDocument(buffer, filename, options = {}) { return filename.toLowerCase().endsWith('.docx') ? parseDocx(buffer) : parsePdf(buffer, options.ocr); }
function chunks(document, maxChars = 16000) {
  const result = []; let current = [], length = 0;
  for (const block of document.blocks) {
    // Split oversized blocks with explicit derived IDs, preserving the original anchor.
    for (let start = 0; start < block.text.length; start += maxChars) {
      const part = { ...block, text: block.text.slice(start, start + maxChars) };
      if (length + part.text.length > maxChars && current.length) { result.push(current); current = []; length = 0; }
      current.push(part); length += part.text.length;
    }
  }
  if (current.length) result.push(current); return result;
}
module.exports = { parseDocx, parsePdf, parseDocument, chunks, parserVersion };
