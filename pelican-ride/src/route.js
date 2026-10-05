// 加州 1 号公路:路线、分区参数、地形高度函数
// 世界坐标:x=东, y=上, z=南。骑行方向向南 => 右手边(d>0)是西边,即太平洋。
// 路线朝向 phi:forward=(sin phi,0,cos phi), right(海)=(-cos phi,0,sin phi)
import { clamp, lerp, smoothstep, noise2, fbm } from './util.js';

export const L = 8400; // 总长(米)
export const DS = 2; // 路线采样间隔
const N = Math.ceil(L / DS) + 1;

// ---------------------------------------------------------------- 地标
export const LANDMARKS = {
  ggb: { s0: 160, s1: 960, t1: 300, t2: 820 },
  pigeon: { s: 2150, d: 88 },
  bixby: { s: 4050, w: 130 },
  morro: { s: 5950, d: 215, r: 135, h: 96 },
  pier: { s: 6850 },
};

export const PLACES = [
  { s: 0, name: '马林岬', en: 'Marin Headlands' },
  { s: 150, name: '金门大桥', en: 'Golden Gate Bridge · San Francisco' },
  { s: 1000, name: '太平洋城', en: 'Pacifica' },
  { s: 1750, name: '魔鬼滑坡', en: "Devil's Slide" },
  { s: 2050, name: '鸽子角灯塔', en: 'Pigeon Point Lighthouse' },
  { s: 2500, name: '半月湾', en: 'Half Moon Bay' },
  { s: 3000, name: '圣克鲁斯海岸', en: 'Santa Cruz Coast' },
  { s: 3500, name: '大瑟尔', en: 'Big Sur' },
  { s: 3880, name: '比克斯比溪大桥', en: 'Bixby Creek Bridge' },
  { s: 4350, name: '大瑟尔', en: 'Big Sur' },
  { s: 5200, name: '卡姆布里亚', en: 'Cambria' },
  { s: 5650, name: '莫罗湾 · 莫罗岩', en: 'Morro Bay · Morro Rock' },
  { s: 6150, name: '圣巴巴拉海岸', en: 'Santa Barbara Coast' },
  { s: 6600, name: '圣莫尼卡码头', en: 'Santa Monica Pier' },
  { s: 7150, name: '威尼斯海滩', en: 'Venice Beach' },
  { s: 7450, name: '马里布', en: 'Malibu' },
];

export const JUMPS = [
  { s: 20, label: '金门大桥', key: 'ggb' },
  { s: 1900, label: '魔鬼滑坡', key: 'ds' },
  { s: 2020, label: '鸽子角灯塔', key: 'pp' },
  { s: 3830, label: '比克斯比大桥', key: 'bx' },
  { s: 5620, label: '莫罗岩', key: 'mr' },
  { s: 6560, label: '圣莫尼卡码头', key: 'sm' },
  { s: 7700, label: '马里布', key: 'ml' },
];

export function placeAt(s) {
  let p = PLACES[0];
  for (const q of PLACES) if (s >= q.s) p = q;
  return p;
}

