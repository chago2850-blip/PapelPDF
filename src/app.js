// PapelPDF — interfaz (proceso de renderizado)
import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { rotY, ownToUnrot, annotBBox, displaySize, uid, formatPageNumber } from './geometry.js';
import { recognizeCanvas, OCR_LANGS } from './ocr.js';
import { buildPdf } from './exporter.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
const PDFJS_OPTS = {
  cMapUrl: new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};
const L = window.PDFLib;
const api = window.papel;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
};

// ---------------------------------------------------------------- estado
const DEFAULT_COLORS = {
  highlight: '#ffd400', underline: '#dc2626', strike: '#dc2626', text: '#1f2937',
  note: '#f5c518', rect: '#2563eb', ellipse: '#2563eb', ink: '#b9441a', whiteout: '#ffffff', redact: '#000000',
};
const PALETTE = ['#ffd400', '#7ee081', '#7cc4ff', '#ff9ec7', '#dc2626', '#b9441a', '#2563eb', '#16a34a', '#1f2937', '#ffffff'];
const TOOL_HINTS = {
  select: 'Selecciona, mueve o redimensiona. Doble clic en un texto para editarlo. Supr para borrar.',
  highlight: 'Arrastra sobre el texto para resaltarlo.',
  underline: 'Arrastra sobre el texto para subrayarlo.',
  strike: 'Arrastra sobre el texto para tacharlo.',
  text: 'Haz clic donde quieras escribir.',
  note: 'Haz clic para dejar una nota.',
  rect: 'Arrastra para dibujar un rectángulo.',
  ellipse: 'Arrastra para dibujar una elipse.',
  ink: 'Dibuja a mano alzada.',
  place: 'Haz clic en la página para colocar. Esc para cancelar.',
  whiteout: 'Arrastra para tapar con blanco; luego escribe encima con Agregar texto.',
  redact: 'Arrastra sobre lo que quieras eliminar. Se borra de verdad al guardar.',
};

let doc = null;                // documento abierto
const pdfDocs = new Map();     // srcId -> PDFDocumentProxy
const pageCache = new Map();   // `${src}:${index}` -> PDFPageProxy
const widgetCache = new Map(); // `${src}:${index}` -> { widgets, notes }
const thumbCache = new Map();  // `${uid}:${rotate}` -> dataURL
let scale = 1;
let tool = 'select';
let style = { color: { ...DEFAULT_COLORS }, opacity: { highlight: 0.4 }, width: { rect: 2, ellipse: 2, ink: 2.5, underline: 1.5, strike: 1.5 }, size: 14 };
let selected = null;           // { uid, id }
let selPages = new Set();
let lastSelPage = null;
let currentPage = 0;
let editingText = null;
let pendingImage = null;       // dataURL a colocar
let history = { undo: [], redo: [] };
let propEditOpen = false;
const viewer = $('#viewer');

function newDoc() {
  return { sources: {}, pages: [], fields: {}, settings: { watermark: null, pageNumbers: null }, security: null, path: null, name: 'Sin título.pdf', dirty: false };
}

// ---------------------------------------------------------------- utilidades
function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}
function setDirty(v = true) {
  if (!doc) return;
  doc.dirty = v;
  $('#dirtyDot').hidden = !v;
  document.title = `${v ? '• ' : ''}${doc.name} — PapelPDF`;
}
window.__papelDirty = () => !!(doc && doc.dirty);

function snapshot() {
  return JSON.stringify({ pages: doc.pages, fields: doc.fields, settings: doc.settings });
}
function pushHistory() {
  if (!doc) return;
  history.undo.push(snapshot());
  if (history.undo.length > 100) history.undo.shift();
  history.redo = [];
  setDirty(true);
}
function restore(snap) {
  const s = JSON.parse(snap);
  const structural = s.pages.map((p) => p.uid + p.rotate).join() !== doc.pages.map((p) => p.uid + p.rotate).join();
  doc.pages = s.pages; doc.fields = s.fields; doc.settings = s.settings;
  selected = null;
  if (structural) { renderViewer(); renderThumbs(); } else { doc.pages.forEach(drawOverlay); drawAllDecor(); refreshFieldValues(); }
  renderProps();
  setDirty(true);
}
function undo() {
  if (isEditable(document.activeElement)) { document.execCommand('undo'); return; }
  if (!history.undo.length) return;
  history.redo.push(snapshot());
  restore(history.undo.pop());
}
function redo() {
  if (isEditable(document.activeElement)) { document.execCommand('redo'); return; }
  if (!history.redo.length) return;
  history.undo.push(snapshot());
  restore(history.redo.pop());
}
function isEditable(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
const pageByUid = (u) => doc.pages.find((p) => p.uid === u);
const findAnnot = (sel) => {
  if (!sel) return null;
  const p = pageByUid(sel.uid);
  return p ? p.annots.find((a) => a.id === sel.id) : null;
};
const baseName = (n) => (n || 'documento').replace(/\.pdf$/i, '');

// ---------------------------------------------------------------- carga
async function loadSource(file) {
  const id = uid();
  let password;
  for (;;) {
    try {
      const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: file.bytes.slice(), password });
      const pdf = await task.promise;
      pdfDocs.set(id, pdf);
      let bytes = file.bytes;
      let protectedWith = null;
      if (hasEncryptDict(bytes)) {
        // pdf-lib no escribe PDFs cifrados: se descifra con qpdf y se vuelve a cifrar al guardar.
        const r = await api.qpdf({ op: 'decrypt', bytes, password: password || '' });
        if (r.encrypted) { bytes = r.bytes; protectedWith = password || ''; }
      }
      const src = { id, kind: 'pdf', name: file.name, path: file.path || null, bytes, pageCount: pdf.numPages, protectedWith };
      const pages = [];
      for (let i = 0; i < pdf.numPages; i++) {
        const pg = await pdf.getPage(i + 1);
        pageCache.set(`${id}:${i}`, pg);
        const vp = pg.getViewport({ scale: 1, rotation: 0 });
        pages.push({ uid: uid(), src: id, index: i, rotate: ((pg.rotate % 360) + 360) % 360, w: vp.width, h: vp.height, view: pg.view.slice(), annots: [] });
      }
      return { src, pages };
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        password = await askPassword(file.name, err.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
        if (password == null) return null;
        continue;
      }
      toast(`No se pudo abrir «${file.name}»: ${err && err.message ? err.message : err}`, 'error');
      return null;
    }
  }
}

function hasEncryptDict(bytes) {
  const needle = [47, 69, 110, 99, 114, 121, 112, 116]; // "/Encrypt"
  const start = Math.max(0, bytes.length - 2_000_000);
  outer: for (let i = bytes.length - needle.length; i >= start; i--) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

async function openFiles(files, { merge = false } = {}) {
  if (!files || !files.length) return;
  if (doc && doc.dirty && !merge) {
    const r = await api.confirm({ message: 'Hay cambios sin guardar.', detail: '¿Abrir otro documento y descartar los cambios?', buttons: ['Descartar y abrir', 'Cancelar'] });
    if (r !== 0) return;
  }
  const d = newDoc();
  for (const f of files) {
    const loaded = await loadSource(f);
    if (!loaded) continue;
    d.sources[loaded.src.id] = loaded.src;
    d.pages.push(...loaded.pages);
  }
  if (!d.pages.length) return;
  const prot = Object.values(d.sources).find((x) => x.protectedWith != null);
  if (prot) {
    d.security = { user: prot.protectedWith, owner: prot.protectedWith, print: true, copy: true, modify: true };
    setTimeout(() => toast(prot.protectedWith ? 'PDF protegido: se guardará con la misma contraseña (cámbiala en Proteger).' : 'PDF con restricciones: se conservarán al guardar (cámbialas en Proteger).'), 600);
  }
  if (files.length === 1 && !merge) { d.path = files[0].path || null; d.name = files[0].name; }
  else d.name = 'Combinado.pdf';
  setDocument(d);
  if (files.length > 1 || merge) { setDirty(true); toast(`${files.length} archivos combinados · ${d.pages.length} páginas`); }
}

function setDocument(d) {
  doc = d;
  history = { undo: [], redo: [] };
  selected = null; selPages = new Set(); currentPage = 0; editingText = null;
  scanned = { count: 0, dismissed: false }; textCache.clear(); closeFind();
  $('#scanBanner').hidden = true;
  $('#home').hidden = true;
  $('#workspace').hidden = false;
  $('#docName').textContent = d.name;
  setDirty(d.dirty);
  setTool('select');
  requestAnimationFrame(() => { zoomFit(false); renderViewer(); renderThumbs(); renderProps(); updateFormInfo(); });
}

function closeDocument() {
  doc = null;
  for (const p of pdfDocs.values()) p.destroy();
  pdfDocs.clear(); pageCache.clear(); widgetCache.clear(); thumbCache.clear();
  $('#workspace').hidden = true;
  $('#home').hidden = false;
  document.title = 'PapelPDF';
  renderRecents();
}

function blankDocument() {
  const d = newDoc();
  d.pages.push({ uid: uid(), src: null, index: 0, rotate: 0, w: 612, h: 792, annots: [] });
  d.dirty = true;
  setDocument(d);
}

// ---------------------------------------------------------------- visor
let observer = null;
function renderViewer() {
  if (!doc) return;
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderPageCanvas(e.target.dataset.uid);
  }, { root: viewer, rootMargin: '600px 0px' });
  viewer.innerHTML = '';
  doc.pages.forEach((p) => {
    const ds = displaySize(p);
    const wrap = h('div', { class: 'page-wrap', 'data-uid': p.uid, style: { width: `${ds.w * scale}px`, height: `${ds.h * scale}px` } });
    const inner = h('div', { class: 'page-inner', style: { width: `${p.w * scale}px`, height: `${p.h * scale}px`, transform: `translate(-50%,-50%) rotate(${p.rotate}deg)` } });
    inner.append(h('canvas'), h('div', { class: 'textLayer', style: { '--scale-factor': String(scale) } }), h('div', { class: 'hits' }), h('div', { class: `fields${$('#highlightFields').checked ? ' hl' : ''}` }), h('div', { class: 'overlay' }));
    wrap.append(inner, h('div', { class: 'decor' }));
    viewer.append(wrap);
    wrap.__rendered = null;
    drawOverlay(p);
    drawDecor(p);
    drawHits(p);
    observer.observe(wrap);
  });
  updateStatus();
}

const wrapOf = (u) => viewer.querySelector(`.page-wrap[data-uid="${u}"]`);

async function renderPageCanvas(u) {
  const p = doc && pageByUid(u);
  const wrap = wrapOf(u);
  if (!p || !wrap) return;
  const key = `${scale}`;
  if (wrap.__rendered === key) return;
  wrap.__rendered = key;
  const canvas = $('canvas', wrap);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(p.w * scale * dpr);
  canvas.height = Math.round(p.h * scale * dpr);
  const ctx = canvas.getContext('2d');
  if (!p.src) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (p.image) ctx.drawImage(await loadImg(p.image), 0, 0, canvas.width, canvas.height);
    renderTextLayer(p, wrap, null);
    return;
  }
  const pg = await getPage(p.src, p.index);
  if (wrap.__task) { try { wrap.__task.cancel(); } catch {} }
  const vp = pg.getViewport({ scale: scale * dpr, rotation: 0 });
  const task = pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
  wrap.__task = task;
  try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
  await renderFields(p, wrap);
  await renderTextLayer(p, wrap, pg);
}

