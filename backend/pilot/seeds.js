const { randomUUID } = require('node:crypto');
const rule = (id, title, instruction, severity = 'medium', tags = []) => ({ id, title, instruction, severity, tags, mandatory: true });
const packs = [
  { pack_id: 'common', name: '通用审查标准（示例待法务确认）', scope: { level: 'common' }, rules: [
    rule('party', '交易主体与授权', '核查双方主体名称、履约主体及签署授权；不能通过公开信息推测其真实有效性。'),
    rule('payment', '价款及付款条件', '核查币种、金额计算口径、税费、付款条件与期限，识别明显冲突或单方变更权。', 'high'),
    rule('liability', '违约及责任限制', '核查违约责任、责任范围、免责与赔偿上限是否清晰，对我方明显不利条款提出人工复核。', 'high'),
    rule('dispute', '适用法律与争议解决', '核查法律适用和争议解决约定；境外法律适用只提示专项人工确认，不宣称已验证境外法合规。'),
  ] },
  { pack_id: 'procurement', name: '采购合同专项（示例待法务确认）', scope: { level: 'type', typeIds: ['procurement'] }, rules: [
    rule('delivery', '交付与验收', '核查货物规格、数量、交付地点时间、验收标准、异议期限与不合格品处理。', 'high'),
    rule('quality', '质量保证与售后', '核查质量保证期限、维修更换及质量责任安排。'),
    rule('ip', '知识产权与模具归属', '若涉及开模或知识产权，核查权属、使用权和交接；未涉及时说明不适用。', 'medium'),
  ] },
  { pack_id: 'warehouse', name: '海外仓专项（示例待法务确认）', scope: { level: 'type', typeIds: ['warehouse'] }, rules: [
    rule('inventory', '入库、库存与出库', '核查入库确认、库存盘点、出库指令、差异认定和证据保存安排。', 'high'),
    rule('cargo', '货损、丢失与保险', '核查仓储货损丢失责任、赔偿口径、免责、保险责任和索赔时限。', 'high'),
    rule('fees', '费用及退仓交接', '核查仓储、操作、退仓费用、调价条件、留置及终止后的货物交接。'),
    rule('foreign', '境外法律专项确认', '涉及境外仓储时必须标记境外法律和当地强制要求需人工专项确认，不得自动判断已合规。', 'high'),
  ] },
  { pack_id: 'software', name: '软件开发、许可与维护专项（示例待法务确认）', scope: { level: 'type', typeIds: ['software_license'] }, rules: [
    rule('software-scope', '服务范围与需求变更', '结合我方交易立场，核查软件开发、许可、订阅或维护的交易实质；明确功能清单、部署环境、账号及容量限制、接口、交付清单、第三方依赖与变更流程。若仅为现成软件许可，不强求定制开发需求书；核心范围需另议或可由一方单独变更时提示风险。', 'high'),
    rule('software-delivery', '交付进度与验收标准', '开发项目核查里程碑、交付方式、测试清单、可验证验收指标、合理验收期限、缺陷等级及复验机制；仅适用许可或SaaS时核查开通和可用性验收。识别极短异议期、使用即验收、缺少量化指标、供应商自行解释性能或一般缺陷无限延后修复。不得将合理的视为验收约定一概判为无效。', 'high'),
    rule('software-payment', '付款与验收及维护费用', '核查金额、税费、发票、预付款、阶段付款与交付验收的对应关系，识别高额预付、验收前付清、单方调价和隐藏的订阅或维护费用；从我方立场说明资金与履约风险。预付款比例本身不等于违法；如保护措施和背景不足，说明需人工核实。', 'high'),
    rule('software-license', '许可范围与使用限制', '区分定制开发成果、既有软件及SaaS。核查许可期限、人数、地域、部署环境、关联公司使用、备份迁移、续费及终止后可用性，识别实际业务超出许可、可任意撤销许可或停服的风险。交易不涉及软件使用许可时说明不适用，不能无依据要求独占或永久许可。'),
    rule('software-ip', '开发成果、源代码与知识产权', '区分我方资料、供应商既有技术、定制成果和第三方组件；核查成果归属、源码及构建资料交付、修改维护权限、源码托管或替代保障与侵权救济。结合是否定制开发和我方目标判断，不将商业软件未交源码直接判为违法；定制采购中权属与后续维护能力失衡应提出协商建议。', 'high'),
    rule('software-support', '维护响应、修复与服务连续性', '核查维护起算及期限、服务时间、故障等级、响应及恢复时限、升级兼容、备份恢复、停服通知与补救；识别只承诺响应、不约定修复，或将网络及第三方原因一概免责。第三方客观故障应结合控制范围和替代措施评价，不保证绝不中断。', 'high'),
    rule('software-data', '合同数据与个人信息受托处理', '核查合同及个人信息处理目的、范围、数据类别、期限、访问权限、保密、安全措施、存储地点、事件通知、删除返还及审计协助。识别将上传合同及日志默认用于训练或分析、脱敏及保留期限由对方自行决定的风险。不得凭合同推断已脱敏合规；涉及跨境处理或境外强制要求时明确需专项人工确认。', 'high'),
    rule('software-subcontract', '分包、第三方模型与数据接收方', '核查第三方开发、OCR、模型推理及云服务的使用范围、数据接收方、授权或通知机制、分包约束与供应商责任；识别无须告知或同意即可转交全部数据且缺少责任约束的情形。不一概认定所有第三方服务都必须取得同一种形式同意，按资料与适用条件提示人工核实。', 'high'),
    rule('software-exit', '解除、数据导出与迁移交接', '核查双方解除条件、通知期限、整改机会、预付款结算、数据导出格式时限费用、备份清理、接口开放和技术交接；识别一方短期任意解约、我方退出需付全部未履行费用、导出价格另议与过早删除数据等锁定风险。结合实际履行和可验证成本提出修改建议。', 'high'),
    rule('software-liability', '违约责任、免责与赔偿上限', '核查双方迟延责任、损失范围、免责及责任上限是否明显失衡，特别关注保密、数据、知识产权责任是否全部受极低上限限制；第三方和技术原因不能无条件排除全部可控责任。说明商业分配风险，不能仅凭比例或格式条款推断法律上当然无效。', 'high'),
    rule('software-dispute', '通知送达与争议解决冲突', '核查通知方式、地址变更、合理到达机制及争议解决是否明确；识别同时约定法院诉讼与仲裁但未明确适用关系、对方单方指定地点或发送即送达可能导致的实际风险。无可追溯法条时只提出文本冲突及人工核实，不编造法律规定或断言条款无效。'),
  ] },
];
const exampleVersion = '2026-10-29.software-1';
function examplePacks() {
  return structuredClone(packs).map(pack => ({ ...pack, id: `example:${pack.pack_id}:${exampleVersion}`, version_no: 1, state: 'example', knowledge: [] }));
}
function hasExample(typeId) { return packs.some(pack => pack.scope.level === 'type' && pack.scope.typeIds.includes(typeId)); }
async function seedDrafts(db) {
  for (const pack of packs) {
    if (!(await db('la_rule_versions').where({ pack_id: pack.pack_id }).first())) await db('la_rule_versions').insert({ id: randomUUID(), ...pack, scope: JSON.stringify(pack.scope), rules: JSON.stringify(pack.rules), knowledge: '[]', version_no: 1, state: 'draft' });
  }
}
module.exports = { seedDrafts, packs, examplePacks, hasExample, exampleVersion };
