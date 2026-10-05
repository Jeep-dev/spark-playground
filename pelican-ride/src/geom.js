// 几何构造辅助:变截面放样、两点管、IK、合并
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _v = new THREE.Vector3();

// 沿样条放样椭圆截面。radiusFn(t)->[rx, ry];colorFn(t, theta, nrm)->[r,g,b] 可选
export function loft(points, { segs = 24, radial = 14, radiusFn, colorFn, closed = false, uvScale = [1, 1], cell = 0, up = new THREE.Vector3(0, 1, 0) } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
  if (cell > 0) {
    // 按物理尺寸自动设置 UV 重复次数(羽毛贴图 18 列 × 26 行),使鳞片大小各向同性
    let per = 0;
    for (let i = 0; i <= 8; i++) { const [a, b] = radiusFn(i / 8); per += Math.PI * (a + b) / 9; }
    uvScale = [Math.max(1, Math.round(per * 2 / (cell * 18))), Math.max(1, Math.round(curve.getLength() / (cell * 26)))];
  }
  const frames = curve.computeFrenetFrames(segs, closed);
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const useCol = !!colorFn;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = curve.getPointAt(t);
    // 平行传输帧; 以 up 定参考 binormal 稳定截面朝向
    let T = frames.tangents[i];
    let N = new THREE.Vector3().crossVectors(up, T);
    if (N.lengthSq() < 1e-6) N.copy(frames.normals[i]);
    N.normalize();
    const B = new THREE.Vector3().crossVectors(T, N).normalize();
    const [rx, ry] = radiusFn(t);
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const x = p.x + N.x * c * rx + B.x * s * ry;
      const y = p.y + N.y * c * rx + B.y * s * ry;
      const z = p.z + N.z * c * rx + B.z * s * ry;
      pos.push(x, y, z);
      // 椭圆法线 ≈ (c/rx, s/ry)
      const nx = (N.x * c) / Math.max(rx, 1e-4) + (B.x * s) / Math.max(ry, 1e-4);
      const ny = (N.y * c) / Math.max(rx, 1e-4) + (B.y * s) / Math.max(ry, 1e-4);
      const nz = (N.z * c) / Math.max(rx, 1e-4) + (B.z * s) / Math.max(ry, 1e-4);
      const l = Math.hypot(nx, ny, nz) || 1;
      nor.push(nx / l, ny / l, nz / l);
      uv.push((j / radial) * uvScale[0], t * uvScale[1]);
      if (useCol) {
        const cc = colorFn(t, th, [nx / l, ny / l, nz / l], [x, y, z]);
        col.push(cc[0], cc[1], cc[2]);
      }
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (useCol) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  // 若法线朝内则翻转(根据首个顶点)
  return g;
}

// 两点之间的圆柱(Y 轴向 -> 对齐 a→b)
export function tube(a, b, r0, r1 = r0, seg = 8) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.subVectors(b, a).normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

export function tint(g, r, gg, b) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function merge(list) {
  if (!list.length) return new THREE.BufferGeometry();
  const prepared = list.map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    if (!x.attributes.uv) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    return x;
  });
  return mergeGeometries(prepared, false);
}

// 两段 IK(在任意平面):返回关节位置。pole 指向弯曲方向
export function ik2(root, target, l1, l2, pole, out = new THREE.Vector3()) {
  const d = new THREE.Vector3().subVectors(target, root);
  let dist = d.length();
  const maxD = (l1 + l2) * 0.999;
  const minD = Math.abs(l1 - l2) * 1.001 + 1e-3;
  dist = Math.min(Math.max(dist, minD), maxD);
  d.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  // pole 在垂直于 d 的分量
  const pp = pole.clone().addScaledVector(d, -pole.dot(d));
  if (pp.lengthSq() < 1e-8) pp.set(0, 1, 0).addScaledVector(d, -d.y);
  pp.normalize();
  return out.copy(root).addScaledVector(d, a).addScaledVector(pp, h);
}

// 让 obj 的局部 +Z 指向 from→to, +Y 尽量靠近 up
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
export function orient(obj, from, to, up) {
  _z.subVectors(to, from).normalize();
  _x.crossVectors(up, _z);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _y.crossVectors(_z, _x).normalize();
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(from);
}
