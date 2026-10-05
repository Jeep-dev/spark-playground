// 沿路线分块的带状地形 + 路面 + 护栏
import * as THREE from 'three';
import { L, D_SAMPLES, sampleRoute, getZone, makeZone, terrainHeight, projectFar, LANDMARKS } from './route.js';
import { clamp, lerp, smoothstep, noise2, fbm, hex, mix3 } from './util.js';
import { extend } from './sky.js';
import { makeAsphaltTextures } from './textures.js';

export const CH = 64; // 每块长度
const ROWS = 16; // 4m 间隔
const RS = CH / ROWS;
const ND = D_SAMPLES.length;
export const BACK = 6;
export const AHEAD = 36;
const NV = (ROWS + 1) * ND;

// ---- 色板(线性)
const P = {
  gold: hex(0x93794a),
  gold2: hex(0x76653a),
  green: hex(0x4b6d33),
  green2: hex(0x35502a),
  forest: hex(0x1b301f),
  rock: hex(0x544a40),
  rock2: hex(0x75665a),
  sand: hex(0xcdb98e),
  wetsand: hex(0x8a7c5f),
  gravel: hex(0x706a60),
  dirt: hex(0x655238),
  under: hex(0xa5946d),
};

const c1 = [0, 0, 0], c2 = [0, 0, 0];
export function terrainColor(out, s, d, h, ny, z) {
  const ad = Math.abs(d);
  const n1 = fbm(s * 0.006, d * 0.006, 3, 51);
  const n2 = noise2(s * 0.04, d * 0.04, 52);
  // 植被基础色
  const g = clamp(z.green + (n1 - 0.5) * 1.1, 0, 1);
  mix3(P.gold, P.gold2, n2, c1);
  mix3(P.green, P.green2, n2, c2);
  mix3(c1, c2, g, out);
  // 高处/茂密林地
  if (d < 0) {
    const forest = smoothstep(0.55, 0.9, z.green) * smoothstep(20, 90, -d) * smoothstep(0.3, 0.7, n1);
    mix3(out, P.forest, forest * 0.8, out);
  }
  // 岩石:陡坡
  const steep = smoothstep(0.9, 0.62, ny);
  if (steep > 0) {
    const strata = 0.5 + 0.5 * Math.sin(h * 0.9 + n1 * 6);
    mix3(P.rock, P.rock2, strata * 0.7 + n2 * 0.3, c1);
    mix3(out, c1, steep, out);
  }
  // 沙滩
  if (d > 0 && z.sand > 0.05) {
    const sw = z.sand * (1 - smoothstep(4.5, 9.0, h)) * smoothstep(0.8, 0.95, ny) * (0.75 + 0.25 * n2);
    if (sw > 0) mix3(out, P.sand, sw, out);
  }
  // 水线附近:一般都有沙/卵石
  if (h < 1.6 && d > 0) {
    const sw = (1 - smoothstep(0.6, 1.8, h)) * smoothstep(0.7, 0.95, ny);
    mix3(out, P.sand, sw * 0.8, out);
  }
  if (h < 0.2) mix3(out, P.under, smoothstep(0.2, -0.3, h), out);
  // 路肩
  const sh = 1 - smoothstep(5.8, 9.5, ad);
  if (sh > 0) {
    mix3(P.gravel, P.dirt, n2, c1);
    mix3(out, c1, sh * 0.9, out);
  }
}


// 共享索引
const INDEX = (() => {
  const idx = new Uint32Array(ROWS * (ND - 1) * 6);
  let k = 0;
  for (let i = 0; i < ROWS; i++)
    for (let j = 0; j < ND - 1; j++) {
      const a = i * ND + j, b = a + 1, c = a + ND, d = c + 1;
      // 朝上的三角(从上往下看逆时针)
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = b; idx[k++] = d; idx[k++] = c;
    }
  return idx;
})();

const GLSL_NOISE = /* glsl */ `
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
`;

