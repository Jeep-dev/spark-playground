import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Atmosphere, SHARED, fmtHour } from './sky.js';
import { Terrain, FarTerrain, CH } from './terrain.js';
import { Ocean, FarMountains } from './ocean.js';
import { Rider } from './rider.js';
import { CameraRig } from './cameras.js';
import { Props } from './props.js';
import { Grass } from './grass.js';
import { Landmarks } from './landmarks.js';
import { Birds } from './birds.js';
import { UI } from './ui.js';
import { Ambience } from './audio.js';
import * as R from './route.js';
import { clamp, damp, lerp } from './util.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 渲染器
const canvas = $('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true, preserveDrawingBuffer: params.has('shot') });
} catch (e) {
  $('fatalMsg').textContent = '需要支持 WebGL 2 的浏览器:' + e.message;
  $('fatal').classList.add('on');
  throw e;
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.15, 14000);
camera.position.set(0, 80, 0);
scene.add(camera);

const atm = new Atmosphere(renderer, scene);
const ocean = new Ocean(scene, atm);
const far = new FarMountains(scene);
const terrain = new Terrain(scene, atm);
const farTerrain = new FarTerrain(scene, terrain.material);
const rider = new Rider(scene);
const props = new Props(scene);
const grass = new Grass(scene);
const landmarks = new Landmarks(scene, terrain);
const birds = new Birds(scene);

// ---------------------------------------------------------------- 状态
const H0 = 14.4, H1 = 18.9;
const hourAt = (s) => H0 + (H1 - H0) * clamp(s / R.L, 0, 1);
const st = {
  s: params.has('s') ? parseFloat(params.get('s')) : 40,
  speed: 0,
  dist: 0,
  lane: 2.4,
  hour: params.has('t') ? parseFloat(params.get('t')) : hourAt(40),
  zone: R.makeZone(),
  roll: 0,
  pitch: 0,
  grade: 0,
  time: 0,
  jumping: false,
};

// ---------------------------------------------------------------- 质量 / 后处理
const Q = {
  low: { dpr: 1, shadow: 1024, msaa: 0, bloom: false, density: 0.5, ext: 48 },
  medium: { dpr: 1.5, shadow: 2048, msaa: 2, bloom: true, density: 0.8, ext: 62 },
  high: { dpr: 2, shadow: 4096, msaa: 4, bloom: true, density: 1.0, ext: 78 },
};
let qName = params.get('q') || 'auto';
let qCur = qName === 'auto' ? 'medium' : qName;
let dprScale = 1;
let composer, renderPass, bloomPass, outputPass;
let bloomOn = true, shadowOn = true;

function buildComposer() {
  const q = Q[qCur];
  const w = innerWidth, h = innerHeight;
  const pr = Math.min(devicePixelRatio || 1, q.dpr) * dprScale;
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  if (composer) composer.dispose();
  const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: q.msaa });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  renderPass = new RenderPass(scene, camera);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.7, 0.92);
  outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);
  bloomPass.enabled = q.bloom && bloomOn;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function applyQuality(name) {
  qName = name;
  qCur = name === 'auto' ? (qCur === 'auto' ? 'medium' : qCur) : name;
  const q = Q[qCur];
  atm.setShadowSize(q.shadow);
  atm.setShadowExtent(q.ext);
  props.setDensity?.(q.density);
  grass.setDensity(q.density);
  buildComposer();
}

addEventListener('resize', () => buildComposer());

// ---------------------------------------------------------------- 骑行/镜头
const audio = new Ambience();
const startAudio = () => { audio.start(); };
addEventListener('pointerdown', startAudio, { once: true });
addEventListener('keydown', startAudio, { once: true });
const ground = (x, z) => {
  const p = R.project(x, z, st.s);
  const h = R.heightAt(p.s, p.d);
  return Math.max(h, 0.2);
};
const cams = new CameraRig(camera, canvas, rider, ground);

const ui = new UI({
  camera: (id) => { cams.setMode(id); },
  currentCamera: () => cams.mode,
  jump: (s, label) => jumpTo(s, label),
  hour: (h) => { st.hour = h; },
  journey: (j) => { if (!j) ui.state.hour = st.hour; },
  quality: (q) => applyQuality(q),
  shadow: (on) => { shadowOn = on; renderer.shadowMap.enabled = on; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); },
  bloom: (on) => { bloomOn = on; if (bloomPass) bloomPass.enabled = on && Q[qCur].bloom; },
  screenshot: () => screenshot(),
  audio: (on) => { audio.start(); audio.setEnabled(on); },
  bell: () => { audio.start(); audio.bell(); ui.toast('叮铃铃~'); },
});
cams.onChange = (id) => ui.setCamera(id);
ui.setCamera('chase');

