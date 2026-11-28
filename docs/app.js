(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fmt = t => { t = Math.max(0, t || 0); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60); return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0'); };
const fmtP = t => fmt(t) + '.' + Math.floor(((t || 0) % 1) * 10);
const fmtLeft = s => !isFinite(s) ? '—' : s < 60 ? '1分未満' : s < 3600 ? Math.round(s / 60) + '分' : (s / 3600).toFixed(1) + '時間';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep0 = () => new Promise(r => setTimeout(r, 0));
const once = (el, ev, ms = 8000) => new Promise(res => { let t; const f = () => { clearTimeout(t); el.removeEventListener(ev, f); res(true); }; el.addEventListener(ev, f); t = setTimeout(() => { el.removeEventListener(ev, f); res(false); }, ms); });

const ICON = {
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg class="i" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  fs: '<svg class="i" viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M11 5h2v14h-2zM5 11h14v2H5z"/></svg>',
  check: '<svg class="i" viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>',
  up: '<svg class="i" viewBox="0 0 24 24"><path d="M12 7l-7 7 1.4 1.4L12 9.8l5.6 5.6L19 14z"/></svg>',
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M12 17l7-7-1.4-1.4L12 14.2 6.4 8.6 5 10z"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>',
};

const v = $('#v'), tl = $('#tl'), thumbV = $('#thumbV');
const S = {
  file: null, url: null, duration: 0, feat: null, audio: null, segs: [], clips: [], gap: 60, gapAuto: true,
  view: { start: 0, span: 0 }, pendingIn: null, curSeg: -1, curLine: -1, skim: null, stopAt: null,
  thumbs: new Map(), aToken: 0, tToken: 0, nextId: 1, analyzing: false, exporting: false,
  tr: { model: '', lines: [], doneUntil: 0 }, query: '',
  lineClosed: new Set(), segOpen: new Set(), segMode: 'topic',
};
try { if (localStorage.getItem('kirinuki:segMode') === 'line') S.segMode = 'line'; } catch (_) {}

/* ---------------- toast ---------------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }

/* ---------------- storage ---------------- */
const IDB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('kirinuki', 1); r.onupgradeneeded = () => r.result.createObjectStore('tr'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  return {
    async get(k) { try { const db = await open(); return await new Promise(res => { const q = db.transaction('tr').objectStore('tr').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (_) { return null; } },
    async put(k, val) { try { const db = await open(); await new Promise(res => { const tx = db.transaction('tr', 'readwrite'); tx.objectStore('tr').put(val, k); tx.oncomplete = res; tx.onerror = res; }); } catch (_) {} },
  };
})();
const fileKey = () => S.file ? S.file.name + '|' + S.file.size : '';
const trKey = model => fileKey() + '|' + model;

/* ---------------- MP4 parsing (audio track only) ---------------- */
async function readAt(file, off, len) { return new Uint8Array(await file.slice(off, off + len).arrayBuffer()); }
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const typ = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o), hdr = 8; const type = typ(b, o + 4);
    if (size === 1) { size = u64(b, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr) return;
    yield { type, start: o, body: o + hdr, end: Math.min(o + size, end) };
    o += size;
  }
}
const child = (b, box, type) => { for (const c of boxes(b, box.body, box.end)) if (c.type === type) return c; return null; };
const path = (b, box, ...types) => { let cur = box; for (const t of types) { cur = child(b, cur, t); if (!cur) return null; } return cur; };
function findDeep(b, start, end, type, depth = 0) {
  for (const c of boxes(b, start, end)) {
    if (c.type === type) return c;
    if (depth < 3 && c.type === 'wave') { const r = findDeep(b, c.body, c.end, type, depth + 1); if (r) return r; }
  }
  return null;
}
async function scanTop(file) {
  const list = []; let o = 0; const size = file.size;
  while (o + 8 <= size && list.length < 300000) {
    const h = await readAt(file, o, 16);
    let sz = u32(h, 0), hdr = 8; const t = typ(h, 4);
    if (sz === 1) { sz = u64(h, 8); hdr = 16; } else if (sz === 0) sz = size - o;
    if (sz < hdr) break;
    list.push({ type: t, start: o, size: sz, hdr });
    o += sz;
  }
  return list;
}
function parseEsds(b, box) {
  let p = box.body + 4;
  const desc = () => { const tag = b[p++]; let len = 0; for (let i = 0; i < 4; i++) { const c = b[p++]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return { tag, len }; };
  let d = desc(); if (d.tag !== 3) return null;
  p += 2; const fl = b[p++]; if (fl & 0x80) p += 2; if (fl & 0x40) p += b[p] + 1; if (fl & 0x20) p += 2;
  d = desc(); if (d.tag !== 4) return null;
  const oti = b[p]; p += 13;
  let asc = null;
  if (p < box.end) { d = desc(); if (d.tag === 5) asc = b.slice(p, p + d.len); }
  return { oti, asc };
}
function parseAsc(a) {
  let bit = 0;
  const rd = n => { let x = 0; for (let i = 0; i < n; i++) { x = (x << 1) | ((a[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; } return x; };
  let aot = rd(5); if (aot === 31) aot = 32 + rd(6);
  const fi = rd(4);
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const rate = fi === 15 ? rd(24) : rates[fi];
  const ch = rd(4);
  return { aot, rate, ch };
}
async function probeMp4(file) {
  const top = await scanTop(file);
  if (!top.length || top[0].type !== 'ftyp') return null;
  const mv = top.find(x => x.type === 'moov'); if (!mv || mv.size > 256 * 2 ** 20) return null;
  const m = await readAt(file, mv.start, mv.size);
  const root = { body: mv.hdr, end: m.length };
  const mvhd = child(m, root, 'mvhd');
  const movieTs = mvhd ? u32(m, mvhd.body + (m[mvhd.body] === 1 ? 20 : 12)) || 1000 : 1000;
  const trex = new Map();
  const mvex = child(m, root, 'mvex');
  if (mvex) for (const c of boxes(m, mvex.body, mvex.end)) if (c.type === 'trex') trex.set(u32(m, c.body + 4), { dur: u32(m, c.body + 12), size: u32(m, c.body + 16) });
  for (const trak of boxes(m, root.body, root.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = path(m, trak, 'mdia', 'hdlr'); if (!hdlr || typ(m, hdlr.body + 8) !== 'soun') continue;
    const tkhd = child(m, trak, 'tkhd'); const trackId = u32(m, tkhd.body + (m[tkhd.body] === 1 ? 20 : 12));
    const mdhd = path(m, trak, 'mdia', 'mdhd');
    const ts = mdhd ? u32(m, mdhd.body + (m[mdhd.body] === 1 ? 20 : 12)) || 1 : 1;
    // edit list: an empty edit delays the whole track (audio that starts N seconds into the video);
    // media_time skips encoder priming. presentation time = dts / ts + off
    let off = 0;
    const elst = path(m, trak, 'edts', 'elst');
    if (elst) {
      const ev = m[elst.body], n = u32(m, elst.body + 4); let p = elst.body + 8, pre = 0, found = false;
      for (let i = 0; i < n; i++) {
        let d, mt;
        if (ev === 1) { d = u64(m, p); mt = u32(m, p + 8) === 0xffffffff ? -1 : u64(m, p + 8); p += 20; }
        else { d = u32(m, p); mt = u32(m, p + 4) | 0; p += 12; }
        if (mt === -1) { pre += d / movieTs; continue; }
        off = pre - mt / ts; found = true; break;
      }
      if (!found) off = pre;
    }
    const stbl = path(m, trak, 'mdia', 'minf', 'stbl'); if (!stbl) continue;
    const stsd = child(m, stbl, 'stsd'); if (!stsd) continue;
    const entry = boxes(m, stsd.body + 8, stsd.end).next().value; if (!entry) continue;
    const eb = entry.body, ver = u16(m, eb + 8);
    let channels = u16(m, eb + 16), rate = u32(m, eb + 24) >>> 16;
    const cs = eb + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    let codec = null, asc = null, frameLen = 1024;
    if (entry.type === 'mp4a') {
      const esdsBox = findDeep(m, cs, entry.end, 'esds');
      const es = esdsBox && parseEsds(m, esdsBox);
      if (es) {
        if ([0x40, 0x66, 0x67, 0x68].includes(es.oti) && es.asc && es.asc.length >= 2) {
          const a = parseAsc(es.asc); codec = 'mp4a.40.' + a.aot; asc = es.asc;
          if (a.rate) rate = a.rate; if (a.ch) channels = a.ch;
        } else if (es.oti === 0x69 || es.oti === 0x6b) { codec = 'mp3'; frameLen = 1152; }
      }
    }
    if (!codec) return null;
    let samples = null;
    const stsz = child(m, stbl, 'stsz'), stsc = child(m, stbl, 'stsc'), stco = child(m, stbl, 'stco') || child(m, stbl, 'co64');
    if (stsz && stsc && stco) {
      const fixed = u32(m, stsz.body + 4), count = u32(m, stsz.body + 8);
      if (count > 0) {
        const sizes = new Uint32Array(count);
        for (let i = 0; i < count; i++) sizes[i] = fixed || u32(m, stsz.body + 12 + i * 4);
        const is64 = stco.type === 'co64', nch = u32(m, stco.body + 4);
        const chunkOff = new Float64Array(nch);
        for (let i = 0; i < nch; i++) chunkOff[i] = is64 ? u64(m, stco.body + 8 + i * 8) : u32(m, stco.body + 8 + i * 4);
        const ne = u32(m, stsc.body + 4), ent = [];
        for (let i = 0; i < ne; i++) { const q = stsc.body + 8 + i * 12; ent.push([u32(m, q), u32(m, q + 4)]); }
        const offsets = new Float64Array(count); let si = 0;
        for (let e = 0; e < ent.length; e++) {
          const first = ent[e][0] - 1, spc = ent[e][1], last = e + 1 < ent.length ? ent[e + 1][0] - 1 : nch;
          for (let c = first; c < last && si < count; c++) { let o = chunkOff[c]; for (let k = 0; k < spc && si < count; k++) { offsets[si] = o; o += sizes[si]; si++; } }
        }
        // decode times from stts (sample durations can vary, and there can be gaps)
        const times = new Float64Array(count), stts = child(m, stbl, 'stts');
        let k = 0, dts = 0;
        if (stts) { const ne2 = u32(m, stts.body + 4); for (let e = 0; e < ne2 && k < count; e++) { const q = stts.body + 8 + e * 8, cnt = u32(m, q), delta = u32(m, q + 4); for (let j = 0; j < cnt && k < count; j++) { times[k++] = dts / ts + off; dts += delta; } } }
        for (; k < count; k++) times[k] = (k ? times[k - 1] + frameLen / rate : off);
        samples = { offsets, sizes, times, count: si };
      }
    }
    if (!samples || samples.count === 0) {
      const offs = [], szs = [], tms = [], def = trex.get(trackId);
      let dts = 0;   // continues across fragments when a fragment has no tfdt
      for (const bx of top) {
        if (bx.type !== 'moof') continue;
        const b = await readAt(file, bx.start, bx.size);
        for (const traf of boxes(b, bx.hdr, b.length)) {
          if (traf.type !== 'traf') continue;
          const tfhd = child(b, traf, 'tfhd'); if (!tfhd) continue;
          const fl = u32(b, tfhd.body) & 0xffffff; let p = tfhd.body + 4;
          if (u32(b, p) !== trackId) continue; p += 4;
          let base = bx.start; if (fl & 1) { base = u64(b, p); p += 8; }
          if (fl & 2) p += 4;
          let defDur = def ? def.dur : 0; if (fl & 8) { defDur = u32(b, p); p += 4; }
          let defSize = def ? def.size : 0; if (fl & 0x10) { defSize = u32(b, p); p += 4; }
          const tfdt = child(b, traf, 'tfdt');
          if (tfdt) dts = b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4);
          let cursor = base;
          for (const trun of boxes(b, traf.body, traf.end)) {
            if (trun.type !== 'trun') continue;
            const tf = u32(b, trun.body) & 0xffffff; let q = trun.body + 4;
            const n = u32(b, q); q += 4;
            let o = cursor; if (tf & 1) { o = base + (u32(b, q) | 0); q += 4; }
            if (tf & 4) q += 4;
            for (let i = 0; i < n; i++) {
              let du = defDur; if (tf & 0x100) { du = u32(b, q); q += 4; }
              let sz = defSize; if (tf & 0x200) { sz = u32(b, q); q += 4; }
              if (tf & 0x400) q += 4; if (tf & 0x800) q += 4;
              offs.push(o); szs.push(sz); tms.push(dts / ts + off); o += sz; dts += du || Math.round(frameLen * ts / rate);
            }
            cursor = o;
          }
        }
      }
      samples = { offsets: Float64Array.from(offs), sizes: Uint32Array.from(szs), times: Float64Array.from(tms), count: offs.length };
    }
    if (!samples.count) return null;
    return { codec, asc, rate, channels: channels || 2, frameLen, samples, start: samples.times[0], editOffset: off };
  }
  return null;
}

/* ---------------- decoding ---------------- */
function decoderConfig(info) { const cfg = { codec: info.codec, sampleRate: info.rate, numberOfChannels: info.channels }; if (info.asc) cfg.description = info.asc; return cfg; }
// Feed samples [i0, i1) to a fresh AudioDecoder; onPCM gets mono float32 chunks in order,
// with the chunk's presentation time in seconds (taken from the file, so gaps and delays are kept).
async function decodeRange(file, info, i0, i1, onPCM, onProg, isCancelled) {
  let err = null;
  const dec = new AudioDecoder({
    output: ad => {
      try { const n = ad.numberOfFrames, buf = new Float32Array(n); ad.copyTo(buf, { planeIndex: 0, format: 'f32-planar' }); onPCM(buf, ad.sampleRate, ad.timestamp / 1e6); }
      catch (e) { err = err || e; } finally { ad.close(); }
    },
    error: e => { err = err || e; },
  });
  dec.configure(decoderConfig(info));
  const { offsets, sizes, times } = info.samples;
  let i = i0;
  try {
    while (i < i1) {
      if (isCancelled && isCancelled()) throw new Error('cancel');
      const s = offsets[i]; let e = s + sizes[i], j = i + 1;
      while (j < i1 && offsets[j] >= e && offsets[j] - e < 65536 && offsets[j] + sizes[j] - s < 4194304) { e = offsets[j] + sizes[j]; j++; }
      const buf = await readAt(file, s, e - s);
      for (let k = i; k < j; k++) {
        const rel = offsets[k] - s;
        if (sizes[k] > 0 && rel + sizes[k] <= buf.length) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(times[k] * 1e6), data: buf.subarray(rel, rel + sizes[k]) }));
      }
      i = j;
      while (dec.decodeQueueSize > 48 && !err) await sleep0();
      if (err) throw err;
      if (onProg) onProg((i - i0) / (i1 - i0));
    }
    await dec.flush();
    if (err) throw err;
  } finally { if (dec.state !== 'closed') dec.close(); }
}
async function decodeMp4(file, info, onPCM, onProg, token) {
  if (!('AudioDecoder' in window)) throw new Error('no-webcodecs');
  const sup = await AudioDecoder.isConfigSupported(decoderConfig(info));
  if (!sup.supported) throw new Error('unsupported-codec');
  await decodeRange(file, info, 0, info.samples.count, onPCM, onProg, () => token !== S.aToken);
  S.audio = { kind: 'mp4', info };
}
async function decodeWhole(file, onPCM, onProg, token) {
  if (file.size > 700 * 2 ** 20) throw new Error('too-big');
  const ab = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const abuf = await ctx.decodeAudioData(ab);
  const d = abuf.getChannelData(0), step = abuf.sampleRate * 30;
  for (let o = 0; o < d.length; o += step) {
    if (token !== S.aToken) throw new Error('cancel');
    onPCM(d.subarray(o, Math.min(d.length, o + step)), abuf.sampleRate);
    onProg(o / d.length); await sleep0();
  }
  S.audio = { kind: 'buf', buf: d, sr: abuf.sampleRate };
}
async function resample16k(x, sr) {
  if (sr === 16000 || !x.length) return Float32Array.from(x);
  const oc = new OfflineAudioContext(1, Math.max(1, Math.ceil(x.length * 16000 / sr)), 16000);
  const b = oc.createBuffer(1, x.length, sr); b.copyToChannel(x, 0);
  const src = oc.createBufferSource(); src.buffer = b; src.connect(oc.destination); src.start();
  const r = await oc.startRendering();
  return Float32Array.from(r.getChannelData(0));
}
// mono 16 kHz audio for [t0, t1)
async function pcm16k(t0, t1) {
  const A = S.audio; if (!A) throw new Error('no-audio');
  if (A.kind === 'buf') return resample16k(A.buf.subarray(Math.max(0, Math.floor(t0 * A.sr)), Math.min(A.buf.length, Math.ceil(t1 * A.sr))), A.sr);
  const info = A.info, T = info.samples.times, n = info.samples.count;
  const firstAtOrAfter = t => { let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid] < t) lo = mid + 1; else hi = mid; } return lo; };
  const i0 = Math.max(0, firstAtOrAfter(t0) - 2), i1 = Math.min(n, firstAtOrAfter(t1) + 2);
  const parts = []; let sr = info.rate;
  if (i1 > i0) await decodeRange(S.file, info, i0, i1, (x, r, ts) => { parts.push({ x, ts }); sr = r; });
  // lay each decoded chunk at its real time; anything without audio (before the track starts, gaps) stays silent
  const len = Math.max(1, Math.round((t1 - t0) * sr)), out = new Float32Array(len);
  let seq = i0 < n ? T[i0] : t0;
  for (const p of parts) {
    const ts = isFinite(p.ts) ? p.ts : seq;
    let o = Math.round((ts - t0) * sr), a = 0; if (o < 0) { a = -o; o = 0; }
    if (a < p.x.length && o < len) out.set(p.x.subarray(a, Math.min(p.x.length, a + len - o)), o);
    seq = ts + p.x.length / sr;
  }
  return resample16k(out, sr);
}

