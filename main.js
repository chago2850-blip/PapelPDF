// PapelPDF — proceso principal de Electron
// Licencia MIT. Sin telemetría, sin cuentas, sin red.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const isMac = process.platform === 'darwin';
const ROOT = __dirname;
let win = null;
let pendingPaths = [];

// La interfaz se sirve desde app://papel/… para que fetch, workers y WebAssembly
// funcionen igual en desarrollo y en la app empaquetada.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.gz': 'application/gzip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
};
function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Prohibido', { status: 403 });
    try {
      const data = await fs.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('No encontrado', { status: 404 });
    }
  });
}

// --- archivos pasados por el sistema ("Abrir con", doble clic) ---
function pdfArgs(argv) {
  return argv.slice(1).filter((a) => /\.pdf$/i.test(a) && !a.startsWith('-'));
}
pendingPaths.push(...pdfArgs(process.argv));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = pdfArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      files.forEach((f) => win.webContents.send('open-path', f));
    }
  });
}

app.on('open-file', (e, file) => {
  // macOS
  e.preventDefault();
  if (win && win.webContents && !win.webContents.isLoading()) win.webContents.send('open-path', file);
  else pendingPaths.push(file);
});

// --- recientes ---
const recentsFile = () => path.join(app.getPath('userData'), 'recientes.json');
async function getRecents() {
  try {
    const list = JSON.parse(await fs.readFile(recentsFile(), 'utf8'));
    const out = [];
    for (const r of list) {
      try { await fs.access(r.path); out.push(r); } catch { /* ya no existe */ }
    }
    return out;
  } catch { return []; }
}
async function addRecent(p) {
  if (!p) return;
  const list = (await getRecents()).filter((r) => r.path !== p);
  list.unshift({ path: p, name: path.basename(p), openedAt: Date.now() });
  await fs.mkdir(path.dirname(recentsFile()), { recursive: true });
  await fs.writeFile(recentsFile(), JSON.stringify(list.slice(0, 12), null, 2));
  if (isMac || process.platform === 'win32') app.addRecentDocument(p);
}

async function readPdf(p) {
  const buf = await fs.readFile(p);
  await addRecent(p);
  return { path: p, name: path.basename(p), bytes: new Uint8Array(buf) };
}

// En pruebas automáticas se evitan los diálogos nativos.
const TEST_DIR = process.env.PAPELPDF_TEST_DIR || null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'PapelPDF',
    backgroundColor: '#f4efe6',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.loadURL('app://papel/src/index.html');
  win.webContents.on('did-finish-load', () => {
    pendingPaths.forEach((f) => win.webContents.send('open-path', f));
    pendingPaths = [];
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.on('close', async (e) => {
    if (win.__forceClose) return;
    e.preventDefault();
    const dirty = await win.webContents.executeJavaScript('window.__papelDirty ? window.__papelDirty() : false').catch(() => false);
    if (!dirty || TEST_DIR) { win.__forceClose = true; win.close(); return; }
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Descartar cambios', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      message: 'Hay cambios sin guardar.',
      detail: '¿Quieres cerrar PapelPDF sin guardar?',
    });
    if (response === 0) { win.__forceClose = true; win.close(); }
  });
}

