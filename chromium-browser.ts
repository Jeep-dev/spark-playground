import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const HOME = process.env.HOME ?? "/data/data/com.termux/files/home";
const PREFIX = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
// A custom endpoint is useful for an already-running, isolated test browser.
// Automatic startup is deliberately limited to the default local endpoint.
const CDP_URL = process.env.PI_CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";
const DISPLAY = ":1";
const NOVNC_URL = "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale";
const PROFILE_DIR = join(HOME, ".config", "chromium-pi-browser");
const PAGE_ID_FILE = process.env.PI_CHROMIUM_PAGE_ID_FILE ?? join(HOME, ".vnc", "termux-browser-page-id");
const NOVNC_DIR = join(HOME, ".local", "share", "noVNC");
const WEBSOCKIFY_DIR = join(NOVNC_DIR, "utils", "websockify");
const SCREENSHOT_DIR = join(HOME, ".pi", "browser-screenshots");

type Page = { id: string; type: string; title?: string; url: string; webSocketDebuggerUrl?: string };
type Control = { ref: string; selector?: string; tag: string; name: string; type?: string; role?: string; expanded?: string; checked?: string; disabled: boolean; sensitive: boolean };
type Snapshot = {
  title: string; url: string; readyState: string; text: string; truncated: boolean;
  elements: Control[]; reasons: string[]; requiresUserAction: boolean; frames: number;
};
type Step = {
  action: string; target?: string; selector?: string; text?: string; key?: string; deltaY?: number;
  timeoutMs?: number; waitFor?: string; waitText?: string; waitState?: string;
};
type Params = Step & { steps?: Step[]; maxChars?: number; maxElements?: number; report?: string; tabId?: string; path?: string; gallery?: boolean; preview?: boolean };

function aborted(signal?: AbortSignal) { signal?.throwIfAborted(); }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
function deadlineSignal(ms: number, signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
async function responds(url: string, signal?: AbortSignal): Promise<boolean> {
  aborted(signal);
  try {
    const response = await fetch(url, { signal: deadlineSignal(1200, signal) });
    await response.body?.cancel();
    return response.ok;
  } catch { aborted(signal); return false; }
}
async function waitForServer(url: string, signal?: AbortSignal) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (await responds(url, signal)) return;
    await sleep(150, signal);
  }
  throw new Error(`Service did not start within 15 seconds: ${url}`);
}
async function detached(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { ...options, env: options.env ?? process.env, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
async function run(pi: ExtensionAPI, command: string, args: string[], signal?: AbortSignal) {
  const result = await pi.exec(command, args, { timeout: 15_000, signal });
  aborted(signal);
  if (result.code !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result.stdout;
}
/** Best effort only: a successful broadcast is not proof that the gallery indexed it. */
export async function requestMediaScan(pi: ExtensionAPI, path: string, signal?: AbortSignal) {
  aborted(signal);
  const uri = 'file://' + path;
  const quoted = "'" + uri.replace(/'/g, "'\\''") + "'";
  try {
    const scan = await pi.exec("rish", ["-c", `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${quoted}`], { timeout: 1500, signal });
    aborted(signal);
    return scan.code === 0 && !scan.killed ? "requested (gallery indexing may be delayed)" :
      "unavailable/timed out; image saved, gallery indexing not confirmed";
  } catch { aborted(signal); return "unavailable; image saved, gallery indexing not confirmed"; }
}
async function ensureDisplay(pi: ExtensionAPI, signal?: AbortSignal) {
  const listing = await pi.exec("vncserver", ["-list"], { timeout: 15_000, signal });
  aborted(signal);
  // TigerVNC can return code 1 for a successful listing.
  if (/^:1\s/m.test(listing.stdout)) return;
  await run(pi, "sh", ["-lc", 'rm -f "$HOME/.vnc/localhost:1.pid" "$TMPDIR/.X1-lock" "$TMPDIR/.X11-unix/X1"'], signal);
  await run(pi, "vncserver", [DISPLAY, "-localhost", "yes", "-SecurityTypes", "None", "-geometry", "900x1500", "-depth", "24", "-noxstartup"], signal);
}
async function ensureBrowser(pi: ExtensionAPI, signal?: AbortSignal) {
  if (await responds(`${CDP_URL}/json/version`, signal)) return;
  if (CDP_URL !== "http://127.0.0.1:9222") throw new Error(`Custom CDP endpoint is unavailable: ${CDP_URL}`);
  await ensureDisplay(pi, signal);
  aborted(signal);
  await detached(join(PREFIX, "bin", "chromium-browser"), [
    "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-session-crashed-bubble",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222",
    `--user-data-dir=${PROFILE_DIR}`, "--window-size=900,1500", "--window-position=0,0", "about:blank",
  ], { env: { ...process.env, DISPLAY } });
  await waitForServer(`${CDP_URL}/json/version`, signal);
}
async function ensureViewer(pi: ExtensionAPI, signal?: AbortSignal) {
  if (await responds(NOVNC_URL, signal)) return;
  if (!existsSync(join(NOVNC_DIR, "vnc.html")) || !existsSync(join(WEBSOCKIFY_DIR, "websockify", "__main__.py"))) {
    throw new Error(`noVNC is not installed at ${NOVNC_DIR}`);
  }
  await ensureDisplay(pi, signal);
  await detached("python", ["-m", "websockify", "--web", NOVNC_DIR, "127.0.0.1:6080", "127.0.0.1:5901"], {
    cwd: WEBSOCKIFY_DIR, env: { ...process.env, PYTHONPATH: WEBSOCKIFY_DIR },
  });
  await waitForServer(NOVNC_URL, signal);
}

/** One socket per selected tab; never replay a command after an uncertain failure. */
export class CDPConnection {
  private ws?: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }>();
  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  async connect(url: string, signal?: AbortSignal) {
    aborted(signal);
    this.close();
    const ws = this.ws = new WebSocket(url);
    ws.addEventListener("message", event => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      request.cleanup();
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const disconnected = () => {
      if (this.ws === ws) this.fail(new Error("Chromium CDP disconnected; an in-flight action may already have run. Inspect before retrying."));
    };
    ws.addEventListener("close", disconnected);
    ws.addEventListener("error", disconnected);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          ws.removeEventListener("open", opened);
          ws.removeEventListener("error", failed);
          ws.removeEventListener("close", failed);
          signal?.removeEventListener("abort", cancel);
        };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("Cannot connect to Chromium CDP")); };
        const cancel = () => { cleanup(); reject(signal?.reason); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("Chromium CDP connection timed out")); }, 4000);
        ws.addEventListener("open", opened, { once: true });
        ws.addEventListener("error", failed, { once: true });
        ws.addEventListener("close", failed, { once: true });
        signal?.addEventListener("abort", cancel, { once: true });
      });
    } catch (error) { this.close(); throw error; }
  }

  send(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 10_000): Promise<any> {
    aborted(signal);
    if (!this.open) return Promise.reject(new Error("Chromium CDP is disconnected; reconnect on the next operation"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      const finish = (error: Error) => { this.pending.delete(id); cleanup(); reject(error); };
      const cancel = () => finish(signal?.reason ?? new Error("Cancelled"));
      const timer = setTimeout(() => finish(new Error(`${method} timed out; the command may already have run. Inspect before retrying.`)), timeoutMs);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.ws!.send(JSON.stringify({ id, method, params })); }
      catch (error) { finish(error as Error); }
    });
  }
  private fail(error: Error) {
    for (const item of this.pending.values()) { item.cleanup(); item.reject(error); }
    this.pending.clear();
  }
  close() {
    this.fail(new Error("Chromium connection closed"));
    this.ws?.close();
    this.ws = undefined;
  }
}