export function makeTerrainMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, envMapIntensity: 0.9 });
  extend(m, {
    key: 'terrain',
    vsDecl: 'attribute float sunVis;\nvarying float vSunVis;\nvarying vec3 vWP;\nvarying vec3 vWN;',
    vsAfterBegin: 'vSunVis = sunVis; vWN = normal; vWP = (modelMatrix * vec4(transformed,1.0)).xyz;',
    fsDecl: `varying float vSunVis;\nvarying vec3 vWP;\nvarying vec3 vWN;\n${GLSL_NOISE}\nfloat tri(vec3 an, float sc){ return an.y*vn(vWP.xz*sc) + an.x*vn(vWP.zy*sc) + an.z*vn(vWP.xy*sc); }`,
    fsAfterColor: /* glsl */ `
      {
        float dist = length(vViewPosition);
        float fine = 1.0 - smoothstep(60.0, 260.0, dist);
        vec3 an = abs(normalize(vWN)); an = an*an; an /= (an.x+an.y+an.z);
        float dn = tri(an,0.16)*0.45 + tri(an,0.8)*0.3 + (tri(an,4.1)*0.25)*fine;
        diffuseColor.rgb *= 0.74 + 0.56*dn;
        // 水下:由浅绿松石渐变到深海色
        float uw = smoothstep(0.2, -0.5, vWP.y);
        float dep = clamp(-vWP.y/16.0, 0.0, 1.0);
        vec3 shallow = diffuseColor.rgb * vec3(0.30, 0.78, 0.74);
        vec3 deepc = vec3(0.003, 0.03, 0.045);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(shallow, deepc, pow(dep, 0.6)), uw);
        // 湿沙
        float wet = (1.0 - smoothstep(0.0, 1.4, vWP.y)) * (1.0 - uw);
        diffuseColor.rgb *= mix(1.0, 0.62, wet);
        // 海浪冲上岸的泡沫
        float swash = 0.30 + 0.28*sin(uTime*0.9 + vWP.x*0.045 + vWP.z*0.031) + 0.12*vn(vWP.xz*0.5 + uTime*0.08);
        float foam = smoothstep(swash, swash-0.4, vWP.y) * smoothstep(-0.7, -0.1, vWP.y);
        foam *= 0.55 + 0.7*vn(vWP.xz*2.1 + uTime*0.25);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85,0.88,0.9), clamp(foam, 0.0, 0.9));
      }`,
    fsAfterLights: 'reflectedLight.directDiffuse *= vSunVis; reflectedLight.directSpecular *= vSunVis;',
  });
  return m;
}