/* ---------------- acoustic features ---------------- */
class Grow {
  constructor() { this.a = new Float32Array(8192); this.n = 0; }
  push(x) { if (this.n === this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = x; }
  get() { return this.a.subarray(0, this.n); }
}
function makeFFT(N) {
  const lev = Math.log2(N), rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let j = 0; j < lev; j++) r = (r << 1) | ((i >> j) & 1); rev[i] = r; }
  const cs = new Float32Array(N / 2), sn = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / N); sn[i] = Math.sin(2 * Math.PI * i / N); }
  return (re, im) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, st = N / size;
      for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += st) {
        const l = i + j + half, tr = re[l] * cs[k] + im[l] * sn[k], ti = im[l] * cs[k] - re[l] * sn[k];
        re[l] = re[i + j] - tr; im[l] = im[i + j] - ti; re[i + j] += tr; im[i + j] += ti;
      }
    }
  };
}
class Extractor {
  constructor() { this.sr = 0; this.N = 512; this.NB = 16; }
  init(sr) {
    this.sr = sr; this.pos = 0; this.dec = Math.max(1, Math.floor(sr / 16000)); this.rate = sr / this.dec;
    const N = this.N; this.buf = new Float32Array(N); this.fill = 0; this.acc = 0; this.accN = 0;
    this.re = new Float32Array(N); this.im = new Float32Array(N); this.fft = makeFFT(N);
    this.win = new Float32Array(N); for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const fmin = 80, fmax = Math.min(7600, this.rate * 0.47), NB = this.NB;
    this.lo = new Uint16Array(NB); this.hi = new Uint16Array(NB);
    for (let k = 0; k < NB; k++) {
      const f0 = fmin * Math.pow(fmax / fmin, k / NB), f1 = fmin * Math.pow(fmax / fmin, (k + 1) / NB);
      const b0 = Math.max(1, Math.floor(f0 / this.rate * N)), b1 = Math.max(b0 + 1, Math.floor(f1 / this.rate * N));
      this.lo[k] = b0; this.hi[k] = Math.min(N / 2, b1);
    }
    this.prev = new Float32Array(NB); this.hasPrev = false;
    this.db = new Grow(); this.zcr = new Grow(); this.flux = new Grow(); this.bands = new Grow();
  }
  // t: presentation time of x[0] in seconds (optional). Gaps are filled with silence and overlaps
  // dropped, so feature frame k always means time k * N / rate on the video's clock.
  push(x, sr, t) {
    if (!this.sr) this.init(sr);
    if (t != null && isFinite(t)) {
      const gap = t - this.pos;
      if (gap > 0.02) { const z = new Float32Array(16384); let left = Math.round(gap * this.sr); while (left > 0) { const k = Math.min(left, z.length); this.feed(z.subarray(0, k)); left -= k; } }
      else if (gap < -0.02) { x = x.subarray(Math.min(x.length, Math.round(-gap * this.sr))); }
    }
    this.feed(x);
  }
  feed(x) {
    this.pos += x.length / this.sr;
    const d = this.dec, b = this.buf, N = this.N;
    for (let i = 0; i < x.length; i++) {
      this.acc += x[i];
      if (++this.accN === d) { b[this.fill++] = this.acc / d; this.acc = 0; this.accN = 0; if (this.fill === N) { this.frame(); this.fill = 0; } }
    }
  }
  frame() {
    const N = this.N, b = this.buf, re = this.re, im = this.im;
    let e = 0, z = 0;
    for (let i = 0; i < N; i++) { const x = b[i]; e += x * x; if (i && ((x >= 0) !== (b[i - 1] >= 0))) z++; re[i] = x * this.win[i]; im[i] = 0; }
    this.db.push(10 * Math.log10(e / N + 1e-12)); this.zcr.push(z / N);
    this.fft(re, im);
    let fl = 0;
    for (let k = 0; k < this.NB; k++) {
      let s = 0; for (let j = this.lo[k]; j < this.hi[k]; j++) s += re[j] * re[j] + im[j] * im[j];
      const lv = Math.log10(s / (this.hi[k] - this.lo[k]) + 1e-12);
      this.bands.push(lv);
      if (this.hasPrev) fl += Math.max(0, lv - this.prev[k]);
      this.prev[k] = lv;
    }
    this.hasPrev = true; this.flux.push(fl);
  }
}
function pctOf(arr, p) { const s = Float32Array.from(arr).filter(x => !isNaN(x)).sort(); return s.length ? s[clamp(Math.floor(p * s.length), 0, s.length - 1)] : 0; }
function rankNorm(raw) { const n = raw.length, idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => raw[a] - raw[b]); const out = new Float32Array(n); idx.forEach((i, r) => { out[i] = n > 1 ? r / (n - 1) : 0.5; }); return out; }
function smooth(a, r) { const n = a.length, out = new Float32Array(n); const P = new Float64Array(n + 1); for (let i = 0; i < n; i++) P[i + 1] = P[i] + a[i]; for (let i = 0; i < n; i++) { const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1); out[i] = (P[hi] - P[lo]) / (hi - lo); } return out; }

function summarize(ex, knownDur) {
  const fd = ex.N / ex.rate, nF = ex.db.n;
  if (nF < 40) throw new Error('short');
  const db = ex.db.get(), flux = ex.flux.get(), zcr = ex.zcr.get(), bands = ex.bands.get(), NB = ex.NB;
  const lo = pctOf(db, 0.06), hi = pctOf(db, 0.97);
  const thr = Math.max(lo + 6, lo + (hi - lo) * 0.3);
  const voiced = new Uint8Array(nF); for (let i = 0; i < nF; i++) voiced[i] = db[i] > thr ? 1 : 0;
  const gapF = Math.round(0.2 / fd);
  for (let i = 0; i < nF;) { if (!voiced[i]) { let j = i; while (j < nF && !voiced[j]) j++; if (j - i < gapF && i > 0 && j < nF) for (let k = i; k < j; k++) voiced[k] = 2; i = j; } else i++; }
  const pauses = [];
  for (let i = 0; i < nF;) { if (voiced[i] === 0) { let j = i; while (j < nF && voiced[j] === 0) j++; if ((j - i) * fd >= 0.35) pauses.push({ s: i * fd, e: j * fd }); i = j; } else i++; }
  const onset = new Uint8Array(nF); let last = -99;
  for (let i = 2; i < nF; i++) if (voiced[i] === 1 && db[i] - Math.min(db[i - 1], db[i - 2]) > 5 && i - last >= 4) { onset[i] = 1; last = i; }

  const featDur = nF * fd, duration = knownDur && isFinite(knownDur) ? knownDur : featDur;
  const nB = Math.max(1, Math.ceil(featDur)), D = NB + 5;
  const X = new Float32Array(nB * D), vr = new Float32Array(nB);
  const bs = new Float64Array(NB), ba = new Float64Array(NB);
  for (let b = 0; b < nB; b++) {
    const f0 = Math.floor(b / fd), f1 = Math.min(nF, Math.max(f0 + 1, Math.floor((b + 1) / fd)));
    let nv = 0, sdb = 0, adb = 0, sfl = 0, szc = 0, on = 0; bs.fill(0); ba.fill(0);
    for (let f = f0; f < f1; f++) {
      sfl += flux[f]; szc += zcr[f]; on += onset[f]; adb += db[f];
      for (let k = 0; k < NB; k++) { const x = bands[f * NB + k]; ba[k] += x; if (voiced[f]) bs[k] += x; }
      if (voiced[f]) { nv++; sdb += db[f]; }
    }
    const n = Math.max(1, f1 - f0), o = b * D;
    for (let k = 0; k < NB; k++) X[o + k] = nv ? bs[k] / nv : ba[k] / n;
    X[o + NB] = nv ? sdb / nv : adb / n;
    X[o + NB + 1] = nv / n; X[o + NB + 2] = sfl / n; X[o + NB + 3] = szc / n; X[o + NB + 4] = on / (n * fd);
    vr[b] = nv / n;
  }
  const Z = new Float32Array(nB * D);
  for (let k = 0; k < D; k++) {
    let m = 0, s = 0; for (let b = 0; b < nB; b++) m += X[b * D + k]; m /= nB;
    for (let b = 0; b < nB; b++) { const d = X[b * D + k] - m; s += d * d; } s = Math.sqrt(s / nB) || 1;
    const w = k < NB ? 0.55 : 1;
    for (let b = 0; b < nB; b++) Z[b * D + k] = clamp((X[b * D + k] - m) / s, -4, 4) * w;
  }
  const exRaw = new Float32Array(nB);
  for (let b = 0; b < nB; b++) { const o = b * D; exRaw[b] = 0.45 * Z[o + NB] + 0.35 * Z[o + NB + 4] + 0.2 * Z[o + NB + 2] - (1 - vr[b]) * 0.8; }
  const excite = rankNorm(smooth(exRaw, 2));
  const P = new Float64Array((nB + 1) * D);
  for (let b = 0; b < nB; b++) for (let k = 0; k < D; k++) P[(b + 1) * D + k] = P[b * D + k] + Z[b * D + k];
  const nov = W => { const out = new Float32Array(nB); for (let b = 1; b < nB; b++) { const w = Math.min(W, b, nB - b); if (w < 3) continue; let s = 0; for (let k = 0; k < D; k++) { const L = (P[b * D + k] - P[(b - w) * D + k]) / w, R = (P[(b + w) * D + k] - P[b * D + k]) / w, d = L - R; s += d * d; } out[b] = Math.sqrt(s / D) * Math.sqrt(w / W); } return out; };
  const n1 = nov(8), n2 = nov(25), p1 = pctOf(n1, 0.95) || 1, p2 = pctOf(n2, 0.95) || 1;
  const bonus = new Float32Array(nB);
  for (const p of pauses) { const len = p.e - p.s; if (len < 0.6) continue; const c = Math.round((p.s + p.e) / 2), val = Math.min(1, (len - 0.4) / 1.8); for (let d = -1; d <= 1; d++) { const i = c + d; if (i >= 0 && i < nB) bonus[i] = Math.max(bonus[i], d ? val * 0.6 : val); } }
  let ch = new Float32Array(nB);
  for (let b = 0; b < nB; b++) ch[b] = 0.75 * (0.45 * n1[b] / p1 + 0.55 * n2[b] / p2) + 0.35 * bonus[b];
  const sm = new Float32Array(nB); for (let b = 0; b < nB; b++) sm[b] = 0.25 * (ch[b - 1] ?? ch[b]) + 0.5 * ch[b] + 0.25 * (ch[b + 1] ?? ch[b]);
  const pc = pctOf(sm, 0.98) || 1; ch = sm.map(x => clamp(x / pc, 0, 1));
  const nE = Math.ceil(featDur * 4), env = new Float32Array(nE), per = 0.25 / fd;
  for (let i = 0; i < nE; i++) { let m = -200; for (let f = Math.floor(i * per); f < Math.min(nF, Math.floor((i + 1) * per)); f++) if (db[f] > m) m = db[f]; env[i] = clamp((m - lo) / ((hi - lo) || 1), 0, 1); }
  const envFine = new Float32Array(nF); for (let f = 0; f < nF; f++) envFine[f] = clamp((db[f] - lo) / ((hi - lo) || 1), 0, 1);
  return { duration, nB, ac: ch, change: ch, excite, voiced: vr, env, envFine, fd, vthr: (thr - lo) / ((hi - lo) || 1), pauses, textUntil: 0 };
}

/* ---------------- transcript → topic changes ---------------- */
const SEGR = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
const STOP = new Set(('こと もの これ それ あれ どれ ここ そこ あそこ どこ そう よう ため とき 時 感じ 自分 今日 本当 結構 ちょっと やっぱり やはり 全然 みんな 皆さん 一つ 二つ 何 何か 部分 場合 今回 最近 前 後 中 上 下 方 人 日 気 話 年 月 回 的 さん 私 僕 俺 あなた 皆 今 次 時間 ところ 所 ほう 方法 普通 一番 多分 たぶん 大体 特に 実際 ちゃんと いろいろ 色々 意味 状態 必要 大丈夫 本当に 自体 以上 以外 あと 後で 全部 最初 最後 他 他の 同じ 別 ' +
  'ええ えー あー うーん まあ ま はい うん なんか なんて ね よ ほんと マジ 系 化 性 的に 的な 等 達 たち 頃 ごろ 位 くらい ぐらい 毎日 毎回 ' +
  '分 秒 個 枚 円 倍 割 度 本 件 歳 行 来 見 言 思 出 入 作 使 彼 彼女').split(/\s+/).filter(Boolean));
