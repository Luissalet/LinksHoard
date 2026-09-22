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
| `LINKS_URL` | Puente MCP: URL de la aplicación (por defecto `http://127.0.0.1:5181`). Debe ser local. |
| `LINKS_TOKEN_FILE` / `LINKS_TOKEN` | Puente MCP: de dónde leer el token (por defecto `<datos>/mcp-token`). |

## Qué hace

- **Guarda al instante.** Pega una URL (o usa el bookmarklet, «Compartir» desde el móvil una vez instalada como app, o la herramienta `save_link` de un asistente) y se guarda inmediatamente con `fetch_status: pending`. Una cola en segundo plano (2 a la vez) descarga la página, extrae el artículo con Readability y rellena título, autoría, extracto y texto completo; la fila se actualiza sola, sin recargar.
- **Lee sin distracciones.** El lector muestra el texto extraído con tamaño de letra ajustable, junto a la URL original, el sitio, la autoría y el tiempo de lectura. Selecciona cualquier texto para subrayarlo, con nota opcional.
- **Organiza.** Etiquetas, favoritos, archivo, leído/no leído. La barra lateral muestra el recuento de etiquetas; la lista también filtra por sitio.
- **Busca en todo.** Búsqueda de texto completo (SQLite FTS5) en título, descripción, texto extraído, notas y etiquetas. Si el SQLite del sistema no trae FTS5, la aplicación cae automáticamente a una búsqueda `LIKE` y lo indica en Ajustes.
- **Importa en bloque.** Marcadores HTML de Netscape (lo que exporta cualquier navegador) o una lista de URLs, una por línea. Ambas evitan duplicados con lo que ya tienes.
- **Resumen semanal.** `GET /api/digest?since=` (y la herramienta MCP `link_digest`) lista lo guardado desde una fecha, agrupado por sitio, con extractos.
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
| `list_tags` | Todas las etiquetas en uso, con recuento. |

Son 11 herramientas en total. `GET /api/agent/tools` siempre refleja la lista real. Las descripciones terminan con una línea `Sinónimos:` en español, para que la forma de hablar de un usuario («guarda esto», «resumen de la semana») encuentre la herramienta correcta.

El asistente tiene instrucciones de resumir o citar un enlace solo a partir del texto que devuelve `read_link`, nunca solo del título, y de decir con claridad cuándo una descarga sigue pendiente o falló en lugar de inventar un resumen.

## Datos y límites

- `data/links-hoard.db`: enlaces, subrayados y ajustes, SQLite con WAL.
- `data/mcp-token`: credencial local creada al iniciar; no se publica ni se incluye en ningún otro sitio.
- Descarga: 15 s de tiempo límite, cabecera User-Agent de navegador, 5 MB de tope. El HTML pasa por `linkedom` + `@mozilla/readability`, con una alternativa manual (título + meta descripción + cuerpo sin etiquetas) cuando Readability no encuentra nada útil. PDF e imágenes se registran con un título derivado del nombre de archivo (sin OCR ni renderizado). YouTube/Vimeo obtienen un título por oEmbed sin necesitar clave de API.
- Búsqueda: FTS5 cuando el SQLite del sistema lo soporta (se comprueba en cada arranque); si no, una alternativa `LIKE` sobre los mismos campos, ambas reflejadas en `GET /api/state`.

## Verificación

```sh
npm test
npm run build
```

Las pruebas usan directorios de datos temporales y un servidor HTTP local para las páginas de ejemplo: nada toca tus datos reales ni la red. Cubren normalización de URL, extracción con Readability sobre una página de ejemplo, idempotencia al guardar, búsqueda de texto completo, el resumen, subrayados, análisis de importación de marcadores/listas de URL, autenticación del token del asistente y un recorrido completo de la API.

Diseño y decisiones: [`DESIGN.md`](DESIGN.md).