async function evaluate<T>(client: CDPConnection, expression: string, signal?: AbortSignal, timeoutMs = 5000): Promise<T> {
  const result = await client.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs,
  }, signal, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Page JavaScript failed");
  }
  return result.result?.value as T;
}
const contextChanged = (error: unknown) => /execution context was destroyed|cannot find context|inspected target navigated/i.test(String(error));

// Kept in the page's main document. Refs point to actual nodes, never nth-child paths:
// a navigation or replaced node makes a ref stale instead of silently clicking a different element.
// No DOM attributes are written, so observing the page does not perturb React or mutation waits.
const DOM = String.raw`
  const storeKey = Symbol.for('pi.chromium.v3');
  const store = globalThis[storeKey] ||= {
    prefix: Math.random().toString(36).slice(2, 10), next: 0, refs: new Map(), ids: new WeakMap()
  };
  // DOM presence/innerText alone is not evidence of a currently displayed panel.
  // Ancestor results are cached for this one evaluation (the prelude runs fresh per call), so each
  // element's style is read once instead of once per descendant text node. Callers that scroll
  // must not reuse visible() results from before the scroll.
  const hiddenCache = new Map(), clipCache = new Map();
  const hiddenTree = el => {
    if (!el) return false;
    let hidden = hiddenCache.get(el);
    if (hidden === undefined) {
      const s = getComputedStyle(el);
      hidden = el.matches('[inert],[aria-hidden="true"]') || s.display === 'none' || s.contentVisibility === 'hidden' ||
        Number(s.opacity) === 0 || hiddenTree(el.parentElement);
      hiddenCache.set(el, hidden);
    }
    return hidden;
  };
  const suppressed = el => {
    if (hiddenTree(el)) return true;
    const s = getComputedStyle(el);
    return s.visibility === 'hidden' || s.visibility === 'collapse';
  };
  // The viewport area left to an element's content after every ancestor's overflow clipping.
  const clipOf = el => {
    if (!el) return { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    let clip = clipCache.get(el);
    if (!clip) {
      const s = getComputedStyle(el), clipX = /(hidden|clip|scroll|auto)/.test(s.overflowX), clipY = /(hidden|clip|scroll|auto)/.test(s.overflowY);
      clip = { ...clipOf(el.parentElement) };
      if (clipX || clipY) {
        const r = el.getBoundingClientRect();
        if (clipX) { clip.left = Math.max(clip.left, r.left); clip.right = Math.min(clip.right, r.right); }
        if (clipY) { clip.top = Math.max(clip.top, r.top); clip.bottom = Math.min(clip.bottom, r.bottom); }
      }
      clipCache.set(el, clip);
    }
    return clip;
  };
  const unclipped = (rect, parent) => {
    const clip = clipOf(parent);
    return Math.min(rect.right, clip.right) > Math.max(rect.left, clip.left) && Math.min(rect.bottom, clip.bottom) > Math.max(rect.top, clip.top);
  };
  const visible = el => el instanceof Element && !suppressed(el) &&
    Array.from(el.getClientRects()).some(r => unclipped(r, el.parentElement));
  const visibleText = (root, limit = 16001) => {
    const parts = []; let length = 0, visited = 0;
    const add = text => { if (length <= limit) { const chunk = text.slice(0, limit + 1 - length); parts.push(chunk); length += chunk.length; } };
    const walk = (node, depth) => {
      if (length > limit || ++visited > 30000 || depth > 200) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.parentElement || suppressed(node.parentElement)) return;
        const range = document.createRange(); range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some(r => unclipped(r, node.parentElement))) add(node.textContent.replace(/\s+/g, ' '));
        return;
      }
      if (!(node instanceof Element) || node.matches('script,style,noscript,template') || suppressed(node)) return;
      const block = !['inline','contents'].includes(getComputedStyle(node).display);
      if (block || node.tagName === 'BR') add('\n');
      for (const child of node.childNodes) { walk(child, depth + 1); if (length > limit || visited > 30000) break; }
      if (block) add('\n');
    };
    walk(root, 0);
    return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  const disabled = el => !!el.disabled || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[inert]');
  const sensitive = el => {
    if (!el) return false;
    const meta = ['type','name','autocomplete','aria-label','placeholder','id'].map(a => el.getAttribute(a) || '').join(' ');
    return el.matches('input[type="password"],input[autocomplete="one-time-code"]') ||
      /password|passcode|one-time-code|\botp\b|verification.?code|security.?code|密码|验证码|校验码/i.test(meta);
  };
  const nodesFor = selector => {
    if (selector.startsWith('@')) {
      const el = store.refs.get(selector);
      return el?.isConnected && el.ownerDocument === document ? [el] : [];
    }
    try { return Array.from(document.querySelectorAll(selector)); }
    catch { throw new Error('Invalid CSS selector: ' + selector); }
  };
  const find = (selector, optional = false) => {
    const all = nodesFor(selector), matches = all.filter(visible);
    if (matches.length > 1) throw new Error('Ambiguous selector (' + matches.length + ' visible matches). Use an exact @ref from the page result.');
    if (matches.length === 1) return matches[0];
    if (optional) return null;
    throw new Error(selector.startsWith('@') ? 'Stale or hidden element ref; read the page again.' : 'Element not found or not visible: ' + selector);
  };
  const refFor = el => {
    let ref = store.ids.get(el);
    if (!ref) { ref = '@' + store.prefix + ':' + (++store.next); store.ids.set(el, ref); }
    store.refs.set(ref, el);
    return ref;
  };
  const nameFor = el => (el.getAttribute('aria-label') ||
    (el.labels && Array.from(el.labels).map(l => visibleText(l, 180)).join(' ')) ||
    el.getAttribute('placeholder') || visibleText(el, 180) || el.getAttribute('name') || el.getAttribute('title') || '').trim().slice(0, 90);
  const semanticSelector = el => {
    const candidates = el.id ? ['#' + CSS.escape(el.id)] : [];
    for (const attr of ['data-testid','aria-label','name','placeholder']) {
      const value = el.getAttribute(attr);
      if (value) candidates.push(el.tagName.toLowerCase() + '[' + attr + '="' + CSS.escape(value) + '"]');
    }
    return candidates.find(s => { if (s.length > 180) return false; try { return document.querySelectorAll(s).length === 1; } catch { return false; } });
  };
  const hasVisible = selector => Array.from(document.querySelectorAll(selector)).some(visible);
  // A widget whose response token is filled has been passed and no longer gates the page.
  const solved = el => {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const token = p.querySelector('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]');
      if (token) return !!token.value;
    }
    return false;
  };
  // Image/puzzle challenges are never automated. Match reCAPTCHA by its bframe path only:
  // hCaptcha's checkbox frame has "recaptchacompat" in its URL and "challenge" in its title.
  const puzzle = () => hasVisible('iframe[src*="/recaptcha/"][src*="/bframe"],iframe[src*="hcaptcha"][src*="frame=challenge"]');
  const pendingWidget = () => Array.from(document.querySelectorAll(
    // Invisible reCAPTCHA/hCaptcha only show a badge; they are not a gate. Turnstile's iframe is
    // often inside a closed shadow root, so its light-DOM response input marks the widget.
    '.g-recaptcha:not([data-size="invisible"]),.h-captcha:not([data-size="invisible"]),.cf-turnstile,' +
    'iframe[src*="hcaptcha"][src*="frame=checkbox"],iframe[src*="challenges.cloudflare"],input[name="cf-turnstile-response"]'
  )).some(el => (el.type === 'hidden' ? !!el.parentElement && visible(el.parentElement) : visible(el)) && !solved(el));
  const reasonsFor = () => {
    const reasons = [], url = location.href;
    const challenge = /\/sorry\/|challenges\.cloudflare\./i.test(url) || typeof window._cf_chl_opt === 'object' ||
      puzzle() || pendingWidget();
    // Do not treat an ordinary mention of "email address" or "验证码" as a login wall.
    const heading = Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).filter(visible).map(el => visibleText(el, 500)).join(' ');
    if (challenge || /verify you are human|checking your browser|unusual traffic|人机验证/i.test(heading)) reasons.push('CAPTCHA or human verification');
    if (hasVisible('input[type="password"]') || (/\/(login|signin|sign-in)([/?#]|$)/i.test(url) && hasVisible('input[type="email"],input[autocomplete="username"]'))) reasons.push('login');
    if (Array.from(document.querySelectorAll('input')).some(el => visible(el) && el.type !== 'password' && sensitive(el))) reasons.push('MFA or verification code');
    if (/oauth|authorize|consent/i.test(url) && /allow|authorize|approve|consent|授权|同意/i.test(heading + ' ' + Array.from(document.querySelectorAll('button')).filter(visible).map(el => visibleText(el, 180)).join(' '))) reasons.push('authorization or consent');
    return reasons;
  };
  const guard = el => {
    if (el?.matches('iframe,frame')) throw new Error('Embedded frame fields require manual handling; main-document controls only.');
    if (sensitive(el)) throw new Error('Password, OTP and verification fields require manual input in noVNC.');
    if (el && (disabled(el) || el.readOnly)) throw new Error('Element is disabled or read-only.');
    const reasons = reasonsFor();
    if (reasons.some(r => r !== 'login')) throw new Error('Manual user action required: ' + reasons.join(', ') + '. Use check to retry automatic verification or open noVNC.');
  };
  // probe(true) marks the start of an action: quiet time is measured from it, so an effect that
  // lands a few ms after the click is not missed because the page had been quiet before.
  const probe = (action = false) => {
    let watch = store.watch;
    if (!watch) {
      watch = store.watch = { changed: Date.now(), touched: Date.now(), nodes: new WeakMap() };
      watch.observer = new MutationObserver(records => {
        const now = Date.now();
        for (const record of records) {
          const target = record.type === 'characterData' ? record.target.parentNode : record.target;
          let node = watch.nodes.get(target);
          if (!node) watch.nodes.set(target, node = { count: 0, first: now });
          // A node that keeps rewriting itself (clock, ticker) is background noise once it has changed
          // a few times, if it was already doing so before the current action (or there was none since
          // load); otherwise such pages never settle. A spinner started by the action and newly added
          // elements always count as progress.
          const noise = node.count++ >= 3 && (watch.action === undefined || node.first < watch.action) &&
            !Array.from(record.addedNodes).some(added => added.nodeType === Node.ELEMENT_NODE);
          if (!noise) watch.changed = now;
        }
      });
      watch.observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      // Kept between calls so background noise is already known at the next action; disconnects itself
      // after 15s idle even if the host cancels, disconnects or the tab becomes inactive.
      watch.timer = setInterval(() => {
        if (Date.now() - watch.touched > 15000) { watch.observer.disconnect(); clearInterval(watch.timer); if (store.watch === watch) delete store.watch; }
      }, 1000);
    }
    if (action) watch.changed = watch.action = Date.now();
    watch.touched = Date.now();
    return Date.now() - watch.changed;
  };
`;
const js = (body: string) => `(() => { ${DOM}\n${body}\n })()`;

