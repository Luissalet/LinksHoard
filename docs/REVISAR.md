# Errores y cosas por revisar

Lista viva de fallos conocidos y puntos a vigilar. Cada línea dice qué pasa, cómo se nota y qué se hizo.

## Abiertos

- **Funes aparece como «foreign» en el Hub** (está dentro de Talos, puerto 5220). `serviceAvailable` exige estado `running` y la llamada `/api/apps/funes/call` devolvió 409 durante un rato. Links tiene un respaldo local (faster-whisper en `.venv-sentidos`), así que el digest no se rompe, pero la transcripción sale con otro motor. Es del Hub/Talos, no de Links.
- **CLAP etiqueta mal la música cantada**: un pop de los 80 sale como «techno music, vocal chop». Las etiquetas de Sentidos son estimaciones; la cabecera de cada tramo añade las tres clases de AudioSet más probables para contrastarlas. Ver `OBJETIVOS.md`.
- **Voz cantada sin transcripción**: Funes y Whisper no detectan voz en algunas canciones y el digest lo anota como «Sin transcripción: no se detectó voz». Es correcto, no hay bug, pero la capa de sonido es la única que describe esos tramos.
- **El Hub solo lee las raíces al arrancar**: tras cambiar `hub.json` hay que reiniciar el Hub. Esta app ya está en la primera raíz.

## Resueltos

- `faster-whisper` fallaba con «open() got an unexpected keyword argument 'metadata_errors'»: `av` 19 quitó ese argumento. Se fija `av==16.1.0` en `sentidos/requirements.txt`.
- El proceso de Sentidos se quedaba colgado al cerrar la app en Windows: el vigilante ahora comprueba el PID del padre (`--parent-pid`) en vez de leer la entrada estándar.
- Las pruebas encontraban los binarios reales de `~/.hoard/bin`: `tests/helpers.js` usa un `HOARD_HOME` temporal y un entorno de Sentidos inexistente.
- `npm test` fallaba en dos pruebas de descargas («missing programs…» y «updating the tools…») aunque el código estaba bien: el `HOARD_HOME` de pruebas era una carpeta temporal fija, compartida por todas las pasadas, y en una pasada con la máquina cargada el Python falso pareció ausente, el actualizador descargó el yt-dlp real de la red a esa carpeta y desde entonces todas las pasadas lo encontraban. Ahora cada proceso de pruebas tiene su propio `HOARD_HOME`, que se borra al acabar, y las pruebas no descargan programas de la red. Si alguna vez se lanzan con `HOARD_EVENTS=0` en el entorno, fallan las que esperan eventos en el hub de prueba: es el entorno, no un fallo.