// ---------------------------------------------------------------- 分区关键帧
// e: 路面海拔  edge: 海侧悬崖/海岸线到路中心距离  cliffW: 崖面水平宽度  rise: 内陆山丘高度(250m处)
// rough: 地形起伏  green: 植被翠绿程度  sand: 沙滩权重  stacks: 海蚀柱  fog: 海雾倍率
// veg: [柏树, 针叶林, 橡树, 棕榈, 灌木, 冰花, 岩石]
const KEYS = [
  { s: 0, e: 62, edge: 26, cliffW: 90, rise: 122, rough: 9, green: 0.35, sand: 0, stacks: 0.3, fog: 1.8, veg: [0.3, 0.1, 0.2, 0, 1.2, 0.8, 0.3] },
  { s: 1000, e: 56, edge: 30, cliffW: 80, rise: 86, rough: 6, green: 0.55, sand: 0, stacks: 0.5, fog: 1.4, veg: [0.9, 0.4, 0.6, 0, 1.0, 0.9, 0.3] },
  { s: 1700, e: 44, edge: 22, cliffW: 70, rise: 166, rough: 10, green: 0.45, sand: 0, stacks: 0.9, fog: 1.2, veg: [0.7, 0.3, 0.3, 0, 1.3, 1.0, 0.7] },
  { s: 2150, e: 30, edge: 150, cliffW: 45, rise: 29, rough: 3, green: 0.3, sand: 0, stacks: 1.0, fog: 1.0, veg: [0.4, 0, 0.1, 0, 0.8, 1.2, 0.3] },
  { s: 2500, e: 14, edge: 80, cliffW: 40, rise: 20, rough: 2, green: 0.8, sand: 0, stacks: 0.3, fog: 0.9, veg: [0.6, 0, 0.2, 0, 0.5, 0.6, 0.1] },
  { s: 3000, e: 18, edge: 40, cliffW: 50, rise: 72, rough: 5, green: 0.7, sand: 0, stacks: 0.4, fog: 1.0, veg: [0.7, 0.4, 0.5, 0, 0.8, 0.8, 0.3] },
  { s: 3600, e: 72, edge: 15, cliffW: 120, rise: 274, rough: 18, green: 0.75, sand: 0, stacks: 1.2, fog: 1.6, veg: [0.3, 1.2, 0.2, 0, 1.5, 0.5, 1.2] },
  { s: 4700, e: 88, edge: 12, cliffW: 130, rise: 288, rough: 18, green: 0.65, sand: 0, stacks: 1.3, fog: 1.5, veg: [0.3, 1.0, 0.2, 0, 1.5, 0.5, 1.2] },
  { s: 5500, e: 6, edge: 48, cliffW: 70, rise: 58, rough: 3, green: 0.3, sand: 0.6, stacks: 0, fog: 1.0, veg: [0.6, 0, 0.1, 0, 0.9, 0.5, 0.2] },
  { s: 6100, e: 5, edge: 36, cliffW: 90, rise: 27, rough: 2, green: 0.45, sand: 1, stacks: 0, fog: 0.8, veg: [0.15, 0, 0.1, 1.1, 0.6, 0.3, 0] },
  { s: 6850, e: 5, edge: 30, cliffW: 85, rise: 17, rough: 1.5, green: 0.5, sand: 1, stacks: 0, fog: 0.7, veg: [0.1, 0, 0.1, 1.5, 0.4, 0.2, 0] },
  { s: 7450, e: 22, edge: 22, cliffW: 75, rise: 101, rough: 8, green: 0.2, sand: 0.3, stacks: 0.6, fog: 0.8, veg: [0.1, 0, 0.2, 0.4, 1.4, 0.8, 0.7] },
  { s: L, e: 32, edge: 18, cliffW: 75, rise: 122, rough: 9, green: 0.2, sand: 0.2, stacks: 0.6, fog: 0.8, veg: [0.1, 0, 0.2, 0.2, 1.4, 0.8, 0.8] },
];

export function makeZone() {
  return { e: 0, edge: 0, cliffW: 0, rise: 0, rough: 0, green: 0, sand: 0, stacks: 0, fog: 1, veg: new Float32Array(7) };
}
const FIELDS = ['e', 'edge', 'cliffW', 'rise', 'rough', 'green', 'sand', 'stacks', 'fog'];

// 地标路段需要平坦路面
const FLAT = [
  [3880, 4260, 82],
];

export function getZone(s, out = makeZone()) {
  s = clamp(s, 0, L);
  let i = 0;
  while (i < KEYS.length - 2 && s > KEYS[i + 1].s) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = smoothstep(0, 1, (s - a.s) / (b.s - a.s));
  for (const f of FIELDS) out[f] = lerp(a[f], b[f], t);
  for (let k = 0; k < 7; k++) out.veg[k] = lerp(a.veg[k], b.veg[k], t);
  // 大桥区域路面保持水平
  for (const [f0, f1, h] of FLAT) {
    const m = smoothstep(f0 - 160, f0 - 20, s) * (1 - smoothstep(f1 + 20, f1 + 160, s));
    if (m > 0) out.e = lerp(out.e, h, m);
  }
  // 金门大桥路面
  const g = LANDMARKS.ggb;
  const mg = smoothstep(g.s0 - 120, g.s0 - 10, s) * (1 - smoothstep(g.s1 + 10, g.s1 + 120, s));
  if (mg > 0) out.e = lerp(out.e, 58, mg);
  return out;
}