async function snapshot(client: CDPConnection, selector: string | undefined, maxChars: number, maxElements: number, signal?: AbortSignal): Promise<Snapshot> {
  return evaluate(client, js(`
    const root = ${JSON.stringify(selector)} ? find(${JSON.stringify(selector)}) : document.body;
    if (!root) throw new Error('Document body is not available yet.');
    for (const [ref, el] of store.refs) if (!el.isConnected) store.refs.delete(ref);
    while (store.refs.size > 1000) store.refs.delete(store.refs.keys().next().value);
    const text = ${maxChars} > 0 ? visibleText(root, ${maxChars} + 1000) : '';
    const elements = [], controls = 'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="checkbox"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="radio"],[role="switch"],[role="combobox"],[role="slider"],[role="treeitem"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
    const candidates = ${maxElements} > 0 ? [...(root.matches(controls) ? [root] : []), ...root.querySelectorAll(controls)] : [];
    // Portalled menus are commonly last in DOM order; don't lose them to the limit.
    const overlay = el => !!el.closest('[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"],[popover]:popover-open');
    candidates.sort((a, b) => Number(overlay(b)) - Number(overlay(a)));
    for (const el of candidates) {
      // The cheap viewport test first: most links on a long page are off-screen.
      const rect = el.getBoundingClientRect();
      if (!${Boolean(selector)} && (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth)) continue;
      if (!visible(el)) continue;
      const secret = sensitive(el);
      elements.push({ ref: refFor(el), selector: semanticSelector(el), tag: el.tagName.toLowerCase(),
        name: secret ? '[sensitive field]' : nameFor(el), type: el instanceof HTMLInputElement ? el.type : undefined,
        role: el.getAttribute('role') || undefined, expanded: el.getAttribute('aria-expanded') ?? undefined,
        checked: el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? undefined,
        disabled: disabled(el), sensitive: secret });
      if (elements.length >= ${maxElements}) break;
    }
    const reasons = reasonsFor();
    return { title: document.title.slice(0, 240), url: location.href, readyState: document.readyState,
      text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars}, elements,
      reasons, requiresUserAction: reasons.length > 0, frames: document.querySelectorAll('iframe,frame').length };
  `), signal);
}

/** Read-only, so retrying is safe while a navigation replaces the execution context or body. */
async function inspect(client: CDPConnection, selector: string | undefined, maxChars: number, maxElements: number, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try { return await snapshot(client, selector, maxChars, maxElements, signal); }
    catch (error) {
      if (attempt >= 4 || !(contextChanged(error) || /Document body is not available/.test(String(error)))) throw error;
      await sleep(120, signal);
    }
  }
}

/** Poll in the host so navigation cannot strand a page-side promise. No blind sleep. */
async function waitForPage(client: CDPConnection, options: { selector?: string; text?: string; state?: string; timeoutMs: number; target?: boolean }, signal?: AbortSignal) {
  const until = Date.now() + options.timeoutMs;
  const explicit = !!(options.selector || options.text !== undefined);
  do {
    aborted(signal);
    try {
      const result = await evaluate<{ done: boolean }>(client, js(`
        const quiet = probe(), selector = ${JSON.stringify(options.selector)}, text = ${JSON.stringify(options.text)};
        let matches = true;
        if (selector) {
          const nodes = nodesFor(selector), shown = nodes.filter(visible), state = ${JSON.stringify(options.state ?? "visible")};
          if (${Boolean(options.target)} && shown.length > 1) throw new Error('Ambiguous selector; use an exact @ref.');
          matches = state === 'attached' ? nodes.length > 0 : state === 'detached' ? nodes.length === 0 :
            state === 'hidden' ? shown.length === 0 : shown.some(el => ${Boolean(options.target)} ? !disabled(el) : true);
        }
        // visibleText only rewrites whitespace, so every whitespace-free piece of the target must
        // already be in textContent: a ~100x cheaper test that rejects most polls before the full scan.
        if (text !== undefined) {
          const raw = document.body?.textContent ?? '';
          matches = matches && !!document.body && text.split(/\s+/).every(part => raw.includes(part)) &&
            visibleText(document.body, 200000).includes(text);
        }
        return { done: ${explicit} ? matches : document.readyState !== 'loading' && quiet >= 160 };
      `), signal, Math.max(100, Math.min(3000, until - Date.now())));
      if (result.done) return true;
    } catch (error) { if (!contextChanged(error)) throw error; }
    if (Date.now() >= until) break;
    await sleep(Math.min(80, until - Date.now()), signal);
  } while (Date.now() <= until);
  if (explicit) throw new Error(`Condition not met within ${options.timeoutMs}ms: ${options.selector ?? ""}${options.text !== undefined ? " text=" + JSON.stringify(options.text) : ""} (${options.state ?? "visible"}).`);
  return false;
}

