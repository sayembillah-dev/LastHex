import * as THREE from 'three';
import { buildTiles, axialToWorld, worldToAxial, tileKey, COLORS, HATS } from './hex.js';

const $ = (id) => document.getElementById(id);
const TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.body.classList.add(TOUCH ? 'touch' : 'desktop');
function fatal(msg) {
  const el = $('fatal');
  el.textContent = msg;
  el.classList.remove('hidden');
  throw new Error(msg);
}
document.addEventListener('gesturestart', (e) => e.preventDefault()); // no pinch-zoom on iOS

const socket = io({ transports: ['websocket'], reconnectionDelay: 500, reconnectionDelayMax: 4000 });
let myId = null, roomInfo = null, snap = null, lastTiles = '', myAim = 0, winnerText = '';
const look = store.get('look', { color: COLORS[Math.floor(Math.random() * COLORS.length)], hat: 'cap' });
$('nick').value = store.get('nick', '');
const pendingRoom = new URLSearchParams(location.search).get('room');

// ---------------------------------------------------------------- renderer
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: devicePixelRatio < 2, alpha: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
} catch {
  fatal('Your browser or device does not support WebGL, which Laser Drop needs. Try an up-to-date Chrome, Safari or Firefox.');
}
$('c').addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast('Graphics were reset, reloading…'); setTimeout(() => location.reload(), 1200); });
renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.5 : 2));
renderer.shadowMap.enabled = !TOUCH;
const scene = new THREE.Scene();
scene.background = null; // CSS gradient sky shows through (free)
scene.fog = new THREE.Fog('#14202e', 42, 80);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);
const CAM_OFF = new THREE.Vector3(20, 20, 20);
// Iso screen directions projected on the ground (camera sits at +x,+y,+z).
const RIGHT = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
const UPG = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };
const ISO_SIN = 0.577; // how much ground "up" shrinks on screen
const cam = { vh: 20, tx: 0, tz: 0 };

scene.add(new THREE.HemisphereLight('#d9ecff', '#3a2f4a', 1.9));
const sun = new THREE.DirectionalLight('#fff0dc', 2.6);
sun.position.set(8, 20, 4);
if (!TOUCH) {
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, far: 50 });
}
scene.add(sun);
function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const gridTex = canvasTex(128, (g, n) => {
  g.fillStyle = '#0d1a26';
  g.fillRect(0, 0, n, n);
  g.strokeStyle = 'rgba(46,230,214,0.22)';
  g.lineWidth = 2;
  // one hex cell per tile, wraps seamlessly
  const r = n / 4, h = r * Math.sqrt(3) / 2;
  for (const [cx, cy] of [[n / 4, n / 4], [n * 3 / 4, n * 3 / 4]]) {
    g.beginPath();
    for (let i = 0; i <= 6; i++) { const a = Math.PI / 3 * i; g.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a) * (h / r) * 1.15); }
    g.stroke();
  }
});
gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping;
gridTex.repeat.set(60, 60);
const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ map: gridTex }));
voidPlane.rotation.x = -Math.PI / 2;
voidPlane.position.y = -16;
scene.add(voidPlane);
// Soft glow under the arena so the floor reads as floating.
const radial = (inner, outer) => canvasTex(64, (g, n) => {
  const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, n, n);
});
const glowTex = radial('rgba(46,230,214,0.5)', 'rgba(46,230,214,0)');
const blobTex = radial('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)');
const underGlow = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
underGlow.rotation.x = -Math.PI / 2;
underGlow.position.y = -15.9;
underGlow.scale.setScalar(1.6);
scene.add(underGlow);

// Floating island under the arena (shrinks with the floor) + a few drifting rocks.
const rockMat = new THREE.MeshLambertMaterial({ color: '#5b5470', flatShading: true });
const islandGeo = new THREE.ConeGeometry(1, 1, 9, 3);
{
  const p = islandGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0.49) { const j = 0.85 + Math.random() * 0.3; p.setX(i, p.getX(i) * j); p.setZ(i, p.getZ(i) * j); p.setY(i, y + (Math.random() - 0.5) * 0.08); }
  }
  islandGeo.computeVertexNormals();
}
const island = new THREE.Mesh(islandGeo, rockMat);
island.rotation.x = Math.PI; // point down
scene.add(island);
const islandSize = { r: 0, goal: 0 };
function setIslandGoal(ring) { islandSize.goal = ring * 1.4 + 0.7; }
setIslandGoal(5);
islandSize.r = islandSize.goal;
const ROCKS = 10;
const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMat, ROCKS);
const rockData = Array.from({ length: ROCKS }, (_, i) => ({
  a: (i / ROCKS) * Math.PI * 2 + Math.random() * 0.4, d: 11 + Math.random() * 5, y: -3 - Math.random() * 6,
  s: 0.35 + Math.random() * 0.7, sp: 0.03 + Math.random() * 0.04, ph: Math.random() * 6,
}));
scene.add(rocks);

// Sparkles: one Points draw call drifting upward.
const SPARKS = TOUCH ? 90 : 160;
const sparkPos = new Float32Array(SPARKS * 3);
for (let i = 0; i < SPARKS; i++) { sparkPos[i * 3] = (Math.random() - 0.5) * 40; sparkPos[i * 3 + 1] = Math.random() * 24 - 14; sparkPos[i * 3 + 2] = (Math.random() - 0.5) * 40; }
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
  size: 0.22, map: radial('rgba(180,255,250,1)', 'rgba(180,255,250,0)'), transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending, opacity: 0.8,
}));
scene.add(sparks);