async function getPage(src, index) {
  const k = `${src}:${index}`;
  if (!pageCache.has(k)) pageCache.set(k, await pdfDocs.get(src).getPage(index + 1));
  return pageCache.get(k);
}

// ---- formularios (S06)
async function getWidgets(p) {
  const k = `${p.src}:${p.index}`;
  if (!widgetCache.has(k)) {
    const pg = await getPage(p.src, p.index);
    const all = await pg.getAnnotations({ intent: 'display' });
    widgetCache.set(k, {
      widgets: all.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && ['Tx', 'Btn', 'Ch'].includes(a.fieldType) && !a.pushButton),
      notes: all.filter((a) => a.subtype === 'Text'),
    });
  }
  return widgetCache.get(k);
}
function initialValue(w) {
  if (w.checkBox) return w.fieldValue && w.fieldValue !== 'Off' && (w.exportValue ? w.fieldValue === w.exportValue : true);
  if (w.radioButton) return w.fieldValue === w.buttonValue ? w.buttonValue : null;
  if (Array.isArray(w.fieldValue)) return w.fieldValue[0] ?? '';
  return w.fieldValue ?? '';
}
function fieldValue(src, w) {
  const vals = doc.fields[src] || {};
  if (Object.prototype.hasOwnProperty.call(vals, w.fieldName)) {
    const v = vals[w.fieldName];
    if (w.radioButton) return v === w.buttonValue;
    return v;
  }
  return w.radioButton ? initialValue(w) === w.buttonValue : initialValue(w);
}
function setField(src, name, value) {
  pushHistory();
  (doc.fields[src] ||= {})[name] = value;
  // otros widgets del mismo campo (p. ej. radios o copias)
  refreshFieldValues(name);
}
async function renderFields(p, wrap) {
  if (!p.src) return;
  const layer = $('.fields', wrap);
  const { widgets, notes } = await getWidgets(p);
  layer.innerHTML = '';
  const v = p.view;
  for (const w of widgets) {
    const [x1, y1, x2, y2] = w.rect;
    const style = { left: `${(x1 - v[0]) * scale}px`, top: `${(v[3] - y2) * scale}px`, width: `${(x2 - x1) * scale}px`, height: `${(y2 - y1) * scale}px`, fontSize: `${Math.max(8, Math.min((y2 - y1) * 0.62, w.textFormat?.fontSize || 14)) * scale}px` };
    let el;
    const common = { class: 'fld', 'data-name': w.fieldName, title: w.alternativeText || w.fieldName, disabled: w.readOnly || false };
    if (w.checkBox) {
      el = h('input', { ...common, type: 'checkbox', style });
      el.addEventListener('change', () => setField(p.src, w.fieldName, el.checked));
    } else if (w.radioButton) {
      el = h('input', { ...common, type: 'radio', name: `${p.src}:${w.fieldName}`, style, 'data-value': w.buttonValue });
      el.addEventListener('change', () => el.checked && setField(p.src, w.fieldName, w.buttonValue));
    } else if (w.fieldType === 'Ch') {
      el = h('select', { ...common, style });
      el.append(h('option', { value: '' }, ''));
      for (const o of w.options || []) el.append(h('option', { value: o.exportValue ?? o.displayValue }, o.displayValue ?? o.exportValue));
      el.addEventListener('change', () => setField(p.src, w.fieldName, el.value));
    } else {
      el = w.multiLine ? h('textarea', { ...common, style }) : h('input', { ...common, type: w.password ? 'password' : 'text', style });
      if (w.maxLen) el.maxLength = w.maxLen;
      el.addEventListener('change', () => setField(p.src, w.fieldName, el.value));
    }
    el.__w = w; el.__src = p.src;
    layer.append(el);
  }
  for (const n of notes) {
    const [x1, , , y2] = n.rect;
    layer.append(h('div', { class: 'pdf-note', title: (n.titleObj?.str ? n.titleObj.str + ': ' : '') + (n.contentsObj?.str || ''), style: { left: `${(x1 - v[0]) * scale}px`, top: `${(v[3] - y2) * scale}px`, pointerEvents: 'auto' } }));
  }
  refreshFieldValues(null, layer);
}
function refreshFieldValues(onlyName = null, root = viewer) {
  for (const el of $$('.fld', root)) {
    const w = el.__w;
    if (!w || (onlyName && w.fieldName !== onlyName)) continue;
    const val = fieldValue(el.__src, w);
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!val;
    else if (document.activeElement !== el) el.value = val ?? '';
  }
}
async function updateFormInfo() {
  if (!doc) return;
  let count = 0;
  for (const p of doc.pages.slice(0, 200)) if (p.src) count += (await getWidgets(p)).widgets.length;
  $('#formInfo').textContent = count ? `${count} campo(s) en el documento` : 'Este documento no tiene campos de formulario.';
}

// ---- anotaciones (S03/S04)
function drawOverlay(p) {
  const wrap = wrapOf(p.uid);
  if (!wrap) return;
  const ov = $('.overlay', wrap);
  ov.innerHTML = '';
  const s = scale;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ink');
  svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  ov.append(svg);
  for (const an of p.annots) {
    const isSel = selected && selected.uid === p.uid && selected.id === an.id;
    if (an.type === 'ink') {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', an.points.map((pt, i) => `${i ? 'L' : 'M'}${pt[0]},${pt[1]}`).join(' '));
      path.setAttribute('stroke', an.color);
      path.setAttribute('stroke-width', an.width);
      path.setAttribute('stroke-opacity', an.opacity ?? 1);
      path.dataset.id = an.id;
      svg.append(path);
      if (isSel) {
        const bb = annotBBox(an);
        ov.append(h('div', { class: 'ink-box', style: { left: `${bb.x * s}px`, top: `${bb.y * s}px`, width: `${bb.w * s}px`, height: `${bb.h * s}px` } }));
      }
      continue;
    }
    const el = h('div', { class: `annot ${an.type}${isSel ? ' selected' : ''}`, 'data-id': an.id });
    Object.assign(el.style, { left: `${an.cx * s}px`, top: `${an.cy * s}px`, transform: `translate(-50%,-50%) rotate(${-(an.rot || 0)}deg)` });
    if (an.type !== 'text') Object.assign(el.style, { width: `${an.dw * s}px`, height: `${an.dh * s}px` });
    const op = an.opacity ?? 1;
    switch (an.type) {
      case 'highlight': el.style.background = an.color; el.style.opacity = an.opacity ?? 0.4; break;
      case 'whiteout': case 'redact': break;
      case 'underline': el.style.borderBottom = `${(an.width || 1.5) * s}px solid ${an.color}`; el.style.opacity = op; break;
      case 'strike': el.style.background = `linear-gradient(${an.color},${an.color}) center / 100% ${(an.width || 1.5) * s}px no-repeat`; el.style.opacity = op; break;
      case 'rect': case 'ellipse': el.style.borderColor = an.color; el.style.borderWidth = `${(an.width || 2) * s}px`; el.style.opacity = op; break;
      case 'text':
        Object.assign(el.style, { color: an.color, fontSize: `${an.size * s}px`, padding: `${4 * s}px`, fontWeight: an.bold ? '700' : '400' });
        el.textContent = an.text;
        el.addEventListener('dblclick', () => startTextEdit(p, an));
        break;
      case 'note':
        el.style.background = an.color;
        el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 5h14v10h-6l-4 4v-4H5z"/></svg>';
        el.title = an.text || 'Nota vacía';
        break;
      case 'image': el.append(h('img', { src: an.data, draggable: 'false' })); el.style.opacity = op; break;
    }
    if (isSel && ['highlight', 'underline', 'strike', 'rect', 'ellipse', 'image', 'whiteout', 'redact'].includes(an.type)) el.append(h('div', { class: 'handle' }));
    ov.append(el);
    if (an.type === 'text') syncTextSize(p, an, el);
  }
}

/** Ajusta dw/dh de un texto a su tamaño real manteniendo fija su esquina superior izquierda. */
function syncTextSize(p, an, el) {
  const ndw = el.offsetWidth / scale, ndh = el.offsetHeight / scale;
  if (!ndw || (Math.abs(ndw - an.dw) < 0.5 && Math.abs(ndh - an.dh) < 0.5)) return;
  const [tx, ty] = ownToUnrot(an, -an.dw / 2, -an.dh / 2);
  const [ox, oy] = rotY(ndw / 2, ndh / 2, -(an.rot || 0));
  an.dw = ndw; an.dh = ndh; an.cx = tx + ox; an.cy = ty + oy;
  el.style.left = `${an.cx * scale}px`; el.style.top = `${an.cy * scale}px`;
}

function startTextEdit(p, an) {
  const el = viewer.querySelector(`.page-wrap[data-uid="${p.uid}"] .annot[data-id="${an.id}"]`);
  if (!el) return;
  editingText = { uid: p.uid, id: an.id, before: snapshot() };
  el.contentEditable = 'true';
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  el.addEventListener('input', () => { an.text = el.innerText.replace(/\n$/, ''); syncTextSize(p, an, el); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.blur(); e.stopPropagation(); });
  el.addEventListener('blur', () => {
    el.contentEditable = 'false';
    an.text = el.innerText.replace(/\n$/, '');
    const before = editingText?.before;
    editingText = null;
    if (!an.text.trim()) { p.annots = p.annots.filter((a) => a !== an); selected = null; }
    if (before && before !== snapshot()) { history.undo.push(before); history.redo = []; setDirty(true); }
    drawOverlay(p); renderProps();
  }, { once: true });
}

// ---- marca de agua y numeración (vista previa)
function drawDecor(p) {
  const wrap = wrapOf(p.uid);
  if (!wrap) return;
  const d = $('.decor', wrap);
  d.innerHTML = '';
  const s = doc.settings;
  if (s.watermark?.text) {
    const wm = s.watermark;
    const el = h('div', { class: 'wm' }, wm.text);
    Object.assign(el.style, { fontSize: `${(wm.size || 60) * scale}px`, color: wm.color || '#c0392b', opacity: wm.opacity ?? 0.2, transform: `rotate(${-(wm.angle ?? 45)}deg) translate(-50%, -35%)` });
    d.append(el);
  }
  if (s.pageNumbers) {
    const pn = s.pageNumbers;
    const i = doc.pages.indexOf(p);
    const el = h('div', { class: 'pn' }, formatPageNumber(pn.format, i + 1 + ((pn.start || 1) - 1), doc.pages.length));
    el.style.fontSize = `${(pn.size || 10) * scale}px`;
    el.style.bottom = `${(24 - (pn.size || 10) * 0.25) * scale}px`;
    if (pn.position === 'left') el.style.left = `${24 * scale}px`;
    else if (pn.position === 'right') el.style.right = `${24 * scale}px`;
    else { el.style.left = '50%'; el.style.transform = 'translateX(-50%)'; }
    d.append(el);
  }
}
const drawAllDecor = () => doc && doc.pages.forEach(drawDecor);

// ---------------------------------------------------------------- interacción con la página
function pageFromEvent(e) {
  const wrap = e.target.closest && e.target.closest('.page-wrap');
  return wrap ? { wrap, p: pageByUid(wrap.dataset.uid) } : null;
}
function clientToUnrot(e, wrap, p) {
  const r = wrap.getBoundingClientRect();
  const [x, y] = rotY(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), -p.rotate);
  return [(x + (p.w * scale) / 2) / scale, (y + (p.h * scale) / 2) / scale];
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