function tokens(text) {
  const out = [];
  if (!SEGR) { const m = text.match(/[一-鿿]{2,}|[゠-ヿー]{2,}|[A-Za-z]{3,}/g) || []; return m.filter(w => !STOP.has(w)).map(w => w.toLowerCase()); }
  for (const s of SEGR.segment(text)) {
    if (!s.isWordLike) continue;
    const w = s.segment;
    if (/^[぀-ゟー]+$/.test(w)) continue;          // hiragana-only: particles, endings
    if (/^[0-9０-９.,]+$/.test(w)) continue;
    if (w.length < 2 && !/[一-鿿]/.test(w)) continue;
    if (STOP.has(w)) continue;
    out.push(w.toLowerCase());
  }
  return out;
}
// Whisper's segment times drift by a few hundred ms. Move each sentence's start/end to the nearest
// real speech onset/offset in the loudness envelope (within ±0.8 s); keeps the raw times in s0/e0.
// Whisper sometimes shifts a whole 30-s window by several seconds (typically when the window opens
// with silence). Sentences from one window share the error, so they are handled as a block: blocks
// come from the recorded window (ck) or, for older transcripts, are split where neighbouring sentences
// overlap or leave an unnatural gap. Each block's "speech expected here" pattern is slid over the real
// voice activity, and the shift is kept only when it is clearly better than leaving it alone.
function localOffsets(F, L) {
  const R = 10, ef = F.envFine, fd = F.fd, thr = F.vthr || 0.3, nS = Math.ceil(F.duration * R) + 1;
  const vad = new Int8Array(nS).fill(-1);
  for (let k = 0; k < nS; k++) {
    const i0 = Math.floor(k / R / fd), i1 = Math.min(ef.length, Math.floor((k + 1) / R / fd));
    let c = 0, m = 0; for (let i = i0; i < i1; i++) { m++; if (ef[i] > thr) c++; }
    if (m && c * 2 >= m) vad[k] = 1;
  }
  const groups = []; let g = [];
  L.forEach((l, i) => {
    const p = L[i - 1];
    const cut = p && (l.ck != null || p.ck != null ? l.ck !== p.ck : (l.s0 - p.e0 < -0.3 || l.s0 - p.e0 > 2.5));
    if (cut && g.length) { groups.push(g); g = []; }
    g.push(i);
  });
  if (g.length) groups.push(g);
  const shift = new Array(L.length).fill(0), MAXD = 10 * R;
  for (const idx of groups) {
    const first = L[idx[0]], last = L[idx[idx.length - 1]];
    let speech = 0; for (const i of idx) speech += L[i].e0 - L[i].s0;
    if (speech < 5) continue;                    // too little to tell where it belongs
    const a = Math.max(0, Math.floor((first.s0 - 2) * R)), b = Math.min(nS, Math.ceil((last.e0 + 2) * R));
    const act = new Int8Array(b - a).fill(-1);
    for (const i of idx) { const l = L[i]; for (let k = Math.round(l.s0 * R); k < Math.round(l.e0 * R); k++) if (k >= a && k < b) act[k - a] = 1; }
    for (const i of idx) { const l = L[i]; for (let k = Math.round((l.s0 - 0.25) * R); k < Math.round((l.s0 + 0.05) * R); k++) if (k >= a && k < b) act[k - a] = -1; }
    let best = 0, bestS = -Infinity, zero = 0;
    for (let D = -MAXD; D <= MAXD; D++) {
      let s = 0; for (let k = 0; k < act.length; k++) { const j = a + k + D; s += act[k] * (j >= 0 && j < nS ? vad[j] : -1); }
      s /= act.length; if (D === 0) zero = s;
      if (s > bestS + 1e-9 || (Math.abs(s - bestS) <= 1e-9 && Math.abs(D) < Math.abs(best))) { bestS = s; best = D; }
    }
    if (bestS - zero >= 0.1 && Math.abs(best) >= 5) for (const i of idx) shift[i] = best / R;
  }
  return shift;
}
function refineTimes() {
  const F = S.feat, L = S.tr.lines; if (!F || !F.envFine || !L.length) return;
  for (const ln of L) if (ln.s0 == null) { ln.s0 = ln.s; ln.e0 = ln.e; }
  const shift = localOffsets(F, L);
  const ef = F.envFine, fd = F.fd, n = ef.length, thr = F.vthr || 0.3, run = Math.max(2, Math.round(0.12 / fd));
  const on = i => i >= 0 && i < n && ef[i] > thr;
  const onset = i => { for (let k = 1; k <= run; k++) if (on(i - k)) return false; for (let k = 0; k < run; k++) if (!on(i + k)) return false; return true; };
  const offset = i => { for (let k = 1; k <= run; k++) if (!on(i - k)) return false; for (let k = 0; k < run; k++) if (on(i + k)) return false; return true; };
  const nearest = (t, test) => { let best = null, bd = 0.8; for (let i = Math.max(0, Math.floor((t - 0.8) / fd)); i <= Math.min(n - 1, Math.ceil((t + 0.8) / fd)); i++) if (test(i)) { const d = Math.abs(i * fd - t); if (d < bd) { bd = d; best = i * fd; } } return best; };
  let prevS = -1;
  L.forEach((ln, i) => {
    const s1 = ln.s0 + shift[i], e1 = ln.e0 + shift[i];
    const a = nearest(s1, onset), b = nearest(e1, offset);
    let s = a != null ? a - 0.08 : s1, e = b != null ? b + 0.1 : e1;
    s = Math.max(s, prevS + 0.1, 0);
    if (e < s + 0.4) e = Math.max(e1, s + 0.4);
    ln.s = s; ln.e = e; ln.shift = shift[i]; prevS = s;
  });
}
// Lexical-cohesion topic change (TextTiling over time) mixed with the acoustic score.
function applyTranscript() {
  const F = S.feat; if (!F) return;
  refineTimes();
  const lines = S.tr.lines, nB = F.nB;
  if (!lines.length) { F.change = F.ac; F.textUntil = 0; F.words = null; return; }
  const vocab = new Map(), wid = w => { let i = vocab.get(w); if (i === undefined) { i = vocab.size; vocab.set(w, i); } return i; };
  const buckets = Array.from({ length: nB }, () => []);
  const words = [];
  for (const ln of lines) {
    const ws = tokens(ln.text);
    ws.forEach((w, i) => { const t = ln.s + (ln.e - ln.s) * (i + 0.5) / ws.length, b = clamp(Math.floor(t), 0, nB - 1), id = wid(w); buckets[b].push(id); words.push({ t, id, w }); });
  }
  const covered = clamp(Math.ceil(S.tr.doneUntil), 0, nB);
  const nDoc = Math.max(1, Math.ceil(covered / 30)), df = new Float32Array(vocab.size);
  for (let d = 0; d < nDoc; d++) { const seen = new Set(); for (let b = d * 30; b < Math.min(covered, d * 30 + 30); b++) for (const w of buckets[b]) seen.add(w); seen.forEach(w => df[w]++); }
  const idf = new Float32Array(vocab.size); for (let w = 0; w < vocab.size; w++) idf[w] = Math.log(1 + nDoc / (1 + df[w])) + 0.1;
  const win = clamp(Math.round(S.gap * 0.8), 15, 60);
  const sim = new Float32Array(nB).fill(NaN);
  for (let b = 1; b < covered; b++) {
    const L = new Map(), R = new Map(); let nl = 0, nr = 0;
    for (let k = Math.max(0, b - win); k < b; k++) for (const w of buckets[k]) { L.set(w, (L.get(w) || 0) + 1); nl++; }
    for (let k = b; k < Math.min(covered, b + win); k++) for (const w of buckets[k]) { R.set(w, (R.get(w) || 0) + 1); nr++; }
    if (nl < 5 || nr < 5) continue;
    let dot = 0, nL = 0, nR = 0;
    for (const [w, c] of L) { const x = c * idf[w]; nL += x * x; const r = R.get(w); if (r) dot += x * r * idf[w]; }
    for (const [w, c] of R) { const x = c * idf[w]; nR += x * x; }
    sim[b] = dot / Math.sqrt(nL * nR || 1);
  }
  // smooth ignoring gaps, then TextTiling depth score
  const ss = new Float32Array(nB).fill(NaN);
  for (let b = 0; b < nB; b++) { let s = 0, c = 0; for (let k = b - 2; k <= b + 2; k++) if (k >= 0 && k < nB && !isNaN(sim[k])) { s += sim[k]; c++; } if (c && !isNaN(sim[b])) ss[b] = s / c; }
  const depth = new Float32Array(nB).fill(NaN);
  for (let b = 0; b < nB; b++) {
    if (isNaN(ss[b])) continue;
    let lm = ss[b], rm = ss[b];
    for (let k = b - 1; k >= Math.max(0, b - win); k--) if (!isNaN(ss[k]) && ss[k] > lm) lm = ss[k];
    for (let k = b + 1; k <= Math.min(nB - 1, b + win); k++) if (!isNaN(ss[k]) && ss[k] > rm) rm = ss[k];
    depth[b] = (lm - ss[b]) + (rm - ss[b]);
  }
  const dp = pctOf(depth, 0.98) || 1;
  const ch = new Float32Array(nB);
  for (let b = 0; b < nB; b++) ch[b] = isNaN(depth[b]) ? F.ac[b] * (b < covered ? 0.6 : 1) : clamp(0.75 * clamp(depth[b] / dp, 0, 1) + 0.25 * F.ac[b], 0, 1);
  F.change = ch; F.textUntil = covered; F.words = words; F.idf = idf; F.win = win;
}
// cosine similarity of the words just before and just after time c (lower = clearer topic change)
function splitSim(F, c) {
  const win = F.win, L = new Map(), R = new Map();
  for (const w of F.words) { if (w.t >= c - win && w.t < c) L.set(w.id, (L.get(w.id) || 0) + 1); else if (w.t >= c && w.t < c + win) R.set(w.id, (R.get(w.id) || 0) + 1); }
  if (L.size < 3 || R.size < 3) return null;
  let dot = 0, nL = 0, nR = 0;
  for (const [w, k] of L) { const x = k * F.idf[w]; nL += x * x; const r = R.get(w); if (r) dot += x * r * F.idf[w]; }
  for (const [w, k] of R) { const x = k * F.idf[w]; nR += x * x; }
  return dot / Math.sqrt(nL * nR || 1);
}
function lineAt(t) { const L = S.tr.lines; let lo = 0, hi = L.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].s <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

