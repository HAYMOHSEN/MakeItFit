// Make It Fit — PDF engine (runs inside the processing worker).
// Shrinks a PDF by cleaning unused data and recompressing the pictures inside it.
// Text, vector graphics, links and form fields are kept exactly as they are.

import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFNumber,
  PDFString, PDFHexString, PDFStream, PDFHeader, PDFBool, ParseSpeeds,
  decodePDFRawStream, EncryptedPDFError,
} from '../lib/pdf-lib.min.js';
import { EngineError, jpegInfo } from './image-engine.js';

const N = (s) => PDFName.of(s);
const K = {
  Type: N('Type'), Subtype: N('Subtype'), Image: N('Image'), Form: N('Form'), XObject: N('XObject'),
  Filter: N('Filter'), DecodeParms: N('DecodeParms'), Width: N('Width'), Height: N('Height'),
  BPC: N('BitsPerComponent'), ColorSpace: N('ColorSpace'), Decode: N('Decode'), ImageMask: N('ImageMask'),
  SMask: N('SMask'), Mask: N('Mask'), Resources: N('Resources'), Matrix: N('Matrix'), Length: N('Length'),
  Metadata: N('Metadata'), PieceInfo: N('PieceInfo'), Thumb: N('Thumb'), DCTDecode: N('DCTDecode'),
  FlateDecode: N('FlateDecode'), DeviceRGB: N('DeviceRGB'), Intent: N('Intent'), Interpolate: N('Interpolate'),
  Predictor: N('Predictor'), Colors: N('Colors'), Columns: N('Columns'), ColorTransform: N('ColorTransform'),
  Contents: N('Contents'), ByteRange: N('ByteRange'), N: N('N'), Alternate: N('Alternate'),
};

// Ladder of (max dpi, JPEG quality). Index 7 (100 dpi) is the "still clearly readable" floor.
export const PDF_STEPS = [
  [300, 0.85], [240, 0.82], [200, 0.8], [170, 0.76], [150, 0.72], [130, 0.68], [115, 0.64],
  [100, 0.6], [90, 0.55], [80, 0.5], [72, 0.45], [60, 0.4], [50, 0.35],
];
export const PDF_FLOOR = 7;
export const PDF_FLOOR_STRONG = PDF_STEPS.length - 1;

let ORIENT_NONE = 'none';

const num = (o) => (o instanceof PDFNumber ? o.asNumber() : typeof o === 'number' ? o : NaN);

// ---------- quick inspection (no full parse) ----------

function hasBytes(bytes, needle, from = 0) {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  outer: for (let i = bytes.indexOf(first, from); i !== -1 && i <= bytes.length - n; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

export function quickInspect(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  return {
    isPdf: head.includes('%PDF-'),
    signed: hasBytes(bytes, '/ByteRange'),
    encrypted: hasBytes(bytes, '/Encrypt', Math.max(0, bytes.length - 262144)) || hasBytes(bytes, '/Encrypt '),
    pdfa: hasBytes(bytes, 'pdfaid:part'),
  };
}

// ---------- loading ----------

async function loadDoc(bytes) {
  try {
    return await PDFDocument.load(bytes, {
      updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false, parseSpeed: ParseSpeeds.Fastest,
    });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(String(e && e.message))) throw new EngineError('PDF_ENCRYPTED');
    throw new EngineError('PDF_DAMAGED', e && e.message);
  }
}

function rawBytes(stream) {
  if (!(stream instanceof PDFRawStream)) return null;
  if (!stream.dict.get(K.Filter)) return stream.contents;
  try { return decodePDFRawStream(stream).decode(); } catch { return null; }
}

function detectPdfA(doc) {
  try {
    const md = doc.catalog.lookup(K.Metadata);
    const b = rawBytes(md);
    if (!b) return null;
    const s = new TextDecoder('utf-8').decode(b);
    const m = s.match(/pdfaid:part\s*(?:=\s*["']|>)\s*(\d)/);
    return m ? { part: Number(m[1]) } : null;
  } catch { return null; }
}

// ---------- lossless cleanup ----------

function removeEditorData(doc) {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!d) continue;
    if (d.has(K.PieceInfo)) d.delete(K.PieceInfo);
    if (d.has(K.Thumb) && d.get(K.Type) === N('Page')) d.delete(K.Thumb);
  }
  doc.catalog.delete(K.PieceInfo);
}

function removePrivateInfo(doc) {
  doc.context.trailerInfo.Info = undefined;
  doc.catalog.delete(K.Metadata);
}

function fnv(bytes, h = 2166136261) {
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

function replaceRefs(value, map) {
  if (value instanceof PDFDict) {
    for (const [k, v] of value.entries()) {
      if (v instanceof PDFRef && map.has(v.tag)) value.set(k, map.get(v.tag));
      else if (v instanceof PDFDict || v instanceof PDFArray) replaceRefs(v, map);
    }
  } else if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) {
      const v = value.get(i);
      if (v instanceof PDFRef && map.has(v.tag)) value.set(i, map.get(v.tag));
      else if (v instanceof PDFDict || v instanceof PDFArray) replaceRefs(v, map);
    }
  }
}

// Merge streams that are byte-for-byte identical (common in office exports with repeated logos).
function dedupeStreams(doc) {
  const ctx = doc.context;
  const groups = new Map();
  const map = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 512) continue;
    const dictStr = obj.dict.toString();
    const key = `${obj.contents.length}:${fnv(obj.contents)}:${dictStr.length}`;
    const list = groups.get(key) || [];
    const twin = list.find((x) => x.dictStr === dictStr && sameBytes(x.obj.contents, obj.contents));
    if (twin) map.set(ref.tag, twin.ref);
    else { list.push({ ref, obj, dictStr }); groups.set(key, list); }
  }
  if (!map.size) return 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict || obj instanceof PDFArray) replaceRefs(obj, map);
    else if (obj instanceof PDFStream) replaceRefs(obj.dict, map);
  }
  const t = ctx.trailerInfo;
  if (t.Info instanceof PDFDict) replaceRefs(t.Info, map);
  return map.size;
}

