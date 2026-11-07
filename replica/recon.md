# Recon: Wondershare PDFelement Pro → clon open source "PapelPDF"

Fecha: 2026-11-06 · Método: clean-room, solo fuentes públicas. El instalador
subido (`pdfelement-pro_full5239.exe`, PE32 Windows, 218 MB) **no se ejecutó, no
se descompiló ni se inspeccionó**; solo se confirmó su tipo de archivo.

## 1. Alcance

| pregunta | respuesta |
| --- | --- |
| App / plataforma | PDFelement Pro, escritorio (Windows/macOS). Clon: escritorio Windows + macOS + Linux |
| Rebanada | El ciclo central: **abrir PDF → leer → anotar / rellenar / firmar → organizar páginas → guardar**. Conversión a Office, OCR y nube quedan fuera del MVP |
| Para quién | Usuario de Santiago Miguel: alternativa libre (licencia MIT) para negocios pequeños que hoy pagan licencia por editar PDFs |

## 2. Fuentes

| fuente | URL | qué dio |
| --- | --- | --- |
| Guía oficial "Edit PDF" | https://pdf.wondershare.net/how-to/edit-pdf.html | Pestañas de la cinta (Home, Edit, Page, Protect), modos de edición, enlaces, recorte, marca de agua, fondo, Bates |
| Listado Microsoft Store | https://apps.microsoft.com/detail/xpfp0g0v147h6d?hl=en-US | Lista de funciones: editar, convertir, formularios, extraer datos a CSV, Bates, firma, OCR |
| Reseña Hongkiat (PDFelement 9) | https://hongkiat.com/blog/wondershare-pdfelement-review | Modos de lectura, herramientas de anotación, lotes, nube, qué es gratis y qué es de pago |
| Precios (Capterra) | https://www.capterra.com/p/148193/PDFelement-6/pricing/ | Planes de USD 49 a 159; OCR, redacción, Bates, conversión y lotes son de pago |
| Página de la app (Apple App Store, India) | https://apps.apple.com/in/app/pdfelement-pdf-editor-ocr/id1470732135 | Confirma la versión para Mac y el posicionamiento ("PDF Editor, OCR") |

Sin capturas de pantalla: `replica/screens/` queda vacío. La estructura de
pantallas viene de la guía oficial y de las reseñas.

## 3. Inventario de pantallas

| ID | pantalla | cómo se llega | propósito | componentes clave | estados |
| --- | --- | --- | --- | --- | --- |
| S01 | Inicio | abrir la app | abrir o crear archivos, recientes, accesos rápidos (combinar, convertir, comprimir) | tarjetas de acción, lista de recientes, zona para arrastrar | vacío (sin recientes), con recientes |
| S02 | Visor/editor de documento | abrir un PDF | leer y trabajar sobre el documento | cinta con pestañas (Home, Comment, Edit, Convert, Page, Protect, Form, Tool), panel de miniaturas, lienzo, panel de propiedades | cargando, normal, PDF escaneado (aviso amarillo de OCR), protegido con contraseña, error |
| S03 | Pestaña Comentar | S02 → Comment | resaltar, subrayar, nota, texto, figuras, lápiz, sello | barra de herramientas, selector de color | herramienta activa / inactiva |
| S04 | Pestaña Editar | S02 → Edit | texto (modo párrafo/línea), imagen, enlace, recorte, marca de agua, fondo, Bates | barra de herramientas, cajas de selección azules, menú contextual | seleccionado, editando |
| S05 | Pestaña Página / organizador | S02 → Page | rotar, eliminar, insertar, extraer, dividir, reemplazar, reordenar | cuadrícula de miniaturas, selección múltiple | 1 página, varias seleccionadas |
| S06 | Pestaña Formulario | S02 → Form | rellenar campos, crear campos, reconocer formulario, extraer datos | campos resaltados, barra de herramientas de campos | sin campos, con campos |
| S07 | Proteger | S02 → Protect | contraseña, permisos, redacción, firma digital | diálogo de contraseña, herramienta de redacción | — |
| S08 | Diálogo de firma | Comment/Protect → Signature | dibujar, escribir o importar firma | lienzo, pestañas Dibujar/Escribir/Imagen | vacío, con firma, límite de firmas (versión gratis: 3) |
| S09 | Convertir | S01 o S02 → Convert | PDF → Word/Excel/PPT/imagen/texto | selector de formato, barra de progreso | progreso, terminado, error |
| S10 | Proceso por lotes | S01 → Batch | combinar, comprimir, convertir, numerar, marca de agua en varios archivos | lista de archivos, selector de acción | vacío, en cola, terminado |
| S11 | Combinar | S01 → Combine | unir varios PDFs | lista ordenable de archivos | vacío, lista |
| S12 | Preferencias | File → Preferences | ortografía, idioma, OCR | formulario | — |
| S13 | Diálogo de contraseña al abrir | abrir un PDF cifrado | desbloquear | campo de contraseña | error de contraseña |
| S14 | Diálogos de guardar / imprimir | Ctrl+S / Ctrl+P | exportar | diálogo del sistema | — |

## 4. Flujos

