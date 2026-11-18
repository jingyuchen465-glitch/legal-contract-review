const path = require('node:path');
const { config } = require('../config');
const { decrypt } = require('../model');
const ENGINE = 'harness-v1';
const UPSTREAM_COMMIT = 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159';
const bounded = (v, fallback, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : fallback;
async function settings(db) {
  const row = db && await db('la_settings').where({ key: 'agent' }).first();
  const v = row?.value || {};
  return {
    maxRequests: bounded(v.maxRequests ?? process.env.AGENT_MAX_REQUESTS, 40, 2, 200),
    maxMinutes: bounded(v.maxMinutes ?? process.env.AGENT_MAX_MINUTES, 30, 1, 120),
    contextWindow: bounded(v.contextWindow ?? process.env.AGENT_CONTEXT_WINDOW, 128000, 8192, 2000000),
    maxOutputTokens: bounded(v.maxOutputTokens ?? process.env.AGENT_MAX_OUTPUT_TOKENS, 12000, 1024, 64000),
    thinkingFormat: v.thinkingFormat || process.env.AGENT_THINKING_FORMAT || 'openai',
    reasoning: v.reasoning ?? process.env.AGENT_REASONING === 'true',
    expectedUpdatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    searchKey: v.encryptedSearchKey ? decrypt(v.encryptedSearchKey) : process.env.BRAVE_SEARCH_API_KEY || '',
    runtimeRoot: path.resolve(process.env.LEGAL_HARNESS_ROOT || path.join(__dirname, '../../..', '.local/legal-harness')),
    homeRoot: path.join(config.dataRoot, 'harness'),
  };
}
const publicSettings = v => ({ maxRequests: v.maxRequests, maxMinutes: v.maxMinutes, contextWindow: v.contextWindow, maxOutputTokens: v.maxOutputTokens, thinkingFormat: v.thinkingFormat, reasoning: v.reasoning, hasSearchKey: !!v.searchKey, expectedUpdatedAt: v.expectedUpdatedAt, engine: ENGINE, upstreamCommit: UPSTREAM_COMMIT });
module.exports = { ENGINE, UPSTREAM_COMMIT, settings, publicSettings, bounded };
