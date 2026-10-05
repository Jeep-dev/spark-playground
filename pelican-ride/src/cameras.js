// 多机位:追尾 / 环绕 / 第一人称 / 侧拍 / 迎面 / 航拍 / 低角度 / 电影 / 自由飞行
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clamp, lerp, damp, smoother } from './util.js';

const ico = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
export const MODES = [
  { id: 'chase', name: '追尾', key: '1', icon: ico('<path d="M3 17l4-9h10l4 9"/><circle cx="7" cy="17" r="1.5"/><circle cx="17" cy="17" r="1.5"/><path d="M12 4v4"/>') },
  { id: 'orbit', name: '环绕', key: '2', icon: ico('<ellipse cx="12" cy="12" rx="9" ry="4.2"/><circle cx="12" cy="12" r="2"/><path d="M19 8l2 .5-.6-2"/>') },
  { id: 'first', name: '第一人称', key: '3', icon: ico('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>') },
  { id: 'side', name: '侧拍', key: '4', icon: ico('<rect x="3" y="8" width="8" height="8" rx="1.5"/><path d="M11 11l6-3v8l-6-3"/><path d="M20 7v10"/>') },
  { id: 'front', name: '迎面', key: '5', icon: ico('<circle cx="12" cy="9" r="4"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>') },
  { id: 'drone', name: '航拍', key: '6', icon: ico('<circle cx="12" cy="12" r="2"/><circle cx="5" cy="5" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M7 7l3.5 3.5M17 7l-3.5 3.5M7 17l3.5-3.5M17 17l-3.5-3.5"/>') },
  { id: 'low', name: '低角度', key: '7', icon: ico('<path d="M3 19h18"/><circle cx="12" cy="13" r="4"/><path d="M12 9V4"/>') },
  { id: 'cine', name: '电影', key: '8', icon: ico('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 5l2 4M12 5l2 4M17 5l2 4"/>') },
  { id: 'free', name: '自由飞行', key: '9', icon: ico('<path d="M21 3L3 10l7 3 3 7z"/>') },
];

const CINE = [
  ['chase', 7], ['low', 6], ['side', 7], ['drone', 8], ['front', 6], ['first', 6], ['side', 6], ['chase', 6],
];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

export class CameraRig {
  constructor(camera, dom, rider, ground) {
    this.camera = camera;
    this.dom = dom;
    this.rider = rider;
    this.ground = ground; // (x,z)=>y
    this.mode = 'chase';
    this.time = 0;
    this.sideSign = 1;
    this.lookAt = new THREE.Vector3();
    this.lookInit = false;
    this.blend = { t: 1, dur: 0.9, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 60 };
    this.fovBase = 60;
    this.shake = 0;
    this.cineIdx = 0;
    this.cineT = 0;
    this.focus = new THREE.Vector3();
    this.lastFocus = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(-1, 0, 0);
    this.free = { yaw: 0, pitch: 0, keys: new Set(), drag: false, lx: 0, ly: 0 };
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 90;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.enabled = false;
    this._bindFree();
    this.onChange = null;
  }

