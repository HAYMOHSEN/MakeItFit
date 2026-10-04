// Make It Fit — processing worker. Everything runs locally; nothing is sent anywhere.
import { fitPhoto, renderPhoto, EngineError } from './image-engine.js';
import { shrinkPdf, quickInspect, buildPdfFromJpegs } from './pdf-engine.js';

const COMBINE_STEPS = [
  [3000, 0.85], [2600, 0.82], [2300, 0.8], [2000, 0.76], [1750, 0.72], [1500, 0.68], [1300, 0.64],
  [1150, 0.6], [1000, 0.55], [850, 0.5], [720, 0.45], [600, 0.4], [500, 0.35],
];
const COMBINE_FLOOR = 7;
const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };

function pageLayout(it, pageSize, margin) {
  let pw, ph;
  if (pageSize === 'photo') {
    const L = 792;
    if (it.ow >= it.oh) { pw = L; ph = (L * it.oh) / it.ow; } else { ph = L; pw = (L * it.ow) / it.oh; }
  } else {
    [pw, ph] = PAGE[pageSize] || PAGE.a4;
    if (it.ow > it.oh) [pw, ph] = [ph, pw];
  }
  const m = pageSize === 'photo' || margin !== 'small' ? 0 : 24;
  const s = Math.min((pw - 2 * m) / it.ow, (ph - 2 * m) / it.oh);
  const dw = it.ow * s, dh = it.oh * s;
  return { pageW: pw, pageH: ph, x: (pw - dw) / 2, y: (ph - dh) / 2, drawW: dw, drawH: dh };
}

async function combinePhotos(files, o, report) {
  const items = [];
  for (const f of files) {
    let bmp;
    try { bmp = await createImageBitmap(f.file, { imageOrientation: 'from-image' }); } catch { throw new EngineError('IMAGE_DECODE', f.file.name); }
    const rot = (((Number(f.rotate) || 0) % 360) + 360) % 360;
    items.push({ file: f.file, rot, ow: rot % 180 ? bmp.height : bmp.width, oh: rot % 180 ? bmp.width : bmp.height });
    bmp.close();
  }
  const maxStep = o.strong ? COMBINE_STEPS.length - 1 : COMBINE_FLOOR;
  const outDims = (it, s) => {
    const k = Math.min(1, COMBINE_STEPS[s][0] / Math.max(it.ow, it.oh));
    return [Math.max(1, Math.round(it.ow * k)), Math.max(1, Math.round(it.oh * k))];
  };
  const encodeItem = async (it, s) => {
    const [w, h] = outDims(it, s);
    const bmp = await createImageBitmap(it.file, { imageOrientation: 'from-image' });
    try {
      const c = await renderPhoto(bmp, it.rot, w, h, 'full', '#FFFFFF');
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: COMBINE_STEPS[s][1] });
      return new Uint8Array(await blob.arrayBuffer());
    } finally { bmp.close(); }
  };

  // Predict size per output pixel from a few sample photos.
  report(0.05, 'Testing quality levels');
  const probe = [0, 3, 7, 12].filter((s) => s <= maxStep);
  const sample = items.slice().sort((a, b) => b.ow * b.oh - a.ow * a.oh).slice(0, Math.min(3, items.length));
  const bpp = new Map();
  let n = 0;
  for (const s of probe) {
    let bytes = 0, px = 0;
    for (const it of sample) {
      const [w, h] = outDims(it, s);
      bytes += (await encodeItem(it, s)).length;
      px += w * h;
      report(0.05 + (0.25 * ++n) / (probe.length * sample.length), 'Testing quality levels');
    }
    bpp.set(s, bytes / Math.max(1, px));
  }
  const bppAt = (s) => {
    if (bpp.has(s)) return bpp.get(s);
    let lo = probe[0], hi = probe[probe.length - 1];
    for (const p of probe) { if (p <= s) lo = p; if (p >= s && hi >= p) hi = p; }
    const a = bpp.get(lo), b = bpp.get(hi);
    if (hi === lo) return a;
    const t = (s - lo) / (hi - lo);
    return Math.exp(Math.log(a) * (1 - t) + Math.log(b) * t);
  };
  const predict = (s) => items.reduce((sum, it) => { const [w, h] = outDims(it, s); return sum + w * h * bppAt(s) + 1500; }, 2000);
  let step = maxStep;
  for (let s = 0; s <= maxStep; s++) if (predict(s) <= o.limit * 0.95) { step = s; break; }

  const tried = new Map();
  const build = async (s) => {
    const pages = [];
    for (let i = 0; i < items.length; i++) {
      report(0.3 + 0.6 * (i / items.length), `Adding photo ${i + 1} of ${items.length}`);
      const it = items[i];
      pages.push({ bytes: await encodeItem(it, s), ...pageLayout(it, o.pageSize, o.margin) });
    }
    const bytes = await buildPdfFromJpegs(pages, { title: o.title });
    tried.set(s, bytes);
    return bytes;
  };
  for (let pass = 0; pass < 4; pass++) {
    const out = tried.get(step) || (await build(step));
    if (out.length <= o.limit) {
      if (step > 0 && !tried.has(step - 1) && out.length < o.limit * 0.8) { step--; continue; }
      break;
    }
    if (step >= maxStep) break;
    const next = Math.min(maxStep, step + (out.length > o.limit * 1.35 ? 2 : 1));
    if (tried.has(next) && tried.get(next).length > o.limit) { step = next; break; }
    step = next;
  }
  let best = null;
  for (const [s, b] of [...tried.entries()].sort((a, b2) => a[0] - b2[0])) if (b.length <= o.limit) { best = { s, b }; break; }
  const fits = !!best;
  if (!best) for (const [s, b] of tried.entries()) if (!best || b.length < best.b.length) best = { s, b };
  const cap = COMBINE_STEPS[best.s][0];
  return {
    blob: new Blob([best.b], { type: 'application/pdf' }),
    fits, pages: items.length, mode: 'combine',
    quality: cap >= 2000 ? 'High' : cap >= 1300 ? 'Good' : cap >= 1000 ? 'Fair' : 'Low',
    notes: [],
  };
}

self.onmessage = async (e) => {
  const { id, task, payload } = e.data || {};
  let last = 0;
  const report = (value, label) => {
    const v = Math.max(last, Math.min(0.99, value || 0));
    last = v;
    self.postMessage({ id, type: 'progress', value: v, label });
  };
  try {
    let result;
    if (task === 'inspect') {
      const bytes = new Uint8Array(await payload.file.arrayBuffer());
      result = quickInspect(bytes);
    } else if (task === 'photo') {
      const r = await fitPhoto(payload.file, payload.opts, report);
      result = { ...r, mode: 'photo' };
    } else if (task === 'pdf') {
      const bytes = new Uint8Array(await payload.file.arrayBuffer());
      const r = await shrinkPdf(bytes, payload.opts, report);
      result = { ...r, blob: new Blob([r.bytes], { type: 'application/pdf' }) };
      delete result.bytes;
    } else if (task === 'combine') {
      result = await combinePhotos(payload.files, payload.opts, report);
    } else if (task === 'assemble') {
      const bytes = await buildPdfFromJpegs(payload.pages, payload.meta || {});
      result = { blob: new Blob([bytes], { type: 'application/pdf' }) };
    } else {
      throw new EngineError('UNKNOWN_TASK');
    }
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({
      id, type: 'error',
      code: (err && err.code) || (err && err.name === 'NotReadableError' ? 'FILE_UNREADABLE' : 'UNKNOWN'),
      message: String((err && err.message) || err),
    });
  }
};
