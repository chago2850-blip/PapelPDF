// Geometría compartida entre la interfaz y el exportador.
//
// Espacios de coordenadas:
//  - "unrot": puntos PDF de la página SIN rotar, origen arriba-izquierda, y hacia abajo.
//  - "pdf":   espacio de usuario PDF (origen abajo-izquierda, y hacia arriba).
//  - "own":   el marco propio de una anotación (centrado en cx,cy y girado -rot grados),
//             es decir, como el usuario la ve derecha cuando la página tiene rotación rot.
// Una anotación de caja guarda { cx, cy, dw, dh, rot } en "unrot".

/** Rota (a,b) `deg` grados en sentido horario visual con el eje y hacia abajo. */
export function rotY(a, b, deg) {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const r = (v) => (Math.abs(v) < 1e-9 ? 0 : v);
  return [r(a * c - b * s), r(a * s + b * c)];
}

/** Punto del marco propio de la anotación (desplazamiento desde el centro) → unrot. */
export function ownToUnrot(an, ox, oy) {
  const [x, y] = rotY(ox, oy, -(an.rot || 0));
  return [an.cx + x, an.cy + y];
}

/** unrot → espacio PDF, usando view = [x1, y1, x2, y2] de la página. */
export function unrotToPdf(view, x, y) {
  return [view[0] + x, view[3] - y];
}

/** Caja alineada a ejes en unrot que ocupa la anotación. */
export function annotBBox(an) {
  if (an.type === 'ink') {
    const xs = an.points.map((p) => p[0]), ys = an.points.map((p) => p[1]);
    const pad = (an.width || 2) / 2;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
  }
  const swap = ((an.rot || 0) % 180) !== 0;
  const w = swap ? an.dh : an.dw, h = swap ? an.dw : an.dh;
  return { x: an.cx - w / 2, y: an.cy - h / 2, w, h };
}

/** Tamaño visible de una página (con su rotación aplicada). */
export function displaySize(page) {
  return (page.rotate % 180) ? { w: page.h, h: page.w } : { w: page.w, h: page.h };
}

export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Formato de numeración: {n} página, {N} total, {n:6} con ceros a la izquierda (Bates). */
export function formatPageNumber(fmt, n, total) {
  return String(fmt || 'Página {n} de {N}')
    .replace(/\{n:(\d{1,2})\}/g, (_m, d) => String(n).padStart(+d, '0'))
    .replace(/\{N\}/g, String(total))
    .replace(/\{n\}/g, String(n));
}

export const uid =() => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
