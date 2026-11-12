import { buildTiles, worldToAxial, axialToWorld, tileKey, ARENA_RADIUS, COLORS, HATS } from './public/hex.js';

export const MAX_PLAYERS = 8;

// Flow: lobby (free roam, everyone visible)
//   → plan (5 s, simultaneous, each player only sees themselves)
//   → reveal (everyone appears with aim lines) → result (all fire at once, hits die)
//   → shrink (outer ring drops) → plan … until one player is left → ended → lobby
const TICK = 10;
const DT = 1 / TICK;
const PLAN_TIME = 3;
const REVEAL_TIME = 0.9;
const RESULT_TIME = 1.8;
const SHRINK_TIME = 0.8;
const END_TIME = 5;
const HIT_RADIUS = 0.55;
const RANGE = 40;
const MIN_RING = 1;
const MAX_ROUNDS = 10; // stops endless stalemates (e.g. AFK players who never get hit)
const BOT_SPEED = 3;
const BOT_NAMES = ['Bolt', 'Sparky', 'Gizmo', 'Rusty', 'Zapper', 'Cog', 'Widget', 'Ratchet'];

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (Number.isFinite(+v) ? +v : null);

export function cleanLook(look = {}) {
  return {
    color: COLORS.includes(look.color) ? look.color : COLORS[Math.floor(Math.random() * COLORS.length)],
    hat: HATS.includes(look.hat) ? look.hat : 'none',
  };
}

export class Room {
  constructor(id, name, io, onEmpty, onChange) {
    Object.assign(this, { id, name, io, onEmpty, onChange });
    this.isPublic = true;
    this.players = new Map();
    this.state = 'lobby';
    this.hostId = null;
    this.tiles = buildTiles();
    this.tileIdx = new Map(this.tiles.map((t, i) => [tileKey(t.q, t.r), i]));
    this.tileState = this.tiles.map(() => '1');
    this.ring = ARENA_RADIUS;
    this.round = 0;
    this.t = 0;
    this.roundDead = new Set();
    this.winner = null;
    this.botSeq = 0;
    this.timer = setInterval(() => this.tick(), 1000 / TICK);
  }

  // ------------------------------------------------------------ room / lobby
  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  summary() {
    return { id: this.id, name: this.name, count: this.players.size, max: MAX_PLAYERS, state: this.state === 'lobby' ? 'lobby' : 'playing' };
  }

  lobbyInfo() {
    return {
      id: this.id, name: this.name, state: this.state === 'lobby' ? 'lobby' : 'playing', hostId: this.hostId,
      players: [...this.players.values()].map((p) => ({ id: p.id, nick: p.nick, color: p.color, hat: p.hat, bot: p.isBot, wins: p.wins, kills: p.kills })),
    };
  }

  broadcastLobby() {
    this.io.to(this.id).emit('lobby', this.lobbyInfo());
  }

  addPlayer(id, nick, look, isBot = false) {
    const spot = this.randomSpot();
    this.players.set(id, {
      id, nick, isBot, ...cleanLook(look), wins: 0, kills: 0,
      alive: this.state === 'lobby', // joining mid-game = spectate until back in the lobby
      x: spot.x, z: spot.z, aim: Math.atan2(-spot.z, -spot.x), bot: null,
    });
    if (!this.hostId && !isBot) this.hostId = id;
  }

  addBot() {
    if (this.state !== 'lobby' || this.players.size >= MAX_PLAYERS) return;
    const n = ++this.botSeq;
    this.addPlayer('bot-' + n, BOT_NAMES[(n - 1) % BOT_NAMES.length] + ' (bot)', { hat: HATS[Math.floor(Math.random() * HATS.length)] }, true);
    this.broadcastLobby();
    this.onChange();
  }

  removeBots() {
    if (this.state !== 'lobby') return;
    for (const [id, p] of this.players) if (p.isBot) this.players.delete(id);
    this.broadcastLobby();
    this.onChange();
  }

  removePlayer(id) {
    this.players.delete(id);
    const humans = [...this.players.values()].filter((p) => !p.isBot);
    if (!humans.length) {
      clearInterval(this.timer);
      this.onEmpty();
      return;
    }
    if (this.hostId === id) this.hostId = humans[0].id;
    this.broadcastLobby();
  }