```
F01 Abrir y leer un PDF
    S01 Abrir archivo → S02 visor (miniaturas, zoom, página siguiente)
    clics: 2   bordes: PDF dañado, PDF cifrado (S13), PDF de 500+ páginas
F02 Anotar y guardar
    S02 → S03 elegir Resaltar → arrastrar sobre la página → Ctrl+S
    clics: 3   bordes: deshacer, cambio de color, anotación en página rotada
F03 Rellenar formulario y firmar
    S02 → S06 rellenar campos → S08 dibujar firma → colocar → guardar
    clics: ~6   bordes: PDF sin campos AcroForm, checkbox/radio/lista
F04 Organizar páginas
    S02 → S05 seleccionar → rotar / eliminar / arrastrar → guardar
    clics: 3–4   bordes: eliminar todas las páginas (bloquear), deshacer
F05 Combinar PDFs
    S01 → S11 agregar archivos → ordenar → combinar → guardar
    clics: 4
F06 Dividir / extraer páginas
    S05 → extraer rango → guardar como nuevo
F07 Insertar páginas de otro PDF / página en blanco
    S05 → insertar → elegir archivo → posición
F08 Marca de agua / numeración de páginas
    S04 → Watermark / Page → Header & Footer → texto, opacidad, rango → aplicar
F09 Proteger con contraseña (de pago en el original)
F10 OCR a un escaneo (de pago)
F11 Convertir a Office (de pago)
```

Número a superar en F02: 3 clics más guardar.

## 5. Componentes

| componente | variantes | estados | pantallas |
| --- | --- | --- | --- |
| Cinta de pestañas | 8 pestañas | activa / inactiva | S02–S07 |
| Botón de herramienta | ícono, ícono + texto | normal, hover, activo, deshabilitado | todas |
| Panel de miniaturas | lista vertical, cuadrícula | seleccionada, arrastrando, multiselección | S02, S05 |
| Lienzo de página | — | cargando, renderizado, herramienta activa | S02 |
| Caja de anotación | resaltado, texto, nota, figura, trazo, imagen/firma | seleccionada, moviendo, redimensionando | S03, S04, S08 |
| Selector de color | 6–8 muestras | seleccionado | S03, S04 |
| Diálogo modal | firma, marca de agua, contraseña, combinar | abierto / cerrado | S08, S11, S13 |
| Aviso (banner) | info (escaneado / OCR), error | — | S02 |
| Toast | éxito, error | — | todas |
| Barra de estado | página n/N, zoom | — | S02 |
| Zona para arrastrar | — | normal / arrastrando encima | S01, S11 |

## 6. Modelo de datos inferido

Una app de escritorio basada en archivos: el PDF es la fuente de verdad.

```
Document   path, name, bytes, pageCount, encrypted, hasAcroForm, dirty
           evidencia: S02, S13, avisos de guardar · confianza: alta
Page       index, rotation (0|90|180|270), width, height, sourceDoc, sourceIndex
           evidencia: S05 rotar/insertar/reemplazar · confianza: alta
Annotation id, pageIndex, type (highlight|underline|strike|text|note|rect|ellipse|ink|image|signature),
           rect{x,y,w,h} (en puntos PDF), color, opacity, text, fontSize, points[], imageData
           evidencia: S03, S04, S08 · confianza: alta (se guarda como contenido o como anotación PDF)
FormField  name, type (text|checkbox|radio|dropdown|optionlist), value, page, rect
           evidencia: S06, "extract form data to CSV" · confianza: alta
Signature  id, kind (draw|type|image), pngData, createdAt — guardadas localmente
           evidencia: S08, "hasta 3 firmas" en la versión gratis · confianza: media
RecentFile path, openedAt, thumbnail       evidencia: S01 · confianza: media
Preferences language, spellcheck, defaultColor   evidencia: S12 · confianza: media
```

## 7. Matriz de funciones

Ver `replica/features.csv`.

## 8. Qué no se puede clonar

- Marca, nombre, logotipos, íconos, plantillas y textos de Wondershare: el clon se llama **PapelPDF** y usa su propio diseño.
- Document Cloud, cuentas Wondershare ID, uso compartido y seguimiento de accesos: es su red y su servicio.
- Funciones de IA (traducción, resumen) que dependen de sus servidores. Se podrían hacer después con un proveedor propio.
- Motor propietario de conversión a Office: sin equivalente libre de la misma calidad. Una opción posterior es delegar en LibreOffice si está instalado.
- Firma digital con certificados de confianza (AATL): requiere una CA. El MVP hace firma visual; la firma PKCS#7 queda como "could".
- Despliegue empresarial (MSI/GPO/SCCM y gestión de licencias): no aplica a software libre.

## 9. Tamaño

- 14 pantallas, 11 flujos, 7 entidades.
- Partes difíciles: (1) **editar el texto existente** dentro del PDF (redistribuir el contenido; ninguna librería JS libre lo hace bien), (2) **OCR** con capa de texto buscable (tesseract.js sirve, pero es pesado), (3) **conversión a Office** con fidelidad de formato.
- Tamaño: **L** para la paridad funcional completa. **M** para el ciclo central, que es lo que construye el MVP: ver, anotar, rellenar, firmar, organizar, combinar, dividir, marca de agua, numeración y guardar.

## Stack del clon (decisión rápida para el MVP)

- **Electron 33**: un solo código para Windows, macOS y Linux, con instaladores de electron-builder (NSIS `.exe`, `.dmg`, `AppImage` y `.deb`).
- **pdf.js** (Apache-2.0) para mostrar las páginas y **pdf-lib** (MIT) para escribir los cambios en el PDF.
- Sin servidor, sin cuentas y sin telemetría. Licencia MIT.
