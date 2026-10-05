// 沿路植被与岩石:InstancedMesh + 分段确定性散布
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { extend } from './sky.js';
import { makePalmFrond } from './textures.js';
import { getZone, makeZone, terrainHeight, toWorld, sampleRoute, LANDMARKS, L } from './route.js';
import { mulberry32, noise2, smoothstep, hex, clamp } from './util.js';

const SEG = 80;
const AHEAD_SEGS = 18;
const BACK_SEGS = 2;

// ------------------------------------------------------------------ 几何构造
function paint(g, fn) {
  const p = g.attributes.position, n = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = fn(p.getX(i), p.getY(i), p.getZ(i), n ? n.getY(i) : 0, i);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function blob(rx, ry, rz, x, y, z, base, hi, seed, detail = 1, amp = 0.28) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const nrm = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    let vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const l = Math.hypot(vx, vy, vz);
    const ux = vx / l, uy = vy / l, uz = vz / l;
    const n = noise2(ux * 2.1 + seed, uy * 2.1 + uz * 1.3 + seed * 0.7, 3) - 0.5;
    const r = 1 + n * amp * 2;
    p.setXYZ(i, ux * r * rx + x, uy * r * ry + y, uz * r * rz + z);
    nrm[i * 3] = ux / rx; nrm[i * 3 + 1] = uy / ry; nrm[i * 3 + 2] = uz / rz;
    const nl = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    nrm[i * 3] /= nl; nrm[i * 3 + 1] /= nl; nrm[i * 3 + 2] /= nl;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  paint(g, (vx, vy, vz, ny, i) => {
    const t = clamp((vy - (y - ry)) / (2 * ry), 0, 1);
    const k = 0.62 + 0.55 * t;
    const nn = 0.9 + 0.2 * noise2(vx * 3 + seed, vz * 3, 5);
    return [(base[0] * (1 - t) + hi[0] * t) * k * nn, (base[1] * (1 - t) + hi[1] * t) * k * nn, (base[2] * (1 - t) + hi[2] * t) * k * nn];
  });
  return g;
}

function trunkGeo(pts, r0, r1, col, seg = 7) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, 10, 1, seg, false);
  const p = g.attributes.position, n = g.attributes.normal;
  // 手动做锥度: 使用管法线从中心线推出半径
  const tubular = 10, radial = seg;
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular, c = curve.getPointAt(t), r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      const nx = n.getX(k), ny = n.getY(k), nz = n.getZ(k);
      p.setXYZ(k, c.x + nx * r, c.y + ny * r, c.z + nz * r);
    }
  }
  paint(g, (x, y, z) => [col[0] * (0.85 + 0.3 * noise2(x * 4, y * 3, 9)), col[1] * (0.85 + 0.3 * noise2(x * 4, y * 3, 9)), col[2] * (0.85 + 0.3 * noise2(x * 4, y * 3, 9))]);
  return g.toNonIndexed();
}

function coneGeo(r, h, y, seg, base, hi, rot = 0, rag = 0) {
  const g = new THREE.ConeGeometry(r, h, seg, 2, true);
  g.rotateY(rot);
  g.translate(0, y + h / 2, 0);
  const p = g.attributes.position;
  const nrm = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), yy = p.getY(i), z = p.getZ(i);
    const rho = Math.hypot(x, z);
    if (rag > 0 && rho > 0.01) {
      const a = Math.atan2(z, x);
      const k = 1 + rag * (noise2(a * 2.4 + y, y * 0.7, 6) - 0.5) * 2 * (rho / r);
      x *= k; z *= k;
      p.setXYZ(i, x, yy - rag * 0.5 * (rho / r) * (noise2(a * 3.1, y, 7)), z);
    }
    const nl = Math.hypot(x, 0.62 * Math.max(rho, 0.2) + 0.15, z) || 1;
    nrm[i * 3] = x / nl; nrm[i * 3 + 1] = (0.62 * Math.max(rho, 0.2) + 0.15) / nl; nrm[i * 3 + 2] = z / nl;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  paint(g, (x, yy) => {
    const t = clamp((yy - y) / h, 0, 1);
    const k = 0.7 + 0.5 * t;
    return [(base[0] * (1 - t) + hi[0] * t) * k, (base[1] * (1 - t) + hi[1] * t) * k, (base[2] * (1 - t) + hi[2] * t) * k];
  });
  return g.toNonIndexed();
}