  _bindFree() {
    const f = this.free, d = this.dom;
    d.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'free') return;
      f.drag = true; f.lx = e.clientX; f.ly = e.clientY;
      d.setPointerCapture?.(e.pointerId);
    });
    d.addEventListener('pointermove', (e) => {
      if (this.mode !== 'free' || !f.drag) return;
      f.yaw -= (e.clientX - f.lx) * 0.004;
      f.pitch = clamp(f.pitch - (e.clientY - f.ly) * 0.004, -1.5, 1.5);
      f.lx = e.clientX; f.ly = e.clientY;
    });
    const up = () => { f.drag = false; };
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);
    d.addEventListener('wheel', (e) => {
      if (this.mode !== 'free') return;
      const dir = _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(dir, -e.deltaY * 0.05);
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('keydown', (e) => { this.free.keys.add(e.code); });
    window.addEventListener('keyup', (e) => { this.free.keys.delete(e.code); });
    window.addEventListener('blur', () => this.free.keys.clear());
  }

  setMode(id, instant = false) {
    if (id === this.mode) {
      if (id === 'side') this.sideSign *= -1;
      return;
    }
    // 记录当前相机状态,用于过渡
    const b = this.blend;
    b.pos.copy(this.camera.position);
    b.quat.copy(this.camera.quaternion);
    b.fov = this.camera.fov;
    b.t = instant ? 1 : 0;
    b.dur = id === 'cine' ? 1.4 : 1.0;
    this.mode = id;
    this.controls.enabled = false;
    if (id === 'cine') { this.cineIdx = 0; this.cineT = 0; }
    if (id === 'free') {
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.free.yaw = e.y; this.free.pitch = e.x;
    }
    if (id === 'orbit') this.orbitPending = true;
    this.lookInit = false;
    if (this.onChange) this.onChange(id);
  }

  // 机位计算:返回 {pos, look, fov, roll}(look 为目标点)
  _shot(id, dt, st, out) {
    const F = this.focus, f = this.fwd, r = this.right;
    const sp = st.speed;
    const t = this.time;
    switch (id) {
      case 'chase': {
        const d = lerp(4.3, 6.2, clamp(sp / 22, 0, 1));
        const h = 1.65 + 0.15 * Math.sin(t * 0.4);
        out.pos.copy(F).addScaledVector(f, -d).addScaledVector(r, 0.35 + 0.25 * Math.sin(t * 0.25));
        out.pos.y = st.roadY + h + 0.2;
        out.look.copy(F).addScaledVector(f, 3.2).addScaledVector(r, 0.1);
        out.look.y = st.roadY + 1.25;
        out.fov = 56 + clamp(sp, 0, 25) * 0.45;
        break;
      }
      case 'first': {
        const h = this.rider.head;
        h.updateWorldMatrix(true, false);
        _v.set(0, 0.09, 0.05).applyMatrix4(h.matrixWorld);
        out.pos.copy(_v);
        // 前方偏下:能看到喙尖与路面
        h.getWorldQuaternion(_q);
        _v2.set(0, -0.02, 1).applyQuaternion(_q);
        // 与路线方向混合,避免头部抖动
        _v2.lerp(f, 0.55).normalize();
        out.look.copy(_v).addScaledVector(_v2, 20);
        out.fov = 82;
        break;
      }
      case 'side': {
        const lat = (st.sideLat || 5.6) * this.sideSign;
        out.pos.copy(F).addScaledVector(r, lat).addScaledVector(f, 1.2 * Math.sin(t * 0.35));
        out.pos.y = st.roadY + 1.15 + 0.2 * Math.sin(t * 0.3);
        out.look.copy(F).addScaledVector(f, 0.3);
        out.look.y = st.roadY + 1.2;
        out.fov = 38;
        break;
      }
      case 'front': {
        out.pos.copy(F).addScaledVector(f, 4.8 + 0.8 * Math.sin(t * 0.3)).addScaledVector(r, 0.9 * Math.sin(t * 0.2));
        out.pos.y = st.roadY + 1.05;
        out.look.copy(F);
        out.look.y = st.roadY + 1.4;
        out.fov = 48;
        break;
      }
      case 'drone': {
        const ang = Math.PI + t * 0.16;
        const R = 32;
        const base = Math.atan2(f.x, f.z);
        const a = base + ang;
        out.pos.set(F.x + Math.sin(a) * R, 0, F.z + Math.cos(a) * R);
        out.pos.y = st.roadY + 20 + 7 * Math.sin(t * 0.2);
        out.look.copy(F).addScaledVector(f, 4);
        out.look.y = st.roadY + 0.9;
        out.fov = 54;
        break;
      }
      case 'low': {
        out.pos.copy(F).addScaledVector(r, 2.3 + 0.5 * Math.sin(t * 0.3)).addScaledVector(f, 2.6 + 0.9 * Math.sin(t * 0.21 + 1));
        out.pos.y = st.roadY + 0.28;
        out.look.copy(F);
        out.look.y = st.roadY + 0.75;
        out.fov = 64;
        break;
      }
      default:
        break;
    }
  }

  update(dt, st) {
    // st: {focus, fwd, right, speed, roadY}
    this.time += dt;
    this.focus.copy(st.focus);
    this.fwd.copy(st.fwd);
    this.right.copy(st.right);
    const cam = this.camera;
    const b = this.blend;
    let id = this.mode;
    let target = this._tgt || (this._tgt = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 60 });

    if (id === 'cine') {
      this.cineT += dt;
      let [sid, dur] = CINE[this.cineIdx];
      if (this.cineT > dur) {
        this.cineIdx = (this.cineIdx + 1) % CINE.length;
        this.cineT = 0;
        [sid, dur] = CINE[this.cineIdx];
        b.pos.copy(cam.position); b.quat.copy(cam.quaternion); b.fov = cam.fov; b.t = 0; b.dur = 1.3;
        this.lookInit = false;
      }
      id = sid;
    }

    if (this._fp && (id === 'orbit' || id === 'free')) { this._fp = false; this.rider.setFirstPerson(false); }
    if (id === 'orbit') {
      const c = this.controls;
      if (this.orbitPending) {
        this.orbitPending = false;
        const p = new THREE.Vector3().copy(this.focus).addScaledVector(this.fwd, -3.2).addScaledVector(this.right, 3.6);
        p.y = st.roadY + 1.9;
        this.orbitStart = { pos: p };
        c.target.set(this.focus.x, st.roadY + 1.15, this.focus.z);
        this.lastFocus.copy(this.focus);
        b.t = 0; b.dur = 1.0;
        b.pos.copy(cam.position); b.quat.copy(cam.quaternion); b.fov = cam.fov;
        cam.position.copy(p);
        cam.fov = 50; cam.updateProjectionMatrix();
        c.update();
        this._orbitQ = cam.quaternion.clone();
        this._orbitP = cam.position.clone();
        c.enabled = false;
      }
      if (b.t < 1) {
        b.t = Math.min(1, b.t + dt / b.dur);
        const e = smoother(b.t);
        // 过渡中目标仍随车移动
        const delta = _v.subVectors(this.focus, this.lastFocus);
        this._orbitP.add(delta);
        c.target.add(delta);
        this.lastFocus.copy(this.focus);
        cam.position.lerpVectors(b.pos, this._orbitP, e);
        cam.quaternion.slerpQuaternions(b.quat, this._orbitQ, e);
        cam.fov = lerp(b.fov, 50, e);
        cam.updateProjectionMatrix();
        if (b.t >= 1) { c.enabled = true; c.update(); }
      } else {
        const delta = _v.subVectors(this.focus, this.lastFocus);
        cam.position.add(delta);
        c.target.add(delta);
        c.target.y = lerp(c.target.y, st.roadY + 1.15, 1 - Math.exp(-3 * dt));
        this.lastFocus.copy(this.focus);
        c.enabled = true;
        c.update();
      }
      this._clamp(cam, st);
      return;
    }

    if (id === 'free') {
      const f = this.free;
      const e = new THREE.Euler(f.pitch, f.yaw, 0, 'YXZ');
      cam.quaternion.setFromEuler(e);
      const k = f.keys;
      const sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? 60 : 14) * dt;
      const mv = _v.set(0, 0, 0);
      if (k.has('KeyW')) mv.z -= 1;
      if (k.has('KeyS')) mv.z += 1;
      if (k.has('KeyA')) mv.x -= 1;
      if (k.has('KeyD')) mv.x += 1;
      if (k.has('KeyE')) mv.y += 1;
      if (k.has('KeyQ')) mv.y -= 1;
      if (mv.lengthSq() > 0) {
        mv.normalize().multiplyScalar(sp);
        const wy = mv.y;
        mv.y = 0;
        mv.applyQuaternion(cam.quaternion);
        cam.position.add(mv);
        cam.position.y += wy;
      }
      this._clamp(cam, st);
      b.t = 1;
      return;
    }

    if (this._fp !== (id === 'first')) { this._fp = id === 'first'; this.rider.setFirstPerson(this._fp); }
    this._shot(id, dt, st, target);
    // 平滑注视点
    if (!this.lookInit) { this.lookAt.copy(target.look); this.lookInit = true; this._pos = target.pos.clone(); this._fov = target.fov; }
    const isFP = id === 'first';
    const lam = isFP ? 14 : id === 'chase' ? 7 : 9;
    this.lookAt.lerp(target.look, 1 - Math.exp(-lam * dt));
    if (isFP) {
      this._pos.copy(target.pos);
    } else {
      const pl = id === 'chase' ? 5.5 : id === 'drone' ? 3 : 12;
      this._pos.lerp(target.pos, 1 - Math.exp(-pl * dt));
    }
    this._fov = lerp(this._fov, target.fov, 1 - Math.exp(-4 * dt));
    const pos = this._pos.clone();
    // 速度抖动
    const k = clamp(st.speed / 25, 0, 1) * 0.012 * (id === 'first' ? 0.5 : 1);
    pos.x += Math.sin(this.time * 31) * k; pos.y += Math.sin(this.time * 37 + 1) * k;
    // 地面避让
    pos.y = Math.max(pos.y, this.ground(pos.x, pos.z) + (id === 'low' ? 0.12 : 0.5));
    _m.lookAt(pos, this.lookAt, _v2.set(0, 1, 0));
    _q.setFromRotationMatrix(_m);
    if (b.t < 1) {
      b.t = Math.min(1, b.t + dt / b.dur);
      const e = smoother(b.t);
      cam.position.lerpVectors(b.pos, pos, e);
      cam.quaternion.slerpQuaternions(b.quat, _q, e);
      cam.fov = lerp(b.fov, this._fov, e);
    } else {
      cam.position.copy(pos);
      cam.quaternion.copy(_q);
      cam.fov = this._fov;
    }
    // 竖屏时放宽垂直视角,保持画面内容
    if (cam.aspect < 1.2) cam.fov = Math.min(105, cam.fov * Math.pow(1.2 / cam.aspect, 0.7));
    cam.near = id === 'first' ? 0.03 : 0.15;
    cam.updateProjectionMatrix();
  }

  _clamp(cam, st) {
    const g = this.ground(cam.position.x, cam.position.z) + 0.6;
    if (cam.position.y < g) cam.position.y = g;
  }
}
