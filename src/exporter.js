// Construye el PDF final a partir del estado del documento.
// No depende del DOM: recibe la librería pdf-lib como parámetro para poder
// usarse igual en la app (UMD global) y en las pruebas de Node.
import { ownToUnrot, unrotToPdf, annotBBox, displaySize, hexToRgb01, formatPageNumber } from './geometry.js';

const PAD = 4; // relleno interno de los cuadros de texto, en puntos

function safeText(font, s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (ch === '\n') { out += ch; continue; }
    try { font.widthOfTextAtSize(ch, 10); out += ch; } catch { out += '?'; }
  }
  return out;
}

export function fillForm(L, libDoc, values) {
  if (!values || !Object.keys(values).length) return;
  let form;
  try { form = libDoc.getForm(); } catch { return; }
  for (const [name, v] of Object.entries(values)) {
    try {
      const f = form.getFieldMaybe ? form.getFieldMaybe(name) : form.getField(name);
      if (!f) continue;
      if (f instanceof L.PDFTextField) f.setText(v == null ? '' : String(v));
      else if (f instanceof L.PDFCheckBox) (v ? f.check() : f.uncheck());
      else if (f instanceof L.PDFRadioGroup) { if (v) f.select(String(v)); }
      else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) { if (v) f.select(String(v)); }
    } catch (err) {
      console.warn('No se pudo rellenar el campo', name, err && err.message);
    }
  }
}

/** Escribe cada palabra reconocida como texto invisible (modo de render 3) sobre su caja. */
function drawOcrText(L, pg, font, words, toPdf) {
  const key = pg.node.newFontDictionary(font.name, font.ref);
  const ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
  for (const w of words) {
    const t = safeText(font, w.t).replace(/\n/g, ' ');
    if (!t.trim() || w.dw <= 0 || w.dh <= 0) continue;
    const size = Math.max(1, w.dh * 0.9);
    const natural = font.widthOfTextAtSize(t, size);
    if (!natural) continue;
    const [x, y] = toPdf(...ownToUnrot(w, -w.dw / 2, w.dh / 2 - w.dh * 0.18));
    const rad = ((w.rot || 0) * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    ops.push(
      L.setFontAndSize(key, size),
      L.PDFOperator.of(L.PDFOperatorNames.SetTextHorizontalScaling, [L.PDFNumber.of(+(100 * w.dw / natural).toFixed(2))]),
      L.setTextMatrix(c, s, -s, c, x, y),
      L.showText(font.encodeText(t + ' ')),
    );
  }
  ops.push(L.endText(), L.popGraphicsState());
  pg.pushOperators(...ops);
}

/** pdf-lib deja en /Annots referencias a widgets que borró al aplanar: se eliminan. */
export function pruneDeadAnnots(L, doc) {
  for (const pg of doc.getPages()) {
    const annots = pg.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i);
      if (ref instanceof L.PDFRef && !doc.context.lookup(ref)) annots.remove(i);
    }
  }
}

/** ¿Se puede guardar sobre el archivo original conservando sus campos de formulario? */
export function canSaveInPlace(state) {
  const ids = new Set(state.pages.map((p) => p.src));
  if (ids.size !== 1) return false;
  const [id] = ids;
  const src = state.sources[id];
  if (!src || src.kind !== 'pdf') return false;
  if (state.pages.length !== src.pageCount) return false;
  return state.pages.every((p, i) => p.index === i);
}

async function embedImage(out, cache, dataUrl) {
  if (cache.has(dataUrl)) return cache.get(dataUrl);
  const b64 = dataUrl.split(',')[1];
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const img = /^data:image\/jpe?g/i.test(dataUrl) ? await out.embedJpg(bytes) : await out.embedPng(bytes);
  cache.set(dataUrl, img);
  return img;
}

/**
 * @param L      módulo pdf-lib
 * @param state  { sources, pages, fields, settings }
 * @param opts   { pageFilter?: (page, i) => boolean } para extraer páginas
 * @returns Uint8Array
 */
