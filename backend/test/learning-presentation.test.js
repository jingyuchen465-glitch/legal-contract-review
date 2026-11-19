const { test } = require('node:test');
const assert = require('node:assert/strict');

test('an adopted proposal is never displayed as published before its actual draft is published', async () => {
  const { proposalStatus, proposalCounts } = await import('../../frontend/src/pilot/learning-presentation.mjs');
  assert.equal(proposalStatus({ state: 'adopted', draftState: 'pending' }).label, '已提交审核');
  assert.equal(proposalStatus({ state: 'adopted', draftState: 'draft' }).label, '草稿待发布');
  assert.equal(proposalStatus({ state: 'adopted' }).label, '已生成草稿');
  assert.equal(proposalStatus({ state: 'adopted', draftState: 'published' }).label, '已发布');
  assert.deepEqual(proposalCounts({ proposals: [{state:'pending'}, {state:'adopted',draftState:'pending'}, {state:'adopted',draftState:'published'}, {state:'adopted',draftState:'retired'}, {state:'ignored'}] }), {pending:1,drafts:1,published:1});
});

test('source references use real version numbers and handle joint materials without displaying raw identifiers', async () => {
  const { evidenceVersion } = await import('../../frontend/src/pilot/learning-presentation.mjs');
  const task={sourceContext:{currentVersion:{id:'main',versionNo:4,filename:'主合同.docx'},documentPairs:[{previousVersion:{id:'attachment',versionNo:2,filename:'补充协议.docx'}}]}};
  assert.equal(evidenceVersion(task,'attachment'),'文件 v2 · 补充协议.docx');
  assert.equal(evidenceVersion(task,'main'),'文件 v4 · 主合同.docx');
  assert.equal(evidenceVersion(task,'unknown-private-identifier'),'来源文件');
});
