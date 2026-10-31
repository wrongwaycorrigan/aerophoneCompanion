// Aerophone Companion: scenes, tones, Live and Library for the Roland AE-20.
// Talks to an AE-20 / AE-30 over USB with Web MIDI. The instrument's parameter map, value sizes,
// effect lists and names come from data.js, built by tools/docs/build_data.py from Roland's public AE-30/AE-20 documents.
(() => {
'use strict';
const D = window.AE_DATA, CAT = D.catalog;
const { INTEGER1x1, INTEGER1x2, INTEGER1x3, INTEGER1x4, INTEGER1x5, INTEGER1x6, INTEGER1x7, INTEGER2x4, INTEGER2x7, INTEGER4x4, INTEGER8x4, PADDING } = D.sizes;
const AM = (() => {          // the parameter map, rebuilt from plain data (shared tables stay shared)
  const built = [];
  const table = (id) => built[id] || (built[id] = D.map.tables[id].map((e) => (e.c != null
    ? { name: e.n, addr: e.a, child: table(e.c) }
    : { name: e.n, addr: e.a, size: e.s, min: e.mn || 0, max: e.mx, ofs: e.o || 0 })));
  return { root: D.map.roots.map((r) => ({ name: r.n, addr: r.a, child: table(r.c) })) };
})();
const { MFX: MFX_TYPE_LIST, CHO: CHORUS_TYPE_LIST, DLY: DELAY_TYPE_LIST, REV: REVERB_TYPE_LIST } = D.fx;
// SysEx addresses pack 7 bits per byte; inside the editor they are plain numbers
const nibble = (x) => (((x & 0x7f000000) >>> 3) | ((x & 0x7f0000) >>> 2) | ((x & 0x7f00) >>> 1) | (x & 0x7f)) >>> 0;
const _7bitize = (x) => (((x << 3) & 0x7f000000) | ((x << 2) & 0x7f0000) | ((x << 1) & 0x7f00) | (x & 0x7f)) >>> 0;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
             set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };


// ======================= value encoding (Roland sizes) =======================
function sizeOf(s) {
  if (s >= PADDING) return s - PADDING;
  switch (s) {
    case INTEGER1x1: case INTEGER1x2: case INTEGER1x3: case INTEGER1x4: case INTEGER1x5: case INTEGER1x6: case INTEGER1x7: return 1;
    case INTEGER2x4: case INTEGER2x7: return 2;
    case INTEGER4x4: return 4;
    case INTEGER8x4: return 8;
  }
  return s;
}
function dec(b, off, s) {
  const n = sizeOf(s);
  if (s === INTEGER2x7) return (b[off] << 7) | b[off + 1];
  if (s === INTEGER2x4 || s === INTEGER4x4 || s === INTEGER8x4) { let v = 0; for (let i = 0; i < n; i++) v = (v << 4) | (b[off + i] & 15); return v; }
  return b[off];
}
function enc(v, s) {
  const n = sizeOf(s);
  if (s === INTEGER2x7) return [(v >> 7) & 127, v & 127];
  if (s === INTEGER2x4 || s === INTEGER4x4 || s === INTEGER8x4) { const o = []; for (let i = n - 1; i >= 0; i--) o.push((v >> (4 * i)) & 15); return o; }
  return [v & 127];
}
const to7 = (lin) => { const a = _7bitize(lin); return [(a >>> 24) & 127, (a >>> 16) & 127, (a >>> 8) & 127, a & 127]; };
const from7 = (b) => nibble(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);

// ======================= blocks =======================
const blocks = {};
function block(path) {
  if (blocks[path]) return blocks[path];
  const [r, c] = path.split('%');
  const re = AM.root.find((e) => e.name === r);
  if (!re) throw new Error('no block ' + path);
  let base = re.addr, table = re.child;
  if (c) { const ce = re.child.find((e) => e.name === c); if (!ce) throw new Error('no block ' + path); base += ce.addr; table = ce.child; }
  let len = 0;
  for (const p of table) if (!p.child && p.name) len = Math.max(len, p.addr + sizeOf(p.size));
  return (blocks[path] = { path, base, table, len });
}
const mem = {};               // path -> Uint8Array
const pdef = (path, off) => block(path).table.find((p) => p.addr === off && p.name && !p.child);

function catKey(path, off) {
  const [r, c] = path.split('%');
  const rr = r.replace(/_\(\d+\)$/, '');
  return c ? `${rr}%${c.replace(/_\d+$/, '_N')}%${off}` : `${rr}%${off}`;
}
const catOkCache = {};
const words = (t) => new Set(String(t).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
function catOK(k, path, off) {      // some labels in Roland's layout data belong to a neighbouring control
  if (k in catOkCache) return catOkCache[k];
  const c = CAT[k], p = pdef(path, off); let ok = true;
  if (c && p) { const a = words(c.label), b = words(p.name); ok = [...a].some((w) => b.has(w)) || !/switch|type|function|assign|curve/i.test(p.name) || /^(Assign Input|Assign Output)/.test(p.name); if (/Bluetooth/.test(c.label)) ok = false; if (c.options && c.options.length === 1 && !c.options[0]) ok = false; }
  return (catOkCache[k] = ok);
}
function cat(path, off, fx) {
  const k = catKey(path, off);
  if (fx != null && CAT[k + '%fx' + fx]) return CAT[k + '%fx' + fx];
  return CAT[k] && catOK(k, path, off) ? CAT[k] : null;
}
function raw(path, off) {
  const d = mem[path]; if (!d) return undefined;
  const p = pdef(path, off); if (!p) return undefined;
  return dec(d, off, p.size);
}
function vofs(path, off, fx) {
  const c = cat(path, off, fx);
  if (c && c.vofs != null) return +c.vofs;
  const p = pdef(path, off); return p ? (p.ofs || 0) : 0;
}
const val = (path, off, fx) => { const r = raw(path, off); return r === undefined ? undefined : r - vofs(path, off, fx); };
function range(path, off, fx) {
  const c = cat(path, off, fx), p = pdef(path, off);
  let mn = c && c.min != null ? c.min : (p ? p.min : 0), mx = c && c.max != null ? c.max : (p ? p.max : 127);
  if (c && c.options) { mn = 0; mx = c.options.length - 1; }
  return [mn, mx];
}
function setVal(path, off, v, fx, send = true) {
  const p = pdef(path, off); if (!p || !mem[path]) return;
  const [mn, mx] = range(path, off, fx);
  v = Math.max(mn, Math.min(mx, Math.round(v)));
  const old = val(path, off, fx);
  const bytes = enc(v + vofs(path, off, fx), p.size);
  bytes.forEach((b, i) => { mem[path][off + i] = b; });
  if (send) sendValue(path, off, fx, old, v);
  changed();
}
// ---- gentle jumps: a big upward jump on a loudness-type setting reaches the instrument over ~0.1 s.
// The control on screen moves at once; small changes and turning down are sent immediately.
const glides = {}, riskyCache = {};
function isRisky(path, off, fx) {
  const k = path + '|' + off + '|' + (fx ?? ''); if (k in riskyCache) return riskyCache[k];
  const p = pdef(path, off), t = (nameFor(path, off, fx) + ' ' + (p ? p.name : '')).toLowerCase();
  return (riskyCache[k] = /level|volume|resonance|drive|gain|boost|feedback|send|peak|sustain/.test(t) && !/velocity|keyfollow|key follow|sens|curve|time|switch|select|mode/.test(t));
}
function sendValue(path, off, fx, old, v) {
  const p = pdef(path, off), [mn, mx] = range(path, off, fx), key = path + '|' + off, addr = block(path).base + off;
  const out = (x) => dev.dt1(addr, enc(Math.round(x) + vofs(path, off, fx), p.size));
  const g = glides[key];
  if (g) {                                           // already gliding: follow the hand, but never jump up
    if (v <= g.sent) { clearInterval(g.t); delete glides[key]; return out(v); }
    g.target = v; return;
  }
  if (old == null || v - old <= 0.1 * (mx - mn) || !isRisky(path, off, fx)) return out(v);
  const s = glides[key] = { sent: old, target: v, step: (v - old) / 6 };
  s.t = setInterval(() => {
    s.sent = Math.min(s.target, s.sent + Math.max(s.step, (s.target - s.sent) / 6));
    out(s.sent);
    if (s.sent >= s.target) { clearInterval(s.t); delete glides[key]; }
  }, 16);
}
const fmtCache = {};
function display(path, off, fx) {
  const v = val(path, off, fx); if (v === undefined) return '–';
  const c = cat(path, off, fx);
  if (c && c.options) return c.options[v] ?? String(v);
  if (c && c.format) {
    try { const f = fmtCache[c.format] || (fmtCache[c.format] = new Function('value', 'return (' + c.format + ');')); const s = f(v); return s === undefined ? String(v) : String(s); }
    catch (e) { return String(v); }
  }
  return String(v);
}
const label = (c, fallback) => ((c && c.label) || fallback || '').replace(/^-\s*/, '');
const ENV_NAMES = {
  ptlAenv: { 0: 'Attack velocity sens', 2: 'Release velocity sens', 4: 'Attack', 8: 'Hold', 12: 'Decay', 16: 'Release', 20: 'Peak level', 24: 'Hold level', 28: 'Sustain level' },
  ptlFenv: { 0: 'Depth', 1: 'Velocity curve', 2: 'Velocity sens', 4: 'Attack velocity sens', 6: 'Release velocity sens', 8: 'Attack', 12: 'Hold', 16: 'Decay', 20: 'Release', 24: 'Start level', 28: 'Peak level', 32: 'Hold level', 36: 'Sustain level', 40: 'End level' },
  ptlPenv: { 0: 'Depth', 2: 'Velocity sens', 4: 'Attack velocity sens', 6: 'Release velocity sens', 8: 'Attack', 12: 'Hold', 16: 'Decay', 20: 'Release', 24: 'Start level', 28: 'Peak level', 32: 'Hold level', 36: 'Sustain level', 40: 'End level', 44: 'Velocity curve' },
  ptlEq: { 0: 'Low gain', 4: 'Mid gain', 8: 'High gain', 12: 'Low frequency', 16: 'Mid frequency', 20: 'High frequency', 24: 'Mid width (Q)', 26: 'EQ on' },
  part: { 1: 'Part on', 10: 'Use the tone’s own effect', 11: 'Through the insert effect' },
  as: { 0: 'Controls', 2: 'Input from', 3: 'Input to', 4: 'Output from', 5: 'Output to', 6: 'Mode', 7: 'Curve' },
};
function nameFor(path, off, fx, given) {
  if (given) return given;
  const blk = (path.split('%')[1] || '').replace(/_\d+$/, '').replace(/^PCMEX_/, '').replace(/^Perf_/, '');
  const m = ENV_NAMES[blk] || (blk.startsWith('as_') ? ENV_NAMES.as : null);
  const o = blk.startsWith('as_') ? off % 16 : off;
  if (m && m[o] && fx == null) return m[o];
  const p = pdef(path, off);
  return label(cat(path, off, fx), p && p.name.replace(/^Assign /, '').replace(/\(reserved\)/, ''));
}
const short = (t) => (t.match(/^(?:Time|Level)\d \((\w+)\)$/) || [])[1] || t.replace(/^Part /, '').replace(/\s*\((CC|RPN)#?\d+\)$/, '').replace(/ Send Level$/, '').replace(/ Shift$/, '').trim();

// ======================= device (Web MIDI + Roland SysEx) =======================
const HDR = [0xF0, 0x41, 0x10, 0x00, 0x00, 0x00, 0x7D];
const chk = (a) => (128 - (a.reduce((s, x) => s + x, 0) % 128)) & 127;
const dev = {
  access: null, input: null, output: null, queue: [], busyUntil: 0, timer: null, waiters: [], onDT1: [],
  normName(n) {
    n = String(n || '').trim();
    const m = n.match(/^MIDI(?:IN|OUT)\d*\s*\((.*)\)$/i); if (m) n = m[1];
    return n.replace(/^\d+-\s*/, '').replace(/\s+MIDI\s*\d*$/i, '').replace(/:.*$/, '').trim();
  },
  ports() {
    const ins = [], outs = [];
    this.access.inputs.forEach((p) => p.state !== 'disconnected' && ins.push(p));
    this.access.outputs.forEach((p) => p.state !== 'disconnected' && outs.push(p));
    return { ins, outs };
  },
  pick(name) {
    const { ins, outs } = this.ports();
    const want = name || [...outs.map((p) => this.normName(p.name))].find((n) => /^(AE-20|AE-30|GC011)/.test(n));
    if (!want) return false;
    const rank = (p) => (p.name.trim() === this.normName(p.name) ? 0 : 1);
    this.input = ins.filter((p) => this.normName(p.name) === want).sort((a, b) => rank(a) - rank(b))[0];
    this.output = outs.filter((p) => this.normName(p.name) === want).sort((a, b) => rank(a) - rank(b))[0];
    if (!this.input || !this.output) return false;
    this.input.onmidimessage = (e) => this.receive(e.data);
    this.name = want;
    return true;
  },
  send(bytes, key) {
    if (key) { const q = this.queue.find((m) => m.key === key); if (q) { q.bytes = bytes; return; } }   // coalesce slider moves
    this.queue.push({ bytes, key }); this.pump();
  },
  pump() {
    if (this.timer || !this.queue.length) return;
    const wait = Math.max(0, this.busyUntil - performance.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const m = this.queue.shift(); if (!m) return;
      try { this.output && this.output.send(m.bytes); } catch (e) { console.error(e); }
      this.busyUntil = performance.now() + (m.bytes.length * 1000) / 3125 + 8;    // Roland's own pacing
      this.pump();
    }, wait);
  },
  dt1(lin, data) {
    for (let i = 0; i < data.length; i += 128) {
      const part = data.slice(i, i + 128), a = to7(lin + i), body = [...a, ...part];
      this.send([...HDR, 0x12, ...body, chk(body), 0xF7], 'a' + (lin + i) + ':' + part.length);
    }
  },
  rq1(lin, size, timeout = 4000) {
    const a = to7(lin), s = to7(size), body = [...a, ...s];
    return new Promise((resolve, reject) => {
      const w = { key: a.join(','), resolve, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error('timeout ' + lin.toString(16))); }, timeout) };
      this.waiters.push(w);
      this.send([...HDR, 0x11, ...body, chk(body), 0xF7]);
    });
  },
  receive(d) {
    if (d[0] < 0xF0) return air.midi(d);
    if (d[0] !== 0xF0 || d[1] !== 0x41 || d[6] !== 0x7D || d[7] !== 0x12) return;
    const a = [d[8], d[9], d[10], d[11]], data = Array.from(d.slice(12, d.length - 2));
    const key = a.join(','), w = this.waiters.find((x) => x.key === key);
    if (w) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(data); return; }
    const lin = from7(a);
    this.onDT1.forEach((f) => f(lin, data, a));
  },
};
const CMD = (addr7) => nibble(addr7);   // Roland writes command addresses in 7-bit form

async function readBlock(path) {
  const b = block(path), data = new Uint8Array(b.len);
  for (let off = 0; off < b.len; off += 128) {
    const n = Math.min(128, b.len - off);
    const got = await dev.rq1(b.base + off, n);
    data.set(got.slice(0, n), off);
  }
  mem[path] = data;
  return data;
}

// ---- live breath: what the AE-20 sends while you play (read only) ----
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const air = {
  v: 0, peak: 0, peakT: 0, note: null, last: 0, trail: [], raf: null, seen: false,
  cc() {   // which controller carries breath: the scene's MIDI-out breath setting, else Breath (2) or Expression (11)
    const b = SP('midi_breath_1');
    if (mem[b]) for (let i = 0; i < 8; i++) { const f = raw(b, i * 16); if (f >= 1 && f <= 95) return f; }
    return null;
  },
  midi(d) {
    const st = d[0] & 0xF0, now = performance.now();
    if (st === 0xB0) {
      const want = this.cc();
      if (want && d[1] === want) this.gotWant = true;
      if (!(d[1] === want || (!this.gotWant && (d[1] === 2 || d[1] === 11)))) return;
      this.v = d[2]; this.last = now; this.seen = true;
      if (d[2] >= this.peak || now - this.peakT > 4000) { this.peak = d[2]; this.peakT = now; }
    } else if (st === 0x90 && d[2]) { this.note = d[1]; this.last = now; }
    else if (st === 0x80 || (st === 0x90 && !d[2])) { if (d[1] === this.note) this.note = null; }
    else return;
    if (!this.raf) this.raf = requestAnimationFrame(airFrame);
  },
};
function airFrame() {
  air.raf = null;
  const now = performance.now(), idle = now - air.last > 700;
  if (idle) air.v = Math.max(0, air.v - 6);
  const b = air.v / 127, main = $('#main');
  main.style.setProperty('--b', b.toFixed(3));
  main.classList.toggle('blowing', air.v > 2); document.body.classList.toggle('airseen', air.seen);
  // the dot on the Breath node's curve
  const svg = main.querySelector('svg.curve[data-curve]');
  if (svg) {
    const blk = svg.dataset.curve, lo = raw(blk, 2) || 0, hi = raw(blk, 3) ?? 127;
    const xf = (v) => Math.max(0, Math.min(1, (v - lo) / ((hi - lo) || 1)));
    const omin = (raw(blk, 4) || 0) / 127, omax = (raw(blk, 5) ?? 127) / 127, c = raw(blk, 7) || 0;
    const pos = (v) => { const x = xf(v); return [16 + x * 176, 12 + 48 - (omin + (omax - omin) * curveFn(c, x)) * 48]; };
    const [x, y] = pos(air.v), dot = svg.querySelector('.bdot');
    dot.setAttribute('cx', air.v > 0 ? x : -20); dot.setAttribute('cy', y);
    air.trail.push([x, y]); if (air.trail.length > 14) air.trail.shift();
    svg.querySelector('.btrail').innerHTML = air.v > 0 ? air.trail.map(([tx, ty], i) => `<circle cx="${tx}" cy="${ty}" r="${1 + i * 0.22}" opacity="${(i / air.trail.length * 0.5).toFixed(2)}"/>`).join('') : '';
    const pk = svg.querySelector('.bpk'), px = air.seen ? pos(air.peak)[0] : -9; pk.setAttribute('x1', px); pk.setAttribute('x2', px);
    svg.querySelector('.bnote').textContent = air.note != null ? NOTE_NAMES[air.note % 12] + (Math.floor(air.note / 12) - 1) : '';
  }
  for (const mp of document.querySelectorAll('#inspector svg.map[data-who="breath"]')) {
    const dot = mp.querySelector('.mdot'), blk = mp.dataset.blk, bb = +mp.dataset.base;
    dot.setAttribute('cx', air.v > 0 ? mX(air.v) : -20); dot.setAttribute('cy', mY(mapOut(blk, bb, air.v)));
  }
  // the breath meter in the Breath settings
  const m = $('#inspector .bmeter');
  if (m) { m.querySelector('.now').style.width = (b * 100) + '%'; m.querySelector('.pk').style.left = (air.peak / 1.27) + '%'; $('#inspector .bmo').textContent = air.seen ? `${air.v}  ·  peak ${air.peak}` : 'Play to see your breath'; }
  if (air.v > 0 || !idle) air.raf = requestAnimationFrame(airFrame);
}

// incoming edits / state from the instrument
dev.onDT1.push((lin, data) => {
  for (const [path, d] of Object.entries(mem)) {
    const b = block(path);
    if (lin + data.length <= b.base || lin >= b.base + b.len) continue;
    for (let i = 0; i < data.length; i++) { const o = lin + i - b.base; if (o >= 0 && o < b.len) d[o] = data[i]; }
    changed();
  }
  const stp = block('stp').base;
  if (lin === stp && data.length >= 3 && !state.backup && !state.quiet) { state.cur = { msb: data[0], lsb: data[1], pc: data[2] }; scheduleSceneLoad(); }
  if (lin === CMD(0x0F004124) && listCollector) listCollector(data);
  if (lin === CMD(0x0F004224) && toneCollector) toneCollector(data);
});

// ======================= app state =======================
const state = {
  view: 'favorites', connected: false, loading: false,
  cur: null, scenes: new Map(), userSlots: [], favorites: [], curFav: -1,
  userTones: null, toneBase: {}, toneTarget: {}, toneNameDraft: {},
  sel: null, zoom: LS.get('zoom', 'fit'), libs: [], libSel: LS.get('libSel', null), entry: null, base: null, skipDraft: false, tonePart: 1, partial: 1, wheel: null, theme: LS.get('theme', null),
};
const SCENE_BLOCKS = AM.root.find((e) => e.name === 'Temporary_Scene').child.map((c) => 'Temporary_Scene%' + c.name);
const TONE_BLOCKS = ['common', 'mfx', 'pmt', 'ptl_1', 'ptl_2', 'ptl_3', 'ptl_4', 'ptlFenv_1', 'ptlFenv_2', 'ptlFenv_3', 'ptlFenv_4', 'ptlAenv_1', 'ptlAenv_2', 'ptlAenv_3', 'ptlAenv_4',
  'ptlLfo_1', 'ptlLfo_2', 'ptlLfo_3', 'ptlLfo_4', 'synCom', 'synPtl_1', 'synPtl_2', 'synPtl_3', 'synPtl_4',
  'ptlPenv_1', 'ptlPenv_2', 'ptlPenv_3', 'ptlPenv_4', 'ptlEq_1', 'ptlEq_2', 'ptlEq_3', 'ptlEq_4'];
const SP = (n) => 'Temporary_Scene%Perf_' + n;
const TP = (part, n) => `Temporary_Tone_PCM_(${part})%PCMEX_${n}`;