function animateWorld(dt, t) {
  gridTex.offset.x = (t * 0.02) % 1;
  gridTex.offset.y = (t * 0.012) % 1;
  islandSize.r += (islandSize.goal - islandSize.r) * Math.min(1, dt * 2.5);
  island.scale.set(islandSize.r, islandSize.r * 1.1, islandSize.r);
  island.position.y = -0.75 - islandSize.r * 0.55;
  for (let i = 0; i < ROCKS; i++) {
    const r = rockData[i];
    r.a += r.sp * dt;
    dummy.position.set(Math.cos(r.a) * r.d, r.y + Math.sin(t * 0.8 + r.ph) * 0.4, Math.sin(r.a) * r.d);
    dummy.rotation.set(t * 0.2 + r.ph, t * 0.15, 0);
    dummy.scale.setScalar(r.s);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  dummy.rotation.set(0, 0, 0);
  dummy.scale.setScalar(1);
  rocks.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < SPARKS; i++) {
    sparkPos[i * 3 + 1] += dt * 0.6;
    if (sparkPos[i * 3 + 1] > 10) sparkPos[i * 3 + 1] = -14;
  }
  sparkGeo.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------- tiles (single instanced draw call)
const tileDefs = buildTiles();
let arenaRing = 5; // outermost ring still standing (camera zooms in as it shrinks)
const N = tileDefs.length;
const tileGeo = new THREE.CylinderGeometry(0.9, 0.95, 0.6, 6);
{ // top face bright, sides darker: reads as a chunky beveled tile under any light
  const n = tileGeo.attributes.normal, col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) { const v = n.getY(i) > 0.5 ? 1 : n.getY(i) < -0.5 ? 0.35 : 0.62; col.set([v, v, v * 1.05], i * 3); }
  tileGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
const tileMesh = new THREE.InstancedMesh(tileGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), N);
tileMesh.receiveShadow = true;
tileMesh.frustumCulled = false;
const tileBase = [], tileY = new Float32Array(N), tileVy = new Float32Array(N), tileSt = new Array(N).fill('1');
const dummy = new THREE.Object3D(), tmpC = new THREE.Color(), WARN = new THREE.Color('#ff3344');
function setTileMatrix(i) {
  const t = tileDefs[i];
  dummy.position.set(t.x, tileY[i], t.z);
  dummy.updateMatrix();
  tileMesh.setMatrixAt(i, dummy.matrix);
}
tileDefs.forEach((t, i) => {
  Object.assign(t, axialToWorld(t.q, t.r));
  // Pastel gradient: warm center → cool lavender rim, with slight per-tile variation.
  tileBase[i] = new THREE.Color().setHSL(0.5 + t.ring * 0.04 + (Math.random() - 0.5) * 0.015, 0.5, 0.64 - t.ring * 0.035 + (t.ring % 2) * 0.035);
  tileY[i] = -0.3;
  setTileMatrix(i);
  tileMesh.setColorAt(i, tileBase[i]);
});
scene.add(tileMesh);

function applyTiles(str, rise = false) {
  for (let i = 0; i < N; i++) {
    const s = str[i];
    if (s === tileSt[i]) continue;
    tileSt[i] = s;
    if (s === '1') {
      // Rise back into place, outer rings later (staggered by depth).
      tileY[i] = rise ? -3 - tileDefs[i].ring * 1.2 : -0.3; tileVy[i] = 0;
      setTileMatrix(i);
      tileMesh.setColorAt(i, tileBase[i]);
    }
  }
  tileMesh.instanceMatrix.needsUpdate = true;
  tileMesh.instanceColor.needsUpdate = true;
  let ring = 0;
  for (let i = 0; i < N; i++) if (str[i] !== '0') ring = Math.max(ring, tileDefs[i].ring);
  setIslandGoal(ring);
  arenaRing = ring;
}
function animateTiles(dt, t) {
  let moved = false, colored = false;
  for (let i = 0; i < N; i++) {
    if (tileSt[i] === '1' && tileY[i] < -0.3) {
      tileY[i] = Math.min(-0.3, tileY[i] + 9 * dt);
      setTileMatrix(i);
      moved = true;
    } else if (tileSt[i] === '2') {
      tmpC.copy(tileBase[i]).lerp(WARN, 0.4 + 0.4 * Math.sin(t * 14));
      tileMesh.setColorAt(i, tmpC);
      tileY[i] = -0.3 + Math.sin(t * 40 + i) * 0.03; // nervous rattle before the drop
      setTileMatrix(i);
      colored = moved = true;
    } else if (tileSt[i] === '0' && tileY[i] > -40) {
      tileVy[i] += 18 * dt;
      tileY[i] -= tileVy[i] * dt;
      if (tileY[i] < -30) tileY[i] = -1000;
      setTileMatrix(i);
      moved = true;
    }
  }
  if (moved) tileMesh.instanceMatrix.needsUpdate = true;
  if (colored) tileMesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------- characters (low-poly, shared geometry + materials)
const geo = {
  body: new THREE.CapsuleGeometry(0.3, 0.3, 3, 10),
  belt: new THREE.CylinderGeometry(0.33, 0.33, 0.08, 10),
  head: new THREE.BoxGeometry(0.5, 0.42, 0.5),
  visor: new THREE.BoxGeometry(0.06, 0.15, 0.4),
  gun: new THREE.BoxGeometry(0.6, 0.13, 0.13),
  barrel: new THREE.CylinderGeometry(0.045, 0.045, 0.25, 6),
  tip: new THREE.SphereGeometry(0.06, 8, 6),
  blob: new THREE.PlaneGeometry(1.1, 1.1),
  capTop: new THREE.CylinderGeometry(0.27, 0.27, 0.16, 8),
  capBrim: new THREE.BoxGeometry(0.3, 0.04, 0.42),
  crown: new THREE.CylinderGeometry(0.26, 0.22, 0.2, 5),
  horn: new THREE.ConeGeometry(0.08, 0.32, 6),
  stick: new THREE.CylinderGeometry(0.02, 0.02, 0.35, 4),
  ball: new THREE.SphereGeometry(0.08, 6, 4),
  halo: new THREE.TorusGeometry(0.25, 0.04, 6, 16),
  marker: new THREE.RingGeometry(0.5, 0.62, 24),
};
const mats = {};
const mat = (c) => (mats[c] ??= new THREE.MeshLambertMaterial({ color: c }));
const glow = (c) => (mats['glow' + c] ??= new THREE.MeshBasicMaterial({ color: c }));
const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });

