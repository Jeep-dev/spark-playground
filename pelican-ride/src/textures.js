// 程序化贴图:沥青路面、羽毛、棕榈叶、招牌
import * as THREE from 'three';
import { mulberry32 } from './util.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function makeAsphaltTextures() {
  const W = 256, Hh = 512;
  const rnd = mulberry32(7);
  const cm = canvas(W, Hh), cr = canvas(W, Hh), cb = canvas(W, Hh);
  const m = cm.getContext('2d'), r = cr.getContext('2d'), b = cb.getContext('2d');
  m.fillStyle = '#4a4745'; m.fillRect(0, 0, W, Hh);
  r.fillStyle = '#d8d8d8'; r.fillRect(0, 0, W, Hh);
  b.fillStyle = '#808080'; b.fillRect(0, 0, W, Hh);
  // 路面整体明暗斑块
  for (let i = 0; i < 40; i++) {
    const x = rnd() * W, y = rnd() * Hh, w = 20 + rnd() * 80, h = 20 + rnd() * 120;
    const g = Math.floor(60 + rnd() * 22);
    m.fillStyle = `rgba(${g},${g},${g + 1},0.25)`;
    m.fillRect(x, y, w, h);
    m.fillRect(x - W, y, w, h); // 环绕
  }
  // 车辙(车道中心稍深,发亮的磨光痕)
  for (const cx of [0.321, 0.679]) {
    for (const [off, wd, col] of [[-0.045, 0.045, 'rgba(25,25,26,0.28)'], [0.045, 0.045, 'rgba(25,25,26,0.28)'], [0, 0.04, 'rgba(90,90,92,0.15)']]) {
      m.fillStyle = col;
      m.fillRect((cx + off - wd / 2) * W, 0, wd * W, Hh);
    }
  }
  // 颗粒
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * W, y = rnd() * Hh;
    const l = rnd();
    const g = Math.floor(l < 0.5 ? 34 + rnd() * 26 : 80 + rnd() * 44);
    m.fillStyle = `rgba(${g},${g - 1},${g - 3},${0.18 + rnd() * 0.3})`;
    m.fillRect(x, y, 1 + rnd() * 1.2, 1 + rnd() * 1.2);
    const bg = Math.floor(rnd() * 255);
    b.fillStyle = `rgba(${bg},${bg},${bg},0.5)`;
    b.fillRect(x, y, 1.5, 1.5);
  }
  // 裂缝与补丁
  m.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    let x = rnd() * W, y = rnd() * Hh;
    m.strokeStyle = 'rgba(15,15,15,0.55)';
    b.strokeStyle = 'rgba(20,20,20,0.9)';
    m.beginPath(); b.beginPath();
    m.moveTo(x, y); b.moveTo(x, y);
    const n = 6 + Math.floor(rnd() * 14);
    for (let k = 0; k < n; k++) {
      x += (rnd() - 0.5) * 18; y += (rnd() - 0.2) * 22;
      m.lineTo(x, y); b.lineTo(x, y);
    }
    m.stroke(); b.stroke();
  }
  for (let i = 0; i < 3; i++) {
    const x = rnd() * W * 0.7, y = rnd() * Hh, w = 24 + rnd() * 60, h = 16 + rnd() * 40;
    const gr = m.createRadialGradient(x + w / 2, y + h / 2, 2, x + w / 2, y + h / 2, Math.max(w, h) * 0.6);
    gr.addColorStop(0, 'rgba(30,29,30,0.26)'); gr.addColorStop(1, 'rgba(30,29,30,0)');
    m.fillStyle = gr;
    m.fillRect(x - w, y - h, w * 3, h * 3);
  }
  // 路面标线: 路宽 10.6m(u: 0..1)
  const line = (u, wm, col, dash) => {
    const x = u * W, w = (wm / 10.6) * W;
    m.fillStyle = col;
    r.fillStyle = '#9a9a9a';
    if (!dash) {
      m.fillRect(x - w / 2, 0, w, Hh);
      r.fillRect(x - w / 2, 0, w, Hh);
    }
  };
  // 白色边线(略有磨损,透出沥青)
  const worn = (u, wm, col) => {
    const x = u * W, w = (wm / 10.6) * W;
    for (let y = 0; y < Hh; y += 2) {
      const a = 0.82 + rnd() * 0.18;
      m.fillStyle = col.replace('A', a.toFixed(2));
      m.fillRect(x - w / 2, y, w, 2);
      r.fillStyle = '#a8a8a8';
      r.fillRect(x - w / 2, y, w, 2);
    }
    // 磨损噪点
    for (let i = 0; i < 160; i++) {
      m.fillStyle = 'rgba(70,70,70,0.45)';
      m.fillRect(x - w / 2 + rnd() * w, rnd() * Hh, 1 + rnd() * 2, 1 + rnd() * 3);
    }
  };
  worn(0.5 - 0.013, 0.12, 'rgba(238,200,40,A)');
  worn(0.5 + 0.013, 0.12, 'rgba(238,200,40,A)');
  worn(0.5 - 3.9 / 10.6, 0.14, 'rgba(232,232,228,A)');
  worn(0.5 + 3.9 / 10.6, 0.14, 'rgba(232,232,228,A)');
  line; // 保持引用,避免 tree-shake 警告

  const map = new THREE.CanvasTexture(cm);
  map.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(cr);
  const bump = new THREE.CanvasTexture(cb);
  for (const t of [map, rough, bump]) {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { map, rough, bump };
}

