// On-device speech recognition (Whisper via transformers.js). Runs in a module worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null, loadedKey = '';

async function hasWebGPU() {
  try { if (!self.navigator || !navigator.gpu) return null; const a = await navigator.gpu.requestAdapter(); return a; } catch (_) { return null; }
}

async function load(model, prefer) {
  const adapter = prefer === 'wasm' ? null : await hasWebGPU();
  const tries = [];
  if (adapter) {
    const f16 = adapter.features && adapter.features.has('shader-f16');
    const big = /small|medium/.test(model);
    tries.push({ device: 'webgpu', dtype: { encoder_model: big && f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' } });
  }
  tries.push({ device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
  let lastErr = null;
  for (const t of tries) {
    try {
      const p = await pipeline('automatic-speech-recognition', model, {
        device: t.device, dtype: t.dtype,
        progress_callback: x => {
          if (x.status === 'progress' || x.status === 'download' || x.status === 'done') self.postMessage({ type: 'progress', status: x.status, file: x.file, loaded: x.loaded || 0, total: x.total || 0 });
        },
      });
      // warm up so the first real chunk is not slow and WebGPU problems show up here
      await p(new Float32Array(16000), { language: 'japanese', task: 'transcribe' });
      return { p, device: t.device };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('load failed');
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    const key = m.model + '|' + (m.prefer || '');
    if (asr && loadedKey === key) { self.postMessage({ type: 'ready', device: asr.device }); return; }
    try {
      if (asr) { try { await asr.p.dispose(); } catch (_) {} asr = null; }
      asr = await load(m.model, m.prefer); loadedKey = key;
      self.postMessage({ type: 'ready', device: asr.device });
    } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
  } else if (m.type === 'run') {
    try {
      const out = await asr.p(m.audio, { language: 'japanese', task: 'transcribe', return_timestamps: true });
      const chunks = (out.chunks || []).map(c => ({ s: c.timestamp[0], e: c.timestamp[1], text: c.text }));
      self.postMessage({ type: 'result', id: m.id, text: out.text || '', chunks });
    } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) }); }
  }
};
