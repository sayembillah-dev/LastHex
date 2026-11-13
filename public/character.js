// Detailed low-poly characters. Every static part is merged into ONE mesh per material, so a fully
// dressed character costs ~6-9 draw calls. Only the animated bits (legs, propeller, cape, flames, …)
// stay as separate objects.
import * as THREE from 'three';

// ---------------------------------------------------------------- shared unit shapes (scaled per use)
const S = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
  cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
  sph: new THREE.SphereGeometry(1, 12, 8),
  hemi: new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
  cone: new THREE.ConeGeometry(1, 1, 10),
  torus: new THREE.TorusGeometry(1, 0.28, 6, 18),
  arc: new THREE.TorusGeometry(1, 0.3, 5, 10, Math.PI),
  torso: new THREE.CapsuleGeometry(0.27, 0.22, 4, 12),
};
const blobTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const blobGeo = new THREE.PlaneGeometry(1.1, 1.1);
const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
export const markerGeo = new THREE.RingGeometry(0.5, 0.62, 24);

const mats = new Map();
const lam = (c) => mats.get('l' + c) || mats.set('l' + c, new THREE.MeshLambertMaterial({ color: c })).get('l' + c);
const glo = (c) => mats.get('g' + c) || mats.set('g' + c, new THREE.MeshBasicMaterial({ color: c })).get('g' + c);
const shade = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
const mix = (a, b, k) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();

const METAL = '#a7b0bb', DARK = '#262833', GOLD = '#ffcc33', WHITE = '#f3f1ec';

// ---------------------------------------------------------------- builder: collects parts, merges per material
const tmp = new THREE.Object3D();
const Y = new THREE.Vector3(0, 1, 0);
class Builder {
  constructor() { this.parts = new Map(); }
  put(shape, material, matrix) {
    if (!this.parts.has(material)) this.parts.set(material, []);
    this.parts.get(material).push([shape, matrix]);
  }
  // add(shape, material, [x,y,z], [sx,sy,sz], [rx,ry,rz])
  add(shape, material, p, s = [1, 1, 1], r = [0, 0, 0]) {
    tmp.position.set(p[0], p[1], p[2]);
    tmp.rotation.set(r[0], r[1], r[2]);
    tmp.scale.set(s[0], s[1], s[2]);
    tmp.updateMatrix();
    this.put(shape, material, tmp.matrix.clone());
  }
  // A cylinder between two points (arms, straps, poles).
  limb(a, b, radius, material, shape = S.cyl) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
    tmp.position.copy(A).addScaledVector(d, 0.5);
    tmp.quaternion.setFromUnitVectors(Y, d.clone().normalize());
    tmp.scale.set(radius, d.length(), radius);
    tmp.updateMatrix();
    this.put(shape, material, tmp.matrix.clone());
    tmp.quaternion.identity();
  }
  build(shadows) {
    const g = new THREE.Group();
    for (const [material, list] of this.parts) {
      const mesh = new THREE.Mesh(mergeParts(list), material);
      mesh.castShadow = shadows;
      mesh.userData.own = true; // geometry belongs to this character → dispose with it
      g.add(mesh);
    }
    return g;
  }
}
function mergeParts(list) {
  const chunks = [];
  let n = 0;
  for (const [shape, m] of list) {
    const g = shape.index ? shape.toNonIndexed() : shape.clone();
    g.applyMatrix4(m);
    chunks.push(g);
    n += g.attributes.position.count;
  }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of chunks) {
    pos.set(g.attributes.position.array, o);
    nor.set(g.attributes.normal.array, o);
    o += g.attributes.position.array.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}
