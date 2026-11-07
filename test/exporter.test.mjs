// Pruebas del exportador sin interfaz: node test/exporter.test.mjs
import * as L from 'pdf-lib';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPdf, canSaveInPlace } from '../src/exporter.js';

const outDir = process.argv[2] || 'test/out';
fs.mkdirSync(outDir, { recursive: true });

import { makeSample } from './sample.mjs';

const bytes = await makeSample();
fs.writeFileSync(path.join(outDir, 'muestra.pdf'), bytes);

const page = (index, rotate = 0) => ({ uid: 'p' + index, src: 'a', index, rotate, w: 612, h: 792, view: [0, 0, 612, 792], annots: [] });
const state = {
  sources: { a: { id: 'a', kind: 'pdf', name: 'muestra.pdf', bytes, pageCount: 3 } },
  pages: [page(0), page(1, 90), page(2)],
  fields: { a: { nombre: 'Santiago Ñúñez', acepto: true, color: 'Verde' } },
  settings: { watermark: { text: 'CONFIDENCIAL', opacity: 0.15, size: 60 }, pageNumbers: { format: 'Página {n} de {N}', position: 'center' } },
};
state.pages[0].annots.push(
  { id: 'h', type: 'highlight', cx: 300, cy: 147, dw: 330, dh: 20, rot: 0, color: '#ffd400', opacity: 0.4 },
  { id: 't', type: 'text', cx: 400, cy: 300, dw: 200, dh: 50, rot: 0, text: 'Revisado ✓\nsegunda línea', size: 14, color: '#c0392b' },
  { id: 'r', type: 'rect', cx: 450, cy: 600, dw: 120, dh: 80, rot: 0, color: '#2563eb', width: 2 },
  { id: 'i', type: 'ink', points: [[100, 700], [150, 650], [200, 720], [260, 680]], color: '#16a34a', width: 3 },
  { id: 'n', type: 'note', cx: 560, cy: 60, dw: 22, dh: 22, rot: 0, text: 'Comentario de prueba', color: '#f5c518' },
  { id: 'u', type: 'underline', cx: 300, cy: 160, dw: 330, dh: 18, rot: 0, color: '#dc2626', width: 1.5 },
);
// texto añadido mientras la página 2 se veía girada 90°
state.pages[1].annots.push({ id: 't2', type: 'text', cx: 300, cy: 400, dw: 220, dh: 30, rot: 90, text: 'Derecho en pantalla', size: 16, color: '#111111' });

assert.equal(canSaveInPlace(state), true);
const out1 = await buildPdf(L, state);
fs.writeFileSync(path.join(outDir, 'guardado.pdf'), out1);
const re = await L.PDFDocument.load(out1);
assert.equal(re.getPageCount(), 3);
assert.equal(re.getForm().getTextField('nombre').getText(), 'Santiago Ñúñez', 'el formulario sigue editable con su valor');
assert.equal(re.getForm().getCheckBox('acepto').isChecked(), true);
assert.deepEqual(re.getForm().getDropdown('color').getSelected(), ['Verde']);
assert.equal(re.getPage(1).getRotation().angle, 90);
assert.ok(re.getPage(0).node.Annots(), 'la nota se guardó como anotación PDF');

// Reordenar + borrar + página en blanco + rotar → documento nuevo y aplanado
const s2 = structuredClone({ ...state, sources: {} });
s2.sources = state.sources;
s2.pages = [state.pages[2], { uid: 'b', src: null, index: 0, rotate: 0, w: 612, h: 792, annots: [] }, { ...state.pages[0], rotate: 180 }];
assert.equal(canSaveInPlace(s2), false);
const out2 = await buildPdf(L, s2);
fs.writeFileSync(path.join(outDir, 'reorganizado.pdf'), out2);
const re2 = await L.PDFDocument.load(out2);
assert.equal(re2.getPageCount(), 3);
assert.equal(re2.getPage(2).getRotation().angle, 180);

// Extraer solo la primera página
const out3 = await buildPdf(L, state, { pageFilter: (_p, i) => i === 0 });
assert.equal((await L.PDFDocument.load(out3)).getPageCount(), 1);

// Página de imagen + texto OCR invisible + corrector + Bates
const png = fs.readFileSync(new URL('./escaneo.png', import.meta.url));
const s4 = {
  sources: {}, fields: {},
  pages: [{ uid: 'img', src: null, index: 0, rotate: 0, w: 612, h: 792, image: 'data:image/png;base64,' + png.toString('base64'),
    annots: [{ id: 'w', type: 'whiteout', cx: 300, cy: 700, dw: 200, dh: 30, rot: 0 }],
    ocr: { words: [{ t: 'Factura', cx: 120, cy: 80, dw: 120, dh: 26, rot: 0 }, { t: 'pagada', cx: 238, cy: 80, dw: 100, dh: 26, rot: 0 }] } }],
  settings: { pageNumbers: { format: 'EXP-{n:6}', position: 'right', start: 41 } },
};
const out4 = await buildPdf(L, s4);
fs.writeFileSync(path.join(outDir, 'imagen-ocr.pdf'), out4);
const { execFileSync } = await import('node:child_process');
const txt = execFileSync('pdftotext', [path.join(outDir, 'imagen-ocr.pdf'), '-'], { encoding: 'utf8' });
assert.match(txt, /Factura pagada/, 'el texto OCR invisible se puede extraer');
assert.match(txt, /EXP-000041/, 'numeración Bates con ceros y número inicial');

console.log('OK: exportador — 4 escenarios');
