// 天空、太阳位置、光照、IBL 环境与大气雾
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { clamp, lerp, smoothstep } from './util.js';

// ------------------------------------------------------------------ 共享 uniform & 材质扩展
export const SHARED = {
  uTime: { value: 0 },
  uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
  uFogSunCol: { value: new THREE.Color(1, 0.8, 0.6) },
  uNight: { value: 0 },
};

const FOG_FRAG = /* glsl */ `
#ifdef USE_FOG
  float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  vec3 vdW = normalize( transpose( mat3( viewMatrix ) ) * ( - vViewPosition ) );
  float sg = pow( max( dot( vdW, uSunDirW ), 0.0 ), 4.0 );
  vec3 fogC = mix( fogColor, uFogSunCol, sg );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogC, fogFactor );
#endif
`;

// 给 MeshStandard/Physical 材质注入:雾(太阳散射)+ 可选自定义片段
export function extend(mat, o = {}) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SHARED);
    if (o.uniforms) Object.assign(shader.uniforms, o.uniforms);
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', `#include <common>\nuniform float uTime;\n${o.vsDecl || ''}`);
    if (o.vsAfterBegin) vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${o.vsAfterBegin}`);
    fs = fs.replace(
      '#include <common>',
      `#include <common>\nuniform float uTime;\nuniform vec3 uSunDirW;\nuniform vec3 uFogSunCol;\nuniform float uNight;\n${o.fsDecl || ''}`
    );
    if (o.fsAfterColor) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n${o.fsAfterColor}`);
    if (o.fsAfterNormal) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${o.fsAfterNormal}`);
    if (o.fsAfterLights) fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${o.fsAfterLights}`);
    if (o.fsBeforeOpaque) fs = fs.replace('#include <opaque_fragment>', `${o.fsBeforeOpaque}\n#include <opaque_fragment>`);
    fs = fs.replace('#include <fog_fragment>', FOG_FRAG);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => o.key || 'ext-default';
  return mat;
}

// ------------------------------------------------------------------ 太阳位置
const LAT = (36.5 * Math.PI) / 180;
const DEC = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + 213)) / 365); // 8 月初
export function sunAt(hour, out = { elev: 0, az: 0, dir: new THREE.Vector3() }) {
  const H = ((hour - 12) * 15 * Math.PI) / 180;
  const sinE = Math.sin(LAT) * Math.sin(DEC) + Math.cos(LAT) * Math.cos(DEC) * Math.cos(H);
  const elev = Math.asin(clamp(sinE, -1, 1));
  const cosA = (Math.sin(DEC) - sinE * Math.sin(LAT)) / (Math.cos(elev) * Math.cos(LAT));
  let az = Math.acos(clamp(cosA, -1, 1));
  if (H > 0) az = Math.PI * 2 - az; // 下午太阳在西侧
  out.elev = elev;
  out.az = az;
  // x=东, z=南 => 北为 -z
  out.dir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az));
  return out;
}

