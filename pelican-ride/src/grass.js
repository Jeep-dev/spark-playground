// 路边草丛:近处实例化草簇(带风摆),距离渐隐,分帧生成
import * as THREE from 'three';
import { extend } from './sky.js';
import { getZone, makeZone, terrainHeight, sampleRoute, L } from './route.js';
import { mulberry32, noise2, clamp, lerp, hex, mix3 } from './util.js';

const SEG = 24;
const BACK = 2, AHEAD = 8;
const CAP = 22000;

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  const rnd = mulberry32(11);
  for (let i = 0; i < 26; i++) {
    const x0 = 64 + (rnd() - 0.5) * 70;
    const lean = (rnd() - 0.5) * 70;
    const h = 60 + rnd() * 62;
    const w = 2.2 + rnd() * 2.2;
    const grad = g.createLinearGradient(0, 128, 0, 128 - h);
    const dark = 120 + Math.floor(rnd() * 40);
    grad.addColorStop(0, `rgb(${dark - 50},${dark - 50},${dark - 50})`);
    grad.addColorStop(1, `rgb(255,255,255)`);
    g.strokeStyle = grad;
    g.lineCap = 'round';
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, 128);
    g.quadraticCurveTo(x0 + lean * 0.3, 128 - h * 0.55, x0 + lean, 128 - h);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function tuftGeometry() {
  const pos = [], uv = [], nrm = [], idx = [];
  for (let k = 0; k < 2; k++) {
    const a = (k * Math.PI) / 2 + 0.4;
    const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5;
    const b = pos.length / 3;
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, 0.85, dz, -dx, 0.85, -dz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) nrm.push(0, 1, 0); // 朝上的法线,避免侧面发黑
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class Grass {
  constructor(scene) {
    this.density = 0.8;
    const mat = extend(
      new THREE.MeshStandardMaterial({ map: grassTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, metalness: 0 }),
      {
        key: 'grass',
        vsAfterBegin: `
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float fade = 1.0 - smoothstep(95.0, 165.0, length(ip - cameraPosition));
          float hh = position.y;
          transformed.x += sin(uTime * 1.9 + ip.x * 0.7 + ip.z * 0.4) * 0.12 * hh * hh;
          transformed.z += cos(uTime * 1.6 + ip.z * 0.6) * 0.08 * hh * hh;
          transformed *= fade;`,
      }
    );
    this.mesh = new THREE.InstancedMesh(tuftGeometry(), mat, CAP);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    scene.add(this.mesh);
    this.cache = new Map();
    this.queue = [];
    this.seg0 = -999;
    this.dirty = false;
    this.zone = makeZone();
    this.gold = hex(0xb79a52); this.gold2 = hex(0x9a8442); this.green = hex(0x6f8f3e); this.green2 = hex(0x4c6e30);
  }

  setDensity(d) { this.density = d; this.cache.clear(); this.seg0 = -999; }

  _gen(k) {
    const rnd = mulberry32(k * 2654435761 + 17);
    const z = this.zone;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), e = new THREE.Euler();
    const mat = [], col = [];
    const n = Math.round(1700 * this.density);
    const c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const s = k * SEG + rnd() * SEG;
      if (s < 0 || s > L) continue;
      getZone(s, z);
      const u = rnd();
      let d;
      if (u < 0.5) d = (rnd() < 0.5 ? -1 : 1) * (5.9 + Math.pow(rnd(), 1.5) * 20);
      else if (u < 0.78) d = -(5.9 + Math.pow(rnd(), 1.2) * 38);
      else d = 5.9 + rnd() * Math.min(z.edge - 5.9, 40);
      if (d > z.edge * 0.95 && d > 14) continue;
      const h = terrainHeight(s, d, z, true);
      if (h < 1.6) continue;
      const r = sampleRoute(s);
      const x = r.x - r.cosp * d, zz = r.z + r.sinp * d;
      const sc0 = 0.55 + rnd() * 0.85;
      sc.set(sc0 * (0.8 + rnd() * 0.5), sc0, sc0 * (0.8 + rnd() * 0.5));
      e.set(0, rnd() * Math.PI * 2, 0);
      q.setFromEuler(e);
      p.set(x, h - 0.04, zz);
      m.compose(p, q, sc);
      mat.push(...m.elements);
      const g = clamp(z.green + (noise2(s * 0.03, d * 0.03, 77) - 0.5) * 1.1 + (rnd() - 0.5) * 0.25, 0, 1);
      mix3(this.gold, this.gold2, rnd(), c1);
      mix3(this.green, this.green2, rnd(), c2);
      mix3(c1, c2, g, c3);
      const v = 0.8 + rnd() * 0.45;
      col.push(c3[0] * v, c3[1] * v, c3[2] * v);
    }
    return { m: new Float32Array(mat), c: new Float32Array(col), n: mat.length / 16 };
  }

  update(s, force) {
    const k0 = Math.floor(s / SEG);
    if (force || k0 !== this.seg0) {
      this.seg0 = k0;
      const lo = k0 - BACK, hi = k0 + AHEAD;
      for (const key of [...this.cache.keys()]) if (key < lo - 1 || key > hi + 1) this.cache.delete(key);
      this.queue = [];
      for (let k = lo; k <= hi; k++) if (k >= 0 && k * SEG <= L && !this.cache.has(k)) this.queue.push(k);
      if (force) { // 传送/开场:一次生成完
        for (const k of this.queue) this.cache.set(k, this._gen(k));
        this.queue = [];
      }
      this.dirty = true;
    }
    if (this.queue.length) {
      const k = this.queue.shift();
      this.cache.set(k, this._gen(k));
      this.dirty = true;
    }
    if (this.dirty && !this.queue.length) {
      this.dirty = false;
      const arr = this.mesh.instanceMatrix.array, col = this.mesh.instanceColor.array;
      let n = 0;
      for (const [, e] of this.cache) {
        const take = Math.min(e.n, CAP - n);
        arr.set(e.m.subarray(0, take * 16), n * 16);
        col.set(e.c.subarray(0, take * 3), n * 3);
        n += take;
      }
      this.mesh.count = n;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}
