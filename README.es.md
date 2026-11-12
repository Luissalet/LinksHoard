<img src="app-icon.png" width="96" alt="">

# Links Hoard

Biblioteca local de «leer después»: guarda una URL, obtén el texto extraído del artículo, etiquétalo y subráyalo, busca en todo y deja que un asistente lo use por MCP. [English](README.md)

## Qué es

Links Hoard guarda los enlaces en un único archivo SQLite de tu propio ordenador. Al guardar un enlace se descarga la página en segundo plano y se extrae el artículo legible (título, autor, extracto, texto completo), de modo que lees una copia limpia y puedes buscar en ella después. Además de marcadores, sigue feeds y páginas, descarga medios, digiere vídeos, narra artículos y responde preguntas sobre lo que has guardado.

Funciona como un Hoard propio, con su servidor, puerto, carpeta de datos y puente MCP. Writer's Hoard lo usa por referencia para su módulo de lectura y enlaces.

## Qué hace

### Guardar y leer
- Pega una URL, usa el bookmarklet, comparte hacia la PWA instalada (el manifiesto declara un destino de compartir) o llama a `save_link`. El enlace se guarda al instante y una cola en segundo plano lo descarga; guardar es idempotente sobre una URL normalizada (se ignoran parámetros de seguimiento, fragmentos, puertos por defecto y barras finales).
- Lector con tamaño de letra ajustable, URL original, sitio, autor y tiempo de lectura; selecciona texto para subrayarlo con una nota opcional.
- Etiquetas, favoritos, archivo y estado leído/no leído, con recuento de etiquetas y filtro por sitio.
- Búsqueda de texto completo (SQLite FTS5, con alternativa automática `LIKE`) en título, descripción, texto, notas, etiquetas y transcripciones de vídeo.
- Importación masiva desde una exportación de marcadores del navegador (HTML Netscape) o una lista de URL, sin duplicar lo que ya tienes.
- Resumen semanal de lo guardado desde una fecha, agrupado por sitio.
- Sugerencias de «para leer hoy» entre lo guardado sin leer, y planes de lectura que encajan textos completos sin leer en un presupuesto de minutos. Véase [docs/READING_PLAN.md](docs/READING_PLAN.md).
- Los subrayados se pueden enviar a Hypatia's Hoard como tarjetas en el mazo «Lecturas».

### Preguntar a un artículo guardado
- El lector responde preguntas sobre un artículo con el modelo del Hub, con citas exactas y anclas de párrafo clicables; se avisa de citas inválidas y de texto cambiado. Las preguntas y respuestas son transitorias. Véase [docs/ARTICLE_QUESTIONS.md](docs/ARTICLE_QUESTIONS.md).

### Vigías
- Sigue un feed RSS/Atom, un repositorio de GitHub (versiones, etiquetas o commits) o una página normal (diferencia de texto en cada cambio), cada uno con su propio intervalo.
- Las vigías de lista siguen las entradas de una página sin feed (ofertas, productos, anuncios) con un selector CSS encontrado automáticamente o dado por ti.
- Los elementos que traen las vigías se pueden leer, descartar o guardar como enlaces.

### Guardar un sitio entero
- Mapea un sitio o sección a partir de sus sitemaps y enlaces, con patrones de inclusión y exclusión, y guarda las páginas como enlaces en una tarea en segundo plano que respeta `robots.txt`, salta lo ya guardado, se puede reanudar o cancelar y deja historial.

### Descargas
- Vídeo, audio y publicaciones de fotos de YouTube, X, Instagram, TikTok, SoundCloud, Vimeo, Twitch, Reddit, Facebook, Bilibili y cualquier otro sitio que admita yt-dlp, usando yt-dlp, gallery-dl y ffmpeg como programas aparte.
- Formatos `video` (MP4), `audio` (MP3), `image` o `auto`; elección de calidad, tramos y listas de reproducción opcionales; cola de una en una con progreso, cancelación y reintento.
- Un botón «Iniciar sesión con <sitio>» para publicaciones privadas, con el perfil de navegador propio de la app; inicias sesión tú, nunca el asistente.
- yt-dlp se actualiza solo cuando envejece o falla como falla una versión antigua.
- Las descargas terminadas se pueden guardar como enlaces con la etiqueta `descarga`.