viewer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !doc) return;
  const hit = pageFromEvent(e);
  if (!hit || !hit.p) return;
  if (e.target.closest('.fld') || e.target.closest('.pdf-note')) return;
  const { wrap, p } = hit;
  if (editingText) { if (e.target.isContentEditable) return; document.activeElement.blur(); }
  const pt = clientToUnrot(e, wrap, p);
  setCurrentPage(doc.pages.indexOf(p));

  if (tool === 'select') {
    const handle = e.target.closest('.handle');
    const target = e.target.closest('.annot') || (e.target.dataset && e.target.dataset.id && e.target.closest('svg.ink') ? e.target : null);
    if (!target) { if (selected) { selected = null; drawOverlay(p); renderProps(); } return; }
    const id = target.dataset.id;
    const an = p.annots.find((a) => a.id === id);
    if (!an) return;
    const prevSel = selected;
    selected = { uid: p.uid, id };
    if (!prevSel || prevSel.id !== id) { drawOverlay(p); renderProps(); }
    if (an.type === 'text' && e.detail >= 2) return; // doble clic: edición
    beginDrag(e, wrap, p, an, handle ? 'resize' : 'move');
    return;
  }

  e.preventDefault();
  if (tool === 'text') {
    pushHistory();
    const an = { id: uid(), type: 'text', cx: pt[0], cy: pt[1], dw: 20, dh: style.size * 1.2 + 8, rot: p.rotate, text: '', size: style.size, color: style.color.text, bold: false };
    p.annots.push(an);
    selected = { uid: p.uid, id: an.id };
    drawOverlay(p);
    // que el clic marque la esquina superior izquierda
    const [ox, oy] = rotY(an.dw / 2, an.dh / 2, -an.rot);
    an.cx = pt[0] + ox; an.cy = pt[1] + oy - an.dh / 2;
    drawOverlay(p);
    history.undo.pop(); // la edición registra su propio paso
    startTextEdit(p, an);
    renderProps();
    return;
  }
  if (tool === 'note') {
    pushHistory();
    const an = { id: uid(), type: 'note', cx: pt[0], cy: pt[1], dw: 22, dh: 22, rot: p.rotate, text: '', color: style.color.note };
    p.annots.push(an);
    selected = { uid: p.uid, id: an.id };
    setTool('select');
    drawOverlay(p); renderProps();
    setTimeout(() => $('#noteText')?.focus(), 0);
    return;
  }
  if (tool === 'place' && pendingImage) {
    const img = new Image();
    img.onload = () => {
      pushHistory();
      const ds = displaySize(p);
      const dw = Math.min(pendingImage.isSignature ? 170 : 240, ds.w * 0.6);
      const dh = dw * (img.naturalHeight / img.naturalWidth);
      const an = { id: uid(), type: 'image', cx: pt[0], cy: pt[1], dw, dh, rot: p.rotate, data: pendingImage.data, opacity: 1 };
      p.annots.push(an);
      selected = { uid: p.uid, id: an.id };
      pendingImage = null;
      setTool('select');
      drawOverlay(p); renderProps();
    };
    img.src = pendingImage.data;
    return;
  }
  if (tool === 'ink') {
    pushHistory();
    const an = { id: uid(), type: 'ink', points: [pt], color: style.color.ink, width: style.width.ink, opacity: 1 };
    p.annots.push(an);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke', an.color); path.setAttribute('stroke-width', an.width);
    $('svg.ink', wrap).append(path);
    trackPointer(e, (ev) => {
      const q = clientToUnrot(ev, wrap, p);
      const last = an.points[an.points.length - 1];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1.2) return;
      an.points.push([+q[0].toFixed(2), +q[1].toFixed(2)]);
      path.setAttribute('d', an.points.map((pt2, i) => `${i ? 'L' : 'M'}${pt2[0]},${pt2[1]}`).join(' '));
    }, () => {
      if (an.points.length < 2) { p.annots = p.annots.filter((a) => a !== an); history.undo.pop(); }
      drawOverlay(p);
    });
    return;
  }
  if (['highlight', 'underline', 'strike', 'rect', 'ellipse', 'whiteout', 'redact'].includes(tool)) {
    pushHistory();
    const an = { id: uid(), type: tool, cx: pt[0], cy: pt[1], dw: 0, dh: 0, rot: p.rotate, color: style.color[tool], opacity: tool === 'highlight' ? (style.opacity.highlight ?? 0.4) : 1, width: style.width[tool] };
    p.annots.push(an);
    const start = pt;
    const update = (q) => {
      const x0 = clamp(Math.min(start[0], q[0]), 0, p.w), x1 = clamp(Math.max(start[0], q[0]), 0, p.w);
      const y0 = clamp(Math.min(start[1], q[1]), 0, p.h), y1 = clamp(Math.max(start[1], q[1]), 0, p.h);
      an.cx = (x0 + x1) / 2; an.cy = (y0 + y1) / 2;
      const bw = x1 - x0, bh = y1 - y0;
      [an.dw, an.dh] = (an.rot % 180) ? [bh, bw] : [bw, bh];
      drawOverlay(p);
    };
    trackPointer(e, (ev) => update(clientToUnrot(ev, wrap, p)), () => {
      if (an.dw < 3 || an.dh < 3) {
        if (['highlight', 'underline', 'strike'].includes(tool) && an.dw >= 3) { an.dh = 12; drawOverlay(p); return; }
        p.annots = p.annots.filter((a) => a !== an); history.undo.pop(); drawOverlay(p);
      }
    });
  }
});

// Evita que el mousedown posterior quite el foco al cuadro de texto recién creado.
viewer.addEventListener('mousedown', (e) => {
  if (tool !== 'select' && e.target.closest('.overlay')) e.preventDefault();
});

function trackPointer(e, onMove, onUp) {
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onUp(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function beginDrag(e, wrap, p, an, mode) {
  const before = snapshot();
  const x0 = e.clientX, y0 = e.clientY;
  const orig = structuredClone(an);
  let moved = false;
  trackPointer(e, (ev) => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    if (mode === 'move') {
      const [ux, uy] = rotY(dx, dy, -p.rotate).map((v) => v / scale);
      if (an.type === 'ink') an.points = orig.points.map(([x, y]) => [x + ux, y + uy]);
      else { an.cx = orig.cx + ux; an.cy = orig.cy + uy; }
    } else {
      const [ox, oy] = rotY(dx, dy, -(p.rotate - (an.rot || 0))).map((v) => v / scale);
      let ndw = Math.max(6, orig.dw + ox), ndh = Math.max(4, orig.dh + oy);
      if (an.type === 'image') ndh = ndw * (orig.dh / orig.dw);
      const [tx, ty] = ownToUnrot(orig, -orig.dw / 2, -orig.dh / 2);
      const [cx, cy] = rotY(ndw / 2, ndh / 2, -(an.rot || 0));
      Object.assign(an, { dw: ndw, dh: ndh, cx: tx + cx, cy: ty + cy });
    }
    drawOverlay(p);
  }, () => {
    if (moved) { history.undo.push(before); history.redo = []; setDirty(true); }
  });
}

function deleteSelected() {
  const an = findAnnot(selected);
  if (!an) return;
  pushHistory();
  const p = pageByUid(selected.uid);
  p.annots = p.annots.filter((a) => a !== an);
  selected = null;
  drawOverlay(p); renderProps();
}

// ---------------------------------------------------------------- herramientas
function setTool(t) {
  tool = t;
  viewer.dataset.mode = t;
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('#toolHint').textContent = TOOL_HINTS[t] || '';
  if (t !== 'select' && selected) { const p = pageByUid(selected.uid); selected = null; if (p) drawOverlay(p); }
  if (t !== 'place') pendingImage = null;
  renderProps();
}

// ---------------------------------------------------------------- panel de propiedades
function swatchRow(current, onPick) {
  const row = h('div', { class: 'swatches' });
  for (const c of PALETTE) row.append(h('button', { class: `swatch${c.toLowerCase() === (current || '').toLowerCase() ? ' on' : ''}`, style: { background: c }, title: c, onclick: () => onPick(c) }));
  const custom = h('input', { type: 'color', class: 'swatch-custom', value: current || '#000000', title: 'Otro color' });
  custom.addEventListener('input', () => onPick(custom.value));
  row.append(custom);
  return row;
}
function renderProps() {
  const el = $('#props');
  el.innerHTML = '';
  propEditOpen = false;
  if (!doc) return;
  const an = findAnnot(selected);
  const editAnnot = (fn) => {
    if (!propEditOpen) { pushHistory(); propEditOpen = true; }
    fn(an); drawOverlay(pageByUid(selected.uid));
  };
  const NAMES = { whiteout: 'Corrector', redact: 'Redacción (definitiva)', highlight: 'Resaltado', underline: 'Subrayado', strike: 'Tachado', rect: 'Rectángulo', ellipse: 'Elipse', ink: 'Trazo', text: 'Texto', note: 'Nota', image: 'Imagen' };
  if (an) {
    el.append(h('h3', {}, NAMES[an.type] || 'Anotación'));
    if (an.type === 'redact') el.append(h('p', { class: 'small' }, 'Al guardar, la página se convierte en imagen y lo que está bajo el recuadro negro desaparece del archivo.'));
    if (!['image', 'whiteout', 'redact'].includes(an.type)) {
      el.append(h('div', { class: 'row' }, h('label', {}, 'Color'), swatchRow(an.color, (c) => { editAnnot((a) => { a.color = c; }); style.color[an.type] = c; renderProps(); propEditOpen = true; })));
    }
    if (['highlight', 'rect', 'ellipse', 'ink', 'image', 'underline', 'strike'].includes(an.type)) {
      const r = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: an.opacity ?? 1 });
      r.addEventListener('input', () => editAnnot((a) => { a.opacity = +r.value; }));
      el.append(h('div', { class: 'row' }, h('label', {}, 'Opacidad'), r));
    }
    if (['rect', 'ellipse', 'ink', 'underline', 'strike'].includes(an.type)) {
      const r = h('input', { type: 'range', min: '0.5', max: '12', step: '0.5', value: an.width || 2 });
      r.addEventListener('input', () => editAnnot((a) => { a.width = +r.value; style.width[a.type] = +r.value; }));
      el.append(h('div', { class: 'row' }, h('label', {}, 'Grosor'), r));
    }
    if (an.type === 'text') {
      const r = h('input', { type: 'range', min: '6', max: '72', step: '1', value: an.size });
      r.addEventListener('input', () => editAnnot((a) => { a.size = +r.value; style.size = +r.value; }));
      const b = h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!an.bold, onchange: (e) => editAnnot((a) => { a.bold = e.target.checked; }) }), 'Negrita');
      el.append(h('div', { class: 'row' }, h('label', {}, 'Tamaño'), r), h('div', { class: 'row' }, b), h('p', { class: 'muted small' }, 'Doble clic sobre el texto para editarlo.'));
    }
    if (an.type === 'note') {
      const ta = h('textarea', { id: 'noteText', placeholder: 'Escribe tu comentario…' });
      ta.value = an.text || '';
      ta.addEventListener('input', () => editAnnot((a) => { a.text = ta.value; }));
      el.append(h('div', { class: 'row' }, h('label', { for: 'noteText' }, 'Comentario'), ta), h('p', { class: 'muted small' }, 'Se guarda como nota PDF estándar: otros visores la muestran como comentario.'));
    }
    el.append(h('button', { class: 'btn', onclick: deleteSelected }, 'Eliminar'));
    return;
  }
  if (tool === 'whiteout' || tool === 'redact') {
    el.append(h('h3', {}, tool === 'redact' ? 'Redactar' : 'Corrector'), h('p', { class: 'small' }, TOOL_HINTS[tool]));
    return;
  }
  if (tool !== 'select' && tool !== 'place') {
    el.append(h('h3', {}, 'Estilo de la herramienta'));
    el.append(h('div', { class: 'row' }, h('label', {}, 'Color'), swatchRow(style.color[tool], (c) => { style.color[tool] = c; renderProps(); })));
    if (tool === 'highlight') {
      const r = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: style.opacity.highlight });
      r.addEventListener('input', () => { style.opacity.highlight = +r.value; });
      el.append(h('div', { class: 'row' }, h('label', {}, 'Opacidad'), r));
    }
    if (style.width[tool] != null) {
      const r = h('input', { type: 'range', min: '0.5', max: '12', step: '0.5', value: style.width[tool] });
      r.addEventListener('input', () => { style.width[tool] = +r.value; });
      el.append(h('div', { class: 'row' }, h('label', {}, 'Grosor'), r));
    }
    if (tool === 'text') {
      const r = h('input', { type: 'range', min: '6', max: '72', step: '1', value: style.size });
      r.addEventListener('input', () => { style.size = +r.value; });
      el.append(h('div', { class: 'row' }, h('label', {}, 'Tamaño'), r));
    }
    return;
  }
  // Información del documento
  const srcs = Object.values(doc.sources);
  const nAnnots = doc.pages.reduce((n, p) => n + p.annots.length, 0);
  el.append(h('h3', {}, 'Documento'), h('dl', {},
    h('dt', {}, 'Archivo'), h('dd', {}, doc.name),
    h('dt', {}, 'Páginas'), h('dd', {}, String(doc.pages.length)),
    h('dt', {}, 'Anotaciones'), h('dd', {}, String(nAnnots)),
    h('dt', {}, 'Fuentes'), h('dd', {}, srcs.length ? srcs.map((s) => s.name).join(', ') : doc.pages.some((p) => p.image) ? 'Imágenes' : 'Documento en blanco'),
    h('dt', {}, 'Ruta'), h('dd', {}, doc.path || 'Sin guardar'),
  ));
  const extras = [];
  if (doc.settings.watermark) extras.push(`Marca de agua: «${doc.settings.watermark.text}»`);
  if (doc.settings.pageNumbers) extras.push('Numeración de páginas activa');
  const ocrPages = doc.pages.filter((p) => p.ocr).length;
  if (ocrPages) extras.push(`Texto reconocido (OCR) en ${ocrPages} página(s)`);
  if (doc.security) extras.push(doc.security.user ? 'Protegido con contraseña' : 'Con restricciones de permisos');
  if (extras.length) el.append(h('h3', { style: { marginTop: '18px' } }, 'Elementos'), ...extras.map((t) => h('p', { class: 'small' }, t)));
}