const sceneKey = (msb, lsb, pc) => `${msb}-${lsb}-${pc}`;
function sceneNo(s) {
  if (!s) return '';
  if (s.lsb <= 11) return `User ${pad2(s.lsb + 1)}-${pad2(s.pc + 1)}`;
  if (s.lsb >= 64 && s.lsb <= 75) return `Preset ${pad2(s.lsb - 63)}-${pad2(s.pc + 1)}`;
  return `${s.msb}-${s.lsb}-${s.pc}`;
}
const isUser = (s) => s && s.msb === 85 && s.lsb <= 11;
function sceneName() {
  const d = mem[SP('common')]; if (!d) return '';
  return String.fromCharCode(...d.slice(0, 16)).trim();
}
// tone picker: grouped by Roland's categories, in Roland's order; empty numbers are left out
function toneOptions(bank, list, cur) {
  const cats = (D.toneCats || {})[bank] || [], opt = (i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${i + 1}. ${esc(list[i] || 'Empty')}</option>`;
  const idx = list.map((n, i) => i).filter((i) => list[i] || i === cur);
  if (!cats.some(Boolean)) return idx.map(opt).join('');
  const groups = new Map();
  for (const i of idx) { const c = cats[i] || 'Other'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(i); }
  return [...groups].map(([c, is]) => `<optgroup label="${esc(c)}">${is.map(opt).join('')}</optgroup>`).join('');
}
function toneName(msb, lsb, pc) {
  const pick = (list, label) => (list && list[pc]) || `${label} ${pc + 1}`;   // never blank
  if (msb === 71 && lsb === 72) return pick(D.tones.A, 'Preset A');
  if (msb === 71 && lsb === 73) return pick(D.tones.B, 'Preset B');
  if (msb === 71 && lsb === 74) return pick(D.tones.C, 'Preset C');
  if (msb === 89 && lsb === 66) return pick(D.tones.SN, 'SuperNATURAL');
  if (msb === 70 && lsb === 66) return pick(D.tones.DK, 'Drum kit');
  if (msb === 71 && lsb >= 8 && lsb <= 11) { const i = (lsb - 8) * 128 + pc; return (state.userTones && state.userTones[i]) || `User tone ${i + 1}`; }
  return `Tone ${msb}-${lsb}-${pc}`;
}
function toneCode(msb, lsb, pc) {
  const p = { 72: 'A', 73: 'B', 74: 'C' }[lsb];
  if (msb === 71 && p) return `Preset ${p}-${pc + 1}`;
  if (msb === 89) return `SuperNATURAL ${pc + 1}`;
  if (msb === 70) return `Drum kit ${pc + 1}`;
  if (msb === 71 && lsb >= 8 && lsb <= 11) return `User tone U${String((lsb - 8) * 128 + pc + 1).padStart(3, '0')}`;
  return '';
}
const isZC = (n) => raw(SP('part_' + n), 2) === 71;

// ======================= loading =======================
let sceneTimer = null, listCollector = null, toneCollector = null;
function scheduleSceneLoad() { clearTimeout(sceneTimer); sceneTimer = setTimeout(loadScene, 250); }

let autoT = null, connecting = false, beatT = null;
// the instrument went away: keep everything on screen, say so, and offer a one-click reconnect
function lostConnection(why) {
  if (!state.connected) return;
  state.connected = false; clearInterval(beatT);
  if (dev.input) dev.input.onmidimessage = null;
  dev.input = dev.output = null; dev.queue.length = 0; clearTimeout(dev.timer); dev.timer = null;
  dev.waiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.resolve(null); });
  state.lost = true;
  status('lost', `${why}. Click to reconnect`);
  render();
}
function heartbeat() {
  let misses = 0;
  clearInterval(beatT);
  beatT = setInterval(async () => {
    if (!state.connected || state.loading || state.backup || dev.queue.length || dev.timer) return;
    try { const r = await dev.rq1(block('stp').base, 1, 2500); if (r) misses = 0; }
    catch (e) { if (++misses >= 2) lostConnection('AE-20 not responding'); }
  }, 4000);
}
async function connect(portName) {
  if (connecting) return; connecting = true;
  try {
    status('busy', 'Connecting');
    if (!dev.access) {
      dev.access = await navigator.requestMIDIAccess({ sysex: true });
      dev.access.onstatechange = (e) => {
        const p = e.port;
        if (state.connected) { if ((p === dev.output || p === dev.input) && p.state === 'disconnected') lostConnection('AE-20 unplugged or off'); }
        else if (p.state === 'connected' && /^(AE-20|AE-30|GC011)/.test(dev.normName(p.name))) { clearTimeout(autoT); autoT = setTimeout(() => { if (!state.connected && !connecting) connect(); }, 1500); }
      };
    }
    if (!dev.pick(portName)) { status('', 'Not connected'); state.connected = false; renderConnect(); return; }
    dev.dt1(block('stp').base + 7, [1]);           // let the instrument report edits made on it
    await readBlock('stp');
    state.cur = { msb: raw('stp', 0), lsb: raw('stp', 1), pc: raw('stp', 2) };
    state.connected = true; state.initScene = null; lists.fresh = {}; lists.queue = []; lists.favAt = Date.now(); primeNames();
    status('busy', 'Reading scenes');
    for (let i = 1; i <= 12; i++) await readBlock(`System%Sys_favorite_${i}`);
    await loadScene();
    status('ok', `${dev.name} connected by USB`); state.lost = false;
    heartbeat();
    loadSceneLists().then(() => fetchUserTones()).then(() => render());   // names for favorites, slots and your tones, in the background
  } catch (e) {
    console.error(e);
    status('', e.name === 'SecurityError' || e.name === 'NotAllowedError' ? 'MIDI access blocked' : 'Not connected');
    state.connected = false; renderConnect(e);
  } finally { connecting = false; }
}

async function loadScene() {
  if (state.loading) { scheduleSceneLoad(); return; }      // one read at a time
  if (isDirty() && !state.skipDraft) await autoDraft();
  state.skipDraft = false;
  state.loading = true;
  try {
    const stp = await dev.rq1(block('stp').base, 4);
    state.cur = { msb: stp[0], lsb: stp[1], pc: stp[2] }; state.curFav = stp[3];
    for (const p of SCENE_BLOCKS) await readBlock(p);
    for (let n = 1; n <= 4; n++) {
      if (raw(SP('part_' + n), 1) && isZC(n)) { await readBlock(TP(n, 'common')); await readBlock(TP(n, 'mfx')); }
    }
    for (const k of Object.keys(mem)) if (k.startsWith('Temporary_Tone_PCM') && !k.endsWith('common') && !k.endsWith('mfx')) delete mem[k];
    const nm = sceneName(); if (nm) state.scenes.set(sceneKey(state.cur.msb, state.cur.lsb, state.cur.pc), nm);
    state.base = snapshot(); state.loaded = snapshot(); state.entry = null; state.unstored = false; state.toneBase = {}; state.solo = null;
  } finally { state.loading = false; }
  render();
}

async function loadTone(part) {
  status('busy', 'Reading tone');
  for (const b of TONE_BLOCKS) await readBlock(TP(part, b));
  state.toneBase[part] = toneSnap(part);
  status('ok', `${dev.name} connected by USB`);
  render();
}

// ---- your tones: the names in the 512 user tone slots, and saving an edited tone into one ----
// A scene only points at its tones, so an edited tone is kept by writing it to a user tone slot
// and pointing the part at that slot; uploading the scene then keeps the link.
const USER_TONES = 512, TONE_NAME_LEN = 16;
const isInitTone = (t) => !t || /^INIT TONE$/i.test(t.trim());
async function fetchUserTones(force) {
  if (!state.connected || state.tonesBusy || (state.userTones && !force)) return;
  state.tonesBusy = true;
  while (lists.busy) await sleep(100);
  lists.busy = true;                                   // one name list at a time
  try {
    const names = new Array(USER_TONES).fill('');
    await new Promise((resolve) => {
      let t = setTimeout(done, 5000);
      function done() { toneCollector = null; clearTimeout(t); resolve(); }
      toneCollector = (d) => {                         // gg ee dd mm ll pp name[16]
        if (d.length < 22 || d[0] !== 1) return;
        const msb = d[3], lsb = d[4], pc = d[5];
        if (!msb && !lsb && !pc) return done();
        if (msb === 71 && lsb >= 8 && lsb <= 11) names[(lsb - 8) * 128 + pc] = String.fromCharCode(...d.slice(6, 22)).trim();
        clearTimeout(t); t = setTimeout(done, 3000);
      };
      dev.dt1(CMD(0x0F004200), [1, 0, 0, 0, 0, 0, 0, 0x0F, 0x0F, 0x0F, 0x0F]);
    });
    if (state.connected) state.userTones = names;
  } finally { lists.busy = false; state.tonesBusy = false; pumpLists(); }
  if (state.view === 'tones' || state.view === 'scenes') { renderMain(true); renderInspector(); }
}
// ---- waves: the PCM waves a partial plays, named from the Wave List (banks A-D) ----
const WAVE_BANK = Object.fromEntries(Object.entries(D.waveGroups || {}).map(([b, g]) => [g, b]));
const WAVE_KIND = ['', 'Expansion', 'Sample', 'Multisample'];
function waveOf(n, P) {
  const ptl = TP(n, 'ptl_' + P); if (!mem[ptl]) return null;
  const gt = raw(ptl, 27), gid = raw(ptl, 28), L = raw(ptl, 32), R = raw(ptl, 36);
  const bank = gt === 0 ? WAVE_BANK[gid] : null;
  return { gt, gid, L, R, bank, name: bank && L ? ((D.waves || {})[bank] || [])[L - 1] || '' : '' };
}
const waveNo = (bank, num) => `${bank} ${String(num).padStart(3, '0')}`;
function waveLabel(w, short) {
  if (!w) return '';
  if (!w.L) return 'No wave';
  if (w.gt !== 0) return `${WAVE_KIND[w.gt] || 'Wave'} ${w.L}`;
  if (!w.bank) return `Wave ${w.L} (group ${w.gid})`;
  return short ? (w.name || waveNo(w.bank, w.L)) : `${waveNo(w.bank, w.L)}${w.name ? ' · ' + w.name : ''}`;
}
// stereo waves come as "… L" / "… R" pairs next to each other
function stereoPartner(bank, num) {
  const list = (D.waves || {})[bank] || [], nm = list[num - 1] || '', nx = list[num] || '';
  return / L$/.test(nm) && nx === nm.replace(/ L$/, ' R') ? num + 1 : 0;
}
function setWave(n, P, bank, num) {               // plays at once; part of the tone's edits
  const syn = TP(n, 'synPtl_' + P), ptl = TP(n, 'ptl_' + P);
  if (raw(syn, 0) !== 0) setVal(syn, 0, 0, null);   // oscillator type: PCM
  if (raw(ptl, 27) !== 0) setVal(ptl, 27, 0, null);
  if (raw(ptl, 28) !== D.waveGroups[bank]) setVal(ptl, 28, D.waveGroups[bank], null);
  setVal(ptl, 32, num, null);
  setVal(ptl, 36, stereoPartner(bank, num), null);
}
function waveBrowser(n, P) {
  const ptl = TP(n, 'ptl_' + P), syn = TP(n, 'synPtl_' + P); if (!mem[ptl] || !mem[syn]) return;
  const before = { osc: raw(syn, 0), gt: raw(ptl, 27), gid: raw(ptl, 28), L: raw(ptl, 32), R: raw(ptl, 36) };
  const w0 = waveOf(n, P);
  let bank = (w0 && w0.bank) || LS.get('waveBank', 'A'), q = '', cur = w0 && w0.bank ? { bank: w0.bank, num: w0.L } : null;
  const v = document.createElement('div'); v.className = 'panelveil';
  v.innerHTML = `<div class="panel wavepanel" role="dialog" aria-modal="true" aria-label="Choose a wave">
    <h2>Wave for partial ${P}</h2>
    <div class="wavetop"><div class="wtabs" role="tablist">${Object.keys(D.waves || {}).map((b) => `<button role="tab" data-b="${b}">Bank ${b}</button>`).join('')}</div>
    <label class="wsearch"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg><input type="search" placeholder="Search all waves" aria-label="Search waves"></label></div>
    <div class="wlist" role="listbox" tabindex="0"></div>
    <div class="wfoot"><span class="wnow"></span><button class="stay">Cancel</button><button class="choice primary wdone">Use this wave</button></div></div>`;
  document.body.appendChild(v);
  const list = v.querySelector('.wlist'), inp = v.querySelector('input'), now = v.querySelector('.wnow');
  const rows = () => {
    const all = []; const ql = q.trim().toLowerCase();
    for (const [b, names] of Object.entries(D.waves || {})) {
      if (!ql && b !== bank) continue;
      names.forEach((nm, i) => { if (nm && (!ql || nm.toLowerCase().includes(ql) || waveNo(b, i + 1).toLowerCase().includes(ql))) all.push([b, i + 1, nm]); });
    }
    return all;
  };
  const draw = () => {
    v.querySelectorAll('[data-b]').forEach((t) => { t.classList.toggle('on', !q.trim() && t.dataset.b === bank); t.setAttribute('aria-selected', String(!q.trim() && t.dataset.b === bank)); });
    const rs = rows();
    list.innerHTML = rs.length ? rs.map(([b, i, nm]) => `<button role="option" data-w="${b}-${i}" class="${cur && cur.bank === b && cur.num === i ? 'on' : ''}"><small>${waveNo(b, i)}</small>${esc(nm)}${stereoPartner(b, i) ? '<em>stereo</em>' : ''}</button>`).join('') : '<div class="wnone">No waves match</div>';
    const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    now.textContent = cur ? `${waveNo(cur.bank, cur.num)} · ${(D.waves[cur.bank] || [])[cur.num - 1] || ''}` : '';
  };
  const pick = (b, i) => { cur = { bank: b, num: i }; setWave(n, P, b, i); draw(); };
  const close = (keep) => {
    if (!keep) {                                     // put the partial back as it was
      if (raw(syn, 0) !== before.osc) setVal(syn, 0, before.osc, null);
      [[27, 'gt'], [28, 'gid'], [32, 'L'], [36, 'R']].forEach(([o, k]) => { if (raw(ptl, o) !== before[k]) setVal(ptl, o, before[k], null); });
    }
    v.remove(); document.removeEventListener('keydown', key, true); renderMain(true); renderInspector();
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
    if (e.key === 'Enter' && document.activeElement !== inp) { e.preventDefault(); close(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); const rs = rows(); if (!rs.length) return;
      let i = cur ? rs.findIndex(([b, k]) => b === cur.bank && k === cur.num) : -1;
      i = Math.max(0, Math.min(rs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      pick(rs[i][0], rs[i][1]);
    }
  };
  document.addEventListener('keydown', key, true);
  v.querySelectorAll('[data-b]').forEach((t) => { t.onclick = () => { bank = t.dataset.b; LS.set('waveBank', bank); q = ''; inp.value = ''; draw(); }; });
  inp.oninput = () => { q = inp.value; draw(); };
  list.onclick = (e) => { const r = e.target.closest('[data-w]'); if (!r) return; const [b, i] = r.dataset.w.split('-'); pick(b, +i); };
  list.ondblclick = (e) => { if (e.target.closest('[data-w]')) close(true); };
  v.querySelector('.stay').onclick = () => close(false);
  v.querySelector('.wdone').onclick = () => close(true);
  v.onclick = (e) => { if (e.target === v) close(false); };
  draw(); list.focus();
}
// a new tone starts from the instrument's own blank tone, in an empty user tone slot
async function newTone(n) {
  if (toneDirty(n)) return toneGuard(n, () => newTone(n));
  if (!state.userTones) await fetchUserTones();
  const idx = (state.userTones || []).findIndex(isInitTone);
  if (idx < 0) { toast('Every user tone slot is in use. Save over one of your own tones instead.'); return; }
  state.toneTarget[n] = idx; state.toneNameDraft[n] = 'New Tone'; state.partial = 1;
  setTone(n, 71, 8 + (idx >> 7), idx & 127);
  state.toneTarget[n] = idx; state.toneNameDraft[n] = 'New Tone';
  toast(`New tone in U${String(idx + 1).padStart(3, '0')}: choose a wave for each partial, then hold save to keep it.`);
}
// ---- partials: solo to hear one on its own, add, remove ----
const PSW = (i) => 2 + 9 * (i - 1);                // a partial's on/off switch, in the tone's mix table
function partialIsOn(n, i) {                       // as saved in the tone, whatever solo is doing
  const s = state.solo; if (s && s.part === n) return s.saved[i];
  return raw(TP(n, 'pmt'), PSW(i));
}
function setSwitches(n, want) {                    // straight to the instrument: hearing, not editing
  const pmt = TP(n, 'pmt'); if (!mem[pmt]) return;
  for (let j = 1; j <= 4; j++) if (raw(pmt, PSW(j)) !== want[j]) { mem[pmt][PSW(j)] = want[j]; dev.dt1(block(pmt).base + PSW(j), [want[j]]); }
}
function unsolo() {
  const s = state.solo; if (!s) return;
  state.solo = null; setSwitches(s.part, s.saved);
}
function toggleSolo(n, i) {
  const was = state.solo; unsolo();
  if (!(was && was.part === n && was.p === i)) {
    const saved = {}; for (let j = 1; j <= 4; j++) saved[j] = raw(TP(n, 'pmt'), PSW(j));
    state.solo = { part: n, p: i, saved };
    setSwitches(n, { 1: +(i === 1), 2: +(i === 2), 3: +(i === 3), 4: +(i === 4) });
  }
  renderMain(true);
}
const PARTIAL_BLOCKS = ['synPtl', 'ptl', 'ptlFenv', 'ptlAenv', 'ptlLfo', 'ptlPenv', 'ptlEq'];
function addPartial(n, i) {                        // a new partial starts from partial 1's shaping, then you pick its wave
  unsolo();
  const from = [1, 2, 3, 4].find((j) => j !== i && raw(TP(n, 'pmt'), PSW(j)));
  if (from) for (const b of PARTIAL_BLOCKS) {
    const a = TP(n, `${b}_${from}`), t = TP(n, `${b}_${i}`); if (!mem[a] || !mem[t]) continue;
    mem[t].set(mem[a]); dev.dt1(block(t).base, Array.from(mem[t]));
  }
  setVal(TP(n, 'pmt'), PSW(i), 1);
  state.partial = i; renderMain(); renderInspector();
  waveBrowser(n, i);
}
function removePartial(n, i) {
  unsolo();
  const on = [1, 2, 3, 4].filter((j) => raw(TP(n, 'pmt'), PSW(j)));
  if (on.length <= 1) { toast('A tone needs at least one partial'); return; }
  const ptl = TP(n, 'ptl_' + i), keep = { L: raw(ptl, 32), R: raw(ptl, 36) };
  setVal(TP(n, 'pmt'), PSW(i), 0); setVal(ptl, 32, 0); setVal(ptl, 36, 0);   // off, and its wave cleared
  if (state.partial === i) state.partial = on.find((j) => j !== i);
  renderMain(); renderInspector();
  toast(`Partial ${i} removed`, { label: 'Undo', run: () => { setVal(ptl, 32, keep.L); setVal(ptl, 36, keep.R); setVal(TP(n, 'pmt'), PSW(i), 1); state.partial = i; renderMain(); renderInspector(); } });
}
const toneBlocks = (n) => TONE_BLOCKS.map((b) => TP(n, b));
// ---- save a tone to this computer as a ZENOLOGY user bank (slot 1; the other slots blank) ----
const CRC_T = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zenRecord(n, name) {
  const Z = window.ZEN, r = new Uint8Array(Z.recSize);
  for (const [i, b] of Z.blank) r[i] = b;
  for (const [blk, [copies, stride, base, fields]] of Object.entries(Z.blocks)) {
    for (let k = 0; k < copies; k++) {
      const src = mem[TP(n, copies > 1 ? `${blk}_${k + 1}` : blk)]; if (!src) continue;
      for (const [aeOff, size, centre, pos, w] of fields) {
        const v = dec(src, aeOff, size) - centre, at = base + stride * k + pos;
        for (let i = 0; i < w; i++) r[at + i] = (v >> (8 * i)) & 255;
      }
    }
  }
  const t = (name || 'Tone').slice(0, 16).padEnd(16);
  for (let i = 0; i < 16; i++) { const c = t.charCodeAt(i); r[0x10 + i] = c >= 32 && c < 127 ? c : 32; }
  return r;
}
async function saveToneForZenology(n) {
  if (!window.ZEN || !window.CompressionStream) { toast('This browser can’t write ZENOLOGY files'); return; }
  for (const p of toneBlocks(n)) if (!mem[p]) await readBlock(p);
  const Z = window.ZEN, name = (state.toneNameDraft[n] ?? currentToneName(n)).trim() || 'Tone';
  const rec = zenRecord(n, name), blank = new Uint8Array(Z.recSize); for (const [i, b] of Z.blank) blank[i] = b;
  const raw = new Uint8Array(0x20 + Z.recSize * Z.count); raw.set(Z.svd, 0);
  for (let i = 0; i < Z.count; i++) raw.set(i ? blank : rec, 0x20 + i * Z.recSize);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const head = new Uint8Array(Z.head), dv = new DataView(head.buffer);
  dv.setUint32(0x1c, 0x40 + z.length, true); dv.setUint32(0x38, 0x20 + z.length, true);
  dv.setUint32(0x3c, crc32(z), true); dv.setUint32(0x48, raw.length, true);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([head, z], { type: 'application/octet-stream' }));
  a.download = `${name.replace(/[^\w.-]+/g, '_')}.bin`; a.click();
  toast(`Saved ${name} for ZENOLOGY. In ZENOLOGY: Write › Import`);
}
// Ctrl/Cmd+Shift+E in Tones: save this part's tone exactly as the instrument holds it (for comparing with other ZEN-Core software)
function exportToneData(n) {
  const blocks = {}; for (const b of TONE_BLOCKS) { const p = TP(n, b); if (mem[p]) blocks[b] = Array.from(mem[p]).map(hexb).join(' '); }
  if (!Object.keys(blocks).length) { toast('Open a ZEN-Core tone first'); return; }
  const pp = SP('part_' + n), name = currentToneName(n) || 'tone';
  const o = { app: 'Aerophone Companion', version: (window.AE_VERSION || {}).version, tone: name, bank: [2, 3, 4].map((x) => raw(pp, x)), part: n, blocks };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(o, null, 1)], { type: 'application/json' }));
  a.download = `${name.replace(/[^\w.-]+/g, '_')}.tone.json`; a.click();
  toast(`Saved ${name} tone data`);
}
function toneSnap(n) { const o = {}; for (const p of toneBlocks(n)) if (mem[p]) o[p] = mem[p].slice(); return o; }
function toneDirty(n) {
  const b = state.toneBase[n]; if (!b) return false;
  const s = state.solo && state.solo.part === n ? state.solo : null, pmt = TP(n, 'pmt');
  const sw = (p, i, v) => { if (s && p === pmt) for (let j = 1; j <= 4; j++) if (i === PSW(j)) return s.saved[j]; return v; };
  return toneBlocks(n).some((p) => mem[p] && b[p] && mem[p].some((v, i) => sw(p, i, v) !== b[p][i]));
}
const tonesDirty = () => [1, 2, 3, 4].filter(toneDirty);
const userToneIdx = (n) => { const p = SP('part_' + n); return raw(p, 2) === 71 && raw(p, 3) >= 8 && raw(p, 3) <= 11 ? (raw(p, 3) - 8) * 128 + raw(p, 4) : -1; };
function toneTargetFor(n) {              // the slot this tone saves to: its own, or the first empty one
  if (state.toneTarget[n] != null) return state.toneTarget[n];
  const own = userToneIdx(n); if (own >= 0) return own;
  const free = (state.userTones || []).findIndex(isInitTone);
  return free >= 0 ? free : 0;
}
function currentToneName(n) { const c = TP(n, 'common'); return mem[c] ? String.fromCharCode(...mem[c].slice(0, TONE_NAME_LEN)).trim() : ''; }
function userToneOptions(target) {
  if (!state.userTones) return `<option value="${target}">U${String(target + 1).padStart(3, '0')}  (reading…)</option>`;
  return state.userTones.map((t, i) => `<option value="${i}" ${i === target ? 'selected' : ''}>U${String(i + 1).padStart(3, '0')}  ${isInitTone(t) ? '(empty)' : esc(t)}</option>`).join('');
}
function saveTone(n, idx, name) {
  unsolo();
  const c = TP(n, 'common'), p = SP('part_' + n);
  if (!mem[c] || !mem[p]) return;
  name = (name ?? currentToneName(n)).slice(0, TONE_NAME_LEN);
  const t = name.padEnd(TONE_NAME_LEN);
  for (let i = 0; i < TONE_NAME_LEN; i++) { let ch = t.charCodeAt(i); if (ch < 32 || ch > 126) ch = 32; mem[c][i] = ch; }
  dev.dt1(block(c).base, Array.from(mem[c].slice(0, TONE_NAME_LEN)));
  dev.dt1(CMD(0x0F001005 + 4 * (n - 1)), [0, (idx >> 8) & 15, (idx >> 4) & 15, idx & 15]);   // write this part's tone to the slot
  if (state.userTones) state.userTones[idx] = name.trim();
  const lsb = 8 + (idx >> 7), pc = idx & 127;          // the part now plays the saved tone
  [71, lsb, pc].forEach((v, i) => { mem[p][2 + i] = v; });
  dev.dt1(block(p).base + 2, [71, lsb, pc]);
  state.toneBase[n] = toneSnap(n); state.toneTarget[n] = idx;
  toast(`Tone saved to U${String(idx + 1).padStart(3, '0')}${name.trim() ? ' ' + name.trim() : ''}. Upload the scene so it keeps using it.`);
  render();
}
function toneGuard(n, action) {
  const idx = toneTargetFor(n), nm = currentToneName(n) || toneName(...[2, 3, 4].map((o) => raw(SP('part_' + n), o)));
  const v = document.createElement('div'); v.className = 'panelveil';
  v.innerHTML = `<div class="panel" role="dialog" aria-modal="true"><h2>Keep your edits to ${esc(nm)}?</h2><p>Tone edits live in the instrument's working copy until you save them to a user tone. Changing scene loses them.</p>
    <button class="choice primary" data-c="tone"><div class="fill"></div>${ICON.upload}<div><b>Hold to save the tone</b><span>To user tone U${String(idx + 1).padStart(3, '0')}${state.userTones && !isInitTone(state.userTones[idx]) ? ', replacing ' + esc(state.userTones[idx]) : ''}</span></div></button>
    <button class="choice" data-c="discard">${ICON.discard}<div><b>Discard tone edits</b><span>The scene keeps its saved tone</span></div></button>
    <button class="stay">Keep editing</button></div>`;
  document.body.appendChild(v);
  const close = () => v.remove();
  holdable(v.querySelector('[data-c=tone]'), () => { close(); saveTone(n, idx); action(); });
  v.querySelector('[data-c=discard]').onclick = () => { close(); unsolo(); state.toneBase[n] = toneSnap(n); action(); };
  v.querySelector('.stay').onclick = close;
  v.onclick = (e) => { if (e.target === v) close(); };
}
function toneBarHTML(n) {
  const dirty = toneDirty(n), idx = toneTargetFor(n), over = state.userTones && !isInitTone(state.userTones[idx]) && userToneIdx(n) !== idx;
  return `<div class="tonebar ${dirty ? 'edited' : ''}">
    <button class="tnew" id="tnew" title="Start a new tone in an empty user tone slot">${ICON.plus}New tone</button>
    <span class="tstate">${dirty ? `<span class="drafttxt">${ICON.draft}Draft</span>` : userToneIdx(n) >= 0 ? 'Your tone' : 'Preset tone'}</span>
    <input id="tname" maxlength="${TONE_NAME_LEN}" value="${esc(state.toneNameDraft[n] ?? currentToneName(n))}" title="Tone name" aria-label="Tone name">
    <select class="slot" id="tslot" title="User tone slot on the AE-20">${userToneOptions(idx)}</select>
    <button class="ib hold ${dirty ? 'want' : ''}" id="tsave" title="Hold to save this tone to the AE-20${over ? ', replacing ' + esc(state.userTones[idx]) : ''}">${RING}${ICON.upload}<span class="iblbl">Tone</span></button>
    <button class="ib" id="tzen" title="Save this tone to this computer as a ZENOLOGY bank file">${ICON.computer}</button>
  </div>`;
}
function bindToneBar(n) {
  const sel = $('#tslot'), nm = $('#tname'); if (!sel) return;
  if (!state.userTones) fetchUserTones();
  $('#tnew').onclick = () => newTone(n);
  $('#tzen').onclick = () => saveToneForZenology(n);
  sel.onchange = () => { state.toneTarget[n] = +sel.value; renderMain(true); };
  nm.onkeydown = (e) => { if (e.key === 'Enter') nm.blur(); e.stopPropagation(); };
  nm.oninput = () => { state.toneNameDraft[n] = nm.value; };
  holdable($('#tsave'), () => { delete state.toneNameDraft[n]; saveTone(n, +sel.value, nm.value); });
}

// names arrive bank by bank; preset names ship with the editor and your own are remembered from last time
function primeNames() {
  const cached = LS.get('userNames:' + (dev.name || ''), null);
  if (cached && !state.userSlots.length) {
    state.userSlots = cached.map(([lsb, pc, name]) => ({ msb: 85, lsb, pc, name }));
    for (const u of state.userSlots) state.scenes.set(sceneKey(85, u.lsb, u.pc), u.name);
  }
}
let namesT = null;
function namesArrived() {
  if (namesT) return;
  namesT = setTimeout(() => {
    namesT = null;
    if (state.view === 'favorites') renderFavoritesView();
    else if (state.view === 'library' && !document.body.matches('.dragging-scene,.dragging-slot')) renderLibrary();
  }, 250);
}
// scene names, bank by bank: a queue, so whatever is on screen can jump to the front
const lists = { queue: [], busy: false, fresh: {} };       // key 'g-bank' -> time it was last read
const BANKS_MAX_AGE = 60000;
function listBank(g, bank) {
  return new Promise((resolve) => {
    const got = [];
    let t = setTimeout(done, 5000);
    function done() { listCollector = null; clearTimeout(t); resolve(got); }
    listCollector = (d) => {
      // gg bb dd mm ll pp ii ii ii ii name[16]
      if (d.length < 26 || d[0] !== g || d[1] !== bank) return;
      const msb = d[3], lsb = d[4], pc = d[5];
      if (!msb && !lsb && !pc) return done();
      got.push({ msb, lsb, pc, name: String.fromCharCode(...d.slice(10, 26)).trim() });
      clearTimeout(t); t = setTimeout(done, 3000);
    };
    dev.dt1(CMD(0x0F004100), [g, bank, 0, 0, 0, 0, 0, 0x0F, 0x0F, 0x0F, 0x0F]);
  });
}
function wantBanks(keys, front) {     // keys like '1-3' (user bank 4) or '0-0' (preset bank 1)
  keys = keys.filter((k) => !(lists.fresh[k] > Date.now() - BANKS_MAX_AGE));
  lists.queue = lists.queue.filter((k) => !keys.includes(k));
  lists.queue = front ? [...keys, ...lists.queue] : [...lists.queue, ...keys];
  pumpLists();
}
async function pumpLists() {
  if (lists.busy) return; lists.busy = true;
  try {
    while (lists.queue.length && state.connected) {
      const k = lists.queue.shift(), [g, bank] = k.split('-').map(Number);
      if (lists.fresh[k] > Date.now() - BANKS_MAX_AGE) continue;
      const got = await listBank(g, bank);
      if (!state.connected) break;
      if (g === 1) {     // this bank is now exactly what the instrument says, including slots that became empty
        const lsb = bank;
        for (const key of [...state.scenes.keys()]) { const [m, l] = key.split('-').map(Number); if (m === 85 && l === lsb) state.scenes.delete(key); }
        state.userSlots = state.userSlots.filter((u) => u.lsb !== lsb).concat(got).sort((a, b) => a.lsb - b.lsb || a.pc - b.pc);
        LS.set('userNames:' + dev.name, state.userSlots.map((u) => [u.lsb, u.pc, u.name]));
      }
      for (const x of got) state.scenes.set(sceneKey(x.msb, x.lsb, x.pc), x.name);
      lists.fresh[k] = Date.now();
      namesArrived();
    }
  } finally { lists.busy = false; }
}
const favBanks = () => [...new Set((favorites() || []).filter(Boolean).map((f) => (f.lsb <= 11 ? `1-${f.lsb}` : `0-${f.lsb - 64}`)))];
const userBanks = (first) => { const all = Array.from({ length: 12 }, (_, i) => `1-${i}`); return first != null ? [`1-${first}`, ...all.filter((k) => k !== `1-${first}`)] : all; };
async function loadSceneLists() {      // at connect: favorites' banks, then your banks, then presets
  wantBanks([...favBanks(), ...userBanks(), ...Array.from({ length: 12 }, (_, i) => `0-${i}`)]);
  while ((lists.busy || lists.queue.length) && state.connected) await sleep(200);
}
// switching the wheel: check that what it shows is current
async function refreshMode(m) {
  if (!state.connected) return;
  if (m === 'fav') {
    if (!(lists.favAt > Date.now() - BANKS_MAX_AGE)) { for (let i = 1; i <= 12; i++) await readBlock(`System%Sys_favorite_${i}`); lists.favAt = Date.now(); }
    wantBanks(favBanks(), true);
  } else if (m === 'mine') {
    const hot = state.cat && state.cat.hot;
    wantBanks(userBanks(hot != null ? hot : (state.cur && state.cur.lsb <= 11 ? state.cur.lsb : 0)), true);
  } else if (m === 'presets') {
    const first = state.cur && state.cur.lsb >= 64 ? state.cur.lsb - 64 : 0;
    wantBanks([`0-${first}`, ...Array.from({ length: 12 }, (_, i) => `0-${i}`).filter((k) => k !== `0-${first}`)], true);
  }
  if (state.view === 'favorites') drawWheelLive();
}

function favorites() {
  return Array.from({ length: 12 }, (_, i) => {
    const p = `System%Sys_favorite_${i + 1}`;
    if (!mem[p] || !raw(p, 0)) return null;
    const s = { msb: raw(p, 1), lsb: raw(p, 2), pc: raw(p, 3) };
    const nm = state.scenes.get(sceneKey(s.msb, s.lsb, s.pc));
    return { ...s, name: nm || '…', pending: !nm };
  });
}

// ======================= actions =======================
function selectScene(s) { dev.dt1(block('stp').base, [s.msb, s.lsb, s.pc]); state.cur = s; scheduleSceneLoad(); }
function stepScene(dir) {
  if (!state.cur) return;
  const { msb, lsb, pc } = state.cur;
  let npc = pc + dir, nlsb = lsb;
  const user = lsb <= 11, lo = user ? 0 : 64, hi = user ? 11 : 75;
  if (npc < 0) { nlsb = lsb - 1 < lo ? hi : lsb - 1; npc = 49; }
  if (npc > 49) { nlsb = lsb + 1 > hi ? lo : lsb + 1; npc = 0; }
  if (!user) {   // preset banks have fewer scenes: keep to the names we know
    const keys = [...state.scenes.keys()].filter((k) => k.startsWith('85-')).map((k) => k.split('-').map(Number)).filter((a) => a[1] >= 64).sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    const i = keys.findIndex((a) => a[1] === lsb && a[2] === pc);
    if (keys.length && i >= 0) { const a = keys[(i + dir + keys.length) % keys.length]; nlsb = a[1]; npc = a[2]; }
  }
  selectScene({ msb, lsb: nlsb, pc: npc });
}
function switchFavorite(i) {
  const f = favorites()[i]; if (!f) return;
  dev.dt1(block('stp').base + 3, [i]);
  state.curFav = i; state.cur = { msb: f.msb, lsb: f.lsb, pc: f.pc }; scheduleSceneLoad();
}
function saveFavorite(i) {
  const s = state.cur; if (!s) return;
  const p = `System%Sys_favorite_${i + 1}`;
  [1, s.msb, s.lsb, s.pc].forEach((v, k) => { mem[p][k] = v; });
  dev.dt1(block(p).base, [1, s.msb, s.lsb, s.pc]);
  dev.dt1(CMD(0x0F001000), [0]);                  // system write
  toast(`Favorite ${i + 1} is now ${sceneName()}`);
  render();
}
function writeScene(slot) {
  const n = slot.lsb * 50 + slot.pc;
  dev.dt1(CMD(0x0F001001), [0, (n >> 8) & 15, (n >> 4) & 15, n & 15]);
  state.scenes.set(sceneKey(85, slot.lsb, slot.pc), sceneName());
  toast(`Uploaded to ${sceneNo(slot)}`);
  state.base = snapshot(); state.unstored = false;
  setTimeout(() => { state.cur = { msb: 85, lsb: slot.lsb, pc: slot.pc }; render(); }, 600);
}
function renameScene(text) {
  const t = text.slice(0, 16).padEnd(16);
  for (let i = 0; i < 16; i++) { let c = t.charCodeAt(i); if (c < 32 || c > 126) c = 32; mem[SP('common')][i] = c; }
  dev.dt1(block(SP('common')).base, Array.from(mem[SP('common')].slice(0, 16)));
  render();
}
function setFxType(path, list, id) {
  const isMfx = /mfx|ifx/.test(path);
  const t = (FX_LISTS[list]).find((x) => x.id === id); if (!t) return;
  const base = isMfx ? 0x10 : path.endsWith('rev') ? 3 : 4;
  const d = mem[path];
  const typeOff = isMfx ? 0 : 1;
  d[typeOff] = id;
  const pOff = (n) => base + 4 * n;
  const nParams = isMfx ? 32 : 20;
  const bytes = [];
  for (let n = 0; n < nParams; n++) { const v = (t.defVal[n] ?? 0) + 32768; enc(v, INTEGER4x4).forEach((b, i) => { d[pOff(n) + i] = b; }); }
  dev.dt1(block(path).base + typeOff, [id]);
  dev.dt1(block(path).base + base, Array.from(d.slice(base, base + nParams * 4)));
  if (isMfx) { d[1] = id ? 1 : 0; dev.dt1(block(path).base + 1, [d[1]]); }
  else { d[0] = id ? 1 : 0; dev.dt1(block(path).base, [d[0]]); }
  changed();
}
const FX_LISTS = { MFX: MFX_TYPE_LIST, CHO: CHORUS_TYPE_LIST, DLY: DELAY_TYPE_LIST, REV: REVERB_TYPE_LIST };
function fxNum(list, id) {           // the number an effect type's settings are filed under (as in the Parameter Guide)
  const t = FX_LISTS[list].find((x) => x.id === id); if (!t || !id) return t ? '0' : null;
  return t.text.split(' ')[0];
}
// the long effect list, grouped the way players look for things; names as on the AE-20's screen
const FX_GROUPS = [
  ['Drive and amp', ['Overdrive', 'Distortion', 'T-Scream', 'Fuzz', 'Guitar Amp Simulator', 'Speaker Simulator']],
  ['Modulation', ['Chorus', 'Hexa-Chorus', 'Space-D', 'Flanger', 'Step Flanger', 'Phaser 1', 'Tremolo', 'Auto Pan', 'VK Rotary']],
  ['Delay', ['Delay', 'Modulation Delay', '2 Tap Pan Delay', '3 Tap Pan Delay', 'Tape Echo', 'Gt->Delay']],
  ['Filter and wah', ['Auto Wah', 'Humanizer']],
  ['Pitch', ['Pitch Shifter', '2 Voice Pitch Shifter']],
  ['Tone and EQ', ['Equalizer', 'Low Boost', 'Enhancer', 'Exciter']],
  ['Dynamics and lo-fi', ['Compressor', 'Limiter', 'LOFI Compress']],
  ['Classic Roland units', ['CE-1', 'SBF-325', 'SDD-320', 'JUNO-106 Chorus']],
];
function fxOptions(list, cur) {
  const opt = (x) => `<option value="${x.id}" ${x.id === cur ? 'selected' : ''}>${esc(fxName(list, x.id))}</option>`;
  const all = FX_LISTS[list];
  if (list !== 'MFX') return all.map(opt).join('');
  const nm = (x) => x.text.replace(/^\d+\s+/, ''), used = new Set();
  let h = all.filter((x) => !x.id).map(opt).join('');
  for (const [g, names] of FX_GROUPS) {
    const items = names.map((n) => all.find((x) => x.id && nm(x) === n)).filter(Boolean);
    items.forEach((x) => used.add(x.id));
    if (items.length) h += `<optgroup label="${g}">${items.map(opt).join('')}</optgroup>`;
  }
  const rest = all.filter((x) => x.id && !used.has(x.id));          // anything a newer firmware adds
  if (rest.length) h += `<optgroup label="Other">${rest.map(opt).join('')}</optgroup>`;
  return h;
}
function fxName(list, id) { const t = FX_LISTS[list].find((x) => x.id === id); return t ? (t.id ? t.text.replace(/^\d+\s+/, '') : 'Off') : `Type ${id}`; }

// ======================= UI helpers =======================
function status(kind, text) { const c = $('#conn'); c.className = 'conn ' + kind; c.querySelector('span').textContent = text; }
let toastT;
function toast(t, act) {
  const e = $('#toast'); e.innerHTML = `<span>${esc(t)}</span>${act ? `<button>${esc(act.label)}</button>` : ''}`;
  if (act) e.querySelector('button').onclick = () => { e.classList.remove('show'); act.run(); };
  e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('show'), act ? 7000 : 2600);
}
let changeT;
function changed() { if (state.dragging) return; if (state.view === 'favorites' || state.view === 'live-quiet') return; clearTimeout(changeT); changeT = setTimeout(() => { renderMain(true); }, 40); }
const HEART = 'M0 9C-1.6 7.4-9.5 2.6-9.5-3.2-9.5-6.6-6.9-9-4-9-2.2-9-.8-8-0-6.6 .8-8 2.2-9 4-9 6.9-9 9.5-6.6 9.5-3.2 9.5 2.6 1.6 7.4 0 9z';
const PIN = '<svg viewBox="0 0 16 16"><path d="M9.5 1.5l5 5-2 .8-2.6 2.6.3 3.1-1.2 1.2-3-3-3.5 3.5-.9-.1-.1-.9 3.5-3.5-3-3 1.2-1.2 3.1.3L9.7 3.5z"/></svg>';

// ---- pins: which three values show on a node ----
const PIN_DEFAULTS = {
  part: ['Temporary_Scene%Perf_part_N%5', 'Temporary_Scene%Perf_part_N%24', 'Temporary_Scene%Perf_part_N%7'],
  pcm: ['Temporary_Tone_PCM%PCMEX_ptl_N%0', 'Temporary_Tone_PCM%PCMEX_ptl_N%1', 'Temporary_Tone_PCM%PCMEX_ptl_N%2'],   // a PCM wave: level and tuning
  osc: ['Temporary_Tone_PCM%PCMEX_synPtl_N%1', 'Temporary_Tone_PCM%PCMEX_synPtl_N%6', 'Temporary_Tone_PCM%PCMEX_synPtl_N%7'],
  filter: ['Temporary_Tone_PCM%PCMEX_ptl_N%50', 'Temporary_Tone_PCM%PCMEX_ptl_N%61', 'Temporary_Tone_PCM%PCMEX_ptlFenv_N%0'],
  amp: ['Temporary_Tone_PCM%PCMEX_ptlAenv_N%4', 'Temporary_Tone_PCM%PCMEX_ptlAenv_N%16', 'Temporary_Tone_PCM%PCMEX_ptlAenv_N%28'],
  eq: ['Temporary_Tone_PCM%PCMEX_ptlEq_N%0', 'Temporary_Tone_PCM%PCMEX_ptlEq_N%4', 'Temporary_Tone_PCM%PCMEX_ptlEq_N%8'],
  lfo: ['Temporary_Tone_PCM%PCMEX_ptlLfo_N%0', 'Temporary_Tone_PCM%PCMEX_ptlLfo_N%4', 'Temporary_Tone_PCM%PCMEX_ptlLfo_N%23'],
};
function pinsFor(type) { return LS.get('pins:' + type, null) || PIN_DEFAULTS[type] || null; }
function togglePin(type, key) {
  let p = [...(pinsFor(type) || [])];
  if (p.includes(key)) p = p.filter((k) => k !== key); else { p.push(key); if (p.length > 3) p.shift(); }
  LS.set('pins:' + type, p); renderMain(true); renderInspector();
}
// a pinned key (catalog form) -> concrete path + offset for this node
function resolveKey(key, ctx) {
  const parts = key.split('%');
  const fx = parts[3] ? parts[3].replace('fx', '') : null;
  let root = parts[0], child = parts[1];
  const off = +parts[2];
  if (root === 'Temporary_Tone_PCM') root = `Temporary_Tone_PCM_(${ctx.tonePart})`;
  if (child.endsWith('_N')) child = child.replace(/_N$/, '_' + (ctx.n || 1));
  return { path: root + '%' + child, off, fx };
}
function miniRows(keys, ctx) {
  return keys.map((k) => {
    const { path, off, fx } = resolveKey(k, ctx);
    if (!mem[path]) return '';
    const c = cat(path, off, fx); const v = val(path, off, fx); const [mn, mx] = range(path, off, fx);
    const frac = mx > mn ? (v - mn) / (mx - mn) : 0;
    const bar = c && c.options ? '<div></div>' : `<div class="bar"><i style="left:0;width:${Math.max(2, frac * 100).toFixed(0)}%"></i></div>`;
    const opts = c && c.options;
    return `<div class="mini ${opts ? 'opt' : 'drag'}" title="" data-path="${esc(path)}" data-off="${off}" data-fx="${fx ?? ''}"><label>${esc(short(nameFor(path, off, fx)))}</label>${bar}<output>${esc(display(path, off, fx))}</output></div>`;
  }).join('');
}

// ======================= rendering =======================
function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
  if (!state.connected) return renderConnect();
  renderMain(); renderInspector();
}

function renderConnect(err) {
  document.body.classList.add('noinsp');
  let opts = '', found = false;
  if (dev.access) {
    const names = [...new Set(dev.ports().outs.map((p) => dev.normName(p.name)))];
    const ae = names.filter((n) => /^(AE-20|AE-30|GC011)/.test(n)); found = ae.length > 0;
    if (ae.length > 1) opts = `<select class="sel" id="portsel">${ae.map((n) => `<option>${esc(n)}</option>`).join('')}</select>`;
    else if (ae.length === 1) opts = `<input type="hidden" id="portsel" value="${esc(ae[0])}">`;
    else if (names.length) opts = `<details class="more"><summary>Use another MIDI device</summary><select class="sel" id="portsel">${names.map((n) => `<option>${esc(n)}</option>`).join('')}</select></details>`;
  }
  const blocked = err && (err.name === 'SecurityError' || err.name === 'NotAllowedError');
  $('#main').innerHTML = `<div class="connect"><div class="ccard">
    <h2>${state.lost ? 'The AE-20 isn’t answering' : 'Connect your Aerophone'}</h2>
    <p>${state.lost && !blocked ? 'It was turned off or unplugged. Turn it on or plug it back in and it reconnects by itself, or click Connect. Your unsaved edits are still here.' : blocked ? 'MIDI access was blocked. Allow MIDI devices for this page in the browser’s site settings, then try again.'
      : dev.access && !found ? 'No AE-20 found. Turn it on and plug it in with a USB cable. If it still doesn’t appear, install Roland’s AE-20 USB driver.' : dev.access ? 'Your AE-20 is plugged in.' : 'Plug the AE-20 in with a USB cable and turn it on.'}</p>
    ${opts}
    <button class="btn primary" id="go">Connect</button></div></div>`;
  $('#go').onclick = () => { const ps = $('#portsel'); connect(ps && (ps.type === 'hidden' || ps.closest('details[open]') || ps.tagName === 'SELECT' && !ps.closest('details')) ? ps.value : undefined); };
}

function renderMain(soft) {
  if (!state.connected) return;
  if (state.view !== 'library') document.body.classList.remove('picking');
  document.body.classList.toggle('noinsp', state.view === 'favorites' || state.view === 'library');
  if (state.view === 'favorites') return renderFavoritesView();
  if (state.view === 'library') return renderLibrary();
  if (state.view === 'tones') return renderTones(soft);
  return renderScene(soft);
}

// ---- shared canvas + title ----
function canvasShell(inner, w, h) {
  const prev = $('#main .canvas');
  const mainW = $('#main').clientWidth;
  const z = state.zoom === 'fit' ? Math.min(1, (mainW - 24) / w) : state.zoom;
  const sx = prev ? prev.scrollLeft : 0, sy = prev ? prev.scrollTop : 0;
  $('#main').innerHTML = `<div class="canvas"><div class="stage" style="width:${w}px;height:${h}px;transform:scale(${z})">${inner}<svg class="cables" width="${w}" height="${h}"></svg></div></div>
    ${titleHTML()}
    <div class="zoom"><button data-z="-">−</button><button data-z="1">${Math.round(z * 100)}%</button><button data-z="+">+</button><button data-z="fit">Fit</button></div>`;
  const cv = $('#main .canvas'); cv.scrollLeft = sx; cv.scrollTop = sy;
  bindTitle();
  $('#main .zoom').onclick = (e) => {
    const z = e.target.dataset.z; if (!z) return;
    const curz = state.zoom === 'fit' ? Math.min(1, (mainW - 24) / w) : state.zoom;
    state.zoom = z === 'fit' ? 'fit' : z === '+' ? Math.min(1.6, curz + 0.1) : z === '-' ? Math.max(0.4, curz - 0.1) : 1;
    LS.set('zoom', state.zoom); renderMain();
  };
}
const ICON = {
  heart: `<svg class="g" viewBox="-12 -12 24 24"><path d="${'M0 9C-1.6 7.4-9.5 2.6-9.5-3.2-9.5-6.6-6.9-9-4-9-2.2-9-.8-8-0-6.6 .8-8 2.2-9 4-9 6.9-9 9.5-6.6 9.5-3.2 9.5 2.6 1.6 7.4 0 9z'}"/></svg>`,
  library: '<svg class="g" viewBox="0 0 24 24"><path d="M4 20.5h16"/><rect x="5" y="5" width="3.5" height="15.5" rx=".6"/><rect x="9.5" y="7.5" width="3.5" height="13" rx=".6"/><path d="M14.6 8.6l3.2-.9 3.2 11.9-3.2.9z"/></svg>',
  computer: '<svg class="g" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12.5" rx="1.6"/><path d="M9 20.5h6M12 16.5v4"/><path d="M12 7.5v5.5M9.6 10.8l2.4 2.4 2.4-2.4"/></svg>',
  disk: '<svg class="g" viewBox="0 0 24 24"><path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z"/><path d="M8 3v5h7V3"/><rect x="7.5" y="13" width="9" height="6" rx="1"/></svg>',
  upload: '<svg class="g" viewBox="0 0 24 24"><path d="M12 15V4.5M7.5 9L12 4.5L16.5 9"/><path d="M4.5 13.5v5.5h15v-5.5"/></svg>',
  download: '<svg class="g" viewBox="0 0 24 24"><path d="M12 4.5V15M7.5 10.5L12 15L16.5 10.5"/><path d="M4.5 13.5v5.5h15v-5.5"/></svg>',
  revert: '<svg class="g" viewBox="0 0 24 24"><path d="M4 5v5h5"/><path d="M5 10a8 8 0 1 1 1.6 6.5"/></svg>',
  trash: '<svg class="g" viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/></svg>',
  play: '<svg class="g" viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>',
  plus: '<svg class="g" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  open: '<svg class="g" viewBox="0 0 24 24"><path d="M12 15V4.5M7.5 9L12 4.5L16.5 9" transform="rotate(180 12 9.75)"/><path d="M4.5 13.5v5.5h15v-5.5"/></svg>',
  draft: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  discard: '<svg class="g" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const RING = '<svg class="ring" viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" class="t"/><circle cx="26" cy="26" r="24" class="p"/></svg>';
function slotOptions(target) {
  const slots = state.userSlots.length ? state.userSlots : Array.from({ length: 50 }, (_, pc) => ({ msb: 85, lsb: 0, pc, name: '' }));
  return slots.map((u) => `<option value="${u.lsb}-${u.pc}" ${target && u.lsb === target.lsb && u.pc === target.pc ? 'selected' : ''}>U${pad2(u.lsb + 1)}-${pad2(u.pc + 1)}${u.name ? '  ' + esc(u.name) : ''}</option>`).join('');
}
function uploadTarget() { return state.writeTarget || (isUser(state.cur) ? state.cur : { msb: 85, lsb: 0, pc: 0 }); }
function titleHTML() {
  const dirty = isDirty();
  const lib = state.entry && state.libs.find((l) => l.id === state.entry.lib);
  const sub = lib ? `From ${lib.name}` : sceneNo(state.cur);
  return `<div class="title">
    <button class="step" id="prev" title="Previous scene">&#8249;</button>
    <div><h1><span id="sname" title="Rename">${esc(sceneName() || '…')}</span></h1><p>${dirty ? `<span class="drafttxt">${ICON.draft}Draft</span> · ` : ''}${esc(sub)}${state.loading ? ', reading' : ''}</p></div>
    <button class="step" id="next" title="Next scene">&#8250;</button>
  </div>
  <div class="acts">
    <button class="ib ${dirty ? 'want' : ''}" id="save" title="Save to Library">${ICON.library}<span class="iblbl">Library</span></button>
    <button class="ib hold ${dirty ? 'want' : ''}" id="upload" title="Hold to upload this scene to the AE-20">${RING}${ICON.upload}<span class="iblbl">Scene</span></button>
    <select class="slot" id="wslot" title="User slot on the AE-20">${slotOptions(uploadTarget())}</select><span class="sep"></span>
    <button class="ib" id="revert" title="Revert to saved" ${dirty ? '' : 'disabled'}>${ICON.revert}</button>
  </div>`;
}
// press-and-hold with a filling ring or bar; fires once the fill completes
function holdable(el, onDone, ms = 750) {
  let t = null;
  const cancel = () => { clearTimeout(t); t = null; el.classList.remove('go'); };
  el.style.setProperty('--hold', ms + 'ms');
  el.onpointerdown = (e) => {
    if (e.button !== 0) return; e.preventDefault();
    el.classList.add('go');
    t = setTimeout(() => { t = null; el.classList.remove('go'); el.classList.add('done'); setTimeout(() => el.classList.remove('done'), 450); onDone(); }, ms);
  };
  el.onpointerup = cancel; el.onpointerleave = cancel;
  el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!t) el.onpointerdown({ button: 0, preventDefault() {} }); } };
  el.onkeyup = (e) => { if (e.key === 'Enter' || e.key === ' ') cancel(); };
}
function bindTitle() {
  $('#prev').onclick = () => guard(() => stepScene(-1));
  $('#next').onclick = () => guard(() => stepScene(1));
  $('#save').onclick = () => saveToLibrary();
  $('#revert').onclick = () => revert();
  const sel = $('#wslot');
  sel.onchange = () => { const [l, p] = sel.value.split('-').map(Number); state.writeTarget = { msb: 85, lsb: l, pc: p }; };
  holdable($('#upload'), () => { const [l, p] = sel.value.split('-').map(Number); writeScene({ msb: 85, lsb: l, pc: p }); });
  const h1 = $('#sname');
  h1.onclick = () => {
    const cur = sceneName();
    h1.innerHTML = `<input maxlength="16" value="${esc(cur)}">`;
    const inp = h1.querySelector('input'); inp.focus(); inp.select();
    const done = (ok) => { if (ok && inp.value !== cur) renameScene(inp.value); else renderMain(true); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  };
}

function drawCables(links) {
  const svg = $('#main svg.cables'); if (!svg) return;
  const stage = $('#main .stage');
  let out = '', dots = '';
  const focus = state.sel && state.sel.id;
  for (const [a, b, kind, w] of links) {
    const ea = stage.querySelector(`[data-node="${a}"]`), eb = stage.querySelector(`[data-node="${b}"]`);
    if (!ea || !eb) continue;
    const dim = focus && a !== focus && b !== focus ? ' opacity=".16"' : '';
    const st = kind === 'air' || kind === 'mod' ? 'stroke="var(--air)" stroke-dasharray="6 5"' : kind === 'off' ? 'stroke="var(--ghost)" stroke-dasharray="2 5"' : 'stroke="var(--audio)"';
    let d;
    if (kind === 'mod') {
      // modulation from below: leave the source's top, enter the target's bottom
      const x1 = ea.offsetLeft + ea.offsetWidth / 2, y1 = ea.offsetTop, x2 = eb.offsetLeft + eb.offsetWidth / 2, y2 = eb.offsetTop + eb.offsetHeight;
      const dy = Math.max(30, (y1 - y2) / 2);
      d = `M${x1} ${y1} C ${x1} ${y1 - dy}, ${x2} ${y2 + dy}, ${x2} ${y2}`;
      dots += `<circle cx="${x1}" cy="${y1}" r="5" fill="var(--paper)" stroke="var(--air)" stroke-width="2"/><circle cx="${x2}" cy="${y2}" r="5" fill="var(--paper)" stroke="var(--air)" stroke-width="2"/>`;
    } else {
      const x1 = ea.offsetLeft + ea.offsetWidth, y1 = ea.offsetTop + Math.min(ea.offsetHeight / 2, 64);
      const x2 = eb.offsetLeft, y2 = eb.offsetTop + Math.min(eb.offsetHeight / 2, 64);
      const dx = Math.max(30, (x2 - x1) / 2);
      d = `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }
    out += `<path ${kind === 'air' ? 'class="aircab" ' : ''}d="${d}" fill="none" ${st} stroke-width="${w || 2}" stroke-linecap="round"${dim}/>`;
  }
  svg.innerHTML = out + dots;
}
function nodeHTML(id, x, y, cls, title, sub, body, extra = '') {
  const sel = state.sel && state.sel.id === id ? ' sel' : '';
  return `<div class="node ${cls}${sel}" data-node="${id}" style="left:${x}px;top:${y}px" tabindex="0">
    <h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}${body ? `<div class="rows">${body}</div>` : ''}${extra}</div>`;
}
function bindNodes(defs) {
  const stage = $('#main .stage');
  stage.onclick = (e) => {
    if (state.justDragged) { state.justDragged = false; return; }
    const n = e.target.closest('.node');
    if (!n) { if (state.sel) { state.sel = null; renderMain(true); renderInspector(); } return; }
    const d = defs[n.dataset.node]; if (!d) return;
    const tag = e.target.closest('[data-tag]');
    if (tag) { const [p, o] = [tag.dataset.path, +tag.dataset.off]; const v = val(p, o); setVal(p, o, o === 36 ? (v === 0 ? 1 : 0) : (v === 1 ? 0 : 1)); }
    const cv = e.target.closest('[data-curve]');
    if (cv) { const b = cv.dataset.curve; setVal(b, 7, ((raw(b, 7) || 0) + (e.shiftKey ? 11 : 1)) % 12); }
    if (d.type === 'part' && !raw(SP('part_' + d.n), 1)) { setVal(SP('part_' + d.n), 1, 1); d.title = toneName(raw(SP('part_' + d.n), 2), raw(SP('part_' + d.n), 3), raw(SP('part_' + d.n), 4)); toast(`Part ${d.n} is on`); }
    if (d.type === 'partial') { addPartial(state.tonePart, state.partial); return; }
    state.sel = d; renderMain(true); renderInspector();
  };
  // values inside a node: drag up or down, or use the mouse wheel
  const rowOf = (e) => e.target.closest('.mini[data-path]');
  const nudge = (row, v) => {
    const { path, off } = row.dataset, fx = row.dataset.fx === '' ? null : row.dataset.fx, [mn, mx] = range(path, +off, fx);
    setVal(path, +off, Math.max(mn, Math.min(mx, v)), fx);
    const f = (val(path, +off, fx) - mn) / ((mx - mn) || 1), bi = row.querySelector('.bar i'); if (bi) bi.style.width = Math.max(2, f * 100) + '%';
    row.querySelector('output').textContent = display(path, +off, fx);
  };
  let settle = null;
  const later = () => { clearTimeout(settle); settle = setTimeout(() => { state.dragging = false; renderMain(true); renderInspector(); }, 450); };
  stage.onpointerdown = (e) => {
    const row = rowOf(e); if (!row || e.button !== 0) return;
    const { path, off } = row.dataset, fx = row.dataset.fx === '' ? null : row.dataset.fx, [mn, mx] = range(path, +off, fx);
    e.preventDefault(); row.setPointerCapture(e.pointerId); state.dragging = true; row.classList.add('active');
    const start = { x: e.clientX, y: e.clientY, v: val(path, +off, fx) }, steps = mx - mn, opt = row.classList.contains('opt');
    let moved = false;
    row.onpointermove = (ev) => {
      const d = (ev.clientX - start.x) - (ev.clientY - start.y);
      if (!moved && Math.abs(d) < 3) return; moved = true;
      const per = opt ? 18 : Math.max(0.4, 160 / steps) * (ev.shiftKey ? 4 : 1);   // pixels per step
      nudge(row, Math.round(start.v + d / per));
    };
    row.onpointerup = row.onpointercancel = () => {
      row.onpointermove = null; row.classList.remove('active'); state.dragging = false;
      if (!moved) return;
      state.justDragged = true; setTimeout(() => { state.justDragged = false; }, 0); renderMain(true); renderInspector();
    };
  };
  stage.addEventListener('wheel', (e) => {
    const row = rowOf(e); if (!row) return;
    e.preventDefault(); e.stopPropagation();
    const { path, off } = row.dataset, fx = row.dataset.fx === '' ? null : row.dataset.fx, [mn, mx] = range(path, +off, fx);
    const step = row.classList.contains('opt') ? 1 : Math.max(1, Math.round((mx - mn) / 100)) * (e.shiftKey ? 1 : 1);
    state.dragging = true; nudge(row, val(path, +off, fx) + (e.deltaY < 0 ? step : -step)); later();
  }, { passive: false });
}

