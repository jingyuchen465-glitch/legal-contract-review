const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../pilot/config');
const { createGateway } = require('../pilot/model');
const document = { blocks: [{ id: 'b1', text: '甲方：虚构采购有限公司。乙方：虚构供应有限公司。退款期限为5个工作日。' }] };
const valid = () => ({ contractType: '采购服务退款协议', parties: [{ name: '虚构采购有限公司', label: '甲方', role: '退款收款方', evidence: [{ blockId: 'b1', quote: '甲方：虚构采购有限公司' }] }], reviewPoints: [{ title: '退款到账期限', instruction: '核查5个工作日的起算日与到账标准', evidence: [{ blockId: 'b1', quote: '退款期限为5个工作日' }] }], corePurposes: ['确保按时收到退款'] });
async function run(responder, fn) {
  const saved = { ...config.model }; Object.assign(config.model, { baseUrl: 'http://localhost:9999/v1', name: 'preanalysis-fixture', key: 'fixture-only' });
  let calls = 0;
  try { const gateway = createGateway(null, { fetchImpl: async (_, req) => { calls++; const input = JSON.parse(JSON.parse(req.body).messages[1].content); return Response.json({ choices: [{ message: { content: JSON.stringify(await responder(input, calls)) } }] }); } }); await fn(gateway, () => calls); }
  finally { Object.assign(config.model, saved); }
}