export async function buildPdf(L, state, opts = {}) {
  const { degrees, rgb, StandardFonts } = L;
  const pages = opts.pageFilter ? state.pages.filter(opts.pageFilter) : state.pages;
  if (!pages.length) throw new Error('El documento no tiene páginas.');
  const subset = pages.length !== state.pages.length;

  let out;
  let outPages = [];
  const imgCache = new Map();
  if (!subset && canSaveInPlace(state)) {
    const src = state.sources[pages[0].src];
    out = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
    fillForm(L, out, state.fields?.[src.id]);
    outPages = out.getPages();
  } else {
    out = await L.PDFDocument.create();
    const libDocs = new Map();
    for (const p of pages) {
      if (p.src && !libDocs.has(p.src)) {
        const src = state.sources[p.src];
        const d = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true });
        fillForm(L, d, state.fields?.[src.id]);
        try { d.getForm().flatten(); } catch { /* sin formulario */ }
        pruneDeadAnnots(L, d);
        libDocs.set(p.src, d);
      }
    }
    for (const p of pages) {
      if (!p.src) {
        const blank = out.addPage([p.w, p.h]);
        if (p.image) {
          const img = await embedImage(out, imgCache, p.image);
          blank.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
        }
        outPages.push(blank);
      } else {
        const [cp] = await out.copyPages(libDocs.get(p.src), [p.index]);
        outPages.push(out.addPage(cp));
      }
    }
  }
  out.setProducer('PapelPDF');
  out.setModificationDate(new Date());

  const font = await out.embedFont(StandardFonts.Helvetica);
  const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
  const total = pages.length;

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pg = outPages[i];
    pg.setRotation(degrees(p.rotate));
    // view: caja de la página en su propio espacio PDF
    const view = p.src ? p.view : [0, 0, p.w, p.h];
    const toPdf = (x, y) => unrotToPdf(view, x, y);

    // Capa de texto invisible del OCR: hace el PDF buscable y seleccionable.
    if (p.ocr && p.ocr.words && p.ocr.words.length) drawOcrText(L, pg, font, p.ocr.words, toPdf);

    for (const an of p.annots || []) {
      const [r, g, b] = hexToRgb01(an.color);
      const color = rgb(r, g, b);
      const opacity = an.opacity ?? 1;
      if (an.type === 'ink') {
        if (an.points.length < 2) continue;
        const d = an.points.map((pt, k) => `${k ? 'L' : 'M'}${pt[0].toFixed(2)},${pt[1].toFixed(2)}`).join(' ');
        pg.drawSvgPath(d, { x: view[0], y: view[3], borderColor: color, borderWidth: an.width || 2, borderOpacity: opacity, borderLineCap: L.LineCapStyle?.Round });
        continue;
      }
      const bb = annotBBox(an);
      const [px, py] = toPdf(bb.x, bb.y + bb.h); // esquina inferior izquierda en PDF
      if (an.type === 'whiteout' || an.type === 'redact') {
        pg.drawRectangle({ x: px, y: py, width: bb.w, height: bb.h, color: an.type === 'redact' ? rgb(0, 0, 0) : rgb(1, 1, 1) });
      } else if (an.type === 'highlight') {
        pg.drawRectangle({ x: px, y: py, width: bb.w, height: bb.h, color, opacity: an.opacity ?? 0.4, blendMode: L.BlendMode?.Multiply });
      } else if (an.type === 'rect') {
        pg.drawRectangle({ x: px, y: py, width: bb.w, height: bb.h, borderColor: color, borderWidth: an.width || 2, borderOpacity: opacity });
      } else if (an.type === 'ellipse') {
        pg.drawEllipse({ x: px + bb.w / 2, y: py + bb.h / 2, xScale: bb.w / 2, yScale: bb.h / 2, borderColor: color, borderWidth: an.width || 2, borderOpacity: opacity });
      } else if (an.type === 'underline' || an.type === 'strike') {
        // la línea va en el marco propio: abajo (subrayado) o al centro (tachado)
        const oy = an.type === 'underline' ? an.dh / 2 : 0;
        const a = toPdf(...ownToUnrot(an, -an.dw / 2, oy));
        const z = toPdf(...ownToUnrot(an, an.dw / 2, oy));
        pg.drawLine({ start: { x: a[0], y: a[1] }, end: { x: z[0], y: z[1] }, color, thickness: an.width || 1.5, opacity });
      } else if (an.type === 'text') {
        const size = an.size || 14;
        const [ax, ay] = toPdf(...ownToUnrot(an, -an.dw / 2 + PAD, -an.dh / 2 + PAD + size * 0.8));
        const f = an.bold ? fontBold : font;
        pg.drawText(safeText(f, an.text), { x: ax, y: ay, size, font: f, color, lineHeight: size * 1.2, rotate: degrees(an.rot || 0), opacity });
      } else if (an.type === 'image') {
        const img = await embedImage(out, imgCache, an.data);
        const [ax, ay] = toPdf(...ownToUnrot(an, -an.dw / 2, an.dh / 2));
        pg.drawImage(img, { x: ax, y: ay, width: an.dw, height: an.dh, rotate: degrees(an.rot || 0), opacity });
      } else if (an.type === 'note') {
        const [x1, y1] = toPdf(bb.x, bb.y + bb.h);
        const annot = out.context.obj({
          Type: 'Annot', Subtype: 'Text', Name: 'Comment', Open: false,
          Rect: [x1, y1, x1 + bb.w, y1 + bb.h],
          Contents: L.PDFHexString.fromText(an.text || ''),
          T: L.PDFHexString.fromText('PapelPDF'),
          C: [r, g, b],
          M: L.PDFString.fromDate(new Date()),
        });
        pg.node.addAnnot(out.context.register(annot));
      }
    }

    // Elementos de documento: marca de agua y numeración, siempre derechos a la vista.
    const s = state.settings || {};
    const pageAsAnnot = { cx: p.w / 2, cy: p.h / 2, rot: p.rotate };
    const disp = displaySize(p);
    if (s.watermark && s.watermark.text) {
      const wm = s.watermark;
      const size = wm.size || 60;
      const txt = safeText(fontBold, wm.text);
      const tw = fontBold.widthOfTextAtSize(txt, size);
      const rot = p.rotate + (wm.angle ?? 45);
      const an = { ...pageAsAnnot, rot };
      const [ax, ay] = toPdf(...ownToUnrot(an, -tw / 2, size * 0.35));
      const [r, g, b] = hexToRgb01(wm.color || '#c0392b');
      pg.drawText(txt, { x: ax, y: ay, size, font: fontBold, color: rgb(r, g, b), opacity: wm.opacity ?? 0.2, rotate: degrees(rot) });
    }
    if (s.pageNumbers) {
      const pn = s.pageNumbers;
      const size = pn.size || 10;
      const txt = safeText(font, formatPageNumber(pn.format, i + 1 + ((pn.start || 1) - 1), total));
      const tw = font.widthOfTextAtSize(txt, size);
      const margin = 24;
      let ox = -tw / 2;
      if (pn.position === 'right') ox = disp.w / 2 - margin - tw;
      if (pn.position === 'left') ox = -disp.w / 2 + margin;
      const [ax, ay] = toPdf(...ownToUnrot(pageAsAnnot, ox, disp.h / 2 - margin));
      pg.drawText(txt, { x: ax, y: ay, size, font, color: rgb(0.2, 0.2, 0.2), rotate: degrees(p.rotate) });
    }
  }
  // Sin flujos de objetos: máxima compatibilidad con visores antiguos.
  return out.save({ useObjectStreams: false });
}