async function click(client: CDPConnection, selector: string, signal?: AbortSignal) {
  const point = await evaluate<{ x: number; y: number; tag: string }>(client, js(`
    const el = find(${JSON.stringify(selector)}); guard(el); probe(true);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rects = Array.from(el.getClientRects());
    for (const r of rects) {
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      if (right <= left || bottom <= top) continue;
      for (const [fx, fy] of [[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]) {
        const x = left + (right-left)*fx, y = top + (bottom-top)*fy, hit = document.elementFromPoint(x, y);
        if (hit === el || el.contains(hit)) return { x, y, tag: el.tagName.toLowerCase() };
      }
    }
    throw new Error('Element is covered or outside the viewport; no click was sent. Read the page or dismiss the overlay.');
  `), signal);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, signal);
  await pressAt(client, point.x, point.y, signal);
  return `Clicked ${point.tag}`;
}
async function pressAt(client: CDPConnection, x: number, y: number, signal?: AbortSignal, holdMs = 0) {
  let pressed = false;
  try {
    aborted(signal);
    pressed = true; // The event may be delivered even if its acknowledgement is cancelled.
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, signal);
    if (holdMs) await sleep(holdMs, signal);
  } finally {
    // Release even after cancellation to avoid leaving a stuck mouse button.
    if (pressed && client.open) await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, undefined, 1500);
  }
  aborted(signal);
}

// US-layout virtual key codes. charCodeAt() is wrong for punctuation: "." is 46 (Delete),
// "'" is 39 (ArrowRight), "%" is 37 (ArrowLeft), etc., which page key handlers would misread.
const PUNCTUATION: Record<string, [code: string, keyCode: number]> = {
  "`": ["Backquote", 192], "~": ["Backquote", 192], "-": ["Minus", 189], "_": ["Minus", 189], "=": ["Equal", 187], "+": ["Equal", 187],
  "[": ["BracketLeft", 219], "{": ["BracketLeft", 219], "]": ["BracketRight", 221], "}": ["BracketRight", 221],
  "\\": ["Backslash", 220], "|": ["Backslash", 220], ";": ["Semicolon", 186], ":": ["Semicolon", 186], "'": ["Quote", 222], "\"": ["Quote", 222],
  ",": ["Comma", 188], "<": ["Comma", 188], ".": ["Period", 190], ">": ["Period", 190], "/": ["Slash", 191], "?": ["Slash", 191],
  "!": ["Digit1", 49], "@": ["Digit2", 50], "#": ["Digit3", 51], "$": ["Digit4", 52], "%": ["Digit5", 53],
  "^": ["Digit6", 54], "&": ["Digit7", 55], "*": ["Digit8", 56], "(": ["Digit9", 57], ")": ["Digit0", 48],
};
function characterKey(key: string) {
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
  if (/^\d$/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  const [code, keyCode] = PUNCTUATION[key] ?? ["", 0];
  return { key, code, keyCode, text: key };
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }, Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 }, Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 }, Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 }, End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 }, PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
function keyDefinition(chord: string) {
  const parts = chord === "+" ? ["+"] : chord.split("+");
  const key = parts.pop()!;
  let modifiers = 0;
  for (const part of parts) {
    const flag = ({ ctrl: 2, control: 2, alt: 1, shift: 8, meta: 4, cmd: 4 } as Record<string, number>)[part.toLowerCase()];
    if (!flag) throw new Error(`Unsupported key modifier: ${part}`);
    modifiers |= flag;
  }
  let definition = KEYS[key] ?? ([...key].length === 1 ? characterKey(key) : undefined);
  if (!definition) throw new Error(`Unsupported key: ${key}`);
  // Shift+a should type "A", as on a real keyboard.
  if (modifiers & 8 && /^[a-z]$/.test(definition.key)) definition = { ...definition, key: definition.key.toUpperCase(), text: definition.key.toUpperCase() };
  return { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode, modifiers,
    text: modifiers & (1 | 2 | 4) ? undefined : definition.text };
}
async function dispatchKey(client: CDPConnection, chord: string, signal?: AbortSignal) {
  const event = keyDefinition(chord);
  let pressed = false;
  try {
    aborted(signal);
    pressed = true;
    await client.send("Input.dispatchKeyEvent", { type: event.text ? "keyDown" : "rawKeyDown", ...event }, signal);
  }
  finally {
    if (pressed && client.open) {
      const { text: _text, ...up } = event;
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...up }, undefined, 1500);
    }
  }
  aborted(signal);
}
async function fill(client: CDPConnection, selector: string, text: string, signal?: AbortSignal) {
  const prepared = await evaluate<{ mode: string; ref: string }>(client, js(`
    const el = find(${JSON.stringify(selector)}); guard(el); probe(true);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); el.focus();
    if (document.activeElement !== el) throw new Error('Element could not receive focus.');
    const value = ${JSON.stringify(text)};
    if (el instanceof HTMLSelectElement) {
      const matches = Array.from(el.options).filter(o => o.value === value);
      const options = matches.length ? matches : Array.from(el.options).filter(o => o.text.trim() === value);
      if (options.length !== 1 || options[0].disabled) throw new Error('Select option is missing, ambiguous or disabled.');
      el.value = options[0].value;
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      if (!el.isConnected || el.value !== options[0].value) throw new Error('Selected value was changed by the page; inspect before submitting.');
      return { mode: 'select', ref: refFor(el) };
    }
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) throw new Error('Element is not editable.');
    if (el instanceof HTMLInputElement && !['text','search','email','url','tel','number'].includes(el.type)) throw new Error('Unsupported input type: ' + el.type);
    return { mode: 'insert', ref: refFor(el) };
  `), signal);
  if (prepared.mode === "select") return "Selected option";
  await dispatchKey(client, "Ctrl+a", signal);
  // Recheck focus/sensitivity after key events, which site handlers may intercept.
  await evaluate(client, js(`
    const el = find(${JSON.stringify(prepared.ref)}); guard(el);
    if (document.activeElement !== el) throw new Error('Focus changed before insertion; text was not sent.');
    return true;
  `), signal);
  if (text) await client.send("Input.insertText", { text }, signal);
  else await dispatchKey(client, "Backspace", signal);
  const verified = await evaluate<boolean>(client, js(`
    const el = find(${JSON.stringify(prepared.ref)}, true);
    return !!el && (el.isContentEditable ? el.innerText.replace(/\\r\\n/g, '\\n') : el.value) === ${JSON.stringify(text.replace(/\r\n/g, "\n"))};
  `), signal);
  if (!verified) throw new Error("Text was inserted, but the resulting value differs or the element was replaced. Inspect before submitting; no further batch steps were run.");
  return "Filled and verified";
}
async function press(client: CDPConnection, selector: string | undefined, key: string, signal?: AbortSignal) {
  await evaluate(client, js(`
    const el = ${JSON.stringify(selector)} ? find(${JSON.stringify(selector)}) : document.activeElement;
    guard(el); probe(true);
    if (${Boolean(selector)}) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); el.focus();
      if (document.activeElement !== el) throw new Error('Element could not receive keyboard focus.');
    }
    return true;
  `), signal);
  await dispatchKey(client, key, signal);
  return `Pressed ${key}`;
}