// ---------------------------------------------------------------- 路线(水平)
const X = new Float32Array(N), Z = new Float32Array(N), PHI = new Float32Array(N), KAP = new Float32Array(N), E = new Float32Array(N);
const STRAIGHT = [
  [60, 1060],
  [2030, 2270],
  [3870, 4240],
  [6700, 7000],
];
function straightMask(s) {
  let m = 1;
  for (const [a, b] of STRAIGHT) m *= 1 - smoothstep(a - 120, a, s) * (1 - smoothstep(b, b + 120, s));
  return m;
}
(function build() {
  let x = 0, z = 0, phi = 0.28;
  const zone = makeZone();
  for (let i = 0; i < N; i++) {
    const s = i * DS;
    const k =
      (0.0011 * Math.sin(s / 260 + 1.3) + 0.0008 * Math.sin(s / 140 + 0.4) + 0.0004 * Math.sin(s / 90 + 2.0)) *
      straightMask(s);
    X[i] = x; Z[i] = z; PHI[i] = phi; KAP[i] = k;
    getZone(s, zone);
    E[i] = zone.e + (zone.e > 9 ? 0 : 0);
    phi += k * DS;
    x += Math.sin(phi) * DS;
    z += Math.cos(phi) * DS;
  }
})();

export const sampleOut = { x: 0, z: 0, phi: 0, kappa: 0, e: 0, sinp: 0, cosp: 1 };
export function sampleRoute(s, out = sampleOut) {
  s = clamp(s, 0, L - 0.01);
  const f = s / DS, i = Math.floor(f), t = f - i;
  out.x = X[i] + (X[i + 1] - X[i]) * t;
  out.z = Z[i] + (Z[i + 1] - Z[i]) * t;
  out.phi = PHI[i] + (PHI[i + 1] - PHI[i]) * t;
  out.kappa = KAP[i] + (KAP[i + 1] - KAP[i]) * t;
  out.e = E[i] + (E[i + 1] - E[i]) * t;
  out.sinp = Math.sin(out.phi);
  out.cosp = Math.cos(out.phi);
  return out;
}

// (s,d) -> 世界 xz
export function toWorld(s, d, out = { x: 0, z: 0 }) {
  const r = sampleRoute(s);
  out.x = r.x - r.cosp * d;
  out.z = r.z + r.sinp * d;
  return out;
}

// 世界 xz -> (s,d),带 hint 加速
export function project(x, z, hint = 0, out = { s: 0, d: 0, dist: 0 }) {
  let best = 1e18, bi = 0;
  const c = Math.round(hint / DS);
  const span = 260;
  const i0 = Math.max(0, c - span), i1 = Math.min(N - 2, c + span);
  for (let i = i0; i <= i1; i++) {
    const dx = X[i] - x, dz = Z[i] - z;
    const q = dx * dx + dz * dz;
    if (q < best) { best = q; bi = i; }
  }
  const s = bi * DS;
  const r = sampleRoute(s);
  out.s = s;
  out.d = -((x - r.x) * r.cosp) + (z - r.z) * r.sinp;
  out.dist = Math.sqrt(best);
  return out;
}