function collectGarbage(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [];
  const t = ctx.trailerInfo;
  for (const k of ['Root', 'Info', 'Encrypt']) if (t[k]) stack.push(t[k]);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const v = ctx.lookup(o);
      if (v !== undefined) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) { ctx.delete(ref); removed++; }
  }
  return removed;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(await out);
}

const WEAK_FILTERS = new Set(['ASCIIHexDecode', 'ASCII85Decode', 'LZWDecode', 'RunLengthDecode']);

// Compress streams that were stored uncompressed or with weak/legacy filters.
async function recompressLossless(doc) {
  const ctx = doc.context;
  let saved = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 256) continue;
    const d = obj.dict;
    if (d.get(K.Type) === K.Metadata) continue;
    const names = filterNames(ctx, d.get(K.Filter));
    let data = null;
    if (!names.length) data = obj.contents;
    else {
      if (d.get(K.DecodeParms)) continue;
      const last = names[names.length - 1];
      if (last === 'DCTDecode' && names.length > 1 && names.slice(0, -1).every((x) => x === 'ASCII85Decode' || x === 'ASCIIHexDecode')) {
        // JPEG wrapped in a text encoding: unwrap it (lossless, about 20% smaller).
        try {
          const tmp = PDFRawStream.of(ctx.obj({ Filter: names.slice(0, -1).map((x) => N(x)) }), obj.contents);
          const jpeg = decodePDFRawStream(tmp).decode();
          if (jpegInfo(jpeg)) {
            const nd = d.clone(ctx);
            nd.set(K.Filter, K.DCTDecode);
            ctx.assign(ref, PDFRawStream.of(nd, jpeg.slice()));
            saved += obj.contents.length - jpeg.length;
          }
        } catch { /* keep as is */ }
        continue;
      }
      if (!names.every((x) => WEAK_FILTERS.has(x) || x === 'FlateDecode') || names.every((x) => x === 'FlateDecode')) continue;
      try { data = decodePDFRawStream(obj).decode(); } catch { continue; }
    }
    const z = await deflate(data);
    if (z.length < obj.contents.length * 0.9) {
      const nd = d.clone(ctx);
      nd.set(K.Filter, K.FlateDecode);
      nd.delete(K.DecodeParms);
      ctx.assign(ref, PDFRawStream.of(nd, z));
      saved += obj.contents.length - z.length;
    }
  }
  return saved;
}

// ---------- images ----------

function filterNames(ctx, f) {
  f = ctx.lookup(f);
  if (!f) return [];
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => { const v = ctx.lookup(x); return v instanceof PDFName ? v.decodeText() : '?'; });
  return ['?'];
}

