// HUD / 控制面板
import { MODES } from './cameras.js';
import { JUMPS, L, PLACES } from './route.js';
import { fmtHour } from './sky.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(cb) {
    this.cb = cb;
    this.state = { hour: 15, journey: true, cruise: 8, paused: false, quality: 'auto', shadow: true, bloom: true };
    this.placeKey = '';
    this._buildDock();
    this._buildRoute();
    this._bindPanel();
    this._bindKeys();
    this.hintTimer = null;
  }

  _buildDock() {
    const dock = $('dock');
    this.dockBtns = {};
    for (const m of MODES) {
      const b = document.createElement('button');
      b.innerHTML = `${m.icon}<span>${m.name}</span><kbd>${m.key}</kbd>`;
      b.title = `${m.name} (${m.key})`;
      b.addEventListener('click', () => this.cb.camera(m.id));
      dock.appendChild(b);
      this.dockBtns[m.id] = b;
    }
  }

  setCamera(id) {
    for (const k in this.dockBtns) this.dockBtns[k].classList.toggle('on', k === id);
  }

  _buildRoute() {
    const bar = $('bar');
    for (const j of JUMPS) {
      const t = document.createElement('div');
      t.className = 'tick';
      t.tabIndex = 0;
      t.style.left = `${(j.s / L) * 100}%`;
      t.innerHTML = `<label>${j.label}</label>`;
      t.addEventListener('click', (e) => { e.stopPropagation(); this.cb.jump(j.s, j.label); });
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.cb.jump(j.s, j.label); });
      bar.appendChild(t);
    }
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      this.cb.jump(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * L);
    });
  }

  _bindPanel() {
    const panel = $('panel');
    $('gear').addEventListener('click', () => panel.classList.toggle('open'));
    const s = this.state;
    const hour = $('inHour'), journey = $('inJourney'), speed = $('inSpeed'), pause = $('inPause');
    hour.addEventListener('input', () => {
      s.hour = parseFloat(hour.value);
      s.journey = false;
      journey.checked = false;
      $('outHour').textContent = fmtHour(s.hour);
      this.cb.hour(s.hour);
    });
    journey.addEventListener('change', () => { s.journey = journey.checked; this.cb.journey(s.journey); });
    speed.addEventListener('input', () => { s.cruise = parseFloat(speed.value); $('outSpeed').textContent = `${Math.round(s.cruise * 3.6)} km/h`; });
    pause.addEventListener('change', () => { s.paused = pause.checked; });
    $('inQuality').addEventListener('change', (e) => { s.quality = e.target.value; this.cb.quality(s.quality); });
    $('inShadow').addEventListener('change', (e) => { s.shadow = e.target.checked; this.cb.shadow(s.shadow); });
    $('inBloom').addEventListener('change', (e) => { s.bloom = e.target.checked; this.cb.bloom(s.bloom); });
    $('inAudio').addEventListener('change', (e) => { this.cb.audio(e.target.checked); });
    $('btnShot').addEventListener('click', () => this.cb.screenshot());
    $('btnFull').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    });
    $('btnHide').addEventListener('click', () => this.toggleHide());
    // 点击画布空白处收起面板
    $('view').addEventListener('pointerdown', () => panel.classList.remove('open'));
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.code !== 'Escape') return;
      const m = MODES.find((x) => x.key === e.key);
      if (m) { this.cb.camera(m.id); return; }
      switch (e.code) {
        case 'KeyC': {
          const i = MODES.findIndex((x) => x.id === this.cb.currentCamera());
          this.cb.camera(MODES[(i + 1) % MODES.length].id);
          break;
        }
        case 'Space': e.preventDefault(); this.setPaused(!this.state.paused); break;
        case 'ArrowUp': this.setCruise(this.state.cruise + 1); e.preventDefault(); break;
        case 'ArrowDown': this.setCruise(this.state.cruise - 1); e.preventDefault(); break;
        case 'KeyT': this.setJourney(!this.state.journey); break;
        case 'KeyH': this.toggleHide(); break;
        case 'KeyP': this.cb.screenshot(); break;
        case 'KeyB': this.cb.bell(); break;
        case 'Escape': $('panel').classList.remove('open'); break;
        default:
      }
    });
  }

  toggleHide() { document.body.classList.toggle('hide-ui'); }
  setPaused(p) { this.state.paused = p; $('inPause').checked = p; this.toast(p ? '已暂停' : '继续骑行'); }
  setCruise(v) {
    v = Math.max(0, Math.min(30, v));
    this.state.cruise = v;
    $('inSpeed').value = v;
    $('outSpeed').textContent = `${Math.round(v * 3.6)} km/h`;
    this.toast(`巡航速度 ${Math.round(v * 3.6)} km/h`);
  }
  setJourney(j) { this.state.journey = j; $('inJourney').checked = j; this.cb.journey(j); this.toast(j ? '时间随旅程推进' : '时间已固定'); }
  setHourSlider(h) { $('inHour').value = h; $('outHour').textContent = fmtHour(h); }

  toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove('show'), 1600);
  }

  hint(msg, ms = 6000) {
    const h = $('hint');
    h.textContent = msg;
    h.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => h.classList.remove('show'), ms);
  }

  setPlace(p) {
    const key = p.name + p.en;
    if (key === this.placeKey) return;
    this.placeKey = key;
    const el = $('place');
    el.style.opacity = 0;
    setTimeout(() => {
      $('placeName').textContent = p.name;
      $('placeEn').textContent = p.en;
      el.style.opacity = 1;
    }, 280);
  }

  update(d) {
    $('vSpeed').innerHTML = `${Math.round(d.speed * 3.6)}<i>km/h</i>`;
    $('vClock').textContent = fmtHour(d.hour);
    $('vDist').innerHTML = `${(d.dist / 1000).toFixed(2)}<i>km</i>`;
    $('vSun').innerHTML = `${Math.round(d.sunElev)}<i>°</i>`;
    const f = Math.max(0, Math.min(1, d.s / L)) * 100;
    $('barFill').style.width = `${f}%`;
    $('barDot').style.left = `${f}%`;
    if (this.state.journey) this.setHourSlider(d.hour);
  }

  loading(p, text) {
    $('loadBar').style.width = `${Math.round(p * 100)}%`;
    if (text) $('loadText').textContent = text;
  }
  loaded() { $('loading').classList.add('done'); setTimeout(() => ($('loading').style.display = 'none'), 900); }
  fatal(msg) { $('fatalMsg').textContent = msg; $('fatal').classList.add('on'); }
  fade(on) { $('fade').style.opacity = on ? 1 : 0; }
}