// Small animated sub-part, built the same way and attached at a pivot.
function pivot(parent, at, fill, shadows) {
  const b = new Builder();
  fill(b);
  const g = b.build(shadows);
  g.position.set(...at);
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------- outfits: torso + pants + details
const HEAD_Y = 1.12, TOP = 1.33;
function outfit(b, kind, c) {
  let torso = c, pants = shade(c, 0.45), arms = c;
  const front = (w, h, d, y, color, x = 0.255) => b.add(S.box, lam(color), [x, y, 0], [w, h, d]);
  switch (kind) {
    case 'classic':
      b.add(S.cyl, lam(DARK), [0, 0.5, 0], [0.285, 0.07, 0.285]);
      b.add(S.box, glo(GOLD), [0.285, 0.5, 0], [0.03, 0.06, 0.08]);
      break;
    case 'suit':
      torso = '#2a2d3a'; pants = '#22242f'; arms = '#2a2d3a';
      front(0.03, 0.32, 0.15, 0.74, WHITE);
      b.add(S.box, lam(c), [0.275, 0.72, 0], [0.03, 0.26, 0.055]); // tie
      b.add(S.box, lam(c), [0.276, 0.85, 0], [0.03, 0.05, 0.08]); // knot
      for (const z of [-1, 1]) b.add(S.box, lam('#1d1f29'), [0.258, 0.8, z * 0.1], [0.03, 0.2, 0.05], [z * 0.35, 0, 0]); // lapels
      break;
    case 'ninja':
      torso = '#24242e'; pants = '#1c1c24'; arms = '#24242e';
      b.add(S.cyl, lam(c), [0, 0.52, 0], [0.29, 0.08, 0.29], [0.18, 0, 0]); // sash
      b.add(S.box, lam(c), [0, HEAD_Y + 0.1, 0], [0.52, 0.07, 0.5]); // headband
      for (const z of [-1, 1]) b.add(S.box, lam(c), [-0.3, HEAD_Y + 0.04, z * 0.06], [0.14, 0.04, 0.05], [0, z * 0.4, -0.6]); // tails
      break;
    case 'astro':
      torso = '#eef2f6'; pants = '#dfe5ec'; arms = '#eef2f6';
      front(0.04, 0.2, 0.2, 0.7, '#c9d2dc');
      [['#ff4d6d', -0.06], ['#5cd65c', 0], [c, 0.06]].forEach(([col, z]) => b.add(S.sph, glo(col), [0.28, 0.72, z], [0.025, 0.025, 0.025]));
      b.add(S.torus, lam('#9aa5b1'), [0, 0.95, 0], [0.22, 0.22, 0.22], [Math.PI / 2, 0, 0]); // collar
      for (const z of [-1, 1]) b.add(S.sph, lam(c), [0, 0.86, z * 0.27], [0.08, 0.08, 0.08]); // shoulder patches
      break;
    case 'knight':
      pants = '#7f8894'; arms = METAL;
      b.add(S.box, lam(METAL), [0.19, 0.68, 0], [0.12, 0.38, 0.42]); // breastplate
      b.add(S.box, lam(c), [0.255, 0.7, 0], [0.02, 0.26, 0.08]); // crest
      for (const z of [-1, 1]) b.add(S.hemi, lam(METAL), [0, 0.86, z * 0.27], [0.15, 0.12, 0.15], [0, 0, z * 0.5]);
      b.add(S.cyl, lam('#5b3a24'), [0, 0.47, 0], [0.29, 0.06, 0.29]);
      break;
    case 'robot':
      pants = '#6f7782'; arms = METAL;
      front(0.04, 0.26, 0.26, 0.7, DARK);
      [['#2ee6d6', -0.08], ['#ffd24d', 0], ['#ff4d6d', 0.08]].forEach(([col, z]) => b.add(S.box, glo(col), [0.28, 0.74, z], [0.02, 0.05, 0.05]));
      b.add(S.box, glo('#2ee6d6'), [0.28, 0.63, 0], [0.02, 0.025, 0.2]);
      for (const z of [-1, 1]) b.add(S.cyl6, lam(METAL), [0, 0.88, z * 0.26], [0.07, 0.06, 0.07], [Math.PI / 2, 0, 0]);
      b.add(S.cyl6, lam(METAL), [0, 0.95, 0], [0.12, 0.08, 0.12]); // neck joint
      break;
    case 'pirate':
      pants = '#3b2a20';
      front(0.04, 0.36, 0.13, 0.7, WHITE, 0.262);
      for (const y of [0.62, 0.72, 0.82]) b.add(S.sph, glo(GOLD), [0.288, y, 0.085], [0.022, 0.022, 0.022]);
      b.add(S.cyl, lam('#c0263c'), [0, 0.5, 0], [0.29, 0.08, 0.29]); // sash
      b.add(S.box, lam('#c0263c'), [0.2, 0.42, 0.2], [0.05, 0.16, 0.06], [0.3, 0, 0]);
      break;
    case 'hoodie':
      b.add(S.torus, lam(shade(c, 0.85)), [-0.1, 0.96, 0], [0.2, 0.2, 0.26], [0, Math.PI / 2, 0.3]); // hood
      front(0.04, 0.13, 0.28, 0.55, shade(c, 0.8)); // pocket
      for (const z of [-1, 1]) b.limb([0.26, 0.92, z * 0.06], [0.28, 0.76, z * 0.07], 0.012, lam(WHITE)); // strings
      break;
  }
  b.put(S.torso, lam(torso), new THREE.Matrix4().makeTranslation(0, 0.62, 0));
  return { pants, arms };
}

// ---------------------------------------------------------------- faces (front of the head is +x)
function face(b, kind, c) {
  const x = 0.25, y = HEAD_Y + 0.03;
  switch (kind) {
    case 'visor':
      b.add(S.box, glo('#9ffcff'), [x, y, 0], [0.04, 0.14, 0.4]);
      b.add(S.box, glo('#e6ffff'), [x + 0.005, y + 0.035, -0.08], [0.04, 0.03, 0.14]); // shine
      break;
    case 'eyes':
      for (const z of [-1, 1]) {
        b.add(S.sph, lam('#ffffff'), [x, y, z * 0.11], [0.03, 0.085, 0.07]);
        b.add(S.sph, glo('#14161f'), [x + 0.02, y - 0.01, z * 0.11], [0.02, 0.045, 0.035]);
      }
      break;
    case 'happy':
      for (const z of [-1, 1]) {
        b.add(S.arc, glo('#14161f'), [x + 0.005, y, z * 0.11], [0.055, 0.055, 0.06], [0, Math.PI / 2, 0]);
        b.add(S.sph, glo('#ff8fb1'), [x - 0.01, y - 0.09, z * 0.16], [0.02, 0.03, 0.05]);
      }
      b.add(S.arc, glo('#14161f'), [x + 0.005, y - 0.08, 0], [0.04, 0.04, 0.05], [0, Math.PI / 2, Math.PI]); // smile
      break;
    case 'shades':
      for (const z of [-1, 1]) b.add(S.box, lam('#101218'), [x + 0.01, y, z * 0.11], [0.04, 0.1, 0.17]);
      b.add(S.box, lam('#101218'), [x + 0.01, y + 0.03, 0], [0.04, 0.025, 0.06]);
      b.add(S.box, glo('#6c7a99'), [x + 0.032, y + 0.025, -0.15], [0.005, 0.02, 0.06]); // glint
      break;
    case 'cyclops':
      b.add(S.torus, lam('#14161f'), [x, y, 0], [0.11, 0.11, 0.2], [0, Math.PI / 2, 0]);
      b.add(S.sph, glo('#ff3355'), [x, y, 0], [0.03, 0.1, 0.1]);
      b.add(S.sph, glo('#ffd0d8'), [x + 0.02, y + 0.03, -0.03], [0.01, 0.025, 0.025]);
      break;
    case 'mask':
      b.add(S.box, lam('#1d1d26'), [0, HEAD_Y - 0.09, 0], [0.52, 0.17, 0.5]);
      for (const z of [-1, 1]) b.add(S.box, glo('#ffffff'), [x, y + 0.03, z * 0.1], [0.03, 0.04, 0.1], [z * 0.15, 0, 0]);
      break;
  }
}

// ---------------------------------------------------------------- hats
function hat(b, kind, c, g, anim, shadows) {
  const t = TOP;
  switch (kind) {
    case 'cap':
      b.add(S.hemi, lam(shade(c, 0.55)), [0, t - 0.04, 0], [0.27, 0.17, 0.26]);
      b.add(S.box, lam(shade(c, 0.4)), [0.25, t - 0.02, 0], [0.24, 0.03, 0.4]);
      b.add(S.sph, glo(WHITE), [0.15, t + 0.07, 0], [0.025, 0.04, 0.05]);
      break;
    case 'beanie':
      b.add(S.hemi, lam(mix(c, '#ffffff', 0.3)), [0, t - 0.04, 0], [0.27, 0.24, 0.26]);
      b.add(S.cyl, lam(WHITE), [0, t - 0.02, 0], [0.27, 0.07, 0.26]);
      b.add(S.sph, lam(WHITE), [0, t + 0.22, 0], [0.07, 0.07, 0.07]);
      break;
    case 'tophat':
      b.add(S.cyl, lam('#15161d'), [0, t + 0.01, 0], [0.33, 0.03, 0.33]);
      b.add(S.cyl, lam('#15161d'), [0, t + 0.18, 0], [0.2, 0.32, 0.2]);
      b.add(S.cyl, lam(c), [0, t + 0.07, 0], [0.205, 0.06, 0.205]);
      break;
    case 'crown':
      b.add(S.cyl6, glo(GOLD), [0, t + 0.08, 0], [0.24, 0.17, 0.24]);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        b.add(S.cone, glo(GOLD), [Math.cos(a) * 0.2, t + 0.21, Math.sin(a) * 0.2], [0.05, 0.12, 0.05]);
      }
      b.add(S.sph, glo('#ff3355'), [0.24, t + 0.09, 0], [0.04, 0.04, 0.04]);
      break;
    case 'wizard':
      b.add(S.cyl, lam('#3b3fa8'), [0, t + 0.01, 0], [0.36, 0.03, 0.36]);
      b.add(S.cone, lam('#3b3fa8'), [-0.03, t + 0.28, 0], [0.24, 0.52, 0.24], [0, 0, 0.15]);
      for (const [x, y, z] of [[0.13, 0.18, 0.08], [0.05, 0.34, -0.09], [0.1, 0.1, -0.15]]) b.add(S.sph, glo('#ffe066'), [x, t + y, z], [0.03, 0.03, 0.03]);
      break;
    case 'viking':
      b.add(S.hemi, lam(METAL), [0, t - 0.05, 0], [0.28, 0.22, 0.27]);
      b.add(S.cyl, glo(GOLD), [0, t - 0.03, 0], [0.285, 0.04, 0.275]);
      for (const z of [-1, 1]) b.add(S.cone, lam('#f0e6d2'), [0, t + 0.12, z * 0.3], [0.06, 0.3, 0.06], [z * 1.0, 0, 0]);
      break;
    case 'chef':
      b.add(S.cyl, lam(WHITE), [0, t + 0.08, 0], [0.22, 0.18, 0.22]);
      b.add(S.sph, lam(WHITE), [0, t + 0.24, 0], [0.29, 0.15, 0.29]);
      break;
    case 'headphones':
      b.add(S.arc, lam('#22242f'), [0, t - 0.05, 0], [0.29, 0.3, 0.25], [0, Math.PI / 2, 0]);
      for (const z of [-1, 1]) {
        b.add(S.cyl, lam(shade(c, 0.6)), [0, HEAD_Y + 0.02, z * 0.27], [0.11, 0.07, 0.11], [Math.PI / 2, 0, 0]);
        b.add(S.cyl, glo(c), [0, HEAD_Y + 0.02, z * 0.305], [0.07, 0.01, 0.07], [Math.PI / 2, 0, 0]);
      }
      break;
    case 'bunny':
      for (const z of [-1, 1]) {
        b.add(S.sph, lam(WHITE), [-0.03, t + 0.22, z * 0.12], [0.06, 0.24, 0.09], [z * 0.2, 0, -0.12]);
        b.add(S.sph, lam('#ffb3c7'), [0.0, t + 0.22, z * 0.125], [0.02, 0.17, 0.05], [z * 0.2, 0, -0.12]);
      }
      break;
    case 'propeller':
      b.add(S.hemi, lam(c), [0, t - 0.04, 0], [0.27, 0.17, 0.26]);
      b.add(S.hemi, lam('#ffd24d'), [0, t - 0.035, 0], [0.18, 0.175, 0.27]);
      b.add(S.cyl, lam(DARK), [0, t + 0.15, 0], [0.015, 0.1, 0.015]);
      anim.prop = pivot(g, [0, t + 0.2, 0], (p) => {
        p.add(S.box, lam('#ff4d6d'), [0.13, 0, 0], [0.26, 0.015, 0.07], [0.3, 0, 0]);
        p.add(S.box, lam('#4da6ff'), [-0.13, 0, 0], [0.26, 0.015, 0.07], [-0.3, 0, 0]);
        p.add(S.sph, lam(DARK), [0, 0, 0], [0.03, 0.03, 0.03]);
      }, shadows);
      break;
    case 'halo':
      b.add(S.torus, glo('#ffe066'), [0, t + 0.24, 0], [0.24, 0.24, 0.16], [Math.PI / 2, 0, 0]);
      break;
  }
}

