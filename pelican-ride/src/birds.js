// 飞行中的褐鹈鹕群与海鸥
import * as THREE from 'three';
import { extend } from './sky.js';
import { loft, merge } from './geom.js';
import { sampleRoute, getZone, makeZone, terrainHeight, L } from './route.js';
import { hex, clamp, damp, lerp, smoothstep, mulberry32 } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const zT = makeZone();

function colorize(g, fn) {
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = fn(p.getX(i), p.getY(i), p.getZ(i), i);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// 翅膀平面形(沿 +x 伸展, z 为弦向, 前缘 z>0),分内外两段
function wingShapes(scale) {
  const inner = new THREE.Shape();
  inner.moveTo(0, 0.12);
  inner.lineTo(0.55, 0.14);
  inner.lineTo(0.55, -0.2);
  inner.lineTo(0.4, -0.22);
  inner.lineTo(0.25, -0.18);
  inner.lineTo(0, -0.15);
  inner.closePath();
  const outer = new THREE.Shape();
  outer.moveTo(0, 0.14);
  outer.lineTo(0.45, 0.08);
  outer.lineTo(0.63, -0.05);
  outer.lineTo(0.56, -0.25);
  outer.lineTo(0.45, -0.19);
  outer.lineTo(0.37, -0.3);
  outer.lineTo(0.25, -0.2);
  outer.lineTo(0.15, -0.28);
  outer.lineTo(0, -0.2);
  outer.closePath();
  const mk = (sh, x0, c0, c1) => {
    const g = new THREE.ShapeGeometry(sh);
    g.rotateX(-Math.PI / 2); // XY -> XZ (法线朝上)
    g.scale(scale, scale, scale);
    colorize(g, (x, y, z) => {
      const t = clamp(x / scale / 0.65, 0, 1);
      const trail = smoothstep(0.0, -0.3, z / scale);
      return mixc(mixc(c0, c1, t), [c1[0] * 0.5, c1[1] * 0.5, c1[2] * 0.5], trail * 0.4 + (x0 > 0 ? t * 0.3 : 0));
    });
    return g;
  };
  return { mk, inner, outer };
}

function makeBird(kind) {
  const peli = kind === 'pelican';
  const sc = peli ? 1 : 0.42;
  const g = new THREE.Group();
  const flap = new THREE.Group(); // 整体上下
  g.add(flap);
  const C = peli
    ? { body: hex(0x7a6a58), belly: hex(0x4b3d31), head: hex(0xf3ecd8), neck: hex(0xf1eadb), wing: hex(0x8d7e6c), tip: hex(0x241c16), bill: hex(0xa59a84) }
    : { body: hex(0xf2f2ee), belly: hex(0xffffff), head: hex(0xffffff), neck: hex(0xffffff), wing: hex(0xb7bcc2), tip: hex(0x16181a), bill: hex(0xe8b02a) };
  const mat = extend(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide, envMapIntensity: 0.9 }), { key: 'ext-default' });
  // 躯干
  const body = loft([V(0, 0, -0.38 * sc), V(0, 0.01 * sc, -0.12 * sc), V(0, 0.015 * sc, 0.14 * sc), V(0, 0.03 * sc, 0.3 * sc)], {
    segs: 16, radial: 12,
    radiusFn: (t) => { const q = Math.sqrt(Math.max(0, 1 - (2 * Math.pow(t, 0.9) - 1) ** 2)); return [0.115 * sc * q, 0.105 * sc * q]; },
    colorFn: (t, th, n) => mixc(C.belly, C.body, smoothstep(-0.3, 0.7, n[1])),
  });
  flap.add(new THREE.Mesh(body, mat));
  // 脖子+头+喙
  const neck = loft(peli ? [V(0, 0.03, 0.26), V(0, 0.09, 0.3), V(0, 0.12, 0.38)] : [V(0, 0.03 * sc, 0.26 * sc), V(0, 0.06 * sc, 0.33 * sc), V(0, 0.07 * sc, 0.4 * sc)], {
    segs: 8, radial: 10, radiusFn: (t) => [0.05 * sc, 0.05 * sc], colorFn: () => C.neck,
  });
  flap.add(new THREE.Mesh(neck, mat));
  const head = new THREE.SphereGeometry(0.052 * sc, 12, 10);
  head.scale(0.95, 1, 1.2);
  head.translate(0, (peli ? 0.125 : 0.07 * sc), (peli ? 0.4 : 0.4 * sc));
  colorize(head, (x, y) => mixc(C.head, peli ? hex(0xf0cf62) : C.head, smoothstep(0.1, 0.16, y) * (peli ? 1 : 0)));
  flap.add(new THREE.Mesh(head, mat));
  const bill = loft(peli ? [V(0, 0.12, 0.43), V(0, 0.1, 0.55), V(0, 0.07, 0.66), V(0, 0.045, 0.71)] : [V(0, 0.07 * sc, 0.43 * sc), V(0, 0.065 * sc, 0.5 * sc), V(0, 0.055 * sc, 0.56 * sc)], {
    segs: 10, radial: 8,
    radiusFn: (t) => (peli ? [0.027 * (1 - 0.7 * t) + 0.004, 0.02 * (1 - 0.6 * t) + 0.004] : [0.012 * sc * 2.2 * (1 - 0.6 * t), 0.01 * sc * 2.2 * (1 - 0.5 * t)]),
    colorFn: (t) => mixc(C.bill, peli ? hex(0xcf6c2a) : hex(0xd8402a), smoothstep(0.82, 1, t)),
  });
  flap.add(new THREE.Mesh(bill, mat));
  if (peli) {
    const pouch = loft([V(0, 0.105, 0.43), V(0, 0.07, 0.55), V(0, 0.035, 0.66), V(0, 0.03, 0.7)], {
      segs: 10, radial: 8, radiusFn: (t) => [0.02 + 0.02 * Math.sin(Math.PI * t), 0.012 + 0.03 * Math.sin(Math.PI * t)], colorFn: () => hex(0x625a48),
    });
    flap.add(new THREE.Mesh(pouch, mat));
  }
  // 尾
  const tail = new THREE.Shape();
  tail.moveTo(-0.07 * sc, 0); tail.lineTo(0.07 * sc, 0); tail.lineTo(0.06 * sc, -0.2 * sc); tail.lineTo(0, -0.24 * sc); tail.lineTo(-0.06 * sc, -0.2 * sc);
  const tg = new THREE.ShapeGeometry(tail);
  tg.rotateX(-Math.PI / 2).translate(0, 0, -0.34 * sc);
  colorize(tg, () => C.tip);
  flap.add(new THREE.Mesh(tg, mat));
  // 翅膀
  const W = wingShapes(sc * (peli ? 1.0 : 1.0));
  g.wings = [];
  for (const sgn of [1, -1]) {
    const root = new THREE.Group();
    root.position.set(sgn * 0.08 * sc, 0.045 * sc, 0.1 * sc);
    const inn = new THREE.Mesh(W.mk(W.inner, 0, C.wing, C.wing), mat);
    const elbow = new THREE.Group();
    elbow.position.set(0.55 * sc, 0, 0);
    const out = new THREE.Mesh(W.mk(W.outer, 1, C.wing, C.tip), mat);
    elbow.add(out);
    root.add(inn, elbow);
    // 右翼沿 +x,左翼镜像
    const holder = new THREE.Group();
    holder.add(root);
    holder.scale.x = sgn;
    root.position.x = 0.08 * sc;
    flap.add(holder);
    g.wings.push({ root, elbow, sgn });
  }
  g.flapGroup = flap;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = peli; o.receiveShadow = false; } });
  return g;
}

