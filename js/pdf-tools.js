// Make It Fit — pdf.js helpers used on the main thread: thumbnails, previews, protected-PDF checks
// and "scan mode" (turning pages into pictures) for PDFs the smart engine can't shrink enough.

const BASE = new URL('../lib/pdfjs/', import.meta.url).href;
let libPromise = null;

export function getPdfjs() {
  if (!libPromise) {
    libPromise = import('../lib/pdfjs/pdf.min.js').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js';
      return lib;
    });
  }
  return libPromise;
}

const coded = (code, message) => Object.assign(new Error(message || code), { code });

export async function openPdf(blob, password) {
  const lib = await getPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({
    data,
    password: password || undefined,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/',
    iccUrl: BASE + 'iccs/',
    isEvalSupported: false,
    enableXfa: false,
    verbosity: 0,
  });
  try {
    return await task.promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      throw coded(e.code === lib.PasswordResponses.INCORRECT_PASSWORD ? 'PDF_WRONG_PASSWORD' : 'PDF_NEEDS_PASSWORD');
    }
    throw coded('PDF_DAMAGED', e && e.message);
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(coded('ENCODE'))), type, quality));
}

// Renders one page. opt: { dpi } or { maxSide }, plus type/quality for a Blob, or canvasOnly.
export async function renderPage(doc, n, opt) {
  const page = await doc.getPage(n);
  try {
    const vp1 = page.getViewport({ scale: 1 });
    let scale = opt.dpi ? opt.dpi / 72 : opt.maxSide / Math.max(vp1.width, vp1.height);
    const maxPixels = opt.maxPixels || 36e6;
    if (vp1.width * vp1.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (vp1.width * vp1.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: opt.intent || 'display' }).promise;
    const out = { widthPt: vp1.width, heightPt: vp1.height, px: [canvas.width, canvas.height] };
    if (opt.canvasOnly) return { ...out, canvas };
    out.blob = await toBlob(canvas, opt.type || 'image/jpeg', opt.quality);
    canvas.width = canvas.height = 0;
    return out;
  } finally {
    page.cleanup();
  }
}

// Page count, permissions and a first-page thumbnail. Throws PDF_NEEDS_PASSWORD / PDF_DAMAGED.
export async function analyzePdf(blob, password) {
  const lib = await getPdfjs();
  const doc = await openPdf(blob, password);
  try {
    const perms = await doc.getPermissions();
    const canPrint = !perms || perms.includes(lib.PermissionFlag.PRINT) || perms.includes(lib.PermissionFlag.PRINT_HIGH_QUALITY);
    let thumb = null;
    try {
      thumb = (await renderPage(doc, 1, { maxSide: 180, type: 'image/jpeg', quality: 0.82 })).blob;
    } catch { thumb = null; }
    return { pages: doc.numPages, restricted: !!perms, canPrint, thumb };
  } finally {
    await doc.destroy();
  }
}

async function encodeScaled(canvas, f, q) {
  const w = Math.max(1, Math.round(canvas.width * f));
  const h = Math.max(1, Math.round(canvas.height * f));
  if (f >= 0.999) return toBlob(canvas, 'image/jpeg', q);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { alpha: false });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, w, h);
  const b = await toBlob(c, 'image/jpeg', q);
  c.width = c.height = 0;
  return b;
}

export const SCAN_STEPS = [
  [200, 0.8], [170, 0.76], [150, 0.72], [130, 0.68], [115, 0.64], [100, 0.6],
  [90, 0.55], [80, 0.5], [72, 0.45], [60, 0.4], [50, 0.35],
];
const SCAN_FLOOR = 5;
const scanQuality = (dpi) => (dpi >= 170 ? 'High' : dpi >= 130 ? 'Good' : dpi >= 100 ? 'Fair' : 'Low');

/**
 * Turns every page into a picture at the best resolution that fits under the limit.
 * o = { limit, strong, password, signal, onProgress, assemble(pages, meta) -> Blob, title }
 */
