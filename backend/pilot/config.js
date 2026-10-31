const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const env = process.env;
const config = {
  env: env.NODE_ENV || 'development', port: Number(env.PORT || 3000), host: env.HOST || '127.0.0.1',
  databaseUrl: env.DATABASE_URL, dataRoot: path.resolve(env.DATA_ROOT || path.join(__dirname, '../../.local/data')),
  sessionSecret: env.SESSION_SECRET, tokenSecret: env.TOKEN_SECRET,
  publicUrl: env.PUBLIC_URL || 'http://localhost:8080',
  model: { baseUrl: env.MODEL_BASE_URL, name: env.MODEL_NAME, key: env.MODEL_API_KEY, timeout: Number(env.MODEL_TIMEOUT_MS || 120000), reviewTimeout: Number(env.MODEL_REVIEW_TIMEOUT_MS || 300000), concurrency: Number(env.MODEL_CONCURRENCY || 2) },
  jev: { baseUrl: env.JEV_BASE_URL || 'https://api.typesafe.ai', name: env.JEV_MODEL || 'jev-1.14.0', key: env.JEV_API_KEY },
  embeddingModel: env.EMBEDDING_MODEL,
  ocrUrl: env.OCR_URL, ocrToken: env.OCR_TOKEN,
  office: { url: env.ONLYOFFICE_URL, internalUrl: env.ONLYOFFICE_INTERNAL_URL || env.ONLYOFFICE_URL, secret: env.ONLYOFFICE_JWT_SECRET, backendUrl: env.BACKEND_URL_FOR_DOCKER || 'http://host.docker.internal:3000' },
  ding: { enabled: env.DINGTALK_ENABLED === 'true', clientId: env.DINGTALK_CLIENT_ID, secret: env.DINGTALK_CLIENT_SECRET, operatorId: env.DINGTALK_OPERATOR_ID },
};
function validateConfig() {
  if (!config.databaseUrl) throw new Error('必须配置 DATABASE_URL');
  for (const key of ['sessionSecret', 'tokenSecret']) {
    if (!config[key] || config[key].length < 32 || /replace-with/.test(config[key])) throw new Error(`${key} 必须配置至少 32 位随机值`);
  }
  if (config.env === 'production' && new URL(config.publicUrl).protocol !== 'https:') throw new Error('正式部署 PUBLIC_URL 必须使用 HTTPS');
}
module.exports = { config, validateConfig };