// ---- 最近路线点网格(远景地形用)
const GC = 128, GM = 3800;
let gMinX = 1e9, gMinZ = 1e9, gMaxX = -1e9, gMaxZ = -1e9;
for (let i = 0; i < N; i += 8) {
  gMinX = Math.min(gMinX, X[i]); gMaxX = Math.max(gMaxX, X[i]);
  gMinZ = Math.min(gMinZ, Z[i]); gMaxZ = Math.max(gMaxZ, Z[i]);
}
gMinX -= GM; gMinZ -= GM; gMaxX += GM; gMaxZ += GM;
const GW = Math.ceil((gMaxX - gMinX) / GC) + 1, GH = Math.ceil((gMaxZ - gMinZ) / GC) + 1;
const NEAR = new Uint16Array(GW * GH);
(function () {
  for (let gz = 0; gz < GH; gz++) {
    for (let gx = 0; gx < GW; gx++) {
      const cx = gMinX + (gx + 0.5) * GC, cz = gMinZ + (gz + 0.5) * GC;
      let best = 1e18, bi = 0;
      for (let i = 0; i < N; i += 3) {
        const dx = X[i] - cx, dz = Z[i] - cz;
        const q = dx * dx + dz * dz;
        if (q < best) { best = q; bi = i; }
      }
      NEAR[gz * GW + gx] = bi;
    }
  }
})();
// 任意世界点 -> (s,d)。远处点不会出现带状地形的折叠问题
export function projectFar(x, z, out = { s: 0, d: 0 }) {
  const gx = clamp(Math.floor((x - gMinX) / GC), 0, GW - 1), gz = clamp(Math.floor((z - gMinZ) / GC), 0, GH - 1);
  const c = NEAR[gz * GW + gx];
  const i0 = Math.max(0, c - 70), i1 = Math.min(N - 2, c + 70);
  let best = 1e18, bi = c;
  for (let i = i0; i <= i1; i++) {
    const dx = X[i] - x, dz = Z[i] - z;
    const q = dx * dx + dz * dz;
    if (q < best) { best = q; bi = i; }
  }
  const s = bi * DS;
  const r = sampleRoute(s);
  out.s = s;
  out.d = -((x - r.x) * r.cosp) + (z - r.z) * r.sinp;
  return out;
}

// ---------------------------------------------------------------- 地形高度
const zTmp = makeZone();
const B = LANDMARKS;

// 金门海峡:向海与向海湾两侧开阔,越往内陆越窄,海岸线随 d 起伏,避免出现直墙
function bridgeMask(s, d) {
  const lateral = 1 - smoothstep(-60, -230, d);
  const wob = 46 * (noise2(d * 0.011, 7.7, 33) - 0.5);
  const a = smoothstep(B.ggb.s0 - 40 + wob, B.ggb.s0 + 100 + wob, s) * (1 - smoothstep(B.ggb.s1 - 100 + wob, B.ggb.s1 + 40 + wob, s));
  return a * lateral;
}