/* ---------------- segmentation ---------------- */
function snapCut(F, t) {
  if (t < F.textUntil && S.tr.lines.length && F.words) {
    // among sentence starts near t, cut where the vocabulary changes the most
    let best = null, bs = Infinity, near = null, bd = 7;
    for (const ln of S.tr.lines) {
      if (ln.s < t - 9) continue; if (ln.s > t + 9) break;
      const d = Math.abs(ln.s - t); if (d < bd) { bd = d; near = ln.s; }
      const sim = splitSim(F, ln.s); if (sim == null) continue;
      const score = sim + d * 0.004;
      if (score < bs) { bs = score; best = ln.s; }
    }
    const pick = best ?? near;
    if (pick != null) return Math.max(0, pick - 0.15);
  }
  let best = null, bd = 4;
  for (const p of F.pauses) { if (p.e < t - 5) continue; if (p.s > t + 5) break; const c = Math.max(p.s, p.e - 0.3), d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } }
  return best ?? t;
}
function segmentize(F, G) {
  const sc = F.change, n = sc.length, dur = F.duration, r = Math.max(2, Math.round(G / 3)), cand = [];
  for (let i = 2; i < n - 2; i++) {
    if (sc[i] < 0.2) continue;
    let ok = true;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) if (sc[k] > sc[i] || (sc[k] === sc[i] && k < i)) { ok = false; break; }
    if (ok) cand.push(i);
  }
  cand.sort((a, b) => sc[b] - sc[a]);
  const picked = [];
  for (const c of cand) { if (c < G * 0.4 || c > dur - G * 0.4) continue; if (picked.every(p => Math.abs(p - c) >= G)) picked.push(c); }
  picked.sort((a, b) => a - b);
  const cuts = picked.map(b => ({ t: snapCut(F, b), score: sc[b] }));
  const bounds = [{ t: 0, score: 0 }, ...cuts, { t: dur, score: 0 }];
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i].t, b = bounds[i + 1].t; if (b - a < 1) continue;
    let ex = 0, vo = 0, c = 0;
    for (let k = Math.floor(a); k < Math.min(F.excite.length, Math.ceil(b)); k++) { ex += F.excite[k]; vo += F.voiced[k]; c++; }
    segs.push({ start: a, end: b, change: bounds[i].score, heatRaw: c ? ex / c : 0, talk: c ? vo / c : 0 });
  }
  const hr = rankNorm(Float32Array.from(segs.map(s => s.heatRaw)));
  segs.forEach((s, i) => { s.heat = segs.length > 1 ? hr[i] : 0.5; });
  labelSegs(F, segs);
  return segs;
}
// keywords that are frequent in a section but rare in the others
function labelSegs(F, segs) {
  if (!F.words || !F.words.length) return;
  const per = segs.map(() => new Map()), df = new Map();
  let si = 0;
  for (const w of F.words) { while (si < segs.length - 1 && w.t >= segs[si].end) si++; if (w.t < segs[si].start) continue; const m = per[si]; m.set(w.w, (m.get(w.w) || 0) + 1); }
  per.forEach(m => m.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)));
  const N = segs.length;
  segs.forEach((s, i) => {
    if (s.start >= F.textUntil) return;
    // nouns first: words with kana endings (入れ, 焼き, 新しい) are usually verbs/adjectives
    const scored = [...per[i]].map(([w, c]) => [w, c * Math.log(1 + N / df.get(w)) * (w.length >= 2 ? 1 : 0.35) * (/[぀-ゟ]/.test(w) ? 0.25 : 1)]).sort((a, b) => b[1] - a[1]);
    const picked = [];
    for (const [w] of scored) { if (picked.some(p => p.includes(w) || w.includes(p))) continue; picked.push(w); if (picked.length === 3) break; }
    s.label = picked.join('・');
    const li = S.tr.lines.find(l => l.s >= s.start - 0.5);
    if (li && li.s < s.end) s.snip = li.text;
  });
}
// heat / talk for arbitrary sections
function segStats(F, segs) {
  for (const s of segs) {
    let ex = 0, vo = 0, c = 0;
    for (let k = Math.floor(s.start); k < Math.min(F.excite.length, Math.ceil(s.end)); k++) { ex += F.excite[k]; vo += F.voiced[k]; c++; }
    s.heatRaw = c ? ex / c : 0; s.talk = c ? vo / c : 0; s.change = s.change || 0;
  }
  const hr = rankNorm(Float32Array.from(segs.map(s => s.heatRaw)));
  segs.forEach((s, i) => { s.heat = segs.length > 1 ? hr[i] : 0.5; });
  return segs;
}
// one section per spoken line: transcript sentences, then pause-separated speech where not transcribed yet
function segmentByLine(F) {
  const out = [], cov = F.textUntil || 0;
  for (const ln of S.tr.lines) out.push({ start: ln.s, end: ln.e, label: ln.text, line: true });
  if (cov < F.duration - 1) {
    let t = cov; const runs = [];
    for (const p of F.pauses) {
      if (p.e <= cov || p.e - p.s < 0.5) continue;
      if (p.s > t + 0.3) runs.push({ start: t, end: Math.min(F.duration, p.s + 0.1) });
      t = Math.max(t, p.e - 0.1);
    }
    if (F.duration - t > 0.3) runs.push({ start: t, end: F.duration });
    for (const r of runs) { const last = out[out.length - 1]; if (r.end - r.start < 1 && last && !last.line && r.start - last.end < 1.5) last.end = r.end; else out.push(r); }
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = Math.max(out[i - 1].start + 0.3, out[i].start);
  return segStats(F, out);
}
function segIndexAt(t) {
  const n = S.segs.length; if (!n) return -1;
  const i = S.segs.findIndex(s => t >= s.start && t < s.end);
  return i >= 0 ? i : (t >= S.segs[n - 1].start ? n - 1 : 0);
}
// sentence indices per section
function linesBySeg() {
  const g = S.segs.map(() => []);
  if (g.length) S.tr.lines.forEach((ln, i) => g[segIndexAt(ln.s + 0.3)].push(i));
  return g;
}
function autoGap(dur) { return clamp(Math.round(dur / 12 / 5) * 5, 10, 120); }
function resegment() {
  if (!S.feat) return;
  applyTranscript();
  const before = S.segs.length;
  S.segs = S.segMode === 'line' ? segmentByLine(S.feat) : segmentize(S.feat, S.gap); S.curSeg = -1;
  if (S.segs.length !== before) { S.lineClosed.clear(); S.segOpen.clear(); }
  renderSegs(); renderLines(); onTime(); queueThumbs();
  if (!S.analyzing) setStatus(`<span class="pill">${S.segs.length}区間</span><span>${S.feat.textUntil ? '話の内容と音声で区切りました' : '音声だけで区切りました。文字起こしをすると精度が上がります'}</span>`, null);
}

/* ---------------- sample view ---------------- */
function makeSample() {
  const dur = 1800, nB = dur; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const topics = [0, 170, 410, 640, 905, 1150, 1390, 1600];
  const change = new Float32Array(nB), excite = new Float32Array(nB), voiced = new Float32Array(nB), env = new Float32Array(dur * 4);
  for (let b = 0; b < nB; b++) {
    let c = 0.08 + rnd() * 0.12; for (const t of topics) { if (!t) continue; const d = Math.abs(b - t); if (d < 14) c = Math.max(c, (0.95 - (t % 3) * 0.12) * Math.exp(-d * d / 30)); }
    change[b] = c;
    const hot = (b > 690 && b < 800) || (b > 1420 && b < 1500) ? 0.45 : 0;
    excite[b] = clamp(0.25 + hot + 0.25 * Math.sin(b / 37) * Math.sin(b / 11) + rnd() * 0.15, 0, 1);
    voiced[b] = 0.85;
  }
  for (let i = 0; i < env.length; i++) { const b = Math.floor(i / 4), quiet = topics.some(t => t && Math.abs(b - t) < 2); env[i] = quiet ? 0.05 : clamp(0.35 + excite[b] * 0.45 + (rnd() - 0.5) * 0.35, 0, 1); }
  const F = { duration: dur, nB, ac: change, change, excite: rankNorm(excite), voiced, env, pauses: topics.filter(Boolean).map(t => ({ s: t - 1, e: t + 0.4 })), textUntil: 0 };
  return { F, segs: segmentize(F, 120), clips: [{ start: 700, end: 790 }, { start: 1425, end: 1480 }] };
}
const SAMPLE = makeSample();

/* ---------------- timeline ---------------- */
const COL = {};
(function readColors() { const cs = getComputedStyle(document.documentElement); for (const k of ['bg', 'surface', 'line', 'fg', 'muted', 'dim', 'tape', 'cut', 'heat', 'heat-dim', 'wave', 'seg-a', 'seg-b', 'seg-now', 'raised', 'tape-ink']) COL[k] = cs.getPropertyValue('--' + k).trim(); })();
function curData() { return S.feat ? { F: S.feat, segs: S.segs, clips: S.clips } : SAMPLE; }
let tlRaf = 0;
function drawTL() { if (!tlRaf) tlRaf = requestAnimationFrame(() => { tlRaf = 0; drawTLNow(); }); }
function drawTLNow() {
  const dpr = window.devicePixelRatio || 1, W = tl.clientWidth, H = 128;
  if (!W) return;
  if (tl.width !== Math.round(W * dpr) || tl.height !== Math.round(H * dpr)) { tl.width = Math.round(W * dpr); tl.height = Math.round(H * dpr); }
  const g = tl.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const { F, segs, clips } = curData();
  if (!F) return;
  const dur = F.duration, span = S.feat && S.view.span ? S.view.span : dur, v0 = S.feat ? S.view.start : 0;
  const X = t => (t - v0) / span * W;
  const top = 26, waveH = 50, mid = top + waveH / 2, chTop = top + waveH + 4, chH = 28, clipY = chTop + chH + 6;
  segs.forEach((s, i) => { const a = X(s.start), b = X(s.end); if (b < 0 || a > W) return; g.fillStyle = (S.feat && i === S.curSeg) ? COL['seg-now'] : (i % 2 ? COL['seg-a'] : COL['seg-b']); g.fillRect(a, top - 4, b - a, chTop + chH - top + 4); });
  const steps = [5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const st = steps.find(s => s / span * W >= 64) || 7200;
  g.font = '10px "IBM Plex Mono", monospace'; g.textBaseline = 'top';
  for (let t = Math.ceil(v0 / st) * st; t <= v0 + span; t += st) { const x = X(t); g.fillStyle = COL.line; g.fillRect(Math.round(x), 18, 1, 5); g.fillStyle = COL.dim; if (x > 4 && x < W - 30) g.fillText(fmt(t), x + 3, 16); }
  // transcribed range
  if (S.feat && F.textUntil > 0) { g.fillStyle = COL.tape; g.globalAlpha = 0.5; g.fillRect(Math.max(0, X(0)), 0, Math.max(0, X(Math.min(F.textUntil, dur)) - Math.max(0, X(0))), 2); g.globalAlpha = 1; }
  const env = F.env, ex = F.excite;
  for (let px = 0; px < W; px++) {
    const t0 = v0 + px / W * span, t1 = v0 + (px + 1) / W * span;
    if (t1 < 0 || t0 > dur) continue;
    const i0 = Math.max(0, Math.floor(t0 * 4)), i1 = Math.min(env.length, Math.max(i0 + 1, Math.ceil(t1 * 4)));
    let m = 0; for (let i = i0; i < i1; i++) if (env[i] > m) m = env[i];
    const e = ex[clamp(Math.floor((t0 + t1) / 2), 0, ex.length - 1)] || 0;
    const h = Math.max(0.5, m * waveH / 2);
    g.fillStyle = e > 0.8 ? COL.heat : e > 0.6 ? COL['heat-dim'] : COL.wave;
    g.fillRect(px, mid - h, 1, h * 2);
  }
  const ch = F.change;
  g.beginPath(); g.moveTo(0, chTop + chH);
  for (let px = 0; px <= W; px += 1) {
    const t0 = v0 + px / W * span, t1 = v0 + (px + 1) / W * span;
    const i0 = clamp(Math.floor(t0), 0, ch.length - 1), i1 = clamp(Math.ceil(t1), i0 + 1, ch.length);
    let m = 0; for (let i = i0; i < i1; i++) if (ch[i] > m) m = ch[i];
    g.lineTo(px, chTop + chH - m * chH);
  }
  g.lineTo(W, chTop + chH); g.closePath();
  g.globalAlpha = 0.28; g.fillStyle = COL.cut; g.fill(); g.globalAlpha = 1;
  g.strokeStyle = COL.cut; g.lineWidth = 1; g.stroke();
  g.fillStyle = COL.cut;
  segs.forEach((s, i) => { if (!i) return; const x = X(s.start); if (x < -2 || x > W + 2) return; g.globalAlpha = 0.85; g.fillRect(Math.round(x), top - 4, 1.5, chTop + chH - top + 4); g.beginPath(); g.moveTo(x - 4, top - 6); g.lineTo(x + 4, top - 6); g.lineTo(x, top - 1); g.fill(); g.globalAlpha = 1; });
  g.fillStyle = COL.tape;
  for (const c of clips) { const a = X(c.start), b = X(c.end); if (b < 0 || a > W) continue; g.fillRect(a, clipY, Math.max(2, b - a), 10); }
  if (S.feat && S.pendingIn != null) { const x = X(S.pendingIn); g.fillRect(Math.round(x), top - 4, 2, clipY + 10 - top + 4); }
  // search hits
  if (S.feat && S.query) { g.fillStyle = COL.fg; for (const ln of S.tr.lines) if (ln.text.includes(S.query)) { const x = X(ln.s); if (x >= 0 && x <= W) { g.beginPath(); g.moveTo(x - 4, H); g.lineTo(x + 4, H); g.lineTo(x, H - 7); g.fill(); } } }
  if (S.feat) { const x = X(curT() || 0); g.fillStyle = COL.fg; g.fillRect(Math.round(x) - 1, 14, 2, H - 22); }
}
new ResizeObserver(() => drawTL()).observe(tl);

let drag = null;
tl.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, start: S.view.start, moved: false, id: e.pointerId }; });
tl.addEventListener('pointermove', e => {
  if (!drag || !S.feat) return;
  const dx = e.clientX - drag.x;
  if (!drag.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - drag.y)) { drag.moved = true; try { tl.setPointerCapture(drag.id); } catch (_) {} }
  if (drag.moved && S.view.span < S.feat.duration) { S.view.start = clamp(drag.start - dx / tl.clientWidth * S.view.span, 0, S.feat.duration - S.view.span); S.followOff = Date.now() + 4000; drawTL(); }
});
tl.addEventListener('pointerup', e => {
  if (!drag) return; const d = drag; drag = null;
  if (d.moved || !S.feat) return;
  const r = tl.getBoundingClientRect(); const t = S.view.start + (e.clientX - r.left) / r.width * S.view.span;
  seek(clamp(t, 0, S.duration || S.feat.duration));
});
tl.addEventListener('pointercancel', () => { drag = null; });

function setupZoom() {
  const z = $('#zoom'); z.innerHTML = '';
  if (!S.feat) return;
  const dur = S.feat.duration;
  const opts = [['全体', dur], ['10分', 600], ['3分', 180], ['1分', 60]].filter(([, s], i) => i === 0 || s < dur * 0.8);
  opts.forEach(([lab, span]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = lab; b.setAttribute('aria-pressed', String(Math.abs(S.view.span - span) < 0.5));
    b.onclick = () => { const c = v.currentTime || 0; S.view.span = span; S.view.start = clamp(c - span * 0.3, 0, Math.max(0, dur - span)); z.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); drawTL(); };
    z.appendChild(b);
  });
}

/* ---------------- player ---------------- */
const dur = () => S.duration || (isFinite(v.duration) ? v.duration : 0);
// While a finger is dragging we never stack seeks: at most one waits until the previous one lands.
const SK = { pending: null };
function seekSoft(t, quiet) { t = clamp(t, 0, dur()); if (!quiet) crossBuzz(curT(), t); S.shown = t; if (v.seeking) SK.pending = t; else v.currentTime = t; refreshPlayhead(); }
v.addEventListener('seeked', () => { if (SK.pending != null) { const t = SK.pending; SK.pending = null; v.currentTime = t; } });
function seek(t) { SK.pending = null; S.shown = null; v.currentTime = clamp(t, 0, dur()); refreshPlayhead(); }
function curT() { return S.shown != null ? S.shown : (v.currentTime || 0); }
function updateTC() { $('#tc').textContent = fmtP(curT()); $('#tdur').textContent = fmt(dur()); }
function refreshPlayhead() { updateTC(); updateBar(); updateCaption(curT()); drawTL(); drawStrip(); }

/* captions: updated every frame while playing; offset lets the viewer nudge them (e.g. Bluetooth delay) */
const CAP = { off: 0, last: null };
try { CAP.off = clamp(+localStorage.getItem('kirinuki:capOffset') || 0, -2, 2); } catch (_) {}
function updateCaption(t) {
  const tt = t - CAP.off, li = lineAt(tt), ln = S.tr.lines[li];
  const text = ln && tt >= ln.s - 0.05 && tt < ln.e + 0.3 ? ln.text : '';
  if (text !== CAP.last) { CAP.last = text; $('#cap').firstElementChild.textContent = text; $('#cap').hidden = !text; }
  return li;
}
function renderCapOff() { $('#capOffV').textContent = (CAP.off > 0 ? '+' : CAP.off < 0 ? '−' : '±') + Math.abs(CAP.off).toFixed(1) + '秒'; }
for (const [id, d] of [['#capOffM', -0.1], ['#capOffP', 0.1]]) $(id).onclick = () => {
  CAP.off = Math.round(clamp(CAP.off + d, -2, 2) * 10) / 10;
  try { localStorage.setItem('kirinuki:capOffset', String(CAP.off)); } catch (_) {}
  renderCapOff(); CAP.last = null; updateCaption(curT());
};
renderCapOff();

/* play / pause / fullscreen */
function setPlayIcon() { const b = $('#b-play'); b.innerHTML = v.paused ? ICON.play : ICON.pause; b.setAttribute('aria-label', v.paused ? '再生' : '一時停止'); }
function togglePlay() { if (!S.file) return; if (v.paused) v.play().catch(() => {}); else v.pause(); }
$('#b-play').onclick = togglePlay;
$('#b-fs').innerHTML = ICON.fs;
$('#b-fs').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else { await $('.screen').requestFullscreen(); try { await screen.orientation.lock('landscape'); } catch (_) {} }
  } catch (_) { toast('全画面にできませんでした'); }
};
let playRaf = 0;
function playLoop() { if (playRaf) return; const step = () => { if (v.paused) { playRaf = 0; return; } if (S.stopAt != null && v.currentTime >= S.stopAt) { const t = S.stopAt; S.stopAt = null; v.pause(); v.currentTime = t; playRaf = 0; refreshPlayhead(); return; } updateCaption(v.currentTime); updateTC(); updateBar(); drawStrip(); playRaf = requestAnimationFrame(step); }; playRaf = requestAnimationFrame(step); }
v.addEventListener('play', () => { setPlayIcon(); playLoop(); });
v.addEventListener('pause', setPlayIcon);
setPlayIcon();

/* on-video feedback bubble */
let bubbleT;
function showBubble(main, sub, note) { const b = $('#bubble'); b.innerHTML = `<b>${esc(main)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}${note ? `<small>${esc(note)}</small>` : ''}`; b.hidden = false; clearTimeout(bubbleT); }
function hideBubble(ms = 0) { clearTimeout(bubbleT); bubbleT = setTimeout(() => { $('#bubble').hidden = true; }, ms); }

// Precision by how far the finger has slid vertically (iOS-style scrubbing speeds).
const PREC = [{ f: 1, label: '' }, { f: 0.25, label: '1/4 の速さ' }, { f: 0.06, label: '微調整' }];
const precLevel = dy => { const a = Math.abs(dy); return a < 45 ? 0 : a < 100 ? 1 : 2; };

/* snapping + haptics: handles cling to sentence starts/ends, silences and section boundaries */
const SNAP = { on: true };
try { SNAP.on = localStorage.getItem('kirinuki:snap') !== '0'; } catch (_) {}
function buzz(ms) { if (!SNAP.on) return; try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} }
function renderSnapBtn() { const b = $('#b-snap'); b.setAttribute('aria-pressed', String(SNAP.on)); b.textContent = '吸着 ' + (SNAP.on ? 'ON' : 'OFF'); }
$('#b-snap').onclick = () => {
  SNAP.on = !SNAP.on; try { localStorage.setItem('kirinuki:snap', SNAP.on ? '1' : '0'); } catch (_) {}
  renderSnapBtn(); toast(SNAP.on ? 'つまみが文の切れ目や無音に吸い付き、区間の境目で振動します' : '吸着と振動をオフにしました');
};
renderSnapBtn();
function snapTargets(kind, around, win) {
  const out = [], isIn = kind === 'in', near = t => Math.abs(t - around) <= win;
  for (const l of S.tr.lines) { const t = isIn ? Math.max(0, l.s - 0.15) : l.e + 0.15; if (near(t)) out.push({ t, why: isIn ? '文の頭' : '文の終わり', rank: 0 }); }
  if (S.feat) for (const p of S.feat.pauses) { const t = isIn ? Math.max(p.s, p.e - 0.25) : Math.min(p.e, p.s + 0.2); if (near(t)) out.push({ t, why: '無音', rank: 1 }); }
  for (const s of S.segs) if (s.start > 0 && near(s.start)) out.push({ t: s.start, why: '区間の境目', rank: 0 });
  return out;
}
function nearestSnap(list, t, tol) {
  if (!SNAP.on || !list) return null;
  let best = null, bd = tol;
  for (const x of list) { const d = Math.abs(x.t - t) + x.rank * tol * 0.25; if (d < bd) { bd = d; best = x; } }
  return best;
}
// a small "thump" when the playhead crosses a section boundary (like YouTube chapters)
function crossBuzz(a, b) { if (a === b) return; const lo = Math.min(a, b), hi = Math.max(a, b); for (const s of S.segs) if (s.start > 0 && s.start > lo && s.start <= hi) { buzz(12); return; } }

/* custom seek bar: grab anywhere and slide (no jump on tap) */
const bar = $('#seekbar');
function updateBar() { const d = dur(), p = d ? clamp(curT() / d, 0, 1) : 0; bar.querySelector('.fill').style.width = (p * 100) + '%'; bar.querySelector('.knob').style.left = (p * 100) + '%'; bar.setAttribute('aria-valuenow', String(Math.round(curT()))); bar.setAttribute('aria-valuetext', fmt(curT())); }
let bd = null;
bar.addEventListener('pointerdown', e => { if (!S.file) return; try { bar.setPointerCapture(e.pointerId); } catch (_) {} bd = { x: e.clientX, y: e.clientY, lastX: e.clientX, t: curT(), wasPlaying: !v.paused, moved: false }; bar.classList.add('drag'); });
bar.addEventListener('pointermove', e => {
  if (!bd) return;
  const dx = e.clientX - bd.lastX; bd.lastX = e.clientX;
  if (!bd.moved && Math.abs(e.clientX - bd.x) > 3) { bd.moved = true; v.pause(); }
  if (!bd.moved) return;
  const lv = precLevel(e.clientY - bd.y);
  bd.t = clamp(bd.t + dx * dur() / bar.clientWidth * PREC[lv].f, 0, dur()); seekSoft(bd.t);
  showBubble(fmtP(bd.t), lv ? PREC[lv].label : '', lv ? '' : '指を上下にずらすと細かく動かせます');
});
const endBar = () => { if (!bd) return; const b = bd; bd = null; bar.classList.remove('drag'); hideBubble(300); if (b.moved) { seek(b.t); if (b.wasPlaying) v.play().catch(() => {}); } };
bar.addEventListener('pointerup', endBar); bar.addEventListener('pointercancel', endBar);
bar.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') { e.preventDefault(); seek(curT() - 5); } else if (e.key === 'ArrowRight') { e.preventDefault(); seek(curT() + 5); } });