// ---------------------------------------------------------------- miniaturas y páginas (S05)
let thumbObserver = null;
function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { drawThumb(e.target); thumbObserver.unobserve(e.target); }
  }, { root: box, rootMargin: '300px 0px' });
  doc.pages.forEach((p, i) => {
    const t = h('div', { class: `thumb${selPages.has(p.uid) ? ' selected' : ''}${i === currentPage ? ' current' : ''}`, draggable: 'true', 'data-uid': p.uid },
      h('div', { class: 'ph' }), h('span', { class: 'num' }, String(i + 1)));
    t.addEventListener('click', (e) => onThumbClick(e, p, i));
    t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/papel-page', p.uid); e.dataTransfer.effectAllowed = 'move'; if (!selPages.has(p.uid)) { selPages = new Set([p.uid]); markThumbs(); } });
    t.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/papel-page')) return;
      e.preventDefault();
      const r = t.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      t.classList.toggle('drop-after', after); t.classList.toggle('drop-before', !after);
    });
    t.addEventListener('dragleave', () => t.classList.remove('drop-after', 'drop-before'));
    t.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes('text/papel-page')) return;
      e.preventDefault(); e.stopPropagation();
      const after = t.classList.contains('drop-after');
      t.classList.remove('drop-after', 'drop-before');
      movePagesTo(p.uid, after);
    });
    box.append(t);
    thumbObserver.observe(t);
  });
}
function markThumbs() {
  $$('.thumb').forEach((t, i) => { t.classList.toggle('selected', selPages.has(t.dataset.uid)); t.classList.toggle('current', i === currentPage); });
}
async function drawThumb(t) {
  const p = pageByUid(t.dataset.uid);
  if (!p) return;
  const key = `${p.uid}:${p.rotate}`;
  let url = thumbCache.get(key);
  if (!url) {
    const ds = displaySize(p);
    const sc = 110 / Math.max(ds.w, ds.h) * 1.6;
    const c = document.createElement('canvas');
    if (!p.src) { const r = await renderToCanvas(p, sc, true); c.width = r.width; c.height = r.height; c.getContext('2d').drawImage(r, 0, 0); }
    else {
      const pg = await getPage(p.src, p.index);
      const vp = pg.getViewport({ scale: sc, rotation: p.rotate });
      c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    }
    url = c.toDataURL('image/png');
    thumbCache.set(key, url);
  }
  const img = h('img', { src: url, style: { width: `${Math.min(120, 120 * (displaySize(p).w / Math.max(displaySize(p).w, displaySize(p).h)) / 0.78)}px` } });
  const ph = $('.ph', t) || $('img', t);
  if (ph) ph.replaceWith(img);
}
function onThumbClick(e, p, i) {
  if (e.shiftKey && lastSelPage != null) {
    const a = Math.min(lastSelPage, i), b = Math.max(lastSelPage, i);
    selPages = new Set(doc.pages.slice(a, b + 1).map((q) => q.uid));
  } else if (e.ctrlKey || e.metaKey) {
    selPages.has(p.uid) ? selPages.delete(p.uid) : selPages.add(p.uid);
    lastSelPage = i;
  } else {
    selPages = new Set([p.uid]);
    lastSelPage = i;
  }
  markThumbs();
  scrollToPage(i);
}
function scrollToPage(i) {
  const w = viewer.children[i];
  if (w) viewer.scrollTo({ top: w.offsetTop - 16, behavior: 'smooth' });
  setCurrentPage(i);
}
function setCurrentPage(i) {
  if (i === currentPage) return;
  currentPage = i;
  markThumbs();
  updateStatus();
}
function updateStatus() {
  if (!doc) return;
  $('#pageStatus').textContent = `Página ${currentPage + 1} de ${doc.pages.length}`;
  $('#zoomLabel').textContent = `${Math.round(scale * 100)}%`;
}
viewer.addEventListener('scroll', () => {
  if (!doc) return;
  const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  let idx = 0;
  for (let i = 0; i < viewer.children.length; i++) { if (viewer.children[i].offsetTop <= mid) idx = i; else break; }
  setCurrentPage(idx);
}, { passive: true });

/** Páginas objetivo: la selección de miniaturas o la página actual. */
function targetPages() {
  const sel = doc.pages.filter((p) => selPages.has(p.uid));
  return sel.length ? sel : [doc.pages[currentPage]].filter(Boolean);
}
function structural(fn) {
  pushHistory();
  fn();
  currentPage = clamp(currentPage, 0, doc.pages.length - 1);
  renderViewer(); renderThumbs(); drawAllDecor(); renderProps();
}
function rotatePages(delta) {
  const ts = targetPages();
  structural(() => ts.forEach((p) => { p.rotate = (p.rotate + delta + 360) % 360; }));
  toast(ts.length > 1 ? `${ts.length} páginas giradas` : 'Página girada');
}
async function deletePages() {
  const ts = targetPages();
  if (ts.length >= doc.pages.length) { toast('Un documento necesita al menos una página.', 'error'); return; }
  structural(() => { doc.pages = doc.pages.filter((p) => !ts.includes(p)); selPages.clear(); });
  toast(ts.length > 1 ? `${ts.length} páginas eliminadas` : 'Página eliminada');
}
function insertBlank() {
  const ref = doc.pages[currentPage];
  const ds = ref ? { w: ref.w, h: ref.h } : { w: 612, h: 792 };
  structural(() => doc.pages.splice(currentPage + 1, 0, { uid: uid(), src: null, index: 0, rotate: ref ? ref.rotate : 0, w: ds.w, h: ds.h, annots: [] }));
  setTimeout(() => scrollToPage(currentPage + 1), 50);
}
async function insertPdf() {
  const files = await api.openDialog(true);
  if (!files.length) return;
  const added = [];
  for (const f of files) {
    const loaded = await loadSource(f);
    if (!loaded) continue;
    doc.sources[loaded.src.id] = loaded.src;
    added.push(...loaded.pages);
  }
  if (!added.length) return;
  const at = currentPage + 1;
  structural(() => doc.pages.splice(at, 0, ...added));
  toast(`${added.length} página(s) insertadas`);
  updateFormInfo();
}
function movePagesTo(targetUid, after) {
  const moving = doc.pages.filter((p) => selPages.has(p.uid));
  if (!moving.length || moving.some((p) => p.uid === targetUid)) return;
  structural(() => {
    const rest = doc.pages.filter((p) => !selPages.has(p.uid));
    let idx = rest.findIndex((p) => p.uid === targetUid) + (after ? 1 : 0);
    rest.splice(idx, 0, ...moving);
    doc.pages = rest;
  });
}
function moveBy(delta) {
  const ts = targetPages();
  const idxs = ts.map((p) => doc.pages.indexOf(p)).sort((a, b) => a - b);
  if ((delta < 0 && idxs[0] === 0) || (delta > 0 && idxs[idxs.length - 1] === doc.pages.length - 1)) return;
  structural(() => {
    const order = delta < 0 ? idxs : [...idxs].reverse();
    for (const i of order) { const [pg] = doc.pages.splice(i, 1); doc.pages.splice(i + delta, 0, pg); }
    currentPage = clamp(currentPage + delta, 0, doc.pages.length - 1);
    selPages = new Set(ts.map((p) => p.uid));
  });
}