function resolveCS(ctx, cs, depth = 0) {
  cs = ctx.lookup(cs);
  if (!cs || depth > 3) return null;
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    if (n === 'DeviceGray' || n === 'G') return { kind: 'gray', comps: 1 };
    if (n === 'DeviceRGB' || n === 'RGB') return { kind: 'rgb', comps: 3 };
    if (n === 'DeviceCMYK' || n === 'CMYK') return { kind: 'cmyk', comps: 4 };
    return null;
  }
  if (cs instanceof PDFArray && cs.size() > 0) {
    const t = ctx.lookup(cs.get(0));
    const name = t instanceof PDFName ? t.decodeText() : '';
    if (cs.size() === 1) return resolveCS(ctx, t, depth + 1);
    if (name === 'ICCBased') {
      const s = ctx.lookup(cs.get(1));
      const n = s instanceof PDFStream ? num(ctx.lookup(s.dict.get(K.N))) : NaN;
      if (n === 1) return { kind: 'gray', comps: 1 };
      if (n === 3) return { kind: 'rgb', comps: 3 };
      if (n === 4) return { kind: 'cmyk', comps: 4 };
      return null;
    }
    if (name === 'CalGray') return { kind: 'gray', comps: 1 };
    if (name === 'CalRGB') return { kind: 'rgb', comps: 3 };
    if (name === 'Indexed' || name === 'I') {
      const base = resolveCS(ctx, cs.get(1), depth + 1);
      if (!base || base.kind === 'indexed') return null;
      const hival = num(ctx.lookup(cs.get(2)));
      const lk = ctx.lookup(cs.get(3));
      let lookup = null;
      if (lk instanceof PDFString || lk instanceof PDFHexString) lookup = lk.asBytes();
      else if (lk instanceof PDFRawStream) lookup = rawBytes(lk);
      if (!lookup || !(hival >= 0) || lookup.length < (hival + 1) * base.comps) return null;
      return { kind: 'indexed', comps: 1, base, hival, lookup };
    }
  }
  return null;
}

function isDefaultDecode(ctx, arr, comps, bpc, indexed) {
  arr = ctx.lookup(arr);
  if (!arr) return true;
  if (!(arr instanceof PDFArray)) return false;
  const v = arr.asArray().map((x) => num(ctx.lookup(x)));
  if (indexed) return v.length === 2 && v[0] === 0 && v[1] === (1 << bpc) - 1;
  if (v.length !== comps * 2) return false;
  for (let i = 0; i < comps; i++) if (v[2 * i] !== 0 || v[2 * i + 1] !== 1) return false;
  return true;
}

function analyzeImage(ctx, ref, obj) {
  const d = obj.dict;
  const im = ctx.lookup(d.get(K.ImageMask));
  if (im instanceof PDFBool && im.asBoolean()) return null;
  const w = num(ctx.lookup(d.get(K.Width)));
  const h = num(ctx.lookup(d.get(K.Height)));
  if (!(w > 0 && h > 0) || w * h < 4096) return null;
  const len = obj.contents.length;
  if (len < 12 * 1024) return null;
  if (ctx.lookup(d.get(K.Mask)) instanceof PDFArray) return null; // colour-key masking needs exact colours
  const filters = filterNames(ctx, d.get(K.Filter));
  const last = filters[filters.length - 1];
  if (last === 'DCTDecode') {
    if (filters.length !== 1) return null;
    const parms = ctx.lookup(d.get(K.DecodeParms));
    if (parms instanceof PDFDict && parms.get(K.ColorTransform)) return null;
    const info = jpegInfo(obj.contents);
    if (!info || !info.components) return null;
    if (info.components === 2 || info.components > 4) return null;
    if (info.components === 4 && !info.adobe) return null;
    if (!isDefaultDecode(ctx, d.get(K.Decode), info.components, 8, false)) return null;
    return { ref, obj, w, h, kind: 'jpeg', bytes: len };
  }
  if (filters.some((f) => !(f === 'FlateDecode' || WEAK_FILTERS.has(f)))) return null; // JPX, JBIG2, CCITT, Crypt
  const bpc = num(ctx.lookup(d.get(K.BPC))) || 8;
  if (![1, 2, 4, 8, 16].includes(bpc)) return null;
  const cs = resolveCS(ctx, d.get(K.ColorSpace));
  if (!cs || (cs.kind === 'indexed' && bpc === 16)) return null;
  if (!isDefaultDecode(ctx, d.get(K.Decode), cs.comps, bpc, cs.kind === 'indexed')) return null;
  if (bpc === 1 && cs.kind === 'gray') return null; // black & white scans are already compact
  let parms = ctx.lookup(d.get(K.DecodeParms));
  if (parms instanceof PDFArray) parms = ctx.lookup(parms.get(parms.size() - 1));
  let pred = null;
  if (parms instanceof PDFDict) {
    const p = num(ctx.lookup(parms.get(K.Predictor))) || 1;
    if (p > 1) {
      pred = {
        predictor: p,
        colors: num(ctx.lookup(parms.get(K.Colors))) || 1,
        bpc: num(ctx.lookup(parms.get(K.BPC))) || 8,
        columns: num(ctx.lookup(parms.get(K.Columns))) || 1,
      };
      if (pred.predictor === 2 && pred.bpc !== 8) return null;
    }
  }
  return { ref, obj, w, h, kind: 'raw', bytes: len, bpc, cs, pred };
}