### Vídeo
- **Análisis**: transcripción con marcas de tiempo (Funes a través de Hoard Link, o faster-whisper local) y hasta 24 fotogramas clave por cambio de escena; la transcripción es buscable.
- **Digest**: descarga, transcribe, lee el texto en pantalla por OCR y escribe capítulos y un resumen con los modelos locales del Hub en un dosier por capas que un asistente puede leer barato, interrogar y buscar. Véase [docs/VIDEO_DIGEST.md](docs/VIDEO_DIGEST.md).

### Escuchar
- Narra un artículo guardado (o el digest de un vídeo) con Prospero's Hoard, frase a frase como tarea en segundo plano, con el audio guardado en local.
- Barra de reproducción con pausa, saltos, velocidad y reanudación de posición; una cola ordenada de «escuchar después»; voz elegida según el idioma del enlace o en la página Escuchar. Véase [docs/ESCUCHAR.md](docs/ESCUCHAR.md).

### Sentidos
- Un motor de escucha local (modelos CLAP y AudioSet en CPU) que describe un sonido, encuentra y compara sonidos, mide audio, comprueba lo real que suena, dibuja líneas de tiempo y hojas de contacto y construye una capa de banda sonora para los digests de vídeo. Véase [docs/SENTIDOS.md](docs/SENTIDOS.md).

### Copiloto de Faustus y App Dock
- El panel común de Faustus está en todas las vistas y recibe el enlace actual, el párrafo o texto seleccionado y los valores de formulario sin guardar; las listas y el lector se refrescan tras un turno sin perder notas sin guardar.
- Junto a un chat de Faustus, la app registra herramientas de vista (`links_open`, `links_filter`, `links_view`) para que el asistente abra enlaces, aplique filtros y cambie de sección. Véase [docs/COPILOT.md](docs/COPILOT.md).

## Cómo ejecutarlo

Requiere Node.js 22.13 o posterior (usa `node:sqlite` integrado). Sin módulos nativos ni Docker.

```sh
npm install
npm run build
npm start          # http://127.0.0.1:5181
```

`npm run open` arranca el servidor y abre el navegador en Windows; `npm run dev` ejecuta la API con `node --watch` junto con Vite. El servidor escucha solo en `127.0.0.1`. Si el puerto 5181 está ocupado toma el siguiente libre; `PORT_STRICT=1` hace que falle.

| Variable | Para qué sirve |
| --- | --- |
| `LINKS_PORT` / `PORT` | Puerto preferido (por defecto `5181`). |
| `LINKS_DATA_DIR` | Carpeta de datos (por defecto `<repo>/data`): `links-hoard.db` y `mcp-token`. |
| `LINKS_ALLOWED_HOSTS` | Nombres de host extra aceptados detrás de un túnel, separados por comas, exactos o `*.sufijo`. |
| `LINKS_ALLOW_PRIVATE_URLS=1` | Permite descargar desde esta máquina o tu red; desactivado por defecto. |
| `LINKS_URL`, `LINKS_TOKEN_FILE` / `LINKS_TOKEN` | Puente MCP: URL base de la app en marcha y dónde leer su token. |
| `LINKS_MEDIA_DIR` | Carpeta de descargas si no hay una en Ajustes (por defecto `<home>/Downloads/Links Hoard`). |
| `LINKS_YTDLP`, `LINKS_GALLERYDL`, `LINKS_FFMPEG` | Rutas de los programas externos; las variantes `HOARD_*` de toda la familia también valen y prevalecen. |
| `LINKS_FAUSTUS_URL` | Endpoint de Faustus para el copiloto. |
| `LINKS_WATCHES=0` | Desactiva el planificador de vigías. |
| `LINKS_VIDEO`, `LINKS_VIDEO_AUTO`, `LINKS_VIDEO_AUTO_DOWNLOAD` | Controlan el análisis de vídeo en segundo plano y las descargas automáticas. |
| `LINKS_WHISPER_MODEL` | Modelo faster-whisper local para la transcripción de reserva. |
| `LINKS_SENTIDOS_VENV`, `LINKS_SENTIDOS_HOME` | Entorno Python y carpeta del motor Sentidos. |
| `LINKS_COOKIES_FILE`, `LINKS_SESSIONS_DIR` | Archivo de cookies y carpeta de sesiones de inicio de sesión para publicaciones privadas. |

