const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { validateUpload, needsConversion, isSupported } = require('../pilot/file-formats');
const { unpackConversion } = require('../pilot/conversion');
function archive(entries) { const zip = new AdmZip(); for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content)); return zip.toBuffer(); }
test('Office uploads check real containers, expansion limits and reject renamed or macro packages', () => {
  assert.equal(needsConversion('清单.XLSX'), true); assert.equal(needsConversion('合同.docx'), false); assert.equal(isSupported('macro.xlsm'), false);
  for (const name of ['fake.xls', 'fake.doc', 'fake.ppt', 'fake.xlsx', 'fake.pptx']) assert.throws(() => validateUpload({ originalname: name, buffer: Buffer.from('%PDF-1.4') }), e => e.code === 'INVALID_DOCUMENT');
  assert.match(validateUpload({ originalname: 'legacy.doc', buffer: Buffer.from('{\\rtf1 contract}') }), /msword/);
  assert.match(validateUpload({ originalname: '清单.xlsx', buffer: archive({ 'xl/workbook.xml': '<workbook/>' }) }), /spreadsheet/);
  assert.throws(() => validateUpload({ originalname: 'wrong.xlsx', buffer: archive({ 'ppt/presentation.xml': '<presentation/>' }) }), e => e.code === 'INVALID_DOCUMENT');
  assert.throws(() => validateUpload({ originalname: 'macro.xlsx', buffer: archive({ 'xl/workbook.xml': '<workbook/>', 'xl/vbaProject.bin': 'macro' }) }), e => e.code === 'MACRO_FILE');
  assert.throws(() => validateUpload({ originalname: 'binary.csv', buffer: Buffer.from([0, 1]) }), e => e.code === 'INVALID_DOCUMENT');
  const zip = new AdmZip(archive({ 'xl/workbook.xml': '<workbook/>' })); zip.getEntries()[0].header.size = 151 * 1024 * 1024;
  // Package metadata is checked before decompression.
  const bytes = zip.toBuffer(); const offset = bytes.indexOf(Buffer.from('504b0102', 'hex')); bytes.writeUInt32LE(151 * 1024 * 1024, offset + 24);
  assert.throws(() => validateUpload({ originalname: 'expanded.xlsx', buffer: bytes }), e => e.code === 'DOCUMENT_TOO_LARGE');
});
test('converter results must contain valid preview, required structure and no unexpected paths', () => {
  const manifest = JSON.stringify({ version: 1, sourceExtension: '.pptx', document: null, notes: [], warnings: [] });
  const valid = { 'manifest.json': manifest, 'preview.pdf': '%PDF-1.4\n' };
  assert.ok(unpackConversion(archive(valid), '演示.pptx').pdf);
  assert.throws(() => unpackConversion(archive({ ...valid, 'unexpected.txt': 'bad' }), '演示.pptx'), e => e.code === 'CONVERTER_INVALID_RESULT');
  assert.throws(() => unpackConversion(archive({ ...valid, 'preview.pdf': 'not pdf' }), '演示.pptx'), e => e.code === 'CONVERTER_INVALID_RESULT');
  assert.throws(() => unpackConversion(archive(valid), '表格.xlsx'), e => e.code === 'CONVERTER_INVALID_RESULT');
  assert.throws(() => unpackConversion(archive({ ...valid, 'manifest.json': '{bad' }), '演示.pptx'), e => e.code === 'CONVERTER_INVALID_RESULT');
});
test('long Chinese upload names retain a valid extension and fit Linux filename byte limits', () => {
  const { safeName } = require('../pilot/storage');
  const filename = safeName('报价明细📄'.repeat(60) + '.XLSX');
  assert.ok(filename.endsWith('.XLSX')); assert.ok(Buffer.byteLength(filename) <= 200); assert.equal(needsConversion(filename), true);
  assert.equal(safeName('采购合同_50%_é_📄.docx'), '采购合同_50%_é_📄.docx');
});