function collectImages(doc) {
  const ctx = doc.context;
  const masks = new Set();
  const found = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const sm = obj.dict.get(K.SMask);
    if (sm instanceof PDFRef) masks.add(sm.tag);
    const mk = obj.dict.get(K.Mask);
    if (mk instanceof PDFRef) masks.add(mk.tag);
    if (obj.dict.get(K.Subtype) === K.Image) found.push([ref, obj]);
  }
  const out = [];
  for (const [ref, obj] of found) {
    if (masks.has(ref.tag)) continue;
    const a = analyzeImage(ctx, ref, obj);
    if (a) out.push(a);
  }
  return out;
}

function unpredictPNG(data, colors, bpc, columns) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = prev[i];
      let v;
      if (ft === 1) v = raw + left;
      else if (ft === 2) v = raw + up;
      else if (ft === 3) v = raw + ((left + up) >> 1);
      else if (ft === 4) {
        const ul = i >= bpp ? prev[i - bpp] : 0;
        const p = left + up - ul;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      } else v = raw;
      out[dst + i] = v & 255;
    }
    prev = out.subarray(dst, dst + rowLen);
  }
  return out;
}

function unpredictTIFF(data, colors, columns) {
  const rowLen = colors * columns;
  const out = new Uint8Array(data);
  for (let r = 0; r + rowLen <= out.length; r += rowLen) {
    for (let i = colors; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - colors]) & 255;
  }
  return out;
}

const cmyk = (c, m, y, k) => [255 - Math.min(255, c + k), 255 - Math.min(255, m + k), 255 - Math.min(255, y + k)];