// ---------------------------------------------------------------- guardar / exportar
function guardEncrypted() { return false; }
async function save(ask = false) {
  if (!doc || guardEncrypted()) return;
  if (editingText) document.activeElement.blur();
  try {
    const bytes = await finalBytes();
    const res = await api.saveFile({ bytes, path: ask ? null : doc.path, suggestedName: doc.name, ask: ask || !doc.path });
    if (!res) return;
    doc.path = res.path; doc.name = res.name;
    $('#docName').textContent = doc.name;
    setDirty(false);
    renderProps();
    toast(`Guardado: ${res.name}`);
  } catch (err) {
    console.error(err);
    toast(`No se pudo guardar: ${err.message || err}`, 'error');
  }
}
async function extractPages() {
  if (guardEncrypted()) return;
  const ts = targetPages();
  const set = new Set(ts.map((p) => p.uid));
  const bytes = await finalBytes({ pageFilter: (p) => set.has(p.uid) });
  const res = await api.saveFile({ bytes, suggestedName: `${baseName(doc.name)}-paginas.pdf`, ask: true });
  if (res) toast(`${ts.length} página(s) extraídas a ${res.name}`);
}
async function exportPng() {
  if (guardEncrypted()) return;
  const p = doc.pages[currentPage];
  const bytes = await finalBytes({ pageFilter: (q) => q.uid === p.uid, noSecurity: true });
  const pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes }).promise;
  const pg = await pdf.getPage(1);
  const vp = pg.getViewport({ scale: 2 });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const res = await api.saveFile({ bytes: new Uint8Array(await blob.arrayBuffer()), suggestedName: `${baseName(doc.name)}-p${currentPage + 1}.png`, ask: true, kind: 'png' });
  pdf.destroy();
  if (res) toast(`Imagen guardada: ${res.name}`);
}
async function printDoc() {
  if (guardEncrypted()) return;
  await api.printPdf(await finalBytes({ noSecurity: true }));
}
async function exportCsv() {
  const rows = [['campo', 'valor']];
  const seen = new Set();
  for (const p of doc.pages) {
    if (!p.src) continue;
    for (const w of (await getWidgets(p)).widgets) {
      if (seen.has(p.src + w.fieldName)) continue;
      seen.add(p.src + w.fieldName);
      let v = (doc.fields[p.src] || {})[w.fieldName];
      if (v === undefined) v = initialValue(w);
      if (w.radioButton && v === undefined) v = '';
      rows.push([w.fieldName, typeof v === 'boolean' ? (v ? 'Sí' : 'No') : (v ?? '')]);
    }
  }
  if (rows.length === 1) { toast('Este documento no tiene campos de formulario.', 'error'); return; }
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const res = await api.saveFile({ bytes: new TextEncoder().encode(csv), suggestedName: `${baseName(doc.name)}-datos.csv`, ask: true, kind: 'csv' });
  if (res) toast(`Datos exportados: ${res.name}`);
}
function resetForm() {
  pushHistory();
  doc.fields = {};
  refreshFieldValues();
  toast('Formulario restablecido');
}

// ---------------------------------------------------------------- zoom
function zoomFit(rerender = true) {
  if (!doc) return;
  const maxW = Math.max(...doc.pages.map((p) => displaySize(p).w));
  scale = clamp((viewer.clientWidth - 64) / maxW, 0.25, 3);
  if (rerender) { renderViewer(); }
  updateStatus();
}
function zoomBy(f) {
  if (!doc) return;
  const ratio = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  scale = clamp(scale * f, 0.25, 5);
  renderViewer();
  viewer.scrollTop = ratio * viewer.scrollHeight;
}
viewer.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });

// ---------------------------------------------------------------- modales
function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    const footer = h('footer', {});
    for (const a of actions) footer.append(h('button', { class: `btn ${a.kind || ''} ${a.left ? 'left' : ''}`, onclick: async () => { const v = a.value ? await a.value() : a.result; if (v !== undefined) close(v); } }, a.label));
    back.append(h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('header', {}, h('h2', {}, title)), h('div', { class: 'content' }, body), footer));
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
    $('#modalRoot').append(back);
    setTimeout(() => back.querySelector('input,select,textarea,canvas')?.focus(), 0);
  });
}

function askPassword(name, wrong) {
  const input = h('input', { type: 'password', autocomplete: 'off' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('.modal').querySelector('.btn.primary').click(); });
  return modal({
    title: 'Documento protegido',
    body: [h('p', {}, `«${name}» necesita una contraseña para abrirse.`), wrong ? h('p', { style: { color: 'var(--accent)' } }, 'Contraseña incorrecta.') : null, h('label', { class: 'field' }, h('span', {}, 'Contraseña'), input)],
    actions: [{ label: 'Cancelar', result: null }, { label: 'Abrir', kind: 'primary', value: () => input.value }],
  });
}

async function watermarkDialog() {
  const cur = doc.settings.watermark || { text: 'CONFIDENCIAL', opacity: 0.18, size: 60, color: '#c0392b', angle: 45 };
  const text = h('input', { type: 'text', value: cur.text });
  const size = h('input', { type: 'number', min: '8', max: '200', value: cur.size });
  const angle = h('input', { type: 'number', min: '-90', max: '90', value: cur.angle ?? 45 });
  const op = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: cur.opacity });
  const color = h('input', { type: 'color', value: cur.color || '#c0392b' });
  const r = await modal({
    title: 'Marca de agua',
    body: [
      h('label', { class: 'field' }, h('span', {}, 'Texto'), text),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Tamaño (pt)'), size), h('label', { class: 'field' }, h('span', {}, 'Ángulo (°)'), angle)),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Opacidad'), op), h('label', { class: 'field' }, h('span', {}, 'Color'), color)),
      h('p', { class: 'muted small' }, 'Se aplica a todas las páginas al guardar. Puedes verla ya en la vista previa.'),
    ],
    actions: [
      ...(doc.settings.watermark ? [{ label: 'Quitar', left: true, result: 'remove' }] : []),
      { label: 'Cancelar', result: null },
      { label: 'Aplicar', kind: 'primary', value: () => (text.value.trim() ? { text: text.value.trim(), size: +size.value || 60, angle: +angle.value || 0, opacity: +op.value, color: color.value } : undefined) },
    ],
  });
  if (r == null) return;
  pushHistory();
  doc.settings.watermark = r === 'remove' ? null : r;
  drawAllDecor(); renderProps();
}

async function pageNumbersDialog() {
  const cur = doc.settings.pageNumbers || { format: 'Página {n} de {N}', position: 'center', size: 10, start: 1 };
  const format = h('input', { type: 'text', value: cur.format });
  const start = h('input', { type: 'number', min: '1', value: cur.start || 1 });
  const presets = h('div', { class: 'seg' }, ...[['Página {n} de {N}', 'Página n de N'], ['{n}', 'Solo número'], ['EXP-{n:6}', 'Bates']].map(([f, t]) => h('button', { onclick: () => { format.value = f; } }, t)));
  const pos = h('select', {}, ...[['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']].map(([v, t]) => h('option', { value: v, selected: v === cur.position }, t)));
  const size = h('input', { type: 'number', min: '6', max: '36', value: cur.size });
  const r = await modal({
    title: 'Numerar páginas',
    body: [
      presets,
      h('label', { class: 'field' }, h('span', {}, 'Formato · {n} = número, {N} = total, {n:6} = número con 6 dígitos (Bates)'), format),
      h('label', { class: 'field' }, h('span', {}, 'Empezar en'), start),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Posición (pie de página)'), pos), h('label', { class: 'field' }, h('span', {}, 'Tamaño (pt)'), size)),
    ],
    actions: [
      ...(doc.settings.pageNumbers ? [{ label: 'Quitar', left: true, result: 'remove' }] : []),
      { label: 'Cancelar', result: null },
      { label: 'Aplicar', kind: 'primary', value: () => ({ format: format.value || '{n}', position: pos.value, size: +size.value || 10, start: Math.max(1, +start.value || 1) }) },
    ],
  });
  if (r == null) return;
  pushHistory();
  doc.settings.pageNumbers = r === 'remove' ? null : r;
  drawAllDecor(); renderProps();
}

// ---- firma (S08)
const SIG_KEY = 'papelpdf.firmas';
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY) || '[]'); } catch { return []; } };
const storeSigs = (l) => { try { localStorage.setItem(SIG_KEY, JSON.stringify(l.slice(0, 8))); } catch {} };

function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

async function signatureDialog() {
  let mode = 'draw';
  const inkColor = { v: '#10204a' };
  const pad = h('canvas', { class: 'sig-pad' });
  const typed = h('input', { type: 'text', placeholder: 'Escribe tu nombre' });
  const fontSel = h('select', {}, ...['"Segoe Script", "Brush Script MT", "URW Chancery L", "Z003", cursive', '"Lucida Handwriting", "Apple Chancery", cursive', 'Georgia, "Times New Roman", serif'].map((f, i) => h('option', { value: f }, ['Manuscrita', 'Caligráfica', 'Formal'][i])));
  const preview = h('div', { class: 'typed-preview' }, '');
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
  const imgPrev = h('img', { style: { maxHeight: '120px', maxWidth: '100%', display: 'none', background: '#fff' } });
  let imgData = null;
  const remember = h('input', { type: 'checkbox', checked: true });
  const updatePreview = () => { preview.textContent = typed.value || 'Tu firma'; preview.style.fontFamily = fontSel.value; preview.style.color = inkColor.v; };
  typed.addEventListener('input', updatePreview); fontSel.addEventListener('change', updatePreview);
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return;
    imgData = await readAsDataURL(f); imgPrev.src = imgData; imgPrev.style.display = 'block';
  });
  updatePreview();

  const panels = {
    draw: h('div', { class: 'field' }, pad, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      swatchRow(inkColor.v, (c) => { inkColor.v = c; updatePreview(); }), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => pad.getContext('2d').clearRect(0, 0, pad.width, pad.height) }, 'Borrar'))),
    type: h('div', { class: 'field' }, typed, fontSel, preview),
    image: h('div', { class: 'field' }, fileIn, imgPrev, h('p', { class: 'muted small' }, 'Usa una imagen PNG con fondo transparente para mejores resultados.')),
  };
  const seg = h('div', { class: 'seg' });
  const switchTo = (m) => { mode = m; $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.m === m)); Object.entries(panels).forEach(([k, el]) => { el.hidden = k !== m; }); };
  [['draw', 'Dibujar'], ['type', 'Escribir'], ['image', 'Imagen']].forEach(([m, t]) => seg.append(h('button', { 'data-m': m, onclick: () => switchTo(m) }, t)));

  const saved = loadSigs();
  const savedRow = h('div', { class: 'sig-saved' });
  let chosen = null;
  const back = { close: null };
  saved.forEach((s, i) => {
    savedRow.append(h('div', { class: 'item' },
      h('img', { src: s, title: 'Usar esta firma', style: { cursor: 'pointer' }, onclick: () => { chosen = s; $('.modal .btn.primary').click(); } }),
      h('button', { class: 'x', title: 'Olvidar', onclick: (e) => { const l = loadSigs(); l.splice(i, 1); storeSigs(l); e.target.parentElement.remove(); } }, '×')));
  });

  // trazo en el lienzo
  requestAnimationFrame(() => {
    const r = pad.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    pad.width = r.width * dpr; pad.height = r.height * dpr;
    const ctx = pad.getContext('2d');
    ctx.scale(dpr, dpr); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let last = null;
    pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); const b = pad.getBoundingClientRect(); last = [e.clientX - b.left, e.clientY - b.top, e.pressure || 0.5]; });
    pad.addEventListener('pointermove', (e) => {
      if (!last) return;
      const b = pad.getBoundingClientRect();
      const cur = [e.clientX - b.left, e.clientY - b.top, e.pressure || 0.5];
      ctx.strokeStyle = inkColor.v; ctx.lineWidth = 1.6 + cur[2] * 2.2;
      ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke();
      last = cur;
    });
    pad.addEventListener('pointerup', () => { last = null; });
  });
  switchTo('draw');

  const result = await modal({
    title: 'Firmar',
    body: [saved.length ? h('div', { class: 'field' }, h('span', {}, 'Firmas guardadas'), savedRow) : null, seg, panels.draw, panels.type, panels.image,
      h('label', { class: 'toggle', style: { padding: 0 } }, remember, 'Guardar esta firma en este equipo')],
    actions: [{ label: 'Cancelar', result: null }, {
      label: 'Colocar en la página', kind: 'primary', value: () => {
        if (chosen) return { data: chosen, fromSaved: true };
        let data = null;
        if (mode === 'draw') data = trimCanvas(pad);
        if (mode === 'type' && typed.value.trim()) {
          const c = document.createElement('canvas'); c.width = 1200; c.height = 300;
          const x = c.getContext('2d'); x.font = `110px ${fontSel.value}`; x.fillStyle = inkColor.v; x.textBaseline = 'middle';
          x.fillText(typed.value.trim(), 20, 150); data = trimCanvas(c);
        }
        if (mode === 'image') data = imgData;
        if (!data) { toast('Primero crea una firma.', 'error'); return undefined; }
        return { data };
      },
    }],
  });
  if (!result) return;
  if (remember.checked && !result.fromSaved) storeSigs([result.data, ...loadSigs().filter((s) => s !== result.data)]);
  startPlacing(result.data, true);
}
function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
async function normalizeImage(dataUrl) {
  if (/^data:image\/(png|jpe?g)/i.test(dataUrl)) return dataUrl;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}