function makeCharacter(color, hat) {
  const g = new THREE.Group();
  const add = (gm, m, x, y, z, rx = 0, rz = 0) => {
    const mesh = new THREE.Mesh(gm, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, 0, rz);
    mesh.castShadow = !TOUCH;
    g.add(mesh);
    return mesh;
  };
  add(geo.body, mat(color), 0, 0.42, 0);
  add(geo.belt, mat('#2b2b38'), 0, 0.42, 0);
  add(geo.head, mat(color), 0, 1.02, 0);
  add(geo.visor, glow('#9ffcff'), 0.26, 1.04, 0);
  add(geo.gun, mat('#2b2b38'), 0.4, 0.62, 0);
  add(geo.barrel, mat('#44445a'), 0.8, 0.62, 0, 0, Math.PI / 2);
  add(geo.tip, glow(color), 0.94, 0.62, 0);
  // Soft blob shadow: grounds the character even where real shadows are off (phones).
  const blob = new THREE.Mesh(geo.blob, blobMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  blob.renderOrder = -1;
  g.add(blob);
  g.userData.blob = blob;
  const top = 1.23;
  if (hat === 'cap') { add(geo.capTop, mat('#222831'), 0, top + 0.08, 0); add(geo.capBrim, mat('#222831'), 0.28, top + 0.02, 0); }
  if (hat === 'crown') add(geo.crown, glow('#ffcc33'), 0, top + 0.1, 0);
  if (hat === 'horns') { add(geo.horn, mat('#f0e6d2'), 0, top + 0.12, 0.17, 0.45); add(geo.horn, mat('#f0e6d2'), 0, top + 0.12, -0.17, -0.45); }
  if (hat === 'antenna') { add(geo.stick, mat('#888'), 0, top + 0.17, 0); add(geo.ball, glow('#ff3355'), 0, top + 0.36, 0); }
  if (hat === 'halo') add(geo.halo, glow('#ffe066'), 0, top + 0.28, 0, Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------- menu showcase (your character before joining)
const showcase = new THREE.Group();
scene.add(showcase);
function refreshShowcase() {
  showcase.clear();
  showcase.visible = !roomInfo;
  if (roomInfo) return;
  const c = makeCharacter(look.color, look.hat);
  c.rotation.y = -Math.PI / 4;
  showcase.add(c);
}

// ---------------------------------------------------------------- floor lookup
const tileIndex = new Map(tileDefs.map((t, i) => [tileKey(t.q, t.r), i]));
function tileSolidAt(x, z) {
  const { q, r } = worldToAxial(x, z);
  const i = tileIndex.get(tileKey(q, r));
  return i !== undefined && tileSt[i] !== '0';
}

// ---------------------------------------------------------------- live players
const ents = new Map();
const markerMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 });
function infoOf(id) {
  return roomInfo?.players.find((p) => p.id === id) || { nick: '?', color: '#cccccc', hat: 'none' };
}
function makeEnt(id) {
  const info = infoOf(id);
  const g = makeCharacter(info.color, info.hat);
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.6, 0.62, 0), new THREE.Vector3(30, 0.62, 0)]);
  const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: info.color, dashSize: 0.35, gapSize: 0.2, transparent: true, opacity: 0.9 }));
  line.computeLineDistances();
  line.visible = false;
  g.add(line);
  if (id === myId) {
    const m = new THREE.Mesh(geo.marker, markerMat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.03;
    g.add(m);
  }
  g.scale.setScalar(0.01);
  scene.add(g);
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.style.color = info.color;
  tag.textContent = info.nick;
  $('labels').appendChild(tag);
  const e = { g, line, tag, t: null, pop: 0, dead: false, x: 0, z: 0, a: 0, key: info.color + info.hat };
  ents.set(id, e);
  return e;
}
function dropEnt(id) {
  const e = ents.get(id);
  if (!e) return;
  scene.remove(e.g);
  e.line.geometry.dispose();
  e.line.material.dispose();
  e.tag.remove();
  ents.delete(id);
}
const clearEnts = () => [...ents.keys()].forEach(dropEnt);

// ---------------------------------------------------------------- sound (synthesised, no files)
let actx = null, master = null, muted = store.get('muted', false);
function audio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    master = actx.createGain();
    master.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  master.gain.value = muted ? 0 : 1;
  return muted ? null : actx;
}
function setMuted(m) {
  muted = m;
  store.set('muted', m);
  $('soundBtn').textContent = m ? '🔇' : '🔊';
  if (master) master.gain.value = m ? 0 : 1;
}
$('soundBtn').onclick = (e) => { e.currentTarget.blur(); setMuted(!muted); };
setMuted(muted);
addEventListener('pointerdown', audio);
addEventListener('keydown', audio);
function zap() {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain(), n = a.currentTime;
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(1600, n);
  o.frequency.exponentialRampToValueAtTime(90, n + 0.35);
  g.gain.setValueAtTime(0.12, n);
  g.gain.exponentialRampToValueAtTime(0.001, n + 0.4);
  o.connect(g).connect(master);
  o.start(n); o.stop(n + 0.4);
}
function boom() {
  const a = audio(); if (!a) return;
  const len = a.sampleRate * 1.2, buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf; f.type = 'lowpass'; f.frequency.value = 700; g.gain.value = 0.6;
  src.connect(f).connect(g).connect(master);
  src.start();
}
function beep(freq = 660, dur = 0.08) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain(), n = a.currentTime;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.08, n);
  g.gain.exponentialRampToValueAtTime(0.001, n + dur);
  o.connect(g).connect(master);
  o.start(n); o.stop(n + dur);
}

