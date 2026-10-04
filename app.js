// Make It Fit — app logic. Everything runs on this PC; nothing is uploaded.
import { makeZip } from './js/zip.js';
import * as pdfTools from './js/pdf-tools.js';

const VERSION = '1.0.0';
const SETTINGS_KEY = 'makeitfit.settings.v1';
const PRESETS = [100e3, 200e3, 500e3, 1e6, 2e6, 5e6, 10e6, 20e6];
const DEFAULTS = {
  theme: 'system', limit: 2e6, photoFormat: 'auto', resizeMode: 'none', resizeW: '', resizeH: '', resizeFit: 'crop',
  pdfScanFallback: true, pdfPrivacy: true, strong: false, combine: false, pageSize: 'auto', margin: 'small', suffixStyle: 'limit',
};
const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
const EXT_FOR = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif', 'application/pdf': 'pdf' };

const ERRORS = {
  IMAGE_DECODE: ['This image can’t be opened', 'It may be damaged or in an unusual format. Try opening it in Photos and saving a new copy.'],
  PDF_DAMAGED: ['This PDF looks damaged', 'Make It Fit can try to rebuild it from the pages it can read. Check every page of the result before using it.'],
  PDF_LOCKED: ['This PDF is locked by its owner', 'Its security settings block changes and printing, so it can’t be shrunk. Ask the sender for an unlocked copy.'],
  PDF_NEEDS_PASSWORD: ['This PDF needs a password', 'Enter the password to continue.'],
  PDF_WRONG_PASSWORD: ['That password didn’t work', 'Check it and try again.'],
  VERIFY_FAILED: ['The result didn’t pass the safety check', 'The shrunk file was discarded to protect you. Try the “turn pages into images” option.'],
  FILE_UNREADABLE: ['This file can’t be read', 'It may have been moved or deleted since you added it. Add it again.'],
  ENGINE_CRASH: ['This file is too large to process on this PC', 'Close other programs and try again, or split the file into smaller parts.'],
  NOT_PDF: ['This isn’t a real PDF', 'The file is named .pdf but its contents are something else. Open it in the program that made it and export a PDF.'],
  CANCELLED: ['Stopped', ''],
  UNKNOWN: ['Something went wrong with this file', 'Try again. If it keeps happening, send the file to support so it can be fixed.'],
};
const NOTES = {
  resized: 'Resized', lowQuality: 'Lower quality to reach the limit', transparencyWhite: 'Transparent areas became white',
  cleaned: 'Hidden photo info removed', flattened: 'Pages turned into images (text can’t be selected)',
  protected: 'Protected PDF: saved as a print-style copy', rebuilt: 'Rebuilt from readable pages. Check every page',
  pdfa: 'PDF/A kept intact',
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coded = (code, message) => Object.assign(new Error(message || code), { code });
const trimNum = (v) => String(Math.round(v * 100) / 100);
const fmtBytes = (n) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(n < 10e3 ? 1 : 0)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(n < 10e6 ? 2 : 1)} MB` : `${(n / 1e9).toFixed(2)} GB`);
const limitLabel = (n) => (n >= 1e6 ? `${trimNum(n / 1e6)} MB` : `${trimNum(n / 1e3)} KB`);
const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
const baseOf = (name) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);
const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;

// ---------- settings ----------
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* defaults */ }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } }
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme; else delete root.dataset.theme;
}

// ---------- engine client ----------
class Engine {
  constructor() { this.spawn(); }
  spawn() {
    this.pending = new Map();
    this.seq = 0;
    this.worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.value, m.label); return; }
      this.pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.result); else p.reject(coded(m.code || 'UNKNOWN', m.message));
    };
    this.worker.onerror = () => {
      for (const p of this.pending.values()) p.reject(coded('ENGINE_CRASH'));
      this.spawn();
    };
  }
  run(task, payload, onProgress, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, task, payload }, transfer);
    });
  }
  cancel() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(coded('CANCELLED'));
    this.spawn();
  }
}
const engine = new Engine();

// ---------- state ----------
const items = new Map();
let order = [];
let running = false;
let abort = null;
let uid = 0;
const COMBINED_ID = 'combined';

const el = {
  dropzone: $('#dropzone'), fileList: $('#fileList'), rows: $('#rows'), fileCount: $('#fileCount'), summary: $('#summary'),
  summaryText: $('#summaryText'), btnRun: $('#btnRun'), runHint: $('#runHint'), chips: $('#chips'), limitValue: $('#limitValue'),
  limitUnit: $('#limitUnit'), limitText: $('#limitText'), fileInput: $('#fileInput'), toast: $('#toast'), dropOverlay: $('#dropOverlay'),
};

function itemList() { return order.map((id) => items.get(id)).filter(Boolean); }
function processable(it) { return it.kind !== 'unsupported' && !it.isCombined && !(it.pdf && (it.pdf.locked || it.pdf.needsPassword || it.pdf.unreadable)); }

// ---------- limit UI ----------
function renderLimit() {
  el.chips.innerHTML = PRESETS.map((v) => `<button class="chip" role="radio" data-limit="${v}" aria-checked="${v === settings.limit}">${limitLabel(v)}</button>`).join('');
  const unit = settings.limit >= 1e6 ? 1e6 : 1e3;
  el.limitUnit.value = String(unit);
  if (document.activeElement !== el.limitValue) el.limitValue.value = trimNum(settings.limit / unit);
  el.limitText.innerHTML = `Files will be smaller than <b>${limitLabel(settings.limit)}</b> (${settings.limit.toLocaleString()} bytes).`;
  updateRunButton();
}
el.chips.addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  settings.limit = Number(b.dataset.limit);
  saveSettings();
  renderLimit();
});
function readCustomLimit() {
  const v = parseFloat(el.limitValue.value);
  if (!(v > 0)) return;
  const bytes = Math.round(v * Number(el.limitUnit.value));
  settings.limit = Math.min(4e9, Math.max(5000, bytes));
  saveSettings();
  renderLimit();
}
el.limitValue.addEventListener('change', readCustomLimit);
el.limitValue.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); readCustomLimit(); } });
el.limitUnit.addEventListener('change', readCustomLimit);

// ---------- option bindings ----------
function bindSettings() {
  for (const node of $$('[data-setting]')) {
    const key = node.dataset.setting;
    if (node.type === 'checkbox') node.checked = !!settings[key]; else node.value = settings[key] ?? '';
    node.addEventListener('change', () => {
      settings[key] = node.type === 'checkbox' ? node.checked : node.value;
      saveSettings();
      if (key === 'theme') applyTheme();
      syncOptionVisibility();
      renderAll();
    });
  }
  syncOptionVisibility();
}
function syncOptionVisibility() {
  const mode = settings.resizeMode;
  $('#resizeFields').hidden = mode === 'none';
  $('#fitField').hidden = mode !== 'exact';
  if (settings.combine) $('#combineOpts').open = true;
}

// ---------- adding files ----------
function kindOf(file, ext) {
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (IMAGE_EXT[ext] || /^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(file.type)) return 'image';
  return 'unsupported';
}
function unsupportedError(ext) {
  if (ext === 'heic' || ext === 'heif') return { title: 'iPhone HEIC photos aren’t supported yet', hint: 'On the iPhone, set Settings › Photos › “Transfer to Mac or PC” to Automatic, then copy the photo again to get a JPG. See Help for details.' };
  if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'txt', 'rtf'].includes(ext)) return { title: 'Office files aren’t supported', hint: 'Save it as a PDF first (File › Save As › PDF), then add the PDF here.' };
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'm4a', 'wav', 'aac', 'wma'].includes(ext)) return { title: 'Video and audio are coming in a later version', hint: 'This version works with photos and PDFs.' };
  if (['zip', 'rar', '7z'].includes(ext)) return { title: 'Compressed archives aren’t supported', hint: 'Unzip it and add the photos or PDFs inside.' };
  return { title: 'This file type isn’t supported', hint: 'Make It Fit works with PDF, JPG, PNG, WebP, GIF, BMP and AVIF files.' };
}
function addFiles(files) {
  let added = 0;
  for (let file of files) {
    if (!file || !file.name) continue;
    const ext = extOf(file.name);
    if (!file.type && IMAGE_EXT[ext]) file = new File([file], file.name, { type: IMAGE_EXT[ext], lastModified: file.lastModified });
    if (!file.type && ext === 'pdf') file = new File([file], file.name, { type: 'application/pdf', lastModified: file.lastModified });
    const kind = kindOf(file, ext);
    const it = { id: `f${++uid}`, file, name: file.name, ext, kind, size: file.size, rotate: 0, status: 'ready', progress: 0, label: '', pdf: {}, thumb: null, result: null, error: null, strong: false };
    if (kind === 'unsupported') { it.status = 'error'; it.error = unsupportedError(ext); }
    items.set(it.id, it);
    order.push(it.id);
    added++;
    if (kind === 'image') makeImageThumb(it);
    if (kind === 'pdf') analyzePdfItem(it);
  }
  if (added) { renderAll(); toast(added === 1 ? 'Added 1 file' : `Added ${added} files`); }
}
async function makeImageThumb(it) {
  try {
    const bmp = await createImageBitmap(it.file, { imageOrientation: 'from-image', resizeWidth: 120, resizeQuality: 'medium' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    it.thumb = c.toDataURL('image/png');
    it.decodeOk = true;
  } catch {
    it.decodeOk = false;
  }
  renderItem(it);
}
async function analyzePdfItem(it) {
  it.status = 'analyzing';
  renderItem(it);
  try {
    const q = await engine.run('inspect', { file: it.file });
    if (!q.isPdf) throw coded('NOT_PDF');
    it.pdf.signed = q.signed;
    it.pdf.pdfa = q.pdfa;
    try {
      applyPdfInfo(it, await pdfTools.analyzePdf(it.file));
      it.status = 'ready';
      if (it.pdf.locked) setError(it, coded('PDF_LOCKED'));
    } catch (e) {
      if (e.code === 'PDF_NEEDS_PASSWORD') { it.pdf.encrypted = true; it.pdf.needsPassword = true; it.status = 'needs-password'; }
      else { it.pdf.unreadable = true; setError(it, coded('PDF_DAMAGED')); }
    }
  } catch (e) {
    it.pdf.unreadable = true;
    setError(it, e);
  }
  renderItem(it);
  updateRunButton();
}
function applyPdfInfo(it, info) {
  it.pdf.pages = info.pages;
  it.pdf.restricted = info.restricted;
  it.pdf.canPrint = info.canPrint;
  if (info.restricted) { it.pdf.encrypted = true; it.pdf.locked = !info.canPrint; }
  if (info.thumb) it.thumb = URL.createObjectURL(info.thumb);
}

// ---------- rendering ----------
function renderAll() {
  const list = itemList();
  el.dropzone.hidden = list.length > 0;
  el.fileList.hidden = list.length === 0;
  el.fileCount.textContent = list.length ? `(${list.length})` : '';
  for (const node of $$('.row', el.rows)) if (!items.has(node.dataset.id)) node.remove();
  list.forEach((it, i) => {
    let row = $(`.row[data-id="${it.id}"]`, el.rows);
    if (!row) {
      row = document.createElement('li');
      row.className = 'row';
      row.dataset.id = it.id;
      row.innerHTML = `<div class="thumb"></div><div class="body"></div><div class="side"></div>`;
    }
    if (el.rows.children[i] !== row) el.rows.insertBefore(row, el.rows.children[i] || null);
    renderItem(it);
  });
  updateRunButton();
  updateSummary();
}
function renderItem(it) {
  const row = $(`.row[data-id="${it.id}"]`, el.rows);
  if (!row) return;
  row.classList.toggle('combined', !!it.isCombined);
  row.dataset.status = it.status;
  const thumb = $('.thumb', row);
  const thumbHtml = it.thumb ? `<img src="${it.thumb}" alt="">` : icon(it.kind === 'pdf' || it.isCombined ? 'file' : 'image');
  if (thumb.dataset.src !== (it.thumb || 'icon')) { thumb.innerHTML = thumbHtml; thumb.dataset.src = it.thumb || 'icon'; }
  $('.body', row).innerHTML = bodyHtml(it);
  $('.side', row).innerHTML = sideHtml(it);
}
function metaHtml(it) {
  const parts = [];
  if (it.isCombined) parts.push(`PDF`, `${it.parts.length} photos`);
  else {
    parts.push(it.kind === 'pdf' ? 'PDF' : it.kind === 'image' ? (it.ext || 'image').toUpperCase() : (it.ext || 'file').toUpperCase());
    if (it.pdf && it.pdf.pages) parts.push(`${it.pdf.pages} page${it.pdf.pages === 1 ? '' : 's'}`);
    parts.push(fmtBytes(it.size));
    if (it.rotate) parts.push(`rotated ${it.rotate}°`);
  }
  const badges = [];
  if (it.pdf && it.pdf.signed) badges.push('<span class="badge warn" title="Shrinking will make the digital signature invalid">Digitally signed</span>');
  if (it.pdf && it.pdf.locked) badges.push('<span class="badge warn">Locked</span>');
  else if (it.pdf && it.pdf.encrypted && !it.pdf.needsPassword) badges.push('<span class="badge">Protected</span>');
  if (it.pdf && it.pdf.pdfa) badges.push('<span class="badge">PDF/A</span>');
  return `<div class="meta">${parts.map(esc).join('<span aria-hidden="true">·</span>')}${badges.join('')}</div>`;
}
function bodyHtml(it) {
  let state = '';
  const r = it.result;
  switch (it.status) {
    case 'analyzing': state = '<span class="hint">Checking the file</span>'; break;
    case 'ready': state = it.isCombined ? '' : '<span class="hint">Ready</span>'; break;
    case 'needs-password': state = `<span class="bad">Needs a password</span><button class="link" data-act="password">Enter password</button>`; break;
    case 'working': state = `<span>${esc(it.label || 'Working')}</span><div class="progress" style="flex-basis:100%"><div style="width:${Math.round((it.progress || 0) * 100)}%"></div></div>`; break;
    case 'included': state = `<span class="hint">Included in the combined PDF</span>`; break;
    case 'skipped': state = `<span class="hint">${esc(it.label || 'Skipped')}</span>`; break;
    case 'error': {
      const e = it.error || {};
      state = `<span class="bad">${esc(e.title || 'Error')}</span>${e.hint ? `<span class="hint" style="flex-basis:100%">${esc(e.hint)}</span>` : ''}`;
      if (e.code === 'PDF_DAMAGED' && !it.pdf.unreadable) state += `<button class="link" data-act="rebuild">Try to rebuild</button>`;
      if (e.code === 'IMAGE_DECODE' || e.code === 'UNKNOWN' || e.code === 'ENGINE_CRASH' || e.code === 'FILE_UNREADABLE') state += `<button class="link" data-act="retry">Try again</button>`;
      break;
    }
    case 'done': {
      if (!r) break;
      const notes = (r.notes || []).map((n) => NOTES[n]).filter(Boolean);
      if (r.converted) notes.unshift(`Saved as ${r.ext.toUpperCase()}`);
      if (r.kept) state = `<span class="ok">Already under the limit</span><span class="hint">Unchanged${notes.length ? ', ' + notes.join(', ').toLowerCase() : ''}</span>`;
      else if (r.fits) state = `<span class="ok">Fits</span><span class="hint">Quality: ${esc(r.quality)}${r.quality === 'Low' ? ' — check that it’s still readable' : ''}${notes.length ? '. ' + notes.join('. ') : ''}</span>`;
      else state = `<span class="bad">Couldn’t reach ${esc(limitLabel(it.limit))}</span><span class="hint">Smallest clear version: ${fmtBytes(r.size)}${notes.length ? '. ' + notes.join('. ') : ''}</span>${!(settings.strong || it.strong) ? '<button class="link" data-act="strong">Allow lower quality</button>' : '<span class="hint">This is as small as it can go.</span>'}`;
      const max = Math.max(it.size, it.limit * 1.08, r.size);
      state += `<div class="gauge ${r.fits ? '' : 'over'}" style="flex-basis:100%" aria-hidden="true"><div class="g-res" style="width:${(100 * r.size / max).toFixed(1)}%"></div><div class="g-limit" style="left:${(100 * it.limit / max).toFixed(1)}%"></div></div>`;
      break;
    }
    default: break;
  }
  return `<div class="name" title="${esc(it.name)}">${esc(it.name)}</div>${metaHtml(it)}${state ? `<div class="state">${state}</div>` : ''}`;
}
function sideHtml(it) {
  const r = it.result;
  const b = (act, label, iconId, extra = '') => `<button class="btn icon" data-act="${act}" aria-label="${label}" title="${label}" ${extra}>${icon(iconId)}</button>`;
  let sizes = '';
  if (it.status === 'done' && r) sizes = `<div class="sizes"><span class="from">${fmtBytes(it.size)} →</span> <span class="to ${r.fits ? '' : 'bad'}">${fmtBytes(r.size)}</span></div>`;
  else if (!it.isCombined) sizes = `<div class="sizes"><span class="to" style="font-size:14px;color:var(--muted);font-weight:500">${fmtBytes(it.size)}</span></div>`;
  let actions = '';
  if (it.status === 'done' && r) actions += `<button class="btn" data-act="preview">${icon('eye')}Preview</button><button class="btn" data-act="save">${icon('save')}Save</button>`;
  if (it.kind === 'image' && !running && it.status !== 'working') {
    actions += b('rotate', 'Rotate 90°', 'rotate');
    if (settings.combine) actions += b('up', 'Move up', 'up') + b('down', 'Move down', 'down');
  }
  if (!running && it.status !== 'working') actions += b('remove', 'Remove', 'x');
  return `${sizes}<div class="actions">${actions}</div>`;
}
el.rows.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.row');
  const it = items.get(row.dataset.id);
  if (!it) return;
  const act = btn.dataset.act;
  if (act === 'remove') removeItem(it);
  else if (act === 'rotate') { it.rotate = (it.rotate + 90) % 360; if (it.status === 'done') { it.status = 'ready'; clearResult(it); } renderItem(it); }
  else if (act === 'up' || act === 'down') { const i = order.indexOf(it.id); const j = act === 'up' ? i - 1 : i + 1; if (j >= 0 && j < order.length) { [order[i], order[j]] = [order[j], order[i]]; renderAll(); } }
  else if (act === 'preview') openPreview(it);
  else if (act === 'save') saveItem(it);
  else if (act === 'password') askPassword(it);
  else if (act === 'strong') { it.strong = true; runItems([it]); }
  else if (act === 'retry') runItems([it]);
  else if (act === 'rebuild') rebuildItem(it);
});
function clearResult(it) {
  if (it.result && it.result.url) URL.revokeObjectURL(it.result.url);
  it.result = null;
}
function removeItem(it) {
  clearResult(it);
  if (it.thumb && it.thumb.startsWith('blob:')) URL.revokeObjectURL(it.thumb);
  items.delete(it.id);
  order = order.filter((id) => id !== it.id);
  if (it.isCombined) for (const id of it.parts) { const p = items.get(id); if (p && p.status === 'included') p.status = 'ready'; }
  renderAll();
}
function updateRunButton() {
  const list = itemList();
  const ok = list.filter(processable);
  el.btnRun.disabled = running ? false : ok.length === 0;
  el.btnRun.textContent = running ? 'Stop' : 'Make it fit';
  el.btnRun.classList.toggle('primary', !running);
  if (running) el.runHint.textContent = 'Working on your files. You can keep adding files.';
  else if (!list.length) el.runHint.textContent = 'Add files to start.';
  else if (!ok.length) el.runHint.textContent = 'None of these files can be shrunk yet.';
  else el.runHint.textContent = `${ok.length} file${ok.length === 1 ? '' : 's'} will be made smaller than ${limitLabel(settings.limit)}.`;
}
function updateSummary() {
  const done = itemList().filter((it) => it.status === 'done' && it.result);
  el.summary.hidden = done.length === 0 || running;
  if (done.length) {
    const fit = done.filter((it) => it.result.fits).length;
    el.summaryText.textContent = fit === done.length ? `${done.length === 1 ? 'The file fits' : `All ${done.length} files fit`} under ${limitLabel(done[0].limit)}.` : `${fit} of ${done.length} files fit under the limit.`;
    $('#btnSaveAll').textContent = '';
    $('#btnSaveAll').insertAdjacentHTML('beforeend', `${icon('save')}Save all (${done.length})`);
  }
}

// ---------- processing ----------
function setError(it, e) {
  const code = (e && e.code) || 'UNKNOWN';
  const [title, hint] = ERRORS[code] || ERRORS.UNKNOWN;
  it.status = 'error';
  it.error = { code, title, hint };
}
function outputName(it, r) {
  const base = it.isCombined ? 'Combined photos' : baseOf(it.name);
  const ext = r.kept ? (it.ext || r.ext || 'jpg') : r.ext;
  let suffix = '';
  if (settings.suffixStyle === 'limit') suffix = r.fits ? `_under-${limitLabel(it.limit).replace(' ', '')}` : '_smaller';
  else if (settings.suffixStyle === 'small') suffix = '_small';
  if (it.isCombined && settings.suffixStyle === 'same') suffix = '';
  return `${base}${suffix}.${ext}`;
}
function setResult(it, r) {
  clearResult(it);
  const mime = r.blob.type || (r.mode === 'photo' ? r.mime : 'application/pdf');
  const ext = r.mode === 'photo' ? EXT_FOR[r.mime] || EXT_FOR[mime] || 'jpg' : 'pdf';
  it.result = { blob: r.blob, url: URL.createObjectURL(r.blob), size: r.blob.size, fits: !!r.fits, kept: !!r.kept, quality: r.quality || '', notes: r.notes || [], mode: r.mode, width: r.width, height: r.height, pages: r.pages, mime, ext, converted: r.mode === 'photo' && !r.kept && ext !== it.ext && !(ext === 'jpg' && it.ext === 'jpeg') };
  it.result.name = outputName(it, it.result);
  it.status = 'done';
  it.progress = 1;
}
function progressOf(it) {
  let last = 0;
  return (v, label) => {
    if (v < last) return;
    last = v;
    it.progress = v;
    it.label = label;
    if (!it._raf) it._raf = requestAnimationFrame(() => { it._raf = 0; renderItem(it); });
  };
}
async function runItems(selected) {
  if (running) return;
  const limit = settings.limit;
  const list = selected.filter((it) => processable(it));
  if (!list.length) return;
  const signed = list.filter((it) => it.kind === 'pdf' && it.pdf.signed && !it.pdf.signedOk);
  if (signed.length) {
    const choice = await confirmDialog({
      title: signed.length === 1 ? 'This PDF is digitally signed' : `${signed.length} PDFs are digitally signed`,
      body: `<p>Shrinking a signed PDF makes its digital signature invalid. Many portals check signatures.</p><p>${signed.map((s) => `<b>${esc(s.name)}</b>`).join(', ')}</p><p class="hint">If the signature matters, ask the sender for a smaller signed copy instead.</p>`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Skip signed PDFs', value: 'skip' }, { label: 'Shrink anyway', value: 'go', primary: true }],
    });
    if (choice === 'cancel' || !choice) return;
    for (const s of signed) { if (choice === 'skip') { s.status = 'skipped'; s.label = 'Skipped: digitally signed'; renderItem(s); } else s.pdf.signedOk = true; }
  }
  running = true;
  abort = new AbortController();
  updateRunButton();
  el.summary.hidden = true;
  try {
    const images = list.filter((it) => it.kind === 'image' && it.status !== 'skipped');
    const pdfs = list.filter((it) => it.kind === 'pdf' && it.status !== 'skipped');
    if (settings.combine && images.length) await processCombined(images, limit);
    else for (const it of images) { if (abort.signal.aborted) break; await processPhoto(it, limit); }
    for (const it of pdfs) { if (abort.signal.aborted) break; await processPdf(it, limit); }
  } finally {
    running = false;
    abort = null;
    renderAll();
  }
}
async function processPhoto(it, limit) {
  it.limit = limit;
  it.status = 'working'; it.progress = 0; it.label = 'Starting';
  renderItem(it);
  try {
    const opts = {
      limit, mime: settings.photoFormat,
      resize: { mode: settings.resizeMode, w: Number(settings.resizeW) || 0, h: Number(settings.resizeH) || 0, fit: settings.resizeFit },
      rotate: it.rotate, strong: settings.strong || it.strong, privacy: true,
    };
    if (opts.resize.mode === 'exact' && !(opts.resize.w > 0 && opts.resize.h > 0)) opts.resize.mode = 'none';
    const r = await engine.run('photo', { file: it.file, opts }, progressOf(it));
    setResult(it, r);
  } catch (e) {
    if (e.code === 'CANCELLED') it.status = 'ready'; else setError(it, e);
  }
  renderItem(it);
}
async function processCombined(images, limit) {
  let c = items.get(COMBINED_ID);
  if (!c) {
    c = { id: COMBINED_ID, isCombined: true, name: 'Combined photos.pdf', ext: 'pdf', kind: 'pdf', size: 0, status: 'ready', progress: 0, label: '', pdf: {}, thumb: null, result: null, error: null, parts: [], strong: false };
    items.set(COMBINED_ID, c);
    order.unshift(COMBINED_ID);
  }
  c.parts = images.map((it) => it.id);
  c.size = images.reduce((s, it) => s + it.size, 0);
  c.thumb = images[0].thumb;
  c.limit = limit;
  c.status = 'working'; c.progress = 0; c.label = 'Starting';
  for (const it of images) { it.status = 'included'; it.limit = limit; }
  renderAll();
  try {
    const pageSize = settings.pageSize === 'auto' ? (/-(US|CA|PH|MX)$/i.test(navigator.language) ? 'letter' : 'a4') : settings.pageSize;
    const r = await engine.run('combine', {
      files: images.map((it) => ({ file: it.file, rotate: it.rotate })),
      opts: { limit, pageSize, margin: settings.margin, strong: settings.strong || c.strong, title: 'Combined photos' },
    }, progressOf(c));
    c.pdf.pages = r.pages;
    setResult(c, r);
  } catch (e) {
    if (e.code === 'CANCELLED') { c.status = 'ready'; for (const it of images) it.status = 'ready'; } else setError(c, e);
  }
  renderAll();
}
async function scanMode(it, limit, reason) {
  const r = await pdfTools.scanModePdf(it.file, {
    limit, strong: settings.strong || it.strong, password: it.pdf.password, signal: abort && abort.signal, onProgress: progressOf(it), title: baseOf(it.name),
    assemble: async (pages, meta) => (await engine.run('assemble', { pages, meta }, null, pages.map((p) => p.bytes.buffer))).blob,
  });
  r.notes = reason === 'protected' ? ['protected', 'flattened'] : reason === 'rebuild' ? ['rebuilt', 'flattened'] : ['flattened'];
  return r;
}
async function processPdf(it, limit) {
  it.limit = limit;
  it.status = 'working'; it.progress = 0; it.label = 'Starting';
  renderItem(it);
  try {
    if (it.pdf.locked) throw coded('PDF_LOCKED');
    let res = null;
    if (!it.pdf.encrypted) {
      try {
        res = await engine.run('pdf', { file: it.file, opts: { limit, strong: settings.strong || it.strong, privacy: settings.pdfPrivacy } }, progressOf(it));
      } catch (e) {
        if (e.code === 'PDF_ENCRYPTED') it.pdf.encrypted = true;
        else if (e.code === 'VERIFY_FAILED') res = null;
        else throw e;
      }
    }
    if (it.pdf.encrypted) {
      if (it.pdf.needsPassword) { it.status = 'needs-password'; renderItem(it); return; }
      if (it.pdf.canPrint === false) throw coded('PDF_LOCKED');
      res = await scanMode(it, limit, 'protected');
    } else if ((!res || !res.fits) && settings.pdfScanFallback && !(abort && abort.signal.aborted)) {
      it.label = 'Turning pages into images';
      let scan = null;
      try { scan = await scanMode(it, limit, 'fallback'); } catch (e) { if (e.code === 'CANCELLED') throw e; }
      if (scan && (scan.fits || !res || scan.blob.size < res.blob.size)) res = scan;
    }
    if (!res) throw coded('VERIFY_FAILED');
    setResult(it, res);
  } catch (e) {
    if (e.code === 'CANCELLED') it.status = 'ready'; else setError(it, e);
  }
  renderItem(it);
}
async function rebuildItem(it) {
  if (running) return;
  running = true; abort = new AbortController(); updateRunButton();
  it.limit = settings.limit;
  it.status = 'working'; it.progress = 0; it.label = 'Rebuilding';
  renderItem(it);
  try { setResult(it, await scanMode(it, settings.limit, 'rebuild')); }
  catch (e) { if (e.code === 'CANCELLED') it.status = 'ready'; else { it.pdf.unreadable = true; setError(it, e); } }
  finally { running = false; abort = null; renderAll(); }
}
el.btnRun.addEventListener('click', () => {
  if (running) { if (abort) abort.abort(); engine.cancel(); toast('Stopping'); return; }
  runItems(itemList());
});

// ---------- saving ----------
async function saveBlob(blob, name) {
  if (window.showSaveFilePicker) {
    try {
      const ext = extOf(name);
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase() + ' file', accept: { [blob.type || 'application/octet-stream']: ['.' + ext] } }] });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return h.name;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return name;
}
async function saveItem(it) {
  if (!it.result) return;
  const name = await saveBlob(it.result.blob, it.result.name);
  if (name) toast(`Saved ${name}`);
}
async function uniqueName(dir, name) {
  const base = baseOf(name), ext = extOf(name);
  for (let i = 0; i < 200; i++) {
    const candidate = i ? `${base} (${i}).${ext}` : name;
    try { await dir.getFileHandle(candidate); } catch { return candidate; }
  }
  return `${base} (${Date.now()}).${ext}`;
}
async function saveAll() {
  const done = itemList().filter((it) => it.status === 'done' && it.result);
  if (!done.length) return;
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'makeitfit-save', startIn: 'downloads' });
      let n = 0;
      for (const it of done) {
        const fh = await dir.getFileHandle(await uniqueName(dir, it.result.name), { create: true });
        const w = await fh.createWritable();
        await w.write(it.result.blob);
        await w.close();
        n++;
      }
      toast(`Saved ${n} file${n === 1 ? '' : 's'} to “${dir.name}”`);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const zip = await makeZip(done.map((it) => ({ name: it.result.name, blob: it.result.blob })));
  const name = await saveBlob(zip, `Make It Fit - ${done.length} files.zip`);
  if (name) toast(`Saved ${name}`);
}
$('#btnSaveAll').addEventListener('click', saveAll);

// ---------- dialogs ----------
for (const d of $$('dialog')) {
  d.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) d.close(); });
}
function confirmDialog({ title, body, buttons }) {
  const d = $('#dlgConfirm');
  $('#confirmTitle').textContent = title;
  $('#confirmBody').innerHTML = body;
  const foot = $('#confirmFoot');
  foot.innerHTML = buttons.map((b) => `<button class="btn ${b.primary ? 'primary' : ''}" data-value="${esc(b.value)}">${esc(b.label)}</button>`).join('');
  return new Promise((resolve) => {
    const onClick = (e) => { const b = e.target.closest('[data-value]'); if (b) { d.returnValue = b.dataset.value; d.close(); } };
    const onClose = () => { foot.removeEventListener('click', onClick); d.removeEventListener('close', onClose); resolve(d.returnValue || 'cancel'); d.returnValue = ''; };
    foot.addEventListener('click', onClick);
    d.addEventListener('close', onClose);
    d.showModal();
  });
}
function askPassword(it) {
  const d = $('#dlgPassword');
  const input = $('#passwordInput');
  const err = $('#passwordError');
  $('#passwordName').textContent = it.name;
  input.value = '';
  err.hidden = true;
  const form = $('#passwordForm');
  const onSubmit = async (e) => {
    e.preventDefault();
    $('#passwordSubmit').disabled = true;
    try {
      const info = await pdfTools.analyzePdf(it.file, input.value);
      it.pdf.password = input.value;
      it.pdf.needsPassword = false;
      it.pdf.encrypted = true;
      applyPdfInfo(it, info);
      it.status = 'ready';
      if (it.pdf.locked) setError(it, coded('PDF_LOCKED'));
      form.removeEventListener('submit', onSubmit);
      d.close();
      renderItem(it);
      updateRunButton();
    } catch (e2) {
      err.textContent = e2.code === 'PDF_WRONG_PASSWORD' ? 'That password didn’t work. Check it and try again.' : 'This PDF can’t be opened.';
      err.hidden = false;
    } finally { $('#passwordSubmit').disabled = false; }
  };
  form.addEventListener('submit', onSubmit);
  d.addEventListener('close', () => form.removeEventListener('submit', onSubmit), { once: true });
  d.showModal();
  input.focus();
}
let previewItem = null;
async function openPreview(it) {
  const d = $('#dlgPreview');
  const body = $('#previewBody');
  const r = it.result;
  previewItem = it;
  $('#previewTitle').textContent = r.name;
  const stats = [`<span>Before <b>${fmtBytes(it.size)}</b></span>`, `<span>After <b>${fmtBytes(r.size)}</b></span>`, `<span>Limit <b>${limitLabel(it.limit)}</b></span>`];
  if (r.width) stats.push(`<span>Size <b>${r.width} × ${r.height} px</b></span>`);
  if (r.pages) stats.push(`<span>Pages <b>${r.pages}</b></span>`);
  stats.push(`<span>Quality <b>${esc(r.quality)}</b></span>`);
  $('#previewStats').innerHTML = stats.join('');
  body.innerHTML = '';
  const tabs = $('#previewTabs');
  const openBtn = $('#previewOpen');
  if (r.mode === 'photo') {
    tabs.hidden = true; openBtn.hidden = true;
    const before = URL.createObjectURL(it.file);
    body.innerHTML = `<div class="compare" style="--ar:${r.width} / ${r.height}"><img class="before" src="${before}" alt="Original"><img class="after" src="${r.url}" alt="Result"><div class="handle"></div><span class="tag l">Original</span><span class="tag r">Result</span><input type="range" min="0" max="100" value="50" aria-label="Compare original and result"></div><p class="hint" style="margin:10px 0 0">Drag across the picture to compare. The right side is the result.</p>`;
    const cmp = $('.compare', body);
    $('input', cmp).addEventListener('input', (e) => cmp.style.setProperty('--cut', `${e.target.value}%`));
    d.addEventListener('close', () => URL.revokeObjectURL(before), { once: true });
  } else {
    tabs.hidden = false; openBtn.hidden = false;
    openBtn.onclick = () => window.open(r.url, '_blank', 'noopener');
    const show = async (which) => {
      for (const t of $$('.tab', tabs)) t.setAttribute('aria-selected', String(t.dataset.tab === which));
      body.innerHTML = '<div class="pages"></div>';
      const pages = $('.pages', body);
      try {
        const blob = which === 'result' ? r.blob : it.file;
        const info = await pdfTools.renderPreview(blob, pages, { password: which === 'result' ? undefined : it.pdf.password, maxPages: 6 });
        if (info.pages > info.shown) pages.insertAdjacentHTML('beforeend', `<p class="more">Showing the first ${info.shown} of ${info.pages} pages. Use “Open full PDF” to see them all.</p>`);
      } catch { pages.innerHTML = '<p class="hint">This file can’t be previewed here. Use “Open full PDF”.</p>'; }
    };
    tabs.onclick = (e) => { const t = e.target.closest('.tab'); if (t) show(t.dataset.tab); };
    show('result');
  }
  d.showModal();
}
$('#previewSave').addEventListener('click', () => { if (previewItem) saveItem(previewItem); });
$('#btnHelp').addEventListener('click', () => $('#dlgHelp').showModal());
$('#btnSettings').addEventListener('click', () => $('#dlgSettings').showModal());
$('#btnResetSettings').addEventListener('click', () => {
  settings = { ...DEFAULTS };
  saveSettings();
  applyTheme();
  for (const node of $$('[data-setting]')) { const k = node.dataset.setting; if (node.type === 'checkbox') node.checked = !!settings[k]; else node.value = settings[k] ?? ''; }
  syncOptionVisibility();
  renderLimit();
  renderAll();
  toast('Settings reset');
});

// ---------- input: picker, drag & drop, paste, file handler ----------
$('#btnChoose').addEventListener('click', () => el.fileInput.click());
$('#btnAddMore').addEventListener('click', () => el.fileInput.click());
$('#btnClear').addEventListener('click', async () => {
  if (running) return;
  const choice = itemList().length > 1 ? await confirmDialog({ title: 'Remove all files from the list?', body: '<p>Files you already saved stay on your PC.</p>', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Clear all', value: 'go', primary: true }] }) : 'go';
  if (choice !== 'go') return;
  for (const it of itemList()) removeItem(it);
});
el.fileInput.addEventListener('change', () => { addFiles([...el.fileInput.files]); el.fileInput.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); el.dropOverlay.hidden = !el.dropzone.hidden; });
window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); el.dropOverlay.hidden = true; } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('dragging'); el.dropOverlay.hidden = true;
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) addFiles(files);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData && e.clipboardData.files ? e.clipboardData.files : [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image ${i + 1}.${EXT_FOR[f.type] || 'png'}`, { type: f.type }))));
});
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const files = [];
    for (const h of params.files || []) { try { files.push(await h.getFile()); } catch { /* skip */ } }
    if (files.length) addFiles(files);
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); el.fileInput.click(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !el.btnRun.disabled) { e.preventDefault(); el.btnRun.click(); }
});

// ---------- toast, offline, boot ----------
let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready. Restart Make It Fit to use it.'); });
      });
    } catch { /* offline support unavailable */ }
  });
}
applyTheme();
bindSettings();
renderLimit();
renderAll();
$('#versionLabel').textContent = `Version ${VERSION}`;
window.__mif = { items, order, settings, runItems: () => runItems(itemList()), itemList };