function startPlacing(data, isSignature = false) {
  setTool('place');
  pendingImage = { data, isSignature };
  toast(isSignature ? 'Haz clic en la página donde va la firma.' : 'Haz clic en la página donde va la imagen.');
}
$('#imageInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  startPlacing(await normalizeImage(await readAsDataURL(f)));
});

async function aboutDialog() {
  const info = await api.appInfo();
  await modal({
    title: 'Acerca de PapelPDF',
    body: h('div', { class: 'about field' },
      h('img', { class: 'about-logo', src: 'assets/logo.svg', alt: '' }),
      h('p', {}, h('strong', {}, `PapelPDF ${info.version}`), ` · ${info.platform}`),
      h('p', {}, 'Editor de PDF libre y de código abierto (licencia MIT). Gratis para siempre: sin límites de páginas, sin marcas de agua, sin cuentas, sin anuncios y sin telemetría. Funciona sin conexión.'),
      h('p', { class: 'muted small' }, 'Desarrollado por Santiago Miguel · 744 354 8848 · chago2850@gmail.com'),
      h('p', { class: 'muted small' }, 'Usa pdf.js (Apache-2.0), pdf-lib (MIT), tesseract.js (Apache-2.0), qpdf (Apache-2.0) y docx (MIT).')),
    actions: [{ label: 'Cerrar', kind: 'primary', result: true }],
  });
}

// ---------------------------------------------------------------- inicio (S01)
async function renderRecents() {
  const list = await api.recents();
  const ul = $('#recentList');
  ul.innerHTML = '';
  $('#recentEmpty').hidden = list.length > 0;
  $('#clearRecents').hidden = list.length === 0;
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });
  for (const r of list) {
    ul.append(h('li', {}, h('button', { onclick: () => openPath(r.path) },
      h('svg', { viewBox: '0 0 24 24' }), h('strong', {}, r.name), h('span', { class: 'path' }, r.path), h('span', { class: 'when' }, fmt.format(new Date(r.openedAt))))));
  }
  $$('#recentList svg').forEach((s) => { s.outerHTML = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>'; });
}
async function openPath(p) {
  try { await openFiles([await api.readPath(p)]); } catch (e) { toast(`No se pudo abrir: ${e.message || e}`, 'error'); renderRecents(); }
}
$('#clearRecents').addEventListener('click', async () => { await api.clearRecents(); renderRecents(); });

// ---------------------------------------------------------------- texto: capa seleccionable, extracción y búsqueda
let scanned = { count: 0, dismissed: false };
const textCache = new Map(); // uid -> [{ str, x, y, w, h }] en "unrot"
const measureCtx = document.createElement('canvas').getContext('2d');
const imgCacheEl = new Map();
function loadImg(src) {
  if (!imgCacheEl.has(src)) imgCacheEl.set(src, new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }));
  return imgCacheEl.get(src);
}

async function renderTextLayer(p, wrap, pg) {
  const layer = $('.textLayer', wrap);
  if (!layer) return;
  layer.innerHTML = '';
  layer.style.setProperty('--scale-factor', String(scale));
  if (pg) {
    const tc = await pg.getTextContent();
    if (!tc.items.length && !p.ocr) noteScanned(p);
    try {
      const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: layer, viewport: pg.getViewport({ scale, rotation: 0 }) });
      await tl.render();
    } catch (e) { console.warn('capa de texto', e); }
  } else if (p.image && !p.ocr) noteScanned(p);
  // Palabras del OCR: texto transparente sobre su posición para poder seleccionarlas y copiarlas.
  if (p.ocr) {
    for (const w of p.ocr.words) {
      const [tx, ty] = ownToUnrot(w, -w.dw / 2, -w.dh / 2);
      const fs = w.dh * scale * 0.9;
      measureCtx.font = `${fs}px sans-serif`;
      const natural = measureCtx.measureText(w.t).width || 1;
      const span = h('span', {}, w.t + ' ');
      Object.assign(span.style, { left: `${tx * scale}px`, top: `${ty * scale}px`, fontSize: `${fs}px`, fontFamily: 'sans-serif', transform: `rotate(${-(w.rot || 0)}deg) scaleX(${(w.dw * scale) / natural})` });
      layer.append(span);
    }
  }
}
function noteScanned(p) {
  scanned.count++;
  if (!scanned.dismissed) $('#scanBanner').hidden = false;
}
$('#scanBannerClose').addEventListener('click', () => { scanned.dismissed = true; $('#scanBanner').hidden = true; });

/** Texto de una página como cajas en "unrot" (texto nativo del PDF + OCR). */
async function pageTextItems(p) {
  const key = `${p.uid}:${p.ocr ? p.ocr.words.length : 0}`;
  if (textCache.has(key)) return textCache.get(key);
  const items = [];
  if (p.src) {
    const pg = await getPage(p.src, p.index);
    const tc = await pg.getTextContent();
    const v = p.view;
    for (const it of tc.items) {
      if (!it.str) continue;
      const [a, b, c, d, e, f] = it.transform;
      const hgt = it.height || Math.hypot(c, d);
      const vertical = Math.abs(b) > Math.abs(a);
      if (vertical) {
        const w = it.height || Math.hypot(c, d), len = it.width;
        items.push({ str: it.str, x: e - v[0] - w, y: v[3] - f - len, w, h: len, size: hgt, vertical: true, eol: it.hasEOL });
      } else {
        items.push({ str: it.str, x: e - v[0], y: v[3] - f - hgt * 0.85, w: it.width, h: hgt, size: hgt, eol: it.hasEOL, bold: /bold|black|heavy/i.test(tc.styles[it.fontName]?.fontFamily || it.fontName || '') });
      }
    }
  }
  if (p.ocr) {
    for (const w of p.ocr.words) {
      const bb = annotBBox(w);
      items.push({ str: w.t, x: bb.x, y: bb.y, w: bb.w, h: bb.h, size: w.dh, ocr: true });
    }
  }
  textCache.set(key, items);
  return items;
}

/** Agrupa las cajas de texto en líneas de lectura (de arriba abajo y de izquierda a derecha). */
function itemsToLines(items) {
  const horiz = items.filter((i) => !i.vertical && i.str.trim()).sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const lines = [];
  for (const it of horiz) {
    const cy = it.y + it.h / 2;
    let ln = lines.find((l) => Math.abs(l.cy - cy) < Math.max(3, Math.min(l.h, it.h) * 0.5));
    if (!ln) { ln = { cy, h: it.h, items: [] }; lines.push(ln); }
    ln.items.push(it);
  }
  lines.sort((a, b) => a.cy - b.cy);
  return lines.map((l, i) => {
    l.items.sort((a, b) => a.x - b.x);
    let text = '';
    let lastEnd = null;
    for (const it of l.items) {
      if (lastEnd != null && it.x - lastEnd > it.size * 0.15 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      text += it.str;
      lastEnd = it.x + it.w;
    }
    const size = Math.max(...l.items.map((x) => x.size));
    const next = lines[i + 1];
    return { text: text.replace(/\s+/g, ' ').trim(), size: Math.round(size), bold: l.items.every((x) => x.bold), gapAfter: next ? (next.cy - l.cy) > size * 1.9 : true };
  }).filter((l) => l.text);
}

// ---- búsqueda (Ctrl+F)
let find = { q: '', hits: [], idx: -1 };
const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function openFind() {
  $('#findbar').hidden = false;
  const inp = $('#findInput');
  inp.focus(); inp.select();
}
function closeFind() {
  $('#findbar').hidden = true;
  find = { q: '', hits: [], idx: -1 };
  if (doc) doc.pages.forEach(drawHits);
  $('#findCount').textContent = '';
}
async function runFind(q) {
  find = { q, hits: [], idx: -1 };
  if (q.trim().length >= 1 && doc) {
    const nq = norm(q);
    for (const p of doc.pages) {
      for (const it of await pageTextItems(p)) {
        const ns = norm(it.str);
        let at = ns.indexOf(nq);
        while (at >= 0) {
          const f0 = at / ns.length, f1 = Math.min(1, (at + nq.length) / ns.length);
          const box = it.vertical
            ? { x: it.x, y: it.y + it.h * f0, w: it.w, h: it.h * (f1 - f0) }
            : { x: it.x + it.w * f0, y: it.y, w: it.w * (f1 - f0), h: it.h };
          find.hits.push({ uid: p.uid, ...box });
          at = ns.indexOf(nq, at + nq.length);
        }
      }
    }
  }
  if (find.q !== q) return find.hits.length; // llegó otra búsqueda
  find.idx = find.hits.length ? 0 : -1;
  doc.pages.forEach(drawHits);
  updateFindCount();
  gotoHit();
  return find.hits.length;
}
function updateFindCount() {
  $('#findCount').textContent = find.q ? (find.hits.length ? `${find.idx + 1} de ${find.hits.length}` : 'Sin resultados') : '';
}
function drawHits(p) {
  const wrap = wrapOf(p.uid);
  if (!wrap) return;
  const layer = $('.hits', wrap);
  layer.innerHTML = '';
  find.hits.forEach((hit, i) => {
    if (hit.uid !== p.uid) return;
    layer.append(h('div', { class: `hit${i === find.idx ? ' current' : ''}`, style: { left: `${hit.x * scale}px`, top: `${hit.y * scale}px`, width: `${hit.w * scale}px`, height: `${hit.h * scale}px` } }));
  });
}
function gotoHit(delta = 0) {
  if (!find.hits.length) return;
  const prev = find.hits[find.idx];
  find.idx = (find.idx + delta + find.hits.length) % find.hits.length;
  const hit = find.hits[find.idx];
  if (prev && prev.uid !== hit.uid) drawHits(pageByUid(prev.uid));
  const p = pageByUid(hit.uid);
  drawHits(p);
  updateFindCount();
  const el = wrapOf(hit.uid)?.querySelector('.hit.current');
  if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}
let findT;
$('#findInput').addEventListener('input', (e) => { clearTimeout(findT); findT = setTimeout(() => runFind(e.target.value), 180); });
$('#findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoHit(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeFind();
});
$('#findNext').addEventListener('click', () => gotoHit(1));
$('#findPrev').addEventListener('click', () => gotoHit(-1));
$('#findClose').addEventListener('click', closeFind);

// ---------------------------------------------------------------- render genérico a lienzo
/** Dibuja una página (con su rotación si `rotated`) en un lienzo nuevo, sin anotaciones de PapelPDF. */
async function renderToCanvas(p, sc, rotated = true) {
  const c = document.createElement('canvas');
  const R = rotated ? p.rotate : 0;
  if (p.src) {
    const pg = await getPage(p.src, p.index);
    const vp = pg.getViewport({ scale: sc, rotation: R });
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    return c;
  }
  const ds = R % 180 ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
  c.width = Math.round(ds.w * sc); c.height = Math.round(ds.h * sc);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (p.image) {
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((R * Math.PI) / 180);
    ctx.drawImage(await loadImg(p.image), -p.w * sc / 2, -p.h * sc / 2, p.w * sc, p.h * sc);
  }
  return c;
}