function rawToImageData(img) {
  let data = rawBytes(img.obj);
  if (!data) return null;
  if (img.pred) {
    const p = img.pred;
    if (p.predictor >= 10) data = unpredictPNG(data, p.colors, p.bpc, p.columns);
    else if (p.predictor === 2) data = unpredictTIFF(data, p.colors, p.columns);
  }
  const { w, h, bpc, cs } = img;
  const comps = cs.comps;
  const rowBytes = Math.ceil((w * comps * bpc) / 8);
  if (data.length < rowBytes * h * 0.97) return null;
  const f = Math.max(1, Math.ceil(Math.sqrt((w * h) / 36e6)));
  const ow = Math.ceil(w / f), oh = Math.ceil(h / f);
  const out = new Uint8ClampedArray(ow * oh * 4).fill(255);
  const maxv = (1 << bpc) - 1;
  const sample = (row, idx) => {
    if (bpc === 8) return data[row + idx];
    if (bpc === 16) return data[row + idx * 2];
    const bit = idx * bpc;
    return (data[row + (bit >> 3)] >> (8 - bpc - (bit & 7))) & maxv;
  };
  const to255 = bpc === 8 || bpc === 16 ? (v) => v : (v) => Math.round((v * 255) / maxv);
  for (let y = 0, oy = 0; y < h; y += f, oy++) {
    const row = y * rowBytes;
    if (row + rowBytes > data.length) break;
    let o = oy * ow * 4;
    for (let x = 0; x < w; x += f, o += 4) {
      let r, g, b;
      if (cs.kind === 'indexed') {
        let v = sample(row, x);
        if (v > cs.hival) v = cs.hival;
        const L = cs.lookup, bc = cs.base.comps, q = v * bc;
        if (bc === 1) r = g = b = L[q];
        else if (bc === 3) { r = L[q]; g = L[q + 1]; b = L[q + 2]; }
        else [r, g, b] = cmyk(L[q], L[q + 1], L[q + 2], L[q + 3]);
      } else if (comps === 1) {
        r = g = b = to255(sample(row, x));
      } else if (comps === 3) {
        const i = x * 3;
        r = to255(sample(row, i)); g = to255(sample(row, i + 1)); b = to255(sample(row, i + 2));
      } else {
        const i = x * 4;
        [r, g, b] = cmyk(to255(sample(row, i)), to255(sample(row, i + 1)), to255(sample(row, i + 2)), to255(sample(row, i + 3)));
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return new ImageData(out, ow, oh);
}

async function decodeImage(img, tw, th) {
  if (img.kind === 'jpeg') {
    const blob = new Blob([img.obj.contents], { type: 'image/jpeg' });
    const opts = { colorSpaceConversion: 'none', resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' };
    try {
      return await createImageBitmap(blob, { ...opts, imageOrientation: ORIENT_NONE });
    } catch (e) {
      if (e instanceof TypeError && ORIENT_NONE === 'none') {
        ORIENT_NONE = 'from-image';
        return createImageBitmap(blob, { ...opts, imageOrientation: ORIENT_NONE });
      }
      throw e;
    }
  }
  const id = rawToImageData(img);
  if (!id) throw new Error('raw decode failed');
  return createImageBitmap(id, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
}

async function encodeBitmap(bmp, tw, th, q) {
  const c = new OffscreenCanvas(tw, th);
  const g = c.getContext('2d', { alpha: false });
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, tw, th);
  if (bmp.width === tw && bmp.height === th) g.drawImage(bmp, 0, 0);
  else {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, tw, th);
  }
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: q });
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- where images appear on the page (to know their real resolution) ----------

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DL = new Uint8Array(256);
for (const ch of '()<>[]{}/%') DL[ch.charCodeAt(0)] = 1;

const mul = (m, c) => [
  m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
];

function decodeNameToken(b, s, e) {
  let out = '';
  for (let i = s; i < e; i++) {
    if (b[i] === 35 && i + 2 < e) { out += String.fromCharCode(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16)); i += 2; }
    else out += String.fromCharCode(b[i]);
  }
  return out;
}

function skipInlineImage(b, i) {
  const n = b.length;
  while (i < n - 1) {
    if (b[i] === 73 && b[i + 1] === 68 && (WS[b[i - 1]] || DL[b[i - 1]]) && (i + 2 >= n || WS[b[i + 2]])) { i += 3; break; }
    i++;
  }
  while (i < n - 2) {
    if (WS[b[i]] && b[i + 1] === 69 && b[i + 2] === 73 && (i + 3 >= n || WS[b[i + 3]] || DL[b[i + 3]])) return i + 3;
    i++;
  }
  return n;
}

class PlacementScanner {
  constructor(ctx) {
    this.ctx = ctx;
    this.found = new Map();
    this.budget = 25e6;
    this.formCache = new Map();
  }
  record(tag, wIn, hIn) {
    const p = this.found.get(tag);
    if (!p) this.found.set(tag, { w: wIn, h: hIn });
    else { p.w = Math.max(p.w, wIn); p.h = Math.max(p.h, hIn); }
  }
  doXObject(name, res, m, depth) {
    const ctx = this.ctx;
    const xo = res ? ctx.lookup(res.get(K.XObject)) : null;
    if (!(xo instanceof PDFDict)) return;
    const ref = xo.get(N(name));
    const obj = ctx.lookup(ref);
    if (!(obj instanceof PDFStream)) return;
    const sub = obj.dict.get(K.Subtype);
    if (sub === K.Image) {
      if (ref instanceof PDFRef) this.record(ref.tag, Math.hypot(m[0], m[1]) / 72, Math.hypot(m[2], m[3]) / 72);
    } else if (sub === K.Form && depth < 10) {
      const fm = ctx.lookup(obj.dict.get(K.Matrix));
      let mat = [1, 0, 0, 1, 0, 0];
      if (fm instanceof PDFArray && fm.size() === 6) {
        const v = fm.asArray().map((x) => num(ctx.lookup(x)));
        if (v.every(Number.isFinite)) mat = v;
      }
      const fres = ctx.lookup(obj.dict.get(K.Resources));
      let content = ref instanceof PDFRef ? this.formCache.get(ref.tag) : undefined;
      if (content === undefined) {
        content = rawBytes(obj);
        if (ref instanceof PDFRef) this.formCache.set(ref.tag, content);
      }
      if (content) this.run(content, fres instanceof PDFDict ? fres : res, mul(mat, m), depth + 1);
    }
  }
  run(b, res, ctm, depth) {
    const stack = [];
    const saved = [];
    let m = ctm;
    let i = 0;
    const n = b.length;
    while (i < n) {
      if (--this.budget <= 0) throw new Error('budget');
      const c = b[i];
      if (WS[c]) { i++; continue; }
      if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      if (c === 47) {
        let j = i + 1;
        while (j < n && !WS[b[j]] && !DL[b[j]]) j++;
        stack.push({ name: decodeNameToken(b, i + 1, j) });
        i = j; continue;
      }
      if (c === 40) {
        let lvl = 1, j = i + 1;
        while (j < n && lvl > 0) {
          const d = b[j];
          if (d === 92) { j += 2; continue; }
          if (d === 40) lvl++; else if (d === 41) lvl--;
          j++;
        }
        stack.push(null); i = j; continue;
      }
      if (c === 60) {
        if (b[i + 1] === 60) { i += 2; continue; }
        let j = i + 1;
        while (j < n && b[j] !== 62) j++;
        stack.push(null); i = j + 1; continue;
      }
      if (c === 62 || c === 91 || c === 93 || c === 123 || c === 125) { i++; continue; }
      if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
        let j = i + 1;
        while (j < n && ((b[j] >= 48 && b[j] <= 57) || b[j] === 46)) j++;
        let s = '';
        for (let k = i; k < j; k++) s += String.fromCharCode(b[k]);
        stack.push(parseFloat(s));
        i = j; continue;
      }
      let j = i;
      while (j < n && !WS[b[j]] && !DL[b[j]]) j++;
      if (j === i) { i++; continue; }
      const len = j - i;
      const c0 = b[i];
      i = j;
      if (len === 1 && c0 === 113) saved.push(m); // q
      else if (len === 1 && c0 === 81) { if (saved.length) m = saved.pop(); } // Q
      else if (len === 2 && c0 === 99 && b[j - 1] === 109) { // cm
        const k = stack.length;
        if (k >= 6) {
          const a = stack.slice(k - 6);
          if (a.every((x) => typeof x === 'number' && Number.isFinite(x))) m = mul(a, m);
        }
      } else if (len === 2 && c0 === 68 && b[j - 1] === 111) { // Do
        const t = stack[stack.length - 1];
        if (t && t.name) this.doXObject(t.name, res, m, depth);
      } else if (len === 2 && c0 === 66 && b[j - 1] === 73) { // BI
        i = skipInlineImage(b, i);
      }
      stack.length = 0;
    }
  }
}

