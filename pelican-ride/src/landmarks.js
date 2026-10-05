// 沿途地标:金门大桥、鸽子角灯塔、比克斯比溪大桥、圣莫尼卡码头与摩天轮、救生塔
import * as THREE from 'three';
import { extend } from './sky.js';
import { tube, merge, loft } from './geom.js';
import { makeSignTexture } from './textures.js';
import { LANDMARKS, getZone, makeZone, terrainHeight, sampleRoute, L } from './route.js';
import { hex, smoothstep, clamp, mulberry32 } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const zTmp = makeZone();
const hAt = (s, d) => terrainHeight(s, d, getZone(s, zTmp), true);

function mat(p) {
  return extend(new THREE.MeshStandardMaterial(p), { key: 'ext-default' });
}

// 路线局部坐标系: x=左(内陆), z=前进, 原点位于路线 s 处
function frame(scene, s, d = 0) {
  const r = sampleRoute(s);
  const g = new THREE.Group();
  g.position.set(r.x - r.cosp * d, 0, r.z + r.sinp * d);
  g.rotation.y = r.phi;
  scene.add(g);
  return g;
}

function shadows(obj, cast = true, receive = true) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
}

export class Landmarks {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.night = 0;
    this._ggb();
    this._lighthouse();
    this._bixby();
    this._pier();
    this._lifeguards();
    this._signs();
    this.time = 0;
  }

  // ---------------------------------------------------------------- 金门大桥
  _ggb() {
    const B = LANDMARKS.ggb;
    const s0 = B.s0;
    const g = frame(this.scene, s0);
    const deckY = 58;
    const orange = mat({ color: new THREE.Color(...hex(0xc0392b)), roughness: 0.5, metalness: 0.25 });
    const orangeDark = mat({ color: new THREE.Color(...hex(0x9c2f24)), roughness: 0.55, metalness: 0.3 });
    const concrete = mat({ color: new THREE.Color(...hex(0xb7b2a8)), roughness: 0.9 });
    const len = B.s1 - B.s0;
    const t1 = B.t1 - s0, t2 = B.t2 - s0;
    const topY = deckY + 98;

    // 桥面桁架
    const deck = [];
    deck.push(new THREE.BoxGeometry(14.4, 1.3, len + 4).translate(0, deckY - 0.8, len / 2));
    deck.push(new THREE.BoxGeometry(14.8, 0.6, len + 4).translate(0, deckY - 3.8, len / 2));
    const truss = [];
    for (let z = 0; z < len; z += 7) {
      for (const sx of [-1, 1]) {
        const x = sx * 7.1;
        truss.push(tube(V(x, deckY - 3.7, z), V(x, deckY - 0.2, z), 0.12, 0.12, 4));
        truss.push(tube(V(x, deckY - 3.7, z), V(x, deckY - 0.2, z + 7), 0.1, 0.1, 4));
        truss.push(tube(V(x, deckY - 0.2, z), V(x, deckY - 3.7, z + 7), 0.1, 0.1, 4));
      }
    }
    truss.push(tube(V(-7.1, deckY - 0.2, 0), V(-7.1, deckY - 0.2, len), 0.25, 0.25, 6));
    truss.push(tube(V(7.1, deckY - 0.2, 0), V(7.1, deckY - 0.2, len), 0.25, 0.25, 6));
    truss.push(tube(V(-7.1, deckY - 3.7, 0), V(-7.1, deckY - 3.7, len), 0.25, 0.25, 6));
    truss.push(tube(V(7.1, deckY - 3.7, 0), V(7.1, deckY - 3.7, len), 0.25, 0.25, 6));
    // 栏杆
    for (let z = 0; z < len; z += 4) for (const sx of [-1, 1]) truss.push(tube(V(sx * 6.9, deckY + 0.3, z), V(sx * 6.9, deckY + 1.5, z), 0.05, 0.05, 4));
    for (const sx of [-1, 1]) {
      truss.push(tube(V(sx * 6.9, deckY + 1.5, 0), V(sx * 6.9, deckY + 1.5, len), 0.07, 0.07, 4));
      truss.push(tube(V(sx * 6.9, deckY + 0.9, 0), V(sx * 6.9, deckY + 0.9, len), 0.05, 0.05, 4));
    }
    g.add(new THREE.Mesh(merge(deck), orange), new THREE.Mesh(merge(truss), orange));

    // 塔(装饰艺术风格:收分 + 横梁)
    const towerGeo = [];
    const towerCaps = [];
    for (const tz of [t1, t2]) {
      for (const sx of [-1, 1]) {
        const x = sx * 9.6;
        const legs = 5;
        // 分段收分的塔柱
        for (let i = 0; i < legs; i++) {
          const y0 = -10 + (topY + 10) * (i / legs), y1 = -10 + (topY + 10) * ((i + 1) / legs);
          const w0 = 4.2 - 1.4 * (i / legs), w1 = 4.2 - 1.4 * ((i + 1) / legs);
          const d0 = 5.2 - 1.6 * (i / legs), d1 = 5.2 - 1.6 * ((i + 1) / legs);
          const gg = new THREE.CylinderGeometry(1, 1, 1, 4, 1).rotateY(Math.PI / 4);
          // 手工建楔形盒:用 BoxGeometry 近似
          const bx = new THREE.BoxGeometry((w0 + w1) / 2, y1 - y0, (d0 + d1) / 2);
          bx.translate(x, (y0 + y1) / 2, tz);
          towerGeo.push(bx);
        }
        towerCaps.push(new THREE.BoxGeometry(2.4, 3, 3.4).translate(x, topY + 1.5, tz));
      }
      // 横梁 (6 道) + X 撑
      const levels = [deckY + 6, deckY + 22, deckY + 40, deckY + 58, deckY + 76, topY - 3];
      levels.forEach((y, i) => {
        const w = 1.6 + (i === levels.length - 1 ? 0.8 : 0);
        towerGeo.push(new THREE.BoxGeometry(19.2 - (i * 0.6), w, 2.2 - i * 0.12).translate(0, y, tz));
        if (i < levels.length - 1) {
          const y2 = levels[i + 1];
          towerGeo.push(tube(V(-9.6, y, tz), V(9.6, y2, tz), 0.35, 0.35, 5));
          towerGeo.push(tube(V(9.6, y, tz), V(-9.6, y2, tz), 0.35, 0.35, 5));
        }
      });
      // 塔基
      towerGeo.push(new THREE.BoxGeometry(28, 50, 18).translate(0, -22, tz));
    }
    const towers = new THREE.Mesh(merge(towerGeo), orange);
    const caps = new THREE.Mesh(merge(towerCaps), orangeDark);
    const bases = [];
    g.add(towers, caps);
    // 防撞桩/承台(混凝土)
    for (const tz of [t1, t2]) g.add(new THREE.Mesh(new THREE.BoxGeometry(34, 14, 24).translate(0, -3, tz), concrete));

    // 主缆(悬链线近似为抛物线)
    const mainCableY = (z) => {
      if (z < t1) { const u = (t1 - z) / (t1 + 30); return topY - 1.4 - (topY - (deckY + 22)) * (u * u * 0.7 + u * 0.3); }
      if (z > t2) { const u = (z - t2) / (len - t2 + 30); return topY - 1.4 - (topY - (deckY + 22)) * (u * u * 0.7 + u * 0.3); }
      const half = (t2 - t1) / 2, zc = (t1 + t2) / 2;
      const u = (z - zc) / half;
      return deckY + 10 + (topY - 1.4 - deckY - 10) * u * u;
    };
    const cableMats = mat({ color: new THREE.Color(...hex(0xb5382a)), roughness: 0.45, metalness: 0.3 });
    const suspG = [];
    for (const sx of [-1, 1]) {
      const pts = [];
      for (let z = -30; z <= len + 30; z += 10) pts.push(V(sx * 8.9, mainCableY(z), z));
      const curve = new THREE.CatmullRomCurve3(pts);
      const tg = new THREE.TubeGeometry(curve, 160, 0.7, 8, false);
      g.add(new THREE.Mesh(tg, cableMats));
      for (let z = 12; z < len - 12; z += 11) {
        if (Math.abs(z - t1) < 6 || Math.abs(z - t2) < 6) continue;
        const y = mainCableY(z);
        suspG.push(tube(V(sx * 8.9, y, z), V(sx * 7.6, deckY - 0.2, z), 0.09, 0.09, 4));
      }
    }
    g.add(new THREE.Mesh(merge(suspG), cableMats));
    // 锚碇墩
    for (const z of [-26, len + 26]) g.add(new THREE.Mesh(new THREE.BoxGeometry(16, deckY - 6, 18).translate(0, (deckY - 6) / 2, z), concrete));
    // 塔顶航空障碍灯
    this.beacons = [];
    for (const tz of [t1, t2]) for (const sx of [-1, 1]) {
      const m = mat({ color: 0x300000, emissive: 0xff2010, emissiveIntensity: 1.0 });
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8).translate(sx * 9.6, topY + 3.4, tz), m);
      g.add(b);
      this.beacons.push(m);
    }
    shadows(g, true, true);
    this.ggb = g;
    this.items.push({ g, s: (B.s0 + B.s1) / 2, r: 1100 });
  }

  // ---------------------------------------------------------------- 鸽子角灯塔
  _lighthouse() {
    const P = LANDMARKS.pigeon;
    const sBase = P.s;
    const g = frame(this.scene, sBase, P.d);
    const y0 = hAt(sBase, P.d) - 0.4;
    g.position.y = y0;
    const white = mat({ color: 0xeeeae0, roughness: 0.8 });
    const dark = mat({ color: 0x2a2f36, roughness: 0.5, metalness: 0.4 });
    const redroof = mat({ color: new THREE.Color(...hex(0x8c2f2a)), roughness: 0.6, metalness: 0.2 });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 4.6, 24, 8, 1), white);
    tower.position.y = 12;
    g.add(tower);
    // 窗洞
    for (const [y, a] of [[6, 0.6], [12, 2.2], [17, 4]]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.3, 0.3), dark);
      const rr = 4.6 - (2 * y) / 24 * 1.9 + 0.05;
      w.position.set(Math.sin(a) * rr, y, Math.cos(a) * rr);
      w.rotation.y = a;
      g.add(w);
    }
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.7, 0.45, 16), dark);
    gallery.position.y = 24.1;
    g.add(gallery);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.07, 6, 28).rotateX(Math.PI / 2), dark);
    rail.position.y = 25.1;
    g.add(rail);
    // 灯室
    this.lampMat = mat({ color: 0x9fb4c0, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.35, emissive: 0xffd890, emissiveIntensity: 0.0 });
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3.3, 16, 1, true), this.lampMat);
    lamp.position.y = 26;
    lamp.castShadow = false;
    g.add(lamp);
    const frames = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      frames.push(tube(V(Math.sin(a) * 2.2, 24.4, Math.cos(a) * 2.2), V(Math.sin(a) * 2.2, 27.6, Math.cos(a) * 2.2), 0.06, 0.06, 4));
    }
    g.add(new THREE.Mesh(merge(frames), dark));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 2.4, 16), redroof);
    roof.position.y = 28.8;
    g.add(roof);
    g.add(new THREE.Mesh(tube(V(0, 30, 0), V(0, 32.4, 0), 0.07, 0.04, 4), dark));
    // 灯芯与光束
    this.lampCore = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), mat({ color: 0x000000, emissive: 0xfff2c0, emissiveIntensity: 0 }));
    this.lampCore.position.y = 26;
    g.add(this.lampCore);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffeebb, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true });
    const beamG = new THREE.ConeGeometry(26, 900, 16, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 450);
    this.beam = new THREE.Group();
    this.beam.position.y = 26;
    for (const a of [0, Math.PI]) {
      const b = new THREE.Mesh(beamG, beamMat);
      b.rotation.y = a;
      this.beam.add(b);
    }
    g.add(this.beam);
    this.beamMat = beamMat;
    // 看守员房屋
    const house = new THREE.Mesh(new THREE.BoxGeometry(18, 5.5, 7), white);
    house.position.set(-16, 2.75, -2);
    g.add(house);
    const roofH = new THREE.Mesh(new THREE.BoxGeometry(19, 0.7, 8).translate(-16, 5.9, -2), redroof);
    g.add(roofH);
    const house2 = new THREE.Mesh(new THREE.BoxGeometry(8, 4.4, 8), white);
    house2.position.set(-30, 2.2, 7);
    g.add(house2);
    g.add(new THREE.Mesh(new THREE.BoxGeometry(9, 0.6, 9).translate(-30, 4.7, 7), redroof));
    shadows(g, true, true);
    this.lampCore.castShadow = false;
    this.beam.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    this.lighthouse = g;
    this.items.push({ g, s: sBase, r: 2400 });
  }

  // ---------------------------------------------------------------- 比克斯比溪大桥
  _bixby() {
    const B = LANDMARKS.bixby;
    const g = frame(this.scene, B.s);
    const e = getZone(B.s, zTmp).e;
    const concrete = mat({ color: new THREE.Color(...hex(0xb3aa9a)), roughness: 0.92 });
    const concreteDark = mat({ color: new THREE.Color(...hex(0xa8a396)), roughness: 0.95 });
    const half = 58;
    const hs = Math.max(0, hAt(B.s - half, 0));
    const hs2 = Math.max(0, hAt(B.s + half, 0));
    const ySpring = Math.min(hs, hs2) - 2;
    const yCrown = e - 3.2;
    const arch = (z) => yCrown - (yCrown - ySpring) * (z / half) * (z / half);
    // 桥面板 + 护栏
    const deckLen = 2 * 190;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(10.8, 1.4, deckLen).translate(0, e - 0.7, 0), concrete));
    const rails = [];
    for (const sx of [-1, 1]) {
      rails.push(new THREE.BoxGeometry(0.45, 1.0, deckLen).translate(sx * 5.2, e + 0.5, 0));
      for (let z = -deckLen / 2; z <= deckLen / 2; z += 5) rails.push(new THREE.BoxGeometry(0.7, 1.35, 0.7).translate(sx * 5.2, e + 0.7, z));
    }
    g.add(new THREE.Mesh(merge(rails), concrete));
    // 拱肋(两条)
    for (const sx of [-1, 1]) {
      const pts = [];
      for (let z = -half - 4; z <= half + 4; z += 4) pts.push(V(sx * 3.4, arch(Math.max(-half, Math.min(half, z))) + (Math.abs(z) > half ? -(Math.abs(z) - half) * 1.2 : 0), z));
      const rib = loft(pts, {
        segs: 40, radial: 10,
        radiusFn: (t) => { const k = Math.abs(t - 0.5) * 2; return [1.05 + 0.5 * k, 1.5 + 1.3 * k]; },
      });
      g.add(new THREE.Mesh(rib, concrete));
    }
    // 拱上立柱 + 横撑
    const cols = [];
    for (let z = -half + 6; z <= half - 6; z += 11.6) {
      for (const sx of [-1, 1]) {
        const yb = arch(z) + 0.8;
        cols.push(new THREE.BoxGeometry(1.5, e - 1.4 - yb, 1.5).translate(sx * 3.4, (yb + e - 1.4) / 2, z));
      }
      cols.push(new THREE.BoxGeometry(6.8, 1.0, 1.0).translate(0, e - 3.0, z));
    }
    g.add(new THREE.Mesh(merge(cols), concreteDark));
    // 引桥桥墩(落到地形)
    const piers = [];
    for (let z = half + 10; z < 190; z += 14) {
      for (const sgn of [-1, 1]) {
        const zz = sgn * z;
        const h = Math.max(0, hAt(B.s + zz, 0)) - 2;
        if (e - 1.4 - h > 2) piers.push(new THREE.BoxGeometry(5.6, e - 1.4 - h, 1.7).translate(0, (h + e - 1.4) / 2, zz));
      }
    }
    g.add(new THREE.Mesh(merge(piers), concreteDark));
    shadows(g, true, true);
    this.bixby = g;
    this.items.push({ g, s: B.s, r: 1800 });
  }

  // ---------------------------------------------------------------- 圣莫尼卡码头
  _pier() {
    const sP = LANDMARKS.pier.s;
    const g = frame(this.scene, sP);
    const wood = mat({ color: new THREE.Color(...hex(0x8b6b46)), roughness: 0.85 });
    const woodDark = mat({ color: new THREE.Color(...hex(0x5a4430)), roughness: 0.9 });
    const white = mat({ color: 0xf0ece0, roughness: 0.7 });
    const deckY = 5.2;
    // 局部: 码头沿 -x 方向(朝海)延伸;x = -d
    const dStart = 36, dEnd = 330, W = 15;
    const pierLen = dEnd - dStart;
    const deckG = new THREE.BoxGeometry(pierLen, 0.5, W).translate(-(dStart + dEnd) / 2, deckY, 0);
    const deck = new THREE.Mesh(deckG, wood);
    g.add(deck);
    // 木板纹理(画在 canvas)
    {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 64;
      const x = c.getContext('2d');
      x.fillStyle = '#8a6a44'; x.fillRect(0, 0, 512, 64);
      const rnd = mulberry32(3);
      for (let i = 0; i < 64; i += 4) {
        const sh = 100 + rnd() * 50;
        x.fillStyle = `rgb(${sh + 28},${sh},${sh - 40})`;
        x.fillRect(0, i, 512, 3);
      }
      for (let i = 0; i < 90; i++) { x.fillStyle = 'rgba(40,25,10,.35)'; x.fillRect(rnd() * 512, rnd() * 64, 1 + rnd() * 4, 1); }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(pierLen / 20, W / 4); t.anisotropy = 8;
      deck.material = mat({ map: t, roughness: 0.85 });
    }
    // 桩
    const piles = [];
    for (let d = dStart; d < dEnd; d += 5) {
      for (const z of [-6.5, -2.2, 2.2, 6.5]) {
        const h = Math.max(-8, hAt(sP, d) - 1);
        const top = deckY - 0.2;
        piles.push(new THREE.CylinderGeometry(0.34, 0.4, top - Math.min(h, -4), 8).translate(-d, (top + Math.min(h, -4)) / 2, z));
      }
    }
    g.add(new THREE.Mesh(merge(piles), woodDark));
    // 栏杆 + 路灯
    const rail = [];
    const lampPos = [];
    for (const z of [-W / 2 + 0.2, W / 2 - 0.2]) {
      rail.push(new THREE.BoxGeometry(pierLen, 0.14, 0.14).translate(-(dStart + dEnd) / 2, deckY + 1.15, z));
      rail.push(new THREE.BoxGeometry(pierLen, 0.1, 0.1).translate(-(dStart + dEnd) / 2, deckY + 0.6, z));
      for (let d = dStart; d < dEnd; d += 3) rail.push(new THREE.BoxGeometry(0.12, 1.2, 0.12).translate(-d, deckY + 0.6, z));
      for (let d = dStart + 8; d < dEnd - 10; d += 20) lampPos.push([-d, z]);
    }
    g.add(new THREE.Mesh(merge(rail), white));
    const lampPoles = [];
    for (const [x, z] of lampPos) lampPoles.push(tube(V(x, deckY, z), V(x, deckY + 4.4, z), 0.07, 0.06, 5));
    g.add(new THREE.Mesh(merge(lampPoles), woodDark));
    this.lampHeads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 10, 8), mat({ color: 0xfff0c8, emissive: 0xffd890, emissiveIntensity: 0.2 }), lampPos.length);
    lampPos.forEach(([x, z], i) => {
      const m = new THREE.Matrix4().makeTranslation(x, deckY + 4.6, z);
      this.lampHeads.setMatrixAt(i, m);
    });
    g.add(this.lampHeads);
    // 入口拱门与霓虹招牌
    const archG = new THREE.Group();
    archG.position.set(-dStart - 1, 0, 0);
    const pylonG = [];
    for (const z of [-6.8, 6.8]) pylonG.push(new THREE.BoxGeometry(1.4, 9, 1.4).translate(0, deckY + 4.5, z));
    pylonG.push(new THREE.BoxGeometry(1.2, 1.4, 15).translate(0, deckY + 8.8, 0));
    archG.add(new THREE.Mesh(merge(pylonG), mat({ color: new THREE.Color(...hex(0xe8e0d0)), roughness: 0.7 })));
    const signTex = makeSignTexture(['SANTA MONICA', 'PIER · 1909'], { w: 1024, h: 256, bg: '#0a2a48', fg: '#ffe9a8', border: '#ff6a3a', sizes: [118, 60] });
    this.signMat = mat({ map: signTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.0 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(12.4, 3.1), this.signMat);
    sign.rotation.y = Math.PI / 2;
    sign.position.set(-0.2, deckY + 8.5, 0);
    archG.add(sign);
    const sign2 = sign.clone();
    sign2.rotation.y = -Math.PI / 2;
    sign2.position.x = 0.8;
    archG.add(sign2);
    g.add(archG);

    // 摩天轮(轮面朝向公路:转轴沿 x)
    const wheel = new THREE.Group();
    const wd = 232;
    const wR = 13.2, wy = deckY + 16.5;
    wheel.position.set(-wd, wy, 0);
    const rimM = mat({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.4 });
    const rimGeo = [];
    for (const sx of [-1.4, 1.4]) rimGeo.push(new THREE.TorusGeometry(wR, 0.22, 8, 64).rotateY(Math.PI / 2).translate(sx, 0, 0));
    const spokes = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const sx of [-1.4, 1.4]) spokes.push(tube(V(sx * 0.2, 0, 0), V(sx, Math.cos(a) * wR, Math.sin(a) * wR), 0.07, 0.07, 4));
      rimGeo.push(tube(V(-1.4, Math.cos(a) * wR, Math.sin(a) * wR), V(1.4, Math.cos(a) * wR, Math.sin(a) * wR), 0.1, 0.1, 5));
    }
    rimGeo.push(new THREE.CylinderGeometry(0.9, 0.9, 3.4, 12).rotateZ(Math.PI / 2));
    wheel.add(new THREE.Mesh(merge(rimGeo.concat(spokes)), rimM));
    // 座舱
    this.cabins = [];
    const cabCols = [0xff5a5f, 0xffb400, 0x2ec4b6, 0x3a86ff, 0xff7aa8, 0x8ac926, 0xff9f1c, 0x9b5de5];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const cab = new THREE.Group();
      cab.position.set(0, Math.cos(a) * wR, Math.sin(a) * wR);
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.5, 2.0).translate(0, -1.35, 0), mat({ color: new THREE.Color(...hex(cabCols[i % 8])), roughness: 0.4, metalness: 0.1 }));
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.7, 4).rotateY(Math.PI / 4).translate(0, -0.35, 0), mat({ color: 0xf0f0f0, roughness: 0.5 }));
      cab.add(body, roof, new THREE.Mesh(tube(V(0, 0, 0), V(0, -0.8, 0), 0.05, 0.05, 4), rimM));
      wheel.add(cab);
      this.cabins.push({ cab, a });
    }
    // 轮缘灯带(彩灯)
    const NL = 64;
    this.rimLights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), NL * 2);
    this.rimLights.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NL * 2 * 3), 3);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < NL; i++) {
      const a = (i / NL) * Math.PI * 2;
      for (let k = 0; k < 2; k++) {
        mm.makeTranslation(k ? 1.4 : -1.4, Math.cos(a) * (wR + 0.3), Math.sin(a) * (wR + 0.3));
        this.rimLights.setMatrixAt(i * 2 + k, mm);
      }
    }
    wheel.add(this.rimLights);
    g.add(wheel);
    this.wheel = wheel;
    // 支架 (A 形)
    const stand = [];
    for (const sx of [-2.2, 2.2]) {
      stand.push(tube(V(-wd + sx, deckY, -9), V(-wd + sx * 0.3, wy, -0.3), 0.3, 0.2, 6));
      stand.push(tube(V(-wd + sx, deckY, 9), V(-wd + sx * 0.3, wy, 0.3), 0.3, 0.2, 6));
    }
    g.add(new THREE.Mesh(merge(stand), rimM));
    // 旋转木马与乐园建筑
    const carousel = new THREE.Group();
    carousel.position.set(-168, deckY + 0.3, -3);
    carousel.add(new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 5, 16).translate(0, 2.5, 0), mat({ color: new THREE.Color(...hex(0xf1e6c8)), roughness: 0.7 })));
    const croof = new THREE.Mesh(new THREE.ConeGeometry(11, 5, 16).translate(0, 7.6, 0), mat({ color: new THREE.Color(...hex(0xd1443a)), roughness: 0.5 }));
    carousel.add(croof);
    carousel.add(new THREE.Mesh(tube(V(0, 10, 0), V(0, 13, 0), 0.08, 0.04, 4), rimM));
    g.add(carousel);
    // 其他游乐设施:红白条纹帐篷
    for (const [d, z, c] of [[110, 4, 0xe85d75], [135, -4, 0x4cc9f0], [88, -3, 0xffd166]]) {
      const tent = new THREE.Mesh(new THREE.ConeGeometry(4, 4, 8).translate(-d, deckY + 5, z), mat({ color: new THREE.Color(...hex(c)), roughness: 0.6 }));
      g.add(tent);
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 3, 8).translate(-d, deckY + 1.8, z), mat({ color: 0xf5f0e6, roughness: 0.7 })));
    }
    shadows(g, true, true);
    this.lampHeads.castShadow = false;
    this.rimLights.castShadow = false;
    this.pier = g;
    this.items.push({ g, s: sP, r: 2000 });
  }

  // ---------------------------------------------------------------- 救生塔
  _lifeguards() {
    const cols = [0xf8f4ec, 0xe94f37, 0x2f6fb0];
    const spots = [[6200, 70], [6420, 78], [6600, 66], [7050, 72], [7160, 80], [7300, 60]];
    for (const [s, d] of spots) {
      const g = frame(this.scene, s, d);
      const y = hAt(s, d);
      if (y < 0.5) continue;
      g.position.y = y;
      const base = mat({ color: 0xffffff, roughness: 0.6 });
      const accent = mat({ color: new THREE.Color(...hex(cols[(s / 10) % 3 | 0])), roughness: 0.5 });
      const legs = [];
      for (const sx of [-1.1, 1.1]) for (const sz of [-1.1, 1.1]) legs.push(tube(V(sx, 0, sz), V(sx * 0.8, 3.2, sz * 0.8), 0.1, 0.08, 5));
      g.add(new THREE.Mesh(merge(legs), base));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 2.4).translate(0, 3.25, 0), base));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.0, 2.2).translate(0, 4.4, 0), accent));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.25, 2.8).translate(0, 5.5, 0), base));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 0.05).translate(0, 4.5, 1.12), mat({ color: 0x223a52, roughness: 0.15, metalness: 0.5 })));
      g.rotation.y += Math.PI / 2 * 0; // 面向大海(朝 -x)
      g.rotateY(Math.PI / 2);
      shadows(g, true, true);
      this.items.push({ g, s, r: 1500 });
    }
  }

  // ---------------------------------------------------------------- 路牌
  _signs() {
    const list = [
      [1090, ['HALF MOON BAY  22', 'SANTA CRUZ  68'], 'g'],
      [1930, ['PIGEON POINT', 'LIGHTHOUSE  ▶'], 'b'],
      [3380, ['BIG SUR  28', 'MORRO BAY  108'], 'g'],
      [3770, ['BIXBY CREEK', 'BRIDGE  1932'], 'b'],
      [5120, ['MORRO BAY  14', 'SAN LUIS OBISPO  34'], 'g'],
      [6050, ['SANTA MONICA  12', 'LOS ANGELES  24'], 'g'],
      [6690, ['SANTA MONICA', 'PIER  ▶'], 'b'],
      [7420, ['MALIBU  4', 'OXNARD  38'], 'g'],
    ];
    const postM = mat({ color: 0x8a9096, roughness: 0.5, metalness: 0.7 });
    for (const [s, lines, kind] of list) {
      const g = frame(this.scene, s, -8.4);
      const y = hAt(s, -8.4);
      g.position.y = y;
      const tex = makeSignTexture(lines, kind === 'g'
        ? { w: 512, h: 256, bg: '#0b5d3b', fg: '#ffffff', border: '#ffffff', sizes: [54, 54] }
        : { w: 512, h: 256, bg: '#6b3f1d', fg: '#ffffff', border: '#ffffff', sizes: [56, 52] });
      const sm = mat({ map: tex, roughness: 0.45, metalness: 0.1 });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.2), sm);
      face.rotation.y = Math.PI; // 朝向来车(骑行者)
      face.position.set(0, 3.5, 0);
      const back = new THREE.Mesh(new THREE.BoxGeometry(4.5, 2.3, 0.08).translate(0, 3.5, 0.06), postM);
      g.add(face, back);
      g.add(new THREE.Mesh(merge([tube(V(-1.4, 0, 0.1), V(-1.4, 4.6, 0.1), 0.06, 0.06, 6), tube(V(1.4, 0, 0.1), V(1.4, 4.6, 0.1), 0.06, 0.06, 6)]), postM));
      shadows(g, true, true);
      this.items.push({ g, s, r: 900 });
    }
  }

  update(dt, s, camPos, night) {
    this.time += dt;
    const n = smoothstep(0.25, 0.8, night);
    for (const it of this.items) it.g.visible = Math.abs(s - it.s) < it.r;
    // 灯光与动画
    const blink = 0.5 + 0.5 * Math.sin(this.time * 2.2);
    for (const m of this.beacons) m.emissiveIntensity = 0.3 + 3 * blink * (0.4 + n);
    this.lampMat.emissiveIntensity = 0.15 + 3.2 * n;
    this.lampCore.material.emissiveIntensity = 0.2 + 8 * n;
    this.beam.rotation.y += dt * 0.7;
    this.beamMat.opacity = 0.16 * n;
    this.lampHeads.material.emissiveIntensity = 0.1 + 6 * n;
    this.signMat.emissiveIntensity = 0.12 + 1.6 * n;
    if (this.pier.visible) {
      this.wheel.rotation.x += dt * 0.11;
      for (const c of this.cabins) c.cab.rotation.x = -this.wheel.rotation.x;
      // 彩灯流动
      const arr = this.rimLights.instanceColor.array;
      const col = new THREE.Color();
      for (let i = 0; i < 64; i++) {
        const h = ((i / 64) + this.time * 0.15) % 1;
        const on = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(i * 0.9 - this.time * 3));
        col.setHSL(h, 1, 0.55).multiplyScalar(on * (1.0 + 4 * n));
        for (let k = 0; k < 2; k++) { arr[(i * 2 + k) * 3] = col.r; arr[(i * 2 + k) * 3 + 1] = col.g; arr[(i * 2 + k) * 3 + 2] = col.b; }
      }
      this.rimLights.instanceColor.needsUpdate = true;
    }
  }
}