export const fmtHour = (h) => {
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

const ENV_I = 0.8;
// ------------------------------------------------------------------ Atmosphere
export class Atmosphere {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.hour = 16;
    this.sun = sunAt(16);

    // 显示用天空(带太阳盘和云)
    this.sky = new Sky();
    this.sky.scale.setScalar(9000);
    this.sky.material.uniforms.cloudCoverage.value = 0.42;
    this.sky.material.uniforms.cloudDensity.value = 0.5;
    this.sky.material.uniforms.cloudScale.value = 0.00022;
    this.sky.material.uniforms.cloudElevation.value = 0.55;
    scene.add(this.sky);

    // 环境光用天空(不含太阳盘)+ 地面反射
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(9000);
    this.envSky.material.uniforms.showSunDisc.value = 0;
    this.envScene.add(this.envSky);
    this.envGround = new THREE.Mesh(
      new THREE.CircleGeometry(4000, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x806a50 })
    );
    this.envGround.position.y = -2;
    this.envScene.add(this.envGround);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.lastEnvHour = -99;

    // 太阳光
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = true;
    const sh = this.sunLight.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.near = 20;
    sh.camera.far = 900;
    sh.bias = -0.0003;
    sh.normalBias = 0.05;
    sh.radius = 3;
    this.shadowExtent = 62;
    this.setShadowExtent(62);
    scene.add(this.sunLight, this.sunLight.target);

    scene.fog = new THREE.FogExp2(0xaabbcc, 0.0006);
    this.fogBase = 0.0006;
    this.fogMul = 1;

    // 雾色探针
    this.probeRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType });
    this.probeCam = new THREE.PerspectiveCamera(20, 1, 0.1, 100);
    this.probeBuf = new Float32Array(4 * 4 * 4);
    this.fogAway = new THREE.Color();
    this.fogToward = new THREE.Color();

    this.setHour(16, true);
  }

  setShadowExtent(e) {
    this.shadowExtent = e;
    const c = this.sunLight.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.updateProjectionMatrix();
  }

  setShadowSize(n) {
    const sh = this.sunLight.shadow;
    sh.mapSize.set(n, n);
    if (sh.map) { sh.map.dispose(); sh.map = null; }
  }

  // 更新太阳/天空/光照,force 时重新生成 IBL
  setHour(hour, force = false) {
    this.hour = hour;
    const s = sunAt(hour, this.sun);
    const elevDeg = (s.elev * 180) / Math.PI;
    this.elevDeg = elevDeg;
    const sinE = Math.max(Math.sin(s.elev), 0.035);
    // 大气透射:地平线附近偏红
    const T = [Math.exp(-0.06 * (1 / sinE - 1)), Math.exp(-0.12 * (1 / sinE - 1)), Math.exp(-0.26 * (1 / sinE - 1))];
    const vis = smoothstep(-2.5, 3.5, elevDeg);
    this.night = 1 - smoothstep(-6, 5, elevDeg); // 0 白天 1 黄昏后
    SHARED.uNight.value = this.night;
    this.sunLight.color.setRGB(T[0], T[1], T[2]);
    this.sunLight.intensity = 34 * vis;
    this.sunLight.visible = vis > 0.001;
    this.sunLight.castShadow = vis > 0.02;
    SHARED.uSunDirW.value.copy(s.dir);

    // 天空参数
    const skyDir = s.dir.clone();
    if (skyDir.y < 0.01) { skyDir.y = 0.01; skyDir.normalize(); } // Preetham 不处理太阳在地平线下
    const lowSun = 1 - smoothstep(0, 28, elevDeg);
    for (const sk of [this.sky, this.envSky]) {
      const u = sk.material.uniforms;
      u.sunPosition.value.copy(skyDir);
      u.turbidity.value = lerp(2.6, 7.5, lowSun);
      u.rayleigh.value = lerp(1.1, 2.6, lowSun);
      u.mieCoefficient.value = lerp(0.004, 0.006, lowSun);
      u.mieDirectionalG.value = lerp(0.8, 0.9, lowSun);
    }
    this.refreshEnv(force);
    // 自动曝光:按地面总照度(太阳 + 天空)补偿,保留一部分"黄昏更暗"的观感
    const g = this.fogAway;
    const eSky = Math.PI * (g.r * 0.3 + g.g * 0.59 + g.b * 0.11) * 0.7 * ENV_I;
    const eSun = this.sunLight.intensity * Math.max(Math.sin(s.elev), 0) * 0.9;
    this.exposure = clamp(0.115 * Math.pow(35 / Math.max(eSun + eSky, 0.5), 0.78), 0.08, 3.5);
    this.renderer.toneMappingExposure = this.exposure;
  }

  refreshEnv(force) {
    if (!force && Math.abs(this.hour - this.lastEnvHour) < 0.02) return;
    this.lastEnvHour = this.hour;
    // 先探针取雾色(此时 envGround 颜色用占位)
    this.sampleFog();
    // 地面反射 ≈ 雾色(暖化) * 反照率
    const g = this.fogAway;
    this.envGround.material.color.setRGB(g.r * 0.85 + 0.01, g.g * 0.7 + 0.008, g.b * 0.5 + 0.006);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = ENV_I;
    this.scene.fog.color.copy(this.fogAway);
    SHARED.uFogSunCol.value.copy(this.fogToward);
    // 极暗时背景雾也要暗
  }

  sampleFog() {
    const r = this.renderer;
    const old = r.getRenderTarget();
    const cam = this.probeCam;
    const probe = (azOffset, elevDeg, color) => {
      const az = this.sun.az + azOffset;
      const el = (elevDeg * Math.PI) / 180;
      cam.position.set(0, 0, 0);
      cam.lookAt(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
      cam.updateMatrixWorld();
      r.setRenderTarget(this.probeRT);
      r.render(this.envScene, cam);
      r.readRenderTargetPixels(this.probeRT, 0, 0, 4, 4, this.probeBuf);
      let R = 0, G = 0, B = 0;
      for (let i = 0; i < 16; i++) { R += this.probeBuf[i * 4]; G += this.probeBuf[i * 4 + 1]; B += this.probeBuf[i * 4 + 2]; }
      color.setRGB(R / 16, G / 16, B / 16);
    };
    // 保证环境地面不会被探针看到
    const gOld = this.envGround.visible;
    this.envGround.visible = false;
    probe(Math.PI, 4, this.fogAway);
    probe(0.62, 7, this.fogToward);
    this.envGround.visible = gOld;
    r.setRenderTarget(old);
    // 略微去饱和并提亮,使远景更"海雾"
    const lumA = this.fogAway.r * 0.3 + this.fogAway.g * 0.59 + this.fogAway.b * 0.11;
    this.fogAway.lerp(new THREE.Color(lumA, lumA, lumA), 0.15);
    // 朝太阳一侧的雾色:限制相对亮度,避免日落时远山被过曝成白色
    const lumT = this.fogToward.r * 0.3 + this.fogToward.g * 0.59 + this.fogToward.b * 0.11;
    const lumB = Math.max(this.fogAway.r * 0.3 + this.fogAway.g * 0.59 + this.fogAway.b * 0.11, 1e-3);
    if (lumT > lumB * 4) this.fogToward.multiplyScalar((lumB * 4) / lumT);
  }

  // 每帧:让阴影相机/天空跟随
  follow(target, camPos, dt) {
    const dir = this.sun.dir;
    const L = this.sunLight;
    // 阴影相机对齐 texel,避免闪烁
    const size = L.shadow.mapSize.x;
    const texel = (this.shadowExtent * 2) / size;
    const dn = dir.clone().normalize();
    const up = Math.abs(dn.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dn).normalize();
    const up2 = new THREE.Vector3().crossVectors(dn, right).normalize();
    const tx = Math.round(target.dot(right) / texel) * texel;
    const ty = Math.round(target.dot(up2) / texel) * texel;
    const tz = target.dot(dn);
    const snapped = right.multiplyScalar(tx).add(up2.multiplyScalar(ty)).add(dn.clone().multiplyScalar(tz));
    L.target.position.copy(snapped);
    L.position.copy(snapped).addScaledVector(dir, 400);
    L.target.updateMatrixWorld();
    this.sky.position.copy(camPos);
    this.sky.material.uniforms.time.value += dt;
  }

  setFogMul(m) {
    this.fogMul = m;
    this.scene.fog.density = this.fogBase * m;
  }
}
