const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('retained withdrawal service parses without activating its retired routes', () => {
  const result = spawnSync(process.execPath, ['--check', path.resolve(__dirname, '../pilot/decision-reconfirmation.js')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