function contentBytesOf(ctx, contents) {
  contents = ctx.lookup(contents);
  if (contents instanceof PDFStream) return rawBytes(contents);
  if (contents instanceof PDFArray) {
    const parts = contents.asArray().map((r) => rawBytes(ctx.lookup(r))).filter(Boolean);
    let total = 0;
    for (const p of parts) total += p.length + 1;
    const out = new Uint8Array(total).fill(10);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length + 1; }
    return out;
  }
  return null;
}

function scanPlacements(doc) {
  const ctx = doc.context;
  const sc = new PlacementScanner(ctx);
  try {
    for (const page of doc.getPages()) {
      const node = page.node;
      const res = node.Resources();
      const content = contentBytesOf(ctx, node.get(K.Contents));
      if (content) sc.run(content, res, [1, 0, 0, 1, 0, 0], 0);
    }
  } catch {
    // Unusual content: fall back to page-size estimates for anything not found.
  }
  return sc.found;
}

function pageSizesInches(doc) {
  let w = 0, h = 0;
  for (const p of doc.getPages()) {
    const s = p.getSize();
    w = Math.max(w, s.width / 72);
    h = Math.max(h, s.height / 72);
  }
  return { w: w || 8.5, h: h || 11 };
}

// ---------- the search ----------

function headerVersion(ctx) {
  const h = ctx.header;
  const v = parseFloat(`${h.major}.${h.minor}`);
  return Number.isFinite(v) ? v : 1.4;
}

export const pdfQualityLabel = (dpi) => (dpi >= 200 ? 'High' : dpi >= 130 ? 'Good' : dpi >= 100 ? 'Fair' : 'Low');

/**
 * o = { limit, strong, privacy }. Returns { bytes, fits, mode, quality, notes, stats }.
 * Throws EngineError PDF_ENCRYPTED / PDF_DAMAGED / VERIFY_FAILED.
 */
