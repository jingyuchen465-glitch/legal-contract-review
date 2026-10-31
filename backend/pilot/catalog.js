const catalog = [
  { id: 'production', name: '生产采购合同', types: [ ['procurement', '采购合同', true], ['mold', '开模合同'], ['manufacturing', '委托生产合同'] ] },
  { id: 'logistics', name: '跨境物流仓储合同', types: [ ['warehouse', '海外仓仓储服务合同', true], ['customs', '海外清关服务合同'], ['first_mile', '头程国际物流服务合同'], ['freight', '跨境货运代理服务合同'], ['booking', '国际海运订舱服务协议'] ] },
  { id: 'marketing', name: '营销推广服务合同', types: [ ['ads', '投流合同'], ['influencer', '达人营销推广服务协议'], ['portrait', '模特拍摄与肖像许可合同'], ['douyin', '抖音数据服务协议'] ] },
  { id: 'software', name: '软件许可合同', types: [ ['software_license', '软件许可合同'] ] },
  { id: 'other', name: '其他', types: [ ['other', '其他'] ] },
].map(c => ({ ...c, types: c.types.map(([id, name, pilot = false]) => ({ id, name, pilot })) }));
const tags = ['开模', '模具归属', '肖像许可', '知识产权', '清关', '运输', '数据处理', '境外法律'];
function findType(id) { for (const c of catalog) { const t = c.types.find(t => t.id === id); if (t) return { ...t, categoryId: c.id, categoryName: c.name }; } return null; }
module.exports = { catalog, tags, findType, catalogVersion: '2026-10-31.1' };