/* gestures on the video: slide to seek, double-tap the sides for ±5 s, tap to play/pause */
const gest = $('#gest');
let gd = null, lastTap = { time: 0, side: '', count: 0 }, tapTimer = 0;
gest.addEventListener('pointerdown', e => {
  if (!S.file) return;
  const g = gd = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, t0: curT(), t: curT(), wasPlaying: !v.paused, mode: '' };
  // hold still for a moment: play at 2x until the finger lifts
  g.lpTimer = setTimeout(() => {
    if (gd !== g || g.mode) return;
    g.mode = 'fast'; g.wasPaused = v.paused; clearTimeout(tapTimer);
    v.playbackRate = 2; if (v.paused) v.play().catch(() => {});
    showBubble('2倍速', '指を離すと元に戻ります'); buzz(10);
  }, 450);
});
gest.addEventListener('pointermove', e => {
  if (!gd || e.pointerId !== gd.id) return;
  const dx = e.clientX - gd.x, dy = e.clientY - gd.y;
  if (!gd.mode) {
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(gd.lpTimer);
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { gd.mode = 'seek'; try { gest.setPointerCapture(gd.id); } catch (_) {} v.pause(); clearTimeout(tapTimer); }
    else { if (Math.abs(dy) > 12) gd.mode = 'other'; return; }
  }
  if (gd.mode !== 'seek') return;
  const lv = precLevel(dy), step = e.clientX - gd.lastX; gd.lastX = e.clientX;
  const full = clamp(dur(), 10, 90);            // one screen width = 90 s at normal speed
  gd.t = clamp(gd.t + step / gest.clientWidth * full * PREC[lv].f, 0, dur()); seekSoft(gd.t);
  const d = gd.t - gd.t0;
  showBubble((d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '秒', fmtP(gd.t), lv ? PREC[lv].label : '指を下にずらすと細かく');
});
function jumpTap(side, count) {
  seek(curT() + (side === 'l' ? -5 : 5));
  const fx = side === 'l' ? $('#fxL') : $('#fxR');
  fx.textContent = (side === 'l' ? '−' : '+') + (5 * count) + '秒'; fx.classList.add('show');
  clearTimeout(fx._t); fx._t = setTimeout(() => fx.classList.remove('show'), 500);
}
const endGest = e => {
  if (!gd || e.pointerId !== gd.id) return;
  const g = gd; gd = null; clearTimeout(g.lpTimer);
  if (g.mode === 'fast') { v.playbackRate = 1; if (g.wasPaused) v.pause(); hideBubble(200); lastTap = { time: 0, side: '', count: 0 }; return; }
  if (g.mode === 'seek') { seek(g.t); hideBubble(600); if (g.wasPlaying) v.play().catch(() => {}); return; }
  if (g.mode || e.type === 'pointercancel') return;
  const r = gest.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, side = fx < 0.34 ? 'l' : fx > 0.66 ? 'r' : 'c', now = performance.now();
  if (side !== 'c' && side === lastTap.side && now - lastTap.time < 300) { clearTimeout(tapTimer); lastTap.count++; lastTap.time = now; jumpTap(side, lastTap.count); return; }
  lastTap = { time: now, side, count: 0 };
  clearTimeout(tapTimer); tapTimer = setTimeout(togglePlay, 300);
};
gest.addEventListener('pointerup', endGest); gest.addEventListener('pointercancel', endGest);

/* fine nudges */
const nudge = d => () => { if (S.file) seek(curT() + d); };
$('#b-m1').onclick = nudge(-1); $('#b-m01').onclick = nudge(-0.1); $('#b-p01').onclick = nudge(0.1); $('#b-p1').onclick = nudge(1);
document.addEventListener('keydown', e => {
  if (!S.file || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '') || !$('#sheet').hidden) return;
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft' && e.target === document.body) { e.preventDefault(); seek(curT() - (e.shiftKey ? 0.1 : 1)); }
  else if (e.key === 'ArrowRight' && e.target === document.body) { e.preventDefault(); seek(curT() + (e.shiftKey ? 0.1 : 1)); }
  else if (e.key === ',') seek(curT() - 1 / 30);
  else if (e.key === '.') seek(curT() + 1 / 30);
});

/* ---------------- frame grabs (shared by filmstrip and section thumbnails) ---------------- */
let grabChain = Promise.resolve();
function grab(t, w) {
  const tok = S.aToken;
  const p = grabChain.then(async () => {
    if (!thumbV.src || tok !== S.aToken) return null;
    if (thumbV.readyState < 1) await once(thumbV, 'loadedmetadata', 10000);
    if (!thumbV.videoWidth || tok !== S.aToken) return null;
    // wait for the new frame to actually be presented; 'seeked' alone can still hand back the previous frame
    const framed = thumbV.requestVideoFrameCallback ? new Promise(r => { thumbV.requestVideoFrameCallback(() => r(true)); setTimeout(() => r(false), 1500); }) : null;
    thumbV.currentTime = clamp(t, 0, Math.max(0, (thumbV.duration || t + 1) - 0.05));
    if (!(await once(thumbV, 'seeked', 6000)) || tok !== S.aToken) return null;
    if (framed) await framed;
    if (tok !== S.aToken) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = Math.max(1, Math.round(w * thumbV.videoHeight / thumbV.videoWidth));
    c.getContext('2d').drawImage(thumbV, 0, 0, c.width, c.height);
    return c;
  });
  grabChain = p.catch(() => null);
  return p;
}

