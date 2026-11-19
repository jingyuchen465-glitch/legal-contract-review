const path = require('node:path');
const AdmZip = require('adm-zip');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const { annotatedContract } = require('./annotated-contract');
const { fail } = require('./errors');

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
const options = { preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false };
const parser = new XMLParser(options), builder = new XMLBuilder(options);
const element = (name, attributes = {}) => ({ [name]: [], ':@': Object.fromEntries(Object.entries(attributes).map(([key, value]) => ['@_' + key, value])) });

// Prepare only the editor's download copy. The uploaded original stays immutable.
function editorDocument(buffer, version, review, findings = []) {
  const annotated = review ? annotatedContract(buffer, version, review, findings).buffer : buffer;
  const zip = new AdmZip(annotated);
  function read(name, fallback) {
    const xml = zip.getEntry(name) ? zip.readAsText(name) : fallback;
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) fail(422, 'INVALID_DOCX_XML', '文档设置无效，无法开启修订编辑');
    return parser.parse(xml);
  }
  const relationships = read('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  const rels = relationships.find(node => node.Relationships)?.Relationships;
  if (!rels) fail(422, 'INVALID_DOCX_XML', '文档关系无效');
  const relation = rels.find(node => node.Relationship && node[':@']?.['@_Type'] === SETTINGS);
  const target = relation?.[':@']?.['@_Target'];
  const settingsPath = target ? path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('word', target)) : 'word/settings.xml';
  if (relation?.[':@']?.['@_TargetMode'] === 'External' || !settingsPath.startsWith('word/') || settingsPath.includes('\\')) fail(422, 'INVALID_DOCX_XML', '文档设置路径无效');
  const tree = read(settingsPath, `<w:settings xmlns:w="${WORD}"/>`);
  const root = tree.find(node => 'w:settings' in node);
  if (!root) fail(422, 'INVALID_DOCX_XML', '文档设置格式暂不支持');
  root[':@'] = { ...root[':@'], '@_xmlns:w': WORD };
  const settings = root['w:settings'];
  const index = settings.findIndex(node => 'w:trackRevisions' in node);
  if (index === -1) settings.push(element('w:trackRevisions'));
  else settings[index] = element('w:trackRevisions');
  if (!relation) {
    const ids = new Set(rels.map(node => node[':@']?.['@_Id'])); let id = 'rIdOfficeSettings', count = 1;
    while (ids.has(id)) id = 'rIdOfficeSettings' + count++;
    rels.push(element('Relationship', { Id: id, Type: SETTINGS, Target: 'settings.xml' }));
  }
  const types = read('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const typeNodes = types.find(node => node.Types)?.Types;
  if (!typeNodes) fail(422, 'INVALID_DOCX_XML', '文档类型声明无效');
  if (!typeNodes.some(node => node.Override && node[':@']?.['@_PartName'] === '/' + settingsPath)) typeNodes.push(element('Override', { PartName: '/' + settingsPath, ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml' }));
  zip.addFile(settingsPath, Buffer.from(builder.build(tree)));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(builder.build(relationships)));
  zip.addFile('[Content_Types].xml', Buffer.from(builder.build(types)));
  return zip.toBuffer();
}

module.exports = { editorDocument };
