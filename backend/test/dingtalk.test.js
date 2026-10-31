const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachmentsOf, currentAssignees, createApprovalApi } = require('../pilot/dingtalk');
const { resolveIdentity } = require('../pilot/dingtalk-account');

test('approval recipients require current tasks; history and event identities cannot grant access', () => {
  assert.deepEqual(currentAssignees({ tasks: [
    { userId: 'a', status: 'NEW', result: 'NONE' }, { userId: 'a', status: 'RUNNING' },
    { userId: 'b', status: 'COMPLETED' }, { userId: 'c', status: 'NEW', finishTime: '2026-01-01' },
    { userId: 'd', status: 'NEW', result: 'REDIRECTED' }, { status: 'NEW' },
  ], staffId: 'forged' }), ['a']);
  assert.deepEqual(currentAssignees({ status: 'COMPLETED', tasks: [{ userId: 'a', status: 'NEW' }] }), []);
});

test('attachments are discovered in direct fields and table rows, malformed values are skipped', () => {
  const file = (fileId, fileName) => ({ fileId, fileName });
  const found = attachmentsOf({ formComponentValues: [
    { id: 'direct', value: JSON.stringify([file('1', '合同.PDF'), file('2', '材料.xlsx')]) },
    { name: '明细', value: JSON.stringify([[{ id: 'files', value: JSON.stringify([file('3', '补充.docx')]) }]]) },
    { name: '重复', value: [file('1', '合同.PDF')] }, { name: '坏值', value: 'not JSON' },
  ] });
  assert.deepEqual(found.map(f => f.fileName), ['合同.PDF', '材料.xlsx', '补充.docx']);
  assert.equal(found[2].field, '明细:0:files');
});

test('binding resolves authorized UnionID into the app enterprise, and never trusts a caller UserID', async () => {
  const calls = [], replies = [ { accessToken: 'user-token' }, { unionId: 'union-1', nick: '测试成员' }, { accessToken: 'app-token' }, { errcode: 0, result: { userid: 'member-1' } } ];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return Response.json(replies.shift()); };
  const identity = await resolveIdentity({ clientId: 'app', secret: 'secret' }, 'one-use-code', { fetchImpl });
  assert.deepEqual(identity, { userId: 'member-1', displayName: '测试成员' });
  assert.match(calls[0].url, /oauth2\/userAccessToken$/);
  assert.equal(JSON.parse(calls[0].options.body).grantType, 'authorization_code');
  assert.equal(calls[1].options.headers['x-acs-dingtalk-access-token'], 'user-token');
  assert.equal(new URL(calls[3].url).searchParams.get('access_token'), 'app-token');
  assert.deepEqual(JSON.parse(calls[3].options.body), { unionid: 'union-1' });
  await assert.rejects(resolveIdentity({ clientId: 'app', secret: 'secret' }, 'code', { fetchImpl: async () => Response.json({ errcode: 400, errmsg: 'secret must not leak' }) }), e => e.code === 'DING_BIND_ACCESS' && !e.message.includes('secret'));
});

test('attachment download grants access using its instance, rejects foreign hosts and redirects', async () => {
  const calls = [];
  const api = createApprovalApi({ connection: { clientId: 'app', secret: 'secret' }, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/accessToken')) return Response.json({ accessToken: 'app-token', expireIn: 7200 });
    if (url.includes('/urls/download')) return Response.json({ result: { downloadUri: 'https://files.dingtalk.com/fixture' } });
    return new Response(Buffer.from('%PDF-1.4 fixture'));
  } });
  assert.match((await api.attachment('instance-1', { fileId: 'file-1' })).toString(), /^%PDF/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { processInstanceId: 'instance-1', fileId: 'file-1', withCommentAttatchment: false });
  assert.equal(calls[2].options.redirect, 'error');
  const bad = createApprovalApi({ fetchImpl: async url => Response.json(url.endsWith('/accessToken') ? { accessToken: 'token', expireIn: 7200 } : { downloadUri: 'https://evil.example/a.pdf' }) });
  await assert.rejects(bad.attachment('i', { fileId: 'f' }), e => e.code === 'DING_ATTACHMENT_URL');
});

test('attachment download upgrades DingTalk OSS URLs to HTTPS', async () => {
  const calls = [];
  const api = createApprovalApi({ connection: { clientId: 'app', secret: 'secret' }, fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/accessToken')) return Response.json({ accessToken: 'app-token', expireIn: 7200 });
    if (String(url).includes('/urls/download')) return Response.json({ result: { downloadUri: 'http://bucket.oss-cn-shanghai.aliyuncs.com/fixture' } });
    return new Response(Buffer.from('%PDF-1.4 fixture'));
  } });
  assert.match((await api.attachment('instance-1', { fileId: 'file-1' })).toString(), /^%PDF/);
  assert.equal(calls.at(-1), 'https://bucket.oss-cn-shanghai.aliyuncs.com/fixture');
});