// ---------------------------------------------------------------- OCR
async function ocrDialog() {
  const langSel = h('select', {}, ...OCR_LANGS.map((l) => h('option', { value: l.id, selected: l.id === 'spa' }, l.label)));
  const range = h('select', {},
    h('option', { value: 'all' }, `Todas las páginas (${doc.pages.length})`),
    h('option', { value: 'current' }, `Página actual (${currentPage + 1})`),
    ...(selPages.size > 1 ? [h('option', { value: 'selected', selected: true }, `Páginas seleccionadas (${selPages.size})`)] : []));
  const onlyScanned = h('input', { type: 'checkbox', checked: true });
  const r = await modal({
    title: 'Reconocer texto (OCR)',
    body: [
      h('p', { class: 'small' }, 'Convierte páginas escaneadas o fotos en texto que se puede buscar, seleccionar, copiar y exportar a Word. Funciona sin internet.'),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Idioma del documento'), langSel), h('label', { class: 'field' }, h('span', {}, 'Páginas'), range)),
      h('label', { class: 'toggle', style: { padding: 0 } }, onlyScanned, 'Omitir páginas que ya tienen texto'),
    ],
    actions: [{ label: 'Cancelar', result: null }, { label: 'Reconocer', kind: 'primary', value: () => ({ lang: langSel.value, range: range.value, onlyScanned: onlyScanned.checked }) }],
  });
  if (!r) return;
  let pages = r.range === 'current' ? [doc.pages[currentPage]] : r.range === 'selected' ? doc.pages.filter((p) => selPages.has(p.uid)) : doc.pages.slice();
  if (r.onlyScanned) {
    const keep = [];
    for (const p of pages) {
      const native = p.src ? (await (await getPage(p.src, p.index)).getTextContent()).items.filter((i) => i.str.trim()).length : 0;
      if (native < 3) keep.push(p);
    }
    if (!keep.length) { toast('Esas páginas ya tienen texto. Desmarca “Omitir páginas que ya tienen texto” para reconocerlas igual.'); return; }
    pages = keep;
  }
  await runOcr(pages, r.lang);
}

async function runOcr(pages, lang) {
  let cancelled = false;
  const bar = h('i');
  const label = h('p', { class: 'small' }, 'Preparando el reconocimiento…');
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal', role: 'dialog' },
    h('header', {}, h('h2', {}, 'Reconociendo texto…')),
    h('div', { class: 'content' }, label, h('div', { class: 'progress' }, bar)),
    h('footer', {}, h('button', { class: 'btn', onclick: () => { cancelled = true; label.textContent = 'Cancelando…'; } }, 'Cancelar'))));
  $('#modalRoot').append(back);
  const before = snapshot();
  let done = 0, words = 0;
  try {
    for (const p of pages) {
      if (cancelled) break;
      const i = doc.pages.indexOf(p);
      label.textContent = `Página ${i + 1} (${done + 1} de ${pages.length})`;
      const ds = displaySize(p);
      const sc = Math.min(300 / 72, 3400 / Math.max(ds.w, ds.h));
      const canvas = await renderToCanvas(p, sc, true);
      const res = await recognizeCanvas(canvas, lang, (prog) => { bar.style.width = `${((done + prog) / pages.length) * 100}%`; }, sc * 72);
      // píxeles (vista girada) → "unrot", guardado como cajas que se leen derechas con rot = p.rotate
      p.ocr = {
        lang,
        words: res.words.map((w) => {
          const dx = (w.x0 + w.x1) / 2 / sc, dy = (w.y0 + w.y1) / 2 / sc;
          const [ux, uy] = rotY(dx - ds.w / 2, dy - ds.h / 2, -p.rotate);
          return { t: w.t, cx: p.w / 2 + ux, cy: p.h / 2 + uy, dw: (w.x1 - w.x0) / sc, dh: (w.y1 - w.y0) / sc, rot: p.rotate };
        }),
      };
      words += p.ocr.words.length;
      done++;
      bar.style.width = `${(done / pages.length) * 100}%`;
      const wrap = wrapOf(p.uid);
      if (wrap) renderTextLayer(p, wrap, p.src ? await getPage(p.src, p.index) : null);
    }
  } catch (e) {
    console.error(e);
    toast(`Error en el OCR: ${e.message || e}`, 'error');
  } finally {
    back.remove();
  }
  if (done) {
    history.undo.push(before); history.redo = []; setDirty(true);
    textCache.clear();
    $('#scanBanner').hidden = true; scanned.dismissed = true;
    renderProps();
    toast(`Texto reconocido en ${done} página(s) · ${words} palabras. Guarda para que el PDF sea buscable.`);
  }
}

// ---------------------------------------------------------------- PDF final (redacción, cifrado)
async function finalBytes(opts = {}) {
  let bytes = await buildPdf(L, doc, opts);
  const pages = opts.pageFilter ? doc.pages.filter(opts.pageFilter) : doc.pages;
  const red = pages.map((p, i) => (p.annots.some((a) => a.type === 'redact') ? i : -1)).filter((i) => i >= 0);
  if (red.length) bytes = await rasterizePages(bytes, red, 200, 0.9);
  if (doc.security && !opts.noSecurity) bytes = (await api.qpdf({ op: 'encrypt', bytes, ...doc.security })).bytes;
  return bytes;
}

/** Sustituye páginas por una imagen de sí mismas: elimina de verdad el contenido redactado. */
async function rasterizePages(bytes, indices, dpi, quality) {
  const pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
  const lib = await L.PDFDocument.load(bytes, { ignoreEncryption: true });
  for (const i of indices) {
    const pg = await pdf.getPage(i + 1);
    const vp = pg.getViewport({ scale: dpi / 72, rotation: 0 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const jpg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', quality))).arrayBuffer());
    const old = lib.getPage(i);
    const rot = old.getRotation().angle;
    const { width, height } = vp.clone({ scale: 1 });
    // quita del formulario los campos que vivían en esta página
    try {
      const annots = old.node.Annots();
      const dicts = new Set(annots ? annots.asArray().map((r) => lib.context.lookup(r)) : []);
      const form = lib.getForm();
      for (const f of form.getFields()) if (f.acroField.getWidgets().some((w) => dicts.has(w.dict))) form.removeField(f);
    } catch { /* sin formulario */ }
    const img = await lib.embedJpg(jpg);
    lib.removePage(i);
    const np = lib.insertPage(i, [width, height]);
    np.drawImage(img, { x: 0, y: 0, width, height });
    np.setRotation(L.degrees(rot));
  }
  pdf.destroy();
  return lib.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------- proteger y comprimir
async function protectDialog() {
  const cur = doc.security || { user: '', owner: '', print: true, copy: true, modify: true };
  const user = h('input', { type: 'password', value: cur.user || '', autocomplete: 'new-password' });
  const user2 = h('input', { type: 'password', value: cur.user || '', autocomplete: 'new-password' });
  const owner = h('input', { type: 'password', value: cur.owner && cur.owner !== cur.user ? cur.owner : '', autocomplete: 'new-password' });
  const pr = h('input', { type: 'checkbox', checked: cur.print });
  const cp = h('input', { type: 'checkbox', checked: cur.copy });
  const md = h('input', { type: 'checkbox', checked: cur.modify });
  const r = await modal({
    title: 'Proteger con contraseña',
    body: [
      h('p', { class: 'small' }, 'Cifrado AES de 256 bits. Se aplica al guardar.'),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Contraseña para abrir'), user), h('label', { class: 'field' }, h('span', {}, 'Repetir contraseña'), user2)),
      h('label', { class: 'field' }, h('span', {}, 'Contraseña de permisos (opcional)'), owner),
      h('div', { class: 'check-list' }, h('span', { class: 'small muted' }, 'Permitir a quien abra el documento:'),
        h('label', {}, pr, 'Imprimir'), h('label', {}, cp, 'Copiar texto e imágenes'), h('label', {}, md, 'Modificar')),
    ],
    actions: [
      ...(doc.security ? [{ label: 'Quitar protección', left: true, result: 'remove' }] : []),
      { label: 'Cancelar', result: null },
      {
        label: 'Aplicar', kind: 'primary', value: () => {
          if (user.value !== user2.value) { toast('Las contraseñas no coinciden.', 'error'); return undefined; }
          const restricted = !(pr.checked && cp.checked && md.checked);
          if (!user.value && !owner.value && !restricted) { toast('Escribe una contraseña o limita algún permiso.', 'error'); return undefined; }
          const own = owner.value || user.value || randomPassword();
          return { user: user.value, owner: own, print: pr.checked, copy: cp.checked, modify: md.checked };
        },
      },
    ],
  });
  if (r == null) return;
  pushHistory();
  doc.security = r === 'remove' ? null : r;
  renderProps();
  toast(r === 'remove' ? 'Protección quitada. Guarda para aplicar.' : 'Protección lista. Se aplicará al guardar.');
}
function randomPassword() {
  const a = new Uint8Array(18); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, '0')).join('');
}

async function compressDialog() {
  const level = h('select', {},
    h('option', { value: 'lossless' }, 'Sin pérdida — conserva texto y calidad'),
    h('option', { value: 'medium' }, 'Media — páginas como imagen a 150 ppp'),
    h('option', { value: 'strong' }, 'Máxima — páginas como imagen a 100 ppp'));
  const r = await modal({
    title: 'Comprimir PDF',
    body: [h('label', { class: 'field' }, h('span', {}, 'Nivel'), level),
      h('p', { class: 'small muted' }, 'Los niveles Media y Máxima convierten cada página en imagen. Son ideales para escaneos, pero el texto deja de ser seleccionable (puedes volver a aplicar OCR). Se guarda como una copia.')],
    actions: [{ label: 'Cancelar', result: null }, { label: 'Comprimir', kind: 'primary', value: () => level.value }],
  });
  if (!r) return;
  toast('Comprimiendo…');
  const original = await finalBytes({ noSecurity: true });
  let bytes = original;
  if (r !== 'lossless') bytes = await rasterizePages(bytes, doc.pages.map((_p, i) => i), r === 'medium' ? 150 : 100, r === 'medium' ? 0.72 : 0.6);
  bytes = (await api.qpdf({ op: 'compress', bytes })).bytes;
  if (doc.security) bytes = (await api.qpdf({ op: 'encrypt', bytes, ...doc.security })).bytes;
  const res = await api.saveFile({ bytes, suggestedName: `${baseName(doc.name)}-comprimido.pdf`, ask: true });
  const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  if (res) toast(`Comprimido: ${kb(original.length)} → ${kb(bytes.length)} (${res.name})`);
}

// ---------------------------------------------------------------- convertir
async function docTextPages() {
  const out = [];
  for (const p of doc.pages) out.push(itemsToLines(await pageTextItems(p)));
  return out;
}
async function warnIfNoText(pages) {
  if (pages.some((l) => l.length)) return true;
  const r = await api.confirm({ message: 'Este documento no tiene texto reconocible.', detail: 'Parece escaneado. Usa primero «Reconocer texto (OCR)» y vuelve a exportar.', buttons: ['Exportar igualmente', 'Cancelar'] });
  return r === 0;
}
async function exportDocx() {
  const pages = await docTextPages();
  if (!(await warnIfNoText(pages))) return;
  const bytes = await api.makeDocx({ title: baseName(doc.name), pages });
  const res = await api.saveFile({ bytes, suggestedName: `${baseName(doc.name)}.docx`, ask: true, kind: 'docx' });
  if (res) toast(`Documento de Word creado: ${res.name}`);
}
async function exportTxt() {
  const pages = await docTextPages();
  if (!(await warnIfNoText(pages))) return;
  const txt = pages.map((lines) => lines.map((l) => l.text + (l.gapAfter ? '\n' : '')).join('\n')).join('\n\f\n');
  const res = await api.saveFile({ bytes: new TextEncoder().encode(txt), suggestedName: `${baseName(doc.name)}.txt`, ask: true, kind: 'txt' });
  if (res) toast(`Texto exportado: ${res.name}`);
}
async function exportImages() {
  const fmt = h('select', {}, h('option', { value: 'png' }, 'PNG (sin pérdida)'), h('option', { value: 'jpg' }, 'JPG (más ligero)'));
  const dpi = h('select', {}, ...[[96, '96 ppp (pantalla)'], [150, '150 ppp'], [300, '300 ppp (impresión)']].map(([v, t]) => h('option', { value: v, selected: v === 150 }, t)));
  const r = await modal({
    title: 'Exportar páginas como imágenes',
    body: [h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Formato'), fmt), h('label', { class: 'field' }, h('span', {}, 'Resolución'), dpi)),
      h('p', { class: 'small muted' }, `Se crea una imagen por página (${doc.pages.length}). Elige la carpeta en el siguiente paso.`)],
    actions: [{ label: 'Cancelar', result: null }, { label: 'Elegir carpeta…', kind: 'primary', value: () => ({ fmt: fmt.value, dpi: +dpi.value }) }],
  });
  if (!r) return;
  const folder = await api.chooseFolder('Carpeta para las imágenes');
  if (!folder) return;
  const bytes = await finalBytes({ noSecurity: true });
  const pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes }).promise;
  const pad = String(pdf.numPages).length;
  let last = null;
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const vp = pg.getViewport({ scale: r.dpi / 72 });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((res) => c.toBlob(res, r.fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.9));
    last = await api.writeInto(folder, `${baseName(doc.name)}-${String(i).padStart(pad, '0')}.${r.fmt}`, new Uint8Array(await blob.arrayBuffer()));
  }
  pdf.destroy();
  toast(`${doc.pages.length} imagen(es) guardadas`);
  if (last) api.showInFolder(last);
}