// ---------------------------------------------------------------- fullscreen (hidden where unsupported, e.g. iPhone Safari)
const fsEl = document.documentElement;
if (!fsEl.requestFullscreen) $('fsBtn').classList.add('hidden');
$('fsBtn').onclick = async (e) => {
  e.currentTarget.blur();
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else { await fsEl.requestFullscreen({ navigationUI: 'hide' }); await screen.orientation?.lock?.('landscape').catch(() => {}); }
  } catch { /* user gesture / permission denied */ }
};

// ---------------------------------------------------------------- effects: beams, debris, shake, slow-mo, flash
const fx = [];
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
const flashGeo = new THREE.SphereGeometry(0.5, 10, 8);
const debrisGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
let shakeT = 0, slowT = 0;
const addMat = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });

function spawnBeam(b) {
  const color = infoOf(b.id).color;
  const a = new THREE.Vector3(b.x1, 0.62, b.z1), c = new THREE.Vector3(b.x2, 0.62, b.z2);
  const len = Math.max(0.01, a.distanceTo(c));
  for (const [r, col] of [[0.18, color], [0.06, '#ffffff']]) {
    const m = new THREE.Mesh(beamGeo, addMat(col));
    m.position.copy(a).lerp(c, 0.5);
    m.quaternion.setFromUnitVectors(Y_AXIS, c.clone().sub(a).normalize());
    m.scale.set(r, len, r);
    scene.add(m);
    fx.push({ m, life: 1, max: 1, kind: 'beam', r });
  }
  const muzzle = new THREE.Mesh(flashGeo, addMat(color));
  muzzle.position.copy(a);
  scene.add(muzzle);
  fx.push({ m: muzzle, life: 0.3, max: 0.3, kind: 'flash', grow: 1.5 });
}

function killEffect(victimId, dirX, dirZ) {
  const e = ents.get(victimId);
  if (!e) return;
  const color = infoOf(victimId).color;
  e.dead = true;
  e.vx = dirX * 7; e.vz = dirZ * 7; e.vy = 7; e.spin = (Math.random() < 0.5 ? -1 : 1) * 9;
  e.tag.textContent = '💀 ' + infoOf(victimId).nick;
  const p = e.g.position.clone().setY(0.8);
  // Big white impact flash + shockwave.
  const f = new THREE.Mesh(flashGeo, addMat('#ffffff'));
  f.position.copy(p);
  scene.add(f);
  fx.push({ m: f, life: 0.6, max: 0.6, kind: 'flash', grow: 5 });
  const ring = new THREE.Mesh(geo.marker, addMat(color));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(p.x, 0.05, p.z);
  scene.add(ring);
  fx.push({ m: ring, life: 0.8, max: 0.8, kind: 'flash', grow: 9 });
  // Debris chunks in the victim's colour.
  for (let i = 0; i < 22; i++) {
    const m = new THREE.Mesh(debrisGeo, mat(i % 4 ? color : '#ffffff'));
    m.position.copy(p);
    scene.add(m);
    const sp = 3 + Math.random() * 6, ang = Math.random() * Math.PI * 2;
    fx.push({
      m, life: 2.2, max: 2.2, kind: 'debris',
      vx: Math.cos(ang) * sp + dirX * 4, vy: 4 + Math.random() * 7, vz: Math.sin(ang) * sp + dirZ * 4,
      rx: Math.random() * 10, rz: Math.random() * 10,
    });
  }
  if (!REDUCED) { shakeT = Math.max(shakeT, 0.7); slowT = 1.0; }
  screenFlash(victimId === myId ? 'rgba(255,30,60,.55)' : 'rgba(255,255,255,.35)');
  if (victimId === myId && navigator.vibrate) navigator.vibrate([200, 80, 350]);
}

function screenFlash(color) {
  const el = $('flash');
  el.style.transition = 'none';
  el.style.background = color;
  el.style.opacity = REDUCED ? '0.4' : '1';
  requestAnimationFrame(() => { el.style.transition = 'opacity .9s ease-out'; el.style.opacity = '0'; });
}

function animateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.life -= dt;
    const k = Math.max(0, f.life / f.max);
    if (f.kind === 'beam') { f.m.material.opacity = k; const r = f.r * (0.4 + k); f.m.scale.x = f.m.scale.z = r; }
    else if (f.kind === 'flash') { f.m.material.opacity = k; f.m.scale.setScalar(1 + (1 - k) * f.grow); }
    else if (f.kind === 'debris') {
      f.vy -= 22 * dt;
      f.m.position.x += f.vx * dt; f.m.position.y += f.vy * dt; f.m.position.z += f.vz * dt;
      f.m.rotation.x += f.rx * dt; f.m.rotation.z += f.rz * dt;
      if (f.m.position.y < 0.08 && tileSolidAt(f.m.position.x, f.m.position.z) && f.vy < 0) { f.m.position.y = 0.08; f.vy *= -0.35; f.vx *= 0.6; f.vz *= 0.6; }
    }
    if (f.life <= 0) {
      scene.remove(f.m);
      if (f.kind !== 'debris') f.m.material.dispose();
      fx.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- my movement: WASD / arrows / left stick, aim: mouse / right stick
let myPos = null, posDirty = false, mousePt = null;
const WALK_SPEED = 4.5;
const inRoom = () => !!roomInfo;
const canMove = () => !!snap && snap.me === 1 && (snap.s === 'lobby' || snap.s === 'plan') && !!myPos;
const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.62);
const ndc = new THREE.Vector2(), hitPt = new THREE.Vector3();
function groundPoint(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(aimPlane, hitPt) ? { x: hitPt.x, z: hitPt.z } : null;
}
function aimAt(pt) {
  if (!myPos || Math.hypot(pt.x - myPos.x, pt.z - myPos.z) < 0.3) return;
  myPos.aim = Math.atan2(pt.z - myPos.z, pt.x - myPos.x);
  posDirty = true;
}
const canvas = $('c');
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !canMove()) return;
  const pt = groundPoint(e);
  if (pt) { mousePt = { ...pt }; aimAt(pt); }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Keyboard: works regardless of which element has focus once you are in a room.