export async function scanModePdf(blob, o) {
  const doc = await openPdf(blob, o.password);
  const check = () => { if (o.signal && o.signal.aborted) throw coded('CANCELLED'); };
  const progress = (v, l) => { if (o.onProgress) o.onProgress(v, l); };
  try {
    const n = doc.numPages;
    const maxStep = o.strong ? SCAN_STEPS.length - 1 : SCAN_FLOOR;
    const samples = [...new Set([1, Math.ceil(n / 2), n])];
    const probe = [...new Set([0, 3, 5, maxStep])].filter((s) => s <= maxStep).sort((a, b) => a - b);
    const perPage = new Map(probe.map((s) => [s, 0]));
    let k = 0;
    for (const p of samples) {
      check();
      const { canvas } = await renderPage(doc, p, { dpi: SCAN_STEPS[0][0], canvasOnly: true, intent: 'print' });
      for (const s of probe) {
        const b = await encodeScaled(canvas, SCAN_STEPS[s][0] / SCAN_STEPS[0][0], SCAN_STEPS[s][1]);
        perPage.set(s, perPage.get(s) + b.size / samples.length);
        progress(0.04 + (0.16 * ++k) / (samples.length * probe.length), 'Testing quality levels');
      }
      canvas.width = canvas.height = 0;
    }
    const sizeAt = (s) => {
      if (perPage.has(s)) return perPage.get(s);
      let lo = probe[0], hi = probe[probe.length - 1];
      for (const p of probe) { if (p <= s) lo = p; if (p >= s && hi >= p) hi = p; }
      const a = perPage.get(lo), b = perPage.get(hi);
      if (hi === lo) return a;
      const t = (s - lo) / (hi - lo);
      return Math.exp(Math.log(Math.max(a, 1)) * (1 - t) + Math.log(Math.max(b, 1)) * t);
    };
    const predict = (s) => n * (sizeAt(s) + 900) + 3000;
    let step = maxStep;
    for (let s = 0; s <= maxStep; s++) if (predict(s) <= o.limit * 0.95) { step = s; break; }

    const tried = new Map();
    const build = async (s) => {
      const pages = [];
      for (let p = 1; p <= n; p++) {
        check();
        progress(0.22 + 0.7 * ((p - 1) / n), `Rendering page ${p} of ${n}`);
        const r = await renderPage(doc, p, { dpi: SCAN_STEPS[s][0], type: 'image/jpeg', quality: SCAN_STEPS[s][1], intent: 'print' });
        pages.push({ bytes: new Uint8Array(await r.blob.arrayBuffer()), pageW: r.widthPt, pageH: r.heightPt });
      }
      progress(0.93, 'Building the PDF');
      const out = await o.assemble(pages, { title: o.title });
      tried.set(s, out);
      return out;
    };
    for (let pass = 0; pass < 3; pass++) {
      const out = tried.get(step) || (await build(step));
      if (out.size <= o.limit) {
        if (step > 0 && !tried.has(step - 1) && out.size < o.limit * 0.8 && pass < 2) { step--; continue; }
        break;
      }
      if (step >= maxStep) break;
      const next = Math.min(maxStep, step + (out.size > o.limit * 1.35 ? 2 : 1));
      if (tried.has(next) && tried.get(next).size > o.limit) { step = next; break; }
      step = next;
    }
    let best = null;
    for (const [s, b] of [...tried.entries()].sort((a, b2) => a[0] - b2[0])) if (b.size <= o.limit) { best = { s, b }; break; }
    const fits = !!best;
    if (!best) for (const [s, b] of tried.entries()) if (!best || b.size < best.b.size) best = { s, b };
    const dpi = SCAN_STEPS[best.s][0];
    return { blob: best.b, fits, pages: n, mode: 'scan', quality: scanQuality(dpi), dpi, notes: [] };
  } finally {
    await doc.destroy();
  }
}

// Renders the first pages of a PDF into a container (for the preview window).
export async function renderPreview(blob, container, { password, maxPages = 6, width = 760 } = {}) {
  const doc = await openPdf(blob, password);
  try {
    const n = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, (width * (window.devicePixelRatio || 1)) / vp1.width);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.style.width = '100%';
      canvas.className = 'preview-page';
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      container.appendChild(canvas);
    }
    return { pages: doc.numPages, shown: n };
  } finally {
    await doc.destroy();
  }
}