async function listTargets(signal?: AbortSignal): Promise<Page[]> {
  const response = await fetch(`${CDP_URL}/json/list`, { signal: deadlineSignal(3000, signal) });
  if (!response.ok) throw new Error(`Cannot list Chromium targets: HTTP ${response.status}`);
  return await response.json() as Page[];
}

// ---- Automatic human-verification checkbox ----
// Only the single "I am human" checkbox of these widgets is clicked. Image/puzzle challenges,
// sliders and other CAPTCHAs are left to the user via noVNC. Set PI_CHROMIUM_AUTO_VERIFY=0 to disable.
const CAPTCHA = "CAPTCHA or human verification";
const AUTO_VERIFY = process.env.PI_CHROMIUM_AUTO_VERIFY !== "0";
const VERIFY_TIMEOUT_MS = 25_000;
type DomNode = {
  nodeId: number; backendNodeId: number; nodeName: string; localName?: string; attributes?: string[]; frameId?: string;
  children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode;
};
type Widget = { name: string; frame: RegExp; checkbox: (node: DomNode) => boolean; fallbackX: number };
const WIDGETS: Widget[] = [
  { name: "Cloudflare Turnstile", frame: /^https:\/\/challenges\.cloudflare\.com\//,
    checkbox: node => node.localName === "input" && attr(node, "type") === "checkbox", fallbackX: 30 },
  { name: "reCAPTCHA", frame: /^https:\/\/(www\.)?(google\.com|recaptcha\.net)\/recaptcha\/(api2|enterprise)\/anchor\?(?!.*size=invisible)/,
    checkbox: node => attr(node, "id") === "recaptcha-anchor", fallbackX: 27 },
  { name: "hCaptcha", frame: /^https:\/\/[\w.-]*hcaptcha\.com\/.*#.*frame=checkbox/,
    checkbox: node => attr(node, "id") === "checkbox", fallbackX: 30 },
];
type Spot = { widget: string; x: number; y: number; checked: boolean };
type Box = { left: number; top: number; width: number; height: number };

function attr(node: DomNode, name: string) {
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}
/** Light DOM, every shadow root (closed ones too, via pierce) and same-process frame documents. */
function collect(root: DomNode, match: (node: DomNode) => boolean) {
  const found: DomNode[] = [], parents = new Map<DomNode, DomNode>(), stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (match(node)) found.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
      parents.set(child, node);
      stack.push(child);
    }
  }
  return { found, parents };
}
async function boxOf(client: CDPConnection, nodeId: number, signal: AbortSignal, quad: "border" | "content" = "border"): Promise<Box | undefined> {
  try {
    const { model } = await client.send("DOM.getBoxModel", { nodeId }, signal);
    const q: number[] = model[quad], xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const box = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    return box.width >= 8 && box.height >= 8 ? box : undefined;
  } catch { aborted(signal); return undefined; } // Not rendered (yet).
}
/** Finds the checkbox in a widget document; its box is relative to that document's frame viewport. */
async function checkboxIn(client: CDPConnection, root: DomNode, widget: Widget, signal: AbortSignal) {
  const { found, parents } = collect(root, widget.checkbox);
  for (const node of found) {
    // A styled checkbox may hide the <input> itself; fall back to its label/wrapper.
    for (let current: DomNode | undefined = node, depth = 0; current && depth < 3; current = parents.get(current), depth++) {
      if (current.nodeName === "#document-fragment") break;
      const box = await boxOf(client, current.nodeId, signal);
      if (box) return { box, checked: attr(node, "aria-checked") === "true" || attr(node, "checked") !== undefined };
    }
  }
  return undefined;
}
async function findCheckbox(client: CDPConnection, signal: AbortSignal): Promise<{ seen: boolean; spot?: Spot }> {
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true }, signal, 8000) as { root: DomNode };
  let targets: Page[] | undefined, seen = false;
  try {
    for (const frame of collect(root, node => node.localName === "iframe").found) {
      let url = attr(frame, "src") ?? "";
      let widget = WIDGETS.find(item => item.frame.test(url));
      if (!widget && frame.frameId && !frame.contentDocument) {
        targets ??= await listTargets(signal).catch(() => { aborted(signal); return []; });
        url = targets.find(target => target.id === frame.frameId)?.url ?? url;
        widget = WIDGETS.find(item => item.frame.test(url));
      }
      if (!widget) continue;
      seen = true;
      await client.send("DOM.scrollIntoViewIfNeeded", { nodeId: frame.nodeId }, signal).catch(() => aborted(signal));
      const frameBox = await boxOf(client, frame.nodeId, signal, "content");
      if (!frameBox) continue;
      let found: { box: Box; checked: boolean } | undefined, inspected = false;
      if (frame.contentDocument) {
        // Same-process frame: box coordinates are already relative to the main viewport.
        inspected = true;
        found = await checkboxIn(client, frame.contentDocument, widget, signal);
      } else {
        // Cross-origin frame in its own process: inspect it through its own target.
        targets ??= await listTargets(signal).catch(() => { aborted(signal); return []; });
        const target = targets.find(item => item.id === frame.frameId && item.webSocketDebuggerUrl);
        if (target) {
          const child = new CDPConnection();
          try {
            await child.connect(target.webSocketDebuggerUrl!, signal);
            const doc = await child.send("DOM.getDocument", { depth: -1, pierce: true }, signal) as { root: DomNode };
            inspected = true;
            found = await checkboxIn(child, doc.root, widget, signal);
            if (found) found.box = { ...found.box, left: found.box.left + frameBox.left, top: found.box.top + frameBox.top };
          } catch { aborted(signal); } finally { child.close(); }
        }
      }
      // Fixed offset only when the frame could not be inspected at all and has the standard
      // (non-compact) layout; an inspected frame without a visible checkbox is still loading.
      const spot = found ? { x: found.box.left + found.box.width / 2, y: found.box.top + found.box.height / 2, checked: found.checked } :
        !inspected && frameBox.width >= 290 && frameBox.height <= 90 ? { x: frameBox.left + widget.fallbackX, y: frameBox.top + frameBox.height / 2, checked: false } : undefined;
      if (!spot) continue;
      const { cssLayoutViewport: view } = await client.send("Page.getLayoutMetrics", {}, signal);
      if (spot.x < 1 || spot.y < 1 || spot.x >= view.clientWidth - 1 || spot.y >= view.clientHeight - 1) continue;
      return { seen, spot: { widget: widget.name, ...spot } };
    }
    return { seen };
  } finally {
    // getDocument implicitly enables the DOM agent; stop its event stream again.
    if (client.open) await client.send("DOM.disable", {}, undefined, 1500).catch(() => {});
  }
}
async function humanClick(client: CDPConnection, x: number, y: number, signal: AbortSignal) {
  x += (Math.random() - 0.5) * 4; y += (Math.random() - 0.5) * 4;
  const fromX = Math.max(2, x - 60 - Math.random() * 120), fromY = y + 40 + Math.random() * 80;
  const steps = 8 + Math.floor(Math.random() * 6);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, ease = t * t * (3 - 2 * t), wobble = i < steps ? (Math.random() - 0.5) * 3 : 0;
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX + (x - fromX) * ease + wobble, y: fromY + (y - fromY) * ease + wobble }, signal);
    await sleep(10 + Math.random() * 25, signal);
  }
  await sleep(80 + Math.random() * 150, signal);
  await pressAt(client, x, y, signal, 50 + Math.random() * 70);
}
async function captchaState(client: CDPConnection, signal: AbortSignal) {
  try {
    return await evaluate<{ captcha: boolean; puzzle: boolean }>(client, js(`return { captcha: reasonsFor().includes(${JSON.stringify(CAPTCHA)}), puzzle: puzzle() };`), signal);
  } catch (error) {
    if (!contextChanged(error)) throw error;
    return { captcha: true, puzzle: false }; // Navigating, e.g. a Cloudflare interstitial that just passed.
  }
}
export async function autoVerify(client: CDPConnection, signal: AbortSignal): Promise<{ passed: boolean; clicks: number; message: string }> {
  const start = Date.now();
  let clicks = 0, lastClick = 0, widget = "", seen = false;
  const clickedPrefix = () => clicks ? `clicked the ${widget} checkbox, but ` : "";
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    const state = await captchaState(client, signal);
    if (!state.captcha) return { passed: true, clicks, message: clicks ? `passed after clicking the ${widget} checkbox` : "verification cleared without a click" };
    if (state.puzzle) return { passed: false, clicks, message: `${clickedPrefix()}an image/puzzle challenge is showing; solve it manually` };
    // Give a clicked widget time to verify before one retry.
    if (clicks < 2 && Date.now() - lastClick > 7000) {
      let found: Awaited<ReturnType<typeof findCheckbox>> = { seen: false };
      try { found = await findCheckbox(client, signal); }
      catch (error) { aborted(signal); if (!client.open) throw error; } // Page changed mid-scan; try again.
      seen ||= found.seen;
      if (found.spot && !found.spot.checked) {
        await humanClick(client, found.spot.x, found.spot.y, signal);
        clicks++; lastClick = Date.now(); widget = found.spot.widget;
        await sleep(800, signal);
        continue;
      }
      if (!seen && Date.now() - start > 8000) return { passed: false, clicks, message: "no supported checkbox widget (Turnstile, reCAPTCHA, hCaptcha) found" };
    }
    await sleep(500, signal);
  }
  return { passed: false, clicks, message: `${clickedPrefix()}verification did not complete within ${VERIFY_TIMEOUT_MS / 1000}s` };
}