function send(cmd) { if (win) win.webContents.send('menu', cmd); }

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu', label: 'PapelPDF' }] : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Abrir…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Combinar PDFs…', click: () => send('merge') },
        { label: 'Crear PDF desde imágenes…', click: () => send('imagesToPdf') },
        { type: 'separator' },
        { label: 'Guardar', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Guardar como…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        {
          label: 'Exportar',
          submenu: [
            { label: 'Word (.docx)…', click: () => send('toDocx') },
            { label: 'Texto (.txt)…', click: () => send('toTxt') },
            { label: 'Imágenes (PNG/JPG)…', click: () => send('toImages') },
          ],
        },
        { label: 'Imprimir…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        { label: 'Cerrar documento', accelerator: 'CmdOrCtrl+W', click: () => send('close') },
        isMac ? { role: 'close', label: 'Cerrar ventana' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { label: 'Deshacer', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Rehacer', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
        { type: 'separator' },
        { label: 'Buscar…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
      ],
    },
    {
      label: 'Herramientas',
      submenu: [
        { label: 'Reconocer texto (OCR)…', click: () => send('ocr') },
        { label: 'Proteger con contraseña…', click: () => send('protect') },
        { label: 'Comprimir…', click: () => send('compress') },
        { label: 'Marca de agua…', click: () => send('watermark') },
        { label: 'Numerar páginas…', click: () => send('pageNumbers') },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { label: 'Acercar', accelerator: 'CmdOrCtrl+=', click: () => send('zoomIn') },
        { label: 'Alejar', accelerator: 'CmdOrCtrl+-', click: () => send('zoomOut') },
        { label: 'Ajustar al ancho', accelerator: 'CmdOrCtrl+0', click: () => send('zoomFit') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Atajos de teclado', click: () => send('shortcuts') },
        { label: 'Acerca de PapelPDF', click: () => send('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- qpdf (WebAssembly): cifrar, descifrar, comprimir ---
const QPDF_WASM = path.join(ROOT, 'node_modules', '@neslinesli93', 'qpdf-wasm', 'dist', 'qpdf.wasm');
async function runQpdf(args, input) {
  const createQpdf = require('@neslinesli93/qpdf-wasm');
  const errors = [];
  const q = await createQpdf({ locateFile: () => QPDF_WASM, print: () => {}, printErr: (t) => errors.push(t) });
  q.FS.writeFile('/in.pdf', input);
  const rc = q.callMain(args);
  let out = null;
  try { out = q.FS.readFile('/out.pdf'); } catch { /* sin salida */ }
  return { rc, out, errors };
}

ipcMain.handle('qpdf', async (_e, opts) => {
  const bytes = Buffer.from(opts.bytes);
  if (opts.op === 'decrypt') {
    const pw = opts.password ? [`--password=${opts.password}`] : [];
    // --is-encrypted también necesita la contraseña para poder abrir el archivo
    const check = await runQpdf([...pw, '--is-encrypted', '/in.pdf'], bytes);
    if (check.rc === 2) return { encrypted: false }; // 2 = no está cifrado
    const r = await runQpdf([...pw, '--decrypt', '/in.pdf', '/out.pdf'], bytes);
    if (!r.out || (r.rc !== 0 && r.rc !== 3)) throw new Error(r.errors.join(' ') || 'No se pudo descifrar el PDF.');
    return { encrypted: true, bytes: r.out };
  }
  if (opts.op === 'encrypt') {
    const yn = (v) => (v ? 'y' : 'n');
    const args = ['/in.pdf', '--encrypt', opts.user || '', opts.owner || opts.user || '', '256',
      `--print=${opts.print ? 'full' : 'none'}`, `--extract=${yn(opts.copy)}`, `--modify=${opts.modify ? 'all' : 'none'}`,
      '--', '/out.pdf'];
    const r = await runQpdf(args, bytes);
    if (!r.out || (r.rc !== 0 && r.rc !== 3)) throw new Error(r.errors.join(' ') || 'No se pudo cifrar el PDF.');
    return { bytes: r.out };
  }
  if (opts.op === 'compress') {
    const r = await runQpdf(['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '--remove-unreferenced-resources=yes', '/in.pdf', '/out.pdf'], bytes);
    if (!r.out || (r.rc !== 0 && r.rc !== 3)) throw new Error(r.errors.join(' ') || 'No se pudo comprimir el PDF.');
    return { bytes: r.out };
  }
  throw new Error('Operación desconocida');
});

// --- Word (.docx) ---
ipcMain.handle('make-docx', async (_e, { title, pages }) => {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const children = [];
  pages.forEach((lines, pi) => {
    if (!lines.length) {
      children.push(new Paragraph({ pageBreakBefore: pi > 0, children: [new TextRun('')] }));
      return;
    }
    lines.forEach((ln, li) => {
      const big = ln.size >= 16;
      children.push(new Paragraph({
        pageBreakBefore: pi > 0 && li === 0,
        heading: big ? (ln.size >= 22 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2) : undefined,
        spacing: { after: ln.gapAfter ? 160 : 40 },
        children: [new TextRun({ text: ln.text, size: Math.round(Math.min(Math.max(ln.size, 8), 40) * 2), bold: ln.bold || undefined })],
      }));
    });
  });
  const docx = new Document({ creator: 'PapelPDF', title, sections: [{ children }] });
  return new Uint8Array(await Packer.toBuffer(docx));
});

// --- diálogos y archivos ---
ipcMain.handle('open-dialog', async (_e, { multi } = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: multi ? 'Selecciona los PDFs' : 'Abrir PDF',
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(readPdf));
});

ipcMain.handle('open-images', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Selecciona las imágenes',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(async (p) => ({ name: path.basename(p), bytes: new Uint8Array(await fs.readFile(p)) })));
});

ipcMain.handle('choose-folder', async (_e, { title }) => {
  if (TEST_DIR) return TEST_DIR;
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('write-into', async (_e, { folder, name, bytes }) => {
  const safe = path.basename(name);
  const out = path.join(folder, safe);
  await fs.writeFile(out, Buffer.from(bytes));
  return out;
});

ipcMain.handle('read-path', async (_e, p) => readPdf(p));
ipcMain.handle('recents', async () => getRecents());
ipcMain.handle('clear-recents', async () => { await fs.rm(recentsFile(), { force: true }); return []; });

const KINDS = {
  pdf: { name: 'Documento PDF', ext: 'pdf', title: 'Guardar PDF' },
  png: { name: 'Imagen PNG', ext: 'png', title: 'Exportar imagen' },
  csv: { name: 'CSV', ext: 'csv', title: 'Exportar datos' },
  txt: { name: 'Texto', ext: 'txt', title: 'Exportar texto' },
  docx: { name: 'Documento de Word', ext: 'docx', title: 'Exportar a Word' },
};
ipcMain.handle('save-file', async (_e, { bytes, path: target, suggestedName, ask, kind = 'pdf' }) => {
  const k = KINDS[kind] || KINDS.pdf;
  let out = target;
  if (TEST_DIR && (ask || !out)) {
    out = path.join(TEST_DIR, suggestedName || `salida.${k.ext}`);
  } else if (ask || !out) {
    const r = await dialog.showSaveDialog(win, {
      title: k.title,
      defaultPath: suggestedName || `documento.${k.ext}`,
      filters: [{ name: k.name, extensions: [k.ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    out = r.filePath;
  }
  await fs.writeFile(out, Buffer.from(bytes));
  if (k.ext === 'pdf') await addRecent(out);
  return { path: out, name: path.basename(out) };
});

ipcMain.handle('print-pdf', async (_e, bytes) => {
  // Abre el PDF final en el visor de Chromium, que trae su propio botón de imprimir.
  const tmp = path.join(os.tmpdir(), `papelpdf-imprimir-${Date.now()}.pdf`);
  await fs.writeFile(tmp, Buffer.from(bytes));
  const pw = new BrowserWindow({
    width: 1000, height: 800, title: 'Imprimir — PapelPDF', parent: win,
    webPreferences: { plugins: true, contextIsolation: true, sandbox: true },
  });
  pw.loadURL('file://' + tmp);
  return true;
});

ipcMain.handle('show-in-folder', (_e, p) => { shell.showItemInFolder(p); return true; });

ipcMain.handle('confirm', async (_e, { message, detail, buttons }) => {
  if (TEST_DIR) return 0;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1,
  });
  return response;
});

ipcMain.handle('app-info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));

app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
