// OCR sin conexión con tesseract.js. Los modelos (español e inglés) viajan dentro de la app.
import Tesseract from '../vendor/ocr/tesseract.esm.min.js';

const base = (p) => new URL(p, import.meta.url).href;
let worker = null;
let workerLangs = '';
let progressCb = null;

export const OCR_LANGS = [
  { id: 'spa', label: 'Español' },
  { id: 'eng', label: 'Inglés' },
  { id: 'spa+eng', label: 'Español + Inglés' },
];

async function getWorker(langs) {
  if (worker && workerLangs === langs) return worker;
  if (worker) { await worker.terminate(); worker = null; }
  worker = await Tesseract.createWorker(langs.split('+'), Tesseract.OEM.LSTM_ONLY, {
    workerPath: base('../vendor/ocr/worker.min.js'),
    corePath: base('../vendor/ocr/core/'),
    langPath: base('../vendor/ocr/tessdata/'),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: (m) => { if (progressCb && m.status === 'recognizing text') progressCb(m.progress); },
  });
  await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '3' });
  workerLangs = langs;
  return worker;
}

/**
 * Reconoce el texto de un lienzo. Devuelve palabras con su caja en píxeles del lienzo.
 * @returns {Promise<{text: string, words: {t: string, x0: number, y0: number, x1: number, y1: number, conf: number}[]}>}
 */
export async function recognizeCanvas(canvas, langs, onProgress, dpi = 300) {
  const w = await getWorker(langs);
  await w.setParameters({ user_defined_dpi: String(Math.round(dpi)) });
  progressCb = onProgress || null;
  try {
    const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
    const words = [];
    for (const b of data.blocks || []) for (const par of b.paragraphs || []) for (const ln of par.lines || []) for (const wd of ln.words || []) {
      const t = (wd.text || '').trim();
      if (!t || wd.confidence < 20) continue;
      words.push({ t, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1, conf: wd.confidence });
    }
    return { text: data.text || '', words };
  } finally {
    progressCb = null;
  }
}

export async function terminateOcr() {
  if (worker) { await worker.terminate(); worker = null; workerLangs = ''; }
}