/* ---------------- filmstrip: fixed center line, drag the frames, pinch to zoom ---------------- */
const strip = $('#strip');
const FS = { span: 20, cache: new Map(), busy: false, raf: 0, lockV0: null, NICE: [0.25, 0.5, 1, 2, 3, 5, 10, 15, 30, 60, 120, 300] };
const tkey = t => Math.round(t * 4) / 4;
function tileDur(W) { const want = FS.span * 72 / Math.max(1, W); return FS.NICE.find(x => x >= want) || 300; }
function tileFor(t, td) {
  const k = tkey(t); if (FS.cache.has(k)) return FS.cache.get(k);
  let best = null, bdist = td * 2.5;
  for (const [kk, img] of FS.cache) { if (!img) continue; const dd = Math.abs(kk - t); if (dd < bdist) { bdist = dd; best = img; } }
  return best;
}
function drawStrip() { if (!FS.raf) FS.raf = requestAnimationFrame(() => { FS.raf = 0; drawStripNow(); }); }
function stripV0() { return FS.lockV0 != null ? FS.lockV0 : curT() - FS.span / 2; }
function drawStripNow() {
  const dpr = window.devicePixelRatio || 1, W = strip.clientWidth, H = 84; if (!W) return;
  if (strip.width !== Math.round(W * dpr) || strip.height !== Math.round(H * dpr)) { strip.width = Math.round(W * dpr); strip.height = Math.round(H * dpr); }
  const g = strip.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  if (!S.file) { g.fillStyle = COL.dim; g.font = '12px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('動画を開くと、ここにコマが並びます', W / 2, H / 2 + 6); g.textAlign = 'left'; return; }
  const span = FS.span, v0 = stripV0(), d = dur(), X = t => (t - v0) / span * W;
  const top = 16, hasVideo = thumbV.videoWidth > 0, thH = hasVideo ? 44 : 0, wTop = top + thH, wH = H - wTop - 6;
  g.fillStyle = COL.bg; if (X(0) > 0) g.fillRect(0, 0, X(0), H); if (X(d) < W) g.fillRect(X(d), 0, W - X(d), H);
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]; const st = steps.find(s => s / span * W >= 60) || 1200;
  g.font = '10px "IBM Plex Mono", monospace'; g.textBaseline = 'top';
  for (let t = Math.ceil(Math.max(0, v0) / st) * st; t <= Math.min(d, v0 + span); t += st) { const x = X(t); g.fillStyle = COL.line; g.fillRect(Math.round(x), 11, 1, 5); g.fillStyle = COL.dim; if (x < W - 40) g.fillText(st < 1 ? fmtP(t) : fmt(t), x + 3, 2); }
  if (hasVideo) {
    const td = tileDur(W);
    for (let k = Math.floor(Math.max(0, v0) / td); k * td < Math.min(d, v0 + span); k++) {
      const t = k * td, x = X(t), w = Math.ceil(td / span * W) + 1, img = tileFor(t, td);
      if (img) {
        const ar = img.width / img.height, tr = w / thH; let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (tr > ar) { sh = img.width / tr; sy = (img.height - sh) / 2; } else { sw = img.height * tr; sx = (img.width - sw) / 2; }
        g.drawImage(img, sx, sy, sw, sh, x, top, w, thH);
      } else { g.fillStyle = COL.raised; g.fillRect(x, top, w, thH); }
      g.fillStyle = COL.bg; g.fillRect(Math.round(x), top, 1, thH);
    }
    queueTiles();
  }
  const F = S.feat;
  if (F && F.envFine) {
    const ef = F.envFine, fd = F.fd; g.fillStyle = COL.wave;
    for (let px = 0; px < W; px++) {
      const t0 = v0 + px / W * span, t1 = v0 + (px + 1) / W * span; if (t1 < 0 || t0 > d) continue;
      const i0 = Math.max(0, Math.floor(t0 / fd)), i1 = Math.min(ef.length, Math.max(i0 + 1, Math.ceil(t1 / fd)));
      let m = 0; for (let i = i0; i < i1; i++) if (ef[i] > m) m = ef[i];
      const h = Math.max(1, m * wH); g.fillRect(px, wTop + 2 + wH - h, 1, h);
    }
  }
  if (S.tr.lines.length && span <= 120) {
    g.fillStyle = COL.muted;
    for (const l of S.tr.lines) { const x = X(l.s); if (x < -4 || x > W + 4) continue; g.beginPath(); g.moveTo(x - 3, wTop); g.lineTo(x + 3, wTop); g.lineTo(x, wTop + 4); g.fill(); }
  }
  g.fillStyle = COL.cut; for (const s of S.segs) { if (!s.start) continue; const x = X(s.start); if (x >= 0 && x <= W) g.fillRect(Math.round(x), top, 1.5, H - top); }
  for (const cl of S.clips) {
    const a = X(cl.start), b = X(cl.end); if (b < -12 || a > W + 12) continue;
    const sel = cl.id === S.editId, hw = sel ? 12 : 7;
    g.fillStyle = COL.tape; g.globalAlpha = sel ? 0.22 : 0.12; g.fillRect(a, top, b - a, H - top); g.globalAlpha = 1;
    g.fillRect(a, H - 4, b - a, 4);
    g.fillRect(a, top, hw, H - top); g.fillRect(b - hw, top, hw, H - top);
    if (sel) { g.fillStyle = COL['tape-ink']; for (const gx of [a + hw / 2, b - hw / 2]) for (let i = -1; i <= 1; i++) g.fillRect(gx - 1, (top + H) / 2 + i * 6 - 1, 2, 2); }
  }
  if (sd && sd.mode === 'handle' && sd.snap) { const x = Math.round(X(sd.snap.t)); g.fillStyle = COL.cut; g.fillRect(x - 1, 0, 2, H); }
  const px = Math.round(X(curT()));
  g.fillStyle = COL.fg; g.fillRect(px - 1, top - 3, 2, H - top + 3);
  g.beginPath(); g.moveTo(px - 5, top - 7); g.lineTo(px + 5, top - 7); g.lineTo(px, top - 1); g.fill();
}
async function queueTiles() {
  if (FS.busy || S.exporting) return;
  FS.busy = true; const tok = S.aToken;
  try {
    for (;;) {
      if (tok !== S.aToken || S.exporting) break;
      const W = strip.clientWidth, td = tileDur(W), c = curT(), v0 = c - FS.span / 2, d = dur(), want = [];
      for (let k = Math.floor(Math.max(0, v0 - FS.span * 0.3) / td); k * td < Math.min(d, v0 + FS.span * 1.3); k++) want.push(k * td);
      want.sort((a, b) => Math.abs(a - c) - Math.abs(b - c));
      const next = want.find(t => !FS.cache.has(tkey(t)));
      if (next == null) break;
      const img = await grab(next + Math.min(td / 2, 0.1), 160);
      if (tok !== S.aToken) break;
      FS.cache.set(tkey(next), img);
      if (FS.cache.size > 900) FS.cache.delete(FS.cache.keys().next().value);
      drawStrip();
    }
  } finally { FS.busy = false; }
}
function stripHint() { $('#stripHint').textContent = '表示幅 ' + (FS.span < 60 ? Math.round(FS.span) + '秒' : fmt(FS.span)) + '・2本指で拡大'; }
const sp = new Map(); let sd = null;
strip.addEventListener('pointerdown', e => {
  if (!S.file) return;
  try { strip.setPointerCapture(e.pointerId); } catch (_) {}
  sp.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (sp.size === 2) { const [a, b] = [...sp.values()]; if (sd && sd.mode === 'handle' && sd.moved) afterClips(); FS.lockV0 = null; sd = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), span: FS.span }; return; }
  if (sp.size > 2) return;
  const r = strip.getBoundingClientRect(), x = e.clientX - r.left, v0 = stripV0(), X = t => (t - v0) / FS.span * r.width;
  let hit = null, hd = 22;
  for (const cl of S.clips) for (const kind of ['in', 'out']) { const hx = X(kind === 'in' ? cl.start : cl.end) + (kind === 'in' ? 4 : -4); const dd = Math.abs(hx - x) - (cl.id === S.editId ? 8 : 0); if (dd < hd) { hd = dd; hit = { cl, kind }; } }
  sd = { mode: hit ? 'handle' : 'scrub', hit, x: e.clientX, y: e.clientY, lastX: e.clientX, t: curT(), wasPlaying: !v.paused, moved: false };
  if (hit) {
    FS.lockV0 = v0; sd.raw = hit.kind === 'in' ? hit.cl.start : hit.cl.end; sd.snap = null;
    sd.targets = snapTargets(hit.kind, sd.raw, Math.max(FS.span, 30));
    if (S.editId !== hit.cl.id) { S.editId = hit.cl.id; renderClips(); }
  }
  v.pause();
});
strip.addEventListener('pointermove', e => {
  if (!sp.has(e.pointerId)) return;
  sp.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!sd) return;
  if (sd.mode === 'pinch') {
    if (sp.size < 2) return;
    const [a, b] = [...sp.values()], dist = Math.hypot(a.x - b.x, a.y - b.y);
    FS.span = clamp(sd.span * sd.dist / Math.max(20, dist), 3, Math.max(30, Math.min(600, dur())));
    stripHint(); drawStrip(); return;
  }
  const dx = e.clientX - sd.lastX; sd.lastX = e.clientX;
  if (!sd.moved && Math.abs(e.clientX - sd.x) > 3) sd.moved = true;
  if (!sd.moved) return;
  const lv = precLevel(e.clientY - sd.y), spp = FS.span / strip.clientWidth * PREC[lv].f;
  if (sd.mode === 'scrub') { sd.t = clamp(sd.t - dx * spp, 0, dur()); seekSoft(sd.t); if (lv) showBubble(fmtP(sd.t), PREC[lv].label); }
  else {
    const cl = sd.hit.cl, isIn = sd.hit.kind === 'in';
    sd.raw += dx * spp;
    // fine mode (finger slid down) never snaps, so exact positions stay reachable
    const sn = lv ? null : nearestSnap(sd.targets, sd.raw, 10 * FS.span / strip.clientWidth);
    const t = sn ? sn.t : sd.raw;
    if (isIn) cl.start = clamp(t, 0, cl.end - 0.3); else cl.end = clamp(t, cl.start + 0.3, dur());
    if (sn && sn !== sd.snap) buzz(8);
    sd.snap = sn;
    seekSoft(isIn ? cl.start : cl.end, true);
    showBubble((isIn ? 'IN ' : 'OUT ') + fmtP(isIn ? cl.start : cl.end), sn ? sn.why + 'に吸着' : (lv ? PREC[lv].label + '（吸着なし）' : ''), sn || lv ? '' : '指を上下にずらすと細かく');
  }
});
const endStrip = e => {
  sp.delete(e.pointerId);
  if (!sd) return;
  if (sd.mode === 'pinch') { if (sp.size === 0) sd = null; return; }
  const s = sd; sd = null; FS.lockV0 = null; hideBubble(400);
  if (e.type === 'pointercancel') { drawStrip(); return; }
  if (s.mode === 'handle') { const t = s.hit.kind === 'in' ? s.hit.cl.start : s.hit.cl.end; if (s.moved) afterClips(); else renderClips(); seek(t); }
  else if (s.moved) { seek(s.t); if (s.wasPlaying) v.play().catch(() => {}); }
  else {
    const r = strip.getBoundingClientRect(), t = clamp(stripV0() + (e.clientX - r.left) / r.width * FS.span, 0, dur());
    const cl = S.clips.find(c => t >= c.start && t <= c.end); if (cl && cl.id !== S.editId) { S.editId = cl.id; renderClips(); }
    seek(t); if (s.wasPlaying) v.play().catch(() => {});
  }
  drawStrip();
};
strip.addEventListener('pointerup', endStrip); strip.addEventListener('pointercancel', endStrip);
strip.addEventListener('wheel', e => { if (!S.file) return; e.preventDefault(); FS.span = clamp(FS.span * Math.pow(1.0015, e.deltaY), 3, Math.max(30, Math.min(600, dur()))); stripHint(); drawStrip(); }, { passive: false });
new ResizeObserver(() => drawStrip()).observe(strip);
stripHint();
$('#b-in').onclick = () => { if (!S.file) return; S.pendingIn = v.currentTime; renderInChip(); drawTL(); };
$('#b-out').onclick = () => {
  if (!S.file) return;
  if (S.pendingIn == null) { toast('先に IN を押して開始位置を決めてください'); return; }
  const a = S.pendingIn, b = v.currentTime;
  if (b - a < 0.5) { toast('OUT は IN より後ろの位置で押してください'); return; }
  S.pendingIn = null; renderInChip(); addClip(a, b);
};
function renderInChip() {
  const c = $('#inchip'), bin = $('#b-in');
  bin.classList.toggle('armed', S.pendingIn != null);
  if (S.pendingIn == null) { c.hidden = true; return; }
  c.hidden = false; c.innerHTML = '';
  const s = document.createElement('span'); s.className = 'tc'; s.textContent = 'IN ' + fmtP(S.pendingIn) + ' — 終わりたい所で OUT';
  const x = document.createElement('button'); x.type = 'button'; x.textContent = '取り消す'; x.onclick = () => { S.pendingIn = null; renderInChip(); drawTL(); };
  c.append(s, x);
}
v.addEventListener('timeupdate', onTime);
v.addEventListener('seeked', onTime);
v.addEventListener('pause', () => { if (S.skim && !S.skim.jumping) stopSkim(); });
function onTime() {
  const t = v.currentTime;
  if (S.stopAt != null && t >= S.stopAt) { S.stopAt = null; v.pause(); }
  if (S.skim && t >= S.skim.until) { S.skim.i++; skimGo(); }
  if (S.feat && S.view.span < S.feat.duration && !v.paused && !(S.followOff > Date.now())) {
    if (t < S.view.start || t > S.view.start + S.view.span * 0.92) S.view.start = clamp(t - S.view.span * 0.1, 0, S.feat.duration - S.view.span);
  }
  const i = S.segs.findIndex(s => t >= s.start && t < s.end);
  if (i !== S.curSeg) {
    const old = $('#segList li.now'); if (old) old.classList.remove('now');
    S.curSeg = i; const li = $(`#segList li[data-i="${i}"]`); if (li) li.classList.add('now');
  }
  // caption + transcript highlight
  const li = updateCaption(t);
  if (li !== S.curLine) {
    const o = $('#lineList li.now'); if (o) o.classList.remove('now');
    S.curLine = li; const n = $(`#lineList li[data-i="${li}"]`); if (n) n.classList.add('now');
  }
  updateTC(); updateBar(); drawTL(); drawStrip();
}
function startSkim() { if (!S.segs.length) return; S.skim = { i: Math.max(0, S.curSeg), until: 0 }; skimGo(); }
function skimGo() {
  const s = S.segs[S.skim?.i];
  if (!s) { stopSkim(); return; }
  S.stopAt = null; S.skim.jumping = true; S.skim.until = s.start + Math.min(8, s.end - s.start - 0.1);
  v.currentTime = s.start; v.play().catch(() => {}).finally(() => { if (S.skim) S.skim.jumping = false; });
  $('#b-skim').textContent = '流し見を止める';
  const li = $(`#segList li[data-i="${S.skim.i}"]`); if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function stopSkim() { if (!S.skim) return; S.skim = null; $('#b-skim').textContent = '冒頭だけ流し見'; }
$('#b-skim').onclick = () => { if (S.skim) { stopSkim(); v.pause(); } else startSkim(); };

/* ---------------- tabs ---------------- */
const TABS = [['segs', '#panel-segs'], ['text', '#panel-text'], ['clips', '#panel-clips']];
function setTab(t) { for (const [id, p] of TABS) { $('#tab-' + id).setAttribute('aria-selected', String(t === id)); $(p).hidden = t !== id; } }
for (const [id] of TABS) $('#tab-' + id).onclick = () => setTab(id);

/* ---------------- sections list ---------------- */
function clipFor(s) { return S.clips.find(c => Math.abs(c.start - s.start) < 0.05 && Math.abs(c.end - s.end) < 0.05); }
function renderSegs() {
  const ul = $('#segList'); ul.innerHTML = '';
  $('#nSegs').textContent = S.segs.length;
  $('#segEmpty').hidden = !!S.segs.length;
  $('#segTools').hidden = !S.feat;
  const lineMode = S.segMode === 'line';
  ul.classList.toggle('linemode', lineMode);
  for (const b of document.querySelectorAll('#segMode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === S.segMode));
  $('#gapRow').hidden = lineMode; $('#lineModeNote').hidden = !lineMode;
  wantThumb.clear(); thumbIO.disconnect();
  const frag = document.createDocumentFragment(), byseg = lineMode ? [] : linesBySeg();
  S.segs.forEach((s, i) => {
    const li = document.createElement('li'); li.className = 'seg' + (i === S.curSeg ? ' now' : ''); li.dataset.i = i;
    const mine = byseg[i] || [], open = S.segOpen.has(i) && mine.length > 0;
    s.thumbKey = thumbKeyOf(s);
    const textBtn = mine.length ? `<button class="segtext-btn" type="button" data-act="text" aria-expanded="${open}">${open ? '▴ 文字を閉じる' : '▾ 文字を見る'}（${mine.length}文）</button>` : '';
    const textBox = open ? `<div class="segtext">${mine.map(k => { const l = S.tr.lines[k]; return `<p data-t="${l.s}"><span class="tc">${fmt(l.s)}</span><span>${esc(l.text)}</span></p>`; }).join('')}<div class="segtext-acts"><button type="button" data-act="copy">この区間の文章をコピー</button></div></div>` : '';
    const badges = [];
    if (s.heat >= 0.8 && S.segs.length >= 3) badges.push('<span class="badge heat">盛り上がり</span>');
    if (i > 0 && s.change >= 0.75) badges.push('<span class="badge cut">話題が大きく変化</span>');
    if (s.talk < 0.35) badges.push('<span class="badge">静か</span>');
    const th = S.thumbs.get(s.thumbKey);
    const on = !!clipFor(s);
    li.innerHTML = `
      <button class="thumb" type="button" data-act="seek" aria-label="${fmt(s.start)}へ移動">${th ? `<img alt="" src="${th}">` : '<img alt="">'}<span class="dur tc">${fmt(s.end - s.start)}</span></button>
      <div class="meta">
        <div class="when tc">${fmt(s.start)} → ${fmt(s.end)}</div>
        ${s.label ? `<div class="label">${esc(s.label)}</div>` : ''}
        ${s.snip ? `<div class="snip">${esc(s.snip)}</div>` : ''}
        ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
        <div class="meters"><span>熱量</span><span class="meter heat" style="--v:${s.heat.toFixed(2)}"><i></i></span><span>変化</span><span class="meter cut" style="--v:${(i ? s.change : 0).toFixed(2)}"><i></i></span></div>
        ${textBtn}
      </div>
      <div class="acts">
        <button class="ibtn" type="button" data-act="play" aria-label="この区間を再生">${ICON.play}</button>
        <button class="ibtn ${on ? 'on' : ''}" type="button" data-act="add" aria-label="${on ? '切り抜きから外す' : '切り抜きに追加'}">${on ? ICON.check : ICON.plus}</button>
      </div>
      ${textBox}`;
    frag.appendChild(li);
  });
  ul.appendChild(frag);
  for (const li of ul.children) thumbIO.observe(li);
}
$('#segMode').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]'); if (!b || b.dataset.mode === S.segMode) return;
  S.segMode = b.dataset.mode; try { localStorage.setItem('kirinuki:segMode', S.segMode); } catch (_) {}
  stopSkim(); resegment();
  if (S.segMode === 'line' && !S.tr.lines.length) toast('文字起こしをすると1文ずつに分かれます。今は話の途切れで区切っています');
});
$('#segList').addEventListener('click', e => {
  const p = e.target.closest('.segtext p[data-t]'); if (p) { stopSkim(); seek(+p.dataset.t); return; }
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const i = +btn.closest('li').dataset.i, s = S.segs[i]; if (!s) return;
  const act = btn.dataset.act;
  if (act === 'text') { if (S.segOpen.has(i)) S.segOpen.delete(i); else S.segOpen.add(i); renderSegs(); return; }
  if (act === 'copy') {
    const text = (linesBySeg()[i] || []).map(k => S.tr.lines[k].text).join('\n');
    const done = () => toast('区間' + (i + 1) + 'の文章をコピーしました');
    const fallback = () => { const box = btn.closest('.segtext'); const r = document.createRange(); r.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('文章を選択しました。長押しでコピーしてください'); };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (_) { fallback(); }
    return;
  }
  if (act === 'seek') { stopSkim(); seek(s.start + 0.01); }
  else if (act === 'play') { stopSkim(); S.stopAt = s.end; v.currentTime = s.start + 0.01; v.play().catch(() => {}); }
  else if (act === 'add') { const c = clipFor(s); if (c) removeClip(c.id); else addClip(s.start, s.end); }
});

/* ---------------- transcript list + search ---------------- */
function renderLines() {
  const ul = $('#lineList'), L = S.tr.lines, q = S.query;
  $('#nLines').textContent = L.length;
  $('#lineEmpty').hidden = !!L.length;
  ul.innerHTML = '';
  const frag = document.createDocumentFragment(); let hits = 0;
  // sentences grouped under the section they start in
  const flat = !S.segs.length || S.segMode === 'line';
  const groups = flat ? [L.map((_, i) => i)] : linesBySeg();
  groups.forEach((idx, k) => {
    const shown = q ? idx.filter(i => L[i].text.includes(q)) : idx;
    if (!shown.length) return;
    hits += q ? shown.length : 0;
    const s = flat ? null : S.segs[k];
    if (s) {
      const closed = !q && S.lineClosed.has(k), on = !!clipFor(s);
      const h = document.createElement('li'); h.className = 'lhead' + (closed ? ' closed' : ''); h.dataset.seg = k;
      h.innerHTML = `
        <button class="lhead-main" type="button" data-hact="toggle" aria-expanded="${!closed}">
          <span class="chev" aria-hidden="true">▾</span>
          <span class="lhead-txt"><span class="tc">区間${k + 1}・${fmt(s.start)}–${fmt(s.end)}・${idx.length}文</span>${s.label ? `<b>${esc(s.label)}</b>` : ''}</span>
        </button>
        <button class="ibtn" type="button" data-hact="play" aria-label="区間${k + 1}を再生">${ICON.play}</button>
        <button class="ibtn ${on ? 'on' : ''}" type="button" data-hact="add" aria-label="${on ? '切り抜きから外す' : '区間を切り抜きに追加'}">${on ? ICON.check : ICON.plus}</button>`;
      frag.appendChild(h);
      if (closed) return;
    }
    for (const i of shown) {
      const ln = L[i];
      const inClip = S.clips.some(c => ln.s < c.end - 0.2 && ln.e > c.start + 0.2), picked = S.pick && S.pick.a === i;
      const li = document.createElement('li'); li.className = 'line' + (i === S.curLine ? ' now' : '') + (inClip ? ' inclip' : '') + (picked ? ' pick' : ''); li.dataset.i = i;
      const txt = q ? esc(ln.text).split(esc(q)).join(`<mark>${esc(q)}</mark>`) : esc(ln.text);
      li.innerHTML = `<span class="tc">${fmt(ln.s)}</span><span>${txt}</span>`;
      frag.appendChild(li);
    }
  });
  ul.appendChild(frag);
  $('#b-fold').hidden = !L.length || S.segs.length < 2 || !!q || flat;
  $('#b-fold').textContent = S.lineClosed.size >= S.segs.length ? 'すべて開く' : 'すべて閉じる';
  if (q) { $('#lineEmpty').hidden = hits > 0; if (!hits) $('#lineEmpty').textContent = `「${q}」は見つかりませんでした。`; }
  else $('#lineEmpty').textContent = '文字起こしをすると、ここに話した内容が時刻つきで並びます。言葉で検索して、その場面に飛べます。';
  renderPick(); drawTL();
}
/* make a clip from sentences: tap the first and the last sentence (or long-press to start) */
// after a long-press, ignore the click that the same finger produces when it lifts
let lpFired = false, suppressUntil = 0, lp = null;
function renderPick() {
  const n = $('#pickNote'), b = $('#b-pick');
  $('#lineList').classList.toggle('picking', !!S.pick);
  b.textContent = S.pick ? 'やめる' : '文章で切り抜く';
  b.disabled = !S.tr.lines.length;
  if (!S.pick) { n.hidden = true; return; }
  n.hidden = false; n.innerHTML = '';
  const s = document.createElement('span');
  s.textContent = S.pick.a == null ? '切り抜きの最初の文をタップしてください' : '最後の文をタップすると切り抜きになります（同じ文をもう一度タップすると1文だけ）';
  const x = document.createElement('button'); x.type = 'button'; x.textContent = '取り消す'; x.onclick = () => { S.pick = null; renderPick(); renderLines(); };
  n.append(s, x);
}
function pickLine(i) {
  const L = S.tr.lines; if (!L[i]) return;
  if (!S.pick) S.pick = { a: null };
  if (S.pick.a == null) { S.pick.a = i; buzz(8); seek(L[i].s); renderPick(); renderLines(); return; }
  const a = Math.min(S.pick.a, i), b = Math.max(S.pick.a, i);
  const s = Math.max(0, L[a].s - 0.15), e = Math.min(dur(), L[b].e + 0.15);
  S.pick = null; renderPick();
  addClip(s, e); renderLines(); seek(s); buzz(15);
}
$('#b-fold').onclick = () => {
  if (S.lineClosed.size >= S.segs.length) S.lineClosed.clear(); else S.segs.forEach((_, k) => S.lineClosed.add(k));
  renderLines();
};
$('#b-pick').onclick = () => { S.pick = S.pick ? null : { a: null }; renderPick(); renderLines(); };
$('#lineList').addEventListener('click', e => {
  if (performance.now() < suppressUntil) return;
  const hb = e.target.closest('[data-hact]');
  if (hb) {
    const k = +hb.closest('li').dataset.seg, s = S.segs[k]; if (!s) return;
    const a = hb.dataset.hact;
    if (a === 'toggle') { if (S.lineClosed.has(k)) S.lineClosed.delete(k); else S.lineClosed.add(k); renderLines(); }
    else if (a === 'play') { stopSkim(); S.stopAt = s.end; v.currentTime = s.start + 0.01; v.play().catch(() => {}); }
    else if (a === 'add') { const c = clipFor(s); if (c) removeClip(c.id); else addClip(s.start, s.end); }
    return;
  }
  const li = e.target.closest('li[data-i]'); if (!li) return;
  const i = +li.dataset.i, ln = S.tr.lines[i]; if (!ln) return;
  if (S.pick) { pickLine(i); return; }
  stopSkim(); seek(ln.s);
});
$('#lineList').addEventListener('pointerdown', e => {
  lpFired = false;
  const li = e.target.closest('li[data-i]'); if (!li) return;
  clearTimeout(lp?.timer);
  lp = { x: e.clientX, y: e.clientY, timer: setTimeout(() => { lp = null; lpFired = true; pickLine(+li.dataset.i); }, 500) };
});
$('#lineList').addEventListener('pointermove', e => { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) { clearTimeout(lp.timer); lp = null; } });
for (const ev of ['pointerup', 'pointercancel']) $('#lineList').addEventListener(ev, () => {
  if (lp) { clearTimeout(lp.timer); lp = null; }
  if (lpFired) { lpFired = false; suppressUntil = performance.now() + 400; }
});
$('#lineList').addEventListener('contextmenu', e => e.preventDefault());
let qT; $('#q').addEventListener('input', e => { clearTimeout(qT); qT = setTimeout(() => { S.query = e.target.value.trim(); renderLines(); }, 200); });

