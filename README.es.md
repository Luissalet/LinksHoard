# Links Hoard

Bandeja de lectura local: guarda una URL, obtén el texto del artículo extraído, etiquétalo, subraya pasajes y busca en todo — todo en un único archivo SQLite en vuestro ordenador, expuesto a un asistente mediante MCP.

English version: [`README.md`](README.md).

## Abrir

Necesita Node.js 22.13 o posterior (usa el `node:sqlite` integrado). Sin módulos nativos ni Docker.

```sh
npm install
npm run build
npm start          # http://127.0.0.1:5181
```

`npm run open` arranca el servidor y abre el navegador en Windows. `npm run dev` ejecuta la API (`node --watch`) y Vite a la vez con el proxy de `/api` configurado solo.

El servidor escucha únicamente en `127.0.0.1`. Si el puerto 5181 está ocupado avanza al siguiente libre y muestra la dirección; con `PORT_STRICT=1` falla en lugar de cambiar.

### Variables de entorno

| Variable | Uso |
| --- | --- |
| `LINKS_PORT` / `PORT` | Puerto preferido (por defecto `5181`). |
| `PORT_STRICT=1` | No buscar otro puerto. |
| `LINKS_DATA_DIR` | Carpeta de datos (por defecto `<repo>/data`, ignorada por git). Contiene `links-hoard.db` y `mcp-token`. |
| `LINKS_ALLOWED_HOSTS` | Nombres de host adicionales aceptados detrás de un túnel (ver más abajo). |
| `LINKS_URL` | Puente MCP: URL de la aplicación (por defecto `http://127.0.0.1:5181`). Debe ser local. |
| `LINKS_TOKEN_FILE` / `LINKS_TOKEN` | Puente MCP: de dónde leer el token (por defecto `<datos>/mcp-token`). |

### Acceso desde el móvil (a través de un túnel)

El servidor escucha en 127.0.0.1 y solo responde a peticiones cuyo `Host` sea `localhost`, `127.0.0.1` o `[::1]`. Para entrar desde el móvil a través de un túnel que ponga la aplicación delante (una red privada, un proxy inverso), indicad los nombres de host adicionales en `LINKS_ALLOWED_HOSTS`, separados por comas, exactos o `*.sufijo`: `LINKS_ALLOWED_HOSTS=mi-pc.example,*.ts.net`. El puerto y las mayúsculas no importan, y el `Origin` de las llamadas a la API también tiene que corresponder a uno de esos hosts (con cualquier esquema o puerto). Las peticiones *fetch* desde otras webs se siguen rechazando; abrir la aplicación desde otra página (un enlace, un bookmarklet, el menú de compartir) es una navegación normal y funciona.

## Qué hace

- **Guarda al instante.** Pega una URL (o usa el bookmarklet, «Compartir» desde el móvil una vez instalada como app, o la herramienta `save_link` de un asistente) y se guarda inmediatamente con `fetch_status: pending`. Una cola en segundo plano (2 a la vez) descarga la página, extrae el artículo con Readability y rellena título, autoría, extracto y texto completo; la fila se actualiza sola, sin recargar.
- **Lee sin distracciones.** El lector muestra el texto extraído con tamaño de letra ajustable, junto a la URL original, el sitio, la autoría y el tiempo de lectura. Selecciona cualquier texto para subrayarlo, con nota opcional.
- **Organiza.** Etiquetas, favoritos, archivo, leído/no leído. La barra lateral muestra el recuento de etiquetas; la lista también filtra por sitio.
- **Busca en todo.** Búsqueda de texto completo (SQLite FTS5) en título, descripción, texto extraído, notas y etiquetas. Si el SQLite del sistema no trae FTS5, la aplicación cae automáticamente a una búsqueda `LIKE` y lo indica en Ajustes.
- **Importa en bloque.** Marcadores HTML de Netscape (lo que exporta cualquier navegador) o una lista de URLs, una por línea. Ambas evitan duplicados con lo que ya tienes.
- **Resumen semanal.** `GET /api/digest?since=` (y la herramienta MCP `link_digest`) lista lo guardado desde una fecha, agrupado por sitio, con extractos.
- **Vigía.** La biblioteca también *trae* cosas: sigue un feed RSS/Atom, un repositorio de GitHub (releases, tags o commits — sin token de API, por sus feeds Atom públicos) o una página cualquiera (un diff de texto en cada cambio). Cada uno se comprueba a su intervalo (60 min por defecto, planificador en el propio proceso, `LINKS_WATCHES=0` lo apaga); la primera comprobación es la base, y cada entrada, release o cambio posterior se convierte en una *novedad* y, con `auto_save`, en un enlace guardado con las etiquetas de la vigilancia (origen `watch`), descargado como cualquier otro. Una página que anuncia un feed (`<link rel="alternate" type="application/rss+xml">`) pasa a vigilancia de feed automáticamente. Cada novedad se publica en el bus de la familia como `links.watch.new` (y los cambios de página como `links.watch.changed`), para que una regla del Hoard Hub o el asistente reaccionen: un resumen, una tarjeta, una nota.
- **Instálala como app.** `manifest.webmanifest` declara un `share_target`: una vez instalada en Android, puedes compartir una página desde cualquier app directamente a Links Hoard.

