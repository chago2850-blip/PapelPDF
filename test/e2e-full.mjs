// Funciones v1.1: imágenes a PDF, aviso de escaneo, OCR, búsqueda, contraseña, redacción, Word, texto, compresión.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out', 'full');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };

const app = await electron.launch({
  executablePath: process.env.PAPELPDF_EXE || require('electron'),
  args: process.env.PAPELPDF_EXE ? ['--no-sandbox'] : [root, '--no-sandbox'],
  env: { ...process.env, PAPELPDF_TEST_DIR: out },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await win.waitForSelector('#home');
const clearToasts = () => win.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

// 1) Imágenes a PDF
const png = fs.readFileSync(path.join(root, 'test', 'escaneo.png'));
await win.evaluate((f) => window.__papel.imagesFrom(f), [{ name: 'escaneo.png', bytes: [...png] }]);
await win.waitForSelector('.page-wrap canvas');
await win.waitForSelector('#scanBanner:not([hidden])', { timeout: 10000 });
await win.screenshot({ path: path.join(out, '10-escaneo.png') });

// 2) OCR en español
await win.click('#scanBanner [data-cmd="ocr"]');
await win.click('.modal .btn.primary');
await win.waitForSelector('.toast:has-text("Texto reconocido")', { timeout: 180000 });
const words = await win.evaluate(() => window.__papel.doc.pages[0].ocr.words.map((w) => w.t).join(' '));
console.log('OCR:', words);
assert.match(words, /Factura/i);
assert.match(words, /Importe/i);

// 3) Búsqueda (sin acentos encuentra con acentos)
const n = await win.evaluate(() => window.__papel.find('pacifico'));
assert.ok(n >= 1, 'la búsqueda encuentra texto del OCR');
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(out, '11-ocr-busqueda.png') });
await win.keyboard.press('Escape');

// 4) Guardar: PDF buscable
await clearToasts();
await win.evaluate(() => window.__papel.run('saveAs'));
await win.waitForSelector('.toast:has-text("Guardado")', { timeout: 15000 });
const saved1 = path.join(out, 'escaneo.pdf');
const txt1 = sh('pdftotext', [saved1, '-']);
assert.match(txt1, /Importe total/i, 'el PDF guardado tiene texto buscable');
fs.copyFileSync(saved1, path.join(out, 'escaneo-buscable.pdf'));

// 5) Word y texto
await clearToasts();
await win.evaluate(() => window.__papel.run('toDocx'));
await win.waitForSelector('.toast:has-text("Word")', { timeout: 15000 });
const docxXml = sh('unzip', ['-p', path.join(out, 'escaneo.docx'), 'word/document.xml']);
assert.match(docxXml, /Factura/);
await clearToasts();
await win.evaluate(() => window.__papel.run('toTxt'));
await win.waitForSelector('.toast:has-text("Texto exportado")', { timeout: 15000 });
assert.match(fs.readFileSync(path.join(out, 'escaneo.txt'), 'utf8'), /Concepto/);

// 6) Contraseña
await clearToasts();
await win.evaluate(() => window.__papel.run('protect'));
const pw = win.locator('.modal input[type="password"]');
await pw.nth(0).fill('papel123');
await pw.nth(1).fill('papel123');
await win.click('.modal .btn.primary');
// 7) Redactar el importe
await win.click('[data-tab="protect"]');
await win.click('[data-tool="redact"]');
await win.evaluate(() => document.querySelector('.viewer').scrollTo(0, 0));
const b = await win.locator('.page-wrap').first().boundingBox();
const k = b.width / 816; // la página mide 816 pt (1700 px a 150 ppp)
await win.mouse.move(b.x + 60 * k, b.y + 240 * k); await win.mouse.down();
await win.mouse.move(b.x + 700 * k, b.y + 275 * k, { steps: 5 }); await win.mouse.up();
await win.click('[data-panel="protect"] [data-tool="redact"]'); // sigue activa; vuelve a seleccionar
await win.evaluate(() => window.__papel.setTool('select'));
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(out, '12-redaccion.png') });
await clearToasts();
await win.evaluate(() => window.__papel.run('save'));
await win.waitForSelector('.toast:has-text("Guardado")', { timeout: 30000 });
const enc = sh('qpdf', ['--show-encryption', '--password=papel123', saved1]);
assert.match(enc, /User password = papel123/, 'cifrado con contraseña');
const dec = path.join(out, 'descifrado.pdf');
sh('qpdf', ['--password=papel123', '--decrypt', saved1, dec]);
const txt2 = sh('pdftotext', [dec, '-']);
assert.doesNotMatch(txt2, /12,450/, 'el texto redactado ya no existe en el archivo');
sh('pdftoppm', ['-r', '40', '-png', dec, path.join(out, 'redactado')]);

// 8) Comprimir
await clearToasts();
await win.evaluate(() => window.__papel.run('compress'));
await win.click('.modal .btn.primary');
await win.waitForSelector('.toast:has-text("Comprimido")', { timeout: 30000 });

// 9) Abrir el PDF protegido pidiendo la contraseña
await clearToasts();
await win.evaluate(() => window.__papel.run('close'));
await win.evaluate((p) => window.papel.readPath(p).then((f) => window.__papelOpen && window.__papelOpen(f)), saved1).catch(() => {});
await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('open-path', p), saved1);
await win.waitForSelector('.modal input[type="password"]', { timeout: 10000 });
await win.fill('.modal input[type="password"]', 'papel123');
await win.click('.modal .btn.primary');
await win.waitForSelector('.page-wrap canvas', { timeout: 15000 });
const sec = await win.evaluate(() => window.__papel.doc.security);
assert.equal(sec.user, 'papel123', 'conserva la contraseña al reabrir');
await win.screenshot({ path: path.join(out, '13-reabierto.png') });

await app.close();
const real = errors.filter((e) => !/Autofill|DevTools|Electron Security/i.test(e));
assert.deepEqual(real, [], 'sin errores en consola');
console.log('OK: e2e completo — imágenes a PDF, OCR, búsqueda, PDF buscable, Word, texto, contraseña, redacción, compresión, reabrir protegido');
