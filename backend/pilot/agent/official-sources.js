const https = require('node:https');
const dns = require('node:dns/promises');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail } = require('../errors');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function officialUrl(value) {
  let url; try { url = new URL(value); } catch { fail(400, 'OFFICIAL_URL', '官方资料地址无效'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(host === 'gov.cn' || host.endsWith('.gov.cn') || host === 'npc.gov.cn' || host.endsWith('.npc.gov.cn'))) {
    fail(403, 'OFFICIAL_DOMAIN_REQUIRED', '仅允许读取政府和司法机关的 HTTPS 官方来源');
  }
  url.hash = ''; return url;
}
function publicAddress(address) {
  if (address.includes(':')) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):|^2002:/i.test(address);
  const n = address.split('.').map(Number);
  return n.length === 4 && n.every(x => Number.isInteger(x) && x >= 0 && x <= 255) &&
    n[0] > 0 && n[0] !== 10 && n[0] !== 127 && n[0] < 224 &&
    !(n[0] === 169 && n[1] === 254) && !(n[0] === 172 && n[1] >= 16 && n[1] <= 31) &&
    !(n[0] === 192 && [0, 168].includes(n[1])) && !(n[0] === 100 && n[1] >= 64 && n[1] <= 127) &&
    !(n[0] === 198 && [18, 19, 51].includes(n[1])) && !(n[0] === 203 && n[1] === 0 && n[2] === 113);
}
async function fetchOfficial(value, { lookup = dns.lookup, timeout = 20000, maxBytes = 2 * 1024 * 1024 } = {}, redirects = 0) {
  const url = officialUrl(value);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) fail(403, 'OFFICIAL_ADDRESS', '官方来源解析到不允许访问的地址');
  const pinned = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'LegalContractReview/2.0', Accept: 'text/html,text/plain,application/pdf', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      timeout,
    }, res => {
      const parts = []; let size = 0;
      res.on('data', part => { size += part.length; if (size > maxBytes) res.destroy(new Error('SOURCE_TOO_LARGE')); else parts.push(part); });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('timeout', () => req.destroy(new Error('SOURCE_TIMEOUT'))); req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 3 || !response.headers.location) fail(422, 'OFFICIAL_REDIRECT', '官方来源重定向次数过多');
    return fetchOfficial(new URL(response.headers.location, url).href, { lookup, timeout, maxBytes }, redirects + 1);
  }
  if (response.status !== 200) fail(422, 'OFFICIAL_FETCH_FAILED', `官方来源返回 HTTP ${response.status}`);
  return { ...response, url: url.href };
}
function plainHtml(html) {
  return html.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(?:p|div|br|h[1-6]|li|tr|article|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
async function readOfficial(value, options) {
  const r = await fetchOfficial(value, options), type = r.headers['content-type'] || '';
  let content, title;
  if (type.includes('application/pdf')) {
    const { PDFParse } = require('pdf-parse');
    // The installed pdf-parse 1.x exposes a function; newer versions expose PDFParse.
    if (PDFParse) { const parser = new PDFParse({ data: r.body }); try { content = (await parser.getText()).text; } finally { await parser.destroy(); } }
    else content = (await require('pdf-parse')(r.body)).text;
    title = new URL(r.url).pathname.split('/').at(-1) || '官方 PDF 资料';
  } else {
    if (!/text\/(?:html|plain)|application\/xhtml/i.test(type)) fail(422, 'OFFICIAL_CONTENT_TYPE', '官方来源不是可识别的正文');
    const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(type)?.[1] || /charset=["']?([\w-]+)/i.exec(r.body.toString('ascii', 0, 2048))?.[1] || 'utf-8';
    let html; try { html = new TextDecoder(charset).decode(r.body); } catch { fail(422, 'OFFICIAL_ENCODING', '官方来源编码无法识别'); }
    title = plainHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '官方法律资料').slice(0, 250);
    content = plainHtml(html);
  }
  if (!content || content.length < 200 || content.length > 500000) fail(422, 'OFFICIAL_BODY_UNAVAILABLE', '未获取到可核验的完整正文，不能使用网页标题代替依据');
  return { title, content, url: r.url, sha256: hash(content), validity: 'unverified' };
}
async function searchOfficial(query, key, { fetchImpl = fetch } = {}) {
  if (!key) return { available: false, limitation: '官方来源搜索服务未配置，可使用内部法律库或读取已知官方链接。', results: [] };
  const clean = String(query).replace(/https?:\/\/\S+|\b(?:site|filetype|inurl):\S+/gi, ' ').trim().slice(0, 500);
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', `${clean} (site:gov.cn OR site:npc.gov.cn)`); url.searchParams.set('count', '10'); url.searchParams.set('search_lang', 'zh-hans');
  try {
    const r = await fetchImpl(url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!r.ok) return { available: false, limitation: `官方来源检索失败（HTTP ${r.status}），不能据此推断没有相关法律。`, results: [] };
    const data = await r.json();
    return { available: true, results: (data.web?.results || []).flatMap(x => { try { return [{ title: x.title, url: officialUrl(x.url).href, snippet: x.description || '', evidence: false }]; } catch { return []; } }) };
  } catch { return { available: false, limitation: '官方来源搜索暂时不可用，相关法律与案例需进一步核实。', results: [] }; }
}
async function localLawCatalog() {
  const root = path.resolve(__dirname, '../../data/laws'), result = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        const content = await fs.readFile(file, 'utf8');
        result.push({ id: hash(path.relative(root, file) + ':' + hash(content)), title: path.relative(root, file).replaceAll('\\', '/').replace(/\.md$/, ''), content, sha256: hash(content), validity: 'unverified', kind: 'internal_law' });
      }
    }
  }
  try { await walk(root); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return result;
}
module.exports = { officialUrl, publicAddress, fetchOfficial, plainHtml, readOfficial, searchOfficial, localLawCatalog, hash };