class BrowserSession {
  client?: CDPConnection;
  page?: Page;
  private savedId?: string;
  private tail: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) { this.pi = pi; }
  queue<T>(fn: (signal: AbortSignal) => Promise<T>, inputSignal?: AbortSignal): Promise<T> {
    const signal = inputSignal ? AbortSignal.any([inputSignal, this.lifetime.signal]) : this.lifetime.signal;
    const task = this.tail.then(() => { aborted(signal); return fn(signal); });
    this.tail = task.catch(() => {});
    return abortable(task, signal);
  }
  async pages(signal?: AbortSignal): Promise<Page[]> {
    return (await listTargets(signal)).filter(page => page.type === "page" && page.webSocketDebuggerUrl);
  }
  async get(signal?: AbortSignal, tabId?: string): Promise<CDPConnection> {
    if (this.client?.open && (!tabId || this.page?.id === tabId)) return this.client;
    await ensureBrowser(this.pi, signal);
    const pages = await this.pages(signal);
    if (this.savedId === undefined) {
      try { this.savedId = (await readFile(PAGE_ID_FILE, "utf8")).trim(); } catch { this.savedId = ""; }
    }
    const requested = tabId ?? this.page?.id ?? this.savedId;
    const page = pages.find(item => item.id === requested) ?? (tabId ? undefined :
      pages.find(item => item.url !== "about:blank") ?? pages[0]);
    if (!page) throw new Error(tabId ? "Tab not found; use action tabs for current IDs." : "No controllable Chromium tab is open.");
    const next = new CDPConnection();
    await next.connect(page.webSocketDebuggerUrl!, signal);
    this.client?.close();
    this.client = next;
    this.page = page;
    if (page.id !== this.savedId) {
      await mkdir(dirname(PAGE_ID_FILE), { recursive: true });
      await writeFile(PAGE_ID_FILE, page.id);
      this.savedId = page.id;
    }
    return next;
  }
  close() { this.lifetime.abort(new Error("Browser extension shut down")); this.client?.close(); this.client = undefined; }
}

const STEP_ACTIONS = ["open", "check", "read", "click", "fill", "press", "scroll", "wait"] as const;
const common = {
  target: Type.Optional(Type.String({ description: "Fully qualified http(s) URL for open" })),
  selector: Type.Optional(Type.String({ description: "Exact @ref from page output (preferred) or unique CSS selector; required for click/fill" })),
  text: Type.Optional(Type.String({ description: "Text for fill; never passwords or verification codes" })),
  key: Type.Optional(Type.String({ description: "Key or chord for press: Enter, Tab, Escape, Ctrl+a, Shift+Tab, or one character" })),
  deltaY: Type.Optional(Type.Integer({ minimum: -10000, maximum: 10000 })),
  waitFor: Type.Optional(Type.String({ description: "After this action, wait for this CSS selector/@ref, then return the page. Avoid separate wait/read calls." })),
  waitText: Type.Optional(Type.String({ description: "After this action, wait for visible page text to contain this substring" })),
  waitState: Type.Optional(StringEnum(["visible", "hidden", "attached", "detached"] as const)),
  timeoutMs: Type.Optional(Type.Integer({ description: "Condition timeout, not a sleep duration; 0 to 30000ms", minimum: 0, maximum: 30000 })),
};
const parameters = Type.Object({
  action: StringEnum([...STEP_ACTIONS, "batch", "tabs", "switch", "screenshot"] as const),
  ...common,
  steps: Type.Optional(Type.Array(Type.Object({ action: StringEnum(STEP_ACTIONS), ...common }), { minItems: 1, maxItems: 12,
    description: "For batch: known, sequential steps; returns one final page. Stops on first error/manual gate. Do not parallelize dependent browser actions." })),
  tabId: Type.Optional(Type.String({ description: "Tab ID for switch; get IDs using tabs. Popups are not selected automatically." })),
  report: Type.Optional(StringEnum(["page", "status"] as const, { description: "Default page: compact text + controls after actions; status skips text/controls" })),
  path: Type.Optional(Type.String({ description: "screenshot only: PNG output path (relative to working directory or absolute). Mutually exclusive with gallery." })),
  gallery: Type.Optional(Type.Boolean({ description: "screenshot only: save to Android DCIM/Screenshots and request a bounded media scan. Scan failure does not lose the image." })),
  preview: Type.Optional(Type.Boolean({ description: "screenshot only: return the image as well as its path; default true." })),
  maxChars: Type.Optional(Type.Integer({ description: "Page text limit; default 2500", minimum: 500, maximum: 16000 })),
  maxElements: Type.Optional(Type.Integer({ description: "Visible viewport controls limit; default 24. Scroll or read a scoped selector for more.", minimum: 0, maximum: 80 })),
});

