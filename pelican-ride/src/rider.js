// 鹈鹕 + 自行车:程序化建模与骑行动画
// 本地坐标:+z 前进, +y 向上, +x 向左(与路线分组坐标一致)
import * as THREE from 'three';
import { loft, tube, tint, merge, ik2, orient } from './geom.js';
import { extend } from './sky.js';
import { makeFeatherTextures } from './textures.js';
import { clamp, lerp, damp, smoothstep, mulberry32, hex } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const R_TIRE = 0.36;
const UP = V(0, 1, 0);

function phys(p) {
  return extend(new THREE.MeshPhysicalMaterial(p), { key: 'ext-default' });
}
function stdm(p) {
  return extend(new THREE.MeshStandardMaterial(p), { key: 'ext-default' });
}
const shade = (arr, k) => [arr[0] * k, arr[1] * k, arr[2] * k];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function wickerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7a5530'; g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 16) {
    for (let x = 0; x < 128; x += 16) {
      const horiz = ((x + y) / 16) % 2 === 0;
      g.fillStyle = horiz ? '#b88a52' : '#9c7040';
      g.fillRect(x + 1, y + 2, 14, 12);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + 1, y + (horiz ? 12 : 2), 14, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function leafGeometry(len, wid, c0, c1) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(wid * 0.95, -len * 0.2, wid * 0.9, -len * 0.78, 0, -len);
  s.bezierCurveTo(-wid * 0.9, -len * 0.78, -wid * 0.95, -len * 0.2, 0, 0);
  const g = new THREE.ShapeGeometry(s, 6);
  g.rotateX(-Math.PI / 2); // 叶尖指向 +z,法线 +y
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp(pos.getZ(i) / len, 0, 1);
    const c = mixc(c0, c1, t);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export class Rider {
  constructor(scene) {
    this.root = new THREE.Group(); // 世界位置/朝向
    this.lean = new THREE.Group(); // 倾斜
    this.bike = new THREE.Group(); // 车体
    this.rig = new THREE.Group(); // 鹈鹕(可上下晃动)
    this.root.add(this.lean);
    this.lean.add(this.bike);
    this.bike.add(this.rig);
    scene.add(this.root);

    this.crank = 0;
    this.wheel = 0;
    this.steer = 0;
    this.time = 0;
    this.bobSmooth = 0;

    const fe = makeFeatherTextures();
    this.mats = {
      frame: phys({ color: new THREE.Color(...hex(0x0c9aa8)), metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 }),
      accent: phys({ color: new THREE.Color(...hex(0xf2a33a)), metalness: 0.4, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 }),
      chrome: stdm({ color: 0xdcdfe3, metalness: 1, roughness: 0.2 }),
      dark: stdm({ color: 0x1b1c1e, metalness: 0.4, roughness: 0.5 }),
      rubber: stdm({ color: 0x131313, metalness: 0, roughness: 0.88 }),
      leather: stdm({ color: 0x3a2417, metalness: 0, roughness: 0.55 }),
      wicker: stdm({ map: wickerTexture(), roughness: 0.9 }),
      fish: phys({ color: 0xcfd8de, metalness: 0.9, roughness: 0.22, clearcoat: 0.6 }),
      feather: phys({
        vertexColors: true, map: fe.map, bumpMap: fe.bump, bumpScale: 0.7, roughness: 0.78, metalness: 0,
        sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.9, 0.82, 0.7),
      }),
      featherLeaf: phys({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.7, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.9, 0.82, 0.7) }),
      bill: phys({ vertexColors: true, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
      pouch: phys({ vertexColors: true, roughness: 0.55, sheen: 0.6, sheenColor: new THREE.Color(0.8, 0.7, 0.5) }),
      skin: stdm({ color: 0x242220, roughness: 0.65 }),
      lens: phys({ color: 0x07090c, metalness: 1, roughness: 0.04, clearcoat: 1 }),
      scarf: stdm({ color: new THREE.Color(...hex(0xe0412f)), roughness: 0.85, side: THREE.DoubleSide }),
      lamp: stdm({ color: 0x222222, emissive: 0xfff2cc, emissiveIntensity: 0.0 }),
      tail: stdm({ color: 0x300000, emissive: 0xff1a10, emissiveIntensity: 0.4 }),
    };

    this._buildBike();
    this._buildPelican();
    this._buildScarf();

    this.root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    this.scarf.castShadow = true;

    // 车灯
    this.headlight = new THREE.SpotLight(0xfff0d0, 0, 60, 0.42, 0.55, 1.6);
    this.headlight.position.set(0, 0.96, 0.55);
    this.headlight.target.position.set(0, 0, 8);
    this.steerGroup.add(this.headlight, this.headlight.target);
    this.headlight.target.position.set(0, 0.3, 8);

    this._tmp = { a: V(0, 0, 0), b: V(0, 0, 0), c: V(0, 0, 0) };
  }

  // ------------------------------------------------------------ 自行车
  _buildBike() {
    const m = this.mats;
    const bike = this.bike;
    const BB = V(0, 0.28, -0.07);
    const seatTop = V(0, 0.83, -0.262);
    const headTop = V(0, 0.865, 0.4);
    const headBot = V(0, 0.71, 0.435);
    const rearAx = V(0, R_TIRE, -0.5);
    const frontAx = V(0, R_TIRE, 0.52);
    this.BB = BB;
    this.rearAx = rearAx;
    this.frontAx = frontAx;
    this.headBot = headBot;
    this.steerAxis = new THREE.Vector3().subVectors(headTop, headBot).normalize();

    // 车架
    const f = [];
    f.push(tube(BB, seatTop, 0.017));
    f.push(tube(V(0, 0.81, -0.255), headTop.clone().setY(0.845), 0.0165));
    f.push(tube(headBot.clone().add(V(0, -0.005, -0.004)), BB, 0.022, 0.019));
    f.push(tube(headBot, headTop.clone().add(V(0, 0.01, 0)), 0.024, 0.024, 12));
    for (const sx of [-1, 1]) {
      f.push(tube(V(sx * 0.03, BB.y, BB.z), V(sx * 0.058, rearAx.y, rearAx.z), 0.011, 0.007));
      f.push(tube(V(sx * 0.016, 0.8, -0.258), V(sx * 0.058, rearAx.y, rearAx.z), 0.008, 0.006));
    }
    const frame = new THREE.Mesh(merge(f), m.frame);
    bike.add(frame);
    // 橙色点缀:座管和头管环
    const acc = new THREE.Mesh(merge([tube(V(0, 0.58, -0.186), V(0, 0.7, -0.222), 0.0185), tube(headBot.clone().add(V(0, 0.03, -0.007)), headBot.clone().add(V(0, 0.05, -0.011)), 0.0255)]), m.accent);
    bike.add(acc);

    // 座杆/鞍座
    const post = new THREE.Mesh(tube(seatTop, V(0, 0.93, -0.272), 0.0135), m.chrome);
    bike.add(post);
    const sad = new THREE.Mesh(
      loft([V(0, 0.955, -0.4), V(0, 0.962, -0.27), V(0, 0.972, -0.13)], {
        segs: 10, radial: 12,
        radiusFn: (t) => [0.065 * (0.5 + 0.9 * Math.sin(Math.PI * Math.pow(t, 0.8)) ** 0.7), 0.017 * Math.sin(Math.PI * Math.min(1, t * 0.98 + 0.01)) ** 0.5 + 0.004],
      }),
      m.leather
    );
    bike.add(sad);
    bike.add(new THREE.Mesh(tube(V(-0.03, 0.945, -0.36), V(-0.025, 0.946, -0.17), 0.003), m.chrome));
    bike.add(new THREE.Mesh(tube(V(0.03, 0.945, -0.36), V(0.025, 0.946, -0.17), 0.003), m.chrome));

    // 后轮
    this.rearWheel = this._wheel();
    this.rearWheel.position.copy(rearAx);
    bike.add(this.rearWheel);
    // 后飞轮、链条、曲柄
    this.crankGroup = new THREE.Group();
    this.crankGroup.position.copy(BB);
    bike.add(this.crankGroup);
    const ringG = merge([
      new THREE.CylinderGeometry(0.098, 0.098, 0.004, 40).rotateZ(Math.PI / 2).translate(-0.05, 0, 0),
      new THREE.CylinderGeometry(0.052, 0.052, 0.003, 24).rotateZ(Math.PI / 2).translate(-0.056, 0, 0),
      ...Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2;
        return tube(V(-0.05, 0, 0), V(-0.05, Math.cos(a) * 0.092, Math.sin(a) * 0.092), 0.006, 0.004, 5);
      }),
    ]);
    this.crankGroup.add(new THREE.Mesh(ringG, m.chrome));
    const cog = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.016, 20).rotateZ(Math.PI / 2).translate(-0.05, 0, 0), m.chrome);
    cog.position.copy(rearAx);
    bike.add(cog);
    // 链条上下两条
    const cr = 0.098, cgR = 0.046;
    const chainG = merge([
      tube(V(-0.05, BB.y + cr, BB.z), V(-0.05, rearAx.y + cgR, rearAx.z), 0.0045, 0.0045, 4),
      tube(V(-0.05, BB.y - cr, BB.z), V(-0.05, rearAx.y - cgR, rearAx.z), 0.0045, 0.0045, 4),
    ]);
    bike.add(new THREE.Mesh(chainG, m.dark));

    // 曲柄臂与踏板(每帧更新)
    this.crankArms = [];
    this.pedals = [];
    for (const sx of [1, -1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.02, 0.17).translate(0, 0, 0.085), m.chrome);
      bike.add(arm);
      this.crankArms.push(arm);
      const pedal = new THREE.Group();
      pedal.add(new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.022, 0.1), m.dark));
      pedal.add(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.026, 0.1).translate(0.032, 0, 0), m.rubber));
      pedal.add(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.026, 0.1).translate(-0.032, 0, 0), m.rubber));
      bike.add(pedal);
      this.pedals.push(pedal);
    }
    // 轴心(BB)
    bike.add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.13, 12).rotateZ(Math.PI / 2).translate(BB.x, BB.y, BB.z), m.chrome));

    // ---- 转向组:前叉 + 前轮 + 车把 + 篮子 + 灯
    this.steerGroup = new THREE.Group();
    this.steerGroup.position.copy(headBot);
    bike.add(this.steerGroup);
    const off = (v) => v.clone().sub(headBot);
    const forkG = [];
    for (const sx of [-1, 1]) {
      const crown = V(sx * 0.052, 0.69, 0.428);
      const mid = V(sx * 0.054, 0.45, 0.47);
      forkG.push(tube(off(crown), off(mid), 0.0125, 0.01));
      forkG.push(tube(off(mid), off(V(sx * 0.057, R_TIRE, 0.52)), 0.01, 0.008));
    }
    forkG.push(new THREE.CylinderGeometry(0.006, 0.006, 0.108, 8).rotateZ(Math.PI / 2).translate(0, off(V(0, 0.695, 0.43)).y, off(V(0, 0.695, 0.43)).z));
    forkG.push(tube(off(headTop), off(V(0, 0.9, 0.405)), 0.0125));
    forkG.push(tube(off(V(0, 0.9, 0.405)), off(V(0, 0.918, 0.47)), 0.013));
    this.steerGroup.add(new THREE.Mesh(merge(forkG), m.chrome));
    this.frontWheel = this._wheel();
    this.frontWheel.position.copy(off(frontAx));
    this.steerGroup.add(this.frontWheel);
    // 车把(弯把,向后掠)
    const barPts = [V(0.3, 0.915, 0.395), V(0.25, 0.917, 0.44), V(0.19, 0.918, 0.47), V(0, 0.918, 0.47), V(-0.19, 0.918, 0.47), V(-0.25, 0.917, 0.44), V(-0.3, 0.915, 0.395)].map(off);
    const barCurve = new THREE.CatmullRomCurve3(barPts);
    this.steerGroup.add(new THREE.Mesh(new THREE.TubeGeometry(barCurve, 40, 0.0115, 8), m.chrome));
    for (const sx of [-1, 1]) {
      const grip = new THREE.Mesh(tube(off(V(sx * 0.32, 0.915, 0.37)), off(V(sx * 0.29, 0.915, 0.415)), 0.0175, 0.0175, 10), m.rubber);
      this.steerGroup.add(grip);
      // 刹车把
      this.steerGroup.add(new THREE.Mesh(tube(off(V(sx * 0.255, 0.912, 0.435)), off(V(sx * 0.235, 0.895, 0.5)), 0.005, 0.004), m.dark));
    }
    // 铃铛
    this.steerGroup.add(new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0.07, 0.94, 0.47).translate(-headBot.x, -headBot.y, -headBot.z), m.chrome));
    // 车灯
    const lampBody = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.036, 0.05, 14).rotateX(Math.PI / 2).translate(0, 0.97, 0.53).translate(-headBot.x, -headBot.y, -headBot.z), m.dark);
    this.steerGroup.add(lampBody);
    this.lampLens = new THREE.Mesh(new THREE.CircleGeometry(0.028, 16).translate(0, 0.97, 0.556).translate(-headBot.x, -headBot.y, -headBot.z), m.lamp);
    this.steerGroup.add(this.lampLens);
    // 篮子(挂在车把前方)
    const bc = off(V(0, 0.83, 0.64));
    const basketG = [];
    const bw = 0.34, bh = 0.2, bd = 0.26, th = 0.012;
    basketG.push(new THREE.BoxGeometry(bw, th, bd).translate(bc.x, bc.y - bh / 2, bc.z));
    basketG.push(new THREE.BoxGeometry(bw, bh, th).translate(bc.x, bc.y, bc.z + bd / 2));
    basketG.push(new THREE.BoxGeometry(bw, bh, th).translate(bc.x, bc.y, bc.z - bd / 2));
    basketG.push(new THREE.BoxGeometry(th, bh, bd).translate(bc.x + bw / 2, bc.y, bc.z));
    basketG.push(new THREE.BoxGeometry(th, bh, bd).translate(bc.x - bw / 2, bc.y, bc.z));
    const bg = merge(basketG);
    const uv = bg.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * 2);
    this.steerGroup.add(new THREE.Mesh(bg, m.wicker));
    // 篮口金属圈
    this.steerGroup.add(new THREE.Mesh(
      merge([
        tube(V(bc.x - bw / 2, bc.y + bh / 2, bc.z - bd / 2), V(bc.x + bw / 2, bc.y + bh / 2, bc.z - bd / 2), 0.006),
        tube(V(bc.x - bw / 2, bc.y + bh / 2, bc.z + bd / 2), V(bc.x + bw / 2, bc.y + bh / 2, bc.z + bd / 2), 0.006),
        tube(V(bc.x - bw / 2, bc.y + bh / 2, bc.z - bd / 2), V(bc.x - bw / 2, bc.y + bh / 2, bc.z + bd / 2), 0.006),
        tube(V(bc.x + bw / 2, bc.y + bh / 2, bc.z - bd / 2), V(bc.x + bw / 2, bc.y + bh / 2, bc.z + bd / 2), 0.006),
        tube(off(V(0, 0.9, 0.44)), V(bc.x, bc.y + bh / 2, bc.z - bd / 2), 0.005),
      ]),
      m.chrome
    ));
    // 鱼 ×2
    for (const [dx, rz, ry] of [[-0.07, 0.35, 0.3], [0.07, 0.2, -0.35]]) {
      const fish = this._fish();
      fish.position.set(bc.x + dx, bc.y + 0.1, bc.z);
      fish.rotation.set(-0.35 - rz * 0.4, ry, rz * 0.6, 'YXZ');
      this.steerGroup.add(fish);
    }
    // 尾灯、挡泥板反光片
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.02).translate(0, 0.74, -0.38), m.tail);
    bike.add(tail);
    this.tailLight = tail;
  }

  _fish() {
    const g = new THREE.Group();
    const body = loft([V(0, 0, 0.17), V(0, 0, 0), V(0, 0, -0.16)], {
      segs: 14, radial: 12,
      radiusFn: (t) => {
        const q = Math.sin(Math.PI * Math.pow(t, 0.7));
        return [0.026 * q ** 0.8 * (1 - 0.4 * t), 0.045 * q ** 0.8 * (1 - 0.6 * t)];
      },
      colorFn: (t, th, n) => {
        const belly = smoothstep(0.1, -0.7, n[1]);
        const back = smoothstep(0.2, 0.9, n[1]);
        return mixc(mixc([0.55, 0.62, 0.68], [0.12, 0.2, 0.3], back), [0.9, 0.92, 0.93], belly);
      },
    });
    const bm = phys({ vertexColors: true, metalness: 0.85, roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.1 });
    g.add(new THREE.Mesh(body, bm));
    const tailShape = new THREE.Shape();
    tailShape.moveTo(0, 0); tailShape.lineTo(-0.05, -0.07); tailShape.lineTo(0, -0.045); tailShape.lineTo(0.05, -0.07); tailShape.closePath();
    const tg = new THREE.ShapeGeometry(tailShape);
    tg.rotateY(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0, -0.15);
    const tailM = new THREE.Mesh(tg, stdm({ color: 0x6d7f8e, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide }));
    g.add(tailM);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 8).translate(0.02, 0.012, 0.12), stdm({ color: 0x000000, roughness: 0.2 }));
    const eye2 = eye.clone(); eye2.position.x = -0.04;
    g.add(eye, eye2);
    // 背鳍
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.07, 4).rotateX(-0.5).translate(0, 0.05, -0.02), stdm({ color: 0x405868, roughness: 0.4, metalness: 0.5 }));
    g.add(fin);
    return g;
  }

  _wheel() {
    const m = this.mats;
    const g = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(R_TIRE - 0.027, 0.027, 12, 64).rotateY(Math.PI / 2), m.rubber);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R_TIRE - 0.058, 0.0075, 8, 64).rotateY(Math.PI / 2), m.chrome);
    const parts = [];
    const hubR = 0.022, rimR = R_TIRE - 0.062;
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2, side = i % 2 ? 1 : -1;
      const a0 = a + side * 0.28;
      parts.push(tube(V(side * 0.032, Math.cos(a0) * hubR, Math.sin(a0) * hubR), V(0, Math.cos(a) * rimR, Math.sin(a) * rimR), 0.0012, 0.0012, 3));
    }
    parts.push(new THREE.CylinderGeometry(0.018, 0.018, 0.075, 12).rotateZ(Math.PI / 2));
    parts.push(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 14).rotateZ(Math.PI / 2).translate(0.032, 0, 0));
    parts.push(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 14).rotateZ(Math.PI / 2).translate(-0.032, 0, 0));
    const spokes = new THREE.Mesh(merge(parts), m.chrome);
    // 反光条(前后轮侧面橙色)
    const refl = new THREE.Mesh(new THREE.TorusGeometry(R_TIRE - 0.03, 0.0285, 6, 64, 0.5).rotateY(Math.PI / 2), stdm({ color: 0xffb040, emissive: 0x442200, roughness: 0.5 }));
    g.add(tire, rim, spokes, refl);
    return g;
  }

  // ------------------------------------------------------------ 鹈鹕
  _buildPelican() {
    const m = this.mats;
    const rig = this.rig;
    const C = {
      back: hex(0x6b5a4b), backHi: hex(0x9a8d7e), belly: hex(0x3c2e25),
      neckRear: hex(0x5e3a24), neckFront: hex(0xf2ede0),
      face: hex(0xf6f1e0), crown: hex(0xeccb5e),
      billA: hex(0xb2a791), billB: hex(0x9c917a), billTip: hex(0xc9622a),
      pouch: hex(0x5d5546), wingA: hex(0x84766a), wingB: hex(0x2a211a), leg: hex(0x2a2825),
    };
    this.C = C;
    const K = 1.05;

    // ---- 躯干
    const spine = [V(0, 1.02, -0.8), V(0, 1.1, -0.52), V(0, 1.24, -0.2), V(0, 1.4, 0.08), V(0, 1.5, 0.2)];
    const bodyG = loft(spine, {
      segs: 32, radial: 26, cell: 0.05,
      radiusFn: (t) => {
        const u = Math.pow(t, 0.85);
        const r = Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)) * (0.6 + 0.4 * u);
        return [0.21 * r, 0.25 * r];
      },
      colorFn: (t, th, n) => {
        const top = smoothstep(-0.3, 0.7, n[1]);
        const c = mixc(shade(C.belly, K), shade(C.back, K), top);
        const streak = 0.5 + 0.5 * Math.sin(th * 9 + t * 24);
        return mixc(c, shade(C.backHi, K), top * 0.3 * streak * smoothstep(0.1, 0.6, t));
      },
    });
    this.body = new THREE.Mesh(bodyG, m.feather);
    rig.add(this.body);
    // 尾羽
    const tailG = [];
    for (let i = -2; i <= 2; i++) {
      const lg = leafGeometry(0.3, 0.05, shade(C.wingA, 0.8), shade(C.wingB, 0.9));
      lg.rotateX(0.2).rotateY(Math.PI + i * 0.15);
      lg.translate(i * 0.012, 1.07, -0.78);
      tailG.push(lg);
    }
    rig.add(new THREE.Mesh(merge(tailG), m.featherLeaf));

    // ---- 脖子(S 形)
    const pivot = V(0, 1.88, 0.22);
    const neckPts = [V(0, 1.43, 0.14), V(0, 1.56, 0.08), V(0, 1.69, 0.06), V(0, 1.8, 0.12), pivot.clone()];
    const neckG = loft(neckPts, {
      segs: 28, radial: 18, cell: 0.04,
      radiusFn: (t) => {
        const r = 0.122 - 0.054 * smoothstep(0, 0.55, t) + 0.01 * smoothstep(0.75, 1, t);
        return [r, r * 1.02];
      },
      colorFn: (t, th, n) => {
        const rear = smoothstep(0.2, -0.55, n[2]) * (1 - smoothstep(0.8, 0.98, t)) * smoothstep(0.0, 0.12, t + 0.08);
        return mixc(shade(C.neckFront, K * 0.95), shade(C.neckRear, K), rear);
      },
    });
    this.neck = new THREE.Mesh(neckG, m.feather);
    rig.add(this.neck);

    // ---- 头部(局部坐标,原点在颈顶枢轴)
    this.head = new THREE.Group();
    this.head.position.copy(pivot);
    rig.add(this.head);
    const headSph = new THREE.SphereGeometry(0.1, 26, 20);
    headSph.scale(0.92, 1.0, 1.2);
    headSph.translate(0, 0.045, 0.06);
    {
      const p = headSph.attributes.position, nn = headSph.attributes.normal;
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const crown = smoothstep(0.2, 0.8, nn.getY(i)) * smoothstep(-0.2, 0.5, 0.35 - nn.getZ(i) * 0.5 + nn.getY(i) * 0.5);
        const c = mixc(shade(C.face, K * 0.95), shade(C.crown, K * 0.95), crown);
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
      headSph.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    this.headMesh = new THREE.Mesh(headSph, m.feather);
    this.head.add(this.headMesh);
    const billPts = [V(0, 0.045, 0.1), V(0, 0.035, 0.26), V(0, 0.0, 0.42), V(0, -0.055, 0.56), V(0, -0.082, 0.605)];
    const billG = loft(billPts, {
      segs: 26, radial: 16,
      radiusFn: (t) => [0.047 * (1 - 0.74 * t ** 1.2) + 0.004, 0.037 * (1 - 0.72 * t ** 1.1) + 0.004],
      colorFn: (t, th, n) => {
        let c = mixc(C.billA, C.billB, smoothstep(0, 1, t));
        c = mixc(c, C.billTip, smoothstep(0.8, 0.97, t));
        c = mixc(c, [c[0] * 1.3, c[1] * 1.3, c[2] * 1.25], smoothstep(0.6, 1, n[1]) * 0.6);
        return c;
      },
    });
    this.head.add(new THREE.Mesh(billG, m.bill));
    const pouchPts = [V(0, 0.015, 0.1), V(0, -0.04, 0.26), V(0, -0.108, 0.42), V(0, -0.14, 0.545), V(0, -0.13, 0.6)];
    const pouchG = loft(pouchPts, {
      segs: 26, radial: 16,
      radiusFn: (t) => {
        const q = Math.sin(Math.PI * Math.min(1, t * 1.02));
        return [0.034 + 0.032 * q ** 0.8 * (1 - t * 0.4), 0.012 + 0.058 * q ** 0.9 * (1 - 0.3 * t)];
      },
      colorFn: (t, th, n) => {
        const edge = smoothstep(0.7, 1, Math.abs(n[0]));
        return mixc(shade(C.pouch, 0.9), shade(C.billA, 0.55), edge * 0.5 + t * 0.2);
      },
    });
    this.pouch = new THREE.Mesh(pouchG, m.pouch);
    this.head.add(this.pouch);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 8), stdm({ color: 0x000000, roughness: 0.15 }));
      eye.position.set(sx * 0.082, 0.068, 0.04);
      this.head.add(eye);
    }
    // 墨镜(自信!)
    const glasses = new THREE.Group();
    for (const sx of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), m.lens);
      lens.scale.set(0.056, 0.042, 0.011);
      lens.position.set(sx * 0.094, 0.07, 0.07);
      lens.rotation.y = sx * (Math.PI / 2 - 0.5);
      glasses.add(lens);
      const rimm = new THREE.Mesh(new THREE.TorusGeometry(1, 0.09, 6, 26), m.dark);
      rimm.scale.set(0.057, 0.043, 0.057);
      rimm.position.copy(lens.position);
      rimm.rotation.y = lens.rotation.y;
      glasses.add(rimm);
      glasses.add(new THREE.Mesh(tube(V(sx * 0.11, 0.075, 0.04), V(sx * 0.092, 0.07, -0.07), 0.004), m.dark));
    }
    glasses.add(new THREE.Mesh(tube(V(-0.055, 0.082, 0.12), V(0.055, 0.082, 0.12), 0.005), m.dark));
    glasses.add(new THREE.Mesh(tube(V(-0.085, 0.076, 0.095), V(-0.055, 0.082, 0.12), 0.0045), m.dark));
    glasses.add(new THREE.Mesh(tube(V(0.085, 0.076, 0.095), V(0.055, 0.082, 0.12), 0.0045), m.dark));
    this.head.add(glasses);
    this.glasses = glasses;

    // ---- 翅膀(手臂)
    this.arms = [];
    for (const sx of [1, -1]) {
      const up = new THREE.Group(), fore = new THREE.Group();
      const L1 = 0.44, L2 = 0.42;
      const wingBody = (len, rx0, rx1, ry0, ry1, dark) =>
        loft([V(0, 0, 0), V(0, 0, len * 0.5), V(0, 0, len)], {
          segs: 12, radial: 16, cell: 0.04,
          radiusFn: (t) => [lerp(rx0, rx1, t), lerp(ry0, ry1, t)],
          colorFn: (t, th, n) => mixc(shade(C.wingA, K * 1.0), shade(C.wingB, K * 0.9), clamp(smoothstep(0.55, 1, t) * dark + smoothstep(0.1, -0.7, n[1]) * 0.15, 0, 1)),
        });
      const feathersFor = (len, count, fl, fw, rnd) => {
        const arr = [];
        for (let i = 0; i < count; i++) {
          const z = 0.05 + (len - 0.12) * (i / (count - 1));
          const lg = leafGeometry(fl * (0.85 + rnd() * 0.25), fw, shade(C.wingA, 0.85), shade(C.wingB, 1));
          lg.rotateY(-sx * (0.12 + 0.3 * rnd())).rotateZ(sx * (0.1 + 0.2 * rnd()));
          lg.translate(-sx * 0.055, -0.03, z);
          arr.push(lg);
        }
        return arr;
      };
      const rnd = mulberry32(sx > 0 ? 11 : 12);
      up.add(new THREE.Mesh(wingBody(L1, 0.115, 0.1, 0.04, 0.035, 0.3), m.feather));
      up.add(new THREE.Mesh(merge(feathersFor(L1, 7, 0.22, 0.055, rnd)), m.featherLeaf));
      fore.add(new THREE.Mesh(wingBody(L2, 0.1, 0.06, 0.036, 0.028, 0.8), m.feather));
      fore.add(new THREE.Mesh(merge(feathersFor(L2, 9, 0.26, 0.055, rnd)), m.featherLeaf));
      // 握把的翼尖羽
      const tipG = [];
      for (let i = 0; i < 5; i++) {
        const lg = leafGeometry(0.17, 0.026, shade(C.wingB, 1.2), shade(C.wingB, 0.7));
        lg.rotateY((i - 2) * 0.22).rotateX(-0.2 - Math.abs(i - 2) * 0.05);
        lg.translate((i - 2) * 0.012, -0.01, L2 - 0.06);
        tipG.push(lg);
      }
      fore.add(new THREE.Mesh(merge(tipG), m.featherLeaf));
      rig.add(up, fore);
      this.arms.push({ sx, up, fore, L1, L2 });
    }

    // ---- 腿
    this.legs = [];
    const footG = new THREE.Shape();
    footG.moveTo(0, 0);
    footG.bezierCurveTo(0.03, 0.03, 0.09, 0.07, 0.13, 0.17);
    footG.quadraticCurveTo(0.075, 0.15, 0.0, 0.12);
    footG.quadraticCurveTo(-0.075, 0.15, -0.13, 0.17);
    footG.bezierCurveTo(-0.09, 0.07, -0.03, 0.03, 0, 0);
    for (const sx of [1, -1]) {
      const thigh = new THREE.Group(), shin = new THREE.Group(), foot = new THREE.Group();
      const L1 = 0.4, L2 = 0.43;
      const tg = loft([V(0, 0, 0), V(0, 0, L1 * 0.5), V(0, 0, L1)], {
        segs: 8, radial: 14, cell: 0.04,
        radiusFn: (t) => [lerp(0.092, 0.05, t), lerp(0.1, 0.056, t)],
        colorFn: () => shade(C.belly, K * 1.0),
      });
      thigh.add(new THREE.Mesh(tg, m.feather));
      thigh.add(new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10).translate(0, 0, L1), m.skin));
      shin.add(new THREE.Mesh(merge([tube(V(0, 0, 0), V(0, 0, L2), 0.026, 0.02, 10), new THREE.SphereGeometry(0.03, 10, 8).translate(0, 0, L2)]), m.skin));
      const fgeo = new THREE.ExtrudeGeometry(footG, { depth: 0.009, bevelEnabled: false, curveSegments: 6 });
      fgeo.rotateX(-Math.PI / 2);
      const fm = new THREE.Mesh(fgeo, stdm({ color: new THREE.Color(...hex(0x403a33)), roughness: 0.6, side: THREE.DoubleSide }));
      fm.position.set(0, -0.052, -0.03);
      foot.add(fm);
      foot.add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), m.skin));
      rig.add(thigh, shin, foot);
      this.legs.push({ sx, thigh, shin, foot, L1, L2 });
    }
  }

  _buildScarf() {
    const N = 10;
    this.scarfN = N;
    this.scarfNodes = [];
    this.scarfPrev = [];
    const anchor = V(0, 1.62, 0.045);
    for (let i = 0; i < N; i++) {
      this.scarfNodes.push(anchor.clone().add(V(0, -0.02 * i, -0.06 * i)));
      this.scarfPrev.push(this.scarfNodes[i].clone());
    }
    this.scarfAnchor = anchor;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(N * 2 * 2), 2));
    const idx = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    this.scarf = new THREE.Mesh(g, this.mats.scarf);
    this.scarf.frustumCulled = false;
    // 围脖(脖根圈)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.032, 8, 20).rotateX(Math.PI / 2).translate(0, 1.6, 0.09), this.mats.scarf);
    ring.scale.set(1, 1, 1.1);
    this.rig.add(ring);
    this.rig.add(this.scarf);
  }

  // ------------------------------------------------------------ 每帧
  // st: {speed, kappa, grade, dt, night}
  update(dt, st) {
    this.time += dt;
    const v = st.speed;
    this.wheel += (v / R_TIRE) * dt;
    this.crank += ((v / R_TIRE) / 2.65) * dt;
    this.rearWheel.rotation.x = this.wheel;
    this.frontWheel.rotation.x = this.wheel;

    // 转向
    const steerT = clamp(Math.atan(1.0 * st.kappa) * 2.2, -0.4, 0.4);
    this.steer = damp(this.steer, steerT, 6, dt);
    this.steerGroup.quaternion.setFromAxisAngle(this.steerAxis, this.steer);

    // 骑行晃动:踩踏频率的 2 倍
    const cr = this.crank;
    const power = clamp(1 - st.grade * -6, 0.4, 1.4);
    const bob = Math.sin(cr * 2) * 0.006 * power;
    const sway = Math.sin(cr) * 0.012 * power;
    this.rig.position.set(sway, bob, 0);
    this.rig.rotation.z = -sway * 0.8;
    this.rig.rotation.x = Math.sin(cr * 2 + 0.6) * 0.006;

    // 曲柄/踏板/腿 IK
    const BB = this.BB;
    const Lc = 0.17;
    const thetas = [cr, cr + Math.PI]; // 左(+x), 右(-x)
    const tmp = this._tmp;
    for (let k = 0; k < 2; k++) {
      const leg = this.legs[k];
      const sx = leg.sx; // +1 左
      const th = thetas[k];
      const px = sx * 0.1;
      const py = BB.y - Lc * Math.cos(th);
      const pz = BB.z - Lc * Math.sin(th);
      // 曲柄臂: 从 BB 到踏板
      const arm = this.crankArms[k];
      tmp.a.set(sx * 0.07, BB.y, BB.z);
      tmp.b.set(px, py, pz);
      orient(arm, tmp.a, tmp.b, UP);
      arm.scale.z = tmp.a.distanceTo(tmp.b) / 0.17;
      const pedal = this.pedals[k];
      pedal.position.set(px + sx * 0.012, py, pz);
      // 踝关节:脚踏板上方
      const ankleLift = 0.075;
      const ank = V(px, py + ankleLift, pz - 0.02);
      const hip = V(sx * 0.115, 1.0 + bob * 0.5, -0.31);
      const knee = ik2(hip, ank, leg.L1, leg.L2, V(sx * 0.35, 0.15, 1), new THREE.Vector3());
      orient(leg.thigh, hip, knee, V(sx, 0, 0));
      orient(leg.shin, knee, ank, V(sx, 0, 0));
      leg.foot.position.copy(ank);
      leg.foot.rotation.set(-0.12 - 0.35 * Math.cos(th + 0.4), 0, 0);
    }
    this.crankGroup.rotation.x = cr;

    // 手臂 IK -> 车把握把(随转向)
    const steerQ = this.steerGroup.quaternion;
    for (const A of this.arms) {
      const sx = A.sx;
      const gripLocal = V(sx * 0.31, 0.917, 0.395).sub(this.headBot).applyQuaternion(steerQ).add(this.headBot);
      const shoulder = V(sx * 0.175, 1.42, 0.1);
      const wrist = gripLocal.clone().add(V(0, 0.02, -0.0));
      const elbow = ik2(shoulder, wrist, A.L1, A.L2, V(sx * 0.55, -0.35, -0.45), new THREE.Vector3());
      orient(A.up, shoulder, elbow, V(sx, 0.2, 0));
      orient(A.fore, elbow, wrist, V(sx, 0.2, 0));
    }

    // 头部:保持水平看向前方,补偿车身俯仰;颈部随晃动
    const hp = (st.pitch || 0);
    this.head.rotation.set(-hp * 0.8 + Math.sin(cr * 2 + 1.1) * 0.012 + 0.04, clamp(-this.steer * 0.9, -0.3, 0.3), -(st.roll || 0) * 0.5);
    this.pouch.scale.y = 1 + 0.025 * Math.sin(this.time * 2.1);
    this.body.scale.setScalar(1 + 0.008 * Math.sin(this.time * 2.6));

    // 车灯
    const nightK = st.night || 0;
    this.headlight.intensity = 90 * nightK;
    this.lampLens.material.emissiveIntensity = 0.1 + 6 * nightK;
    this.tailLight.material.emissiveIntensity = 0.4 + 3 * nightK;

    this._scarf(dt, v);
  }

  _scarf(dt, v) {
    const N = this.scarfN, nodes = this.scarfNodes, prev = this.scarfPrev;
    const seg = 0.075;
    const sub = 2;
    const h = dt / sub;
    nodes[0].copy(this.scarfAnchor);
    prev[0].copy(nodes[0]);
    for (let it = 0; it < sub; it++) {
      for (let i = 1; i < N; i++) {
        const p = nodes[i], q = prev[i];
        const vx = (p.x - q.x) * 0.9, vy = (p.y - q.y) * 0.9, vz = (p.z - q.z) * 0.9;
        q.copy(p);
        const flutter = Math.sin(this.time * 11 + i * 0.9) * 0.6 * (i / N);
        p.x += vx + flutter * h * h * 4;
        p.y += vy - 2.2 * h * h + Math.cos(this.time * 9 + i) * 0.3 * h * h * (i / N);
        p.z += vz - (1.1 + v * 0.75) * h * h;
      }
      for (let k = 0; k < 3; k++) {
        for (let i = 1; i < N; i++) {
          const a = nodes[i - 1], b = nodes[i];
          const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const l = Math.hypot(dx, dy, dz) || 1e-6;
          const diff = (l - seg) / l;
          if (i === 1) { b.x -= dx * diff; b.y -= dy * diff; b.z -= dz * diff; }
          else { a.x += dx * diff * 0.5; a.y += dy * diff * 0.5; a.z += dz * diff * 0.5; b.x -= dx * diff * 0.5; b.y -= dy * diff * 0.5; b.z -= dz * diff * 0.5; }
        }
        nodes[0].copy(this.scarfAnchor);
      }
    }
    const pos = this.scarf.geometry.attributes.position.array;
    const nor = this.scarf.geometry.attributes.normal.array;
    const uv = this.scarf.geometry.attributes.uv.array;
    const dir = new THREE.Vector3(), side = new THREE.Vector3(), nrm = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const a = nodes[Math.max(0, i - 1)], b = nodes[Math.min(N - 1, i + 1)];
      dir.subVectors(b, a).normalize();
      side.crossVectors(dir, UP);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const tw = Math.sin(this.time * 6 + i * 0.7) * 0.9 * (i / N);
      nrm.crossVectors(side, dir).normalize();
      const w = 0.065 * (1 - 0.35 * (i / N));
      const s2 = side.clone().multiplyScalar(Math.cos(tw)).addScaledVector(nrm, Math.sin(tw));
      const p = nodes[i];
      pos[i * 6] = p.x + s2.x * w; pos[i * 6 + 1] = p.y + s2.y * w; pos[i * 6 + 2] = p.z + s2.z * w;
      pos[i * 6 + 3] = p.x - s2.x * w; pos[i * 6 + 4] = p.y - s2.y * w; pos[i * 6 + 5] = p.z - s2.z * w;
      nor[i * 6] = nor[i * 6 + 3] = nrm.x; nor[i * 6 + 1] = nor[i * 6 + 4] = nrm.y; nor[i * 6 + 2] = nor[i * 6 + 5] = nrm.z;
      uv[i * 4] = 0; uv[i * 4 + 1] = i / N; uv[i * 4 + 2] = 1; uv[i * 4 + 3] = i / N;
    }
    this.scarf.geometry.attributes.position.needsUpdate = true;
    this.scarf.geometry.attributes.normal.needsUpdate = true;
  }

  // 第一人称:隐藏头部球体与墨镜(相机位于头内),保留喙
  setFirstPerson(on) {
    this.headMesh.visible = !on;
    this.glasses.visible = !on;
    this.head.traverse((o) => { if (o.isMesh && o !== this.headMesh && !this.glasses.children.includes(o)) o.castShadow = true; });
  }

  headWorld(out) {
    return this.head.getWorldPosition(out);
  }
}
