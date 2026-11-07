import * as L from 'pdf-lib';

// PDF de muestra: 3 páginas, la 2 rotada 90°, con formulario en la 1
export async function makeSample() {
  const d = await L.PDFDocument.create();
  const f = await d.embedFont(L.StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = d.addPage([612, 792]);
    p.drawText(`Pagina de prueba ${i + 1}`, { x: 72, y: 700, size: 28, font: f });
    p.drawText('Lorem ipsum dolor sit amet, texto para resaltar.', { x: 72, y: 640, size: 14, font: f });
    if (i === 1) p.setRotation(L.degrees(90));
  }
  const form = d.getForm();
  const name = form.createTextField('nombre');
  name.addToPage(d.getPage(0), { x: 72, y: 540, width: 250, height: 24 });
  const ok = form.createCheckBox('acepto');
  ok.addToPage(d.getPage(0), { x: 72, y: 500, width: 16, height: 16 });
  const color = form.createDropdown('color');
  color.addOptions(['Rojo', 'Verde', 'Azul']);
  color.addToPage(d.getPage(0), { x: 72, y: 460, width: 150, height: 22 });
  return d.save();
}

