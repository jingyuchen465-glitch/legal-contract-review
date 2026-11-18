import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const projectRoot = resolve(import.meta.dirname, '../../..');

// These fixtures drive the real pinned Harness runtime against local mock HTTP
// servers. Each invocation owns its patch, session data, and extension modules.
export async function createFixture(name) {
  const runtimeRoot = resolve(process.env.LEGAL_HARNESS_ROOT || join(projectRoot, '.local/legal-harness'));
  const sdk = join(runtimeRoot, 'packages/sdk/client/lib/index.js');
  if (!existsSync(sdk)) {
    throw new Error('Build the pinned runtime with npm run harness:build, or set LEGAL_HARNESS_ROOT to a prepared source runtime.');
  }
  const manifest = JSON.parse(await readFile(join(runtimeRoot, 'packages/sdk/client/package.json'), 'utf8'));
  if (manifest.version !== '0.2.2-rc.1') throw new Error('Fixture requires the pinned Harness SDK 0.2.2-rc.1');
  const id = name + '-' + randomUUID();
  const stateRoot = join(projectRoot, '.local/harness-smoke', id);
  const extensionRoot = join(runtimeRoot, 'apps/cli/harness-fixtures', id);
  await mkdir(stateRoot, { recursive: true });
  await mkdir(extensionRoot, { recursive: true });
  const { DeepSeekHarness } = await import(pathToFileURL(sdk).href);
  return { DeepSeekHarness, runtimeRoot, stateRoot, extensionRoot, id };
}

// Do not pass the parent's model credentials, NODE_OPTIONS, or proxy settings
// into the test runtime. Every adapter below targets loopback with a fake token.
export function childEnvironment(values) {
  const base = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) base[key] = process.env[key];
  }
  return { ...base, ...values, NO_COLOR: '1', NODE_ENV: 'production' };
}

export function stderrLines(harness) {
  // Diagnostic inspection is intentionally pinned to the upstream source SDK;
  // stderrTail is internal and must not become an application integration API.
  const lines = harness.client.stderrTail;
  if (!Array.isArray(lines)) throw new Error('Pinned SDK stderr diagnostics changed');
  return lines;
}
