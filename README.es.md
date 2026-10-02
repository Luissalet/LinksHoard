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
| `LINKS_MEDIA_DIR` | Carpeta de descargas si no hay una en Ajustes (por defecto `<usuario>/Downloads/Links Hoard`). |
| `LINKS_YTDLP` / `LINKS_GALLERYDL` / `LINKS_FFMPEG` | Ruta de cada programa (ver [Descargas](#descargas)). También admite `node:<script.js>` y `python -m yt_dlp`. |
| `LINKS_MEDIA_SIBLING_DIR` | Carpeta donde se buscan `yt-dlp`/`gallery-dl` antes de los módulos de Python (por defecto `../Writers hoard desktop/resources/bin`); `off` la desactiva. |
| `LINKS_MEDIA_AUTO_UPDATE` / `LINKS_MEDIA_STALE_DAYS` | `0` desactiva la actualización automática de yt-dlp (igual que el interruptor de Ajustes); antigüedad en días a partir de la cual yt-dlp se actualiza antes de descargar (por defecto 45). |
| `PYTHON` | Intérprete de Python para `python -m yt_dlp` y `pip install -U` (por defecto `python3`, `python` o `py -3`). |
| `LINKS_COOKIES_FILE` | Archivo de cookies en formato Netscape para publicaciones privadas (el ajuste de Ajustes tiene prioridad). |
| `LINKS_COOKIES_BROWSERS` | Navegadores a probar para las cookies, separados por comas y en orden (por defecto `firefox,chrome,edge,brave,chromium,vivaldi,opera`). |
| `LINKS_MEDIA_TRANSCODE=0` | No recodificar los vídeos descargados que no sean H.264/AAC. |

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
- **Descarga vídeo, audio y fotos.** Dile al asistente «descárgame esto: <enlace>» (o pega el enlace en **Descargas**) y el vídeo, el audio o las fotos acaban en una carpeta de tu disco: YouTube, X, Instagram, TikTok, Audiomack, SoundCloud, Vimeo, Twitch, Reddit, Facebook, Bilibili y cualquier otro sitio que conozca yt-dlp. Ver [Descargas](#descargas).
- **Instálala como app.** `manifest.webmanifest` declara un `share_target`: una vez instalada en Android, puedes compartir una página desde cualquier app directamente a Links Hoard.

## Descargas

La página **Descargas** (`#/descargas`) y la herramienta `media_download` convierten un enlace en archivos de tu disco. El vídeo y el audio pasan por [yt-dlp](https://github.com/yt-dlp/yt-dlp); las publicaciones de fotos y los carruseles que yt-dlp no puede coger («There is no video in this post») por [gallery-dl](https://github.com/mikf/gallery-dl). Son programas aparte: la aplicación no los incluye.

- **Sitios.** YouTube, X (Twitter), Instagram, TikTok, Audiomack, SoundCloud, Vimeo, Twitch, Reddit, Facebook, Bilibili y otros tienen etiqueta propia; cualquier otra URL también se le pasa a yt-dlp (etiqueta «Otro (yt-dlp)»), que admite más de mil sitios.
- **Formatos.** `video` (MP4; se prefiere H.264 + AAC y un archivo en otro códec se recodifica con ffmpeg para que se vea en todas partes), `audio` (MP3, la mejor calidad), `image` (gallery-dl) o `auto` (vídeo; si la publicación no tiene vídeo, sus fotos). `quality` del vídeo: `best`, `1080`, `720`, `480`. Una lista de reproducción solo se descarga con `playlist: true`, hasta `max_items` (50 por defecto).
- **Dónde se guardan.** La carpeta de **Ajustes → Descargas** (`media.dir`), si no `LINKS_MEDIA_DIR`, si no `<usuario>/Downloads/Links Hoard`; `dir` en una llamada la sustituye solo para esa descarga. Los archivos se llaman `título [id].ext`, saneados para Windows; un archivo existente nunca se sobrescribe, y las fotos van a una subcarpeta propia (`autor - pie de foto`, numerada si ya existe). No se deja ningún `.info.json`, miniatura ni otro archivo auxiliar: título, pie de foto, autor, fecha y duración se guardan en la base de datos.
- **Cola.** Una descarga a la vez, por orden de llegada, con progreso (porcentaje, velocidad, tiempo restante) en memoria y reflejado en la tabla `media_downloads`. Cancelar una descarga en espera la quita sin ejecutarla; cancelar la que corre mata yt-dlp y todo lo que haya lanzado (`taskkill /T /F` en Windows). Al volver a arrancar, las descargas que estaban en marcha pasan a *fallida* («interrumpida al cerrar la app») y las que seguían en espera se encolan de nuevo.
- **Enlace en la biblioteca.** Con `save_link` (activado por defecto), una descarga terminada guarda también la URL como enlace con la etiqueta `descarga` (origen `download`, tipo vídeo, audio o imagen) y la nota «Descargado en <ruta>»; cuando la propia página no da texto (Instagram, X), el pie de foto pasa a ser el texto del enlace para que `read_link` y la búsqueda lo encuentren. Publica `links.media.done` / `links.media.failed` en el bus de la familia.
- **Contenido privado.** Sin sesión iniciada, Instagram y X suelen negarse. La aplicación prueba primero sin cookies y, si el sitio pide iniciar sesión, con las cookies de tus navegadores uno por uno (Firefox, Chrome, Edge, Brave, Chromium, Vivaldi, Opera) hasta que uno funcione; `cookies_browser` fija un navegador (o `none`), y **Ajustes → Descargas** acepta un `cookies.txt` de Netscape. Inicia sesión antes en ese sitio con ese navegador. Los navegadores de la familia Chrome en Windows pueden negarse mientras están abiertos: ciérralo o usa Firefox.
- **Programas necesarios.** yt-dlp para vídeo y audio, gallery-dl para fotos, ffmpeg para unir las pistas y hacer MP3 (el vídeo funciona sin él, como un único archivo). Cada uno se busca en este orden: su variable (`LINKS_YTDLP`, `LINKS_GALLERYDL`, `LINKS_FFMPEG`), el `PATH`, la carpeta hermana `../Writers hoard desktop/resources/bin` y `python -m yt_dlp` / `python -m gallery_dl` (ffmpeg también por `imageio-ffmpeg`). Se instalan con `python -m pip install -U yt-dlp gallery-dl` y, en Windows, `winget install Gyan.FFmpeg`. La tarjeta **Herramientas** de Descargas (y `media_tools`) muestra lo encontrado con sus versiones, y **Actualizar** ejecuta `yt-dlp -U` / `gallery-dl -U`, o `pip install -U` si funcionan como módulo de Python. Los accesos `.cmd`/`.bat` del `PATH` en Windows se ignoran: usa el `.exe` o apunta la variable a él.
- **yt-dlp se mantiene al día solo.** Las plataformas cambian y un yt-dlp viejo empieza a fallar (un vídeo de YouTube que responde HTTP 403 es la señal habitual). Antes de descargar, si yt-dlp tiene más de 45 días se actualiza; y si una descarga falla como falla un yt-dlp desactualizado, se actualiza y la descarga se repite una vez, antes de probar las cookies de los navegadores. Como mucho una actualización automática cada 6 horas; el interruptor está en Ajustes → Descargas, que también muestra la última.
- **Ver y localizar.** La página reproduce los archivos en el sitio (vídeo, audio, imágenes) desde `GET /api/media/:id/file`, que admite peticiones Range, y abre el Explorador con el archivo seleccionado. En el lector, un vídeo guardado (o un enlace de un sitio conocido) tiene un botón **Descargar**.
- **Límites.** La aplicación no descifra contenido con DRM, no inicia sesión por ti y no descarga de sitios que yt-dlp y gallery-dl no sepan leer. Borrar archivos desde la aplicación es definitivo (Node no tiene papelera) y solo ocurre si se pide de forma explícita.

Rutas REST (con la misma protección local que el resto de `/api`):

| Ruta | Uso |
| --- | --- |
| `GET /api/media` | Lista, la más reciente primero (`?status=` un estado, `active` o `finished`; `?limit=`). |
| `POST /api/media` | Empieza `{ url, format, quality, dir, save_link, playlist, max_items, cookies_browser }`; devuelve la fila en cola (una descarga idéntica en curso se devuelve con `existing: true`). |
| `GET /api/media/:id` | Una descarga con progreso, archivos y metadatos. |
| `POST /api/media/:id/cancel` · `retry` | Cancelar (en espera o en marcha) / volver a encolar la misma descarga. |
| `DELETE /api/media/:id` | Quita el registro; con `?files=1` borra también los archivos descargados. |
| `GET /api/media/:id/file?i=0` | Envía un archivo producido (admite Range; `&download=1` como adjunto). |
| `POST /api/media/:id/reveal` | Abre el gestor de archivos sobre el archivo (`explorer /select,` en Windows). |
| `POST /api/media/probe` | Qué hay tras un enlace (título, duración, alturas, lista o publicación de fotos) sin descargar. |
| `GET /api/media/tools` · `POST /api/media/tools/update` | Programas encontrados con sus versiones / actualizarlos. |
| `GET /api/media/settings` · `PUT /api/media/settings` | Carpeta de descargas y archivo de cookies. |

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
| `import_video_transcript` | Importar subtítulos disponibles de un vídeo de YouTube guardado para leerlos, buscarlos y citarlos. Requiere `python -m yt_dlp`; no descarga el vídeo. |
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
| `media_download` | Descargar el vídeo, el audio o las fotos de un enlace; espera y devuelve los archivos con ruta absoluta y tamaño (`format`, `quality`, `dir`, `save_link`, `playlist`, `wait`, `timeout_s`). |
| `media_status` | Progreso y resultado de una descarga o la lista reciente. |
| `media_cancel` | Cancelar una descarga en espera o en marcha. |
| `media_retry` | Volver a encolar una descarga fallida o cancelada. |
| `media_probe` | Título, duración, alturas disponibles, lista o publicación de fotos — sin descargar. |
| `media_tools` | Si se encontraron yt-dlp, gallery-dl y ffmpeg, con versiones; `update: true` los actualiza. |
| `media_delete` | Quitar el registro de una descarga; sus archivos solo con `delete_files` y `confirm`. |

Son 25 herramientas en total. `GET /api/agent/tools` siempre refleja la lista real. Las descripciones terminan con una línea `Sinónimos:` en español, para que la forma de hablar de un usuario («guarda esto», «resumen de la semana») encuentre la herramienta correcta.

El asistente tiene instrucciones de resumir o citar un enlace solo a partir del texto que devuelve `read_link`, nunca solo del título, y de decir con claridad cuándo una descarga sigue pendiente o falló en lugar de inventar un resumen.

## Datos y límites

- `data/links-hoard.db`: enlaces, subrayados, vigilancias, la lista de descargas y ajustes, SQLite con WAL. Los archivos descargados no están en la carpeta de datos: están en la carpeta de descargas.
- `data/mcp-token`: credencial local creada al iniciar; no se publica ni se incluye en ningún otro sitio.
- Descarga: 15 s de tiempo límite, cabecera User-Agent de navegador, 5 MB de tope. El HTML pasa por `linkedom` + `@mozilla/readability`, con una alternativa manual (título + meta descripción + cuerpo sin etiquetas) cuando Readability no encuentra nada útil. Antes de extraer, se elimina el relleno habitual (infoboxes, navboxes, barras laterales, marcas de referencia, tablas de contenidos, enlaces de «editar», `<nav>`/`<aside>`), y el HTML restante se convierte a texto bloque a bloque (salto de línea tras cada párrafo/título/elemento de lista/fila de tabla, espacio entre celdas), para que el texto nunca quede pegado entre celdas o bloques como ocurriría con `textContent` a secas. El extracto elige el primer párrafo real (≥ 80 caracteres con puntuación de frase) en lugar de lo primero que aparezca en el marcado, como un infobox. PDF e imágenes se registran con un título derivado del nombre de archivo (sin OCR ni renderizado). YouTube/Vimeo obtienen un título por oEmbed sin necesitar clave de API. Un enlace guardado antes de esta mejora en la extracción se puede corregir con **refetch_link** / `POST /api/links/:id/refetch` (o el botón «Reintentar descarga» del lector): vuelve a ejecutar la extracción actual sobre la misma URL y sobrescribe el título, el extracto y el texto guardados.
- Búsqueda: FTS5 cuando el SQLite del sistema lo soporta (se comprueba en cada arranque); si no, una alternativa `LIKE` sobre los mismos campos, ambas reflejadas en `GET /api/state`.

## Verificación

```sh
npm test
npm run build
```

Las pruebas usan directorios de datos temporales y un servidor HTTP local para las páginas de ejemplo: nada toca tus datos reales ni la red. Las descargas se prueban con scripts pequeños que imitan yt-dlp, gallery-dl y ffmpeg (`tests/media-fakes.js`, elegidos con `LINKS_YTDLP=node:<script>`), así que no hace falta ningún sitio real ni ningún programa. Cubren normalización de URL, extracción con Readability sobre una página de ejemplo, idempotencia al guardar, búsqueda de texto completo, el resumen, subrayados, análisis de importación de marcadores/listas de URL, autenticación del token del asistente, un recorrido completo de la API y, para las descargas: detección de plataforma, argumentos por formato y calidad, lectura del progreso, la cola (orden, cancelación de una descarga en espera y de la que corre con su árbol de procesos), el relevo a gallery-dl, las cookies de los navegadores, el enlace guardado con su nota, que nunca se sobrescribe nada, el envío de archivos con Range, las rutas REST y las herramientas MCP.

Diseño y decisiones: [`DESIGN.md`](DESIGN.md).
