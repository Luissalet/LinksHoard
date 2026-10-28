# Sentidos: el oído de Links Hoard

Sentidos escucha un sonido en tu equipo y dice qué es, qué música y qué efectos lleva, cuánto suena y si parece grabado o sintético. Funciona con dos modelos locales, sin nube y sin cuentas: **CLAP** (`laion/larger_clap_general`, compara el sonido con descripciones escritas) y **AST / AudioSet** (`MIT/ast-finetuned-audioset-10-10-0.4593`, 527 clases de sonido). Se ejecutan en la CPU y ocupan unos 1,1 GB en disco (se descargan una vez) y unos 2 GB de memoria mientras el motor está cargado.

La voz no es cosa de Sentidos: se transcribe aparte (Funes, o faster-whisper en este equipo). Sentidos oye todo lo demás: música, efectos, ambiente, golpes, pasos, aplausos.

## Qué hace

| Herramienta MCP | Pantalla | Qué responde |
| --- | --- | --- |
| `audio_describe` | Qué suena | Con qué descripciones del vocabulario se parece más (con su z y veredicto), etiquetas de AudioSet, forma y volumen. |
| `audio_match` | Comprobar descripción | ¿Suena a lo que escribes? z frente a un vocabulario calibrado, puesto en la clasificación, veredicto y alternativas (`alts`). |
| `audio_find` | Buscar el momento | En qué tramos de un archivo suena lo que describes (ventanas o eventos). **Sin archivo**, busca en las bandas sonoras ya indexadas por los digests de vídeo (instantáneo); con `deep: true` ordena además los audios y vídeos descargados escuchándolos. |
| `audio_timeline` | Línea de tiempo | Secciones con su género, ánimo, instrumentos y ambiente, eventos etiquetados (golpes, pasos, voz), volumen (LUFS, pico real, LRA), caídas y pulso. `detail` low, normal o high. |
| `audio_measure` | Medir | Números sin modelos: volumen integrado y a corto plazo, pico, rango, ruido de fondo, saturación, anchura estéreo, brillo, ancho de banda, ataque y golpes por segundo (`music: true` añade el tempo). |
| `audio_realness` | ¿Real o sintético? | Probabilidad de grabación real por ventanas de 4 s y global. Orientativo: su calibración es débil y se dice. |
| `audio_sheet` | Hoja de sonido | PNG con espectrograma, onda, volumen, secciones y eventos. Devuelve la ruta y el tamaño. |
| `audio_status` | Motor | Si está instalado, si los modelos están listos, si el motor corre; `setup`, `start`, `stop`. |

Todas aceptan **una fuente**: `path` (archivo absoluto), `id` (enlace guardado con un audio o vídeo descargado) o `url` (si no está guardado, se baja solo el audio y se guarda en la biblioteca). `start` y `end` (segundos) acotan el tramo. Por defecto la respuesta es el texto legible; `with_data: true` añade las cifras.

## Cómo leer una respuesta

Cada etiqueta es una **estimación** de un modelo, no un hecho. La z dice cuánto se aleja el sonido del azar frente a un vocabulario de ~320 descripciones:

| Veredicto | z | Precisión medida en la biblioteca de calibración |
| --- | --- | --- |
| fuerte (*strong*) | ≥ 3 | 98 % |
| plausible | 2,5 a 3 | 41 % |
| débil (*weak*) | 2 a 2,5 | 28 % |
| sin coincidencia (*no match*) | < 2 | no es una coincidencia |

Las descripciones de música, instrumentos y voz van marcadas «sin validar»: su umbral no se ha medido. Un asistente debe citar el veredicto, no darlo por cierto.

## Banda sonora en el digest de vídeo

Un digest de vídeo con Sentidos preparado lleva una capa más, **«qué suena»**: `sound.md` (secciones con su lectura y etiquetas de AudioSet con tiempos, volumen, pulso y los eventos más expuestos), una línea **Suena** en la ficha y una línea por capítulo en el índice. Se genera con `audio_timeline` sobre la pista de audio del vídeo (hasta los primeros 30 minutos; `sound_max_s` en los ajustes del digest).

- Se lee con `video_digest_read` nivel `sound` (también con `from`/`to`), forma parte de `full` y de la pestaña **Qué suena** del panel del vídeo.
- Se busca con `video_find` (resultados `where: "sound"`) y con `audio_find` sin fuente.
- `video_ask` puede citarla (`a1`, `a2`…) y las citas se comprueban igual que las de la voz; se redacta como estimación.
- Si Sentidos no está preparado, el digest termina igual (no queda «parcial»), lo anota en los avisos y se completa solo con la capa de sonido la próxima vez que se pida el digest con Sentidos listo. Se apaga con el ajuste **Escuchar la banda sonora** (`sound: false`).

