const { Server } = require('socket.io');
const { config } = require('./config');
const { accessible } = require('./auth');
function setupRealtime(server, db, sessionMiddleware) {
  const io = new Server(server, { cors: { origin: new URL(config.publicUrl).origin, credentials: true } });
  io.engine.use(sessionMiddleware);
  io.use(async (socket, next) => {
    try { const user = await db('la_users').where({ id: socket.request.session?.userId, active: true }).first(); if (!user) throw new Error('unauthorized'); socket.data.userId = user.id; socket.data.contracts = new Set(); next(); }
    catch { next(new Error('unauthorized')); }
  });
  io.on('connection', socket => socket.on('join-contract', async (id, ack) => {
    try {
      if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('invalid');
      const user = await db('la_users').where({ id: socket.data.userId, active: true }).first();
      if (!user) throw new Error('unauthorized');
      await accessible(db, user, id);
      if (socket.data.contracts.size >= 30) throw new Error('limit');
      socket.data.contracts.add(id); if (typeof ack === 'function') ack({ ok: true });
    } catch { if (typeof ack === 'function') ack({ ok: false }); }
  }));
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return; polling = true;
    try {
      for (const socket of io.sockets.sockets.values()) {
        const user = await db('la_users').where({ id: socket.data.userId, active: true }).first();
        if (!user) { socket.disconnect(true); continue; }
        for (const id of socket.data.contracts) {
          try {
            const c = await accessible(db, user, id);
            const run = c.current_review_id && await db('la_reviews').where({ id: c.current_review_id }).select('id', 'status', 'stage', 'progress', 'updated_at').first();
            socket.emit('review-progress', { contractId: id, review: run });
          } catch { socket.data.contracts.delete(id); }
        }
      }
    } catch { console.error('socket_poll_failed'); } finally { polling = false; }
  }, 3000);
  return { io, close: async () => { clearInterval(timer); await new Promise(resolve => io.close(resolve)); } };
}
module.exports = { setupRealtime };