export class Terrain {
  constructor(scene, atmosphere) {
    this.scene = scene;
    this.atm = atmosphere;
    this.material = makeTerrainMaterial();
    const tex = makeAsphaltTextures();
    this.roadMat = new THREE.MeshStandardMaterial({
      map: tex.map, roughnessMap: tex.rough, bumpMap: tex.bump, bumpScale: 1.2,
      roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    extend(this.roadMat, { key: 'road' });
    this.railMat = new THREE.MeshStandardMaterial({ color: 0xaab0b4, roughness: 0.45, metalness: 0.75, side: THREE.DoubleSide });
    extend(this.railMat, { key: 'rail' });

    this.group = new THREE.Group();
    scene.add(this.group);
    this.chunks = new Map(); // idx -> chunk
    this.free = [];
    this.queue = [];
    this._zone = makeZone();
    this._r = { x: 0, z: 0, phi: 0 };
    this.sunKey = new THREE.Vector3();
    this.lastIdx = -999;
    this.builtCount = 0;
  }

  _alloc() {
    if (this.free.length) return this.free.pop();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NV * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(NV * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(NV * 3), 3));
    g.setAttribute('sunVis', new THREE.BufferAttribute(new Float32Array(NV).fill(1), 1));
    g.setIndex(new THREE.BufferAttribute(INDEX, 1));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;

    // 路面
    const RR = CH / 2 + 1;
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RR * 2 * 3), 3));
    rg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(RR * 2 * 3), 3));
    rg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(RR * 2 * 2), 2));
    const ri = [];
    for (let i = 0; i < RR - 1; i++) {
      const a = i * 2;
      ri.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    rg.setIndex(ri);
    const road = new THREE.Mesh(rg, this.roadMat);
    road.receiveShadow = true;

    // 护栏:立柱 + 梁
    const maxPosts = CH / 4;
    const rl = new THREE.BufferGeometry();
    const rv = maxPosts * 24 + (CH / 2 + 1) * 4;
    rl.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rv * 3), 3));
    rl.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rv * 3), 3));
    rl.setIndex(new THREE.BufferAttribute(new Uint32Array(maxPosts * 36 + (CH / 2) * 12), 1));
    const rail = new THREE.Mesh(rl, this.railMat);
    rail.castShadow = true;
    rail.receiveShadow = true;

    this.group.add(mesh, road, rail);
    return { mesh, road, rail, idx: -1, sunDir: new THREE.Vector3(9, 9, 9), H: new Float32Array(NV + 2 * ND), P: new Float32Array((NV + 2 * ND) * 3) };
  }

  // 构建 chunk
  build(ch, idx) {
    ch.idx = idx;
    const s0 = idx * CH;
    const zone = this._zone;
    const r = this._r;
    const P3 = ch.P;
    const H = ch.H;
    // 含上下各 1 行 padding,共 ROWS+3 行
    const rowsAll = ROWS + 3;
    const rowZ = [];
    for (let i = -1; i <= ROWS + 1; i++) {
      const s = s0 + i * RS;
      const z = makeZone();
      getZone(s, z);
      rowZ.push(z);
    }
    for (let ii = 0; ii < rowsAll; ii++) {
      const i = ii - 1;
      const s = s0 + i * RS;
      const z = rowZ[ii];
      sampleRoute(s, r);
      for (let j = 0; j < ND; j++) {
        const d = D_SAMPLES[j];
        const h = terrainHeight(s, d, z, true);
        const k = ii * ND + j;
        H[k] = h;
        P3[k * 3] = r.x - r.cosp * d;
        P3[k * 3 + 1] = h;
        P3[k * 3 + 2] = r.z + r.sinp * d;
      }
    }
    const geo = ch.mesh.geometry;
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const col = geo.attributes.color.array;
    const c3 = [0, 0, 0], c4 = [0, 0, 0];
    for (let i = 0; i <= ROWS; i++) {
      const z = rowZ[i + 1];
      const s = s0 + i * RS;
      for (let j = 0; j < ND; j++) {
        const k = i * ND + j;
        const kk = (i + 1) * ND + j; // padded index
        pos[k * 3] = P3[kk * 3];
        pos[k * 3 + 1] = P3[kk * 3 + 1];
        pos[k * 3 + 2] = P3[kk * 3 + 2];
        // 中心差分法线
        const jl = Math.max(0, j - 1), jr = Math.min(ND - 1, j + 1);
        const ax = P3[((i + 2) * ND + j) * 3] - P3[(i * ND + j) * 3];
        const ay = P3[((i + 2) * ND + j) * 3 + 1] - P3[(i * ND + j) * 3 + 1];
        const az = P3[((i + 2) * ND + j) * 3 + 2] - P3[(i * ND + j) * 3 + 2];
        const bx = P3[((i + 1) * ND + jr) * 3] - P3[((i + 1) * ND + jl) * 3];
        const by = P3[((i + 1) * ND + jr) * 3 + 1] - P3[((i + 1) * ND + jl) * 3 + 1];
        const bz = P3[((i + 1) * ND + jr) * 3 + 2] - P3[((i + 1) * ND + jl) * 3 + 2];
        // a = 沿 s 方向, b = 沿 d 方向(d 增大 = 向右/向海)
        // 法线 = b × a  (保证朝上)
        let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
        terrainColor(c3, s, D_SAMPLES[j], P3[kk * 3 + 1], ny, z);
        col[k * 3] = c3[0]; col[k * 3 + 1] = c3[1]; col[k * 3 + 2] = c3[2];
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeBoundingSphere();
    // 垂直方向多留余量,避免远处误剔除
    ch.mesh.visible = true;

    this._road(ch, s0, rowZ);
    this._rail(ch, s0, rowZ);
    ch.sunDir.set(9, 9, 9); // 需要烘焙阴影
    this.builtCount++;
  }

  _road(ch, s0, rowZ) {
    const g = ch.road.geometry;
    const pos = g.attributes.position.array, nor = g.attributes.normal.array, uv = g.attributes.uv.array;
    const r = this._r;
    const z = this._zone;
    const HW = 5.3;
    const RR = CH / 2 + 1;
    for (let i = 0; i < RR; i++) {
      const s = s0 + i * 2;
      sampleRoute(s, r);
      getZone(s, z);
      const y = z.e + 0.03;
      for (let c = 0; c < 2; c++) {
        const d = c === 0 ? -HW : HW;
        const k = i * 2 + c;
        pos[k * 3] = r.x - r.cosp * d;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = r.z + r.sinp * d;
        nor[k * 3] = 0; nor[k * 3 + 1] = 1; nor[k * 3 + 2] = 0;
        uv[k * 2] = c;
        uv[k * 2 + 1] = s / 12;
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.computeBoundingSphere();
    // 路面三角形朝向:检查缠绕方向 -> 使其朝上
    // (a=左(d=-)端, b=右端; 顶点序列 a,b,a',b'...)
  }

  _rail(ch, s0) {
    const g = ch.rail.geometry;
    const zc = getZone(s0 + CH / 2, this._zone);
    const want = zc.edge < 50 && zc.e > 9 && !(s0 + CH / 2 > LANDMARKS.ggb.s0 - 20 && s0 + CH / 2 < LANDMARKS.ggb.s1 + 20);
    if (!want) { ch.rail.visible = false; return; }
    ch.rail.visible = true;
    const pos = g.attributes.position.array, nor = g.attributes.normal.array;
    const idx = g.index.array;
    let vc = 0, ic = 0;
    const r = this._r;
    const D = 6.1;
    const z = makeZone();
    const pushBox = (cx, cy, cz, sx, sy, sz, yawS, yawC) => {
      // 立柱:以路线局部坐标 (x=横向, z=纵向)
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const faces = [
        [[1, 0, 0], [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]]],
        [[-1, 0, 0], [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]]],
        [[0, 1, 0], [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]]],
        [[0, 0, 1], [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]]],
        [[0, 0, -1], [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]]],
        [[0, -1, 0], [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]]],
      ];
      for (const [n, vs] of faces) {
        const base = vc;
        for (const v of vs) {
          const lx = v[0] + cx, lz = v[2] + cz; // lx: 向海为 +d, lz: 沿路为 +s
          pos[vc * 3] = r.x + yawS * lz - yawC * lx;
          pos[vc * 3 + 1] = v[1] + cy;
          pos[vc * 3 + 2] = r.z + yawC * lz + yawS * lx;
          nor[vc * 3] = yawS * n[2] - yawC * n[0];
          nor[vc * 3 + 1] = n[1];
          nor[vc * 3 + 2] = yawC * n[2] + yawS * n[0];
          vc++;
        }
        idx[ic++] = base; idx[ic++] = base + 1; idx[ic++] = base + 2;
        idx[ic++] = base; idx[ic++] = base + 2; idx[ic++] = base + 3;
      }
    };
    // 立柱:每 4m
    for (let i = 0; i < CH / 4; i++) {
      const s = s0 + i * 4 + 2;
      sampleRoute(s, r);
      getZone(s, z);
      pushBox(D, z.e + 0.35, 0, 0.1, 0.7, 0.1, r.sinp, r.cosp);
    }
    // 梁(W 形近似为扁平带):沿路每 2m 一段
    const beamStart = vc;
    const nb = CH / 2;
    let rows = 0;
    for (let i = 0; i <= nb; i++) {
      const s = s0 + i * 2;
      sampleRoute(s, r);
      getZone(s, z);
      for (const [dy, dd] of [[0.55, 0], [0.85, 0]]) {
        const lx = D - 0.05, y = z.e + dy;
        pos[vc * 3] = r.x - r.cosp * lx;
        pos[vc * 3 + 1] = y;
        pos[vc * 3 + 2] = r.z + r.sinp * lx;
        // 法线朝向路中心(向内):-right
        nor[vc * 3] = r.cosp; nor[vc * 3 + 1] = 0; nor[vc * 3 + 2] = -r.sinp;
        vc++;
      }
      rows++;
    }
    for (let i = 0; i < nb; i++) {
      const a = beamStart + i * 2;
      idx[ic++] = a; idx[ic++] = a + 1; idx[ic++] = a + 2;
      idx[ic++] = a + 1; idx[ic++] = a + 3; idx[ic++] = a + 2;
    }
    g.setDrawRange(0, ic);
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.index.needsUpdate = true;
    g.computeBoundingSphere();
  }

  // ---------------------------------------------------------- 阴影烘焙(地形自遮挡)
  bake(ch, sunDir, sunOn) {
    const geo = ch.mesh.geometry;
    const sv = geo.attributes.sunVis.array;
    ch.sunDir.copy(sunDir);
    if (!sunOn) { sv.fill(1); geo.attributes.sunVis.needsUpdate = true; return; }
    const s0 = ch.idx * CH;
    const rc = sampleRoute(s0 + CH / 2, this._r);
    const phi = rc.phi;
    const sn = Math.sin(phi), cs = Math.cos(phi);
    // 太阳方向在 (沿路, 向右, 向上) 局部系
    const al = sunDir.x * sn + sunDir.z * cs;
    const ri = sunDir.x * -cs + sunDir.z * sn;
    const up = sunDir.y;
    const hor = Math.hypot(al, ri) || 1;
    const dS = al / hor, dD = ri / hor, slope = up / hor; // 每水平米上升
    const COLS = 6, RW = 8;
    const nC = Math.ceil((ND - 1) / COLS) + 1, nR = ROWS / RW + 1;
    const grid = new Float32Array(nC * nR);
    const z = this._zone;
    const steps = [2, 4, 7, 11, 16, 24, 34, 48, 66, 90, 120, 160, 210, 270, 340];
    const P3 = ch.P;
    for (let a = 0; a < nR; a++) {
      const i = a * RW;
      const s = s0 + i * RS;
      for (let b = 0; b < nC; b++) {
        const j = Math.min(ND - 1, b * COLS);
        const d = D_SAMPLES[j];
        const h = ch.mesh.geometry.attributes.position.array[(i * ND + j) * 3 + 1] + 1.2;
        let vis = 1;
        for (let q = 0; q < steps.length; q++) {
          const t = steps[q];
          const ss = s + dS * t, dd = d + dD * t;
          if (dd < -262 || dd > 442 || ss < 0 || ss > L) break;
          const th = terrainHeight(ss, dd, getZone(ss, z), false);
          const rayH = h + slope * t;
          vis = Math.min(vis, clamp(0.5 + (rayH - th) / (0.12 * t + 1.5), 0, 1));
          if (vis <= 0) break;
        }
        grid[a * nC + b] = vis;
      }
    }
    for (let i = 0; i <= ROWS; i++) {
      const fa = i / RW, a0 = Math.min(nR - 2, Math.floor(fa)), ta = fa - a0;
      for (let j = 0; j < ND; j++) {
        const fb = j / COLS, b0 = Math.min(nC - 2, Math.floor(fb)), tb = fb - b0;
        const v00 = grid[a0 * nC + b0], v01 = grid[a0 * nC + b0 + 1], v10 = grid[(a0 + 1) * nC + b0], v11 = grid[(a0 + 1) * nC + b0 + 1];
        sv[i * ND + j] = lerp(lerp(v00, v01, tb), lerp(v10, v11, tb), ta);
      }
    }
    geo.attributes.sunVis.needsUpdate = true;
  }

  // ---------------------------------------------------------- 每帧
  // 返回尚未建完的数量
  update(sBike, sunDir, sunOn, budgetMs = 6) {
    const c0 = Math.floor((sBike - BACK * CH) / CH), c1 = Math.floor((sBike + AHEAD * CH) / CH);
    const t0 = performance.now();
    // 回收范围外
    for (const [idx, ch] of this.chunks) {
      if (idx < c0 || idx > c1) {
        ch.mesh.visible = false; ch.road.visible = false; ch.rail.visible = false;
        this.chunks.delete(idx);
        this.free.push(ch);
      }
    }
    // 需要的 chunk,近处优先
    const mid = Math.floor(sBike / CH);
    let missing = 0;
    const order = [];
    for (let i = Math.max(0, c0); i <= Math.min(Math.floor(L / CH), c1); i++) if (!this.chunks.has(i)) order.push(i);
    order.sort((a, b) => Math.abs(a - mid - 1) - Math.abs(b - mid - 1));
    for (const i of order) {
      if (performance.now() - t0 > budgetMs) { missing++; continue; }
      const ch = this._alloc();
      ch.road.visible = true;
      this.build(ch, i);
      this.chunks.set(i, ch);
    }
    // 记录当前连续已建好的范围(供远景地形挖洞)
    let lo = mid, hi = mid;
    while (this.chunks.has(lo - 1)) lo--;
    while (this.chunks.has(hi + 1)) hi++;
    this.sMin = this.chunks.has(mid) ? lo * CH : 1e9;
    this.sMax = this.chunks.has(mid) ? (hi + 1) * CH : -1e9;
    // 阴影烘焙(每帧最多 2 块)
    let baked = 0;
    for (const ch of this.chunks.values()) {
      if (ch.sunDir.distanceToSquared(sunDir) > 0.0004 || (sunOn && ch.sunDir.y > 8)) {
        if (performance.now() - t0 > budgetMs + 3 && baked > 0) break;
        this.bake(ch, sunDir, sunOn);
        if (++baked >= 2) break;
      }
    }
    return missing;
  }

  // 一次性建完(加载/传送时)
  async warm(sBike, sunDir, sunOn, onProgress) {
    let guard = 0;
    for (;;) {
      const miss = this.update(sBike, sunDir, sunOn, 14);
      if (onProgress) onProgress(1 - miss / (AHEAD + BACK));
      if (miss === 0 || guard++ > 200) break;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}



// ------------------------------------------------------------------ 远景地形(世界坐标网格,覆盖带状地形之外)
const FN = 97, FCELL = 64;
export class FarTerrain {
  constructor(scene, material) {
    this.cache = new Map();
    this.cx = 1e9; this.cz = 1e9;
    this.sMin = 0; this.sMax = 0;
    const nv = FN * FN;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('sunVis', new THREE.BufferAttribute(new Float32Array(nv).fill(1), 1));
    this.index = new Uint32Array((FN - 1) * (FN - 1) * 6);
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    this.geo = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);
    this.zone = makeZone();
    this.tmp = { s: 0, d: 0 };
    this.c3 = [0, 0, 0];
    this.lastRange = [-1, -1];
    this.dirtyIdx = true;
  }

  _vertex(gx, gz) {
    const key = gx * 65537 + gz;
    let v = this.cache.get(key);
    if (v) return v;
    const x = gx * FCELL, z = gz * FCELL;
    const p = projectFar(x, z, this.tmp);
    let h;
    if (p.d > 470) h = -60;
    else {
      const zz = getZone(p.s, this.zone);
      h = terrainHeight(p.s, p.d, zz, false);
      // 与带状地形重叠处下沉,避免穿插/闪烁
      const ad = Math.abs(p.d);
      h -= 3 * (1 - smoothstep(235, 300, ad));
    }
    v = { h, s: p.s, d: p.d };
    this.cache.set(key, v);
    return v;
  }

  update(px, pz, sMin, sMax) {
    const gx0 = Math.round(px / FCELL), gz0 = Math.round(pz / FCELL);
    const moved = gx0 !== this.cx || gz0 !== this.cz;
    const rangeChanged = Math.abs(sMin - this.lastRange[0]) > 1 || Math.abs(sMax - this.lastRange[1]) > 1;
    if (!moved && !rangeChanged) return;
    this.lastRange = [sMin, sMax];
    const half = (FN - 1) / 2;
    const pos = this.geo.attributes.position.array, nor = this.geo.attributes.normal.array, col = this.geo.attributes.color.array;
    if (moved) {
      this.cx = gx0; this.cz = gz0;
      const verts = new Array(FN * FN);
      for (let j = 0; j < FN; j++)
        for (let i = 0; i < FN; i++) verts[j * FN + i] = this._vertex(gx0 - half + i, gz0 - half + j);
      this.verts = verts;
      for (let j = 0; j < FN; j++) {
        for (let i = 0; i < FN; i++) {
          const k = j * FN + i;
          const v = verts[k];
          const x = (gx0 - half + i) * FCELL, z = (gz0 - half + j) * FCELL;
          pos[k * 3] = x; pos[k * 3 + 1] = v.h; pos[k * 3 + 2] = z;
          const hl = verts[j * FN + Math.max(0, i - 1)].h, hr = verts[j * FN + Math.min(FN - 1, i + 1)].h;
          const hu = verts[Math.max(0, j - 1) * FN + i].h, hd = verts[Math.min(FN - 1, j + 1) * FN + i].h;
          const dx = (Math.min(FN - 1, i + 1) - Math.max(0, i - 1)) * FCELL, dz = (Math.min(FN - 1, j + 1) - Math.max(0, j - 1)) * FCELL;
          let nx = -(hr - hl) / dx, nz = -(hd - hu) / dz, ny = 1;
          const nl = Math.hypot(nx, ny, nz);
          nx /= nl; ny /= nl; nz /= nl;
          nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
          terrainColor(this.c3, v.s, v.d, v.h, ny, getZone(v.s, this.zone));
          col[k * 3] = this.c3[0]; col[k * 3 + 1] = this.c3[1]; col[k * 3 + 2] = this.c3[2];
        }
      }
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.normal.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      // 清理缓存
      if (this.cache.size > FN * FN * 3) {
        // 只保留当前窗口内的顶点
        this.cache.clear();
        for (let j = 0; j < FN; j++)
          for (let i = 0; i < FN; i++) this.cache.set((gx0 - half + i) * 65537 + (gz0 - half + j), this.verts[j * FN + i]);
      }
    }
    // 索引:跳过完全落在带状地形内的单元
    const idx = this.index;
    let n = 0;
    const lo = sMin + 24, hi = sMax - 24;
    const verts = this.verts;
    for (let j = 0; j < FN - 1; j++) {
      for (let i = 0; i < FN - 1; i++) {
        const a = verts[j * FN + i], b = verts[j * FN + i + 1], c = verts[(j + 1) * FN + i], d = verts[(j + 1) * FN + i + 1];
        let inside = true;
        for (const q of [a, b, c, d]) {
          if (!(q.s > lo && q.s < hi && q.d > -246 && q.d < 428)) { inside = false; break; }
        }
        if (inside) continue;
        const k = j * FN + i;
        idx[n++] = k; idx[n++] = k + FN; idx[n++] = k + 1;
        idx[n++] = k + 1; idx[n++] = k + FN; idx[n++] = k + FN + 1;
      }
    }
    this.geo.setDrawRange(0, n);
    this.geo.index.needsUpdate = true;
  }
}