El servidor solo responde a peticiones cuyo `Host` sea `localhost`, `127.0.0.1` o `[::1]`; para acceder desde el móvil por un túnel, añade los nombres de host del túnel a `LINKS_ALLOWED_HOSTS`.

Las páginas se descargan con el descargador común de la familia: cada salto de redirección se comprueba contra direcciones privadas y de metadatos, el cuerpo se limita a 5 MB y el HTML pasa por Readability con una alternativa manual.

## Conexión con Faustus y el Hoard Hub

- Id de app `links`, puerto por defecto 5181; `faustus-plugin.json` es el manifiesto del plugin. Arráncala desde el Hoard Hub o con `npm start`.
- El puente MCP (`server/mcp.js`) reenvía cada llamada por HTTP a la app en marcha, autenticada con el token de `<carpeta de datos>/mcp-token`; nunca abre la base de datos. `GET /api/agent/tools` devuelve la lista viva de herramientas. Las descripciones acaban con sinónimos en español para que las frases en español encuentren la herramienta correcta.
- Herramientas por grupos: guardar y leer (`save_link`, `list_links`, `search_links`, `read_link`, `read_link_paragraphs`, `ask_link`, `edit_link`, `tag_link`, `mark_link`, `add_highlight`, `refetch_link`, `delete_link`, `list_tags`, `link_digest`, `resurface`, `reading_plan`, `highlights_to_cards`, `import_video_transcript`); vigías (`watch_*`); mapeo y rastreo de sitios (`map_site`, `crawl_*`); descargas (`media_*`, `site_sessions`, `site_login`, `site_logout`, `read_post`); vídeo (`link_video*`, `video_digest*`, `video_ask`, `video_find`, `video_frame`); escucha (`listen_*`); sonido (`audio_*`).
- Al asistente se le indica que resuma o cite un enlace solo a partir del texto que devuelve `read_link` y que diga claramente cuándo una descarga está pendiente o ha fallado.
- Writer's Hoard reenvía sus vistas de lectura y llamadas de herramientas a esta app a través del Hub y ofrece arrancarla si no está en marcha.
- El manifiesto nombra las skills `read-later-digest` y `web-to-clean-markdown`, visibles en la pestaña Skills del Hub.

## Estructura del proyecto

| Ruta | Contenido |
| --- | --- |
| `server/` | Servidor Node: API, extracción, vigías, rastreos, descargas, vídeo, escucha, puente MCP |
| `client/` | Interfaz web (Vite) |
| `sentidos/` | Motor de escucha en Python |
| `docs/` | Referencias de funciones |
| `scripts/` | Scripts auxiliares |
| `tests/` | Pruebas |
| `data/` | Base de datos local y token (ignorado por git) |
| `faustus-plugin.json` | Manifiesto del plugin de Faustus |

## Desarrollo

```sh
npm test
npm run build
```

Las pruebas usan carpetas de datos temporales, un servidor HTTP local para los casos, un hub simulado y scripts simulados de yt-dlp, gallery-dl y ffmpeg. Las notas de diseño están en [DESIGN.md](DESIGN.md); los objetivos y problemas conocidos, en [docs/OBJETIVOS.md](docs/OBJETIVOS.md) y [docs/REVISAR.md](docs/REVISAR.md).

Datos: `data/links-hoard.db` (SQLite con WAL) guarda enlaces, subrayados, vigías, la lista de descargas y los ajustes; los archivos descargados viven en la carpeta de descargas. Véase `LICENSE`.