export class Birds {
  constructor(scene) {
    this.scene = scene;
    this.pelicans = [];
    this.gulls = [];
    const rnd = mulberry32(77);
    for (let i = 0; i < 7; i++) {
      const b = makeBird('pelican');
      b.scale.setScalar(0.9 + rnd() * 0.15);
      b.phase = rnd() * 6.28;
      b.userData.slot = i;
      scene.add(b);
      this.pelicans.push(b);
    }
    for (let i = 0; i < 9; i++) {
      const b = makeBird('gull');
      b.scale.setScalar(1.8 + rnd() * 0.5);
      b.phase = rnd() * 6.28;
      b.userData.c = { a0: rnd() * 6.28, r: 14 + rnd() * 28, ds: (rnd() - 0.5) * 220, dd: 20 + rnd() * 140, y: 10 + rnd() * 24, w: 0.2 + rnd() * 0.25 };
      scene.add(b);
      this.gulls.push(b);
    }
    this.flockS = 0;
    this.time = 0;
    this.init = false;
    this._v = new THREE.Vector3();
  }

  groundY(s, d) {
    return Math.max(0, terrainHeight(s, d, getZone(s, zT), false));
  }

  // 翅膀拍打: amp 拍打幅度, ph 相位, lift 滑翔时的上反角
  _pose(b, ph, amp, lift) {
    const a = Math.sin(ph) * amp + lift;
    const e = Math.sin(ph - 0.9) * amp * 0.7 + lift * 0.5;
    for (const w of b.wings) {
      w.root.rotation.z = a;
      w.elbow.rotation.z = e;
      w.root.rotation.y = -0.05 * Math.sin(ph);
    }
    b.flapGroup.position.y = -Math.sin(ph) * amp * 0.06;
  }