// ---------------------------------------------------------------- back items (back of the body is -x)
function back(b, kind, c, g, anim, shadows) {
  switch (kind) {
    case 'backpack':
      b.add(S.box, lam('#6b4f3a'), [-0.33, 0.66, 0], [0.18, 0.36, 0.36]);
      b.add(S.box, lam('#7f5f46'), [-0.43, 0.6, 0], [0.05, 0.16, 0.26]);
      b.add(S.box, lam(c), [-0.33, 0.85, 0], [0.19, 0.06, 0.37]);
      for (const z of [-1, 1]) b.limb([-0.25, 0.85, z * 0.14], [0.22, 0.8, z * 0.14], 0.02, lam('#4a3628'));
      break;
    case 'cape':
      anim.cape = pivot(g, [-0.22, 0.94, 0], (p) => {
        p.add(S.box, lam(shade(c, 0.6)), [-0.04, -0.32, 0], [0.03, 0.66, 0.5]);
        p.add(S.box, glo(GOLD), [0, 0, 0], [0.06, 0.05, 0.42]);
      }, shadows);
      break;
    case 'jetpack':
      for (const z of [-1, 1]) {
        b.add(S.cyl, lam(METAL), [-0.36, 0.68, z * 0.11], [0.09, 0.38, 0.09]);
        b.add(S.cone, lam(c), [-0.36, 0.92, z * 0.11], [0.09, 0.12, 0.09]);
        b.add(S.cyl, lam(DARK), [-0.36, 0.47, z * 0.11], [0.07, 0.06, 0.07]);
      }
      b.add(S.box, lam(DARK), [-0.3, 0.7, 0], [0.08, 0.26, 0.14]);
      anim.flames = [-1, 1].map((z) => pivot(g, [-0.36, 0.44, z * 0.11], (p) => {
        p.add(S.cone, glo('#ffb347'), [0, -0.1, 0], [0.06, 0.2, 0.06], [Math.PI, 0, 0]);
        p.add(S.cone, glo('#fff1a8'), [0, -0.06, 0], [0.03, 0.12, 0.03], [Math.PI, 0, 0]);
      }, false));
      break;
    case 'wings':
      anim.wings = [-1, 1].map((z) => pivot(g, [-0.28, 0.84, z * 0.1], (p) => {
        p.add(S.box, lam(WHITE), [-0.05, 0.05, z * 0.25], [0.03, 0.26, 0.46], [0, 0, 0.1]);
        p.add(S.box, lam('#e3e8ef'), [-0.06, -0.08, z * 0.2], [0.03, 0.18, 0.36], [0, 0, 0.1]);
        p.add(S.box, lam('#cfd6df'), [-0.07, -0.18, z * 0.15], [0.03, 0.12, 0.24], [0, 0, 0.1]);
      }, shadows));
      break;
    case 'sword':
      b.add(S.box, lam('#d9e1ea'), [-0.31, 0.8, 0], [0.03, 0.72, 0.075], [0.65, 0, 0]);
      b.add(S.box, glo(GOLD), [-0.31, 0.53, 0.17], [0.05, 0.05, 0.22], [0.65, 0, 0]);
      b.add(S.cyl, lam('#5b3a24'), [-0.31, 0.47, 0.22], [0.03, 0.14, 0.03], [0.65, 0, 0]);
      b.add(S.sph, glo(c), [-0.31, 0.41, 0.26], [0.04, 0.04, 0.04]);
      break;
    case 'flag':
      b.add(S.cyl, lam('#8a8f99'), [-0.3, 1.05, -0.12], [0.02, 1.2, 0.02]);
      b.add(S.sph, glo(GOLD), [-0.3, 1.66, -0.12], [0.04, 0.04, 0.04]);
      anim.flag = pivot(g, [-0.3, 1.45, -0.12], (p) => {
        p.add(S.box, lam(c), [-0.2, 0, 0], [0.4, 0.26, 0.015]);
        p.add(S.box, lam(WHITE), [-0.2, 0, 0.001], [0.1, 0.1, 0.016]);
      }, shadows);
      break;
  }
}