/* ---------------- clips ---------------- */
function storeKey() { return S.file ? 'kirinuki:v1:' + fileKey() : null; }
function saveProject() { const k = storeKey(); if (!k) return; try { localStorage.setItem(k, JSON.stringify({ clips: S.clips.map(({ start, end }) => ({ start, end })), gap: S.gapAuto ? null : S.gap })); } catch (_) {} }
function loadProject() { const k = storeKey(); try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }
function addClip(a, b) {
  const c = { id: S.nextId++, start: a, end: b };
  const at = S.clips.findIndex(x => x.start > a);
  if (at < 0) S.clips.push(c); else S.clips.splice(at, 0, c);
  S.editId = c.id;
  afterClips(); toast('切り抜きに追加しました（' + fmt(b - a) + '）');
}
function removeClip(id) { S.clips = S.clips.filter(c => c.id !== id); if (S.editId === id) S.editId = null; afterClips(); }
function afterClips() { saveProject(); renderClips(); renderSegs(); renderLines(); drawStrip(); }
function renderClips() {
  const ul = $('#clipList'); ul.innerHTML = '';
  const total = S.clips.reduce((a, c) => a + c.end - c.start, 0);
  $('#nClips').textContent = S.clips.length;
  $('#clipSum').textContent = S.clips.length ? `${S.clips.length}本・合計 ${fmt(total)}` : '0本';
  $('#clipEmpty').hidden = !!S.clips.length;
  $('#b-export').disabled = !S.clips.length;
  S.clips.forEach((c, i) => {
    const sel = c.id === S.editId;
    const li = document.createElement('li'); li.className = 'clip' + (sel ? ' sel' : ''); li.dataset.id = c.id;
    const row = k => `<span class="lab">${k === 'in' ? 'IN' : 'OUT'}</span><div class="ctrl"><button type="button" data-act="${k}-1">−1秒</button><button type="button" data-act="${k}-01">−0.1</button><button type="button" data-act="${k}-now">今</button><button type="button" data-act="${k}+01">+0.1</button><button type="button" data-act="${k}+1">+1秒</button></div>`;
    li.innerHTML = `
      <div class="row1">
        <span class="no">${String(i + 1).padStart(2, '0')}</span>
        <span class="range tc">${fmtP(c.start)} → ${fmtP(c.end)}<small>${fmt(c.end - c.start)}</small></span>
        <button class="ibtn" type="button" data-act="play" aria-label="プレビュー">${ICON.play}</button>
        <button class="ibtn" type="button" data-act="up" aria-label="前へ" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button class="ibtn" type="button" data-act="down" aria-label="後ろへ" ${i === S.clips.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
        <button class="ibtn" type="button" data-act="del" aria-label="削除">${ICON.x}</button>
      </div>
      ${sel ? '<div class="selnote">編集中：上の帯にある黄色いつまみをドラッグしても調整できます</div>' : ''}
      <div class="trim">${row('in')}${row('out')}</div>
      <div class="edge"><button type="button" data-act="pv-in">▶ 始まり3秒を確認</button><button type="button" data-act="pv-out">▶ 終わり3秒を確認</button></div>`;
    ul.appendChild(li);
  });
}
$('#clipList').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  const id = +li.dataset.id, i = S.clips.findIndex(c => c.id === id), c = S.clips[i]; if (!c) return;
  const btn = e.target.closest('button[data-act]');
  if (!btn) { if (S.editId !== id) { S.editId = id; renderClips(); } seek(c.start); return; }
  const wasSel = S.editId === id; S.editId = id;
  const act = btn.dataset.act, D = dur() || Infinity, now = curT();
  const setIn = t => { c.start = clamp(t, 0, c.end - 0.3); seek(c.start); };
  const setOut = t => { c.end = clamp(t, c.start + 0.3, D); seek(c.end); };
  switch (act) {
    case 'play': stopSkim(); S.stopAt = c.end; v.currentTime = c.start; v.play().catch(() => {}); if (!wasSel) renderClips(); drawStrip(); return;
    case 'pv-in': stopSkim(); S.stopAt = Math.min(c.end, c.start + 3); v.currentTime = c.start; v.play().catch(() => {}); if (!wasSel) renderClips(); return;
    case 'pv-out': stopSkim(); S.stopAt = c.end; v.currentTime = Math.max(c.start, c.end - 3); v.play().catch(() => {}); if (!wasSel) renderClips(); return;
    case 'in-01': setIn(c.start - 0.1); break;
    case 'in+01': setIn(c.start + 0.1); break;
    case 'out-01': setOut(c.end - 0.1); break;
    case 'out+01': setOut(c.end + 0.1); break;
    case 'up': if (i > 0) [S.clips[i - 1], S.clips[i]] = [S.clips[i], S.clips[i - 1]]; break;
    case 'down': if (i < S.clips.length - 1) [S.clips[i + 1], S.clips[i]] = [S.clips[i], S.clips[i + 1]]; break;
    case 'del': removeClip(id); toast('切り抜きを削除しました'); return;
    case 'in-1': setIn(c.start - 1); break;
    case 'in+1': setIn(c.start + 1); break;
    case 'in-now': if (now >= c.end - 0.5) { toast('IN は OUT より前の位置にしてください'); return; } setIn(now); break;
    case 'out-1': setOut(c.end - 1); break;
    case 'out+1': setOut(c.end + 1); break;
    case 'out-now': if (now <= c.start + 0.5) { toast('OUT は IN より後ろの位置にしてください'); return; } setOut(now); break;
  }
  afterClips();
});

/* ---------------- granularity ---------------- */
let gapT;
$('#gap').addEventListener('input', e => {
  S.gap = +e.target.value; S.gapAuto = false; $('#gapv').textContent = S.gap + '秒';
  clearTimeout(gapT); gapT = setTimeout(() => { resegment(); saveProject(); }, 120);
});

/* ---------------- thumbnails: only for cards on (or near) the screen ---------------- */
const thumbTimeOf = s => Math.max(s.start, Math.min(s.end - 0.2, s.start + Math.min(4, (s.end - s.start) / 3)));
const thumbKeyOf = s => Math.round(thumbTimeOf(s) * 2) / 2;
const wantThumb = new Set();
const thumbIO = new IntersectionObserver(entries => {
  for (const en of entries) { const i = +en.target.dataset.i; if (en.isIntersecting) wantThumb.add(i); else wantThumb.delete(i); }
  kickThumbs();
}, { rootMargin: '600px 0px' });
let thumbBusy = false;
function queueThumbs() { for (const li of document.querySelectorAll('#segList li.seg')) thumbIO.observe(li); kickThumbs(); }
async function kickThumbs() {
  if (thumbBusy) return; thumbBusy = true;
  try {
    while (wantThumb.size && !S.exporting) {
      const i = wantThumb.values().next().value; wantThumb.delete(i);
      const s = S.segs[i]; if (!s) continue;
      const key = thumbKeyOf(s);
      if (!S.thumbs.has(key)) {
        const c = await grab(thumbTimeOf(s), 224);
        if (!c) { if (!thumbV.videoWidth) { wantThumb.clear(); break; } continue; }
        try { S.thumbs.set(key, c.toDataURL('image/jpeg', 0.7)); } catch (_) { continue; }
      }
      const img = $(`#segList li[data-i="${i}"] img`); if (img && S.segs[i] === s) img.src = S.thumbs.get(key);
    }
  } finally { thumbBusy = false; }
}

/* ---------------- open + analyse ---------------- */
$('#file').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
function setStatus(html, prog) {
  $('#tlStatus').innerHTML = html;
  const p = $('#prog'); p.hidden = prog == null; if (prog != null) p.firstElementChild.style.width = (prog * 100).toFixed(1) + '%';
}
async function loadFile(file) {
  stopSkim(); S.aToken++; S.tToken++; ASR.stopReq = true;
  if (S.url) URL.revokeObjectURL(S.url);
  Object.assign(S, { file, url: URL.createObjectURL(file), feat: null, audio: null, segs: [], curSeg: -1, curLine: -1, pendingIn: null, stopAt: null, thumbs: new Map(), duration: 0, tr: { model: '', lines: [], doneUntil: 0 }, editId: null, shown: null, pick: null, lineClosed: new Set(), segOpen: new Set() });
  FS.cache = new Map(); FS.lockV0 = null; SK.pending = null;
  const saved = loadProject();
  S.clips = (saved?.clips || []).map(c => ({ id: S.nextId++, start: c.start, end: c.end }));
  S.gapAuto = !(saved && saved.gap); if (!S.gapAuto) S.gap = saved.gap;
  $('#ph').hidden = true;
  v.src = S.url; thumbV.src = S.url;
  renderInChip(); renderSegs(); renderLines(); renderClips(); setupZoom(); updateAsrUI();
  setStatus('<span class="pill">準備中</span><span>動画を読み込んでいます…</span>', 0);
  await once(v, 'loadedmetadata', 15000);
  S.duration = isFinite(v.duration) ? v.duration : 0;
  FS.span = clamp(S.duration / 6, 10, 30); stripHint();
  refreshPlayhead();
  if (thumbV.readyState < 1) once(thumbV, 'loadedmetadata', 10000).then(drawStrip);
  analyze(file);
}
async function analyze(file) {
  const token = S.aToken; S.analyzing = true;
  const t0 = performance.now();
  const ex = new Extractor();
  const onPCM = (x, sr, t) => ex.push(x, sr, t);
  const onProg = p => { if (token === S.aToken) setStatus(`<span class="pill">音声を分析中 ${Math.round(p * 100)}%</span><span>再生しながら待てます</span>`, p); };
  try {
    let done = false;
    try {
      const info = await probeMp4(file);
      if (info) { await decodeMp4(file, info, onPCM, onProg, token); done = true; }
    } catch (e) { if (e.message === 'cancel') throw e; console.warn('mp4 path failed, falling back', e); }
    if (!done) {
      setStatus('<span class="pill">音声を分析中</span><span>音声をまとめて読み込んでいます…</span>', 0.02);
      await decodeWhole(file, onPCM, onProg, token);
    }
    if (token !== S.aToken) return;
    S.feat = summarize(ex, S.duration);
    if (!S.duration) S.duration = S.feat.duration;
    if (S.gapAuto) S.gap = autoGap(S.feat.duration);
    $('#gap').value = S.gap; $('#gapv').textContent = S.gap + '秒';
    S.view = { start: 0, span: S.feat.duration };
    // transcript from an earlier session?
    const model = $('#asrModel').value;
    let tr = await IDB.get(trKey(model));
    if (!tr) for (const o of $('#asrModel').options) { if (o.value === model) continue; const t = await IDB.get(trKey(o.value)); if (t) { tr = t; $('#asrModel').value = o.value; break; } }
    if (token !== S.aToken) return;
    if (tr) S.tr = migrateTr(tr);
    S.analyzing = false;
    setupZoom(); resegment(); renderClips();
    updateAsrUI();
  } catch (e) {
    if (e.message === 'cancel' || token !== S.aToken) return;
    console.error(e);
    const msg = e.message === 'too-big' ? 'この形式の大きなファイルは分析できません。MP4（AAC音声）で保存した動画を使ってください。'
      : e.message === 'short' ? '音声が短すぎて分析できませんでした。' : 'この動画の音声を分析できませんでした。MP4形式の動画で試してください。';
    setStatus(`<span class="pill">分析できません</span><span>${msg}</span>`, null);
  } finally { if (token === S.aToken) S.analyzing = false; }
}