const keys = {};
const KEYMAP = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
  w: 'u', s: 'd', a: 'l', d: 'r', W: 'u', S: 'd', A: 'l', D: 'r' };
addEventListener('keydown', (e) => {
  const dir = KEYMAP[e.code] || KEYMAP[e.key];
  if (!dir || !inRoom()) return;
  if (e.target.tagName === 'INPUT') e.target.blur();
  keys[dir] = true;
  e.preventDefault();
});
addEventListener('keyup', (e) => { const dir = KEYMAP[e.code] || KEYMAP[e.key]; if (dir) keys[dir] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// Two fixed on-screen sticks for touch screens.
const STICK_R = 50;
function makeStick(el, onMove) {
  const s = { id: null, nx: 0, ny: 0 };
  const knob = el.firstElementChild;
  const upd = (e) => {
    const r = el.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
    s.nx = dx / STICK_R; s.ny = dy / STICK_R;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    onMove?.(s);
  };
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); s.id = e.pointerId; el.setPointerCapture(e.pointerId); upd(e); });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === s.id) upd(e); });
  const end = (e) => { if (e.pointerId !== s.id) return; s.id = null; s.nx = s.ny = 0; knob.style.transform = ''; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return s;
}
const toWorld = (sx, sy) => ({ x: RIGHT.x * sx + UPG.x * sy, z: RIGHT.z * sx + UPG.z * sy });
const moveStick = makeStick($('joyL'));
makeStick($('joyR'), (s) => {
  if (!canMove() || Math.hypot(s.nx, s.ny) < 0.3) return;
  const w = toWorld(s.nx, -s.ny);
  myPos.aim = Math.atan2(w.z, w.x);
  posDirty = true;
});

function walk(dt) {
  if (!canMove()) return;
  const sx = (keys.r ? 1 : 0) - (keys.l ? 1 : 0) + moveStick.nx;
  const sy = (keys.u ? 1 : 0) - (keys.d ? 1 : 0) - moveStick.ny;
  let { x: mx, z: mz } = toWorld(sx, sy);
  const l = Math.hypot(mx, mz);
  if (l < 0.05) return;
  if (l > 1) { mx /= l; mz /= l; }
  const step = WALK_SPEED * dt;
  const nx = myPos.x + mx * step, nz = myPos.z + mz * step;
  if (tileSolidAt(nx, nz)) { myPos.x = nx; myPos.z = nz; }
  else if (tileSolidAt(nx, myPos.z)) myPos.x = nx;
  else if (tileSolidAt(myPos.x, nz)) myPos.z = nz;
  else return;
  if (mousePt) aimAt(mousePt);
  posDirty = true;
}
setInterval(() => {
  if (posDirty && canMove()) socket.emit('pos', { x: +myPos.x.toFixed(2), z: +myPos.z.toFixed(2), aim: +myPos.aim.toFixed(3) });
  posDirty = false;
}, 70);

// ---------------------------------------------------------------- UI
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 2200);
}
const nick = () => {
  const n = $('nick').value.trim();
  store.set('nick', n);
  return n;
};

function buildCustomizer() {
  const colors = $('colors'), hats = $('hats');
  colors.replaceChildren();
  hats.replaceChildren();
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === look.color ? ' on' : '');
    b.style.background = c;
    b.setAttribute('aria-label', 'Color ' + c);
    b.onclick = () => setLook({ color: c });
    colors.appendChild(b);
  }
  for (const h of HATS) {
    const b = document.createElement('button');
    b.className = 'hat' + (h === look.hat ? ' on' : '');
    b.textContent = h;
    b.onclick = () => setLook({ hat: h });
    hats.appendChild(b);
  }
}
function setLook(change) {
  Object.assign(look, change);
  store.set('look', look);
  buildCustomizer();
  if (roomInfo) socket.emit('setLook', look);
  else refreshShowcase();
}

function renderRooms(list) {
  const ul = $('roomList');
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No rooms yet. Hit Quick Play to make one.';
    ul.appendChild(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = r.name;
    const meta = document.createElement('small');
    meta.textContent = `${r.count}/${r.max} · ${r.state === 'lobby' ? 'waiting' : 'in game'}`;
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = 'Join';
    b.disabled = r.count >= r.max;
    b.onclick = () => socket.emit('joinRoom', { nick: nick(), look, roomId: r.id });
    li.append(name, meta, b);
    ul.appendChild(li);
  }
}

function renderLobby() {
  if (!roomInfo) return;
  $('roomName').textContent = roomInfo.name;
  $('roomCode').textContent = roomInfo.id;
  const ul = $('playerList');
  ul.replaceChildren();
  for (const p of roomInfo.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = p.nick + (p.id === myId ? ' (you)' : '');
    const meta = document.createElement('small');
    meta.textContent = (p.id === roomInfo.hostId ? 'host · ' : '') + `${p.wins}🏆`;
    li.append(dot, name, meta);
    ul.appendChild(li);
  }
  const host = roomInfo.hostId === myId;
  for (const id of ['start', 'addBot', 'removeBots']) $(id).classList.toggle('hidden', !host);
  $('start').disabled = roomInfo.players.length < 2;
  $('lobbyHint').textContent = host
    ? roomInfo.players.length < 2 ? 'Need 2+ players. Add a bot or share the invite link.' : 'Walk around, then hit Start.'
    : 'Walk around while the host gets ready…';
  if (compact()) $('lobbyHint').textContent += TOUCH ? ' Left stick moves, right stick aims.' : ' WASD moves, mouse aims.';
}

function updateScreens() {
  const room = inRoom(), roam = room && roomInfo.state === 'lobby';
  $('menu').classList.toggle('hidden', room);
  document.body.classList.toggle('in-room', room);
  document.body.classList.toggle('roam', roam);
  $('lobby').classList.toggle('hidden', !roam);
  $('hud').classList.toggle('hidden', !room);
  $('labels').classList.toggle('hidden', !room);
  if (room) $('customSlot').appendChild($('custom'));
  else $('nick').after($('custom'));
  if (room && document.activeElement?.tagName === 'INPUT') document.activeElement.blur();
  refreshShowcase();
}

