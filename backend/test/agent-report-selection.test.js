const { test } = require('node:test');
const assert = require('node:assert/strict');
const helpers = import('../../frontend/src/pilot/review-reports.mjs');
const report = (id, created_at, extra = {}) => ({ id, created_at, version_id: 'v1', status: 'completed', agent_result: { summary: id }, ...extra });

test('chat, questions, interrupted and partial rounds never replace a complete report', async () => {
  const { completedReports, selectReport } = await helpers;
  const rows = [report('complete', '2026-11-06T08:00:00Z')];
  for (const status of ['queued', 'running', 'waiting_input', 'failed', 'cancelled', 'completed']) {
    rows.push(report(status, '2026-11-06T09:00:00Z', { status, agent_result: null }));
    const reports = completedReports(rows, 'v1');
    assert.deepEqual(reports.map(r => r.id), ['complete']);
    assert.equal(selectReport(reports, 'complete', true), 'complete');
    assert.equal(selectReport(reports, '', true), 'complete');
  }
  assert.deepEqual(completedReports([report('partial', '2026-11-06T09:00:00Z', { status: 'running' })], 'v1'), []);
});

test('new reports follow completion time order and manual history remains selected', async () => {
  const { completedReports, selectReport } = await helpers;
  const reports = completedReports([report('old', '2026-11-06T08:00:00Z'), report('new', '2026-11-06T09:00:00Z')], 'v1');
  assert.equal(selectReport(reports, 'old', true), 'new');
  assert.equal(selectReport(reports, 'old', false), 'old');
  assert.equal(selectReport(reports, 'missing', false), 'new');
  assert.equal(selectReport(reports, '', true), 'new');
});

test('reports are scoped to the current file version, including valid zero-risk reports', async () => {
  const { completedReports, selectReport } = await helpers;
  const rows = [report('zero-risk', '2026-11-06T08:00:00Z', { findings: [] })];
  assert.equal(completedReports(rows, 'v1').length, 1);
  assert.deepEqual(completedReports(rows, 'v2'), []);
  assert.equal(selectReport(completedReports(rows, 'v2'), 'zero-risk', false), '');
  assert.equal(selectReport([], '', true), '');
});

test('joint report membership follows frozen file versions, including zero-risk attachments', async () => {
  const { completedReports, reportIncludesVersion } = await helpers;
  const joint = report('joint', '2026-11-06T08:00:00Z', { snapshot: { jointGroup: { documents: [{ versionId: 'attachment-v1' }] } }, findings: [] });
  assert.equal(reportIncludesVersion(joint, 'attachment-v1'), true);
  assert.deepEqual(completedReports([joint], 'attachment-v1').map(r => r.id), ['joint']);
  assert.deepEqual(completedReports([joint], 'attachment-v2'), []);
  assert.equal(reportIncludesVersion(null, 'attachment-v1'), false);
});