## Normalización de URL (la clave de deduplicación)

Guardar es idempotente sobre una forma normalizada de la URL: se eliminan `utm_*`, `fbclid`, `gclid` y parámetros de seguimiento similares, se quita el fragmento, el host se pone en minúsculas y se elimina la barra final de la ruta. Guardar una página ya guardada (aunque cambien los parámetros de seguimiento) devuelve el enlace existente con `existing: true` en lugar de duplicarlo.

## Conectar una IA

En **Ajustes** (o mediante `faustus-plugin.json`) un asistente configurado para servidores MCP locales por stdio puede conectarse usando `server/mcp.js`, `LINKS_URL` y `LINKS_TOKEN_FILE`. El puente nunca abre la base de datos: cada llamada se envía por HTTP a la aplicación en marcha, autenticada con un token aleatorio que se escribe de nuevo en `<datos>/mcp-token` en cada arranque.

Herramientas:

| Herramienta | Uso |
| --- | --- |
| `save_link` | Guardar una URL (idempotente); espera hasta 10 s la descarga para informar del título/extracto reales. |
| `list_links` | Listar por estado (no leído/leído/archivado/todo), etiqueta, sitio, desde. |
| `search_links` | Búsqueda de texto completo. |
| `read_link` | Leer el texto extraído, paginado por caracteres; incluye subrayados. |
| `tag_link` | Añadir/quitar etiquetas. |
| `mark_link` | Alternar leído/no leído/archivado/favorito. |
| `add_highlight` | Guardar una cita subrayada con nota. |
| `link_digest` | Lo guardado desde una fecha, agrupado por sitio. |
| `refetch_link` | Volver a descargar y extraer. |
| `delete_link` | Borrar permanentemente (destructivo; confirmar antes). |
| `watch_add` | Seguir un feed, un repositorio de GitHub o una página (tipo autodetectado; intervalo, etiquetas, auto_save). |
| `watch_list` | Las vigilancias con su última comprobación, último error y novedades. |
| `watch_items` | Lo que han traído las vigilancias (no vistas primero; desde una fecha; por vigilancia). |
| `watch_check` | Comprobar una vigilancia (o todas las pendientes) ahora. |
| `watch_dismiss` | Marcar una novedad como vista. |
| `watch_remove` | Dejar de seguir (las novedades y los enlaces guardados se quedan). |
| `list_tags` | Todas las etiquetas en uso, con recuento. |

Son 17 herramientas en total. `GET /api/agent/tools` siempre refleja la lista real. Las descripciones terminan con una línea `Sinónimos:` en español, para que la forma de hablar de un usuario («guarda esto», «resumen de la semana») encuentre la herramienta correcta.

El asistente tiene instrucciones de resumir o citar un enlace solo a partir del texto que devuelve `read_link`, nunca solo del título, y de decir con claridad cuándo una descarga sigue pendiente o falló en lugar de inventar un resumen.

## Datos y límites

- `data/links-hoard.db`: enlaces, subrayados y ajustes, SQLite con WAL.
- `data/mcp-token`: credencial local creada al iniciar; no se publica ni se incluye en ningún otro sitio.
- Descarga: 15 s de tiempo límite, cabecera User-Agent de navegador, 5 MB de tope. El HTML pasa por `linkedom` + `@mozilla/readability`, con una alternativa manual (título + meta descripción + cuerpo sin etiquetas) cuando Readability no encuentra nada útil. Antes de extraer, se elimina el relleno habitual (infoboxes, navboxes, barras laterales, marcas de referencia, tablas de contenidos, enlaces de «editar», `<nav>`/`<aside>`), y el HTML restante se convierte a texto bloque a bloque (salto de línea tras cada párrafo/título/elemento de lista/fila de tabla, espacio entre celdas), para que el texto nunca quede pegado entre celdas o bloques como ocurriría con `textContent` a secas. El extracto elige el primer párrafo real (≥ 80 caracteres con puntuación de frase) en lugar de lo primero que aparezca en el marcado, como un infobox. PDF e imágenes se registran con un título derivado del nombre de archivo (sin OCR ni renderizado). YouTube/Vimeo obtienen un título por oEmbed sin necesitar clave de API. Un enlace guardado antes de esta mejora en la extracción se puede corregir con **refetch_link** / `POST /api/links/:id/refetch` (o el botón «Reintentar descarga» del lector): vuelve a ejecutar la extracción actual sobre la misma URL y sobrescribe el título, el extracto y el texto guardados.
- Búsqueda: FTS5 cuando el SQLite del sistema lo soporta (se comprueba en cada arranque); si no, una alternativa `LIKE` sobre los mismos campos, ambas reflejadas en `GET /api/state`.

## Verificación

```sh
npm test
npm run build
```

Las pruebas usan directorios de datos temporales y un servidor HTTP local para las páginas de ejemplo: nada toca tus datos reales ni la red. Cubren normalización de URL, extracción con Readability sobre una página de ejemplo, idempotencia al guardar, búsqueda de texto completo, el resumen, subrayados, análisis de importación de marcadores/listas de URL, autenticación del token del asistente y un recorrido completo de la API.

Diseño y decisiones: [`DESIGN.md`](DESIGN.md).
