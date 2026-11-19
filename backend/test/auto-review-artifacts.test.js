const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { parseDocx } = require('../pilot/parser');
const { draftDocument } = require('../pilot/auto-review-artifacts');
function source(paragraphs) {
  const z = new AdmZip();
  z.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`));
  z.addFile('word/media/test.png', Buffer.from('preserved-image'));
  return z.toBuffer();
}
const p = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const finding = (versionId, blockId, text, operation = 'replace', newText = '乙方应于2026年12月1日交付。') => ({ id: 'risk-' + blockId, title: '交付约定', status: 'fail', check_status: 'fail', severity: 'high', kind: 'clause', reason: '交付期限不明确', suggestion: newText, evidence: [{ versionId, blockId, quote: text }], edits: [{ versionId, blockId, originalText: text, newText, operation, reason: '明确交付' }] });
test('replace, insert and delete proposals become comments without changing original text or package parts', () => {
  const raw = source(p('乙方交付时间另议。') + p('付款方式另议。') + p('重复收费。'));
  const buffer = require('../pilot/annotated-contract').annotatedContract(raw,{filename:'合同.docx',parsed:parseDocx(raw),version_no:1},{id:'prior',status:'completed'},[]).buffer;
  const original = Buffer.from(buffer);
  const version = { id: 'v1', filename: '合同.docx', version_no: 1, parsed: parseDocx(buffer) };
  const findings = [finding('v1','b1','乙方交付时间另议。'), finding('v1','b2','付款方式另议。','insert_after','甲方应于验收后十日内付款。'), finding('v1','b3','重复收费。','delete',''), finding('other','b1','乙方交付时间另议。')];
  const result = draftDocument(buffer, version, { id: 'r1', status: 'completed' }, findings);
  const z = new AdmZip(result.buffer), xml = z.readAsText('word/document.xml');
  assert.doesNotMatch(xml, /<w:(?:ins|del)\b/);
  assert.deepEqual(parseDocx(result.buffer).blocks.map(b => b.text), version.parsed.blocks.map(b => b.text));
  assert.deepEqual(buffer, original);
  assert.equal(z.readAsText('word/media/test.png'),'preserved-image'); assert.deepEqual(result.unresolved,[]);
  assert.match(z.readAsText('word/comments.xml'),/正文未自动替换。/); // existing comment text stays literal
  const comments = z.readAsText('word/comments.xml');
  assert.doesNotMatch(comments, /可靠定位且通过校验的正文修改以 Word 修订显示/);
  assert.match(comments, /交付期限不明确/); assert.match(comments, /乙方应于2026年12月1日交付/);
  assert.match(comments, /甲方应于验收后十日内付款/); assert.match(comments, /删除该段正文/);
  assert.deepEqual(result.locatedFindingIds, ['risk-b1','risk-b2','risk-b3']);
  assert.equal(result.editCount, 0); assert.equal(result.outputMode, 'comments_only');
});
test('duplicate paragraphs and competing proposals are annotated while existing revisions stay intact', () => {
  const buffer = source(p('重复条款。') + p('重复条款。') + '<w:p><w:ins w:id="45"><w:r><w:t>已有修订。</w:t></w:r></w:ins></w:p>' + p('同段冲突。'));
  const version = { id:'v1', filename:'合同.docx', version_no:1, parsed:parseDocx(buffer) };
  const findings = [finding('v1','b1','重复条款。'),finding('v1','b3','已有修订。'),finding('v1','b4','同段冲突。'),{...finding('v1','b4','同段冲突。'),id:'another'}];
  const result = draftDocument(buffer,version,{id:'r1',status:'completed'},findings),z=new AdmZip(result.buffer);
  assert.equal(result.editCount,0);assert.equal(result.unresolved.length,0);
  assert.equal(result.locatedFindingIds.length,4);
  assert.equal((z.readAsText('word/document.xml').match(/<w:ins\b/g)||[]).length,1);
  assert.doesNotMatch(z.readAsText('word/document.xml'), /<w:del\b/);
  assert.match(z.readAsText('word/document.xml'),/w:id="45"/); assert.match(z.readAsText('word/comments.xml'),/交付约定/);
  assert.deepEqual(parseDocx(result.buffer).blocks.map(b=>b.text), version.parsed.blocks.map(b=>b.text));
});

test('unapplied edits retain exact proposed text in comments even when the suggestion is only a short note', () => {
  const buffer = source(p('重复条款。') + p('重复条款。'));
  const version = { id: 'v1', filename: '合同.docx', version_no: 1, parsed: parseDocx(buffer) };
  const f = { ...finding('v1', 'b1', '重复条款。', 'replace', '供方按约交货。'), suggestion: '按正文修改。' };
  const result = draftDocument(buffer, version, { id: 'r1', status: 'completed' }, [f]);
  assert.equal(result.editCount, 0);
  assert.match(new AdmZip(result.buffer).readAsText('word/comments.xml'), /供方按约交货。/);
  assert.deepEqual(parseDocx(result.buffer).blocks.map(b => b.text), ['重复条款。', '重复条款。']);
});

test('unlocated, missing and uncertain opinions remain in comments and other-file text is not leaked', () => {
  const buffer = source(p('原文。')), original = Buffer.from(buffer);
  const version = { id:'v1', filename:'合同.docx', version_no:1, parsed:parseDocx(buffer) };
  const f = finding('v1','b1','原文。');
  const findings = [
    {...f, id:'stale', evidence:[{versionId:'v1',blockId:'b99',quote:'找不到'}]},
    {...f, id:'missing', kind:'missing', evidence:[], edits:[], suggestion:'补充保密条款。'},
    {...f, id:'uncertain', kind:'uncertain', status:'uncertain', check_status:'uncertain', edits:[], suggestion:'确认交付日期。'},
    {...f, id:'multi', edits:[...f.edits, {...f.edits[0],versionId:'other',newText:'其他文件专用内容'}]},
    {...f, id:'pass', status:'pass', check_status:'pass'},
    {...f, id:'rejected', disposition:{action:'reject'}},
  ];
  const result = draftDocument(buffer,version,{id:'r1',status:'completed'},findings);
  const z=new AdmZip(result.buffer), comments=z.readAsText('word/comments.xml');
  assert.deepEqual(buffer,original);
  assert.deepEqual(parseDocx(result.buffer).blocks.map(b=>b.text), ['原文。']);
  assert.deepEqual(result.unlocatedFindingIds, ['stale','missing']);
  assert.deepEqual(result.locatedFindingIds, ['uncertain','multi']);
  assert.match(comments,/原文位置待人工核实/); assert.match(comments,/缺失条款/); assert.match(comments,/确认交付日期/);
  assert.doesNotMatch(comments,/其他文件专用内容/);
  assert.equal(result.editCount,0);
});

test('distinct edit proposals on identical evidence are not lost during comment grouping', () => {
  const buffer=source(p('原文。')), version={id:'v1',filename:'合同.docx',version_no:1,parsed:parseDocx(buffer)};
  const f={...finding('v1','b1','原文。'),suggestion:'建议改法如下。'};
  const result=draftDocument(buffer,version,{id:'r1',status:'completed'},[f,{...f,id:'second',edits:[{...f.edits[0],newText:'另一项完整建议。'}]}]);
  const comments=new AdmZip(result.buffer).readAsText('word/comments.xml');
  assert.match(comments,/乙方应于2026年12月1日交付/); assert.match(comments,/另一项完整建议/);
  assert.deepEqual(result.locatedFindingIds,['risk-b1','second']);
});
