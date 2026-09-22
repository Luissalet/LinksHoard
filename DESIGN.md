---
name: Links Hoard
description: Una bandeja de lectura local, tranquila y rápida, para guardar y volver a los artículos que importan.
colors:
  accent: "#2f5d8a"
  accent-hover: "#244a6e"
  ink: "#1f2733"
  muted: "#5c6470"
  paper: "#f9fafb"
  white: "#ffffff"
  line: "#e2e6ec"
  soft: "#eef2f7"
  sidebar: "#f1f4f8"
  nav-active: "#dbe6f1"
  nav-active-ink: "#1c3f61"
  nav-hover: "#e6ecf3"
  field-line: "#ccd4de"
  field-ink: "#26303d"
  placeholder: "#7c8592"
  supporting-ink: "#626c78"
  focus: "#3f74a8"
  button-line: "#d3dae2"
  panel: "#f2f5f9"
  unread-bg: "#e7eef7"
  unread-ink: "#2f5d8a"
  favorite-ink: "#b8862f"
  favorite-bg: "#f8eede"
  warn-bg: "#f8ecd2"
  warn-ink: "#7a5a17"
  danger-bg: "#fbeceb"
  danger-ink: "#8a3a2c"
  danger-line: "#e8c8c2"
  highlight-bg: "#fff3c4"
typography:
  headline:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.65
  reader:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    lineHeight: 1.75
  button:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "18px"
  label:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
  code:
    fontFamily: "Consolas, monospace"
    fontSize: "11px"
    lineHeight: 1.8
rounded:
  badge: "5px"
  field: "6px"
  control: "7px"
  panel: "8px"
  dialog: "12px"
spacing:
  control-gap: "8px"
  action-gap: "10px"
  section-gap: "16px"
  panel-padding: "20px"
  page-gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    borderColor: "{colors.button-line}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger-ink}"
    borderColor: "{colors.danger-line}"
    rounded: "{rounded.control}"
  field:
    backgroundColor: "{colors.white}"
    textColor: "{colors.field-ink}"
    borderColor: "{colors.field-line}"
    rounded: "{rounded.field}"
    padding: "8px 11px"
    width: "100%"
  nav-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.nav-active-ink}"
    rounded: "{rounded.control}"
    padding: "10px 13px"
  chip:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.supporting-ink}"
    rounded: "{rounded.badge}"
    padding: "2px 6px"
  site-chip:
    rounded: "7px"
    size: "28px"
    textColor: "{colors.white}"
  highlight-mark:
    backgroundColor: "{colors.highlight-bg}"
---

# Design System: Links Hoard

## Overview

**Creative North Star: "Bandeja de lectura tranquila"**

Una bandeja de entrada para lo que quieres leer, no una red social: papel claro, tinta azul pizarra, filas de una sola línea con extracto y un lector limpio sin distracciones. La interfaz está en español de España.

La dirección estética se hereda de la familia Hoard (papel, paneles de 8px, Segoe UI) y cambia el acento a un azul pizarra (`#2f5d8a`), con contraste 6,8:1 sobre papel, usado en botones, enlaces, la marca «L» y el color de foco.

**Key Characteristics:**

- Superficies claras y planas separadas por líneas; ningún panel flota.
- Cada enlace guardado es una fila compacta: chip de sitio, título, sitio y fecha, extracto de dos líneas, chips de estado y etiquetas.
- El lector es la pieza central: texto ancho de columna cómoda, tamaño de letra ajustable y subrayado por selección.
- Guardar es inmediato: pegar una URL la añade al instante con estado «pendiente»; el texto llega solo cuando termina la descarga en segundo plano.

## Colors

El azul pizarra organiza las acciones; los neutros de papel y gris frío sostienen la lectura de listas largas.

### Primary

- **Pizarra:** `accent` en botones primarios, enlaces y foco de escritura. `accent-hover` lo oscurece al pasar el puntero.
- **Selección:** `nav-active` / `nav-active-ink` marcan la página activa; `soft` es el hover de filas.

### Neutral

- **Papel:** `paper` es la página; `white` los paneles y campos; `panel` la caja de guardado rápido; `sidebar` el índice.
- **Tinta:** `ink` para títulos; `muted` para descripciones; `supporting-ink` para metadatos (sitio, fecha).
- **Líneas:** `line` separa filas y paneles; `field-line` y `button-line` bordean controles.

### Semantic

- **No leído:** `unread-bg` / `unread-ink` en el chip de sitio y el contador de la Bandeja.
- **Favorito:** `favorite-ink` / `favorite-bg`, estrella rellena.
- **Pendiente de descarga:** `warn-bg` / `warn-ink`, chip «Descargando…».
- **Fallo de descarga:** `danger-bg` / `danger-ink`, chip «Fallo al descargar» con el motivo.
- **Subrayado:** `highlight-bg` (amarillo suave) tras el texto seleccionado y guardado.