  update(dt, s, t, frame) {
    this.time += dt;
    const T = this.time;
    const speed = frame && frame.speed || 0;
    if (!this.init) { this.flockS = s + 30; this.init = true; }
    // 鹈鹕群追逐目标
    const target = s + 28 + 24 * Math.sin(T * 0.08);
    const v = clamp(speed * 1.0 + (target - this.flockS) * 0.4, 5, 18);
    this.flockS += v * dt;
    if (Math.abs(this.flockS - target) > 500) this.flockS = target;
    const lat = 46 + 14 * Math.sin(T * 0.05 + 1.0);
    const alt = 7 + 3 * Math.sin(T * 0.09);
    const vv = new THREE.Vector3();
    this.pelicans.forEach((b, i) => {
      // V 字队形: 队长在前,两翼向后展开
      const rank = Math.ceil(i / 2), side = i === 0 ? 0 : i % 2 ? 1 : -1;
      const sPos = this.flockS - rank * 7.5;
      const dPos = lat + side * rank * 6 + 2 * Math.sin(T * 0.3 + i);
      const r = sampleRoute(clamp(sPos, 0, L - 1));
      const x = r.x - r.cosp * dPos, z = r.z + r.sinp * dPos;
      const wave = 0.5 * Math.sin(T * 0.9 + i * 1.3 + sPos * 0.05);
      const y = this.groundY(sPos, dPos) + alt + wave + (i === 0 ? 1.5 : rank * 0.3 * Math.sin(T * 0.4 + i));
      b.position.set(x, y, z);
      // 朝向:沿路线前进,并轻微随个体摆动
      const yaw = r.phi + 0.06 * Math.sin(T * 0.4 + i);
      b.rotation.set(0.05 * Math.sin(T * 0.7 + i), yaw, -0.08 * Math.sin(T * 0.5 + i * 2), 'YXZ');
      // 拍打几次、滑翔几次
      const cyc = (T * 0.22 + b.phase / 6.28 * 0.7 + rank * 0.05) % 1;
      const flapping = smoothstep(0.5, 0.58, cyc) * (1 - smoothstep(0.88, 0.96, cyc));
      b.flapPhase = (b.flapPhase || 0) + dt * (5.2 + 1.2 * Math.sin(i));
      this._pose(b, b.flapPhase + b.phase, 0.62 * flapping + 0.06, 0.12 * (1 - flapping) + 0.02);
    });
    // 海鸥盘旋
    this.gulls.forEach((b, i) => {
      const c = b.userData.c;
      const a = c.a0 + T * c.w;
      const sC = s + c.ds, dC = c.dd;
      const ss = sC + Math.cos(a) * c.r * 1.2, dd = dC + Math.sin(a) * c.r;
      const r = sampleRoute(clamp(ss, 0, L - 1));
      const x = r.x - r.cosp * dd, z = r.z + r.sinp * dd;
      const y = this.groundY(ss, dd) + c.y + 3 * Math.sin(T * 0.7 + i);
      b.position.set(x, y, z);
      // 切线方向
      const tx = -Math.sin(a) * c.r * 1.2, tz = Math.cos(a) * c.r;
      // (ds, dd) -> 世界方向
      const wx = r.sinp * tx - r.cosp * tz, wz = r.cosp * tx + r.sinp * tz;
      b.rotation.set(0, Math.atan2(wx, wz), -0.35 * Math.sign(c.w), 'YXZ');
      b.flapPhase = (b.flapPhase || 0) + dt * (8 + 2 * Math.sin(i));
      const gl = smoothstep(0.2, 0.6, 0.5 + 0.5 * Math.sin(T * 0.3 + i * 2));
      this._pose(b, b.flapPhase, 0.5 * (1 - gl) + 0.05, 0.08);
    });
  }
}