function renderStrip() {
  const strip = $('strip');
  strip.replaceChildren();
  if (!snap || snap.s === 'lobby') return;
  const alive = new Set(snap.al);
  strip.classList.toggle('dense', (roomInfo?.players.length || 0) > 4);
  for (const p of roomInfo?.players || []) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (alive.has(p.id) ? '' : ' out');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.textContent = p.id === myId ? 'You' : p.nick;
    chip.append(dot, name);
    strip.appendChild(chip);
  }
}

let snapAt = 0, resultText = '', lastBeep = 0;
function setText(id, text) {
  const el = $(id);
  if (el.textContent === text) return;
  el.textContent = text;
  if (id === 'center' && text && !REDUCED) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
}
function updateHud(now) {
  if (!snap || !inRoom()) return;
  const t = Math.max(0, snap.t - (now - snapAt) / 1000);
  const sec = Math.ceil(t);
  let big = '', small = '';
  switch (snap.s) {
    case 'lobby': small = compact() ? '' : TOUCH ? 'Left stick to move · right stick to aim' : 'WASD / arrows to move · mouse to aim'; break;
    case 'plan':
      big = `HIDE & AIM · ${sec}`;
      small = !snap.me ? spectateText() : (compact() ? 'Move & aim — you are invisible!' : 'Everyone is invisible. Pick your spot and aim before time runs out!');
      if (snap.me && sec <= 3 && sec !== lastBeep) { lastBeep = sec; beep(sec === 1 ? 880 : 660); }
      break;
    case 'reveal': big = 'REVEAL!'; small = snap.me ? 'Fire!' : spectateText(); lastBeep = 0; break;
    case 'result': big = resultText; small = snap.me ? '' : spectateText(); break;
    case 'shrink': big = 'The arena shrinks…'; small = `Round ${snap.round + 1} next`; break;
    case 'ended': big = $('results').classList.contains('hidden') ? winnerText : ''; break;
  }
  setText('center', big);
  setText('sub', small);
  setText('round', snap.round && snap.s !== 'lobby' ? `Round ${snap.round} · ${snap.al.length} alive` : '');
  $('timerBar').style.width = snap.s === 'plan' ? (t / (snap.d || 3)) * 100 + '%' : '0%';
  const sticks = TOUCH && canMove();
  $('joyL').classList.toggle('hidden', !sticks);
  $('joyR').classList.toggle('hidden', !sticks);
}

function spectateText() {
  return roomInfo?.players.find((p) => p.id === myId) && joinedMidGame ? 'Match in progress · you play next game' : 'You are out · spectating';
}

function addFeed({ victim, killer, kc, vc }) {
  const d = document.createElement('div');
  const k = document.createElement('b'), v = document.createElement('b');
  k.textContent = killer; k.style.color = kc || '';
  v.textContent = victim; v.style.color = vc || '';
  d.append(k, ' ⚡ ', v);
  $('feed').prepend(d);
  setTimeout(() => d.remove(), 5000);
}

$('quick').onclick = () => { if (!socket.connected) return toast('Still connecting…'); socket.emit('quickPlay', { nick: nick(), look }); };
$('nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('quick').click(); } });
$('create').onclick = () => socket.emit('createRoom', { nick: nick(), look });
$('refresh').onclick = () => socket.emit('listRooms');
$('start').onclick = (e) => { e.currentTarget.blur(); socket.emit('start'); };
$('addBot').onclick = () => socket.emit('addBot');
$('removeBots').onclick = () => socket.emit('removeBots');
$('moreToggle').onclick = () => $('lobby').classList.toggle('collapsed');
$('customToggle').onclick = () => $('customSlot').classList.toggle('hidden');
// Copy that also works on plain-http LAN pages, where navigator.clipboard / share don't exist.
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'; // 16px: no iOS zoom
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  return legacyCopy(text);
}
function showInvite(url) {
  $('inviteUrl').value = url;
  $('inviteBox').classList.remove('hidden');
  setTimeout(() => { $('inviteUrl').focus(); $('inviteUrl').select(); $('inviteUrl').setSelectionRange(0, url.length); }, 50);
}
$('inviteClose').onclick = () => $('inviteBox').classList.add('hidden');
$('inviteUrl').onfocus = (e) => e.target.select();
$('copyLink').onclick = async () => {
  const url = `${location.origin}/?room=${roomInfo.id}`;
  // Share sheet first on phones (HTTPS only). Called synchronously so the tap still counts as a user gesture.
  if (TOUCH && navigator.share && window.isSecureContext) {
    try { await navigator.share({ title: 'Laser Drop', text: 'Join my Laser Drop room!', url }); return; }
    catch (err) { if (err?.name === 'AbortError') return; }
  }
  if (await copyText(url)) toast('Invite link copied');
  else showInvite(url);
};
$('roomCode').onclick = async () => {
  if (await copyText(roomInfo.id)) toast(`Room code ${roomInfo.id} copied`);
  else showInvite(`${location.origin}/?room=${roomInfo.id}`);
};
function resetArena() {
  lastTiles = '';
  applyTiles('1'.repeat(N), true);
  winnerText = '';
  resultText = '';
}
function leaveRoom() {
  socket.emit('leaveRoom');
  rejoinId = null;
  joinedMidGame = false;
  history.replaceState(null, '', '/');
  dropRoomState();
}
$('leave').onclick = leaveRoom;
$('quit').onclick = leaveRoom;

