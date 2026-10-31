const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { randomBytes } = require('node:crypto');
const { config } = require('./config');
const { wrap, fail } = require('./errors');
const { verifyPassword, hashPassword, publicUser, audit } = require('./auth');
const { router } = require('./routes');
const office = require('./office');
function createApp(db, { sessionName = 'legal.sid' } = {}) {
  const app = express(); app.disable('x-powered-by');
  const proxyHops=Number(process.env.TRUST_PROXY_HOPS||0);if(Number.isInteger(proxyHops)&&proxyHops>0&&proxyHops<=2)app.set('trust proxy',proxyHops);
  const officeOrigin = config.office.url ? new URL(config.office.url).origin : null;
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'", ...(officeOrigin ? [officeOrigin] : [])], 'frame-src': ["'self'", ...(officeOrigin ? [officeOrigin] : [])], 'img-src': ["'self'", 'data:', 'blob:'], 'worker-src': ["'self'", 'blob:'], 'connect-src': ["'self'", ...(officeOrigin ? [officeOrigin] : [])], 'upgrade-insecure-requests': config.env === 'production' ? [] : null } }, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '5mb' }));
  const store = new PgStore({ conString: config.databaseUrl, tableName: 'la_sessions', createTableIfMissing: true });
  const sessionMiddleware = session({ store, secret: config.sessionSecret, resave: false, saveUninitialized: false, name: sessionName, cookie: { httpOnly: true, sameSite: 'strict', secure: config.env === 'production', maxAge: 8 * 3600000 } });
  app.use(sessionMiddleware);
  app.use(wrap(async (req, res, next) => { req.user = req.session.userId ? await db('la_users').where({ id: req.session.userId, active: true }).first() : null; next(); }));
  app.get('/api/health', wrap(async (req, res) => { await db.raw('select 1'); res.json({ ok: true, service: 'legal-agent', version: '1.0.0' }); }));
  app.get('/api/auth/session', (req, res) => { req.session.csrf ||= randomBytes(32).toString('hex'); res.set('Cache-Control', 'no-store').json({ user: req.user ? publicUser(req.user) : null, csrf: req.session.csrf }); });
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/onlyoffice/callback') return next();
    if (req.headers.origin && req.headers.origin !== new URL(config.publicUrl).origin) return res.status(403).json({ code: 'ORIGIN', message: '请求来源不允许' });
    if (!req.session.csrf || req.headers['x-csrf-token'] !== req.session.csrf) return res.status(403).json({ code: 'CSRF', message: '会话校验失败，请刷新页面' }); next();
  });
  const attempts = new Map(); const dummy = hashPassword(randomBytes(24).toString('hex'));
  app.post('/api/auth/login', wrap(async (req, res) => {
    if (typeof req.body.username !== 'string' || typeof req.body.password !== 'string' || req.body.password.length > 200) fail(400, 'LOGIN_FORMAT', '请填写账号和密码');
    const key = req.ip; let a = attempts.get(key); if (!a || Date.now() > a.until) { a = { count: 0, until: Date.now() + 900000 }; attempts.set(key, a); }
    if (++a.count > 10) fail(429, 'LOGIN_LIMIT', '尝试过多，请 15 分钟后重试');
    if (attempts.size > 10000) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
    const user = await db('la_users').where({ username: req.body.username, active: true }).first();
    const ok = await verifyPassword(req.body.password, user?.password_hash || await dummy);
    if (!user || !ok) fail(401, 'LOGIN_FAILED', '账号或密码不正确');
    attempts.delete(key); await new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
    req.session.userId = user.id; req.session.csrf = randomBytes(32).toString('hex');
    await audit(db, user, 'auth.login', user.id); res.json({ user: publicUser(user), csrf: req.session.csrf });
  }));
  app.post('/api/auth/logout', wrap(async (req, res) => { await new Promise((resolve, reject) => req.session.destroy(e => e ? reject(e) : resolve())); res.clearCookie(sessionName).json({ ok: true }); }));
  app.use('/api', office.publicRouter(db));
  app.use('/api', (req, res, next) => req.user ? next() : res.status(401).json({ code: 'LOGIN_REQUIRED', message: '请先登录' }));
  app.use('/api', require('./dingtalk-account').accountRouter(db), office.privateRouter(db), router(db));
  app.use('/api', (req, res) => res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' }));
  const dist = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html'))); }
  app.use((e, req, res, next) => {
    if (res.headersSent) return next(e);
    const status = e.name === 'ZodError' ? 400 : e.code === 'LIMIT_FILE_SIZE' ? 413 : e.code === '23505' ? 409 : e.code === '22P02' ? 400 : e.status || 500;
    const message = e.name === 'ZodError' ? '输入格式无效，请检查必填内容' : e.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 50MB' : status >= 500 ? '服务处理失败，请联系管理员并提供任务编号' : e.message;
    if (status >= 500) console.error(JSON.stringify({ error: e.code || e.name, route: req.route?.path }));
    res.status(status).json({ code: e.code || 'REQUEST_ERROR', message });
  });
  return { app, sessionMiddleware, close: () => store.close() };
}
module.exports = { createApp };