function build(list) {
  const out = mergeGeometries(list.map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    ['uv'].forEach((a) => { if (!x.attributes[a]) x.setAttribute(a, new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2)); });
    return x;
  }), false);
  return out;
}

const Cs = {
  cyp: hex(0x24472a), cypHi: hex(0x4f7a3a),
  pine: hex(0x1e4126), pineHi: hex(0x3d6c3a),
  oak: hex(0x38572a), oakHi: hex(0x68893a),
  shrub: hex(0x4a5a2c), shrubHi: hex(0x8a8a46),
  sage: hex(0x5d6d4a), sageHi: hex(0xa4a67c),
  trunk: hex(0x3a2c20), redwood: hex(0x4e2e20), palmTrunk: hex(0x7d6a4e),
  rock: hex(0x5a5148), rockHi: hex(0x8a8070),
};

function makeCypress() {
  const parts = [];
  parts.push(trunkGeo([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.5, 2.5, 0), new THREE.Vector3(1.4, 5.2, 0.2), new THREE.Vector3(2.4, 7, 0)], 0.42, 0.18, Cs.trunk, 6));
  parts.push(trunkGeo([new THREE.Vector3(0.6, 3, 0), new THREE.Vector3(-0.8, 5, 0.6), new THREE.Vector3(-1.8, 6.4, 0.9)], 0.18, 0.08, Cs.trunk, 5));
  const lumps = [
    [2.6, 7.4, 0, 3.6, 1.8, 3.2], [-0.8, 6.9, 0.8, 3.0, 1.6, 2.8], [4.2, 7.0, -0.6, 2.8, 1.5, 2.4],
    [1.2, 8.7, 0.3, 2.6, 1.5, 2.4], [-2.6, 6.3, -0.2, 2.2, 1.3, 2.0], [3.0, 8.4, 0.8, 2.0, 1.2, 1.8],
  ];
  lumps.forEach((l, i) => parts.push(blob(l[3], l[4], l[5], l[0], l[1], l[2], Cs.cyp, Cs.cypHi, i * 3.1, 1, 0.3)));
  return build(parts);
}
function makeConifer() {
  const parts = [trunkGeo([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 12, 0), new THREE.Vector3(0.1, 26, 0)], 0.62, 0.12, Cs.redwood, 7)];
  const tiers = 11;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = 4.6 + t * 20;
    const r = 4.3 * (1 - t * 0.8) + 0.45;
    parts.push(coneGeo(r, 5.0 - t * 1.5, y, 12, Cs.pine, Cs.pineHi, i * 0.7, 0.22));
  }
  return build(parts);
}
function makeOak() {
  const parts = [];
  parts.push(trunkGeo([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.2, 1.6, 0), new THREE.Vector3(0, 3, 0.1)], 0.45, 0.28, Cs.trunk, 6));
  parts.push(trunkGeo([new THREE.Vector3(0, 2, 0), new THREE.Vector3(1.4, 3.4, 0.4), new THREE.Vector3(2.4, 4.0, 0.2)], 0.2, 0.1, Cs.trunk, 5));
  parts.push(trunkGeo([new THREE.Vector3(0, 2, 0), new THREE.Vector3(-1.4, 3.3, -0.4), new THREE.Vector3(-2.3, 3.9, -0.2)], 0.2, 0.1, Cs.trunk, 5));
  const lumps = [[0, 5, 0, 3.4, 2.4, 3.4], [2.6, 4.4, 0.4, 2.4, 1.7, 2.3], [-2.5, 4.3, -0.3, 2.4, 1.7, 2.3], [0.4, 6.4, 0.6, 2.2, 1.5, 2.2], [0.5, 4.2, 2.4, 2.0, 1.5, 2.0], [-0.6, 4.3, -2.4, 2.0, 1.5, 2.0]];
  lumps.forEach((l, i) => parts.push(blob(l[3], l[4], l[5], l[0], l[1], l[2], Cs.oak, Cs.oakHi, i * 2.3 + 1, 1, 0.26)));
  return build(parts);
}
function makeShrub() {
  const parts = [];
  parts.push(blob(1.1, 0.8, 1.0, 0, 0.55, 0, Cs.shrub, Cs.shrubHi, 1, 0, 0.3));
  parts.push(blob(0.8, 0.6, 0.8, 0.9, 0.4, 0.3, Cs.sage, Cs.sageHi, 2, 0, 0.3));
  parts.push(blob(0.7, 0.55, 0.7, -0.7, 0.4, -0.4, Cs.shrub, Cs.sageHi, 3, 0, 0.3));
  return build(parts);
}
function makeIce() {
  const parts = [];
  parts.push(blob(1.5, 0.35, 1.5, 0, 0.2, 0, hex(0x4f7a3a), hex(0x8a7a3a), 4, 1, 0.22));
  const rnd = mulberry32(5);
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 1.2;
    const f = blob(0.13, 0.05, 0.13, Math.cos(a) * r, 0.5 + rnd() * 0.05, Math.sin(a) * r, hex(0xd4278f), hex(0xff6fc0), i, 0, 0.1);
    parts.push(f);
  }
  return build(parts);
}
function makeRock() {
  const parts = [];
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const l = Math.hypot(x, y, z);
    const n = noise2(x / l * 2 + 7, y / l * 2 + z / l * 1.4, 4);
    const r = 0.75 + n * 0.55;
    p.setXYZ(i, (x / l) * r * 1.2, (y / l) * r * 0.78, (z / l) * r);
  }
  g.computeVertexNormals();
  paint(g, (x, y, z) => {
    const t = clamp(y * 0.6 + 0.5, 0, 1);
    const n = 0.8 + 0.4 * noise2(x * 4, z * 4, 8);
    return [(Cs.rock[0] * (1 - t) + Cs.rockHi[0] * t) * n, (Cs.rock[1] * (1 - t) + Cs.rockHi[1] * t) * n, (Cs.rock[2] * (1 - t) + Cs.rockHi[2] * t) * n];
  });
  g.translate(0, 0.35, 0);
  parts.push(g);
  return build(parts);
}
function makePalmTrunk() {
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.25, 4, 0.1), new THREE.Vector3(0.1, 8.5, -0.1), new THREE.Vector3(0.4, 13, 0.1)];
  const t = trunkGeo(pts, 0.34, 0.22, Cs.palmTrunk, 8);
  // 枯叶裙:冠下方一圈下垂的枯叶,上粗下细
  const sk = new THREE.CylinderGeometry(0.55, 0.36, 1.5, 10, 3, true);
  const p = sk.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const k = 1 + 0.18 * (noise2(a * 2.2, p.getY(i) * 0.9, 8) - 0.5) * 2;
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  sk.translate(0.38, 12.3, 0.1);
  paint(sk, (x, y) => { const v = 0.8 + 0.4 * noise2(x * 5, y * 3, 3); return [hex(0x6a5330)[0] * v, hex(0x6a5330)[1] * v, hex(0x6a5330)[2] * v]; });
  return build([t, sk.toNonIndexed()]);
}
function makePalmCrown() {
  const rnd = mulberry32(31);
  const pos = [], uv = [], nrm = [], idx = [];
  const cx = 0.4, cy = 13.0, cz = 0.1;
  const NF = 16, SEGS = 7;
  for (let f = 0; f < NF; f++) {
    const a = (f / NF) * Math.PI * 2 + rnd() * 0.3;
    const len = 3.8 + rnd() * 1.4;
    const lift = 0.7 + rnd() * 0.9;
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const sx = -dirz, sz = dirx;
    const base = pos.length / 3;
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const r = len * t;
      const y = cy + lift * 2.4 * Math.sin(Math.PI * 0.5 * t) - 3.4 * t * t * (0.8 + 0.3 * f / NF);
      const w = 1.25 * (1 - 0.35 * t) * (0.25 + Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)));
      for (const sgn of [-1, 1]) {
        pos.push(cx + dirx * r + sx * w * sgn, y, cz + dirz * r + sz * w * sgn);
        uv.push(t, sgn < 0 ? 0 : 1);
        nrm.push(0, 1, 0);
      }
    }
    for (let i = 0; i < SEGS; i++) {
      const a0 = base + i * 2;
      idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ 物种定义
// density: 每 80m 路段的基础数量(乘以 zone.veg[idx] 与质量系数)
const SPECIES = [
  { id: 'cypress', vi: 0, base: 5, cap: 500, near: 90, inland: 120, sea: true, maxSlope: 0.55, s0: 0.8, s1: 1.5, cast: true, dMin: 9, make: makeCypress },
  { id: 'conifer', vi: 1, base: 24, cap: 1500, near: 220, inland: 160, sea: false, maxSlope: 0.9, s0: 0.8, s1: 1.5, cast: true, dMin: 9, make: makeConifer, cluster: true },
  { id: 'oak', vi: 2, base: 7, cap: 600, near: 100, inland: 130, sea: true, maxSlope: 0.5, s0: 0.8, s1: 1.4, cast: true, dMin: 10, make: makeOak },
  { id: 'palm', vi: 3, base: 7, cap: 700, near: 100, inland: 90, sea: true, maxSlope: 0.3, s0: 0.85, s1: 1.2, cast: true, dMin: 9, make: makePalmTrunk, avenue: true },
  { id: 'shrub', vi: 4, base: 90, cap: 4000, inland: 130, sea: true, maxSlope: 0.75, s0: 0.6, s1: 1.6, cast: false, dMin: 6.3, make: makeShrub, cluster: true },
  { id: 'ice', vi: 5, base: 55, cap: 3000, inland: 40, sea: true, maxSlope: 0.6, s0: 0.7, s1: 1.4, cast: false, dMin: 6.3, make: makeIce, seaOnly: true },
  { id: 'rock', vi: 6, base: 18, cap: 1500, near: 140, inland: 120, sea: true, maxSlope: 3, s0: 0.45, s1: 1.9, cast: true, dMin: 6.5, make: makeRock, rock: true },
];

export class Props {
  constructor(scene) {
    this.scene = scene;
    this.density = 0.8;
    this.cache = new Map();
    this.seg0 = -999;
    this.zone = makeZone();
    this.insts = {};
    const treeMat = () => extend(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.9 }), {
      key: 'tree',
      vsDecl: 'varying vec3 vWPt;',
      fsDecl: `varying vec3 vWPt;
        float h31(vec3 p){ p = fract(p*vec3(.1031,.1030,.0973)); p += dot(p, p.yxz+33.33); return fract((p.x+p.y)*p.z); }
        float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x), mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x), mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y), f.z); }`,
      fsAfterColor: `
        {
          float ln = n3(vWPt * 2.6) * 0.5 + n3(vWPt * 7.5) * 0.3 + n3(vWPt * 19.0) * 0.2;
          diffuseColor.rgb *= 0.55 + 0.95 * ln;
        }`,
      fsAfterLights: 'reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.7 * (1.0 - uNight);',
      vsAfterBegin: `
        {
          vec4 wpt = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wpt = instanceMatrix * wpt;
          #endif
          vWPt = (modelMatrix * wpt).xyz;
        }
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float swW = smoothstep(1.0, 14.0, position.y);
        transformed.x += sin(uTime * 1.25 + ip.x * 0.23 + ip.z * 0.31 + position.y * 0.15) * 0.16 * swW;
        transformed.z += cos(uTime * 1.05 + ip.z * 0.27 + position.y * 0.12) * 0.12 * swW;`,
    });
    this.mat = treeMat();
    for (const sp of SPECIES) {
      const geo = sp.make();
      const mesh = new THREE.InstancedMesh(geo, this.mat, sp.cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(sp.cap * 3), 3);
      scene.add(mesh);
      this.insts[sp.id] = { sp, mesh };
      if (sp.cast) {
        // 只在近处(阴影相机范围内)的实例参与阴影渲染,主渲染中不写颜色/深度
        const cm = this.ghostMat || (this.ghostMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
        const cmesh = new THREE.InstancedMesh(geo, cm, sp.near);
        cmesh.count = 0;
        cmesh.frustumCulled = false;
        cmesh.castShadow = true;
        cmesh.receiveShadow = false;
        cmesh.renderOrder = -10;
        scene.add(cmesh);
        this.insts[sp.id].cast = cmesh;
        if (sp.id === 'palm') this.insts[sp.id].castCrown = true;
      }
    }
    // 棕榈冠(带透明叶)
    const crownMat = extend(new THREE.MeshStandardMaterial({ map: makePalmFrond(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.7, metalness: 0, envMapIntensity: 0.9 }), {
      key: 'palmcrown',
      vsAfterBegin: `
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float swp = smoothstep(11.0, 16.0, position.y);
        transformed.y += sin(uTime * 1.7 + ip.x * 0.3 + position.x * 0.9) * 0.14 * swp * length(position.xz - vec2(0.4, 0.1)) * 0.25;`,
    });
    const crown = new THREE.InstancedMesh(makePalmCrown(), crownMat, 700);
    crown.count = 0; crown.frustumCulled = false; crown.castShadow = false; crown.receiveShadow = true;
    crown.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(700 * 3), 3);
    scene.add(crown);
    this.crown = crown;
    const ghostCrown = new THREE.InstancedMesh(crown.geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide }), 100);
    ghostCrown.count = 0; ghostCrown.frustumCulled = false; ghostCrown.castShadow = true; ghostCrown.renderOrder = -10;
    // 棕榈树冠需要给 alphaTest 叶片提供自定义深度材质,否则阴影是整块方片
    ghostCrown.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: crownMat.map, alphaTest: 0.45 });
    scene.add(ghostCrown);
    this.ghostCrown = ghostCrown;
    this.lastNear = new THREE.Vector3(1e9, 0, 1e9);
  }

  setDensity(d) {
    this.density = d;
    this.cache.clear();
    this.seg0 = -999;
  }

  // 生成一个路段的所有物种实例
  _gen(k) {
    const out = {};
    const z = this.zone;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), eul = new THREE.Euler();
    const xz = { x: 0, z: 0 };
    const sStart = k * SEG;
    for (const sp of SPECIES) {
      const rnd = mulberry32((k * 73856093) ^ (sp.id.charCodeAt(0) * 19349663) ^ (sp.id.charCodeAt(1) * 83492791));
      const zc = getZone(sStart + SEG / 2, z);
      let w = zc.veg[sp.vi];
      const arr = [];
      const cols = [];
      const place = (s, d, scaleMul = 1, yawFixed = null) => {
        if (s < 0 || s > L) return;
        getZone(s, z);
        const dMin = sp.dMin;
        if (Math.abs(d) < dMin) return;
        const h = terrainHeight(s, d, z, true);
        if (h < (sp.rock ? -0.5 : 1.3)) return;
        const h1 = terrainHeight(s + 2, d, z, true), h2 = terrainHeight(s, d + 2, z, true);
        const slope = Math.hypot(h1 - h, h2 - h) / 2;
        if (slope > sp.maxSlope) return;
        // 海侧岩石不要放在悬崖外太远
        const r = sampleRoute(s);
        xz.x = r.x - r.cosp * d; xz.z = r.z + r.sinp * d;
        const scl0 = (sp.s0 + (sp.s1 - sp.s0) * rnd()) * scaleMul;
        scl.set(scl0, scl0 * (0.9 + 0.3 * rnd()), scl0);
        const yaw = yawFixed !== null ? yawFixed : rnd() * Math.PI * 2;
        // 柏树:朝内陆倾斜(风向)
        eul.set((rnd() - 0.5) * 0.06, sp.id === 'cypress' ? r.phi + (rnd() - 0.5) * 0.5 : yaw, (rnd() - 0.5) * 0.06);
        q.setFromEuler(eul);
        pos.set(xz.x, h - 0.25 * scl0, xz.z);
        m.compose(pos, q, scl);
        arr.push(...m.elements);
        const v = 0.82 + 0.34 * rnd(), hue = (rnd() - 0.5) * 0.12;
        cols.push(v * (1 + hue), v, v * (1 - hue));
      };
      if (sp.avenue && w > 0.7) {
        for (let i = 0; i < SEG / 16; i++) {
          for (const side of [-1, 1]) {
            const s = sStart + 8 + i * 16 + (rnd() - 0.5) * 3;
            place(s, side * (10.2 + rnd() * 1.2), 0.95 + 0.25 * rnd());
          }
        }
      }
      const n = Math.round(sp.base * w * this.density * (sp.avenue ? 0.35 : 1));
      for (let i = 0; i < n; i++) {
        const s = sStart + rnd() * SEG;
        const seaward = sp.seaOnly ? true : sp.sea && rnd() < 0.38;
        let d;
        getZone(s, z);
        if (seaward) {
          const reach = z.edge + z.cliffW * (sp.rock ? 1.0 : 0.35);
          d = sp.dMin + 0.5 + rnd() * Math.max(5, reach - sp.dMin);
        } else {
          d = -(sp.dMin + 0.5 + Math.pow(rnd(), 1.5) * sp.inland);
        }
        if (sp.cluster) {
          const nz = noise2(s * 0.012 + 3.3, d * 0.012, 91);
          if (rnd() > smoothstep(0.35, 0.7, nz)) continue;
        }
        place(s, d);
      }
      out[sp.id] = { m: new Float32Array(arr), c: new Float32Array(cols), n: arr.length / 16 };
    }
    return out;
  }

  // 近处实例子集(用于阴影)
  _nearSet(fx, fz) {
    const R2 = 100 * 100;
    for (const sp of SPECIES) {
      const it = this.insts[sp.id];
      if (!it.cast) continue;
      const src = it.mesh.instanceMatrix.array, n = it.mesh.count;
      const dst = it.cast.instanceMatrix.array;
      let c = 0;
      for (let i = 0; i < n && c < sp.near; i++) {
        const dx = src[i * 16 + 12] - fx, dz = src[i * 16 + 14] - fz;
        if (dx * dx + dz * dz < R2) {
          dst.set(src.subarray(i * 16, i * 16 + 16), c * 16);
          if (sp.id === 'palm' && c < 100) this.ghostCrown.instanceMatrix.array.set(src.subarray(i * 16, i * 16 + 16), c * 16);
          c++;
        }
      }
      it.cast.count = c;
      it.cast.instanceMatrix.needsUpdate = true;
      if (sp.id === 'palm') {
        this.ghostCrown.count = Math.min(c, 100);
        this.ghostCrown.instanceMatrix.needsUpdate = true;
      }
    }
  }

  update(s, camPos, dt, force, focus) {
    if (focus && (force || this.seg0 === -999 || Math.abs(focus.x - this.lastNear.x) + Math.abs(focus.z - this.lastNear.z) > 8)) {
      this.lastNear.copy(focus);
      this._pendingNear = true;
    }
    const k0 = Math.floor(s / SEG);
    if (!force && k0 === this.seg0) {
      if (this._pendingNear) { this._nearSet(this.lastNear.x, this.lastNear.z); this._pendingNear = false; }
      return;
    }
    this.seg0 = k0;
    const lo = k0 - BACK_SEGS, hi = k0 + AHEAD_SEGS;
    for (const key of [...this.cache.keys()]) if (key < lo - 2 || key > hi + 2) this.cache.delete(key);
    const t0 = performance.now();
    for (let k = lo; k <= hi; k++) {
      if (k < 0 || k * SEG > L) continue;
      if (!this.cache.has(k)) this.cache.set(k, this._gen(k));
    }
    for (const sp of SPECIES) {
      const inst = this.insts[sp.id].mesh;
      const arr = inst.instanceMatrix.array, col = inst.instanceColor.array;
      let n = 0;
      let nC = 0;
      for (let k = lo; k <= hi; k++) {
        const e = this.cache.get(k);
        if (!e) continue;
        const d = e[sp.id];
        const take = Math.min(d.n, sp.cap - n);
        arr.set(d.m.subarray(0, take * 16), n * 16);
        col.set(d.c.subarray(0, take * 3), n * 3);
        n += take;
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      inst.instanceColor.needsUpdate = true;
      if (sp.id === 'palm') {
        const c = this.crown;
        c.instanceMatrix.array.set(arr.subarray(0, n * 16));
        c.instanceColor.array.set(col.subarray(0, n * 3));
        c.count = n;
        c.instanceMatrix.needsUpdate = true;
        c.instanceColor.needsUpdate = true;
      }
    }
    this.lastGenMs = performance.now() - t0;
    this._nearSet(this.lastNear.x, this.lastNear.z);
    this._pendingNear = false;
  }
}