// 鹈鹕羽毛:鳞片状羽片 + 羽枝纹,用于颜色(乘性)和凹凸
export function makeFeatherTextures() {
  const S = 512;
  const rnd = mulberry32(21);
  const cm = canvas(S, S), cb = canvas(S, S);
  const m = cm.getContext('2d'), b = cb.getContext('2d');
  m.fillStyle = '#c9c9c9'; m.fillRect(0, 0, S, S);
  b.fillStyle = '#808080'; b.fillRect(0, 0, S, S);
  const rows = 26, cols = 18;
  const rh = S / rows, cw = S / cols;
  for (let row = rows - 1; row >= -1; row--) {
    for (let col = -1; col <= cols; col++) {
      const cx = col * cw + (row % 2 ? cw / 2 : 0) + (rnd() - 0.5) * 3;
      const cy = row * rh + rh * 0.55;
      const base = 170 + rnd() * 70;
      // 羽片
      const g = m.createLinearGradient(cx, cy - rh, cx, cy + rh * 0.9);
      g.addColorStop(0, `rgb(${base - 38},${base - 38},${base - 38})`);
      g.addColorStop(0.7, `rgb(${base},${base},${base})`);
      g.addColorStop(1, `rgb(${base + 14},${base + 14},${base + 14})`);
      m.fillStyle = g;
      m.beginPath();
      m.ellipse(cx, cy, cw * 0.62, rh * 0.95, 0, 0, Math.PI * 2);
      m.fill();
      m.strokeStyle = 'rgba(30,30,30,0.35)';
      m.lineWidth = 1;
      m.stroke();
      // 羽轴
      m.strokeStyle = 'rgba(255,255,255,0.35)';
      m.beginPath(); m.moveTo(cx, cy - rh * 0.8); m.lineTo(cx, cy + rh * 0.8); m.stroke();
      // 羽枝
      m.strokeStyle = 'rgba(40,40,40,0.14)';
      for (let k = -4; k <= 4; k++) {
        m.beginPath();
        m.moveTo(cx, cy - rh * 0.6 + k * 1.2);
        m.lineTo(cx + k * cw * 0.12, cy + rh * 0.8);
        m.stroke();
      }
      // 凹凸
      const bg = b.createLinearGradient(cx, cy - rh, cx, cy + rh);
      bg.addColorStop(0, '#585858'); bg.addColorStop(0.75, '#a0a0a0'); bg.addColorStop(1, '#f0f0f0');
      b.fillStyle = bg;
      b.beginPath();
      b.ellipse(cx, cy, cw * 0.62, rh * 0.95, 0, 0, Math.PI * 2);
      b.fill();
    }
  }
  const map = new THREE.CanvasTexture(cm);
  map.colorSpace = THREE.SRGBColorSpace;
  const bump = new THREE.CanvasTexture(cb);
  for (const t of [map, bump]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { map, bump };
}

// 棕榈叶:长度沿 u,横向沿 v
export function makePalmFrond() {
  const w = 256, h = 96;
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const rnd = mulberry32(5);
  const mid = h / 2;
  for (let x = 6; x < w - 4; x += 2.6) {
    const t = x / w;
    const len = (h / 2 - 3) * (0.32 + 0.68 * Math.sin(Math.PI * Math.min(1, t * 1.12))) * (1 - 0.65 * t * t);
    for (const sgn of [-1, 1]) {
      const sweep = 10 + len * 0.45;
      const gr = 70 + rnd() * 60;
      g.strokeStyle = `rgb(${34 + rnd() * 30},${gr + 40},${22 + rnd() * 20})`;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x, mid);
      g.quadraticCurveTo(x + sweep * 0.5, mid + sgn * len * 0.7, x + sweep, mid + sgn * len);
      g.stroke();
    }
  }
  g.strokeStyle = '#8a7a45';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function makeSignTexture(lines, opt = {}) {
  const w = opt.w || 1024, h = opt.h || 256;
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = opt.bg || '#0b2a4a';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = opt.border || '#ffd45a';
  g.lineWidth = 10;
  g.strokeRect(14, 14, w - 28, h - 28);
  g.fillStyle = opt.fg || '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((ln, i) => {
    const size = (opt.sizes && opt.sizes[i]) || Math.floor((h - 60) / n * 0.82);
    g.font = `bold ${size}px "Helvetica Neue", Arial, sans-serif`;
    g.fillText(ln, w / 2, h * (i + 0.55) / n);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