  stop() {
    clearInterval(this.timer);
  }

  setLook(id, look) {
    const p = this.players.get(id);
    if (!p || this.state !== 'lobby') return;
    Object.assign(p, cleanLook(look));
    this.broadcastLobby();
  }

  // Client-driven movement, only while roaming or planning, only onto solid floor.
  setPos(id, pos) {
    const p = this.players.get(id);
    if (!p || !p.alive || !pos || (this.state !== 'lobby' && this.state !== 'plan')) return;
    const x = num(pos.x), z = num(pos.z), aim = num(pos.aim);
    if (x !== null && z !== null && this.solidAt(x, z)) { p.x = x; p.z = z; }
    if (aim !== null) p.aim = aim;
  }

  // ------------------------------------------------------------ game flow
  start() {
    if (this.state !== 'lobby' || this.players.size < 2) return;
    this.round = 0;
    this.winner = null;
    for (const p of this.players.values()) { p.alive = true; p.kills = 0; }
    this.beginRound(); // switch state first so the lobby broadcast already says "playing"
    this.broadcastLobby();
    this.onChange();
  }

  setPhase(state, t) {
    this.state = state;
    this.t = t;
    this.dur = t;
    this.broadcast();
  }

  alivePlayers() {
    return [...this.players.values()].filter((p) => p.alive);
  }

  beginRound() {
    if (this.alivePlayers().length <= 1) return this.endGame();
    this.round++;
    this.roundDead = new Set();
    for (const p of this.players.values()) if (p.isBot) p.bot = null;
    this.setPhase('plan', PLAN_TIME);
  }

  fire() {
    const shooters = this.alivePlayers();
    const shots = [];
    for (const s of shooters) {
      const dx = Math.cos(s.aim), dz = Math.sin(s.aim);
      let best = null, bestT = RANGE;
      for (const o of shooters) {
        if (o === s) continue;
        const fx = o.x - s.x, fz = o.z - s.z;
        const t = fx * dx + fz * dz;
        if (t <= 0) continue;
        const perp2 = fx * fx + fz * fz - t * t;
        if (perp2 > HIT_RADIUS * HIT_RADIUS) continue;
        const th = Math.max(0, t - Math.sqrt(HIT_RADIUS * HIT_RADIUS - perp2));
        if (th < bestT) { bestT = th; best = o; }
      }
      shots.push({ id: s.id, x1: r2(s.x), z1: r2(s.z), x2: r2(s.x + dx * bestT), z2: r2(s.z + dz * bestT), hit: best ? best.id : null });
      if (best) {
        this.roundDead.add(best.id);
        s.kills++;
        this.io.to(this.id).emit('feed', { victim: best.nick, killer: s.nick, vc: best.color, kc: s.color });
      }
    }
    // Simultaneous: everyone has already fired before anyone is removed.
    for (const id of this.roundDead) this.players.get(id).alive = false;
    this.io.to(this.id).emit('shots', shots);
  }

  endGame() {
    const alive = this.alivePlayers();
    const w = alive.length === 1 ? alive[0] : null;
    if (w) w.wins++;
    this.winner = w ? w.id : null;
    const standings = [...this.players.values()]
      .map((p) => ({ id: p.id, nick: p.nick, color: p.color, kills: p.kills, wins: p.wins, won: p === w, alive: p.alive }))
      .sort((a, b) => b.won - a.won || b.alive - a.alive || b.kills - a.kills);
    this.io.to(this.id).emit('roundEnd', { winner: w ? w.nick : null, winnerId: w ? w.id : null, rounds: this.round, survivors: alive.length, standings });
    this.setPhase('ended', END_TIME);
    this.broadcastLobby();
    this.onChange();
  }

  backToLobby() {
    this.tileState = this.tiles.map(() => '1');
    this.ring = ARENA_RADIUS;
    this.round = 0;
    this.roundDead = new Set();
    for (const p of this.players.values()) {
      p.alive = true;
      if (!this.solidAt(p.x, p.z)) Object.assign(p, this.randomSpot());
    }
    this.state = 'lobby';
    this.broadcastLobby();
    this.onChange();
  }