async function imagesToPdf() {
  const files = await api.openImages();
  if (files.length) await imagesToPdfFrom(files);
}
async function imagesToPdfFrom(files) {
  const pages = [];
  for (const f of files) {
    const mime = /\.png$/i.test(f.name) ? 'image/png' : /\.jpe?g$/i.test(f.name) ? 'image/jpeg' : /\.webp$/i.test(f.name) ? 'image/webp' : /\.gif$/i.test(f.name) ? 'image/gif' : 'image/bmp';
    let b64 = ''; const CH = 0x8000;
    for (let i = 0; i < f.bytes.length; i += CH) b64 += String.fromCharCode.apply(null, f.bytes.subarray(i, i + CH));
    const data = await normalizeImage(`data:${mime};base64,${btoa(b64)}`);
    const img = await loadImg(data);
    // tamaño de página: la imagen a 150 ppp, sin pasar de 842 pt (A4) por el lado mayor
    let w = img.naturalWidth * 72 / 150, hh = img.naturalHeight * 72 / 150;
    const k = Math.min(1, 842 / Math.max(w, hh)); w *= k; hh *= k;
    pages.push({ uid: uid(), src: null, index: 0, rotate: 0, w, h: hh, image: data, annots: [] });
  }
  if (!pages.length) return;
  if (doc) {
    structural(() => doc.pages.splice(currentPage + 1, 0, ...pages));
    toast(`${pages.length} imagen(es) insertadas como páginas`);
    return;
  }
  const d = newDoc();
  d.pages = pages; d.name = files.length === 1 ? `${files[0].name.replace(/\.[^.]+$/, '')}.pdf` : 'Imágenes.pdf'; d.dirty = true;
  setDocument(d);
  toast('PDF creado desde imágenes. Usa OCR si quieres que el texto se pueda buscar.');
}

async function shortcutsDialog() {
  const rows = [['Ctrl/⌘ + O', 'Abrir'], ['Ctrl/⌘ + S', 'Guardar'], ['Ctrl/⌘ + F', 'Buscar'], ['Ctrl/⌘ + Z / Y', 'Deshacer / Rehacer'], ['Ctrl/⌘ + rueda', 'Zoom'],
    ['V', 'Seleccionar'], ['H', 'Resaltar'], ['T', 'Texto'], ['N', 'Nota'], ['P', 'Lápiz'], ['R', 'Rectángulo'], ['Supr', 'Borrar selección'], ['Flechas', 'Mover selección (Shift = 10 pt)'], ['Re Pág / Av Pág', 'Página anterior / siguiente']];
  await modal({ title: 'Atajos de teclado', body: h('div', { class: 'shortcuts' }, ...rows.flatMap(([k, t]) => [h('kbd', {}, k), h('span', {}, t)])), actions: [{ label: 'Cerrar', kind: 'primary', result: true }] });
}

// ---------------------------------------------------------------- comandos
const commands = {
  open: async () => { const f = await api.openDialog(false); if (f.length) openFiles(f); },
  merge: async () => {
    const f = await api.openDialog(true);
    if (!f.length) return;
    if (doc) {
      const added = [];
      for (const file of f) { const l = await loadSource(file); if (l) { doc.sources[l.src.id] = l.src; added.push(...l.pages); } }
      if (added.length) { structural(() => doc.pages.push(...added)); toast(`${added.length} página(s) añadidas al final`); updateFormInfo(); }
    } else openFiles(f, { merge: true });
  },
  blank: blankDocument,
  home: async () => {
    if (doc && doc.dirty) {
      const r = await api.confirm({ message: 'Hay cambios sin guardar.', detail: '¿Cerrar el documento y descartar los cambios?', buttons: ['Descartar', 'Cancelar'] });
      if (r !== 0) return;
    }
    closeDocument();
  },
  close: () => commands.home(),
  save: () => save(false),
  saveAs: () => save(true),
  undo, redo,
  zoomIn: () => zoomBy(1.2), zoomOut: () => zoomBy(1 / 1.2), zoomFit: () => zoomFit(true),
  image: () => $('#imageInput').click(),
  signature: signatureDialog,
  rotateLeft: () => rotatePages(-90), rotateRight: () => rotatePages(90),
  deletePages, insertBlank, insertPdf, extract: extractPages,
  moveUp: () => moveBy(-1), moveDown: () => moveBy(1),
  watermark: watermarkDialog, pageNumbers: pageNumbersDialog,
  exportPng, print: printDoc, exportCsv, resetForm,
  about: aboutDialog,
  find: openFind,
  ocr: ocrDialog,
  protect: protectDialog,
  compress: compressDialog,
  toDocx: exportDocx,
  toTxt: exportTxt,
  toImages: exportImages,
  imagesToPdf: imagesToPdf,
  shortcuts: shortcutsDialog,
};
const needsDoc = new Set(['find', 'ocr', 'protect', 'compress', 'toDocx', 'toTxt', 'toImages', 'save', 'saveAs', 'undo', 'redo', 'zoomIn', 'zoomOut', 'zoomFit', 'image', 'signature', 'rotateLeft', 'rotateRight', 'deletePages', 'insertBlank', 'insertPdf', 'extract', 'moveUp', 'moveDown', 'watermark', 'pageNumbers', 'exportPng', 'print', 'exportCsv', 'resetForm', 'close']);
function run(cmd) {
  if (needsDoc.has(cmd) && !doc) return;
  const fn = commands[cmd];
  if (fn) Promise.resolve(fn()).catch((e) => { console.error(e); toast(String(e.message || e), 'error'); });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b) { run(b.dataset.cmd); return; }
  const t = e.target.closest('[data-tool]');
  if (t && t.dataset.tool !== tool) setTool(t.dataset.tool);
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    $$('[data-tab]').forEach((x) => x.classList.toggle('active', x === tab));
    $$('.tb-group').forEach((g) => { g.hidden = g.dataset.panel !== tab.dataset.tab; });
    if (tab.dataset.tab !== 'comment' && tool !== 'select') setTool('select');
  }
});
$('#highlightFields').addEventListener('change', (e) => $$('.fields').forEach((f) => f.classList.toggle('hl', e.target.checked)));
api.onMenu(run);
api.onOpenPath(openPath);

document.addEventListener('keydown', (e) => {
  if (!doc || isEditable(document.activeElement) || $('.modal-back')) return;
  const k = e.key.toLowerCase();
  if ((k === 'delete' || k === 'backspace') && selected) { e.preventDefault(); deleteSelected(); return; }
  if (k === 'escape' && !$('#findbar').hidden) { closeFind(); return; }
  if (k === 'escape') { if (selected) { const p = pageByUid(selected.uid); selected = null; drawOverlay(p); renderProps(); } setTool('select'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { v: 'select', h: 'highlight', t: 'text', n: 'note', p: 'ink', r: 'rect' };
  if (map[k]) { setTool(map[k]); return; }
  if (k === 'pagedown' || k === 'arrowright' && !selected) scrollToPage(Math.min(currentPage + 1, doc.pages.length - 1));
  if (k === 'pageup' || k === 'arrowleft' && !selected) scrollToPage(Math.max(currentPage - 1, 0));
  if (k === 'home') scrollToPage(0);
  if (k === 'end') scrollToPage(doc.pages.length - 1);
  if (selected && k.startsWith('arrow')) {
    const an = findAnnot(selected); if (!an || an.type === 'ink') return;
    e.preventDefault(); pushHistory();
    const p = pageByUid(selected.uid);
    const step = e.shiftKey ? 10 : 1;
    const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
    const [ux, uy] = rotY(d[0], d[1], -p.rotate);
    an.cx += ux; an.cy += uy; drawOverlay(p);
  }
});

// arrastrar archivos a la ventana
let dragDepth = 0;
const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { dragDepth++; $('#dropOverlay').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  const files = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const imgs = [...e.dataTransfer.files].filter((f) => /^image\/(png|jpeg)/.test(f.type));
  if (!files.length && imgs.length && doc) { startPlacing(await normalizeImage(await readAsDataURL(imgs[0]))); return; }
  if (!files.length && imgs.length) { await imagesToPdfFrom(await Promise.all(imgs.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))); return; }
  if (!files.length) { toast('Solo se pueden abrir archivos PDF.', 'error'); return; }
  const loaded = await Promise.all(files.map(async (f) => ({ name: f.name, path: api.pathForFile(f), bytes: new Uint8Array(await f.arrayBuffer()) })));
  if (doc && files.length >= 1 && e.target.closest && e.target.closest('#thumbs')) {
    const added = [];
    for (const file of loaded) { const l = await loadSource(file); if (l) { doc.sources[l.src.id] = l.src; added.push(...l.pages); } }
    if (added.length) { structural(() => doc.pages.push(...added)); toast(`${added.length} página(s) añadidas`); }
    return;
  }
  openFiles(loaded, { merge: loaded.length > 1 });
});

let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => doc && zoomFit(true), 200); });

// ganchos para pruebas automáticas
window.__papel = { get doc() { return doc; }, run, imagesFrom: (files) => imagesToPdfFrom(files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) }))), setTool, get scale() { return scale; }, find: (q) => { openFind(); $('#findInput').value = q; return runFind(q); } };

renderRecents();
