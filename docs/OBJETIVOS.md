# Objetivos futuros de Links Hoard

Lista viva. Lo que se cierra se mueve al README; aquí solo queda lo que falta.

## Integración con Writer (tarea #1711, del lado de Writer)

- Writer llama a Links como módulo externo para guardar referencias (hoy el módulo absorbido sigue en su código; Writer está bloqueado por la tarea #1095 y no se toca desde aquí).
- Retirar de Writer el manifiesto de compatibilidad `links` y su lista `absorbs` cuando Writer lo cierre. El Hub ya resuelve `links` a esta app (primera raíz de `hub.json`).

## Faustus (tarea #1723)

- Sustituir el preset integrado de Faustus por `faustus-plugin.json` de este repo y recargar plugins. Mientras tanto el conector `links` apunta a `http://127.0.0.1:5181` pero conserva el comando antiguo.

## Sentidos

- Fijar CLAP y AudioSet en una revisión concreta de Hugging Face para que una actualización del modelo no cambie las etiquetas.
- Etiquetas de CLAP afinadas para música cantada (hoy puede llamar «techno» a un pop de los 80; la cabecera ya añade las clases de AudioSet para contrastar).
- Separar voz y música antes de describir, para que la voz de fondo no ensucie la descripción del tramo.
- Pista de sonido de vídeos largos (más de 30 min) por lotes en segundo plano, con reanudación.

## Vídeos

- Reutilizar la transcripción de Funes cuando el Hub lo marque como disponible, sin pasar por el respaldo local con faster-whisper.