// 低成本版本(用于阴影烘焙):只含大尺度形态
export function terrainHeight(s, d, z, detail = true) {
  const ad = Math.abs(d);
  let h;
  if (d >= 0) {
    const edge = Math.max(10, z.edge * (0.78 + 0.44 * noise2(s * 0.011, 1.7, 3)) + (detail ? 4 * noise2(s * 0.07, 0.3, 4) : 0));
    const u = d - edge;
    if (u <= 0) {
      h = z.e + (detail ? z.rough * 0.12 * (noise2(s * 0.04, d * 0.04, 5) - 0.5) * smoothstep(8, 30, d) : 0);
      // 临崖处略微下沉
      h -= 0.6 * smoothstep(-8, 0, u) * (z.e > 8 ? 1 : 0);
    } else {
      const W = z.cliffW * (0.75 + 0.5 * noise2(s * 0.028, 9.1, 6));
      const t = u / W;
      if (t < 1) {
        // 上陡下缓的崖面
        const p = 1 - Math.pow(smoothstep(0, 1, t), 1.0);
        h = z.e * p * (1 - 0.0 * t);
        if (detail) h += z.rough * 0.9 * (noise2(s * 0.09, d * 0.09, 7) - 0.5) * Math.sin(Math.PI * t) * (z.e > 8 ? 1 : 0.2);
      } else {
        h = -(u - W) * 0.06;
      }
      // 海蚀柱
      if (z.stacks > 0.05 && u > 18 && d < 380) {
        const sn = noise2(s * 0.016 + 5.2, d * 0.016 + 1.1, 8);
        const m = smoothstep(0.64, 0.8, sn);
        if (m > 0) h = Math.max(h, m * (26 + 22 * noise2(s * 0.05, d * 0.05, 9)) * Math.min(1, z.stacks) - 4 + (h < 0 ? 0 : 0));
      }
    }
  } else {
    const t0 = Math.max(0, (ad - 7) / 260);
    const t = t0 <= 1 ? t0 : 1 + 0.3 * Math.log(t0); // 远处缓慢饱和,形成山脉而非无限增高
    let n1 = fbm(s * 0.0042, d * 0.0042, detail || t0 < 1.5 ? 4 : 2, 11);
    if (t0 > 1) n1 = lerp(n1, fbm(s * 0.0019, d * 0.0019, 2, 14), smoothstep(1, 2.4, t0)); // 远景改用更低频的起伏,避免尖刺
    h = z.e + z.rise * Math.pow(t, 1.25) * (0.5 + 1.0 * n1);
    if (detail) h += z.rough * (fbm(s * 0.03, d * 0.03, 3, 13) - 0.5) * 2 * smoothstep(0, 0.25, t);
  }

  // 莫罗岩与沙洲
  const m = B.morro;
  const dx = s - m.s, dy = d - m.d;
  if (Math.abs(dx) < m.r * 1.4 && Math.abs(dy) < m.r * 1.4) {
    const r = Math.sqrt(dx * dx + dy * dy) * (1 + 0.18 * (noise2(dx * 0.02, dy * 0.02, 21) - 0.5));
    if (r < m.r) {
      const q = 1 - r / m.r;
      let rock = m.h * Math.pow(q, 0.62) * (0.88 + 0.28 * noise2(dx * 0.045, dy * 0.045, 22));
      rock -= 4;
      if (detail) rock += 2.2 * (noise2(dx * 0.2, dy * 0.2, 23) - 0.5);
      h = Math.max(h, rock);
    }
    // 连接海岸的沙洲
    if (dy < -m.r * 0.2 && Math.abs(dx) < 26) {
      const edge0 = z.edge;
      if (d > edge0 - 5) {
        const sb = (1 - smoothstep(10, 26, Math.abs(dx))) * (1 - smoothstep(m.d - m.r * 0.9, m.d - m.r * 0.5, d));
        h = Math.max(h, 1.8 * sb - 0.3);
      }
    }
  }

  // 金门海峡
  const bm = bridgeMask(s, d);
  if (bm > 0) h = lerp(h, -36 + (detail ? 4 * noise2(s * 0.05, d * 0.05, 31) : 0), bm);

  // 比克斯比峡谷
  const bx = B.bixby;
  const cx = Math.abs(s - bx.s);
  if (cx < bx.w) {
    const c = smoothstep(0, 1, 1 - cx / bx.w);
    const floor = 8 + 0.3 * Math.max(0, -d) - 0.12 * Math.max(0, d);
    h = Math.min(h, floor + (1 - c) * 150 + (detail ? 3 * noise2(s * 0.08, d * 0.08, 41) : 0));
  }

  // 路基:路面两侧平整
  if (ad < 16) {
    const roadH = z.e - 0.12;
    const keep = bm > 0 ? 1 - bm : 1;
    let k = 1 - smoothstep(5.8, 16, ad);
    if (cx < bx.w) k *= 1 - smoothstep(0, 1, 1 - cx / bx.w) * smoothstep(0.1, 0.45, 1 - cx / bx.w);
    k *= keep;
    h = lerp(h, roadH, k);
  }
  return h;
}

export function heightAt(s, d) {
  return terrainHeight(s, d, getZone(s, zTmp));
}

// 横向采样列(不等距:近密远疏)
export const D_SAMPLES = (function () {
  const arr = [];
  let d = -260;
  // 内陆
  while (d < -40) { arr.push(d); d += Math.max(2, Math.min(9, Math.abs(d) * 0.07)); }
  d = -40;
  while (d < 60) { arr.push(d); d += 1.5; }
  d = 60;
  while (d < 440) { arr.push(d); d += Math.min(6, 1.5 + (d - 60) * 0.02); }
  arr.push(440);
  return Float32Array.from(arr);
})();