**The Estado escrito Rule.** Cada estado (no leído, favorito, archivado, pendiente, fallo) se lee como texto además de color.

## Typography

**Body Font:** Segoe UI con `system-ui` y `sans-serif` de respaldo; Georgia solo en la marca «L»; Consolas en Ajustes (bookmarklet, ruta de datos).

- **Headline:** título de página (28px; 24px en móvil).
- **Title:** título de panel/sección (16px).
- **Body:** listas y formularios (14px; metadatos 12–13px; chips 10px).
- **Reader:** texto del lector, más grande que el resto de la interfaz (17px por defecto, tres tamaños adicionales seleccionables).
- **Label:** etiqueta visible encima de cada campo (12px, seminegrita).

## Layout

Escritorio: rejilla `224px | 1fr`; índice pegado arriba a `100dvh` con etiquetas más usadas visibles debajo de la navegación. Contenido centrado a `1200px` (el lector se limita a `900px` para una línea de lectura cómoda).

- **Bandeja / Todo:** caja de guardado arriba, buscador, filtro de sitio, lista de filas de una línea con acciones a la derecha (favorito, archivar).
- **Archivados / Favoritos:** misma lista sin caja de guardado.
- **Lector:** cabecera con título, sitio, autor, fecha y tiempo de lectura; controles de tamaño de letra; texto; subrayados con nota; etiquetas; notas libres.
- **Ajustes:** bookmarklet arrastrable, instrucciones de instalación PWA, formulario de importación, datos.

Hasta `768px` el índice pasa a barra superior desplazable, la caja de guardado a una columna y las filas conservan chip de sitio, título y metadatos apilados; las acciones permanecen accesibles a la derecha.

## Elevation & Depth

Plano por defecto. Sombra únicamente en el diálogo de confirmación (`0 24px 70px #16223026`, velo `#16223055`), el aviso flotante (`0 8px 28px #1622302a`) y el popover «Subrayar» sobre el texto seleccionado.

**The Profundidad funcional Rule.** Una sombra significa «esto está encima de la página».

## Shapes

Campos `6px`, botones y navegación `7px`, paneles `8px`, diálogo `12px`, chips `5px`, chip de sitio `7px` (28×28px, inicial en blanco sobre color determinista por dominio). Los iconos son trazos SVG de 1,8px. No hay imágenes raster salvo el icono de la app (SVG).

## Components

### Buttons

Primario azul pizarra con tinta blanca, secundario blanco con borde, destructivo sobre `danger-bg`. Altura mínima `38px` (`30px` en `btn-sm`, usado en las acciones de fila). Deshabilitado a opacidad 0,45.

### Link rows

Chip de sitio (inicial + color por dominio) a la izquierda, título y metadatos al centro, extracto de dos líneas, chips de tipo/estado/etiquetas debajo, acciones (favorito, archivar) a la derecha. El chip de sitio también alterna leído/no leído al pulsarlo. Fila completa clicable para abrir el lector.

### Reader

Columna de máximo `68ch`, tamaño de letra con cuatro pasos. Seleccionar texto muestra un popover «Subrayar» sobre la selección; los subrayados guardados se listan debajo con nota editable y fecha. Etiquetas y notas en secciones propias, guardado inmediato al perder el foco.

### Save box

Formulario de una fila (URL + etiquetas + botón «Guardar»). Guardar es inmediato: la fila aparece con chip «Descargando…» y se actualiza sola en segundo plano sin recargar la página.

### Feedback

Aviso centrado abajo (`role=status` o `alert`) con botón «Cerrar» y cierre automático a los 4 s. Borrados con `<dialog>` nativo y botón destructivo. Vacíos con borde discontinuo y una única acción.

## Do's and Don'ts

### Do:

- **Do** mostrar el estado de descarga (pendiente/fallo) como texto, no solo como color.
- **Do** mantener el lector como columna de ancho cómodo, independiente del resto de la interfaz.
- **Do** guardar inmediatamente notas, etiquetas y subrayados sin botón «Guardar» aparte.
- **Do** dar al chip de sitio un color estable por dominio (hash simple), sin depender de red externa (sin favicons remotos).

### Don't:

- **Don't** añadir un segundo color de acento ni convertir las filas en tarjetas flotantes.
- **Don't** bloquear el guardado de una URL a la espera de la descarga: se guarda al instante y el texto llega después.
- **Don't** resumir o citar un enlace a partir del título: solo del texto extraído.