// ---------------------------------------------------------------- public API
export function makeCharacter(look, shadows = false) {
  const c = look.color || '#cccccc';
  const b = new Builder();
  const anim = {};
  const g = new THREE.Group();
  const { pants, arms } = outfit(b, look.outfit || 'classic', c);
  // head
  b.add(S.box, lam(c), [0, HEAD_Y, 0], [0.5, 0.42, 0.48]);
  b.add(S.box, lam(shade(c, 0.8)), [0, HEAD_Y - 0.2, 0], [0.42, 0.04, 0.4]); // chin shadow line
  face(b, look.face || 'visor', c);
  // arms reaching to the gun + hands
  for (const z of [-1, 1]) {
    b.limb([0, 0.86, z * 0.26], [0.3, 0.64, z * 0.07], 0.07, lam(arms));
    b.add(S.sph, lam('#f1d2b6'), [0.31, 0.63, z * 0.065], [0.065, 0.065, 0.065]);
  }
  // blaster
  b.add(S.box, lam(DARK), [0.47, 0.66, 0], [0.44, 0.13, 0.12]);
  b.add(S.box, lam(c), [0.47, 0.735, 0], [0.3, 0.025, 0.125]);
  b.add(S.box, lam(DARK), [0.36, 0.56, 0], [0.08, 0.15, 0.08], [0, 0, -0.25]);
  b.add(S.cyl, lam('#44465a'), [0.77, 0.66, 0], [0.045, 0.2, 0.045], [0, 0, Math.PI / 2]);
  b.add(S.sph, glo(c), [0.88, 0.66, 0], [0.055, 0.055, 0.055]);
  hat(b, look.hat || 'none', c, g, anim, shadows);
  back(b, look.back || 'none', c, g, anim, shadows);
  const body = b.build(shadows);
  g.add(body);
  // legs on hip pivots so they can swing
  anim.legs = [-1, 1].map((z) => pivot(g, [0, 0.36, z * 0.12], (p) => {
    p.add(S.cyl, lam(pants), [0, -0.15, 0], [0.085, 0.3, 0.085]);
    p.add(S.box, lam('#22242f'), [0.05, -0.32, 0], [0.2, 0.08, 0.13]);
  }, shadows));
  // soft blob shadow: grounds the character even where real shadows are off (phones)
  const blob = new THREE.Mesh(blobGeo, blobMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  blob.renderOrder = -1;
  g.add(blob);
  g.userData.blob = blob;
  g.userData.anim = anim;
  return g;
}

// walk: 0..1 how much the character is walking; phase: walk cycle; t: seconds
export function animateCharacter(g, t, phase, walk) {
  const a = g.userData.anim;
  if (!a) return;
  const sw = Math.sin(phase) * 0.7 * walk;
  if (a.legs) { a.legs[0].rotation.z = sw; a.legs[1].rotation.z = -sw; }
  if (a.prop) a.prop.rotation.y = t * (8 + walk * 14);
  if (a.cape) a.cape.rotation.z = -0.12 - walk * 0.5 + Math.sin(t * 3) * 0.05;
  if (a.flag) a.flag.rotation.y = Math.sin(t * 4) * 0.35;
  if (a.flames) for (const f of a.flames) f.scale.set(1, 0.7 + Math.random() * 0.5 + walk * 0.6, 1);
  if (a.wings) a.wings.forEach((w, i) => { w.rotation.x = (i ? 1 : -1) * (0.15 + Math.sin(t * (walk ? 12 : 2)) * (walk ? 0.35 : 0.08)); });
}

export function disposeCharacter(g) {
  g.traverse((o) => { if (o.userData.own) o.geometry.dispose(); });
}
