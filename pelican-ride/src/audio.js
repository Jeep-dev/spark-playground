// 程序化环境音:海浪、风、轮胎声,以及车铃。需要用户手势后才会启动。
export class Ambience {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
  }

  _noise(ctx, seconds = 4, color = 'pink') {
    const n = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    }
    // 首尾交叉淡化,保证循环无爆音
    const f = Math.floor(ctx.sampleRate * 0.1);
    for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[n - f + i] * (1 - t); }
    return buf;
  }

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    this.master.connect(ctx.destination);
    const loop = (buf, nodes, gainNode) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      let n = src;
      for (const x of nodes) { n.connect(x); n = x; }
      n.connect(gainNode);
      gainNode.connect(this.master);
      src.start(0, Math.random() * 3);
      return src;
    };
    const pink = this._noise(ctx, 6, 'pink'), brown = this._noise(ctx, 6, 'brown');
    // 海浪:低通噪声 + 缓慢涌动
    this.surfGain = ctx.createGain(); this.surfGain.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.4;
    loop(brown, [lp], this.surfGain);
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 3200; hp.Q.value = 0.5;
    loop(pink, [hp], this.hissGain);
    // 风
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.6;
    this.windFilter = bp;
    loop(pink, [bp], this.windGain);
    // 轮胎/链条低频
    this.rollGain = ctx.createGain(); this.rollGain.gain.value = 0;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 260;
    loop(brown, [lp2], this.rollGain);
    this.t = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.2);
  }

  // surf: 0..1 海浪响度(靠近海岸)  speed: m/s
  update(dt, speed, surf, night) {
    if (!this.ctx || !this.enabled) return;
    this.t += dt;
    const now = this.ctx.currentTime;
    // 浪涌:几个不同周期的叠加
    const swell = 0.55 + 0.25 * Math.sin(this.t * 0.5) + 0.2 * Math.sin(this.t * 0.83 + 1.3);
    this.surfGain.gain.setTargetAtTime(0.22 * surf * swell, now, 0.3);
    this.hissGain.gain.setTargetAtTime(0.035 * surf * (0.3 + swell * swell), now, 0.3);
    const w = Math.min(1, speed / 18);
    this.windGain.gain.setTargetAtTime(0.03 + 0.2 * w * w, now, 0.2);
    this.windFilter.frequency.setTargetAtTime(300 + 500 * w + 80 * Math.sin(this.t * 0.7), now, 0.3);
    this.rollGain.gain.setTargetAtTime(0.18 * Math.min(1, speed / 10), now, 0.2);
  }

  bell() {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [f, g] of [[2350, 0.14], [3560, 0.07], [4710, 0.04]]) {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      gn.gain.setValueAtTime(0, t);
      gn.gain.linearRampToValueAtTime(g, t + 0.004);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(gn); gn.connect(this.master);
      o.start(t); o.stop(t + 1.5);
    }
  }
}
