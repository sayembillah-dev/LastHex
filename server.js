import express from 'express';
import compression from 'compression';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { Server } from 'socket.io';
import { Room, MAX_PLAYERS } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300;
const startedAt = Date.now();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.get('/health', (_req, res) => {
  let players = 0;
  for (const r of rooms.values()) players += r.players.size;
  res.json({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), rooms: rooms.size, players, sockets: io.engine.clientsCount });
});
// Self-hosted three.js (no CDN dependency); versioned file, so cache it hard.
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/three/build'), { maxAge: '30d', immutable: true }));
// App files change on deploy: always revalidate (ETag makes that cheap).
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));
app.use((_req, res) => res.status(404).send('Not found'));

const server = createServer(app);
const io = new Server(server, {
  perMessageDeflate: false,
  maxHttpBufferSize: 4096, // all client messages are tiny
  pingInterval: 10000,
  pingTimeout: 8000,
  cors: PROD ? undefined : { origin: true },
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();
const cleanText = (v, max) => String(v ?? '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const cleanNick = (n) => cleanText(n, 16) || 'Player' + Math.floor(100 + Math.random() * 900);
const roomList = () => [...rooms.values()].filter((r) => r.isPublic).map((r) => r.summary()).slice(0, 50);

let listTimer = null; // coalesce room-list pushes (many joins/leaves → one emit)
const pushList = () => {
  if (listTimer) return;
  listTimer = setTimeout(() => { listTimer = null; io.to('browser').emit('rooms', roomList()); }, 250);
};

function makeId() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike chars
  let id;
  do id = Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  while (rooms.has(id));
  return id;
}

function createRoom(name) {
  if (rooms.size >= MAX_ROOMS) return null;
  const id = makeId();
  const room = new Room(id, name, io, () => { rooms.delete(id); pushList(); log('room closed', id); }, pushList);
  rooms.set(id, room);
  log('room created', id);
  return room;
}

// ---------------------------------------------------------------- sockets
// Per-socket token bucket: generous for movement (~15/s), strict for everything else.
function limiter(rate, burst) {
  let tokens = burst, at = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - at) / 1000) * rate);
    at = now;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
}

io.on('connection', (socket) => {
  let room = null;
  const fast = limiter(30, 40);
  const slow = limiter(4, 8);
  const talk = limiter(1, 4); // chat: burst of 4, then 1 msg/s
  socket.join('browser');
  socket.emit('rooms', roomList());

  // Wrap every handler: rate limit + never let a bad payload crash the process.
  const on = (ev, bucket, fn) => socket.on(ev, (...args) => {
    if (!bucket()) return;
    try { fn(...args); } catch (err) { log('handler error', ev, err?.stack || err); }
  });

  function join(r, nick, look) {
    if (!r) return socket.emit('err', 'Server is busy, try again in a moment');
    if (r.players.size >= MAX_PLAYERS) return socket.emit('err', 'Room is full');
    if (room === r) return;
    if (room) leave();
    room = r;
    socket.leave('browser');
    socket.join(r.id);
    r.addPlayer(socket.id, cleanNick(nick), look);
    socket.emit('joined', { roomId: r.id, you: socket.id });
    socket.emit('chatHistory', r.chat);
    r.broadcastLobby();
    pushList();
  }

  function leave() {
    if (!room) return;
    const r = room;
    room = null;
    socket.leave(r.id);
    socket.join('browser');
    r.removePlayer(socket.id);
    pushList();
    socket.emit('rooms', roomList());
  }

  const obj = (v) => (v && typeof v === 'object' ? v : {});
  const isHost = () => room && room.hostId === socket.id;

  on('listRooms', slow, () => socket.emit('rooms', roomList()));
  on('createRoom', slow, (d) => { d = obj(d); join(createRoom(cleanText(d.name, 24) || `${cleanNick(d.nick)}'s room`), d.nick, d.look); });
  on('joinRoom', slow, (d) => {
    d = obj(d);
    const r = rooms.get(cleanText(d.roomId, 8).toUpperCase());
    if (!r) return socket.emit('err', 'Room not found or already closed');
    join(r, d.nick, d.look);
  });
  on('quickPlay', slow, (d) => {
    d = obj(d);
    // Prefer the fullest open lobby so players meet each other.
    const open = [...rooms.values()].filter((x) => x.isPublic && x.state === 'lobby' && x.players.size < MAX_PLAYERS);
    open.sort((a, b) => b.humanCount() - a.humanCount());
    join(open[0] || createRoom('Quick Play'), d.nick, d.look);
  });
  on('leaveRoom', slow, leave);
  on('setLook', slow, (look) => room && room.setLook(socket.id, obj(look)));
  on('start', slow, () => isHost() && room.start());
  on('addBot', slow, () => isHost() && room.addBot());
  on('removeBots', slow, () => isHost() && room.removeBots());
  on('chat', talk, (text) => {
    if (!room || typeof text !== 'string') return;
    const t = text.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (t) room.say(socket.id, t);
  });
  on('pos', fast, (pos) => room && room.setPos(socket.id, obj(pos)));
  socket.on('disconnect', () => { try { leave(); } catch (err) { log('leave error', err); } });
});

// ---------------------------------------------------------------- lifecycle
process.on('uncaughtException', (err) => log('uncaught', err?.stack || err));
process.on('unhandledRejection', (err) => log('unhandled rejection', err));

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  log(`${sig}: shutting down`);
  io.emit('serverRestart');
  for (const r of rooms.values()) r.stop();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => log(`Laser Drop running on http://localhost:${PORT}`));
