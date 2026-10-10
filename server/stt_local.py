"""Local CPU speech to text for Links Hoard (used only when the family's STT service is not there).

Usage: python stt_local.py <audio.wav> <model> <language|auto> [allow_download:0|1]
Prints one JSON object on stdout: {"text", "language", "model", "segments": [{"start", "end", "text"}]}.
The model must already be in the local cache unless allow_download is 1: nothing is downloaded behind the user's back.
"""
import json
import sys


def main():
    audio, model_name = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 else "auto"
    allow_download = len(sys.argv) > 4 and sys.argv[4] == "1"
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4, local_files_only=not allow_download)
    segments, info = model.transcribe(audio, language=None if language in ("", "auto") else language, vad_filter=True)
    out = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            out.append({"start": round(float(seg.start), 2), "end": round(float(seg.end), 2), "text": text})
    print(json.dumps({"text": " ".join(s["text"] for s in out), "language": info.language, "model": model_name, "segments": out}, ensure_ascii=False))


if __name__ == "__main__":
    main()