// ---------------------------------------------------------------- network
let rejoinId = pendingRoom, joinedMidGame = false;
function conn(text) {
  $('conn').classList.toggle('hidden', !text);
  if (text) $('connText').textContent = text;
}
function dropRoomState() {
  roomInfo = null;
  snap = null;
  myPos = null;
  clearEnts();
  resetArena();
  showResults(null);
  updateScreens();
}
conn('Connecting…');
socket.on('connect', () => {
  myId = socket.id;
  conn('');
  // Auto-rejoin after a network blip / server restart, or join from an invite link.
  if (rejoinId) socket.emit('joinRoom', { nick: nick(), look, roomId: rejoinId });
});
socket.on('connect_error', () => conn(navigator.onLine === false ? 'You are offline. Waiting for network…' : 'Can’t reach the server. Retrying…'));
socket.on('disconnect', (reason) => {
  if (reason === 'io client disconnect') return;
  rejoinId = roomInfo?.id || rejoinId;
  conn('Connection lost. Reconnecting…');
  dropRoomState();
  // Server-initiated disconnects (e.g. deploy restart) are not retried automatically.
  if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 1000);
});
socket.on('serverRestart', () => conn('Server is updating. Reconnecting…'));
socket.on('rooms', renderRooms);
socket.on('err', (m) => { toast(m); rejoinId = null; history.replaceState(null, '', '/'); });
socket.on('joined', ({ roomId, you }) => {
  myId = you;
  myPos = null;
  rejoinId = roomId;
  joinedMidGame = false;
  history.replaceState(null, '', '/?room=' + roomId);
});
socket.on('lobby', (info) => {
  const was = roomInfo?.state;
  if (!roomInfo && info.state !== 'lobby') joinedMidGame = true;
  if (info.state === 'lobby') joinedMidGame = false;
  roomInfo = info;
  for (const [id, e] of ents) {
    const p = info.players.find((x) => x.id === id);
    if (!p || p.color + p.hat !== e.key) dropEnt(id);
  }
  renderLobby();
  if (was !== info.state) updateScreens();
});
socket.on('state', (s) => {
  const prev = snap;
  snap = s;
  snapAt = performance.now();
  if (s.tiles !== lastTiles) { applyTiles(s.tiles); lastTiles = s.tiles; }
  if (prev?.s !== s.s) {
    if (s.s === 'lobby') { clearEnts(); resetArena(); showResults(null); }
    // Keep the room card / HUD in sync with the live phase, not just lobby broadcasts.
    if (roomInfo && (s.s === 'lobby') !== (roomInfo.state === 'lobby')) { roomInfo.state = s.s === 'lobby' ? 'lobby' : 'playing'; updateScreens(); }
    if (s.s === 'plan') for (const id of [...ents.keys()]) if (id !== myId) dropEnt(id); // everyone vanishes
  }
  // My own position is driven locally while I can move; otherwise the server is the truth.
  const meSrv = s.p.find((p) => p.id === myId);
  if (meSrv && (!myPos || !canMove() || (prev && prev.s !== s.s && s.s === 'plan' && !tileSolidAt(myPos.x, myPos.z)))) {
    myPos = { x: meSrv.x, z: meSrv.z, aim: meSrv.a };
  }
  const seen = new Set();
  for (const p of s.p) {
    seen.add(p.id);
    const e = ents.get(p.id) || makeEnt(p.id);
    e.t = p;
  }
  for (const [id, e] of [...ents]) if (!seen.has(id) && !e.dead) dropEnt(id);
  if (!prev || prev.s !== s.s || prev.al.length !== s.al.length) renderStrip();
});
socket.on('shots', (shots) => {
  zap();
  shots.forEach(spawnBeam);
  const victims = shots.filter((x) => x.hit);
  if (victims.length) {
    setTimeout(boom, 60);
    for (const v of victims) {
      const d = Math.hypot(v.x2 - v.x1, v.z2 - v.z1) || 1;
      killEffect(v.hit, (v.x2 - v.x1) / d, (v.z2 - v.z1) / d);
    }
  }
  const n = new Set(victims.map((x) => x.hit)).size;
  resultText = victims.some((x) => x.hit === myId) ? 'YOU WERE HIT!' : n ? `${n} ELIMINATED!` : 'Everyone missed!';
});
socket.on('roundEnd', (r) => {
  winnerText = r.winner ? `🏆 ${r.winner} wins!` : r.survivors ? `Time's up! ${r.survivors} survivors` : 'Draw! Nobody survived';
  if (r.winnerId === myId) { beep(660, 0.12); setTimeout(() => beep(880, 0.12), 130); setTimeout(() => beep(1320, 0.25), 260); }
  setTimeout(() => showResults(r), 900); // let the last death play out first
});
function showResults(r) {
  $('results').classList.toggle('hidden', !r || !roomInfo);
  if (!r) return;
  $('resTitle').textContent = r.winnerId === myId ? '🏆 You win!' : r.winner ? `🏆 ${r.winner} wins` : r.survivors ? "Time's up · draw" : 'Draw!';
  $('resSub').textContent = `${r.rounds} round${r.rounds === 1 ? '' : 's'}`;
  const ol = $('resList');
  ol.replaceChildren();
  for (const p of r.standings) {
    const li = document.createElement('li');
    if (p.id === myId) li.className = 'me';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = (p.won ? '👑 ' : p.alive ? '🛡 ' : '') + p.nick + (p.id === myId ? ' (you)' : '');
    const meta = document.createElement('small');
    meta.textContent = `${p.kills} kill${p.kills === 1 ? '' : 's'} · ${p.wins}🏆`;
    li.append(dot, name, meta);
    ol.appendChild(li);
  }
}
socket.on('feed', addFeed);

