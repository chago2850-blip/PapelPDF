// Copia el motor de OCR (tesseract.js-core) y los modelos de español e inglés a
// ./vendor/ocr para que la app funcione sin conexión y con rutas fijas al empaquetar.
// Se ejecuta automáticamente después de `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const out = path.join(root, 'vendor', 'ocr');
const coreOut = path.join(out, 'core');
const langOut = path.join(out, 'tessdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(coreOut, { recursive: true });
fs.mkdirSync(langOut, { recursive: true });

// tesseract.js-core puede estar en la raíz o anidado dentro de tesseract.js
const tjs = path.dirname(require.resolve('tesseract.js/package.json'));
const coreDir = [path.join(tjs, 'node_modules', 'tesseract.js-core'), path.join(root, 'node_modules', 'tesseract.js-core')].find((d) => fs.existsSync(d));
for (const f of fs.readdirSync(coreDir)) if (/^tesseract-core.*\.(js|wasm)$/.test(f)) fs.copyFileSync(path.join(coreDir, f), path.join(coreOut, f));
fs.copyFileSync(path.join(tjs, 'dist', 'worker.min.js'), path.join(out, 'worker.min.js'));
fs.copyFileSync(path.join(tjs, 'dist', 'tesseract.esm.min.js'), path.join(out, 'tesseract.esm.min.js'));

for (const lang of ['spa', 'eng']) {
  const src = path.join(root, 'node_modules', '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
  fs.copyFileSync(src, path.join(langOut, `${lang}.traineddata.gz`));
}
console.log('[ocr] motor y modelos listos en vendor/ocr/');