  tick() {
    this.botsAct();
    if (this.state !== 'lobby') {
      this.t -= DT;
      if (this.state === 'plan' && this.alivePlayers().length <= 1) return this.endGame();
      if (this.t <= 0) {
        const s = this.state;
        if (s === 'plan') this.setPhase('reveal', REVEAL_TIME);
        else if (s === 'reveal') { this.fire(); this.setPhase('result', RESULT_TIME); this.warnRing(); }
        else if (s === 'result') {
          if (this.alivePlayers().length <= 1 || this.round >= MAX_ROUNDS) this.endGame();
          else if (this.ring > MIN_RING) {
            this.setRing(this.ring, '0');
            this.ring--;
            // Anyone standing on the dropped ring slides to the nearest safe tile.
            for (const p of this.alivePlayers()) if (!this.solidAt(p.x, p.z)) Object.assign(p, this.nearestSolid(p.x, p.z));
            this.setPhase('shrink', SHRINK_TIME);
          } else this.beginRound();
        } else if (s === 'shrink') this.beginRound();
        else if (s === 'ended') this.backToLobby();
      }
    }
    this.broadcast();
  }

  // ------------------------------------------------------------ bots
  botsAct() {
    if (this.state !== 'lobby' && this.state !== 'plan') return;
    for (const p of this.players.values()) {
      if (!p.isBot || !p.alive) continue;
      if (!p.bot || (this.state === 'lobby' && (p.bot.wait -= DT) <= 0)) {
        const spot = this.randomSpot();
        const tgt = this.randomSpot();
        p.bot = { tx: spot.x, tz: spot.z, aim: Math.atan2(tgt.z * 0.5 - spot.z, tgt.x * 0.5 - spot.x), wait: 2 + Math.random() * 3 };
      }
      const dx = p.bot.tx - p.x, dz = p.bot.tz - p.z, d = Math.hypot(dx, dz);
      const step = Math.min(d, BOT_SPEED * DT);
      if (d > 0.01) {
        const nx = p.x + (dx / d) * step, nz = p.z + (dz / d) * step;
        if (this.solidAt(nx, nz)) { p.x = nx; p.z = nz; }
      }
      p.aim += Math.atan2(Math.sin(p.bot.aim - p.aim), Math.cos(p.bot.aim - p.aim)) * 0.3;
    }
  }

  // ------------------------------------------------------------ floor
  warnRing() {
    if (this.ring > MIN_RING && this.alivePlayers().length > 1) this.setRing(this.ring, '2');
  }

  setRing(ring, s) {
    this.tiles.forEach((t, i) => { if (t.ring === ring && this.tileState[i] !== '0') this.tileState[i] = s; });
  }

  solidAt(x, z) {
    const { q, r } = worldToAxial(x, z);
    const i = this.tileIdx.get(tileKey(q, r));
    return i !== undefined && this.tileState[i] !== '0';
  }

  openTiles() {
    return this.tiles.filter((t, i) => this.tileState[i] !== '0').map((t) => axialToWorld(t.q, t.r));
  }

  randomSpot() {
    const open = this.openTiles();
    const c = open[Math.floor(Math.random() * open.length)];
    return { x: c.x + (Math.random() - 0.5) * 0.8, z: c.z + (Math.random() - 0.5) * 0.8 };
  }

  nearestSolid(x, z) {
    let best = null, bd = Infinity;
    for (const c of this.openTiles()) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) { bd = d; best = c; }
    }
    return { x: best.x, z: best.z };
  }

  // ------------------------------------------------------------ snapshots (per viewer: planning is blind)
  snapshotFor(viewerId) {
    const blind = this.state === 'plan';
    const shown = [...this.players.values()].filter((p) => (p.alive || this.roundDead.has(p.id)) && (!blind || p.id === viewerId));
    const me = this.players.get(viewerId);
    return {
      s: this.state,
      t: r2(Math.max(0, this.t)),
      d: this.dur || 0,
      round: this.round,
      tiles: this.tileState.join(''),
      w: this.winner,
      me: me?.alive ? 1 : 0,
      al: this.alivePlayers().map((p) => p.id),
      p: shown.map((p) => ({ id: p.id, x: r2(p.x), z: r2(p.z), a: r2(p.aim), dead: p.alive ? 0 : 1 })),
    };
  }

  broadcast() {
    for (const p of this.players.values()) if (!p.isBot) this.io.to(p.id).emit('state', this.snapshotFor(p.id));
  }
}
