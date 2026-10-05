// 太平洋:半透明 PBR 水面(程序化波浪法线 + 菲涅尔 + 太阳闪光),深海底,远景山脉
import * as THREE from 'three';
import { extend } from './sky.js';
import { project, sampleRoute, L } from './route.js';
import { noise2, fbm, hex } from './util.js';

const WAVES = /* glsl */ `
varying vec3 vWPos;
vec3 waveNormal(vec2 p, float dist, out float steep2) {
  vec2 g = vec2(0.0);
  float t = uTime;
  // 域扭曲,打散规则条纹
  p += 4.0 * vec2(sin(p.y * 0.021 + t * 0.13), cos(p.x * 0.017 - t * 0.11));
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float wl = 110.0 * pow(0.7, fi);
    float ang = (fract(fi * 0.6180339 + 0.13) - 0.5) * 2.4;
    vec2 dir = vec2(cos(ang), sin(ang));
    float k = 6.2831853 / wl;
    float w = sqrt(9.81 * k);
    float steep = 0.032 + 0.016 * min(fi, 7.0);
    float fade = smoothstep(dist * 0.0022, dist * 0.006, wl);
    float ph = k * dot(dir, p) - w * t + fi * 5.31;
    g += dir * (steep * cos(ph)) * fade;
  }
  steep2 = length(g);
  return normalize(vec3(-g.x, 1.0, -g.y));
}
`;

export class Ocean {
  constructor(scene, atmosphere) {
    this.atm = atmosphere;
    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(...hex(0x0b5a68)),
      roughness: 0.075,
      metalness: 0.0,
      clearcoat: 0,
      envMapIntensity: 1.0,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
    });
    extend(mat, {
      key: 'ocean',
      vsDecl: 'varying vec3 vWPos;',
      vsAfterBegin: 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      fsDecl: WAVES,
      fsAfterNormal: /* glsl */ `
        {
          float dist = length(vWPos - cameraPosition);
          float stp;
          vec3 wn = waveNormal(vWPos.xz, dist, stp);
          // 远处向平面收敛,抑制闪烁
          wn = normalize(mix(wn, vec3(0.0, 1.0, 0.0), smoothstep(1200.0, 6000.0, dist)));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          // 浪尖白沫
          vec2 fp = vWPos.xz * 0.45 + vec2(uTime * 0.12, -uTime * 0.05);
          float fn = sin(fp.x * 1.3 + sin(fp.y * 1.7)) * sin(fp.y * 1.1 + sin(fp.x * 0.9)) * 0.5 + 0.5;
          fn = fn * (0.6 + 0.4 * sin(vWPos.x * 0.21 + vWPos.z * 0.17 + uTime * 0.3));
          float foam = smoothstep(0.42, 0.75, stp * (0.55 + 0.9 * fn)) * (1.0 - smoothstep(300.0, 1200.0, dist));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.68, 0.7), foam * 0.7);
          roughnessFactor = mix(roughnessFactor, 0.7, foam);
        }`,
      fsBeforeOpaque: /* glsl */ `
        {
          float dist = length(vWPos - cameraPosition);
          vec3 V = normalize(cameraPosition - vWPos);
          float ndv = clamp(V.y, 0.0, 1.0);
          float fr = pow(1.0 - ndv, 4.0);
          float a = mix(0.62, 1.0, fr);
          a = mix(a, 1.0, smoothstep(200.0, 1400.0, dist));
          // 次表面散射:逆光时浪尖透出青绿色
          vec3 L = uSunDirW;
          float back = pow(max(dot(-V, L) * 0.5 + 0.5, 0.0), 3.0);
          vec3 sss = vec3(0.01, 0.12, 0.10) * back * max(L.y, 0.0) * 2.0;
          outgoingLight = (totalDiffuse + totalEmissiveRadiance + sss) * a + totalSpecular;
          diffuseColor.a = a;
        }`,
    });
    this.mat = mat;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000, 1, 1).rotateX(-Math.PI / 2), mat);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // 深海底
    const fm = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.002, 0.03, 0.045), roughness: 1, metalness: 0 });
    extend(fm, { key: 'seafloor' });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000, 1, 1).rotateX(-Math.PI / 2), fm);
    this.floor.position.y = -46;
    this.floor.frustumCulled = false;
    scene.add(this.floor);
  }
  follow(pos) {
    this.mesh.position.set(pos.x, 0, pos.z);
    this.floor.position.set(pos.x, -46, pos.z);
  }
}

// 远景山脉环:只在内陆侧起伏,海一侧是平静的地平线
export class FarMountains {
  constructor(scene) {
    const SEG = 360;
    this.SEG = SEG;
    const R0 = 3600, R1 = 5200;
    this.R0 = R0;
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const col = new Float32Array((SEG + 1) * 2 * 3);
    const idx = [];
    for (let i = 0; i < SEG; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    this.geo = g;
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false });
    this.mat = m;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);
    this.lastS = -1e9;
    this.hazeCol = new THREE.Color(0.5, 0.6, 0.7);
  }
  setHaze(c) {
    this.hazeCol.copy(c);
    this.lastS = -1e9;
  }
  update(camPos, s) {
    if (Math.abs(s - this.lastS) < 30 && this.lastCam && this.lastCam.distanceTo(camPos) < 30) return;
    this.lastS = s;
    this.lastCam = camPos.clone();
    const r = sampleRoute(s);
    // 内陆方向 = -right = (cos phi, 0, -sin phi)
    const ix = r.cosp, iz = -r.sinp;
    const pos = this.geo.attributes.position.array, col = this.geo.attributes.color.array;
    const R = this.R0;
    for (let i = 0; i <= this.SEG; i++) {
      const a = (i / this.SEG) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      const x = camPos.x + dx * R, z = camPos.z + dz * R;
      const inland = dx * ix + dz * iz; // -1..1
      const w = Math.max(0, inland + 0.25) / 1.25;
      const n = fbm(x * 0.00055, z * 0.00055, 4, 61);
      const ridge = 1 - Math.abs(2 * fbm(x * 0.0011 + 9, z * 0.0011, 3, 62) - 1);
      let h = (180 + 900 * n * n + 420 * ridge * ridge) * Math.pow(w, 1.4);
      // 海一侧只剩几乎看不见的岛屿
      h += 25 * Math.max(0, noise2(x * 0.004, z * 0.004, 63) - 0.72) * 8 * (1 - w);
      pos[i * 6] = x; pos[i * 6 + 1] = -60; pos[i * 6 + 2] = z;
      pos[i * 6 + 3] = x; pos[i * 6 + 4] = h - 60; pos[i * 6 + 5] = z;
      const t = Math.min(1, h / 900);
      const c0 = this.hazeCol;
      // 越高越偏深蓝紫(大气透视后),底部与雾融合
      const dark = 0.82 - 0.25 * t;
      col[i * 6] = c0.r * 1.0; col[i * 6 + 1] = c0.g * 1.0; col[i * 6 + 2] = c0.b * 1.0;
      col[i * 6 + 3] = c0.r * dark * 0.96; col[i * 6 + 4] = c0.g * dark; col[i * 6 + 5] = c0.b * dark * 1.04;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}