function validateStep(step: Step) {
  if (!STEP_ACTIONS.includes(step.action as any)) throw new Error(`Unsupported step action: ${step.action}`);
  if (step.action === "open") {
    let url: URL;
    try { url = new URL(step.target ?? ""); } catch { throw new Error("open requires a fully qualified http(s) URL"); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) navigation is allowed");
  }
  if (["click", "fill"].includes(step.action) && !step.selector?.trim()) throw new Error(`${step.action} requires selector`);
  if (step.action === "fill" && step.text === undefined) throw new Error("fill requires text");
  if (step.action === "press") { if (!step.key) throw new Error("press requires key"); keyDefinition(step.key); }
  if (step.waitState && !step.waitFor && !(step.action === "wait" && step.selector)) throw new Error("waitState requires waitFor, or selector with action wait");
}
async function executeStep(client: CDPConnection, step: Step, signal: AbortSignal): Promise<string> {
  const timeout = step.timeoutMs ?? (step.action === "wait" && !step.selector && !step.waitFor && step.waitText === undefined ? 1200 : 8000);
  if (["click", "fill", "press"].includes(step.action) && step.selector) {
    // Missing CSS targets can appear asynchronously; old refs must never be rebound.
    if (step.selector.startsWith("@")) await evaluate(client, js(`find(${JSON.stringify(step.selector)}); return true;`), signal);
    else await waitForPage(client, { selector: step.selector, target: true, timeoutMs: step.timeoutMs ?? 3000 }, signal);
  }
  let result = "";
  if (step.action === "open") {
    await client.send("Page.bringToFront", {}, signal);
    // A same-document navigation (hash change) keeps the old watcher; restart its quiet window.
    await evaluate(client, js("probe(true); return true"), signal).catch(error => { aborted(signal); if (!contextChanged(error)) throw error; });
    const navigation = await client.send("Page.navigate", { url: step.target }, signal, Math.max(1000, timeout));
    if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
    if (navigation.isDownload) return "Navigation started a download; inspect downloads separately.";
    result = "Opened page";
  }
  if (step.action === "click") result = await click(client, step.selector!, signal);
  if (step.action === "fill") result = await fill(client, step.selector!, step.text!, signal);
  if (step.action === "press") result = await press(client, step.selector, step.key!, signal);
  if (step.action === "scroll") {
    // Many app layouts scroll an inner container while the window itself cannot move.
    const position = await evaluate<{ target: string; x: number; y: number }>(client, js(`
      probe(true);
      const delta = ${step.deltaY ?? 600}, before = scrollY;
      window.scrollBy({ top: delta, behavior: 'instant' });
      if (scrollY !== before || !delta) return { target: 'page', x: scrollX, y: scrollY };
      const scrollable = el => el.scrollHeight > el.clientHeight && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && visible(el);
      const chain = start => { const out = []; for (let el = start; el && el !== document.documentElement; el = el.parentElement) out.push(el); return out; };
      // Prefer the focused element's container, then the one under the viewport centre, then the largest.
      const area = el => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); };
      const rest = Array.from(document.body?.querySelectorAll('*') ?? []).slice(0, 8000).filter(scrollable).sort((a, b) => area(b) - area(a));
      for (const el of [...chain(document.activeElement), ...chain(document.elementFromPoint(innerWidth / 2, innerHeight / 2)), ...rest]) {
        if (!scrollable(el)) continue;
        const top = el.scrollTop;
        el.scrollBy({ top: delta, behavior: 'instant' });
        if (el.scrollTop !== top) return { target: 'container', x: el.scrollLeft, y: el.scrollTop };
      }
      return { target: 'none', x: scrollX, y: scrollY };
    `), signal);
    result = position.target === "none" ? `Nothing scrolled (already at the edge?); page at ${position.x}, ${position.y}` :
      `Scrolled ${position.target} to ${position.x}, ${position.y}`;
  }
  if (step.action === "check") result = "Checked page";
  if (step.action === "read") result = "Read page";
  const selector = step.waitFor ?? (step.action === "wait" ? step.selector : undefined);
  if (selector || step.waitText !== undefined || step.action === "wait") {
    const settled = await waitForPage(client, { selector, text: step.waitText, state: step.waitState, timeoutMs: timeout }, signal);
    result += `${result ? "; " : ""}${settled ? "condition satisfied" : "page still changing; specify waitFor or waitText"}`;
  } else if (["open", "click", "press", "scroll"].includes(step.action)) {
    const settled = await waitForPage(client, { timeoutMs: Math.min(timeout, step.action === "open" ? 8000 : 1200) }, signal);
    if (!settled) result += "; page still changing (use waitFor/waitText for a specific result)";
  }
  return result;
}
function limitOutput(text: string) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= 42_000) return text;
  // Streaming decode drops an incomplete final UTF-8 character instead of corrupting it.
  return new TextDecoder().decode(bytes.subarray(0, 42_000), { stream: true }) + "\n[Output truncated; use a scoped read or smaller maxChars/maxElements]";
}
function formatPage(data: Snapshot) {
  const controls = data.elements.map(el => `${el.ref} ${el.tag}${el.type ? `[${el.type}]` : ""} ${JSON.stringify(el.name)}${el.role ? ` [role=${el.role}]` : ""}${el.expanded !== undefined ? ` [expanded=${el.expanded}]` : ""}${el.checked !== undefined ? ` [checked/selected=${el.checked}]` : ""}${el.disabled ? " [disabled]" : ""}${el.sensitive ? " [manual only]" : ""}${el.selector ? "  " + el.selector : ""}`).join("\n");
  return limitOutput(`${data.title || "Untitled"}\n${data.url}${data.text ? "\n\n" + data.text : ""}${data.truncated ? "\n[Text truncated; use scoped read or maxChars]" : ""}${controls ? "\n\nViewport controls (@refs stay valid only for the same connected node):\n" + controls : ""}${data.frames ? `\n[${data.frames} embedded frame(s); controls above are main-document only]` : ""}`);
}