// ---- scene graph ----
function assignSummary(blk, slots) {
  const out = [];
  for (let i = 0; i < slots; i++) {
    const f = raw(blk, i * 16); if (!f) continue;
    out.push(funcName(f).replace(/ \(CC\d+\)$/, ''));
  }
  return out;
}
// the AE-20's 12 breath/controller curves
const CURVE_K = [1.7, 2.6, 4, 8];
function curveFn(c, x) {
  if (c >= 1 && c <= 4) return Math.pow(x, CURVE_K[c - 1]);
  if (c >= 5 && c <= 8) return 1 - Math.pow(1 - x, CURVE_K[c - 5]);
  if (c === 9) return x < 0.5 ? 0.5 * Math.pow(2 * x, 3) : 1 - 0.5 * Math.pow(2 - 2 * x, 3);
  if (c === 10) return x < 0.5 ? 0.5 * (1 - Math.pow(1 - 2 * x, 3)) : 0.5 + 0.5 * Math.pow(2 * x - 1, 3);
  if (c === 11) return x < 0.5 ? 0 : 1;
  return x;
}
function curveD(c, w, h, pad = 2, lo = 0, hi = 1) {
  let d = ''; for (let i = 0; i <= 40; i++) { const x = i / 40, y = lo + (hi - lo) * curveFn(c, x); d += `${i ? 'L' : 'M'}${(pad + x * (w - 2 * pad)).toFixed(1)} ${(h - pad - y * (h - 2 * pad)).toFixed(1)} `; }
  return d;
}
function curvePath(blk) {
  const c = raw(blk, 7) || 0, omin = (raw(blk, 4) || 0) / 127, omax = (raw(blk, 5) ?? 127) / 127;
  return curveD(c, 176, 48, 0, omin, omax).replace(/([ML])([\d.]+) ([\d.]+)/g, (m, L, x, y) => `${L}${(+x + 16).toFixed(1)} ${(+y + 12).toFixed(1)}`);
}
const FUNC_NAMES = ['BEND DOWN', 'BEND UP', 'AFTER TOUCH', 'SCENE DOWN', 'SCENE UP', 'FAVORITE DOWN', 'FAVORITE UP', 'CHORUS SW', 'REVERB SW', 'DELAY SW', 'IFX SW', 'UNISON SW', 'OCT DOWN', 'OCT UP', 'TRANSPOSE DOWN', 'TRANSPOSE UP', 'DRONE SW', 'HARMONY SW', 'START/STOP', 'X-FADE', 'INT. HRMNY SCALE', 'KEY SET', 'SCALE TUNE SW'];
const titleCase = (t) => t.toLowerCase().replace(/(^|[ \-/(])\w/g, (x) => x.toUpperCase()).replace(/\bSw\b/, 'switch').replace(/\bIfx\b/, 'insert effect').replace(/\bOct\b/, 'Octave');
function funcName(f) {
  if (!f) return 'Nothing';
  if (f <= 95) { const nm = D.ccNames[f - 1] || `CC${f}`; const m = nm.match(/^CC(\d+):(.+)$/); return m ? `${titleCase(m[2].trim())} (CC${+m[1]})` : nm; }
  return titleCase(FUNC_NAMES[f - 96] || `Function ${f}`);
}
function renderScene(soft) {
  const defs = {}; let html = '';
  const X = { ctl: 24, part: 264, mfx: 514, ifx: 764, send: 1014, out: 1254 }, Y0 = 170;
  html += `<div class="col" style="left:${X.ctl}px;top:${Y0 - 34}px">Performance</div><div class="col" style="left:${X.part}px;top:${Y0 - 34}px">Parts</div>
    <div class="col" style="left:${X.mfx}px;top:${Y0 - 34}px">Part effects</div><div class="col" style="left:${X.ifx}px;top:${Y0 - 34}px">Insert effect</div>
    <div class="col" style="left:${X.send}px;top:${Y0 - 34}px">Sends</div><div class="col" style="left:${X.out}px;top:${Y0 - 34}px">Output</div>`;
  const links = [];
  // controllers
  const br = SP('as_breath_1'), breath = assignSummary(br, 4);
  defs.breath = { id: 'breath', type: 'assign', blk: br, title: 'Breath', slots: 4 };
  html += nodeHTML('breath', X.ctl, Y0, '', 'Breath <span class="bmini"><i></i></span>', esc(breath.join(', ') || 'Not assigned'), '',
    `<svg class="curve cstep" data-curve="${br}" width="210" height="70" viewBox="0 0 210 70"><path class="f" d="${curvePath(br)} L192 60 L16 60Z"/><path class="l" d="${curvePath(br)}"/><line class="bpk" x1="-9" x2="-9" y1="10" y2="62"/><g class="btrail"></g><circle class="bdot" cx="-20" cy="-20" r="5"/><text class="bnote" x="16" y="22"></text><text x="196" y="66">${(raw(br, 7) || 0) + 1}/12</text></svg><div class="port out air"></div>`);
  const bdn = val(SP('common'), 0x20), bup = val(SP('common'), 0x21);
  defs.bite = { id: 'bite', type: 'assign', blk: SP('as_bite_1'), title: 'Bite', slots: 4, extra: [[SP('common'), 0x20], [SP('common'), 0x21]] };
  const biteA = assignSummary(SP('as_bite_1'), 4);
  html += nodeHTML('bite', X.ctl, Y0 + 170, '', 'Bite', esc(`Bends pitch down ${bdn}, up ${bup}`) + (biteA.length ? `<br>${esc(biteA.join(', '))}` : ''), '', '<div class="port out air"></div>');
  const motion = assignSummary(SP('as_motion_1'), 2);
  defs.motion = { id: 'motion', type: 'assign', blk: SP('as_motion_1'), title: 'Motion', slots: 2 };
  html += nodeHTML('motion', X.ctl, Y0 + 290, motion.length ? '' : 'ghost', 'Motion', esc(motion.join(', ') || 'Not used in this scene'), '', motion.length ? '<div class="port out air"></div>' : '');

  // parts
  let y = Y0; const partYs = []; const ifxParts = []; let any = false;
  for (let n = 1; n <= 4; n++) {
    const p = SP('part_' + n); if (!mem[p]) continue;
    const on = raw(p, 1);
    if (!on) { html += `<div class="node ghost" data-node="part${n}" style="left:${X.part}px;top:${y}px"><h3>+ Part ${n}</h3><div class="sub">Click to turn on</div></div>`;
      defs['part' + n] = { id: 'part' + n, type: 'part', n, title: 'Part ' + n }; y += 92; continue; }
    any = true;
    const msb = raw(p, 2), lsb = raw(p, 3), pc = raw(p, 4);
    defs['part' + n] = { id: 'part' + n, type: 'part', n, title: toneName(msb, lsb, pc) };
    const mp = val(p, 36), tg = (o, txt, on) => `<button class="tag ${on === 1 ? 'on' : on === 2 ? 'tone' : ''}" data-tag data-path="${p}" data-off="${o}">${txt}</button>`;
    const tags = [tg(36, mp === 0 ? 'Mono' : mp === 1 ? 'Poly' : 'Mono/poly: tone', mp === 2 ? 2 : 1), tg(37, 'Legato', val(p, 37)), tg(38, 'Portamento', val(p, 38))];
    html += nodeHTML('part' + n, X.part, y, '', esc(toneName(msb, lsb, pc)), esc(`Part ${n}, ${toneCode(msb, lsb, pc)}`),
      miniRows(pinsFor('part'), { n }) + `<div class="tags">${tags.join('')}</div>`,
      '<div class="port in air"></div><div class="port out"></div>');
    links.push(['breath', 'part' + n, 'air', 2]);
    if (biteA.length || bdn || bup) links.push(['bite', 'part' + n, 'air', 1.5]);
    // part effect
    const follow = raw(p, 10);
    if (follow) {
      const tm = TP(n, 'mfx'); const tt = mem[tm] ? raw(tm, 0) : null;
      defs['mfx' + n] = { id: 'mfx' + n, type: 'fx', path: tm, list: 'MFX', title: tt != null ? fxName('MFX', tt) : 'Tone’s own effect', tone: true, n };
      html += nodeHTML('mfx' + n, X.mfx, y + 8, tt ? '' : 'ghost', esc(tt ? fxName('MFX', tt) : tt === 0 ? 'No effect' : 'Tone’s own effect'), tt === 0 ? 'The tone has no effect' : 'The tone’s own effect', tt ? fxMini(tm, 'MFX') : '', '<div class="port in"></div><div class="port out"></div>');
    } else {
      const pm = SP('mfx_' + n), t = raw(pm, 0);
      defs['mfx' + n] = { id: 'mfx' + n, type: 'fx', path: pm, list: 'MFX', title: fxName('MFX', t), n };
      html += nodeHTML('mfx' + n, X.mfx, y + 8, t ? '' : 'ghost', esc(t ? fxName('MFX', t) : 'No effect'), t ? 'In place of the tone’s effect' : 'Tone’s effect is off', t ? fxMini(pm, 'MFX') : '', '<div class="port in"></div><div class="port out"></div>');
    }
    links.push(['part' + n, 'mfx' + n, 'audio']);
    partYs.push(y);
    if (raw(p, 11) === 1) ifxParts.push(n);
    y += 222;
  }
  // insert effect
  const ifx = SP('ifx'), it = raw(ifx, 0), ion = raw(ifx, 1);
  const ifxUsed = ifxParts.length && it && ion;
  const iy = ifxParts.length ? Math.round(ifxParts.map((n) => partYs[n - 1] ?? Y0).reduce((a, b) => a + b, 0) / ifxParts.length) : Y0 + 80;
  defs.ifx = { id: 'ifx', type: 'fx', path: ifx, list: 'MFX', title: fxName('MFX', it) };
  html += nodeHTML('ifx', X.ifx, ifxUsed ? iy : Math.max(y, iy + 330), it && ion ? '' : 'ghost', esc(it ? fxName('MFX', it) : 'No insert effect'), ifxParts.length ? `Parts ${ifxParts.join(', ')} run through it` : 'No part runs through it',
    it && ion ? fxMini(ifx, 'MFX') : '', '<div class="port in"></div><div class="port out"></div>');
  // sends
  const sends = [['dly', 'DLY', 'Delay'], ['rev', 'REV', 'Reverb'], ['cho', 'CHO', 'Chorus']];
  const shift = Math.max(0, (Y0 - 10) - (iy - 175));
  const sendY = { dly: iy - 175 + shift, rev: iy + 75 + shift, cho: iy + 245 + shift };
  for (const [k, list, nm] of sends) {
    const pth = SP(k), on = raw(pth, 0), t = raw(pth, 1);
    const lvlOff = 2;
    defs[k] = { id: k, type: 'send', path: pth, list, title: nm };
    const active = on && t;
    html += nodeHTML(k, X.send, sendY[k], active ? '' : 'ghost', nm, esc(active ? fxName(list, t) : 'Off'),
      active ? `<div class="mini"><label>Level</label><div class="bar"><i style="width:${(raw(pth, lvlOff) / 127 * 100).toFixed(0)}%"></i></div><output>${raw(pth, lvlOff)}</output></div>` : '',
      '<div class="port in"></div>' + (active ? '<div class="port out"></div>' : ''));
    if (active) links.push([k, 'out', 'audio']);
  }
  // routing cables
  for (let n = 1; n <= 4; n++) {
    const p = SP('part_' + n); if (!mem[p] || !raw(p, 1)) continue;
    const toIfx = raw(p, 11) === 1 && it && ion;
    if (toIfx) links.push(['mfx' + n, 'ifx', 'audio']); else links.push(['mfx' + n, 'out', 'audio']);
    const src = toIfx ? 'ifx' : 'mfx' + n;
    for (const [k, off] of [['dly', 9], ['rev', 7], ['cho', 8]]) {
      const lvl = toIfx ? (k === 'dly' ? val(SP('common'), 0x19) : k === 'rev' ? raw(ifx, 3) : raw(ifx, 2)) : raw(p, off);
      const on = raw(SP(k), 0) && raw(SP(k), 1);
      if (lvl > 0) links.push([src, k, on ? 'audio' : 'off', on ? 0.8 + (lvl / 127) * 2 : 1.2]);
    }
  }
  if (it && ion) links.push(['ifx', 'out', 'audio']);
  const lvl = raw(SP('common'), 0x18);
  defs.out = { id: 'out', type: 'out', title: 'Output' };
  html += nodeHTML('out', X.out, iy - 4 + shift, '', 'Output', 'Scene level', `<div class="mini"><label>Level</label><div class="bar"><i style="width:${(lvl / 127 * 100).toFixed(0)}%"></i></div><output>${lvl}</output></div>`, '<div class="port in"></div>');
  canvasShell(html, 1480, Math.max(900, y + 120, iy + 400));
  drawCables(links.filter((l, i, a) => a.findIndex((m) => m[0] === l[0] && m[1] === l[1]) === i));
  bindNodes(defs);
  state.defs = defs;
  if (state.sel && !defs[state.sel.id]) state.sel = null;
}
function fxMini(path, list) {
  const t = raw(path, list === 'MFX' ? 0 : 1);
  const num = fxNum(list, t); if (!num) return '';
  const type = 'fx:' + list + num;
  let keys = LS.get('pins:' + type, null);
  if (!keys) keys = fxParams(path, list).filter((k) => CAT[k].kind === 'Slider').slice(0, 3);
  const ctx = { n: (path.match(/_(\d)$/) || [])[1], tonePart: (path.match(/_\((\d)\)/) || [])[1] };
  return miniRows(keys, ctx);
}
function fxParams(path, list) {
  const t = raw(path, list === 'MFX' ? 0 : 1), num = fxNum(list, t);
  const base = catKey(path, 0).replace(/%0$/, '');
  return Object.keys(CAT).filter((k) => k.startsWith(base + '%') && k.endsWith('%fx' + num)).sort((a, b) => +a.split('%')[2] - +b.split('%')[2]);
}

// ---- tones view: oscillator → filter → amp, LFO and envelope as modulators ----
// the part, partial and tone bars sit outside the zoomed canvas so they never slide under the title
function outsideBars(html) { $('#main').insertAdjacentHTML('beforeend', html); }
function renderTones(soft) {
  const n = state.tonePart, p = SP('part_' + n);
  const partsBar = `<div class="parts">${[1, 2, 3, 4].map((i) => {
    const pp = SP('part_' + i), on = mem[pp] && raw(pp, 1);
    const nm = on ? toneName(raw(pp, 2), raw(pp, 3), raw(pp, 4)) : `Part ${i}`;
    return `<button data-tp="${i}" class="${i === n ? 'on' : ''}" ${on ? '' : 'disabled'}>${esc(nm)}</button>`; }).join('')}</div>`;
  if (!mem[p] || !raw(p, 1) || !isZC(n)) {
    canvasShell('', 1400, 700); outsideBars(partsBar + `<div class="note" style="position:absolute;left:32px;top:146px;max-width:520px;z-index:3">${mem[p] && raw(p, 1) ? 'SuperNATURAL and drum tones are finished instruments with no partials to edit.' : 'Choose a part above.'}</div>`);
    bindParts(); return;
  }
  if (!mem[TP(n, 'synPtl_1')]) { canvasShell('', 1400, 700); outsideBars(partsBar + '<div class="note" style="position:absolute;left:32px;top:146px;max-width:520px;z-index:3">Reading the tone…</div>'); bindParts(); loadTone(n); return; }
  const P = state.partial, ctx = { n: P, tonePart: n };
  const syn = TP(n, 'synPtl_' + P), ptl = TP(n, 'ptl_' + P), lfo = TP(n, 'ptlLfo_' + P), aenv = TP(n, 'ptlAenv_' + P), fenv = TP(n, 'ptlFenv_' + P), sc = TP(n, 'synCom');
  const penv = TP(n, 'ptlPenv_' + P), peq = TP(n, 'ptlEq_' + P);
  const pmt = TP(n, 'pmt');
  const partialOn = (i) => partialIsOn(n, i), solo = state.solo && state.solo.part === n ? state.solo.p : 0;
  const onCount = [1, 2, 3, 4].filter(partialOn).length;
  const toneBar = toneBarHTML(n);
  const plName = (i) => { const sy = TP(n, 'synPtl_' + i), t = raw(sy, 0); return t === 0 ? waveLabel(waveOf(n, i), true) : t === 1 ? `${D.vaWaves[raw(sy, 1)] || 'VA'} wave` : D.oscTypes[t] || ''; };
  const partials = `<div class="parts plist" style="top:138px">${[1, 2, 3, 4].map((i) => partialOn(i)
    ? `<button data-pl="${i}" class="${i === P ? 'on' : ''} ${solo && solo !== i ? 'muted' : ''}" title="${esc(plName(i))}"><b>${i}</b><span class="pnm">${esc(plName(i))}</span><span class="pso ${solo === i ? 'lit' : ''}" data-solo="1" role="button" aria-pressed="${solo === i}" title="${solo === i ? 'Stop solo' : 'Solo: hear only this partial'}">S</span>${onCount > 1 ? `<span class="prm-x" data-rm="1" role="button" title="Remove partial ${i}">×</span>` : ''}</button>`
    : `<button data-pl="${i}" class="off" title="Add partial ${i}">+ Partial ${i}</button>`).join('')}</div>`;
  const defs = {}; let html = '';
  if (!partialOn(P)) {
    defs.partial = { id: 'partial', type: 'partial', title: 'Partial ' + P };
    canvasShell(`<div class="node ghost" data-node="partial" style="left:300px;top:290px"><h3>+ Partial ${P}</h3><div class="sub">Off. Click to turn it on and layer it with the others</div></div>`, 1440, 900); outsideBars(partsBar + partials + toneBar);
    bindNodes(defs); bindParts(); bindToneBar(n); state.defs = defs; return;
  }
  const oscType = raw(syn, 0), wave = raw(syn, 1);
  const oscName = oscType === 1 ? `${D.vaWaves[wave] || 'VA'} wave` : oscType === 0 ? waveLabel(waveOf(n, P)) : D.oscTypes[oscType] || 'Oscillator';
  const uni = raw(sc, 0);
  const Y = 290;
  defs.osc = { id: 'osc', type: 'osc', title: 'Oscillator', ctx };
  html += nodeHTML('osc', 290, Y, '', 'Oscillator', esc(oscName + (uni ? `, unison ${display(sc, 1)}` : '')), miniRows(pinsFor(oscType === 0 ? 'pcm' : 'osc'), ctx), '<div class="port in air"></div><div class="port out"></div>');
  defs.filter = { id: 'filter', type: 'filter', title: 'Filter', ctx };
  html += nodeHTML('filter', 550, Y, '', 'Filter', esc(display(ptl, 49)), miniRows(pinsFor('filter'), ctx), '<div class="port in"></div><div class="port out"></div>');
  defs.amp = { id: 'amp', type: 'amp', title: 'Amp', ctx };
  html += nodeHTML('amp', 810, Y, '', 'Amp', 'Envelope and level', miniRows(pinsFor('amp'), ctx), '<div class="port in"></div><div class="port out"></div>');
  defs.eq = { id: 'eq', type: 'eq', title: 'EQ', ctx };
  const eqOn = mem[peq] && raw(peq, 26);
  html += nodeHTML('eq', 1070, Y, eqOn ? '' : 'off', 'EQ', eqOn ? 'Low, mid and high' : 'Off', miniRows(pinsFor('eq'), ctx), '<div class="port in"></div><div class="port out"></div>');
  defs.toneout = { id: 'toneout', type: 'toneout', title: 'Tone output', ctx };
  const tl = raw(TP(n, 'common'), 21);
  html += nodeHTML('toneout', 1330, Y, '', 'Tone output', esc(fxName('MFX', raw(TP(n, 'mfx'), 0)) + ' effect'), `<div class="mini"><label>Level</label><div class="bar"><i style="width:${(tl / 127 * 100).toFixed(0)}%"></i></div><output>${tl}</output></div>`, '<div class="port in"></div>');
  defs.lfo = { id: 'lfo', type: 'lfo', title: 'LFO 1', ctx };
  html += nodeHTML('lfo', 290, Y + 260, '', 'LFO 1', esc(display(lfo, 0) + (raw(lfo, 1) ? `, ${display(lfo, 2)}` : '')), miniRows(pinsFor('lfo'), ctx), '');
  defs.fenv = { id: 'fenv', type: 'fenv', title: 'Filter envelope', ctx };
  html += nodeHTML('fenv', 550, Y + 300, '', 'Filter envelope', esc(`Depth ${display(fenv, 0)}`), '', '');
  defs.penv = { id: 'penv', type: 'penv', title: 'Pitch envelope', ctx };
  html += nodeHTML('penv', 32, Y + 300, '', 'Pitch envelope', mem[penv] ? esc(`Depth ${display(penv, 0)}`) : '', '', '');
  defs.breath = { id: 'breath', type: 'assign', blk: SP('as_breath_1'), title: 'Breath', slots: 4 };
  html += nodeHTML('breath', 32, Y, '', 'Breath <span class="bmini"><i></i></span>', 'Shapes volume and tone', '', '<div class="port out air"></div>');
  const links = [['breath', 'osc', 'air'], ['osc', 'filter', 'audio'], ['filter', 'amp', 'audio'], ['amp', 'eq', eqOn ? 'audio' : 'off'], ['eq', 'toneout', 'audio']];
  if (val(lfo, 23) || val(syn, 7)) links.push(['lfo', 'osc', 'mod']);
  if (val(lfo, 25)) links.push(['lfo', 'filter', 'mod']);
  if (val(lfo, 27)) links.push(['lfo', 'amp', 'mod']);
  if (val(fenv, 0)) links.push(['fenv', 'filter', 'mod']);
  if (mem[penv] && val(penv, 0)) links.push(['penv', 'osc', 'mod']);
  canvasShell(html, 1580, 900); outsideBars(partsBar + partials + toneBar);
  drawCables(links);
  bindNodes(defs); bindParts(); bindToneBar(n);
  state.defs = defs;
  if (state.sel && !defs[state.sel.id]) state.sel = null;
}
function bindParts() {
  document.querySelectorAll('[data-tp]').forEach((b) => { b.onclick = () => { unsolo(); state.tonePart = +b.dataset.tp; state.sel = null; renderMain(); renderInspector(); }; });
  document.querySelectorAll('[data-pl]').forEach((b) => { b.onclick = (e) => {
    const n = state.tonePart, i = +b.dataset.pl;
    if (e.target.closest('[data-solo]')) { e.stopPropagation(); return toggleSolo(n, i); }
    if (e.target.closest('[data-rm]')) { e.stopPropagation(); return removePartial(n, i); }
    if (!partialIsOn(n, i)) return addPartial(n, i);
    state.partial = i; renderMain(); renderInspector();
  }; });
}

// ---- breath and bite: what goes in, what comes out ----
const MAP = { x0: 40, x1: 290, y0: 14, y1: 160 };
const mX = (v) => MAP.x0 + (v / 127) * (MAP.x1 - MAP.x0), mY = (v) => MAP.y1 - (v / 127) * (MAP.y1 - MAP.y0);
function mapOut(blk, b, x) {
  const lo = raw(blk, b + 2) || 0, hi = raw(blk, b + 3) ?? 127, o0 = raw(blk, b + 4) || 0, o1 = raw(blk, b + 5) ?? 127, c = raw(blk, b + 7) || 0;
  const t = Math.max(0, Math.min(1, (x - lo) / ((hi - lo) || 1)));
  return o0 + (o1 - o0) * curveFn(c, t);
}
function mapInner(blk, b, who) {
  const lo = raw(blk, b + 2) || 0, hi = raw(blk, b + 3) ?? 127, o0 = raw(blk, b + 4) || 0, o1 = raw(blk, b + 5) ?? 127;
  let d = ''; for (let i = 0; i <= 64; i++) { const x = i / 64 * 127; d += `${i ? 'L' : 'M'}${mX(x).toFixed(1)} ${mY(mapOut(blk, b, x)).toFixed(1)} `; }
  const grid = [0.25, 0.5, 0.75].map((f) => `<line class="mg" x1="${MAP.x0}" x2="${MAP.x1}" y1="${MAP.y1 - f * (MAP.y1 - MAP.y0)}" y2="${MAP.y1 - f * (MAP.y1 - MAP.y0)}"/>`).join('');
  return `<rect class="mbg" x="${MAP.x0}" y="${MAP.y0}" width="${MAP.x1 - MAP.x0}" height="${MAP.y1 - MAP.y0}" rx="6"/>${grid}
    <rect class="mdead" x="${MAP.x0}" y="${MAP.y0}" width="${mX(lo) - MAP.x0}" height="${MAP.y1 - MAP.y0}"/><rect class="mdead" x="${mX(hi)}" y="${MAP.y0}" width="${MAP.x1 - mX(hi)}" height="${MAP.y1 - MAP.y0}"/>
    <path class="mf" d="${d} L${MAP.x1} ${MAP.y1} L${MAP.x0} ${MAP.y1}Z"/><path class="ml" d="${d}"/>
    <line class="mguide" x1="${mX(lo)}" x2="${mX(lo)}" y1="${MAP.y1}" y2="${mY(o0)}"/><line class="mguide" x1="${mX(hi)}" x2="${mX(hi)}" y1="${MAP.y1}" y2="${mY(o1)}"/>
    <circle class="mh" data-h="0" cx="${mX(lo)}" cy="${mY(o0)}" r="7"/><circle class="mh" data-h="1" cx="${mX(hi)}" cy="${mY(o1)}" r="7"/>
    <circle class="mdot" cx="-20" cy="-20" r="6"/>
    <text class="mx" x="${MAP.x1}" y="${MAP.y1 + 22}">${who === 'bite' ? 'Bite harder' : who === 'breath' ? 'Blow harder' : 'Push further'} →</text>
    <text class="mx" x="${MAP.x0}" y="${MAP.y1 + 22}" style="text-anchor:start">Soft</text>
    <text class="my" transform="translate(16 ${(MAP.y0 + MAP.y1) / 2}) rotate(-90)">Sends more →</text>
    <text class="mv" x="${mX(lo)}" y="${MAP.y1 + 36}">${lo}</text><text class="mv" x="${mX(hi)}" y="${MAP.y1 + 36}">${hi}</text>`;
}
function bindMaps(el) {
  for (const svg of el.querySelectorAll('svg.map')) {
    const blk = svg.dataset.blk, b = +svg.dataset.base, who = svg.dataset.who;
    let h = null;
    const at = (e) => { const r = svg.getBoundingClientRect(), k = 300 / r.width; return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; };
    svg.onpointerdown = (e) => {
      const [x, y] = at(e), d0 = Math.hypot(x - mX(raw(blk, b + 2) || 0), y - mY(raw(blk, b + 4) || 0)), d1 = Math.hypot(x - mX(raw(blk, b + 3) ?? 127), y - mY(raw(blk, b + 5) ?? 127));
      if (Math.min(d0, d1) > 30) return;
      h = d0 <= d1 ? 0 : 1; svg.setPointerCapture(e.pointerId); svg.classList.add('dragging'); e.preventDefault();
    };
    svg.onpointermove = (e) => {
      if (h == null) return;
      const [x, y] = at(e), vx = Math.round(Math.max(0, Math.min(127, (x - MAP.x0) / (MAP.x1 - MAP.x0) * 127))), vy = Math.round(Math.max(0, Math.min(127, (MAP.y1 - y) / (MAP.y1 - MAP.y0) * 127)));
      const lo = raw(blk, b + 2) || 0, hi = raw(blk, b + 3) ?? 127;
      if (h === 0) { setVal(blk, b + 2, Math.min(vx, hi - 1)); setVal(blk, b + 4, vy); } else { setVal(blk, b + 3, Math.max(vx, lo + 1)); setVal(blk, b + 5, vy); }
      svg.innerHTML = mapInner(blk, b, who);
    };
    svg.onpointerup = svg.onpointercancel = () => { if (h == null) return; h = null; svg.classList.remove('dragging'); renderMain(true); renderInspector(); };
  }
}

// ---- envelopes: a small drawing; the stage you point at or change lights up ----
const ENV = { amp: { t: [4, 8, 12, 16], l: [null, 20, 24, 28, null] }, fenv: { t: [8, 12, 16, 20], l: [24, 28, 32, 36, 40] }, penv: { t: [8, 12, 16, 20], l: [24, 28, 32, 36, 40] } };
function envPoints(path, kind) {
  const E = ENV[kind], H = 96, pad = 8, seg = (300 - 2 * pad - 40) / 4;
  const nv = (o) => { const [mn, mx] = range(path, o); return (val(path, o) - mn) / ((mx - mn) || 1); };
  const lv = (o) => (o == null ? 0 : nv(o)), w = (o) => 4 + Math.sqrt(nv(o)) * (seg - 4);
  const xs = [pad]; xs.push(xs[0] + w(E.t[0]), 0, 0); xs[2] = xs[1] + w(E.t[1]); xs[3] = xs[2] + w(E.t[2]); xs.push(xs[3] + 40); xs.push(xs[4] + w(E.t[3]));
  const ls = [lv(E.l[0]), lv(E.l[1]), lv(E.l[2]), lv(E.l[3]), lv(E.l[3]), lv(E.l[4])];
  return xs.map((x, i) => [+x.toFixed(1), +(H - pad - ls[i] * (H - 2 * pad)).toFixed(1)]);
}
function envSVG(path, kind) {
  if (!mem[path]) return '';
  const p = envPoints(path, kind), segs = ['t1', 't2', 't3', 'sus', 't4'], y0 = kind === 'penv' ? 48 : 88;   // pitch moves either side of the note played
  return `<svg class="env" data-env-of="${esc(path)}" data-kind="${kind}" viewBox="0 0 300 96">${kind === 'penv' ? '<line class="emid" x1="8" x2="292" y1="48" y2="48"/>' : ''}<path class="ef" d="M${p[0][0]} ${y0} ${p.map((q) => 'L' + q.join(' ')).join(' ')} L${p[5][0]} ${y0}Z"/>
    ${p.slice(0, 5).map((q, i) => `<path class="es ${segs[i]}" d="M${q.join(' ')} L${p[i + 1].join(' ')}"/>`).join('')}
    ${p.map((q, i) => i === 4 ? '' : `<circle class="ep l${i > 4 ? i - 1 : i}" cx="${q[0]}" cy="${q[1]}" r="3.5"/>`).join('')}</svg>`;
}
function envControls(path, kind, pinType) {
  const E = ENV[kind], rows = [];
  E.t.forEach((o, i) => { rows.push(control(path, o, null, pinType, null, `data-env="t${i + 1}"`)); });
  E.l.forEach((o, i) => { if (o != null) rows.push(control(path, o, null, pinType, null, `data-env="l${i}"`)); });
  return rows.join('');
}

// ---- inspector ----
function control(path, off, fx, pinType, name, attrs = '') {
  const c0 = cat(path, off, fx), c = { ...(c0 || {}), label: nameFor(path, off, fx, name) }; const p = pdef(path, off);
  if (!p || !mem[path]) return '';
  const key = catKey(path, off) + (fx != null && CAT[catKey(path, off) + '%fx' + fx] ? '%fx' + fx : '');
  const pinned = pinType && (pinsFor(pinType) || []).includes(key);
  const pinBtn = pinType ? `<button class="pin ${pinned ? 'on' : ''}" data-pin="${esc(key)}" title="Show on node">${PIN}</button>` : '<span class="pin none"></span>';
  const v = val(path, off, fx), [mn, mx] = range(path, off, fx);
  const nm = esc(c.label);
  const data = `data-path="${esc(path)}" data-off="${off}" data-fx="${fx ?? ''}"`;
  if (c && c.options) {
    if (c.options.length <= 3) return `<div class="prm" ${attrs}>${pinBtn}<span class="pn">${nm}</span><span></span><div class="ctl seg" ${data}>${c.options.map((o, i) => `<button data-v="${i}" class="${i === v ? 'on' : ''}">${esc(o)}</button>`).join('')}</div></div>`;
    return `<div class="prm" ${attrs}>${pinBtn}<span class="pn">${nm}</span><span></span><select class="sel ctl" ${data}>${c.options.map((o, i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
  }
  if (mx - mn === 1 && (!c0 || c.kind === 'Switch' || c.kind === 'Other')) return `<div class="prm" ${attrs}>${pinBtn}<span class="pn">${nm}</span><button class="tog ${v ? 'on' : ''}" ${data} data-toggle="1"></button></div>`;
  if (c.format && c.format.includes(' Hz') && mn > 0 && mx / mn >= 100) {           // frequencies: even steps per octave
    const lv = Math.round(1000 * Math.log(v / mn) / Math.log(mx / mn));
    return `<div class="prm" ${attrs}>${pinBtn}<span class="pn">${nm}</span><span class="pv">${esc(display(path, off, fx))}</span><input type="range" class="ctl" min="0" max="1000" value="${lv}" style="--p:${lv / 10}%" data-log="${mn},${mx}" ${data}></div>`;
  }
  const pct = mx > mn ? ((v - mn) / (mx - mn)) * 100 : 0;
  return `<div class="prm" ${attrs}>${pinBtn}<span class="pn">${nm}</span><span class="pv">${esc(display(path, off, fx))}</span><input type="range" class="ctl" min="${mn}" max="${mx}" value="${v}" style="--p:${pct}%" ${data}></div>`;
}
function section(title, items) { const h = items.filter(Boolean).join(''); return h ? `<section>${title ? `<h4>${esc(title)}</h4>` : ''}${h}</section>` : ''; }
function allOf(path, skip = [], pinType) {
  const base = catKey(path, 0).replace(/%0$/, '');
  return Object.keys(CAT).filter((k) => k.startsWith(base + '%') && !k.includes('%fx') && !skip.includes(+k.split('%')[2]))
    .map((k) => +k.split('%')[2]).sort((a, b) => a - b).map((o) => control(path, o, null, pinType)).join('');
}
function renderInspector() {
  const el = $('#inspector'); if (!state.connected || state.view === 'favorites' || state.view === 'library') return;
  const s = state.sel;
  if (!s) {
    el.innerHTML = `<h2>${esc(sceneName())}</h2><p class="lead">${state.view === 'tones' ? 'Select a node to shape the tone. Changes are heard as you play.' : 'Select a node to see its settings. Changes are heard as you play.'}</p>`;
    return;
  }
  let h = '';
  if (s.type === 'part') {
    const p = SP('part_' + s.n), on = raw(p, 1);
    h += `<h2>${esc(s.title)}</h2><p class="lead">Part ${s.n}: one layer of the scene, playing one tone.${on ? '' : ' Off.'}</p>`;
    h += section('', [control(p, 1, null)]);
    if (on) {
      const msb = raw(p, 2), lsb = raw(p, 3), pc = raw(p, 4);
      const bank = msb === 89 ? 'SN' : msb === 70 ? 'DK' : { 72: 'A', 73: 'B', 74: 'C' }[lsb] || 'U';
      const list = bank === 'U' ? (state.userTones || []).map((t) => (/^INIT TONE$/i.test(t) ? '' : t)) : D.tones[bank] || [];
      if (bank === 'U' && !state.userTones) fetchUserTones();
      h += `<section><h4>Tone</h4><div class="prm"><span class="pin none"></span><select class="sel ctl" id="tbank" style="grid-column:2/4">${[['A', 'Preset A'], ['B', 'Preset B'], ['C', 'Preset C'], ['SN', 'SuperNATURAL'], ['DK', 'Drum kits'], ['U', 'User tones']].map(([k, t]) => `<option value="${k}" ${k === bank ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="prm"><span class="pin none"></span><select class="sel ctl" id="tsel" style="grid-column:2/4">${toneOptions(bank, list, bank === 'U' ? (lsb - 8) * 128 + pc : pc)}</select></div></section>`;
      h += section('Level and position', [5, 6, 24, 22, 23].map((o) => control(p, o, null, 'part')));
      h += section('Playing', [36, 37, 38, 40, 42].map((o) => control(p, o, null, 'part')));
      h += section('Sends and routing', [7, 8, 9, 11, 10].map((o) => control(p, o, null, 'part')));
      h += section('Shaping', [27, 28, 29, 30, 31, 32, 33, 34, 35].map((o) => control(p, o, null, 'part')));
      h += `<details class="more"><summary>All part settings</summary>${allOf(p, [], 'part')}</details>`;
    }
  } else if (s.type === 'fx' || s.type === 'send') {
    const list = s.list, path = s.path, isMfx = list === 'MFX', t = raw(path, isMfx ? 0 : 1);
    const lead = s.id === 'ifx' ? 'Insert effect (IFX): processes only the parts routed into it.' : s.tone ? 'The tone’s own multi-effect (MFX). Switch it off in the part to use a part effect.' : s.type === 'send' ? 'Send effect: shared by all parts; each part sends some of its sound here.' : 'Part multi-effect (MFX): used instead of the tone’s own effect.';
    h += `<h2>${esc(fxName(list, t))}</h2><p class="lead">${lead}</p>`;
    h += `<section><h4>Type</h4><div class="prm"><span class="pin none"></span><select class="sel ctl" id="fxtype" style="grid-column:2/4">${fxOptions(list, t)}</select></div></section>`;
    if (!isMfx) h += section('', [control(path, 0, null, null, 'Effect on'), control(path, 2, null, null, 'Level'), path.endsWith('rev') ? '' : control(path, 3, null, null, 'Reverb send')]);
    else h += section('', [control(path, 1, null, null, 'Effect on'), control(path, 2, null, null, 'Chorus send'), control(path, 3, null, null, 'Reverb send')]);
    const num = fxNum(list, t), pinType = 'fx:' + list + num;
    if (!LS.get('pins:' + pinType, null)) PIN_DEFAULTS[pinType] = fxParams(path, list).filter((k) => CAT[k].kind === 'Slider').slice(0, 3);
    h += section('Settings', fxParams(path, list).map((k) => control(path, +k.split('%')[2], num, pinType)));
  } else if (s.type === 'assign') {
    h += `<h2>${esc(s.title)}</h2><p class="lead">What ${s.title.toLowerCase()} controls: each slot drives one setting, with its own range and curve.</p>`;
    if (s.id === 'breath') {
      const lo = raw(s.blk, 2) || 0, hi = raw(s.blk, 3) ?? 127;
      h += `<section><h4>Your breath</h4><div class="bmeter"><b class="rng" style="left:${lo / 1.27}%;width:${(hi - lo) / 1.27}%"></b><i class="now"></i><i class="pk"></i></div><output class="bmo">${air.seen ? '' : 'Play to see your breath'}</output></section>`;
    }
    const who = s.title === 'Bite' ? 'bite' : s.title.toLowerCase();
    for (let i = 0; i < s.slots; i++) {
      const b = i * 16, f = raw(s.blk, b), cv = raw(s.blk, b + 7) || 0;
      const isSwitch = f >= 96 && /SW|START|KEY SET|DOWN|UP/.test(FUNC_NAMES[f - 96] || '') && !/BEND/.test(FUNC_NAMES[f - 96] || '');
      const mapH = `<svg class="map" data-blk="${esc(s.blk)}" data-base="${b}" data-who="${who}" viewBox="0 0 300 196">${mapInner(s.blk, b, who)}</svg>`;
      const modeH = isSwitch ? `<div class="prm"><span class="pin none"></span><span class="pn">Switch</span><span></span><div class="ctl seg" data-path="${esc(s.blk)}" data-off="${b + 6}" data-fx=""><button data-v="1" class="${raw(s.blk, b + 6) === 1 ? 'on' : ''}">On while held</button><button data-v="0" class="${raw(s.blk, b + 6) === 0 ? 'on' : ''}">Press on, press off</button></div></div>` : '';
      const exact = `<details class="more"><summary>Exact values</summary>${[[2, `${titleCase(who)} from`], [3, `${titleCase(who)} to`], [4, 'Sends from'], [5, 'Sends to']].map(([o, nm]) => control(s.blk, b + o, null, null, nm)).join('')}</details>`;
      const fsel = `<div class="prm"><span class="pin none"></span><span class="pn">Controls</span><span></span><select class="sel ctl" data-path="${esc(s.blk)}" data-off="${b}" data-fx="">${Array.from({ length: 119 }, (_, v) => v).filter((v) => v <= 95 || FUNC_NAMES[v - 96]).map((v) => `<option value="${v}" ${v === f ? 'selected' : ''}>${esc(funcName(v))}</option>`).join('')}</select></div>`;
      const curves = `<div class="prm"><span class="pin none"></span><span class="pn">Curve</span><span class="pv">${cv + 1} of 12</span><div class="ctl curves" data-path="${esc(s.blk)}" data-off="${b + 7}">${Array.from({ length: 12 }, (_, c) => `<button data-v="${c}" class="${c === cv ? 'on' : ''}" aria-label="Curve ${c + 1}"><svg viewBox="0 0 36 36"><path d="${curveD(c, 36, 36, 4)}"/></svg></button>`).join('')}</div></div>`;
      h += section(`Slot ${i + 1}${f ? '' : ' (off)'}`, f ? [fsel, isSwitch ? modeH : mapH + curves, isSwitch ? '' : exact] : [fsel]);
    }
    if (s.extra) h += section('Pitch bend', s.extra.map(([pth, o]) => control(pth, o, null)));
  } else if (s.type === 'out') {
    const c = SP('common');
    h += `<h2>Output</h2><p class="lead">The scene’s master output.</p>`;
    h += section('', [0x18, 0x14, 0x15, 0x10].map((o) => control(c, o, null)));
    h += section('Harmony', [0x41, 0x38, 0x39, 0x29, 0x2a, 0x2b, 0x2c].map((o) => control(c, o, null)));
  } else if (s.type === 'osc') {
    const { n, tonePart } = { n: s.ctx.n, tonePart: s.ctx.tonePart };
    const syn = TP(tonePart, 'synPtl_' + n), ptl = TP(tonePart, 'ptl_' + n), sc = TP(tonePart, 'synCom');
    h += `<h2>Oscillator</h2><p class="lead">Oscillator: the raw sound source. Partial ${n}.</p>`;
    const pt = raw(syn, 0) === 0 ? 'pcm' : 'osc', wv = raw(syn, 0) === 0 ? waveLabel(waveOf(tonePart, n)) : '';
    h += `<section><h4>Wave</h4><button class="wavebtn" id="wavepick" data-n="${tonePart}" data-p="${n}"><span>${raw(syn, 0) === 0 ? esc(wv) : 'Use a PCM wave'}</span><b>Browse waves</b></button>${(pt === 'pcm' ? [0] : [0, 1, 6, 7, 8, 22]).map((o) => control(syn, o, null, pt)).join('')}</section>`;
    h += section('Pitch', [1, 2].map((o) => control(ptl, o, null, pt)));
    h += section('Unison', [0, 1, 2].map((o) => control(sc, o, null, pt)));
    h += `<details class="more"><summary>All oscillator settings</summary>${allOf(syn, [0, 1, 6, 7, 8, 22], pt)}</details>`;
  } else if (s.type === 'filter') {
    const { n, tonePart } = s.ctx; const ptl = TP(tonePart, 'ptl_' + n), syn = TP(tonePart, 'synPtl_' + n), fe = TP(tonePart, 'ptlFenv_' + n);
    h += `<h2>Filter</h2><p class="lead">Filter: cuts frequencies to shape the tone color; a lower cutoff sounds darker. Partial ${n}.</p>`;
    h += section('Filter', [49, 50, 61, 54].map((o) => control(ptl, o, null, 'filter')).concat([14, 15, 18, 10].map((o) => control(syn, o, null, 'filter'))));
    h += `<section><h4>Envelope</h4>${control(fe, 0, null, 'filter')}${envSVG(fe, 'fenv')}${envControls(fe, 'fenv', 'filter')}</section>`;
  } else if (s.type === 'fenv') {
    const { n, tonePart } = s.ctx; const fe = TP(tonePart, 'ptlFenv_' + n);
    h += `<h2>Filter envelope</h2><p class="lead">Envelope: a shape over each note (attack, decay, sustain, release). This one moves the filter cutoff.</p>`;
    h += section('', [0, 1, 2].map((o) => control(fe, o, null)));
    h += `<section><h4>Shape</h4>${envSVG(fe, 'fenv')}${envControls(fe, 'fenv')}</section>`;
  } else if (s.type === 'penv') {
    const { n, tonePart } = s.ctx; const pe = TP(tonePart, 'ptlPenv_' + n);
    h += `<h2>Pitch envelope</h2><p class="lead">Pitch envelope: bends the pitch over each note, for a scoop up, a fall-off or a synth zap. Depth sets how far.</p>`;
    h += section('', [0, 2, 44].map((o) => control(pe, o, null)));
    h += `<section><h4>Shape</h4>${envSVG(pe, 'penv')}${envControls(pe, 'penv')}</section>`;
    h += `<details class="more"><summary>More settings</summary>${[4, 6].map((o) => control(pe, o, null)).join('')}</details>`;
  } else if (s.type === 'eq') {
    const { n, tonePart } = s.ctx; const q = TP(tonePart, 'ptlEq_' + n);
    h += `<h2>EQ</h2><p class="lead">EQ: boosts or cuts the low, mid and high frequencies of partial ${n}.</p>`;
    h += section('', [control(q, 26, null)]);
    h += section('Low', [0, 12].map((o) => control(q, o, null, 'eq')));
    h += section('Mid', [4, 16, 24].map((o) => control(q, o, null, 'eq')));
    h += section('High', [8, 20].map((o) => control(q, o, null, 'eq')));
  } else if (s.type === 'amp') {
    const { n, tonePart } = s.ctx; const ae = TP(tonePart, 'ptlAenv_' + n), ptl = TP(tonePart, 'ptl_' + n);
    h += `<h2>Amp</h2><p class="lead">Amp: the partial’s volume over each note, set by its envelope. Your breath adds to it as you play.</p>`;
    h += `<section><h4>Envelope</h4>${envSVG(ae, 'amp')}${envControls(ae, 'amp', 'amp')}</section>`;
    h += section('Level', [0, 7, 71, 72].map((o) => control(ptl, o, null, 'amp')));
  } else if (s.type === 'lfo') {
    const { n, tonePart } = s.ctx; const lf = TP(tonePart, 'ptlLfo_' + n), syn = TP(tonePart, 'synPtl_' + n);
    h += `<h2>LFO 1</h2><p class="lead">LFO: a slow, repeating wave that moves pitch (vibrato), filter (wah) or volume (tremolo).</p>`;
    h += section('Shape and speed', [0, 1, 2, 4, 11, 22].map((o) => control(lf, o, null, 'lfo')));
    h += section('Targets', [23, 25, 27, 29].map((o) => control(lf, o, null, 'lfo')).concat([control(syn, 7, null, 'lfo')]));
    h += `<details class="more"><summary>LFO 2</summary>${[79, 80, 81, 83, 90, 101, 102, 104, 106, 108].map((o) => control(lf, o, null)).join('')}</details>`;
  } else if (s.type === 'toneout') {
    const { tonePart } = s.ctx; const c = TP(tonePart, 'common');
    h += `<h2>Tone output</h2><p class="lead">The tone’s overall level, mono or poly, and portamento.</p>`;
    h += section('', [21, 22, 26, 29, 30, 32, 36].map((o) => control(c, o, null)));
  }
  el.innerHTML = h;
  bindInspector(); bindMaps(el);
}
function bindInspector() {
  const el = $('#inspector');
  const wp = $('#wavepick'); if (wp) wp.onclick = () => waveBrowser(+wp.dataset.n, +wp.dataset.p);
  const lightEnv = (k) => { el.querySelectorAll('svg.env .on').forEach((x) => x.classList.remove('on')); if (!k) return; el.querySelectorAll(k[0] === 't' ? `svg.env .es.${k}` : `svg.env .ep.${k}`).forEach((x) => x.classList.add('on')); };
  el.onpointerover = (e) => { const r = e.target.closest('[data-env]'); lightEnv(r && r.dataset.env); };
  el.onfocusin = (e) => { const r = e.target.closest('[data-env]'); lightEnv(r && r.dataset.env); };
  el.oninput = (e) => {
    const t = e.target; if (!t.dataset.path) return;
    const er = t.closest('[data-env]');
    if (er) setTimeout(() => { const sv = el.querySelector(`svg.env[data-env-of="${t.dataset.path}"]`); if (sv) { sv.outerHTML = envSVG(t.dataset.path, sv.dataset.kind); lightEnv(er.dataset.env); } });
    const lg = t.dataset.log && t.dataset.log.split(',').map(Number);
    setVal(t.dataset.path, +t.dataset.off, lg ? Math.round(lg[0] * (lg[1] / lg[0]) ** (t.value / 1000)) : +t.value, t.dataset.fx === '' ? null : t.dataset.fx);
    if (t.type === 'range') {
      const [mn, mx] = [+t.min, +t.max]; t.style.setProperty('--p', ((t.value - mn) / (mx - mn) * 100) + '%');
      const out = t.parentElement.querySelector('.pv'); if (out) out.textContent = display(t.dataset.path, +t.dataset.off, t.dataset.fx === '' ? null : t.dataset.fx);
    }
  };
  el.onchange = (e) => {
    const t = e.target;
    if (t.id === 'fxtype') { setFxType(state.sel.path, state.sel.list, +t.value); renderInspector(); return; }
    if (t.id === 'tbank') {
      const b = t.value;
      if (b === 'U') { const i = (state.userTones || []).findIndex((x) => x && !/^INIT TONE$/i.test(x)); setTone(state.sel.n, 71, 8 + (Math.max(0, i) >> 7), Math.max(0, i) & 127); return; }
      const [msb, lsb] = { A: [71, 72], B: [71, 73], C: [71, 74], SN: [89, 66], DK: [70, 66] }[b];
      setTone(state.sel.n, msb, lsb, 0); return;
    }
    if (t.id === 'tsel') {
      const p = SP('part_' + state.sel.n), v = +t.value;
      if (raw(p, 2) === 71 && raw(p, 3) >= 8 && raw(p, 3) <= 11) setTone(state.sel.n, 71, 8 + (v >> 7), v & 127);
      else setTone(state.sel.n, raw(p, 2), raw(p, 3), v);
      return;
    }
    if (t.tagName === 'SELECT' && t.dataset.path) renderInspector();
  };
  el.onclick = (e) => {
    const pin = e.target.closest('[data-pin]');
    if (pin) { const type = state.sel.type === 'fx' || state.sel.type === 'send' ? 'fx:' + state.sel.list + fxNum(state.sel.list, raw(state.sel.path, state.sel.list === 'MFX' ? 0 : 1)) : state.sel.type; return togglePin(type, pin.dataset.pin); }
    const cb = e.target.closest('.curves button');
    if (cb) { const box = cb.parentElement; setVal(box.dataset.path, +box.dataset.off, +cb.dataset.v, null); renderInspector(); renderMain(true); return; }
    const seg = e.target.closest('.seg button');
    if (seg) { const box = seg.parentElement; setVal(box.dataset.path, +box.dataset.off, +seg.dataset.v, box.dataset.fx === '' ? null : box.dataset.fx); renderInspector(); return; }
    const tg = e.target.closest('[data-toggle]');
    if (tg) { const v = val(tg.dataset.path, +tg.dataset.off) ? 0 : 1; setVal(tg.dataset.path, +tg.dataset.off, v, null); renderInspector(); }
  };
}
function setTone(n, msb, lsb, pc) {
  if (state.solo && state.solo.part === n) state.solo = null;   // the instrument reloads the tone
  const p = SP('part_' + n);
  [msb, lsb, pc].forEach((v, i) => { mem[p][2 + i] = v; });
  dev.dt1(block(p).base + 2, [msb, lsb, pc]);
  for (const k of Object.keys(mem)) if (k.startsWith(`Temporary_Tone_PCM_(${n})`)) delete mem[k];
  delete state.toneBase[n]; delete state.toneNameDraft[n];
  setTimeout(async () => { if (msb === 71) { await readBlock(TP(n, 'common')); await readBlock(TP(n, 'mfx')); } if (state.sel) state.sel.title = toneName(msb, lsb, pc); render(); }, 300);
  render();
}

// ======================= edits, drafts and the Library =======================
const hexb = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function snapshot() { const o = {}; for (const p of SCENE_BLOCKS) if (mem[p]) o[p] = mem[p].slice(); return o; }
function isDirty() {
  if (!state.base || state.loading) return false;
  for (const p of SCENE_BLOCKS) { const a = mem[p], b = state.base[p]; if (!a || !b) continue; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true; }
  return false;
}
function toParamSet() { const ps = {}; for (const p of SCENE_BLOCKS) if (mem[p]) ps['User_Scene_%' + p.split('%')[1]] = Array.from(mem[p]).map(hexb); return ps; }
function psBytes(ps, blk) { const a = ps['User_Scene_%' + blk]; return a ? a.map((h) => parseInt(h, 16) & 127) : null; }
function psName(ps) { const c = psBytes(ps, 'Perf_common'); return c ? String.fromCharCode(...c.slice(0, 16)).trim() : 'Scene'; }
function psTones(ps) {
  const out = [];
  for (let n = 1; n <= 4; n++) { const p = psBytes(ps, 'Perf_part_' + n); if (p && p[1]) out.push({ name: toneName(p[2], p[3], p[4]), user: p[2] === 71 && p[3] >= 8 && p[3] <= 11 }); }
  return out;
}
function revert() {
  if (!state.base) return;
  for (const p of SCENE_BLOCKS) {
    const a = mem[p], b = state.base[p]; if (!a || !b) continue;
    let i = 0;
    while (i < a.length) {
      if (a[i] === b[i]) { i++; continue; }
      let j = i; while (j < a.length && a[j] !== b[j]) j++;
      dev.dt1(block(p).base + i, Array.from(b.slice(i, j))); a.set(b.slice(i, j), i); i = j;
    }
  }
  toast('Back to the saved sound'); render();
}
// write a stored scene into the instrument's temporary scene, so it plays without overwriting any slot
async function audition(ps) {
  if (isDirty()) await autoDraft();
  state.unstored = true;            // playing, but not in any slot until uploaded
  const common = SP('common');
  dev.dt1(block(common).base + 0x18, [0]);                 // quiet while the scene loads, as Roland's editor does
  for (const p of SCENE_BLOCKS) {
    const bytes = psBytes(ps, p.split('%')[1]); if (!bytes) continue;
    const b = block(p); mem[p] = new Uint8Array(b.len); mem[p].set(bytes.slice(0, b.len));
    if (p !== common) dev.dt1(b.base, Array.from(mem[p]));
  }
  dev.dt1(block(common).base, Array.from(mem[common]));
  for (const k of Object.keys(mem)) if (k.startsWith('Temporary_Tone_PCM')) delete mem[k];
  await sleep(300);
  for (let n = 1; n <= 4; n++) if (raw(SP('part_' + n), 1) && isZC(n)) { await readBlock(TP(n, 'common')); await readBlock(TP(n, 'mfx')); }
  state.base = snapshot(); state.loaded = snapshot(); state.unstored = true; state.toneBase = {};
}

const LIB = {
  db: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open('aerophone-next', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('libs', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      } catch (e) { res(); }
    });
  },
  tx(mode) { return this.db.transaction('libs', mode).objectStore('libs'); },
  all() { return new Promise((res) => { if (!this.db) return res([]); const q = this.tx('readonly').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); },
  put(lib) { return new Promise((res) => { if (!this.db) return res(); const q = this.tx('readwrite').put(lib); q.onsuccess = q.onerror = () => res(); }); },
  del(id) { return new Promise((res) => { if (!this.db) return res(); const q = this.tx('readwrite').delete(id); q.onsuccess = q.onerror = () => res(); }); },
};
async function loadLibs() { await LIB.open(); state.libs = (await LIB.all()).sort((a, b) => (a.kind === 'drafts' ? -1 : b.kind === 'drafts' ? 1 : a.created - b.created)); }
async function ensureLib(name, kind = 'library') {
  let l = state.libs.find((x) => x.kind === kind && (kind === 'drafts' || x.name === name));
  if (!l) { l = { id: uid(), name, kind, scenes: [], tones: [], created: Date.now() }; state.libs.push(l); await LIB.put(l); }
  return l;
}
async function saveToLibrary() {
  const ps = toParamSet(), name = sceneName();
  let lib = state.entry && state.libs.find((l) => l.id === state.entry.lib);
  let sc = lib && lib.scenes.find((x) => x.id === state.entry.scene);
  if (lib && lib.kind === 'drafts') { lib.scenes = lib.scenes.filter((x) => x !== sc); await LIB.put(lib); sc = null; }
  if (!sc) { lib = await ensureLib('My scenes'); sc = { id: uid() }; lib.scenes.push(sc); }
  Object.assign(sc, { name, ps, savedAt: Date.now(), from: sc.from || sceneNo(state.cur) });
  await LIB.put(lib);
  state.entry = { lib: lib.id, scene: sc.id }; state.base = snapshot();
  toast(`Saved to ${lib.name}`); render();
}
async function autoDraft() {
  const lib = await ensureLib('Drafts', 'drafts');
  const sc = { id: uid(), name: sceneName(), ps: toParamSet(), savedAt: Date.now(), from: sceneNo(state.cur) };
  lib.scenes.unshift(sc); if (lib.scenes.length > 50) lib.scenes.length = 50;
  await LIB.put(lib);
  notice(`Your edits to ${sc.name} were kept as a draft in the Library`, () => { state.view = 'library'; state.libSel = lib.id; render(); });
}
function notice(text, open) { toast(text, open ? { label: 'Open', run: open } : null); }

// ---- leaving a scene with unsaved edits ----
function guard(action) {
  const td = tonesDirty();
  if (td.length) return toneGuard(td[0], () => guard(action));
  if (!isDirty()) return action();
  const v = document.createElement('div'); v.className = 'panelveil';
  const t = uploadTarget();
  v.innerHTML = `<div class="panel" role="dialog" aria-modal="true"><h2>Keep your edits to ${esc(sceneName())}?</h2><p>You changed this scene. Choose what to do before moving on.</p>
    <button class="choice primary" data-c="save">${ICON.library}<div><b>Save to Library</b><span>${state.entry ? 'Updates it in ' + esc((state.libs.find((l) => l.id === state.entry.lib) || {}).name || 'the Library') : 'Adds it to My scenes on this computer'}</span></div></button>
    <button class="choice" data-c="upload"><div class="fill"></div>${ICON.upload}<div><b>Hold to upload to the AE-20</b><span>Overwrites user slot U${pad2(t.lsb + 1)}-${pad2(t.pc + 1)}</span></div></button>
    <button class="choice" data-c="discard">${ICON.discard}<div><b>Discard edits</b><span>Go back to the saved sound</span></div></button>
    <button class="stay">Keep editing</button></div>`;
  document.body.appendChild(v);
  const close = () => v.remove();
  v.querySelector('[data-c=save]').onclick = async () => { close(); await saveToLibrary(); action(); };
  holdable(v.querySelector('[data-c=upload]'), () => { close(); writeScene(t); action(); });
  v.querySelector('[data-c=discard]').onclick = () => { close(); state.skipDraft = true; state.base = snapshot(); action(); };
  v.querySelector('.stay').onclick = close;
  v.onclick = (e) => { if (e.target === v) close(); };
  v.querySelector('[data-c=save]').focus();
}
addEventListener('beforeunload', (e) => { if (isDirty() || tonesDirty().length) { e.preventDefault(); e.returnValue = ''; } });

// ---- Library view: this computer (left) → the AE-20 (right) ----
// Scenes on the left live only in this browser. Nothing reaches the instrument until it is
// lined up on a user slot on the right and uploaded with a hold.
const COMPUTER = '<svg class="g" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="10.5" rx="1.5"/><path d="M2.5 19h19"/></svg>';
const ARROW = '<svg class="g" viewBox="0 0 24 24"><path d="M4 12h15M14 7l5 5-5 5"/></svg>';
state.staged = new Map();      // "lsb-pc" -> {lib, scene}
state.bank = LS.get('bank', 0);
state.picks = [];              // scenes picked on the left, waiting for a first slot
const drained = async () => { while (dev.queue.length || dev.timer) await sleep(30); };
function slotName(lsb, pc) { const n = state.scenes.get(sceneKey(85, lsb, pc)); if (n != null) return n; const u = state.userSlots.find((x) => x.lsb === lsb && x.pc === pc); return u ? u.name : ''; }
function findScene(ref) {
  if (ref.clear) return { id: 'clear', name: 'INIT SCENE', ps: state.initScene, clear: true };
  const l = state.libs.find((x) => x.id === ref.lib); return l && l.scenes.find((x) => x.id === ref.scene);
}
const isEmptyName = (n) => !n || n === 'INIT SCENE';
function stage(lsb, pc, ref) { stageMany([ref], lsb, pc); }
// several scenes go into consecutive slots, starting where you drop them (and on into the next bank)
function stageMany(refs, lsb, pc) {
  let n = 0;
  for (const ref of refs) {
    if (lsb > 11) break;
    state.staged.set(`${lsb}-${pc}`, ref); n++;
    if (++pc > 49) { pc = 0; lsb++; }
  }
  state.picks = [];
  if (refs.length > 1) {
    toast(n < refs.length ? `Lined up ${n} of ${refs.length} scenes: the rest don’t fit after bank 12` : `Lined up ${n} scenes in a row`);
  }
  renderLibrary();
}

function renderLibrary() {
  document.body.classList.toggle('picking', state.picks.length > 0);
  if (!state.libs.find((l) => l.id === state.libSel)) state.libSel = (state.libs.find((l) => l.kind !== 'drafts') || state.libs[0] || {}).id || null;
  const lib = state.libs.find((l) => l.id === state.libSel);
  const fmt = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const shelf = state.libs.map((l) => `<button class="shelf ${l.id === state.libSel ? 'on' : ''} ${l.kind}" data-lib="${l.id}" draggable="${l.scenes.length ? 'true' : 'false'}">${l.kind === 'drafts' ? ICON.draft : ''}${esc(l.name)}<small>${l.scenes.length}</small></button>`).join('');
  const queued = new Set([...state.staged.values()].map((r) => r.scene));
  const picked = new Set(state.picks.map((r) => r.scene));
  const cards = lib ? lib.scenes.map((sc) => {
    const tones = psTones(sc.ps);
    return `<div class="card ${picked.has(sc.id) ? 'picked' : ''} ${queued.has(sc.id) ? 'queued' : ''}" draggable="true" data-sc="${sc.id}" tabindex="0">
      <div class="cn"><b>${esc(sc.name || psName(sc.ps))}</b><span>${esc(tones.map((t) => t.name).join(' + ') || 'No parts on')}</span>
        ${tones.some((t) => t.user) ? '<em class="warn">Uses a user tone, which must already be on the AE-20</em>' : ''}</div>
      <span class="ct">${lib.backup && sc.from ? esc(sc.from) : sc.savedAt ? fmt(sc.savedAt) : ''}</span>
      <button class="ib sm" data-act="play" title="Try it on the AE-20 without saving to a slot">${ICON.play}</button>
      <button class="ib sm hold danger" data-act="del" title="Hold to delete from this computer">${RING}${ICON.trash}</button>
    </div>`; }).join('') : '';

  const banks = Array.from({ length: 12 }, (_, i) => `<button class="${i === state.bank ? 'on' : ''} ${[...state.staged.keys()].some((k) => k.startsWith(i + '-')) ? 'has' : ''}" data-bank="${i}">${pad2(i + 1)}</button>`).join('');
  const slots = Array.from({ length: 50 }, (_, pc) => {
    const lsb = state.bank, key = `${lsb}-${pc}`, ref = state.staged.get(key), inc = ref && findScene(ref);
    const old0 = slotName(lsb, pc), old = isEmptyName(old0) ? '' : old0, cur = state.cur && isUser(state.cur) && state.cur.lsb === lsb && state.cur.pc === pc;
    return `<div class="slotrow ${inc ? 'staged' : ''} ${inc && inc.clear ? 'clearing' : ''} ${cur ? 'cur' : ''} ${old ? '' : 'empty'}" data-slot="${key}" draggable="${old && !inc ? 'true' : 'false'}" tabindex="0">
      <span class="sn">${pad2(pc + 1)}</span>
      ${inc ? `<div class="sx"><b>${inc.clear ? ICON.trash + 'Empty' : ICON.draft + esc(inc.name)}</b><span>${inc.clear ? `Clears ${esc(old)}` : `Replaces ${esc(old || 'an empty slot')}`}</span></div><button class="ib xs" data-unstage title="Take it off this slot">${ICON.discard}</button>`
        : `<div class="sx"><b>${esc(old || 'Empty')}</b></div>${old ? `<button class="ib xs clr" data-clear title="Empty this slot">${ICON.trash}</button>` : ''}`}
    </div>`; }).join('');
  const n = state.staged.size;

  $('#main').innerHTML = `<div class="lib">
    <section class="pane local" id="localpane">
      <header><div class="ph">${COMPUTER}<div><h2>This computer</h2><p>Kept in this browser. Upload a scene to play it from the AE-20.</p></div></div>
        <div class="pa"><button class="ib sm" id="libnew" title="New library">${ICON.plus}</button><button class="ib sm" id="libimport" title="Import .aezl files">${ICON.open}</button></div></header>
      <div class="shelves">${shelf}</div>
      ${lib ? `<div class="libbar"><h3 id="libname" title="Rename">${esc(lib.name)}</h3><span>${lib.kind === 'drafts' ? 'Kept automatically when you leave a scene with unsaved edits' : `${lib.scenes.length} scene${lib.scenes.length === 1 ? '' : 's'}`}</span>
        ${lib.scenes.length > 1 ? `<button class="selall" id="selall">${state.picks.length === lib.scenes.length ? 'Select none' : 'Select all'}</button>` : ''}
        <button class="ib sm" id="libexport" title="Export as .aezl">${ICON.download}</button><button class="ib sm hold danger" id="libdel" title="Hold to delete this library">${RING}${ICON.trash}</button></div>` : ''}
      <div class="cards">${cards || `<p class="empty">${lib ? 'Nothing here yet. Save a scene with the disk icon in Scenes, or drag a slot over from the AE-20.' : 'Import a .aezl file, or save a scene with the disk icon in Scenes.'}</p>`}</div>
    </section>
    <div class="gutter">${ARROW}</div>
    <section class="pane device" id="devpane">
      <header><div class="ph"><i class="led ${state.connected ? 'ok' : ''}"></i><div><h2>AE-20</h2><p>${state.connected ? 'User scenes. Drag a scene onto a slot, then hold to upload.' : 'Connect the AE-20 to upload.'}</p></div></div>
        ${state.connected ? `<button class="btn ghost" id="backup" ${state.backup ? 'disabled' : ''}>${ICON.download}Back up</button>` : ''}</header>
      <div class="banks">${banks}</div>
      <div class="slots">${slots}</div>
      ${state.backup ? `<footer class="bk"><div class="bkbar"><i style="width:${(state.backup.done / Math.max(1, state.backup.total) * 100).toFixed(1)}%"></i></div><span>Backing up ${Math.min(state.backup.total, state.backup.done + 1)} of ${state.backup.total}: ${esc(state.backup.now || '')}</span><button class="clear" id="bkstop">Stop</button></footer>` : n ? `<footer><button class="hold big" id="push" ${state.connected ? '' : 'disabled'}><div class="fill"></div>${ICON.upload}<span>Hold to update ${n} slot${n === 1 ? '' : 's'}</span></button>
        <button class="clear" id="clearq">Clear</button></footer>` : ''}
    </section>
    <input type="file" id="libfile" accept=".aezl,application/json" multiple hidden></div>`;

  // left side
  $('#main .shelves').onclick = (e) => { const b = e.target.closest('[data-lib]'); if (!b) return; state.libSel = b.dataset.lib; LS.set('libSel', state.libSel); renderLibrary(); };
  $('#libnew').onclick = async () => { const l = { id: uid(), name: `Library ${state.libs.filter((x) => x.kind !== 'drafts').length + 1}`, kind: 'library', scenes: [], tones: [], created: Date.now() }; state.libs.push(l); await LIB.put(l); state.libSel = l.id; renderLibrary(); };
  $('#libimport').onclick = () => $('#libfile').click();
  $('#libfile').onchange = async (e) => { for (const f of e.target.files) await importAezl(f); renderLibrary(); };
  if (lib) {
    $('#libexport').onclick = () => exportAezl(lib);
    holdable($('#libdel'), async () => { state.libs = state.libs.filter((x) => x !== lib); await LIB.del(lib.id); for (const [k, r] of state.staged) if (r.lib === lib.id) state.staged.delete(k); toast(`Deleted ${lib.name}`); renderLibrary(); });
    const nameEl = $('#libname');
    nameEl.onclick = () => {
      nameEl.innerHTML = `<input value="${esc(lib.name)}">`; const inp = nameEl.querySelector('input'); inp.focus(); inp.select();
      const done = async () => { const v = inp.value.trim(); if (v) { lib.name = v; await LIB.put(lib); } renderLibrary(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') renderLibrary(); }; inp.onblur = done;
    };
    for (const card of document.querySelectorAll('#main .card')) {
      const sc = lib.scenes.find((x) => x.id === card.dataset.sc), ref = { lib: lib.id, scene: sc.id };
      card.onclick = (e) => {
        if (e.target.closest('button')) return;
        const has = state.picks.some((r) => r.scene === sc.id), order = (list) => lib.scenes.filter((x) => list.some((r) => r.scene === x.id)).map((x) => ({ lib: lib.id, scene: x.id }));
        if (e.shiftKey && state.anchor) {
          const a = lib.scenes.findIndex((x) => x.id === state.anchor), b = lib.scenes.findIndex((x) => x.id === sc.id);
          if (a >= 0) { const [i, j] = a < b ? [a, b] : [b, a]; state.picks = lib.scenes.slice(i, j + 1).map((x) => ({ lib: lib.id, scene: x.id })); return renderLibrary(); }
        }
        if (e.ctrlKey || e.metaKey) state.picks = order(has ? state.picks.filter((r) => r.scene !== sc.id) : [...state.picks, ref]);
        else state.picks = has && state.picks.length === 1 ? [] : [ref];
        state.anchor = sc.id; renderLibrary();
      };
      card.onkeydown = (e) => { if (e.key === 'Enter' && e.target === card) card.onclick(e); };
      card.ondragstart = (e) => {
        const group = state.picks.some((r) => r.scene === sc.id) && state.picks.length > 1 ? state.picks : [ref];
        dragScenes(e, group);
      };
      card.ondragend = () => document.body.classList.remove('dragging-scene', 'dragging-slot');
      card.querySelector('[data-act=play]').onclick = () => guard(async () => { await audition(sc.ps); state.entry = ref; toast(`Playing ${sc.name}. It isn’t in a slot yet`); state.view = 'scenes'; LS.set('view', 'scenes'); render(); });
      holdable(card.querySelector('[data-act=del]'), async () => { lib.scenes = lib.scenes.filter((x) => x !== sc); await LIB.put(lib); for (const [k, r] of state.staged) if (r.scene === sc.id) state.staged.delete(k); toast(`Deleted ${sc.name}`); renderLibrary(); });
    }
  }
  if ($('#selall')) $('#selall').onclick = () => { state.picks = state.picks.length === lib.scenes.length ? [] : lib.scenes.map((x) => ({ lib: lib.id, scene: x.id })); renderLibrary(); };
  for (const pill of document.querySelectorAll('#main .shelf[draggable=true]')) {
    pill.ondragstart = (e) => { const l = state.libs.find((x) => x.id === pill.dataset.lib); dragScenes(e, l.scenes.map((x) => ({ lib: l.id, scene: x.id }))); };
    pill.ondragend = () => document.body.classList.remove('dragging-scene', 'dragging-slot');
  }
  // the left pane accepts slots dragged back from the AE-20 (a copy; the slot is untouched)
  const lp = $('#localpane');
  lp.ondragover = (e) => { if (e.dataTransfer.types.includes('text/x-ae-slot')) { e.preventDefault(); lp.classList.add('over'); } };
  lp.ondragleave = (e) => { if (!lp.contains(e.relatedTarget)) lp.classList.remove('over'); };
  lp.ondrop = (e) => { lp.classList.remove('over'); const k = e.dataTransfer.getData('text/x-ae-slot'); if (k) { e.preventDefault(); copyFromSlot(...k.split('-').map(Number)); } };

  // right side
  $('#main .banks').onclick = (e) => { const b = e.target.closest('[data-bank]'); if (!b) return; state.bank = +b.dataset.bank; LS.set('bank', state.bank); renderLibrary(); };
  for (const b of document.querySelectorAll('#main .banks [data-bank]')) {     // drop on a bank: from its first slot
    b.ondragover = (e) => { if (e.dataTransfer.types.includes('text/x-ae-scene')) { e.preventDefault(); b.classList.add('over'); } };
    b.ondragleave = () => b.classList.remove('over');
    b.ondrop = (e) => { b.classList.remove('over'); const r = e.dataTransfer.getData('text/x-ae-scene'); if (r) { e.preventDefault(); state.bank = +b.dataset.bank; stageMany(JSON.parse(r), +b.dataset.bank, 0); } };
  }
  for (const row of document.querySelectorAll('#main .slotrow')) {
    const [lsb, pc] = row.dataset.slot.split('-').map(Number);
    row.onclick = (e) => {
      if (e.target.closest('[data-unstage]')) { state.staged.delete(row.dataset.slot); return renderLibrary(); }
      if (e.target.closest('[data-clear]')) { state.staged.set(row.dataset.slot, { clear: true }); return renderLibrary(); }
      if (state.picks.length) stageMany(state.picks, lsb, pc);
    };
    row.onkeydown = (e) => { if (e.key === 'Enter') row.onclick(e); };
    row.ondragover = (e) => { if (e.dataTransfer.types.includes('text/x-ae-scene')) { e.preventDefault(); row.classList.add('over'); } };
    row.ondragleave = () => row.classList.remove('over');
    row.ondrop = (e) => { row.classList.remove('over'); const r = e.dataTransfer.getData('text/x-ae-scene'); if (r) { e.preventDefault(); stageMany(JSON.parse(r), lsb, pc); } };
    row.ondragstart = (e) => { e.dataTransfer.setData('text/x-ae-slot', row.dataset.slot); e.dataTransfer.effectAllowed = 'copy'; document.body.classList.add('dragging-slot'); };
    row.ondragend = () => document.body.classList.remove('dragging-scene', 'dragging-slot');
  }
  const push = $('#push');
  if (push && n && state.connected) holdable(push, () => uploadStaged(), 1000);
  if ($('#backup')) $('#backup').onclick = () => backupAE();
  if ($('#bkstop')) $('#bkstop').onclick = () => { state.backup.stop = true; };
  if ($('#clearq')) $('#clearq').onclick = () => { state.staged.clear(); renderLibrary(); };
}
// dragging one or many scenes: the drag picture says how many
function dragScenes(e, refs) {
  e.dataTransfer.setData('text/x-ae-scene', JSON.stringify(refs)); e.dataTransfer.effectAllowed = 'copy';
  if (refs.length > 1) {
    const g = document.createElement('div'); g.className = 'dragcount'; g.textContent = `${refs.length} scenes`;
    document.body.appendChild(g); e.dataTransfer.setDragImage(g, 20, 20); setTimeout(() => g.remove());
  }
  document.body.classList.add('dragging-scene');
}
// The AE-20's own empty scene, read from one of its empty slots (it can differ between firmware versions)
async function readSlot(lsb, pc) {
  dev.dt1(block('stp').base, [85, lsb, pc]);                 // select only; nothing is written
  await drained(); await sleep(150);
  const ps = {};
  for (const p of SCENE_BLOCKS) ps['User_Scene_%' + p.split('%')[1]] = Array.from(await readBlockRaw(p)).map(hexb);
  return ps;
}
async function fetchInitScene(avoid) {
  if (state.initScene) return state.initScene;
  const empties = state.userSlots.filter((u) => u.name === 'INIT SCENE' && !avoid.has(`${u.lsb}-${u.pc}`));
  if (!empties.length) return null;
  state.quiet = true; status('busy', 'Reading the AE-20’s empty scene');
  try {
    const reads = [];
    for (const u of empties.slice(0, 3)) {
      const ps = await readSlot(u.lsb, u.pc);
      if (psName(ps) === 'INIT SCENE') reads.push(JSON.stringify(ps));
      if (reads.length >= 2 && reads[0] === reads[1]) break;             // two agree: done
    }
    if (!reads.length) return null;
    const count = {}; for (const r of reads) count[r] = (count[r] || 0) + 1;
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    if (reads.length > 1 && best[1] < 2) return null;                      // no two agree: don't guess
    state.initScene = JSON.parse(best[0]);
    return state.initScene;
  } finally { state.quiet = false; status('ok', `${dev.name} connected by USB`); }
}
async function uploadStaged() {
  const clears = [...state.staged.entries()].filter(([, r]) => r.clear);
  if (clears.length && !(await fetchInitScene(new Set(clears.map(([k]) => k))))) {
    for (const [k] of clears) state.staged.delete(k);
    toast(state.userSlots.some((u) => u.name === 'INIT SCENE') ? 'Couldn’t read a matching empty scene from the AE-20, so no slots were emptied' : 'The AE-20 has no empty slot to copy its INIT SCENE from, so no slots were emptied');
    if (state.view === 'library') renderLibrary();
    if (!state.staged.size) return;
  }
  const jobs = [...state.staged.entries()];
  let done = 0;
  for (const [k, ref] of jobs) {
    const sc = findScene(ref); if (!sc) continue;
    const [lsb, pc] = k.split('-').map(Number);
    status('busy', `Uploading ${++done} of ${jobs.length}`);
    await audition(sc.ps); await drained();
    writeScene({ msb: 85, lsb, pc }); await drained(); await sleep(400);
    const u = state.userSlots.find((x) => x.lsb === lsb && x.pc === pc);
    if (u) u.name = sc.name; else state.userSlots.push({ msb: 85, lsb, pc, name: sc.name });
    state.scenes.set(sceneKey(85, lsb, pc), sc.name);
    state.staged.delete(k);
    if (state.view === 'library') renderLibrary();
  }
  status('ok', `${dev.name} connected by USB`);
  toast(done === 1 ? `Uploaded ${findScene(jobs[0][1]).name} to ${sceneNo({ lsb: +jobs[0][0].split('-')[0], pc: +jobs[0][0].split('-')[1] })}` : `Uploaded ${done} scenes to the AE-20`);
}
function copyFromSlot(lsb, pc) {
  if (isEmptyName(slotName(lsb, pc))) return;
  guard(async () => {
    const lib = state.libs.find((l) => l.id === state.libSel && l.kind !== 'drafts') || await ensureLib('My scenes');
    state.skipDraft = true;
    dev.dt1(block('stp').base, [85, lsb, pc]); state.cur = { msb: 85, lsb, pc };
    clearTimeout(sceneTimer); await loadScene();
    const sc = { id: uid(), name: sceneName(), ps: toParamSet(), savedAt: Date.now(), from: sceneNo(state.cur) };
    lib.scenes.push(sc); await LIB.put(lib);
    state.libSel = lib.id; state.entry = { lib: lib.id, scene: sc.id };
    toast(`Copied ${sc.name} to ${lib.name}`); renderLibrary();
  });
}
// ---- Back up the AE-20: reads every user scene and the 12 favorites; never writes anything to be stored ----
async function readBlockRaw(path) {
  const b = block(path), data = new Uint8Array(b.len);
  for (let off = 0; off < b.len; off += 128) { const n = Math.min(128, b.len - off); data.set((await dev.rq1(b.base + off, n)).slice(0, n), off); }
  return data;
}
function backupAE() {
  if (!state.connected || state.backup) return;
  guard(async () => {
    const slots = state.userSlots.filter((u) => u.name && u.name !== 'INIT SCENE').sort((a, b) => a.lsb - b.lsb || a.pc - b.pc);
    const before = state.cur && { ...state.cur }, when = new Date();
    const lib = { id: uid(), name: `AE-20 backup ${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, kind: 'library', backup: true, scenes: [], tones: [], created: Date.now(), favorites: [] };
    state.backup = { done: 0, total: slots.length, stop: false, now: '' };
    const show = () => { status('busy', `Backing up ${Math.min(state.backup.total, state.backup.done + 1)} of ${state.backup.total}`); if (state.view === 'library') renderLibrary(); };
    show();
    try {
      for (let i = 1; i <= 12; i++) { const p = `System%Sys_favorite_${i}`; lib.favorites.push(Array.from(await readBlockRaw(p))); }
      for (const u of slots) {
        if (state.backup.stop || !state.connected) break;
        state.backup.now = u.name; show();
        dev.dt1(block('stp').base, [85, u.lsb, u.pc]);            // select only: the slot itself is not touched
        await drained(); await sleep(150);
        const ps = {};
        for (const p of SCENE_BLOCKS) ps['User_Scene_%' + p.split('%')[1]] = Array.from(await readBlockRaw(p)).map(hexb);
        lib.scenes.push({ id: uid(), name: psName(ps) || u.name, ps, from: `U${pad2(u.lsb + 1)}-${pad2(u.pc + 1)}`, slot: [u.lsb, u.pc], savedAt: Date.now() });
        state.backup.done++;
      }
    } catch (e) { console.error(e); }
    const stopped = state.backup.stop || lib.scenes.length < slots.length;
    state.backup = null;
    if (lib.scenes.length) { if (stopped) lib.name += ' (partial)'; state.libs.push(lib); await LIB.put(lib); state.libSel = lib.id; LS.set('libSel', lib.id); }
    if (state.connected && before) { dev.dt1(block('stp').base, [before.msb, before.lsb, before.pc]); state.cur = before; state.skipDraft = true; await drained(); await sleep(150); await loadScene(); }
    status(state.connected ? 'ok' : 'lost', state.connected ? `${dev.name} connected by USB` : 'AE-20 unplugged or off. Click to reconnect');
    toast(lib.scenes.length ? `Backed up ${lib.scenes.length} scene${lib.scenes.length === 1 ? '' : 's'} and your favorites${stopped ? ', then stopped' : ''}` : 'Nothing was backed up');
    if (state.view === 'library') renderLibrary();
  });
}

async function importAezl(file) {
  try {
    const o = JSON.parse(await file.text());
    if (!o || !Array.isArray(o.data) || !Array.isArray(o.data[0])) throw new Error('not a library');
    const scenes = o.data[0].filter((c) => c && c.paramSet && c.paramSet['User_Scene_%Perf_common'])
      .map((c) => ({ id: uid(), name: psName(c.paramSet), ps: c.paramSet, memo: c.memo || '', from: file.name }))
      .filter((sc) => sc.name !== 'INIT SCENE');
    const l = { id: uid(), name: o.name || file.name.replace(/\.aezl$/i, ''), kind: 'library', scenes, tones: o.data[1] || [], formatRev: o.formatRev, device: o.device, created: Date.now(), ...(Array.isArray(o.favorites) ? { favorites: o.favorites, backup: true } : {}) };
    state.libs.push(l); await LIB.put(l); state.libSel = l.id;
    toast(`Imported ${l.name}: ${scenes.length} scenes`);
  } catch (e) { console.error(e); toast(`${file.name} isn’t an Aerophone library`); }
}
function exportAezl(lib) {
  const save = (name, scenes, extra) => {
    const o = { name, formatRev: lib.formatRev || '0104', device: lib.device || 'AE-30', data: [scenes.map((sc) => ({ memo: sc.memo || '', paramSet: sc.ps })), lib.tones || []], ...extra };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(o)], { type: 'application/octet-stream' }));
    a.download = name.replace(/[\\/:*?"<>|]/g, '_') + '.aezl';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  if (lib.scenes.length <= 50) return save(lib.name, lib.scenes, lib.favorites ? { favorites: lib.favorites } : {});
  const banks = new Map();
  lib.scenes.forEach((sc, i) => { const b = sc.slot ? sc.slot[0] : Math.floor(i / 50); if (!banks.has(b)) banks.set(b, []); banks.get(b).push(sc); });
  let k = 0;
  for (const [b, list] of banks) for (let i = 0; i < list.length; i += 50) setTimeout(() => save(`${lib.name} Bank ${pad2(b + 1)}${list.length > 50 ? ' part ' + (i / 50 + 1) : ''}`, list.slice(i, i + 50), lib.favorites && k === 0 ? { favorites: lib.favorites } : {}), 400 * k++);
  toast(`Saving ${k} files, one per bank. Your browser may ask to allow several downloads`);
}

// ======================= favorites wheel =======================
function wheelSVG(mode, cx, cy, R, r, hot, over) {
  const favs = favorites(); if (over) favs[over.slot] = { ...over.cand, cand: true }; let segs = '', labels = '';
  const c = state.cur, curIdx = c ? favs.findIndex((f) => f && f.msb === c.msb && f.lsb === c.lsb && f.pc === c.pc) : -1;
  const split = (s) => { const w = s.split(' '); if (s.length <= 11 || w.length < 2) return [s]; let best = null;
    for (let k = 1; k < w.length; k++) { const a = w.slice(0, k).join(' '), b = w.slice(k).join(' '), m = Math.max(a.length, b.length); if (!best || m < best[0]) best = [m, a, b]; } return [best[1], best[2]]; };
  for (let i = 0; i < 12; i++) {
    const n = i + 1, mid = (i * 30 - 90) * Math.PI / 180, a0 = mid - Math.PI / 12 + 0.012, a1 = mid + Math.PI / 12 - 0.012;
    const pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    const p = [pt(R, a0), pt(R, a1), pt(r, a1), pt(r, a0)];
    const f = favs[i];
    const cls = 'wseg' + (i === hot ? ' hot' : '') + (mode === 'play' && i === curIdx && !(f && f.cand) ? ' cur' : '') + (!f ? ' empty' : '') + (f && f.cand ? ' cand' : '');
    segs += `<path class="${cls}" data-slot="${i}" d="M${p[0][0]} ${p[0][1]} A${R} ${R} 0 0 1 ${p[1][0]} ${p[1][1]} L${p[2][0]} ${p[2][1]} A${r} ${r} 0 0 0 ${p[3][0]} ${p[3][1]}Z"/>`;
    const [lx, ly] = pt((R + r) / 2 + R * 0.03, mid);
    const saving = mode === 'save' && i === hot;
    const name = saving ? sceneName() : f ? f.name : '';
    const lines = name ? split(name) : [];
    let off = lines.length > 1 ? -8 : 0; if (saving) off -= 10;
    const ts = lines.map((t, j) => `<tspan x="${lx}" dy="${j ? 17 : 0}">${esc(t)}</tspan>`).join('');
    if (!saving) labels += `<text class="wnum" x="${lx}" y="${ly - 22 + off}">${n}</text>`;
    labels += `<text class="wnm ${i === hot ? 'whot' : ''}" x="${lx}" y="${ly + 4 + off}">${ts}</text>`;
    if (saving) labels += `<path class="wheart" transform="translate(${lx} ${ly + 4 + off + 17 * (lines.length - 1) + 14}) scale(.75)" d="${HEART}"/>`;
  }
  let hub = `<circle class="whub" cx="${cx}" cy="${cy}" r="${r - 10}"/>`;
  if (mode === 'save') {
    const [a, b] = split(sceneName() || ''); hub += `<text class="wh2" x="${cx}" y="${cy - (b ? 10 : -6)}">${esc(a)}</text>${b ? `<text class="wh2" x="${cx}" y="${cy + 18}">${esc(b)}</text>` : ''}<path class="wheart" transform="translate(${cx} ${cy + 50}) scale(1.15)" d="${HEART}"/>`;
  } else if (over) {
    const [a, b] = split(over.cand.name), hy = cy + r * 0.52, C = 2 * Math.PI * 19;
    hub += `<text class="wh2" x="${cx}" y="${cy + (b ? -16 : -4)}">${esc(a)}</text>${b ? `<text class="wh2" x="${cx}" y="${cy + 10}">${esc(b)}</text>` : ''}
      <g id="favkeep" class="keep" style="--c:${C.toFixed(1)}"><circle class="kb" cx="${cx}" cy="${hy}" r="19"/><circle class="kr" cx="${cx}" cy="${hy}" r="19" transform="rotate(-90 ${cx} ${hy})"/><path class="wheart" transform="translate(${cx} ${hy}) scale(.85)" d="${HEART}"/></g>`;
  } else if (false) {
    const [a, b] = split(''); hub += `<text class="wh2" x="${cx}" y="${cy + (b ? -4 : 8)}">${esc(a)}</text>${b ? `<text class="wh2" x="${cx}" y="${cy + 26}">${esc(b)}</text>` : ''}`;
  } else {
    const [a, b] = split(sceneName() || ''); hub += `<text class="wh2" x="${cx}" y="${cy + (b ? -2 : 9)}">${esc(a)}</text>${b ? `<text class="wh2" x="${cx}" y="${cy + 26}">${esc(b)}</text>` : ''}`;
  }
  return segs + labels + hub;
}
function slotAt(x, y, cx, cy, r, R) {
  const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
  if (d < r * 0.85 || d > R * 1.6) return null;
  let a = Math.atan2(dy, dx) * 180 / Math.PI + 90; if (a < 0) a += 360;
  return Math.round(a / 30) % 12;
}
function openWheel(mode, at) {
  if (!state.connected) return;
  const ov = $('#overlay'), W = innerWidth, H = innerHeight;
  const R = Math.min(330, H * 0.36), r = R * 0.36, cx = at ? at[0] : W / 2, cy = at ? at[1] : H / 2;
  state.wheel = { mode, cx, cy, R, r, hot: null };
  let hold = null;
  const draw = () => {
    let svg = wheelSVG('play', cx, cy, R, r, state.wheel.hot);
    if (mode === 'save') svg = svg.slice(0, svg.indexOf('<circle class="whub"')) + favHub(cx, cy, r, state.wheel.hot);
    ov.innerHTML = `<div class="veil"></div><svg viewBox="0 0 ${W} ${H}" class="${mode === 'save' ? 'saving' : ''}">${svg}</svg>`;
  };
  draw(); ov.classList.add('show');
  ov.onpointermove = (e) => { const h = slotAt(e.clientX, e.clientY, cx, cy, r, R); if (h !== state.wheel.hot) { if (hold) { hold(); hold = null; } state.wheel.hot = h; draw(); } };
  ov.onpointerdown = (e) => {
    if (mode !== 'save' || e.button !== 0) return;
    const h = slotAt(e.clientX, e.clientY, cx, cy, r, R); if (h == null) return;
    hold = holdWedge(ov.querySelector('svg'), h, cx, cy, R, r, () => { hold = null; closeWheel(); saveFavorite(h); });
  };
  ov.onclick = (e) => { if (mode === 'save' && slotAt(e.clientX, e.clientY, cx, cy, r, R) == null && !hold) closeWheel(); };
  state.wheel.draw = draw;
}
function closeWheel(commit) {
  const w = state.wheel; if (!w) return;
  $('#overlay').classList.remove('show'); $('#overlay').innerHTML = '';
  state.wheel = null;
  if (commit && w.mode === 'play' && w.hot != null) switchFavorite(w.hot);
}
function isCurFav() { const c = state.cur; return !!c && favorites().some((f) => f && f.msb === c.msb && f.lsb === c.lsb && f.pc === c.pc); }
// ======================= Live: the wheel plus a few effect knobs =======================
// Knob moves here are performance tweaks: they play at once, never mark the scene as a draft,
// and are gone when the scene changes (the instrument reloads the scene).
const COLOR_TYPES = [   // name shown, MFX type name, the parameter the knob turns
  ['Flanger', 'Flanger', 'Balance'], ['Phaser', 'Phaser 1', 'Depth'], ['Auto Wah', 'Auto Wah', 'Depth'], ['Humanizer', 'Humanizer', 'Depth'],
  ['Overdrive', 'Overdrive', 'Drive'], ['Fuzz', 'Fuzz', 'Drive'], ['Tape Echo', 'Tape Echo', 'Echo Level'], ['Lo-Fi', 'LOFI Compress', 'Balance'],
];
const mfxId = (name) => (MFX_TYPE_LIST.find((x) => x.text.replace(/^\d+\s+/, '') === name) || {}).id;
const FRIENDLY = {
  'INTEGRA7Rev': 'Studio Reverb', 'Warm Hall': 'Warm Hall', 'Hall': 'Concert Hall', 'GS Reverb': '’90s Sound Canvas Room', 'SRV-2000': 'SRV-2000 ’84 Digital', 'SRV-2000NL': 'Gated ’80s Reverb', 'GM2 Reverb': 'General MIDI Room',
  'Delay': 'Digital Delay', 'T-Ctrl Dly': 'Varispeed Delay', 'Delay->Trem': 'Delay into Tremolo', '2Tap PanDly': 'Ping-Pong Delay', '3Tap PanDly': 'Triple-Tap Delay',
  'Chorus': 'Chorus', 'CE-1': 'Boss CE-1 Chorus', 'SDD-320': 'Dimension D', 'JUNO-106 Chorus': 'Juno-106 Chorus',
};
const typeName = (list, id) => { const t = FX_LISTS[list].find((x) => x.id === id); if (!t) return '?'; const n = t.text.replace(/^\d+\s+/, ''); return list === 'MFX' ? n : FRIENDLY[n] || n; };
const SENDS = { rev: { list: 'REV', send: 7, def: 'Hall' }, cho: { list: 'CHO', send: 8, def: 'JUNO-106 Chorus' }, dly: { list: 'DLY', send: 9, def: 'Delay' } };
const activeParts = () => [1, 2, 3, 4, 5].filter((n) => mem[SP('part_' + n)] && raw(SP('part_' + n), 1));
function liveWrite(path, off, v, fx) {              // display value -> instrument, without making a draft
  const p = pdef(path, off); if (!p || !mem[path]) return;
  const [mn, mx] = range(path, off, fx); v = Math.max(mn, Math.min(mx, Math.round(v)));
  const old = val(path, off, fx);
  const bytes = enc(v + vofs(path, off, fx), p.size);
  mem[path].set(bytes, off); if (state.base && state.base[path]) state.base[path].set(bytes, off);
  sendValue(path, off, fx, old, v);
}
const syncBase = (path) => { if (state.base && mem[path]) state.base[path] = mem[path].slice(); };
// the part whose effect the Color knob plays with: the first part that is on
function colorPart() { return activeParts()[0] || 1; }
function colorState() {
  const n = colorPart(), pp = SP('part_' + n);
  const follow = raw(pp, 10) && isZC(n) && mem[TP(n, 'mfx')];
  const path = follow ? TP(n, 'mfx') : SP('mfx_' + n);
  if (!mem[path]) return null;
  const id = raw(path, 0), on = id && raw(path, 1);
  const page = fxNum('MFX', id);
  const pref = (COLOR_TYPES.find((c) => mfxId(c[1]) === id) || [])[2];
  let off = null;
  for (const want of [pref, 'Balance', 'Depth', 'Drive', 'Level'].filter(Boolean)) {
    for (let o = 16; o < 144; o += 4) { const c = cat(path, o, page); if (c && c.label === want) { off = o; break; } }
    if (off != null) break;
  }
  return { n, path, follow, id, on, page, off, name: id ? typeName('MFX', id) : 'Off' };
}
// moving the Color effect off the tone and into the scene, so the tone itself is never changed
function colorOwn() {
  const c = colorState(); if (!c || !c.follow) return c;
  const sp = SP('mfx_' + c.n), b = block(sp);
  mem[sp] = new Uint8Array(b.len); mem[sp].set(mem[c.path].slice(0, b.len));
  dev.dt1(b.base, Array.from(mem[sp])); syncBase(sp);
  liveWrite(SP('part_' + c.n), 10, 0);
  return colorState();
}
function knobDefs() {
  const out = [];
  for (const id of ['rev', 'dly', 'cho']) {
    const S = SENDS[id], path = SP(id); if (!mem[path]) continue;
    const t = raw(path, 1), on = raw(path, 0) && t;
    out.push({ id, name: { rev: 'Reverb', dly: 'Delay', cho: 'Chorus' }[id], size: id === 'cho' ? 'med' : 'big',
      frac: on ? raw(path, 2) / 127 : 0, text: on && raw(path, 2) ? Math.round(raw(path, 2) / 1.27) + '%' : 'Off',
      type: t ? typeName(S.list, t) : 'Off', types: FX_LISTS[S.list].filter((x) => x.id).map((x) => [typeName(S.list, x.id), x.id]), cur: t });
  }
  const c = colorState();
  if (c) {
    const [mn, mx] = c.off != null ? range(c.path, c.off, c.page) : [0, 1];
    const v = c.off != null ? val(c.path, c.off, c.page) : 0;
    out.push({ id: 'col', name: 'Color', size: 'med', frac: c.on && c.off != null ? (v - mn) / (mx - mn) : 0,
      text: c.on && c.off != null ? Math.round(100 * (v - mn) / (mx - mn)) + '%' : 'Off',
      type: c.on ? c.name.replace('Phaser 1', 'Phaser').replace('LOFI Compress', 'Lo-Fi') : 'Off', where: `On part ${c.n}`,
      types: COLOR_TYPES.map((t) => [t[0], mfxId(t[1])]).filter((t) => t[1]), cur: c.on ? c.id : 0 });
  }
  if (mem[SP('common')]) out.push({ id: 'vol', name: 'Level', size: 'sm', frac: raw(SP('common'), 24) / 127, text: Math.round(raw(SP('common'), 24) / 1.27) + '%' });
  const ap = activeParts();
  if (ap.length) { const v = val(SP('part_' + ap[0]), 27); out.push({ id: 'brt', name: 'Brightness', size: 'sm', frac: (v + 64) / 127, text: v > 0 ? '+' + v : String(v), center: true }); }
  return out;
}
// knob position 0..1 -> instrument
function knobSet(id, f) {
  f = Math.max(0, Math.min(1, f));
  if (SENDS[id]) {
    const S = SENDS[id], path = SP(id), lvl = Math.round(f * 127);
    if (lvl > 0 && !(raw(path, 0) && raw(path, 1))) {     // turning an effect on from Off
      if (!raw(path, 1)) { const def = FX_LISTS[S.list].find((x) => x.text.replace(/^\d+\s+/, '') === S.def) || FX_LISTS[S.list].find((x) => x.id); setFxTypeLive(path, S.list, def.id); }
      liveWrite(path, 0, 1);
      for (const n of activeParts()) if (!raw(SP('part_' + n), S.send)) liveWrite(SP('part_' + n), S.send, 64);   // let the parts reach it
    }
    liveWrite(path, 2, lvl);
  } else if (id === 'col') {
    let c = colorOwn(); if (!c) return;
    if (!c.on && f > 0) { setFxTypeLive(c.path, 'MFX', c.id || mfxId('Flanger')); c = colorState(); }
    if (c.off == null) return;
    const [mn, mx] = range(c.path, c.off, c.page); liveWrite(c.path, c.off, mn + f * (mx - mn), c.page);
  } else if (id === 'vol') liveWrite(SP('common'), 24, f * 127);
  else if (id === 'brt') for (const n of activeParts()) liveWrite(SP('part_' + n), 27, Math.round(f * 127) - 64);
}
function knobType(id, typeId) {
  if (SENDS[id]) { setFxTypeLive(SP(id), SENDS[id].list, typeId); liveWrite(SP(id), 0, 1); if (!raw(SP(id), 2)) liveWrite(SP(id), 2, 64); }
  if (id === 'col') { const c = colorOwn(); if (c) setFxTypeLive(c.path, 'MFX', typeId); }
  drawKnobs();
}
function setFxTypeLive(path, list, id) { const v = state.view; state.view = 'live-quiet'; setFxType(path, list, id); state.view = v; syncBase(path); }

const polar = (c, r, a) => [c + r * Math.cos((a - 90) * Math.PI / 180), c + r * Math.sin((a - 90) * Math.PI / 180)];
function knobSVG(size, frac, text, center) {
  const c = size / 2, w = Math.max(5, size * 0.07), r = c - w, a = -135 + 270 * frac, a0 = center ? 0 : -135;
  const arc = (x, y) => { const lo = Math.min(x, y), hi = Math.max(x, y); const [x0, y0] = polar(c, r, lo), [x1, y1] = polar(c, r, hi); return `M${x0} ${y0}A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  const [px, py] = polar(c, r * 0.79, a), [qx, qy] = polar(c, r * 0.63, a);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><path class="trk" d="${arc(-135, 135)}" stroke-width="${w}"/>
    ${Math.abs(a - a0) > 2 ? `<path class="val" d="${arc(a0, a)}" stroke-width="${w}"/>` : ''}
    <circle class="cap" cx="${c}" cy="${c}" r="${r * 0.8}"/><line class="ptr" x1="${qx}" y1="${qy}" x2="${px}" y2="${py}" stroke-width="${Math.max(2, size * 0.018)}"/>
    <text x="${c}" y="${c}" font-size="${size * 0.15}">${esc(text)}</text></svg>`;
}
function liveGeom() {
  const W = $('#main').clientWidth, H = $('#main').clientHeight, top = 78, bottom = 92;
  const R = Math.max(150, Math.min((H - top - bottom) / 2, (W - 2 * Math.min(420, W * 0.26)) / 2)), r = R * 0.36;
  const cx = W / 2, cy = top + (H - top - bottom) / 2, side = (W - 2 * R) / 2;
  const S = { big: Math.min(230, side * 0.56, H * 0.25), med: Math.min(150, side * 0.37, H * 0.16) };
  return { W, H, R, r, cx, cy, side, S, top, bottom };
}
// ---- what the centre of the wheel can show ----
const CAT_SHORT = { 'Synth Hard Lead': 'Hard Lead', 'Synth Soft Lead': 'Soft Lead', 'Synth Pad/Strings': 'Pad & Strings', 'Synth Brass/Bass': 'Synth Brass', 'Brasswinds': 'Brass', 'Guitar/Bass': 'Guitar & Bass', 'Vox/Choir': 'Voice & Choir' };
function catGroups(src) {
  if (src === 'mine') return Array.from({ length: 12 }, (_, i) => ({ name: `Bank ${pad2(i + 1)}`, pending: !lists.fresh[`1-${i}`], scenes: [...state.scenes.entries()].map(([k, n]) => { const [m, l, p] = k.split('-').map(Number); return { msb: m, lsb: l, pc: p, name: n }; }).filter((x) => x.msb === 85 && x.lsb === i && x.name && x.name !== 'INIT SCENE').sort((x, y) => x.pc - y.pc) }));
  const fromInstrument = (lsb) => [...state.scenes.entries()].map(([k, n]) => { const [m, l, p] = k.split('-').map(Number); return { msb: m, lsb: l, pc: p, name: n }; })
    .filter((x) => x.msb === 85 && x.lsb === lsb && x.name).sort((x, y) => x.pc - y.pc);
  return Array.from({ length: 12 }, (_, i) => { const cat = ((D.presets || [])[i] || {}).cat || `Preset ${pad2(i + 1)}`;
    return { name: CAT_SHORT[cat] || cat, full: cat, pending: !lists.fresh[`0-${i}`], scenes: fromInstrument(64 + i) }; });
}
function playingName() { const c = state.cur; return (c && state.scenes.get(sceneKey(c.msb, c.lsb, c.pc))) || sceneName() || ''; }
function catIdx(c, gi, g) {
  const k = c.src + gi; return c.idx[k] != null ? c.idx[k] : 0;
}
function catWheelSVG(cx, cy, R, r) {
  const c = state.cat, groups = catGroups(c.src); let segs = '', labels = '';
  if (c.hot == null) { const gi = state.cur ? groups.findIndex((g) => g.scenes.some((x) => x.lsb === state.cur.lsb && x.pc === state.cur.pc)) : -1; c.hot = gi < 0 ? 0 : gi; }
  const pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const two = (t, n) => { const w = t.split(' '); if (t.length <= n || w.length < 2) return [t]; let best = null; for (let k = 1; k < w.length; k++) { const a = w.slice(0, k).join(' '), b = w.slice(k).join(' '), m = Math.max(a.length, b.length); if (!best || m < best[0]) best = [m, a, b]; } return [best[1], best[2]]; };
  groups.forEach((g, i) => {
    const mid = (i * 30 - 90) * Math.PI / 180, a0 = mid - Math.PI / 12 + 0.012, a1 = mid + Math.PI / 12 - 0.012;
    const p = [pt(R, a0), pt(R, a1), pt(r, a1), pt(r, a0)], hot = i === c.hot && (state.wheelHover || state.kbNav), idx = catIdx(c, i, g);
    const holds = state.cur && g.scenes.some((x) => x.lsb === state.cur.lsb && x.pc === state.cur.pc);
    segs += `<path class="wseg cat ${hot ? 'hot' : ''} ${holds ? 'cur' : ''} ${g.scenes.length ? '' : 'empty'}" d="M${p[0][0]} ${p[0][1]} A${R} ${R} 0 0 1 ${p[1][0]} ${p[1][1]} L${p[2][0]} ${p[2][1]} A${r} ${r} 0 0 0 ${p[3][0]} ${p[3][1]}Z"/>`;
    if (hot && g.scenes.length > 1) {
      const f = idx / (g.scenes.length - 1), ae = a0 + 0.02 + (a1 - a0 - 0.04) * Math.max(0.03, f), [x0, y0] = pt(R - 7, a0 + 0.02), [x1, y1] = pt(R - 7, ae);
      segs += `<path class="wprog t" d="M${x0} ${y0} A${R - 7} ${R - 7} 0 0 1 ${pt(R - 7, a1 - 0.02).join(' ')}"/><path class="wprog" d="M${x0} ${y0} A${R - 7} ${R - 7} 0 0 1 ${x1} ${y1}"/>`;
    }
    const [lx, ly] = pt((R + r) / 2 + R * 0.03, mid), sc = g.scenes[idx], sn = sc ? two(sc.name, 11) : [];
    labels += `<text class="wcat" x="${lx}" y="${ly - 14 - (sn.length > 1 ? 8 : 0)}">${esc(g.name)}</text>`;
    labels += sc ? `<text class="wnm ${hot ? 'whot' : ''}" x="${lx}" y="${ly + 6 - (sn.length > 1 ? 8 : 0)}">${sn.map((t, j) => `<tspan x="${lx}" dy="${j ? 17 : 0}">${esc(t)}</tspan>`).join('')}</text>` : `<text class="wsub" x="${lx}" y="${ly + 8}">${g.pending ? '…' : 'Empty'}</text>`;
  });
  const g = groups[c.hot], nm = playingName();
  const [a, b] = two(nm, 9), ar = r * 0.66;
  let hub = `<circle class="whub" cx="${cx}" cy="${cy}" r="${r - 10}"/>`;
  hub += `<text class="wh2" x="${cx}" y="${cy + (b ? -4 : 8)}">${esc(a || '')}</text>${b ? `<text class="wh2" x="${cx}" y="${cy + 22}">${esc(b)}</text>` : ''}`;
  if (g && g.scenes.length > 1) for (const d of [-1, 1]) hub += `<g class="arrow" data-arrow="${d}"><circle cx="${cx + d * ar}" cy="${cy + 2}" r="17"/><path d="M${cx + d * ar - d * 3} ${cy - 5} L${cx + d * ar + d * 4} ${cy + 2} L${cx + d * ar - d * 3} ${cy + 9}"/></g>`;
  return segs + labels + hub;
}
const WMODES = [['fav', 'Favorites'], ['presets', 'Presets'], ['mine', 'User']];
function setMode(m) {
  if (state.favEdit) favCancel(true);
  state.favSave = false; state.favHot = null;
  state.catIdx = {};
  state.cat = m === 'fav' ? null : { src: m, hot: null, idx: state.catIdx };
  LS.set('wmode', m); drawWheelLive(); refreshMode(m);
}
const nextMode = (d = 1) => { const i = WMODES.findIndex(([k]) => k === (state.cat ? state.cat.src : 'fav')); setMode(WMODES[(i + d + 3) % 3][0]); };
function enterCats() { state.cat = { src: state.cat ? state.cat.src : 'presets', hot: null, idx: state.cat ? state.cat.idx : {}, before: state.cur && { ...state.cur }, played: false }; drawWheelLive(); }
function leaveCats(keep) {
  const c = state.cat; if (!c) return;
  state.cat = null;
  if (!keep && c.played && c.before) selectScene(c.before);
  drawWheelLive();
}
function catStep(d) {
  const c = state.cat; if (!c || c.hot == null) return;
  const g = catGroups(c.src)[c.hot]; if (!g.scenes.length) return;
  const k = c.src + c.hot, i = (catIdx(c, c.hot, g) + d + g.scenes.length) % g.scenes.length;
  c.idx[k] = i; c.played = true; selectScene(g.scenes[i]); drawWheelLive();
}
function catPick(i) {
  const c = state.cat; const g = catGroups(c.src)[i]; if (!g.scenes.length) return;
  const k = c.src + i; c.idx[k] = catIdx(c, i, g); c.hot = i; c.played = true; selectScene(g.scenes[c.idx[k]]); drawWheelLive();
}

// ---- weapon-wheel editing: point at a wedge, scroll through scenes, hold to keep ----
function sceneGroups() {   // 12 preset categories, then your 12 banks
  return [...catGroups('presets').map((g) => ({ ...g, name: g.full || g.name })), ...catGroups('mine').map((g) => ({ ...g, name: 'User · ' + g.name }))].filter((g) => g.scenes.length);
}
function favCycle(slot, dir, jump) {
  const groups = sceneGroups(); if (!groups.length) return;
  const e = state.favEdit && state.favEdit.slot === slot ? state.favEdit : null;
  if (state.favEdit && !e) favCancel(true);
  const fav = favorites()[slot], cur = state.cur, same = (a, b) => a && b && a.lsb === b.lsb && a.pc === b.pc;
  const playingFirst = !e && cur && !same(fav, cur);      // the first step offers the scene you're playing
  const from = e ? e.cand : playingFirst ? cur : fav || cur;
  let gi = from ? groups.findIndex((g) => g.scenes.some((x) => same(x, from))) : 0; if (gi < 0) gi = 0;
  let si = from ? groups[gi].scenes.findIndex((x) => same(x, from)) : -1;
  if (playingFirst) { if (si < 0) si = 0; }
  else if (jump) { gi = (gi + dir + groups.length) % groups.length; si = 0; }
  else { si += dir; if (si >= groups[gi].scenes.length) { gi = (gi + 1) % groups.length; si = 0; } if (si < 0) { gi = (gi - 1 + groups.length) % groups.length; si = groups[gi].scenes.length - 1; } }
  const cand = groups[gi].scenes[si];
  state.favEdit = { slot, cand, group: groups[gi].name.replace(/^User · /, ''), before: e ? e.before : state.cur && { ...state.cur } };
  if (!same(cand, cur)) selectScene({ msb: cand.msb, lsb: cand.lsb, pc: cand.pc });
  drawWheelLive();
}
function favCancel(quiet) {
  const e = state.favEdit; if (!e) return;
  state.favEdit = null;
  if (e.before) selectScene(e.before);
  if (!quiet) drawWheelLive();
}
function favKeep(slot) {
  const e = state.favEdit; if (!e || e.slot !== slot) return;
  state.favEdit = null;
  const p = `System%Sys_favorite_${slot + 1}`, c = e.cand;
  [1, c.msb, c.lsb, c.pc].forEach((v, k) => { mem[p][k] = v; });
  dev.dt1(block(p).base, [1, c.msb, c.lsb, c.pc]);
  dev.dt1(CMD(0x0F001000), [0]);
  toast(`Favorite ${slot + 1} is now ${c.name}`);
  drawWheelLive();
}

// ---- favorites: choose the slot, then hold on it to write ----
function startFavSave(viaOverlay) {
  const go = () => { if (viaOverlay) openWheel('save'); else { state.favSave = true; drawWheelLive(); } };
  if (!(isDirty() || state.unstored)) return go();
  const t = uploadTarget();
  const v = document.createElement('div'); v.className = 'panelveil';
  v.innerHTML = `<div class="panel" role="dialog" aria-modal="true"><h2>Upload ${esc(sceneName())} first?</h2><p>A favorite plays whatever is stored in its slot on the AE-20. Your changes to this scene aren’t stored there yet.</p>
    <button class="choice primary" data-c="upload"><div class="fill"></div>${ICON.upload}<div><b>Hold to upload to the AE-20</b><span>Overwrites user slot U${pad2(t.lsb + 1)}-${pad2(t.pc + 1)}, then pick a favorite slot</span></div></button>
    <button class="choice" data-c="saved">${ICON.heart}<div><b>Use the stored version</b><span>The favorite plays the scene as it was before your changes</span></div></button>
    <button class="stay">Keep editing</button></div>`;
  document.body.appendChild(v);
  const close = () => v.remove();
  holdable(v.querySelector('[data-c=upload]'), () => { close(); writeScene(t); setTimeout(go, 700); });
  v.querySelector('[data-c=saved]').onclick = () => { close(); go(); };
  v.querySelector('.stay').onclick = close;
  v.onclick = (e) => { if (e.target === v) close(); };
}
// press and hold on a wedge: it fills from the centre outwards, then the favorite is written
function holdWedge(svg, i, cx, cy, R, r, done) {
  const NS = 'http://www.w3.org/2000/svg', path = document.createElementNS(NS, 'path'); path.setAttribute('class', 'wfill'); svg.appendChild(path);
  const mid = (i * 30 - 90) * Math.PI / 180, a0 = mid - Math.PI / 12 + 0.012, a1 = mid + Math.PI / 12 - 0.012, pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const t0 = performance.now(); let raf;
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / 750), o = r + (R - r) * t;
    const p = [pt(o, a0), pt(o, a1), pt(r, a1), pt(r, a0)];
    path.setAttribute('d', `M${p[0][0]} ${p[0][1]} A${o} ${o} 0 0 1 ${p[1][0]} ${p[1][1]} L${p[2][0]} ${p[2][1]} A${r} ${r} 0 0 0 ${p[3][0]} ${p[3][1]}Z`);
    if (t < 1) raf = requestAnimationFrame(step); else { cleanup(); done(); }
  };
  const cleanup = () => { cancelAnimationFrame(raf); path.remove(); removeEventListener('pointerup', cleanup); };
  addEventListener('pointerup', cleanup);
  raf = requestAnimationFrame(step);
  return cleanup;
}
function favHub(cx, cy, r, hot) {        // centre of the wheel while choosing a favorite slot
  const f = hot != null ? favorites()[hot] : null;
  const nm = sceneName() || '', w = nm.split(' '), two = nm.length > 12 && w.length > 1 ? [w.slice(0, Math.ceil(w.length / 2)).join(' '), w.slice(Math.ceil(w.length / 2)).join(' ')] : [nm];
  return `<circle class="whub" cx="${cx}" cy="${cy}" r="${r - 10}"/>` + two.map((t, j) => `<text class="wh2" x="${cx}" y="${cy - 14 + (two.length > 1 ? -12 + j * 26 : 0)}">${esc(t)}</text>`).join('') +
    `<path class="wheart" transform="translate(${cx} ${cy + 22}) scale(.9)" d="${HEART}"/>` +
    (hot != null && f ? `<text class="wsub" x="${cx}" y="${cy + r * 0.62}">${esc(f.name)}</text>` : '');
}

function renderFavoritesView() {
  if (!state.connected) return;
  const live = $('#main .favview.live');
  if (live) { drawWheelLive(); if (!live.querySelector('.lv.drag')) { drawKnobs(); drawSliders(); } if (live.__redraw) live.__redraw(); return; }
  $('#main').innerHTML = `<div class="favview live"><div class="lsearch"><svg class="g" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg><input id="lq" placeholder="Find a scene" autocomplete="off" spellcheck="false"></div>
    <svg id="wheelsvg"></svg><div class="pick wmpick"><button data-step="-1" aria-label="Previous wheel">‹</button><span data-step="1"></span><button data-step="1" aria-label="Next wheel">›</button></div><div id="knobs"></div><div id="sliders"></div></div>`;
  $('#main .wmpick').onclick = (e) => { const b = e.target.closest('[data-step]'); if (b) nextMode(+b.dataset.step); };
  if (state.cat === undefined || state.cat === null) { const m = LS.get('wmode', 'fav'); if (m !== 'fav') { state.catIdx = state.catIdx || {}; state.cat = { src: m, hot: null, idx: state.catIdx }; } }
  drawWheelLive(); drawKnobs(); drawSliders(); bindSearch(); refreshMode(state.cat ? state.cat.src : 'fav');
  const svg = $('#wheelsvg');
  const hit = (e) => { const g = liveGeom(), b = svg.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, d = Math.hypot(x - g.cx, y - g.cy);
    return { hub: d < g.r * 0.85, slot: d <= g.R * 1.04 ? slotAt(x, y, g.cx, g.cy, g.r, g.R) : null, g }; };
  let hold = null;
  svg.onpointermove = (e) => {
    const h = hit(e);
    svg.classList.toggle('hubhot', false);
    const over = h.slot != null || h.hub;
    if (over !== !!state.wheelHover || state.kbNav) { state.wheelHover = over; state.kbNav = false; if (!over && state.cat) state.cat.hot = null; drawWheelLive(); }
    if (state.cat) { if (h.slot !== state.cat.hot && h.slot != null) { state.cat.hot = h.slot; drawWheelLive(); } return; }
    if (state.favEdit && h.hub) return;
    if (state.favEdit && h.slot == null) return;
    if (h.slot !== (state.favHot ?? null)) { if (hold) { hold(); hold = null; } state.favHot = h.slot; drawWheelLive(); }
  };
  svg.onpointerleave = () => { state.wheelHover = false; state.kbNav = false; if (state.cat) { state.cat.hot = null; drawWheelLive(); return; } if (state.favEdit) return; state.favHot = null; svg.classList.remove('hubhot'); drawWheelLive(); };
  svg.onpointerdown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('#favkeep') && state.favEdit) { const slot = state.favEdit.slot, k = e.target.closest('#favkeep'); k.classList.add('go'); const t = setTimeout(() => { k.classList.remove('go'); favKeep(slot); }, 750); const stop = () => { clearTimeout(t); k.classList.remove('go'); removeEventListener('pointerup', stop); }; addEventListener('pointerup', stop); return; }
    const h = hit(e); if (h.slot == null) return;
    if (state.favSave) hold = holdWedge(svg, h.slot, h.g.cx, h.g.cy, h.g.R, h.g.r, () => { hold = null; state.favSave = false; saveFavorite(h.slot); });
    else if (state.favEdit && state.favEdit.slot === h.slot) hold = holdWedge(svg, h.slot, h.g.cx, h.g.cy, h.g.R, h.g.r, () => { hold = null; favKeep(h.slot); });
  };
  svg.onclick = (e) => {
    const ar = e.target.closest('[data-arrow]'); if (ar && state.cat) { catStep(+ar.dataset.arrow); return; }
    if (e.target.closest('#favkeep')) return;
    const h = hit(e);
    if (state.cat) { if (!h.hub && h.slot != null) catPick(h.slot); return; }
    if (state.favSave) { if (h.slot == null) { state.favSave = false; drawWheelLive(); } return; }
    if (state.favEdit) { if (!h.hub && h.slot !== state.favEdit.slot) favCancel(); return; }
    if (h.slot != null && !h.hub) switchFavorite(h.slot);
  };
  svg.addEventListener('wheel', (e) => {
    if (state.cat) { if (state.cat.hot == null) return; e.preventDefault(); return catStep(e.deltaY > 0 ? -1 : 1); }
    if (state.favSave || state.favHot == null) return;
    e.preventDefault();
    const d = (e.deltaY || e.deltaX) > 0 ? -1 : 1, now = performance.now();
    if (now - (svg.__wt || 0) < 90) return; svg.__wt = now;     // one step per notch, even on smooth trackpads
    favCycle(state.favHot, d, e.shiftKey);
  }, { passive: false });
}
function drawWheelLive() {
  const svg = $('#wheelsvg'); if (!svg) return;
  const { W, H, R, r, cx, cy } = liveGeom();
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.setProperty('--ws', Math.max(0.85, Math.min(1.4, R / 370)).toFixed(3));
  svg.classList.toggle('cats', !!state.cat); svg.classList.toggle('saving', !!state.favSave); svg.dataset.wmode = state.cat ? state.cat.src : 'fav';
  const wm = $('#main .wmpick'); if (wm) { wm.style.left = Math.max(8, cx - R * 0.93 - 40) + 'px'; wm.style.top = (cy + R * 0.86) + 'px'; wm.dataset.wmode = svg.dataset.wmode; wm.querySelector('span').textContent = WMODES.find(([k]) => k === svg.dataset.wmode)[1]; }
  if (state.cat) { svg.innerHTML = catWheelSVG(cx, cy, R, r); return; }
  if (state.favSave) { const full = wheelSVG('play', cx, cy, R, r, state.favHot ?? null); svg.innerHTML = full.slice(0, full.indexOf('<circle class="whub"')) + favHub(cx, cy, r, state.favHot ?? null); return; }
  if (state.favEdit) { svg.innerHTML = wheelSVG('play', cx, cy, R, r, state.favHot ?? null, state.favEdit); return; }
  svg.innerHTML = wheelSVG('play', cx, cy, R, r, state.favHot ?? null);
}
function drawKnobs() {
  const box = $('#knobs'); if (!box) return;
  const g = liveGeom(), defs = knobDefs().filter((k) => k.size !== 'sm');
  const pos = { rev: [0.5, 0.07], dly: [0.5, 0.07], cho: [0.5, 0.55], col: [0.5, 0.55] };
  const left = { rev: 1, cho: 1 };
  box.innerHTML = defs.map((k) => {
    const size = Math.round(g.S[k.size]), [fx, fy] = pos[k.id], x = left[k.id] ? g.side * fx : g.W - g.side * fx;
    return `<div class="lv ${k.size} ${k.text === 'Off' ? 'off' : ''}" data-k="${k.id}" style="left:${x}px;top:${g.H * fy}px">
      <h4>${k.name}</h4><div class="kn" tabindex="0" role="slider" aria-label="${k.name}" aria-valuetext="${esc(k.text)}">${knobSVG(size, k.frac, k.text, k.center)}</div>
      ${k.types ? `<div class="pick"><button data-step="-1">‹</button><span data-open>${esc(k.type)}</span><button data-step="1">›</button></div>` : ''}
      ${k.where ? `<div class="where">${k.where}</div>` : ''}</div>`;
  }).join('');
  for (const el of box.querySelectorAll('.lv')) {
    const id = el.dataset.k, k = defs.find((d) => d.id === id), kn = el.querySelector('.kn');
    let start = null;
    const set = (f) => { knobSet(id, f); const nk = knobDefs().find((d) => d.id === id); kn.innerHTML = knobSVG(Math.round(g.S[nk.size]), nk.frac, nk.text, nk.center); el.classList.toggle('off', nk.text === 'Off'); kn.setAttribute('aria-valuetext', nk.text); k.frac = nk.frac; const sp = el.querySelector('.pick span'); if (sp && nk.type !== sp.textContent) sp.textContent = nk.type; };
    kn.onpointerdown = (e) => { if (e.button !== 0) return; e.preventDefault(); kn.setPointerCapture(e.pointerId); start = { y: e.clientY, f: k.frac }; el.classList.add('drag'); };
    kn.onpointermove = (e) => { if (!start) return; set(start.f + (start.y - e.clientY) / (e.shiftKey ? 900 : 220)); };
    kn.onpointerup = kn.onpointercancel = () => { start = null; el.classList.remove('drag'); };
    kn.onwheel = (e) => { e.preventDefault(); set(k.frac + (e.deltaY < 0 ? 1 : -1) / 50); };
    kn.onkeydown = (e) => { const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (d) { e.preventDefault(); e.stopPropagation(); set(k.frac + d / (e.shiftKey ? 127 : 25)); } };
    kn.ondblclick = () => liveReset(id);
    if (k.types) {
      el.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { const i = k.types.findIndex((t) => t[1] === k.cur); const n = k.types[(i + +b.dataset.step + k.types.length) % k.types.length]; knobType(id, n[1]); }; });
      el.querySelector('[data-open]').onclick = (e) => typeMenu(e.target, k);
    }
  }
}
// Volume and Brightness: plain sliders under the wheel
function drawSliders() {
  const box = $('#sliders'); if (!box) return;
  if (box.querySelector('.drag')) return;
  const g = liveGeom(), defs = knobDefs().filter((k) => k.size === 'sm');
  box.style.cssText = `left:${g.cx}px;top:${g.cy + g.R + 22}px`;
  box.innerHTML = defs.map((k) => k.id === 'brt'
    ? `<label class="ls tone" data-k="${k.id}"><span>Dark</span><input type="range" min="0" max="1000" value="${Math.round(k.frac * 1000)}" style="--p:${(k.frac * 100).toFixed(1)}%" class="centered" aria-label="Dark to bright"><span>Bright</span></label>`
    : `<label class="ls" data-k="${k.id}"><span>${k.name}</span><input type="range" min="0" max="1000" value="${Math.round(k.frac * 1000)}" style="--p:${(k.frac * 100).toFixed(1)}%"><output>${esc(k.text)}</output></label>`).join('');
  for (const l of box.querySelectorAll('.ls')) {
    const id = l.dataset.k, inp = l.querySelector('input'), out = l.querySelector('output');
    inp.oninput = () => { knobSet(id, inp.value / 1000); const nk = knobDefs().find((d) => d.id === id); if (out) out.textContent = nk.text; inp.style.setProperty('--p', (inp.value / 10) + '%'); };
    inp.onpointerdown = () => l.classList.add('drag'); inp.onpointerup = () => l.classList.remove('drag');
    inp.ondblclick = () => { liveReset(id); drawSliders(); };
    inp.onkeydown = (e) => e.stopPropagation();
  }
}
// double-click: back to how the scene was saved
function liveReset(id) {
  const o = state.loaded; if (!o) return;
  const paths = { rev: [SP('rev')], dly: [SP('dly')], cho: [SP('cho')], vol: [SP('common')], col: [SP('mfx_' + colorPart())], brt: activeParts().map((n) => SP('part_' + n)) }[id] || [];
  if (id === 'col' || SENDS[id]) paths.push(...activeParts().map((n) => SP('part_' + n)));
  for (const p of paths) { const a = mem[p], b = o[p]; if (!a || !b) continue;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { let j = i; while (j < a.length && a[j] !== b[j]) j++; dev.dt1(block(p).base + i, Array.from(b.slice(i, j))); a.set(b.slice(i, j), i); i = j; }
    syncBase(p); }
  drawKnobs();
}
function typeMenu(anchor, k) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = k.types.map(([n, id]) => `<button data-id="${id}" class="${id === k.cur ? 'on' : ''}">${esc(n)}</button>`).join('');
  document.body.appendChild(m);
  const b = anchor.getBoundingClientRect(), mh = m.offsetHeight;
  m.style.left = Math.min(innerWidth - m.offsetWidth - 12, Math.max(12, b.left + b.width / 2 - m.offsetWidth / 2)) + 'px';
  m.style.top = (b.bottom + 8 + mh < innerHeight ? b.bottom + 8 : b.top - 8 - mh) + 'px';
  m.onclick = (e) => { const x = e.target.closest('[data-id]'); if (x) { knobType(k.id, +x.dataset.id); } m.remove(); };
  setTimeout(() => addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); removeEventListener('pointerdown', off, true); } }, true));
  (m.querySelector('.on') || m.firstChild).focus();
}

// ---- search above the wheel ----
function allScenes() {
  const list = [...state.scenes.entries()].map(([k, name]) => { const [msb, lsb, pc] = k.split('-').map(Number); return { msb, lsb, pc, name }; })
    .filter((s) => s.msb === 85 && s.name && (s.lsb <= 11 || (s.lsb >= 64 && s.lsb <= 75)));
  return list.sort((a, b) => (a.lsb >= 64) - (b.lsb >= 64) || a.lsb - b.lsb || a.pc - b.pc);
}
function bindSearch() {
  const q = $('#lq'), host = $('#main .favview'); if (!q) return;
  let v = null, rows = [], at = -1;
  const isCur = (s) => state.cur && s.lsb === state.cur.lsb && s.pc === state.cur.pc;
  const close = () => { if (v) v.remove(); v = null; host.__redraw = null; host.classList.remove('browsing'); };
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    if (!t) return close();
    if (!v) {
      const g = liveGeom(); v = document.createElement('div'); v.className = 'browser';
      const w = Math.max(460, g.R * 1.6);
      v.style.cssText = `left:${g.cx - w / 2}px;top:8px;width:${w}px;max-height:${g.cy + g.R - 8}px`;
      host.appendChild(v); host.classList.add('browsing'); host.__redraw = draw;
      v.onpointerdown = (e) => {          // press on a result: play it and go back to the wheel
        const r = e.target.closest('.brow'); if (!r || e.button !== 0) return;
        e.preventDefault(); play(+r.dataset.i); q.value = ''; close(); q.blur();
        toast(`Playing ${rows[+r.dataset.i] ? rows[+r.dataset.i].name : ''}`);
      };
    }
    const cats = D.presets || [];
    rows = allScenes().filter((s) => s.name.toLowerCase().includes(t) || `u${pad2(s.lsb + 1)}-${pad2(s.pc + 1)}`.includes(t) || (s.lsb >= 64 && (cats[s.lsb - 64] || {}).cat && cats[s.lsb - 64].cat.toLowerCase().includes(t)));
    let last = '', html = '';
    rows.forEach((s, i) => {
      const grp = s.lsb <= 11 ? `User · Bank ${pad2(s.lsb + 1)}` : (cats[s.lsb - 64] || {}).cat || `Preset ${pad2(s.lsb - 63)}`;
      if (grp !== last) { html += `<h5>${esc(grp)}</h5>`; last = grp; }
      html += `<div class="brow ${isCur(s) ? 'cur' : ''} ${i === at ? 'at' : ''}" data-i="${i}"><span class="bn">${pad2(s.pc + 1)}</span><b>${esc(s.name)}</b></div>`;
    });
    v.innerHTML = `<div class="blist">${html || '<p class="empty">No scene by that name.</p>'}</div>`;
    const el = v.querySelector('.at') || v.querySelector('.cur'); if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const play = (i) => { at = i; const s = rows[i]; if (!s) return; selectScene({ msb: s.msb, lsb: s.lsb, pc: s.pc }); draw(); };
  q.oninput = () => { at = -1; draw(); };
  q.onkeydown = (e) => {
    if (!v) { if (e.key === 'Escape') q.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); play(Math.max(0, Math.min(rows.length - 1, (at < 0 ? rows.findIndex(isCur) : at) + (e.key === 'ArrowDown' ? 1 : -1)))); }
    if (e.key === 'Enter') { if (at < 0 && rows.length) play(0); q.value = ''; close(); q.blur(); }
    if (e.key === 'Escape') { e.stopPropagation(); q.value = ''; close(); q.blur(); }
  };
}

// ======================= global input =======================
document.getElementById('nav').onclick = (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (state.favEdit) favCancel(true);
  if (b.dataset.view !== 'tones') unsolo();
  state.view = b.dataset.view; state.sel = null; LS.set('view', state.view); render();
};
function applyTheme() { if (state.theme) document.documentElement.dataset.theme = state.theme; else delete document.documentElement.dataset.theme; }
$('#conn').onclick = () => { if (!state.connected) connect(); };
$('#theme').onclick = () => {
  const dark = state.theme ? state.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = dark ? 'light' : 'dark'; LS.set('theme', state.theme); applyTheme();
};
let spaceDown = false;
addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (state.view === 'tones' && e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); exportToneData(state.tonePart); return; }
  if (state.view === 'favorites' && !typing) {
    if (e.key === '/' || (e.key === 'f' && (e.ctrlKey || e.metaKey))) { const q = $('#lq'); if (q) { e.preventDefault(); q.focus(); return; } }
    if (e.key === 'Tab' && !state.favSave) { nextMode(e.shiftKey ? -1 : 1); return e.preventDefault(); }
    if (!state.cat && !state.favSave) {
      const n = (d) => { state.kbNav = true; state.favHot = ((state.favHot ?? (d > 0 ? -1 : 12)) + d + 12) % 12; drawWheelLive(); };
      if (e.key === 'ArrowRight') { if (state.favEdit) favCancel(true); n(1); return e.preventDefault(); }
      if (e.key === 'ArrowLeft') { if (state.favEdit) favCancel(true); n(-1); return e.preventDefault(); }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.favHot != null) { favCycle(state.favHot, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey); return e.preventDefault(); }
      if (e.key === 'Enter' && state.favHot != null && !e.repeat) {
        e.preventDefault();
        if (state.favEdit && state.favEdit.slot === state.favHot) {
          const g = liveGeom(), slot = state.favHot;
          const stop = holdWedge($('#wheelsvg'), slot, g.cx, g.cy, g.R, g.r, () => favKeep(slot));
          addEventListener('keyup', function up(k) { if (k.key === 'Enter') { stop(); removeEventListener('keyup', up); } });
        } else switchFavorite(state.favHot);
        return;
      }
      if (e.key === 'Escape' && state.favEdit) { favCancel(); return; }
    }
    if (state.cat) {
      const c = state.cat;
      if (e.key === 'ArrowDown' || e.key === 'e') { state.kbNav = true; c.hot = ((c.hot ?? -1) + 1) % 12; drawWheelLive(); return e.preventDefault(); }
      if (e.key === 'ArrowUp' || e.key === 'q') { state.kbNav = true; c.hot = ((c.hot ?? 12) + 11) % 12; drawWheelLive(); return e.preventDefault(); }
      if (e.key === 'ArrowRight') { catStep(1); return e.preventDefault(); }
      if (e.key === 'ArrowLeft') { catStep(-1); return e.preventDefault(); }
      if (e.key === 'Enter') { if (c.hot != null) catPick(c.hot); return e.preventDefault(); }
    }
  }
  if (e.key === 'Escape') { closeWheel(false); state.favSave = false; if (state.view === 'favorites') renderFavoritesView(); }
  if (e.code === 'Space' && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); spaceDown = true; openWheel('play'); }
});
addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceDown) { spaceDown = false; closeWheel(true); } });
$('#main').addEventListener('contextmenu', (e) => e.preventDefault());
$('#main').addEventListener('pointerdown', (e) => { if (e.button === 2) { openWheel('play', [e.clientX, e.clientY]); } });
addEventListener('pointerup', (e) => { if (e.button === 2 && state.wheel && state.wheel.mode === 'play') closeWheel(true); });
addEventListener('resize', () => renderMain(true));

applyTheme();
if (window.AE_VERSION) $('#ver').textContent = `v${AE_VERSION.version} · ${AE_VERSION.build}`;
if (!navigator.requestMIDIAccess) { status('', 'No Web MIDI'); $('#main').innerHTML = '<div class="connect"><div class="card"><h2>Use Chrome or Edge</h2><p>This browser can’t talk to MIDI devices. Open the editor in Chrome or Edge.</p></div></div>'; document.body.classList.add('noinsp'); }
else loadLibs().then(connect);
window.__app = { zenRecord, saveToneForZenology, waveOf, setWave, waveBrowser, newTone, saveTone, toneDirty, tonesDirty, fetchUserTones, setTone, setFxType, lists, refreshMode, favorites, air, knobSet, knobDefs, colorState, setMode, catStep, state, mem, block, dev, raw, val, setVal, readBlock, selectScene, switchFavorite, SP, TP, isDirty, toParamSet, audition, LIB };   // for testing
})();