/* ---------------- transcription controller ---------------- */
const ASR = { worker: null, running: false, stopReq: false, device: '', pending: new Map(), nextId: 1, loadP: null, dl: {} };
function asrWorker() {
  if (!ASR.worker) {
    ASR.worker = new Worker('asr-worker.js', { type: 'module' });
    ASR.worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') {
        if (m.file && m.total) ASR.dl[m.file] = { loaded: m.loaded, total: m.total };
        const tot = Object.values(ASR.dl).reduce((a, x) => a + x.total, 0), got = Object.values(ASR.dl).reduce((a, x) => a + x.loaded, 0);
        if (tot > 1e6) setAsrState(`文字起こしモデルを準備中… ${(got / 1048576).toFixed(0)} / ${(tot / 1048576).toFixed(0)} MB`, got / tot);
      } else if (m.type === 'ready') { ASR.loadP?.res(m.device); ASR.loadP = null; }
      else if (m.type === 'result') { const p = ASR.pending.get(m.id); if (p) { ASR.pending.delete(m.id); p.res(m); } }
      else if (m.type === 'error') {
        if (m.id != null) { const p = ASR.pending.get(m.id); if (p) { ASR.pending.delete(m.id); p.rej(new Error(m.message)); } }
        else { ASR.loadP?.rej(new Error(m.message)); ASR.loadP = null; }
      }
    };
    ASR.worker.onerror = e => { const err = new Error(e.message || 'worker error'); ASR.loadP?.rej(err); ASR.loadP = null; ASR.pending.forEach(p => p.rej(err)); ASR.pending.clear(); };
  }
  return ASR.worker;
}
// transcripts saved before v2 assumed the audio started at 0:00; move them to the track's real start
function migrateTr(tr) {
  if (!tr || tr.v2) return tr;
  if (S.audio && S.audio.kind === 'mp4' && S.feat) {
    const sh = S.audio.info.start || 0;
    if (Math.abs(sh) > 0.05) {
      for (const l of tr.lines) { l.s += sh; l.e += sh; if (l.s0 != null) { l.s0 += sh; l.e0 += sh; } }
      tr.doneUntil = Math.min(S.feat.duration, tr.doneUntil + sh);
      toast(`保存済みの文字起こしを${sh.toFixed(1)}秒ずらして音声に合わせました`);
    }
  }
  tr.v2 = true; if (tr.model) IDB.put(trKey(tr.model), tr);
  return tr;
}
function asrLoad(model, prefer) { return new Promise((res, rej) => { ASR.loadP = { res, rej }; asrWorker().postMessage({ type: 'load', model, prefer: prefer || '' }); }); }
// some phone GPUs return empty or garbage text from Whisper; once seen, remember to use the CPU
function asrPrefer() { try { return localStorage.getItem('kirinuki:asrDevice') || ''; } catch (_) { return ''; } }
function asrRun(audio) { const id = ASR.nextId++; return new Promise((res, rej) => { ASR.pending.set(id, { res, rej }); ASR.worker.postMessage({ type: 'run', id, audio }, [audio.buffer]); }); }
function setAsrState(text, prog) {
  $('#asrState').textContent = text;
  const p = $('#asrProg'); p.hidden = prog == null; if (prog != null) p.firstElementChild.style.width = (clamp(prog, 0, 1) * 100).toFixed(1) + '%';
}
function updateAsrUI() {
  $('#asr').hidden = !S.feat;
  const go = $('#asrGo'), sel = $('#asrModel');
  sel.disabled = ASR.running;
  if (ASR.running) { go.textContent = '一時停止'; return; }
  const dur = S.feat ? S.feat.duration : 0, done = S.tr.doneUntil;
  if (!S.tr.lines.length && !done) { go.textContent = '開始'; setAsrState('まだ行っていません'); }
  else if (done >= dur - 1 && !S.tr.lines.length) { go.textContent = 'やり直す'; setAsrState('完了しましたが、文字を1行も認識できませんでした。下の「詳細」で原因を確認できます'); }
  else if (done >= dur - 1) { go.textContent = 'やり直す'; setAsrState(`完了（${S.tr.lines.length}行）`); }
  else { go.textContent = '続きから'; setAsrState(`${fmt(done)} まで完了（${Math.round(done / dur * 100)}%）`, done / dur); }
  renderAsrDiag();
}
function renderAsrDiag() {
  const d = S.tr.diag || [], box = $('#asrDiag');
  $('#asrCpu').checked = asrPrefer() === 'wasm';
  box.hidden = !d.length && !S.tr.lines.length && !(S.feat && S.tr.doneUntil >= S.feat.duration - 1);
  const ok = d.filter(x => x.kept > 0).length, silent = d.filter(x => x.rms <= 0.003).length;
  const dropped = d.filter(x => !x.kept && x.raw && x.rms > 0.003).length, empty = d.filter(x => !x.kept && !x.raw && x.rms > 0.003).length;
  let why = '';
  if (d.length && !ok) why = silent === d.length ? '動画から取り出した音声が無音になっています（音声の取り出しに問題があります）。' : empty >= dropped ? '音声はあるのに、認識結果が空でした。下の「CPUだけで処理する」をオンにして、やり直してみてください。' : '認識結果がすべて意味のない文字だったため除外しました。下の「CPUだけで処理する」をオンにして、やり直してみてください。';
  $('#asrDiagSum').textContent = d.length ? `${why}認識できた ${ok}・空 ${empty}・除外 ${dropped}・無音 ${silent}（全${d.length}か所）` : 'まだ記録がありません。';
  $('#asrDiagLog').textContent = d.slice(-80).map(x => `${fmt(x.s)}–${fmt(x.e)} ${x.dev === 'webgpu' ? 'GPU' : 'CPU'} 音量${x.rms.toFixed(3)} ${x.kept}行「${x.raw || '（空）'}」`).join('\n');
}
$('#asrCpu').addEventListener('change', e => {
  try { if (e.target.checked) localStorage.setItem('kirinuki:asrDevice', 'wasm'); else localStorage.removeItem('kirinuki:asrDevice'); } catch (_) {}
  toast(e.target.checked ? '次の文字起こしからCPUだけで処理します' : '次の文字起こしからGPUが使えれば使います');
});
function planChunks(F, from) {
  const out = []; let t = from; const dur = F.duration;
  while (t < dur - 0.5) {
    // don't hand Whisper a window that opens with a long silence: its timestamps drift when it does
    const quiet = F.pauses.find(p => p.s <= t + 0.2 && p.e - t >= 1.5);
    if (quiet) { t = Math.max(t, quiet.e - 0.4); if (t >= dur - 0.5) break; }
    let end = Math.min(dur, t + 28);
    if (end < dur) { let best = null; for (const p of F.pauses) { const c = (p.s + p.e) / 2; if (c > t + 12 && c <= t + 28) best = c; if (p.s > t + 28) break; } if (best) end = best; }
    out.push({ s: t, e: end }); t = end;
  }
  return out;
}
const JUNK = /ご視聴ありがとうございました|チャンネル登録|字幕(制作|作成)|by H\.|^[\s。、.!?！？…]*$/;
function addLines(r, s, e) {
  const L = S.tr.lines;
  const parts = r.chunks && r.chunks.length ? r.chunks : [{ s: 0, e: e - s, text: r.text }];
  for (const c of parts) {
    const text = String(c.text || '').replace(/\s+/g, ' ').trim();
    if (!text || JUNK.test(text) || /(.)\1{9,}/.test(text) || /(.{2,10})\1{4,}/.test(text)) continue;
    if (L.slice(-2).some(l => l.text === text)) continue;
    let a = s + (c.s ?? 0), b = c.e != null ? s + c.e : e;
    a = clamp(a, s, e); b = clamp(b, a + 0.3, e + 0.5);
    L.push({ s: a, e: b, text, ck: Math.round(s * 100) / 100 });   // ck: which Whisper window it came from
  }
}
async function startAsr() {
  if (!S.feat || ASR.running) return;
  const model = $('#asrModel').value, token = S.aToken;
  if (S.tr.model !== model || S.tr.doneUntil >= S.feat.duration - 1) {
    const prev = S.tr.model === model ? null : await IDB.get(trKey(model));
    S.tr = prev && prev.doneUntil < S.feat.duration - 1 ? migrateTr(prev) : { model, lines: [], doneUntil: 0, v2: true };
  }
  ASR.running = true; ASR.stopReq = false; ASR.dl = {}; updateAsrUI();
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (_) {}
  let lastApply = performance.now();
  try {
    setAsrState('文字起こしモデルを準備中…', 0);
    ASR.device = await asrLoad(model, asrPrefer());
    const plan = planChunks(S.feat, S.tr.doneUntil);
    if (!S.tr.diag) S.tr.diag = [];
    const t0 = performance.now(); let audioDone = 0, emptyStreak = 0, onCpu = ASR.device !== 'webgpu';
    for (let ci = 0; ci < plan.length; ci++) {
      const c = plan[ci];
      if (ASR.stopReq || token !== S.aToken) break;
      let vo = 0, n = 0; for (let b = Math.floor(c.s); b < Math.min(S.feat.nB, Math.ceil(c.e)); b++) { vo += S.feat.voiced[b]; n++; }
      if (n && vo / n >= 0.05) {
        const pcm = await pcm16k(c.s, c.e);
        if (token !== S.aToken) break;
        let sq = 0; for (let k = 0; k < pcm.length; k += 4) sq += pcm[k] * pcm[k];
        const rms = Math.sqrt(sq / Math.max(1, pcm.length / 4)), len = pcm.length / 16000;
        let r = await asrRun(pcm);
        if (token !== S.aToken) break;
        if (ASR.simEmptyGpu && ASR.device === 'webgpu') r = { text: '', chunks: [] };   // test hook
        const before = S.tr.lines.length; addLines(r, c.s, c.e); const kept = S.tr.lines.length - before;
        S.tr.diag.push({ s: c.s, e: c.e, len, rms, raw: String(r.text || '').trim().slice(0, 60), kept, dev: ASR.device });
        if (S.tr.diag.length > 200) S.tr.diag.shift();
        renderAsrDiag();
        // the audio itself was not silent, yet nothing usable came back: count it against the GPU
        if (kept === 0 && rms > 0.003) emptyStreak++; else if (kept > 0) emptyStreak = 0;
        if (!onCpu && emptyStreak >= 2) {
          onCpu = true;
          setAsrState('GPUで文字を認識できなかったため、CPUに切り替えています…（遅くなります）');
          ASR.device = await asrLoad(model, 'wasm');
          try { localStorage.setItem('kirinuki:asrDevice', 'wasm'); } catch (_) {}
          ci -= emptyStreak; emptyStreak = 0;
          S.tr.doneUntil = plan[ci + 1].s;
          continue;   // redo the chunks that came back empty
        }
      }
      S.tr.doneUntil = c.e; audioDone += c.e - c.s;
      const el = (performance.now() - t0) / 1000, speed = audioDone / el, dur = S.feat.duration;
      setAsrState(`${fmt(c.e)} まで完了（${Math.round(c.e / dur * 100)}%）・残り約${fmtLeft((dur - c.e) / speed)}・${speed.toFixed(1)}倍速・${ASR.device === 'webgpu' ? 'GPU' : 'CPU'}`, c.e / dur);
      IDB.put(trKey(model), S.tr);
      if (performance.now() - lastApply > 8000) { lastApply = performance.now(); resegment(); }
    }
    if (token === S.aToken) { resegment(); IDB.put(trKey(model), S.tr); }
  } catch (e) {
    console.error(e);
    setAsrState('文字起こしを続けられませんでした（' + (e && e.message || e) + '）。高精度モデルで失敗した場合は標準を試してください。');
    ASR.running = false; try { wake && wake.release(); } catch (_) {}
    $('#asrGo').textContent = '再試行'; $('#asrModel').disabled = false;
    return;
  }
  ASR.running = false; try { wake && wake.release(); } catch (_) {}
  if (token === S.aToken) { updateAsrUI(); if (S.tr.doneUntil >= S.feat.duration - 1) toast('文字起こしが終わり、話の内容で区切り直しました'); }
}
$('#asrGo').onclick = async () => {
  if (ASR.running) { ASR.stopReq = true; $('#asrGo').textContent = '止めています…'; return; }
  if (S.feat && S.tr.doneUntil >= S.feat.duration - 1 && S.tr.model === $('#asrModel').value) { S.tr = { model: S.tr.model, lines: [], doneUntil: 0, v2: true }; }
  startAsr();
};
$('#asrModel').addEventListener('change', async () => {
  if (!S.feat || ASR.running) return;
  const tr = await IDB.get(trKey($('#asrModel').value));
  S.tr = tr ? migrateTr(tr) : { model: $('#asrModel').value, lines: [], doneUntil: 0, v2: true };
  resegment(); updateAsrUI();
});

/* ---------------- export ---------------- */
const sheet = $('#sheet');
let exState = null;
function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
$('#b-export').onclick = () => {
  if (!S.clips.length) return;
  const total = S.clips.reduce((a, c) => a + c.end - c.start, 0);
  $('#exInfo').textContent = `${S.clips.length}本・合計 ${fmt(total)} を1本につなげます。実際の再生時間と同じだけかかるので、画面を開いたままお待ちください。`;
  $('#exOpts').hidden = false; $('#exRun').hidden = true; $('#exOut').hidden = true; $('#exSave').hidden = true; $('#exShare').hidden = true; $('#exStart').hidden = false; $('#exMsg').textContent = '';
  $('#exCancel').textContent = '閉じる';
  sheet.hidden = false; v.pause(); stopSkim();
};
$('#exCancel').onclick = () => { if (exState && exState.running) { exState.cancel = true; return; } sheet.hidden = true; $('#exOut').pause(); };
$('#exStart').onclick = () => startExport();
async function startExport() {
  const mime = pickMime();
  if (!mime || !HTMLCanvasElement.prototype.captureStream) { $('#exMsg').textContent = 'このブラウザは動画の書き出しに対応していません。Android の Chrome で開いてください。'; return; }
  const ev = document.createElement('video'); ev.className = 'offscreen'; ev.playsInline = true; ev.preload = 'auto'; ev.src = S.url; document.body.appendChild(ev);
  const AC = window.AudioContext || window.webkitAudioContext; const actx = new AC();
  const unlock = ev.play(); if (unlock) unlock.then(() => ev.pause()).catch(() => {});
  exState = { running: true, cancel: false }; S.exporting = true; S.tToken++;
  $('#exOpts').hidden = true; $('#exStart').hidden = true; $('#exRun').hidden = false; $('#exCancel').textContent = '中止'; $('#exMsg').textContent = '';
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (_) {}
  let rec = null;
  try {
    if (ev.readyState < 1) await once(ev, 'loadedmetadata', 15000);
    try { await unlock; } catch (_) {}
    ev.pause();
    const cap = $('#q720').checked ? 1280 : 4096;
    const vw = ev.videoWidth || 1280, vh = ev.videoHeight || 720, sc = Math.min(1, cap / Math.max(vw, vh));
    const W = Math.round(vw * sc / 2) * 2, H = Math.round(vh * sc / 2) * 2;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const stream = cv.captureStream(30);
    const src = actx.createMediaElementSource(ev), dst = actx.createMediaStreamDestination(); src.connect(dst);
    if (actx.state !== 'running') await actx.resume().catch(() => {});
    dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const bps = clamp(W * H * 30 * 0.15, 2e6, 16e6);
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps, audioBitsPerSecond: 128000 });
    const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const total = S.clips.reduce((a, c) => a + c.end - c.start, 0); let doneDur = 0;
    for (let i = 0; i < S.clips.length; i++) {
      if (exState.cancel) break;
      const c = S.clips[i];
      ev.currentTime = c.start; await once(ev, 'seeked', 10000);
      g.drawImage(ev, 0, 0, W, H);
      await ev.play();
      if (rec.state === 'inactive') rec.start(1000); else rec.resume();
      await new Promise(res => {
        let fin = false;
        const finish = () => { if (fin) return; fin = true; clearInterval(iv); ev.pause(); if (rec.state === 'recording') rec.pause(); res(); };
        const check = () => (ev.currentTime >= c.end - 0.02 || ev.ended || exState.cancel);
        const draw = () => {
          if (fin) return;
          g.drawImage(ev, 0, 0, W, H);
          const p = (doneDur + Math.max(0, ev.currentTime - c.start)) / total;
          $('#exBar').style.width = (p * 100).toFixed(1) + '%';
          $('#exNow').textContent = `${i + 1} / ${S.clips.length} 本目　${fmt(doneDur + ev.currentTime - c.start)} / ${fmt(total)}`;
          if (check()) finish(); else sched();
        };
        const sched = () => ev.requestVideoFrameCallback ? ev.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
        const iv = setInterval(() => { if (check()) finish(); }, 40);
        sched();
      });
      doneDur += c.end - c.start;
    }
    const cancelled = exState.cancel;
    const type = mime.split(';')[0];
    const blob = await new Promise(res => { rec.onstop = () => res(new Blob(chunks, { type })); if (rec.state !== 'inactive') rec.stop(); else res(new Blob(chunks, { type })); });
    if (cancelled) { $('#exMsg').textContent = '書き出しを中止しました。'; $('#exRun').hidden = true; $('#exStart').hidden = false; $('#exOpts').hidden = false; }
    else showResult(blob, mime);
  } catch (e) {
    console.error(e);
    $('#exMsg').textContent = '書き出しに失敗しました（' + (e && e.message || e) + '）。画質を720pにするか、切り抜きを減らして試してください。';
    $('#exStart').hidden = false; $('#exOpts').hidden = false;
  } finally {
    exState.running = false; S.exporting = false; $('#exCancel').textContent = '閉じる';
    try { ev.pause(); ev.removeAttribute('src'); ev.load(); ev.remove(); } catch (_) {}
    actx.close().catch(() => {});
    try { wake && wake.release(); } catch (_) {}
    queueThumbs();
  }
}
let lastFile = null;
function showResult(blob, mime) {
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const base = (S.file?.name || 'video').replace(/\.[^.]+$/, '');
  const now = new Date(), stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  lastFile = new File([blob], `${base}_きりぬき_${stamp}.${ext}`, { type: blob.type });
  const o = $('#exOut'); if (o.src) URL.revokeObjectURL(o.src); o.src = URL.createObjectURL(blob); o.hidden = false;
  $('#exRun').hidden = true; $('#exSave').hidden = false;
  $('#exShare').hidden = !(navigator.canShare && navigator.canShare({ files: [lastFile] }));
  $('#exMsg').textContent = `できました（${(blob.size / 1048576).toFixed(1)} MB・${ext.toUpperCase()}）。「端末に保存」でダウンロードフォルダに保存されます。`;
}
$('#exSave').onclick = () => {
  if (!lastFile) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(lastFile); a.download = lastFile.name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  toast('保存を開始しました');
};
$('#exShare').onclick = async () => { if (!lastFile) return; try { await navigator.share({ files: [lastFile], title: lastFile.name }); } catch (_) {} };

/* ---------------- boot ---------------- */
renderSegs(); renderLines(); renderClips(); refreshPlayhead();
window.__kirinuki = { loadFile, S, ASR, FS, probeMp4, segmentize, applyTranscript, pcm16k, tokens, renderSegs, segStats };
})();
