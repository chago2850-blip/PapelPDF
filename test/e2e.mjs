// Prueba de punta a punta: abre la app real, anota, rellena, firma, gira, guarda y verifica.
// Uso: xvfb-run -a node test/e2e.mjs   (en Linux sin pantalla)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as L from 'pdf-lib';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
const shots = path.join(out, 'shots');
fs.mkdirSync(shots, { recursive: true });
for (const f of fs.readdirSync(out)) if (/^(muestra-guardado|.*-paginas)\.pdf$|\.csv$/.test(f)) fs.rmSync(path.join(out, f));

// documento de muestra (el mismo que usa la prueba del exportador)
const { makeSample } = await import('./sample.mjs');
const sample = path.join(out, 'muestra.pdf');
fs.writeFileSync(sample, await makeSample());

const app = await electron.launch({
  executablePath: process.env.PAPELPDF_EXE || require('electron'),
  args: process.env.PAPELPDF_EXE ? [sample, '--no-sandbox'] : [root, sample, '--no-sandbox'],
  env: { ...process.env, PAPELPDF_TEST_DIR: out },
});
const win = await app.firstWindow();
await win.setViewportSize?.({ width: 1360, height: 860 });
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await win.waitForSelector('.page-wrap .fld', { timeout: 20000 });
await win.waitForTimeout(800);
await win.screenshot({ path: path.join(shots, '01-abierto.png') });

const pageBox = async (i) => win.locator('.page-wrap').nth(i).boundingBox();
// que la página 1 quepa entera en pantalla
await win.evaluate(() => { window.__papel.run('zoomOut'); window.__papel.run('zoomOut'); });
await win.waitForTimeout(400);
let b, sx;
const refresh = async () => { await win.locator('.viewer').evaluate((v) => v.scrollTo(0, 0)); b = await pageBox(0); sx = b.width / 612; };
const at = (x, y) => [b.x + x * sx, b.y + y * sx];
await refresh();

// Resaltar una línea
await win.click('[data-tool="highlight"]');
await win.mouse.move(...at(70, 140)); await win.mouse.down(); await win.mouse.move(...at(380, 158), { steps: 5 }); await win.mouse.up();
// Texto
await win.click('[data-tool="text"]'); await refresh();
await win.mouse.click(...at(330, 230));
await win.keyboard.type('Aprobado por Santiago');
await win.mouse.click(...at(560, 760)); // salir de la edición
// Lápiz
await win.click('[data-tool="ink"]'); await refresh();
await win.mouse.move(...at(100, 640)); await win.mouse.down();
for (const [x, y] of [[140, 600], [180, 660], [230, 610], [270, 650]]) await win.mouse.move(...at(x, y), { steps: 4 });
await win.mouse.up();
// Rectángulo
await win.click('[data-tool="rect"]'); await refresh();
await win.mouse.move(...at(400, 560)); await win.mouse.down(); await win.mouse.move(...at(540, 640), { steps: 4 }); await win.mouse.up();
// Nota
await win.click('[data-tool="note"]'); await refresh();
await win.mouse.click(...at(560, 60));
await win.fill('#noteText', 'Revisar el monto');
await win.click('[data-tool="select"]');

// Formulario
await win.click('[data-tab="form"]');
await win.fill('.fld[data-name="nombre"]', 'Santiago Miguel');
await win.press('.fld[data-name="nombre"]', 'Tab');
await win.check('.fld[data-name="acepto"]');
await win.selectOption('.fld[data-name="color"]', 'Azul');

// Firma dibujada
await win.click('[data-tab="comment"]');
await win.click('[data-cmd="signature"] >> nth=0');
const pad = await win.locator('.sig-pad').boundingBox();
await win.mouse.move(pad.x + 40, pad.y + 120); await win.mouse.down();
for (let k = 0; k <= 24; k++) await win.mouse.move(pad.x + 40 + k * 14, pad.y + 100 + Math.sin(k / 2) * 40, { steps: 2 });
await win.mouse.up();
await win.click('.modal .btn.primary');
await refresh();
await win.mouse.click(...at(160, 470));
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(shots, '02-anotado.png') });

