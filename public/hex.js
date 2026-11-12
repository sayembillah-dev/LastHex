// Shared by server (game.js) and client. Pointy-top hex grid on the X/Z plane.
export const SQRT3 = Math.sqrt(3);
export const TILE = 1; // hex circumradius in world units
export const ARENA_RADIUS = 5;

export const COLORS = ['#ff4d4d', '#4da6ff', '#ffd24d', '#5cd65c', '#c77dff', '#ff9f43', '#2ee6d6', '#ff6bcb', '#f5f5f5', '#3d3d4d'];
export const HATS = ['none', 'cap', 'crown', 'horns', 'antenna', 'halo'];

export function axialToWorld(q, r) {
  return { x: TILE * SQRT3 * (q + r / 2), z: TILE * 1.5 * r };
}

export function worldToAxial(x, z) {
  const q = ((SQRT3 / 3) * x - z / 3) / TILE;
  const r = ((2 / 3) * z) / TILE;
  const s = -q - r;
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export const hexDist = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
export const tileKey = (q, r) => q + ',' + r;

// Deterministic order so server and client agree on tile indices.
export function buildTiles(R = ARENA_RADIUS) {
  const tiles = [];
  for (let q = -R; q <= R; q++) {
    for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
      tiles.push({ q, r, ring: hexDist(q, r) });
    }
  }
  return tiles;
}