export async function shrinkPdf(input, o, report = () => {}) {
  const t0 = Date.now();
  report(0.02, 'Reading the PDF');
  const doc = await loadDoc(input);
  const ctx = doc.context;
  let pageCount = 0;
  try { pageCount = doc.getPageCount(); } catch { throw new EngineError('PDF_DAMAGED'); }
  if (!pageCount) throw new EngineError('PDF_DAMAGED');

  const pdfa = detectPdfA(doc);
  const useObjectStreams = !(pdfa && pdfa.part === 1);
  report(0.06, 'Removing unused data');
  removeEditorData(doc);
  if (o.privacy && !pdfa) removePrivateInfo(doc);
  const merged = dedupeStreams(doc);
  collectGarbage(doc);
  await recompressLossless(doc);
  if (useObjectStreams && headerVersion(ctx) < 1.5) ctx.header = PDFHeader.forVersion(1, 5);

  const save = () => doc.save({ useObjectStreams, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: Infinity });
  const notes = [];
  if (pdfa) notes.push('pdfa');
  if (merged) notes.push('merged');

  report(0.1, 'Measuring');
  const base = await save();
  const verify = async (bytes) => {
    try {
      const check = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
      return check.getPageCount() === pageCount;
    } catch { return false; }
  };
  const finish = async (bytes, extra) => {
    report(0.97, 'Checking the result');
    if (!(await verify(bytes))) throw new EngineError('VERIFY_FAILED');
    return { bytes, pages: pageCount, notes, ms: Date.now() - t0, ...extra };
  };

  if (base.length <= o.limit) {
    return finish(base, { fits: true, mode: 'lossless', quality: 'Original', changedImages: 0 });
  }

  const images = collectImages(doc);
  const imgTotal = images.reduce((s, x) => s + x.bytes, 0);
  if (!images.length || imgTotal < base.length * 0.05) {
    return finish(base, { fits: false, mode: 'lossless', quality: 'Original', changedImages: 0, reason: 'NO_IMAGES' });
  }

  const placements = scanPlacements(doc);
  const page = pageSizesInches(doc);
  for (const im of images) {
    const p = placements.get(im.ref.tag);
    if (p && p.w > 0.05 && p.h > 0.05) { im.dispW = p.w; im.dispH = p.h; im.placed = true; }
    else {
      const s = Math.max(Math.min(page.w / im.w, page.h / im.h), Math.min(page.h / im.w, page.w / im.h));
      im.dispW = im.w * s; im.dispH = im.h * s; im.placed = false;
    }
  }
  const scaleAt = (im, step) => {
    const dpi = PDF_STEPS[step][0];
    return Math.min(1, Math.max((dpi * im.dispW) / im.w, (dpi * im.dispH) / im.h));
  };
  const dims = (im, s) => [Math.max(1, Math.round(im.w * s)), Math.max(1, Math.round(im.h * s))];
  const maxStep = o.strong ? PDF_FLOOR_STRONG : PDF_FLOOR;
  const nonImage = Math.max(0, base.length - imgTotal);

  // Encode one image at a step; returns the new bytes or null when not worth it.
  const encodeAt = async (im, step, bmp) => {
    const s = scaleAt(im, step);
    const [tw, th] = dims(im, s);
    let own = false;
    if (!bmp) { bmp = await decodeImage(im, tw, th); own = true; }
    try {
      const out = await encodeBitmap(bmp, tw, th, PDF_STEPS[step][1]);
      const worth = im.kind === 'raw' ? out.length < im.bytes : out.length < im.bytes * 0.92;
      return worth ? { bytes: out, w: tw, h: th } : null;
    } finally { if (own) bmp.close(); }
  };

  // 1) Sample the biggest images at a few steps to predict the result size.
  report(0.14, 'Testing quality levels');
  const probe = [0, 2, 4, 6, 7, 9, 12].filter((s) => s <= maxStep);
  const sample = images.slice().sort((a, b) => b.bytes - a.bytes).slice(0, Math.min(4, images.length));
  const sampleCache = new Map();
  const est = new Map(probe.map((s) => [s, { orig: 0, out: 0 }]));
  let done = 0;
  for (const im of sample) {
    const s0 = scaleAt(im, probe[0]);
    const [w0, h0] = dims(im, s0);
    let bmp = null;
    try { bmp = await decodeImage(im, w0, h0); } catch { bmp = null; }
    for (const s of probe) {
      let r = null;
      if (bmp) {
        const sc = scaleAt(im, s);
        const [tw, th] = dims(im, sc);
        try {
          const small = tw === bmp.width && th === bmp.height ? bmp : await createImageBitmap(bmp, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
          const out = await encodeBitmap(small, tw, th, PDF_STEPS[s][1]);
          if (small !== bmp) small.close();
          const worth = im.kind === 'raw' ? out.length < im.bytes : out.length < im.bytes * 0.92;
          r = worth ? { bytes: out, w: tw, h: th } : null;
        } catch { r = null; }
      }
      sampleCache.set(`${im.ref.tag}|${s}`, r);
      const e = est.get(s);
      e.orig += im.bytes;
      e.out += r ? r.bytes.length : im.bytes;
      report(0.14 + (0.2 * ++done) / (sample.length * probe.length), 'Testing quality levels');
    }
    if (bmp) bmp.close();
  }
  const sampleTags = new Set(sample.map((x) => x.ref.tag));
  const ratioAt = (s) => {
    if (est.has(s)) { const e = est.get(s); return e.orig ? e.out / e.orig : 1; }
    let lo = probe[0], hi = probe[probe.length - 1];
    for (const p of probe) { if (p <= s) lo = p; if (p >= s && hi >= p) hi = p; }
    const a = ratioAt(lo), b = ratioAt(hi);
    if (hi === lo) return a;
    const t = (s - lo) / (hi - lo);
    return Math.exp(Math.log(Math.max(a, 1e-4)) * (1 - t) + Math.log(Math.max(b, 1e-4)) * t);
  };
  const predict = (s) => {
    let total = nonImage;
    const r = ratioAt(s);
    for (const im of images) {
      if (sampleTags.has(im.ref.tag) && sampleCache.has(`${im.ref.tag}|${s}`)) {
        const c = sampleCache.get(`${im.ref.tag}|${s}`);
        total += c ? c.bytes.length : im.bytes;
      } else total += im.bytes * r;
    }
    return total;
  };
  let step = maxStep;
  for (let s = 0; s <= maxStep; s++) if (predict(s) <= o.limit * 0.95) { step = s; break; }

  // 2) Full passes: encode every image at the chosen step, measure, adjust.
  const originals = images.map((im) => [im.ref, im.obj]);
  const restore = () => { for (const [ref, obj] of originals) ctx.assign(ref, obj); };
  const tried = new Map();
  let passIndex = 0;
  const fullPass = async (s) => {
    restore();
    let changed = 0;
    for (let k = 0; k < images.length; k++) {
      const im = images[k];
      report(0.36 + 0.55 * ((passIndex + k / images.length) / (passIndex + 1.6)), `Recompressing images (${k + 1} of ${images.length})`);
      const key = `${im.ref.tag}|${s}`;
      let r = sampleCache.has(key) ? sampleCache.get(key) : undefined;
      if (r === undefined) { try { r = await encodeAt(im, s); } catch { r = null; } }
      if (!r) continue;
      const dict = im.obj.dict.clone(ctx);
      for (const k2 of [K.Filter, K.DecodeParms, K.Decode, K.Length]) dict.delete(k2);
      if (o.privacy && !pdfa) dict.delete(K.Metadata);
      dict.set(K.Filter, K.DCTDecode);
      dict.set(K.Width, PDFNumber.of(r.w));
      dict.set(K.Height, PDFNumber.of(r.h));
      dict.set(K.BPC, PDFNumber.of(8));
      dict.set(K.ColorSpace, K.DeviceRGB);
      ctx.assign(im.ref, PDFRawStream.of(dict, r.bytes));
      changed++;
    }
    passIndex++;
    const bytes = await save();
    tried.set(s, { bytes, changed });
    return bytes;
  };

  let passes = 0;
  while (passes < 5) {
    const out = tried.has(step) ? tried.get(step).bytes : await fullPass(step);
    passes++;
    if (out.length <= o.limit) {
      const milder = step - 1;
      if (milder >= 0 && !tried.has(milder) && out.length < o.limit * 0.8) { step = milder; continue; }
      break;
    }
    if (step >= maxStep) break;
    const next = Math.min(maxStep, step + (out.length > o.limit * 1.35 ? 2 : 1));
    if (tried.has(next)) { step = next; if (tried.get(next).bytes.length > o.limit) break; continue; }
    step = next;
  }

  // Pick the mildest step that fits; otherwise the smallest result.
  let best = null;
  for (const [s, r] of [...tried.entries()].sort((a, b) => a[0] - b[0])) {
    if (r.bytes.length <= o.limit) { best = { s, ...r }; break; }
  }
  const fitsLimit = !!best;
  if (!best) {
    for (const [s, r] of tried.entries()) if (!best || r.bytes.length < best.bytes.length) best = { s, ...r };
  }
  if (!best || best.bytes.length >= base.length) {
    return finish(base, { fits: false, mode: 'lossless', quality: 'Original', changedImages: 0, reason: 'NO_GAIN' });
  }
  const dpi = PDF_STEPS[best.s][0];
  return finish(best.bytes, {
    fits: fitsLimit, mode: 'smart', quality: pdfQualityLabel(dpi), dpi, changedImages: best.changed,
    totalImages: images.length,
  });
}

// ---------- building PDFs from pictures (scan mode and combined photos) ----------

export async function buildPdfFromJpegs(pages, meta = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const p of pages) {
    const img = await doc.embedJpg(p.bytes);
    const page = doc.addPage([p.pageW, p.pageH]);
    page.drawImage(img, { x: p.x || 0, y: p.y || 0, width: p.drawW || p.pageW, height: p.drawH || p.pageH });
  }
  doc.setProducer('Make It Fit');
  doc.setCreator('Make It Fit');
  if (meta.title) doc.setTitle(meta.title);
  return doc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: Infinity });
}