// Página: girar la página 3 y añadir marca de agua y numeración
await win.click('[data-tab="page"]');
await win.click('.thumb >> nth=2');
await win.click('[data-cmd="rotateRight"]');
await win.click('[data-tab="edit"]');
await win.click('[data-panel="edit"] [data-cmd="watermark"]');
await win.click('.modal .btn.primary');
await win.click('[data-panel="edit"] [data-cmd="pageNumbers"]');
await win.click('.modal .btn.primary');
await win.waitForTimeout(500);

// Deshacer / rehacer la numeración
const pnBefore = await win.locator('.decor .pn').count();
await win.evaluate(() => window.__papel.run('undo'));
assert.equal(await win.locator('.decor .pn').count(), 0, 'deshacer quita la numeración');
await win.evaluate(() => window.__papel.run('redo'));
assert.equal(await win.locator('.decor .pn').count(), pnBefore, 'rehacer la devuelve');

await win.evaluate(() => window.__papel.run('zoomFit'));
await win.waitForTimeout(600);
await win.locator('.viewer').evaluate((v) => v.scrollTo(0, v.scrollHeight));
await win.waitForTimeout(700);
await win.screenshot({ path: path.join(shots, '03-girada-marca.png') });

// Estado interno
const st = await win.evaluate(() => {
  const d = window.__papel.doc;
  return { all: d.pages.map((p) => p.annots.map((a) => a.type)), n: d.pages.length, annots: d.pages[0].annots.map((a) => a.type), rot: d.pages.map((p) => p.rotate), fields: d.fields };
});
console.log(JSON.stringify(st.all));
assert.deepEqual(st.annots.sort(), ['highlight', 'image', 'ink', 'note', 'rect', 'text'].sort());
assert.deepEqual(st.rot, [0, 90, 90]);

// Guardar (sin diálogo en modo prueba → test/out/muestra.pdf se sobrescribe, así que usamos Guardar como)
await win.evaluate(() => window.__papel.run('saveAs'));
await win.waitForSelector('.toast:has-text("Guardado")', { timeout: 10000 });
const saved = path.join(out, 'muestra.pdf');
const re = await L.PDFDocument.load(fs.readFileSync(saved));
assert.equal(re.getPageCount(), 3);
assert.equal(re.getForm().getTextField('nombre').getText(), 'Santiago Miguel');
assert.equal(re.getForm().getCheckBox('acepto').isChecked(), true);
assert.deepEqual(re.getForm().getDropdown('color').getSelected(), ['Azul']);
assert.equal(re.getPage(2).getRotation().angle, 90);
fs.copyFileSync(saved, path.join(out, 'muestra-guardado.pdf'));

// Extraer la página seleccionada y exportar CSV
await win.evaluate(() => window.__papel.run('extract'));
await win.waitForSelector('.toast:has-text("extraídas")', { timeout: 10000 });
assert.equal((await L.PDFDocument.load(fs.readFileSync(path.join(out, 'muestra-paginas.pdf')))).getPageCount(), 1);
await win.evaluate(() => window.__papel.run('exportCsv'));
await win.waitForSelector('.toast:has-text("Datos exportados")', { timeout: 10000 });
const csv = fs.readFileSync(path.join(out, 'muestra-datos.csv'), 'utf8');
assert.match(csv, /"nombre","Santiago Miguel"/);

// Volver al inicio: debe aparecer en recientes
await win.evaluate(() => window.__papel.run('home'));
await win.waitForSelector('#recentList li');
await win.screenshot({ path: path.join(shots, '00-inicio.png') });

await app.close();
const real = errors.filter((e) => !/Autofill|DevTools|Electron Security/i.test(e));
assert.deepEqual(real, [], 'sin errores en consola');
console.log('OK: e2e — abrir, anotar, formulario, firma, girar, marca de agua, numeración, deshacer, guardar, extraer, CSV');