function screenshot() {
  composer.render();
  canvas.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `pelican-ride-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  ui.toast('已保存截图');
}

// ---------------------------------------------------------------- 姿态
const tmpV = new THREE.Vector3();
const frame = { focus: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(), speed: 0, roadY: 0 };
let lastEnvH = -99;

function placeRider(dt) {
  // 注意:sampleRoute 返回的是共享对象,先取需要的辅助采样,最后再取主采样
  const e0 = R.sampleRoute(st.s - 0.55).e, e1 = R.sampleRoute(st.s + 0.55).e;
  st.grade = (R.sampleRoute(st.s + 8).e - R.sampleRoute(st.s - 8).e) / 16;
  const r = R.sampleRoute(st.s);
  const d = st.lane + 0.18 * Math.sin(st.time * 0.37);
  const x = r.x - r.cosp * d, z = r.z + r.sinp * d;
  const pitch = Math.atan2(e1 - e0, 1.1);
  st.pitch = damp(st.pitch, pitch, 6, dt);
  const rollT = clamp(-r.kappa * st.speed * st.speed / 9.81 * 0.95, -0.38, 0.38);
  st.roll = damp(st.roll, rollT, 3.5, dt);
  rider.root.position.set(x, r.e + 0.03, z);
  rider.root.rotation.order = 'YXZ';
  rider.root.rotation.set(-st.pitch, r.phi, 0);
  rider.lean.rotation.z = st.roll;
  rider.root.updateMatrixWorld(true);
  frame.fwd.set(r.sinp, 0, r.cosp);
  frame.right.set(-r.cosp, 0, r.sinp);
  frame.focus.set(0, 1.15, 0.0);
  rider.bike.localToWorld(frame.focus);
  frame.roadY = r.e;
  frame.sideLat = (st.s > R.LANDMARKS.ggb.s0 - 40 && st.s < R.LANDMARKS.ggb.s1 + 40) ? 13.5 : 5.6;
  frame.speed = st.speed;
  return { kappa: r.kappa, e: r.e, phi: r.phi };
}

function updateLighting(dt) {
  st.hour = ui.state.journey ? hourAt(st.s) : ui.state.hour;
  if (Math.abs(st.hour - atm.hour) > 0.0015) atm.setHour(st.hour);
  if (atm.lastEnvHour !== lastEnvH) {
    lastEnvH = atm.lastEnvHour;
    far.setHaze(atm.fogAway);
  }
  SHARED.uTime.value = st.time;
  R.getZone(st.s, st.zone);
  atm.setFogMul(lerp(atm.fogMul, st.zone.fog * (1.0 + 0.0 * atm.night), 1 - Math.exp(-0.8 * dt)) || 1);
}

// ---------------------------------------------------------------- 主循环
let last = performance.now();
let frameCount = 0, fpsAcc = 0, fpsN = 0;
let uiAcc = 0;
let ready = false;

function tick(now) {
  requestAnimationFrame(tick);
  if (!ready || params.has('manual')) return;
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (params.has('fixdt')) dt = parseFloat(params.get('fixdt'));
  step(dt);
  composer.render(dt);
  // 动态分辨率
  if (qName === 'auto') {
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1.5) {
      const ms = (fpsAcc / fpsN) * 1000;
      fpsAcc = 0; fpsN = 0;
      const old = dprScale;
      if (ms > 24 && dprScale > 0.55) dprScale = Math.max(0.55, dprScale - 0.15);
      else if (ms < 15 && dprScale < 1) dprScale = Math.min(1, dprScale + 0.1);
      if (dprScale !== old) buildComposer();
    }
  }
}

function step(dt) {
  const paused = ui.state.paused;
  const sdt = paused ? 0 : dt;
  st.time += dt;
  // 速度
  const targetV = paused ? 0 : ui.state.cruise * clamp(1 - st.grade * 3.2, 0.7, 1.3);
  st.speed = damp(st.speed, targetV, 1.2, dt);
  st.s += st.speed * sdt;
  st.dist += st.speed * sdt;
  if (st.s > R.L - 30 && !st.jumping) {
    jumpTo(0, '旅程重新开始', true);
  }
  const r = placeRider(dt);
  updateLighting(dt);
  rider.update(sdt, { speed: st.speed, kappa: r.kappa, grade: st.grade, pitch: st.pitch, roll: st.roll, night: atm.night });
  rider.root.updateMatrixWorld(true);
  cams.update(dt, frame);
  atm.follow(frame.focus, camera.position, dt);
  const sunOn = atm.sunLight.visible;
  terrain.update(st.s, atm.sun.dir, sunOn, 5);
  farTerrain.update(rider.root.position.x, rider.root.position.z, terrain.sMin, terrain.sMax);
  props.update?.(st.s, camera.position, dt, false, frame.focus);
  grass.update(st.s);
  landmarks.update?.(dt, st.s, camera.position, atm.night);
  birds.update?.(dt, st.s, st.time, frame);
  ocean.follow(camera.position);
  audio.update(dt, st.speed, clamp(1.15 - st.zone.e / 90, 0.25, 1) * (st.zone.edge > 120 ? 0.6 : 1), atm.night);
  far.update(camera.position, st.s);

  uiAcc += dt;
  if (uiAcc > 0.1) {
    uiAcc = 0;
    ui.update({ speed: st.speed, hour: st.hour, dist: st.dist, sunElev: atm.elevDeg, s: st.s });
    ui.setPlace(R.placeAt(st.s));
  }
}

async function jumpTo(s, label, restart) {
  if (st.jumping) return;
  st.jumping = true;
  ui.fade(true);
  await new Promise((r) => setTimeout(r, 380));
  st.s = clamp(s, 0, R.L - 60);
  if (restart) st.dist = 0;
  st.hour = ui.state.journey ? hourAt(st.s) : st.hour;
  atm.setHour(st.hour, true);
  placeRider(0.016);
  await terrain.warm(st.s, atm.sun.dir, atm.sunLight.visible);
  props.update?.(st.s, camera.position, 0.016, true, frame.focus);
  grass.update(st.s, true);
  cams.lookInit = false;
  const b = cams.blend; b.t = 1;
  ui.fade(false);
  if (label) ui.toast(label);
  st.jumping = false;
}

// ---------------------------------------------------------------- 启动
async function boot() {
  ui.loading(0.05, '架设天空与光照');
  applyQuality(qName);
  if (params.has('cam')) cams.setMode(params.get('cam'), true);
  if (params.has('pause')) ui.setPaused(true);
  if (params.has('v')) { ui.setCruise(parseFloat(params.get('v'))); st.speed = ui.state.cruise; }
  else st.speed = 0;
  if (params.has('t')) { ui.state.journey = false; ui.setJourney(false); ui.state.hour = st.hour; ui.setHourSlider(st.hour); }
  if (params.has('hide')) document.body.classList.add('hide-ui');
  atm.setHour(st.hour, true);
  far.setHaze(atm.fogAway);
  placeRider(0.016);
  ui.loading(0.1, '铺设海岸公路与地形');
  await terrain.warm(st.s, atm.sun.dir, atm.sunLight.visible, (p) => ui.loading(0.1 + 0.8 * p));
  props.update?.(st.s, camera.position, 0.016, true, frame.focus);
  grass.update(st.s, true);
  ui.loading(0.9, '摆放相机');
  // 把相机直接摆到追尾位置
  cams.lookInit = false;
  ready = true;
  for (let i = 0; i < 3; i++) step(0.016);
  cams.blend.t = 1;
  // 在加载画面下先渲染一帧,提前编译着色器,避免进入场景后卡顿
  ui.loading(0.94, '编译着色器与光照');
  await new Promise((r) => setTimeout(r, 40));
  composer.render();
  await new Promise((r) => setTimeout(r, 40));
  ui.loading(1, '就绪');
  ui.loaded();
  ui.hint('拖动画面旋转视角(环绕模式) · 数字键 1–9 切换机位 · ⚙ 调整时间与画质');
  window.__pelican = {
    ready: true, st, atm, cams, rider, terrain, camera, renderer, scene, R,
    setS: (s) => jumpTo(s), setHour: (h) => { ui.setJourney(false); ui.state.hour = h; st.hour = h; ui.setHourSlider(h); },
    stepN: (n, dt = 0.033) => { for (let i = 0; i < n; i++) step(dt); },
    render: () => composer.render(),
    frame: (n = 1, dt = 0.033) => { for (let i = 0; i < n; i++) step(dt); composer.render(); return true; },
    // 调试:以车体局部坐标摆放自由相机
    view: (cp, tp, fov = 40) => {
      cams.setMode('free', true);
      rider.root.updateMatrixWorld(true);
      const p = rider.bike.localToWorld(new THREE.Vector3(...cp));
      const t = rider.bike.localToWorld(new THREE.Vector3(...tp));
      camera.position.copy(p);
      const m = new THREE.Matrix4().lookAt(p, t, new THREE.Vector3(0, 1, 0));
      const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
      cams.free.yaw = e.y; cams.free.pitch = e.x;
      camera.fov = fov; camera.updateProjectionMatrix();
    },
  };
  last = performance.now();
  requestAnimationFrame(tick);
}

boot().catch((e) => {
  console.error(e);
  ui.fatal(String(e && e.message ? e.message : e));
});