// ---------------------------------------------------------------- camera + loop
function camGoal() {
  const w = innerWidth, h = innerHeight, a = w / h, s = snap?.s;
  if (!inRoom()) {
    const vh = Math.max(8, 9 / a);
    if (w <= 700 || a < 1) {
      const sy = vh * 0.2; // lift the character above the bottom sheet
      return { vh, tx: -UPG.x * (sy / ISO_SIN), tz: -UPG.z * (sy / ISO_SIN) };
    }
    const sx = (Math.min(420, w * 0.3) / 2) * (vh / h); // push the character right of the side panel
    return { vh, tx: -RIGHT.x * sx, tz: -RIGHT.z * sx };
  }
  // Fit the arena into the screen area NOT covered by HUD / lobby card / joysticks.
  let T = 0, L = 0, B = 0;
  const card = $('lobby');
  if (!card.classList.contains('hidden')) {
    const r = card.getBoundingClientRect();
    if (r.width > w * 0.6) T = r.bottom + 6; // full-width card on phones
    else L = r.right + 6; // side card (desktop / landscape)
  } else T = compact() ? 92 : 78; // in-game HUD band
  if (TOUCH && canMove() && a < 1) B = 170; // joysticks under the arena in portrait
  const fh = Math.max(120, h - T - B), fw = Math.max(160, w - L);
  // Size of the arena still standing, in world units (on-screen width / height incl. characters).
  let W = arenaRing * 3.46 + 4, H = arenaRing * 2.2 + 4;
  // Portrait phones: arena is width-limited and tiny → zoom in and follow the player instead.
  const portrait = a < 0.8;
  if (portrait) W *= 0.68;
  const vh = Math.max(H * h / fh, W * h / fw, 9);
  const px = vh / h; // world units per screen pixel (vertical)
  const sx = (L / 2) * px, sy = ((B - T) / 2) * px;
  let fx = 0, fz = 0;
  if (portrait && myPos && snap?.me) {
    const f = s === 'lobby' || s === 'plan' ? 0.55 : 0.25; // ease toward center for the shots
    fx = myPos.x * f; fz = myPos.z * f;
  }
  return { vh, tx: fx - RIGHT.x * sx - UPG.x * (sy / ISO_SIN), tz: fz - RIGHT.z * sx - UPG.z * (sy / ISO_SIN) };
}
function compact() { return innerWidth <= 700 || innerHeight <= 500; }
function applyCamera(shake) {
  const a = innerWidth / innerHeight;
  camera.left = (-cam.vh * a) / 2;
  camera.right = (cam.vh * a) / 2;
  camera.top = cam.vh / 2;
  camera.bottom = -cam.vh / 2;
  camera.updateProjectionMatrix();
  const sx = (Math.random() - 0.5) * shake, sz = (Math.random() - 0.5) * shake;
  camera.position.set(cam.tx + sx + CAM_OFF.x, CAM_OFF.y, cam.tz + sz + CAM_OFF.z);
  camera.lookAt(cam.tx + sx, 0, cam.tz + sz);
}
function resize() { renderer.setSize(innerWidth, innerHeight, false); }
addEventListener('resize', resize);
resize();

const vproj = new THREE.Vector3();
let last = performance.now();
function frame(now) {
  const rdt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // Slow-motion right after a kill.
  slowT = Math.max(0, slowT - rdt);
  const dt = rdt * (slowT > 0 ? 0.25 + 0.75 * (1 - slowT) ** 2 : 1);
  shakeT = Math.max(0, shakeT - rdt);

  walk(rdt);
  const goal = camGoal();
  const ck = 1 - Math.exp(-6 * rdt);
  cam.vh += (goal.vh - cam.vh) * ck;
  cam.tx += (goal.tx - cam.tx) * ck;
  cam.tz += (goal.tz - cam.tz) * ck;
  applyCamera(shakeT * 0.9);

  const s = snap?.s;
  const allAim = s === 'lobby' || s === 'reveal' || s === 'result';
  const k = 1 - Math.exp(-15 * rdt);
  for (const [id, e] of ents) {
    if (!e.t) continue;
    e.pop = Math.min(1, e.pop + rdt * 4);
    const popS = e.pop < 1 ? 1 + 0.35 * Math.sin(e.pop * Math.PI) : 1;
    e.g.scale.setScalar(Math.max(0.01, e.pop) * popS);
    if (e.dead) {
      // Ragdoll: flung along the beam, spinning, then off into the void.
      e.vy -= 22 * dt;
      e.g.position.x += e.vx * dt; e.g.position.y += e.vy * dt; e.g.position.z += e.vz * dt;
      e.g.rotation.z += e.spin * dt;
      e.g.rotation.x += e.spin * 0.6 * dt;
      e.line.visible = false;
      e.g.userData.blob.visible = false;
      e.tag.style.opacity = Math.max(0, 1 + e.g.position.y / 6);
      if (e.g.position.y < -25) { dropEnt(id); continue; }
    } else {
      const mine = id === myId && canMove();
      const tx = mine ? myPos.x : e.t.x, tz = mine ? myPos.z : e.t.z, ta = mine ? myPos.aim : e.t.a;
      if (e.pop < 0.05 || mine) { e.x = tx; e.z = tz; e.a = ta; }
      else { e.x += (tx - e.x) * k; e.z += (tz - e.z) * k; e.a += Math.atan2(Math.sin(ta - e.a), Math.cos(ta - e.a)) * k; }
      const moving = Math.hypot(tx - e.x, tz - e.z) > 0.02 || (mine && posDirty);
      e.bob = (e.bob || 0) + rdt * (moving ? 14 : 3);
      e.g.position.set(e.x, moving ? Math.abs(Math.sin(e.bob)) * 0.08 : Math.sin(e.bob) * 0.02, e.z);
      e.g.rotation.set(0, -e.a, 0);
      e.line.visible = allAim || (id === myId && s === 'plan');
      e.line.material.opacity = s === 'lobby' ? 0.35 : 0.9;
    }
    const p = e.g.position;
    vproj.set(p.x, p.y + 1.9, p.z).project(camera);
    e.tag.style.transform = `translate(${((vproj.x + 1) / 2) * innerWidth}px, ${((1 - vproj.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
  }
  for (const c of showcase.children) c.rotation.y += rdt * 0.8;
  animateTiles(dt, now / 1000);
  animateWorld(rdt, now / 1000);
  animateFx(dt);
  updateHud(now);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

buildCustomizer();
updateScreens();
requestAnimationFrame(frame);