export default function (pi: ExtensionAPI) {
  const browser = new BrowserSession(pi);
  pi.registerTool({
    name: "enable_chromium", label: "Enable Chromium",
    description: "Enable real Chromium automation for interactive browser tasks in this session. Use web_search_exa/web_fetch_exa for ordinary web search or retrieval.",
    parameters: Type.Object({}),
    async execute() {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "chromium"])]);
      return { content: [{ type: "text", text: "Chromium enabled for this session. Actions return the page automatically; use waitFor/waitText or batch instead of separate click → sleep → read calls." }], details: {} };
    },
  });
  pi.registerTool({
    name: "chromium", label: "Termux Chromium",
    // No active-only promptSnippet/promptGuidelines: keep the system prefix stable.
    description: "Control persistent Chromium for real interactive browser tasks, not ordinary search/retrieval. open/click/fill/press/scroll/wait/check return filtered rendered text and exact @refs including menu items, with open menus prioritized; do not immediately call read again. Text is not a pixel/occlusion guarantee: use screenshot to verify visual claims. Failures include fresh page refs, so use those instead of guessing selectors; missing CSS interaction targets default to 3s (override timeoutMs). Screenshot returns an image preview by default; path chooses a PNG file, gallery saves to Android DCIM/Screenshots with a bounded best-effort scan. Use returned @refs or unique CSS selectors. Set waitFor/waitText on the action for asynchronous results; wait without a condition waits for brief DOM stability, NOT a fixed sleep. Use batch for known dependent steps (one final page); never issue dependent calls in parallel. Batch stops at errors or manual gates; never blindly replay successful steps. A human-verification checkbox (Cloudflare Turnstile, reCAPTCHA, hCaptcha) is clicked automatically once per non-read call; image/puzzle CAPTCHAs, passwords, MFA and consent require manual noVNC handling; check retries the checkbox or resumes afterwards. tabs/switch handle popups explicitly. Main-document DOM only. Use screenshot only when requested or DOM information is insufficient.",
    parameters,
    async execute(_id, input, signal, onUpdate, ctx) {
      const params = input as Params;
      const steps = params.action === "batch" ? params.steps : STEP_ACTIONS.includes(params.action as any) ? [params] : [];
      if (!steps) throw new Error("batch requires steps");
      if (params.action === "batch" && (!steps.length || steps.length > 12)) throw new Error("batch needs 1–12 steps");
      for (const step of steps) validateStep(step); // Validate all before any mutation.
      if (params.action === "switch" && !params.tabId) throw new Error("switch requires tabId");
      if (params.path && params.gallery) throw new Error("Use either path or gallery, not both");
      if (params.path && !params.path.toLowerCase().endsWith(".png")) throw new Error("Screenshot path must end in .png");
      return browser.queue(async activeSignal => {
        const start = Date.now();
        if (!browser.client?.open) onUpdate?.({ content: [{ type: "text", text: "Connecting to Chromium…" }], details: {} });
        const client = await browser.get(activeSignal, params.action === "switch" ? params.tabId : undefined);
        if (params.action === "switch") await client.send("Page.bringToFront", {}, activeSignal);
        if (params.action === "tabs") {
          const tabs = await browser.pages(activeSignal);
          return { content: [{ type: "text" as const, text: tabs.map(tab => `${tab.id}${tab.id === browser.page?.id ? " [selected]" : ""} ${tab.title ?? ""}\n${tab.url}`).join("\n\n") }], details: { tabs, elapsedMs: Date.now() - start } };
        }
        if (params.action === "screenshot") {
          const image = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, activeSignal);
          if (!image?.data) throw new Error("Screenshot capture failed");
          const path = params.path ? resolve(ctx?.cwd ?? process.cwd(), params.path) :
            join(params.gallery ? "/sdcard/DCIM/Screenshots" : SCREENSHOT_DIR, `chromium-${Date.now()}.png`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, Buffer.from(image.data, "base64"), { flag: "wx" });
          let mediaScan: string | undefined;
          if (params.gallery) mediaScan = await requestMediaScan(pi, path, activeSignal);
          return { content: [
            { type: "text" as const, text: `Screenshot saved to: ${path}${mediaScan ? "\nMedia scan: " + mediaScan : ""}` },
            ...(params.preview === false ? [] : [{ type: "image" as const, data: image.data, mimeType: "image/png" as const }]),
          ], details: { path, mediaScan, elapsedMs: Date.now() - start } };
        }
        const completed: string[] = [], verifyNotes: string[] = [];
        let data: Snapshot | undefined, stopped = false, verifyTried = false;
        // Same rule as the in-page guard: a login form alone does not block non-sensitive steps.
        const blocked = (page?: Snapshot) => !!page?.reasons.some(reason => reason !== "login");
        // At most one automatic attempt per call, so a failing widget cannot loop.
        const autoPass = async (page: Snapshot) => {
          if (!AUTO_VERIFY || verifyTried || !page.reasons.includes(CAPTCHA)) return false;
          verifyTried = true;
          onUpdate?.({ content: [{ type: "text", text: "Human verification detected; trying its checkbox automatically…" }], details: {} });
          const outcome = await autoVerify(client, activeSignal);
          verifyNotes.push(`Auto verification: ${outcome.message}`);
          if (outcome.passed) await waitForPage(client, { timeoutMs: 8000 }, activeSignal);
          return outcome.passed;
        };
        const gate = async () => {
          let page = await inspect(client, undefined, 0, 0, activeSignal);
          if (blocked(page) && await autoPass(page)) page = await inspect(client, undefined, 0, 0, activeSignal);
          return page;
        };
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i], gated = !["open", "check", "read", "wait", "scroll"].includes(step.action);
          if (params.action === "batch") {
            // Later steps reuse the safety inspection performed after the preceding step.
            if (i === 0) data = await gate();
            if (gated && blocked(data)) { stopped = true; break; }
            onUpdate?.({ content: [{ type: "text", text: `Browser step ${i + 1}/${steps.length}: ${step.action}` }], details: { completed: i, total: steps.length } });
          }
          try {
            let message: string;
            try { message = await executeStep(client, step, activeSignal); }
            catch (error) {
              // The guard refuses before any input is sent, so a step blocked only by a checkbox
              // can run once more after it passes; no pre-check costs every action a round trip.
              aborted(activeSignal);
              if (!/Manual user action required/.test(String(error)) || !String(error).includes(CAPTCHA) ||
                !await autoPass(await inspect(client, undefined, 0, 0, activeSignal))) throw error;
              message = await executeStep(client, step, activeSignal);
            }
            completed.push(`${i + 1}. ${step.action}: ${message}`);
          } catch (error) {
            aborted(activeSignal);
            let diagnostic = "";
            try { diagnostic = "\n\nCurrent page (read-only diagnostic; no action replayed):\n" + formatPage(await snapshot(client, undefined, 1200, 32, activeSignal)); }
            catch { aborted(activeSignal); }
            throw new Error(limitOutput(`${params.action === "batch" ? `Batch stopped at step ${i + 1}/${steps.length}. Completed ${completed.length} step(s).\n${completed.join("\n")}\n` : ""}${verifyNotes.map(note => note + "\n").join("")}${String(error)}\nThe current action may have taken effect. Successful steps are NOT rolled back. Use the current refs below; do not blindly replay actions.${diagnostic}`));
          }
          if (params.action === "batch" && i < steps.length - 1) {
            data = await gate();
            if (blocked(data)) { stopped = true; break; }
          }
        }
        const last = steps[completed.length - 1];
        // A final scoped read is supported, including in a batch. Other action selectors
        // refer to the target being operated on, not the root of the returned snapshot.
        const root = !stopped && last?.action === "read" ? last.selector : undefined;
        const maxChars = params.report === "status" ? 0 : params.maxChars ?? 2500;
        const maxElements = params.report === "status" ? 0 : params.maxElements ?? 24;
        data = await inspect(client, root, maxChars, maxElements, activeSignal);
        // A plain read never interacts with the page; every other action may pass a checkbox gate.
        if (!["read", "tabs", "switch"].includes(params.action) && await autoPass(data)) {
          data = await inspect(client, root, maxChars, maxElements, activeSignal);
        }
        let handoff = "";
        if (data.requiresUserAction) {
          try { await ensureViewer(pi, activeSignal); handoff = `\nUser action required (${data.reasons.join(", ")}): ${NOVNC_URL}`; }
          catch (error) { aborted(activeSignal); handoff = `\nUser action required (${data.reasons.join(", ")}). Viewer unavailable: ${String(error)}`; }
        }
        const elapsedMs = Date.now() - start;
        const status = [...completed, ...verifyNotes].join("\n") +
          (stopped ? `\nBatch paused at a manual gate. ${steps.length - completed.length} step(s) NOT executed.` : "");
        return {
          content: [{ type: "text" as const, text: `${status}${status ? "\n\n" : ""}${formatPage(data)}${handoff}\n[${elapsedMs}ms]` }],
          details: { ...data, action: params.action, completed: completed.length, stopped, elapsedMs, tabId: browser.page?.id,
            autoVerify: verifyNotes[0], viewerUrl: data.requiresUserAction ? NOVNC_URL : undefined },
        };
      }, signal);
    },
  });
  pi.on("session_start", () => {
    pi.setActiveTools([...new Set(pi.getActiveTools().filter(name => name !== "chromium").concat("enable_chromium"))]);
  });
  // Keep the tool loaded through follow-up user messages; removing it at agent_settled
  // costs another loader/model round trip and can invalidate the prompt cache.
  pi.on("session_shutdown", () => browser.close());
}