## Instalación

Desde la app: página **Sentidos → Preparar Sentidos** (o `audio_status` con `action: "setup"`). Hace, en segundo plano y solo lo que falte:

1. Busca un Python 3.10 a 3.13 (`LINKS_SENTIDOS_BASE_PYTHON` para indicarlo) y crea un entorno propio en `.venv-sentidos/` (no se toca ningún otro Python).
2. Instala `sentidos/requirements.txt` (torch en su versión de CPU, transformers, librosa, faster-whisper…): varios cientos de MB.
3. Arranca el motor y descarga los dos modelos en `<datos>/sentidos/hf/` (unos 1,1 GB).

El motor es un proceso Python (`python -m sentidos.worker`) que mantiene los modelos cargados y responde por HTTP en 127.0.0.1. Links lo arranca en la primera consulta (o con **Arrancar el motor**), lo para tras 20 minutos sin uso (ajustable; 0 = nunca) y lo cierra con la app: el motor vigila el proceso de Links y se cierra solo si desaparece.

`.venv-sentidos/` incluye además faster-whisper: el digest lo usa como motor de voz a texto cuando Funes no está disponible (el modelo `base` debe estar ya en la caché de Hugging Face; `LINKS_WHISPER_ALLOW_DOWNLOAD=1` permite descargarlo).

## Variables de entorno

| Variable | Para qué |
| --- | --- |
| `LINKS_SENTIDOS_VENV` | Carpeta del entorno de Python (por defecto `<repo>/.venv-sentidos`). |
| `LINKS_SENTIDOS_HOME` | Carpeta de modelos y hojas (por defecto `<datos>/sentidos`). |
| `LINKS_SENTIDOS_BASE_PYTHON` | Python con el que crear el entorno. |
| `LINKS_SENTIDOS_IDLE_MIN` | Minutos sin uso antes de parar el motor (por defecto 20; 0 = nunca). |
| `SENTIDOS_THREADS`, `SENTIDOS_PRECISION`, `SENTIDOS_OFFLINE` | Hilos de CPU, precisión (`bf16`, `fp32`) y no tocar la red; los lee el motor. |

## API REST

`GET /api/sentidos/status`, `POST /api/sentidos/setup`, `POST /api/sentidos/start`, `POST /api/sentidos/stop`, `GET|PUT /api/sentidos/settings` (`idle_min`, `warm`), `GET /api/sentidos/sources` (audios y vídeos descargados), `POST /api/sentidos/run {tool, path|id|url, query?, alts?, start?, end?, detail?}`, `GET /api/sentidos/search?q=`, `GET /api/sentidos/sheet/<nombre>.png`.

## Límites

- Solo CPU: la primera consulta carga los modelos (~1 min); una línea de tiempo de 1 minuto tarda unos 50 s con detalle normal (el coste está acotado en archivos largos).
- Un trabajo a la vez: las consultas se encolan en el motor.
- Las etiquetas de música, voz e instrumentos y la detección de sintético son orientativas; los vídeos con mucha voz dan etiquetas de voz y «ambiente de café» sin que haya un café.
- No transcribe ni reconoce canciones concretas; no separa pistas.

## Origen y licencia

El motor (`sentidos/`) es una bifurcación separada de **earshot 0.4.0** (MIT, © 2026 Leon Lin), integrada con nombres y API propios; se han quitado sus partes de generación, crítica y comparación y se ha añadido el motor residente (`worker.py`). Su aviso de licencia está en `sentidos/NOTICE` y `sentidos/LICENSE.earshot`. Los modelos conservan sus licencias (CLAP: Apache-2.0; AST: BSD-3-Clause).

---

## In English

Sentidos is Links Hoard's ear: two local models (CLAP and AST/AudioSet, CPU only, about 1.1 GB downloaded once) in a resident Python worker that Links starts on demand and stops when idle. MCP tools `audio_describe`, `audio_match`, `audio_find`, `audio_timeline`, `audio_measure`, `audio_realness`, `audio_sheet` and `audio_status` take a file `path`, a saved link `id` or a `url`; every label is an estimate with a calibrated z-score and verdict (strong z>=3, plausible, weak, no match). A video digest gains a "what it sounds like" layer (`sound.md`, `video_digest_read` level `sound`, searchable with `video_find`, citable by `video_ask`). Set it up from the **Sentidos** page. The engine is a detached fork of earshot 0.4.0 (MIT); see `sentidos/NOTICE`.
