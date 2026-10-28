"""Sentidos worker: one process that keeps the listening models loaded and answers JSON over loopback HTTP.

    python -m sentidos.worker [--port N] [--warm]

The Links Hoard server starts it on demand (server/sentidos.js), asks it for the port on its first stdout line
({"sentidos_worker": {"port": N, "pid": P}}) and sends every call to POST /call {"tool": ..., "args": {...}}.
Calls run one at a time (CPU models; no import races). The first call that needs a model loads it (20-60 s on CPU)
and the model then stays in memory for the life of the process.

Tools: measure, describe, match, find, rank, timeline, realness, sheet. Every result is
{"ok": true, "tool", "summary", "text", "data", "image"?}: the plain-language reading first, then the numbers.

Derived from earshot (MIT, (c) 2026 Leon Lin): see NOTICE and LICENSE.earshot in this folder.
"""
import argparse
import contextlib
import json
import math
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__, audio, config
from .report import _clean

LOCK = threading.RLock()
STATE = {'started': time.time(), 'calls': 0, 'busy': None, 'last_error': None, 'loaded': {'clap': False, 'ast': False},
         'fetch': {'running': False, 'log': [], 'error': None, 'done': False}}
SILENT_PEAK_DBFS = -70.0
TEXT_MAX = 24000
JSON_MAX = 7000


class ToolFailure(Exception):
    """a readable error for the caller"""


# ------------------------------------------------------------------------------------------------ result shaping
def _shrink(o, n, depth=0):
    if isinstance(o, float):
        return round(o, 3)
    if isinstance(o, str):
        return o if len(o) <= 400 else o[:400] + ' ...'
    if isinstance(o, dict):
        return {k: _shrink(v, n, depth + 1) for k, v in o.items() if not (depth == 0 and k in ('summary', 'text'))}
    if isinstance(o, list):
        out = [_shrink(v, n, depth + 1) for v in o[:n]]
        return out + ([f'... +{len(o) - n} more'] if len(o) > n else [])
    return o


def _dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':'))


def compact(r, limit=JSON_MAX):
    """short, always valid data for an agent's context: floats to 3 decimals, long lists cut, summary / text left out;
    when that is still too long the largest top-level fields are named in 'cut_fields'"""
    c = _clean(r)
    d = c
    for n in (24, 12, 6, 3, 1):
        d = _shrink(c, n)
        if len(_dumps(d)) <= limit:
            return d
    if not isinstance(d, dict):
        return {'cut': 'too long for the compact view; ask again with full=true'}
    cut = []
    for k in sorted(d, key=lambda k: -len(_dumps(d[k]))):
        cut.append(k)
        out = {**{k2: v for k2, v in d.items() if k2 not in cut}, 'cut_fields': cut,
               'note': 'fields left out to stay short; ask again with full=true'}
        if len(_dumps(out)) <= limit:
            return out
    return out


def shape(tool, r, full=False, extra=None):
    r = r if isinstance(r, dict) else {'summary': str(r)}
    head = str(r.get('summary') or '').strip()
    body = str(r.get('text') or '').strip()
    if body.startswith(head):
        head = ''
    if len(body) > TEXT_MAX and not full:
        body = body[:TEXT_MAX] + f'\n... (text cut at {TEXT_MAX} characters; full=true gives all of it)'
    out = {'ok': True, 'tool': tool, 'summary': str(r.get('summary') or '').strip(),
           'text': '\n\n'.join(x for x in (head, body) if x),
           'data': _clean(r) if full else compact(r)}
    if extra:
        out.update(extra)
    return out


def measure_summary(m):
    """one plain sentence from a features.measure() dict"""
    if m.get('error'):
        return f'{m["duration"]:.3f} s: {m["error"]}.'
    if m.get('peak_dbfs', 0) < SILENT_PEAK_DBFS:
        what = 'digitally silent' if m.get('digital_silence_frac', 0) >= 0.999 else 'near-silent'
        return (f'{m["duration"]:.3f} s, {what} (peak {m["peak_dbfs"]:.0f} dBFS): nothing to measure; the loudness, '
                'spectrum and envelope values of silence are meaningless.')
    parts = [f'{m["duration"]:.3f} s']
    if 'lufs' in m:
        parts.append(f'{m["lufs"]} LUFS integrated' + (f' (short-term max {m["short_term_max_lufs"]})'
                                                       if 'short_term_max_lufs' in m else ''))
    else:
        parts.append(f'RMS {m["rms_dbfs"]} dBFS (too short for LUFS)')
    parts.append(f'true peak {m["true_peak_dbtp"]} dBTP' + (f', {m["clipped_samples"]} clipped samples'
                                                            if m.get('clipped_samples') else ''))
    if 'lra_lu' in m:
        parts.append(f'LRA {m["lra_lu"]} LU')
    parts.append(f'noise floor {m["noise_floor_dbfs"]} dBFS')
    if m.get('brightness_hz'):
        parts.append(f'brightness {m["brightness_hz"] / 1000:.1f} kHz')
    if m.get('bandwidth_hz'):
        parts.append(f'bandwidth {m["bandwidth_hz"] / 1000:.1f} kHz')
    if m.get('attack_ms') is not None:
        parts.append(f'attack {m["attack_ms"]:g} ms' + (f', decay {m["decay_ms"]:g} ms' if m.get('decay_ms') else ''))
    if 'onset_count' in m:
        parts.append(f'{m["onset_count"]} onsets')
    if 'tempo' in m:
        parts.append(f'tempo ~{m["tempo"]:g} BPM, key {m["key"][0]["key"] if m.get("key") else "?"}')
    s = ', '.join(parts) + '.'
    if m.get('digital_silence_frac', 0) > 0.01:
        s += (f' {100 * m["digital_silence_frac"]:.1f}% exact digital zeros (usually edit, fade or gate padding; weak '
              'evidence on its own: use realness to judge real vs synthesized).')
    return s


# ------------------------------------------------------------------------------------------------------- inputs
def _file(path, what='file'):
    if not path or not isinstance(path, str):
        raise ToolFailure(f'{what}: a file path is required')
    p = os.path.abspath(os.path.expanduser(path.strip().strip('"')))
    if not os.path.exists(p):
        raise ToolFailure(f'{what} not found: {p}')
    if os.path.isdir(p):
        raise ToolFailure(f'{what} is a folder, expected a file: {p}')
    return p


def _many(paths):
    if isinstance(paths, str):
        paths = [paths]
    if not paths:
        raise ToolFailure('paths: give at least one file or folder')
    expanded = [os.path.abspath(os.path.expanduser(str(p).strip().strip('"'))) for p in paths]
    empty = [p for p in expanded if not audio.list_media([p])]
    if empty:
        raise ToolFailure(f'no audio/video files found in {", ".join(empty[:5])}')
    return audio.list_media(expanded)


def _num(v):
    if v is None or v == '':
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ToolFailure(f'not a number: {v!r}') from None
    if math.isnan(f) or math.isinf(f):
        raise ToolFailure(f'not a number: {v!r}')
    return f


def _span(a):
    return {'start': _num(a.get('start')), 'end': _num(a.get('end'))}


def _detail(a):
    d = a.get('detail') or 'normal'
    if d not in ('low', 'normal', 'high'):
        raise ToolFailure('detail must be "low", "normal" or "high"')
    return d


def _video_for(p, a):
    v = a.get('video')
    if v:
        return _file(v, 'video')
    return p if os.path.splitext(p)[1].lower() in audio.VIDEO_EXTS else None


def _cues(cues):
    if isinstance(cues, str) and cues.strip() and cues.strip()[:1] not in '[{0123456789.-':
        return _file(cues, 'cues')
    return cues or None


# --------------------------------------------------------------------------------------------------------- tools
def t_measure(a):
    from . import features
    p = _file(a.get('path'))
    m = features.measure(p, music=bool(a.get('music')), light=bool(a.get('light')), **_span(a))
    return dict(summary=measure_summary(m), **m)


def t_describe(a):
    from .describe import describe
    return describe(_file(a.get('path')), top=int(a.get('top') or 8), **_span(a))


def t_match(a):
    from .match import match
    q = (a.get('query') or '').strip()
    if not q:
        raise ToolFailure('query: describe the sound you expect')
    alts = a.get('alts')
    if isinstance(alts, str):
        alts = [alts]
    return match(_file(a.get('path')), q, alts=alts or None, **_span(a))


def t_find(a):
    from .search import find
    q = (a.get('query') or '').strip()
    if not q:
        raise ToolFailure('query: describe the sound you are looking for')
    kind = a.get('kind') or 'auto'
    if kind not in ('auto', 'event', 'texture'):
        raise ToolFailure('kind must be "auto", "event" or "texture"')
    return find(_file(a.get('path')), q, win=_num(a.get('win')), hop=_num(a.get('hop')), top=int(a.get('top') or 5),
                kind=kind, **_span(a))


def t_rank(a):
    from .search import rank
    q = (a.get('query') or '').strip()
    if not q:
        raise ToolFailure('query: describe the sound you are looking for')
    return rank(_many(a.get('paths')), q, top=int(a.get('top') or 20))


def t_timeline(a):
    from .timeline import timeline
    p = _file(a.get('path'))
    return timeline(p, video=_video_for(p, a), cues=_cues(a.get('cues')), detail=_detail(a), **_span(a))


def t_realness(a):
    from . import realness as rmod
    model = getattr(rmod, 'MODEL_PATH', None)
    if model and not os.path.isfile(model):
        raise ToolFailure('realness is unavailable (its model file is missing): real-vs-synthesized was NOT checked')
    return rmod.realness(_file(a.get('path')), ast=bool(a.get('ast')) or False, **_span(a))


def t_sheet(a):
    from .sheet import sheet
    p = _file(a.get('path'))
    out = a.get('out_png')
    if not out:
        raise ToolFailure('out_png: the caller must say where to write the picture')
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = sheet(p, out, video=_video_for(p, a), cues=_cues(a.get('cues')), detail=_detail(a), **_span(a))
    r['png'] = r.get('png') or out
    return r


TOOLS = {'measure': t_measure, 'describe': t_describe, 'match': t_match, 'find': t_find, 'rank': t_rank,
         'timeline': t_timeline, 'realness': t_realness, 'sheet': t_sheet}


def call(tool, args):
    fn = TOOLS.get(tool)
    if fn is None:
        raise ToolFailure(f'unknown tool {tool!r}; tools: {", ".join(TOOLS)}')
    with LOCK, contextlib.redirect_stdout(sys.stderr):
        STATE['busy'] = tool
        try:
            r = fn(args or {})
            STATE['calls'] += 1
        finally:
            STATE['busy'] = None
        _mark_loaded()
    extra = {'png': r.get('png')} if tool == 'sheet' else None
    return shape(tool, r, bool(args.get('full')) if args else False, extra)


def _mark_loaded():
    for name in ('clap', 'ast'):
        mod = sys.modules.get(f'{__package__}.models.{name}')
        if mod is not None and getattr(mod, '_inst', None) is not None:
            STATE['loaded'][name] = True


# ----------------------------------------------------------------------------------------------- models + status
def models_status():
    """what the cache holds for each model, filesystem only"""
    from .models import hub
    out = {}
    for key, mid in (('clap', config.CLAP_MODEL), ('ast', config.AST_MODEL)):
        s = hub.resolve(mid, config.CLAP_REVISION if key == 'clap' else config.AST_REVISION)
        out[key] = {'id': mid, 'state': s.state, 'missing': list(s.missing or ())}
    out['ready'] = all(v['state'] in ('cached', 'legacy') for v in (out['clap'], out['ast']))
    return out


def fetch_models():
    """download both models (once, ~1.1 GB) in a thread; progress in STATE['fetch']"""
    f = STATE['fetch']
    if f['running']:
        return
    f.update(running=True, done=False, error=None, log=['descargando modelos…'])

    def run():
        from .models import hub
        try:
            for key, mid in (('clap', config.CLAP_MODEL), ('ast', config.AST_MODEL)):
                f['log'].append(f'{key}: {mid}')
                hub.ensure(mid, config.CLAP_REVISION if key == 'clap' else config.AST_REVISION)
                f['log'].append(f'{key}: listo')
            f['done'] = True
        except Exception as e:  # noqa: BLE001
            f['error'] = f'{type(e).__name__}: {e}'
        finally:
            f['running'] = False
    threading.Thread(target=run, daemon=True).start()


def warm():
    """load both models now, in the background (the first call is then fast)"""
    def run():
        try:
            with LOCK:
                from .models import ast, clap
                clap.get()
                ast.get()
            STATE['loaded'] = {'clap': True, 'ast': True}
        except Exception as e:  # noqa: BLE001
            STATE['last_error'] = f'warm: {type(e).__name__}: {e}'
    threading.Thread(target=run, daemon=True).start()


def status():
    try:
        ms = models_status()
    except Exception as e:  # noqa: BLE001
        ms = {'error': f'{type(e).__name__}: {e}', 'ready': False}
    return {'ok': True, 'version': __version__, 'pid': os.getpid(), 'uptime_s': round(time.time() - STATE['started']),
            'busy': STATE['busy'], 'calls': STATE['calls'], 'loaded': STATE['loaded'], 'models': ms,
            'fetch': STATE['fetch'], 'last_error': STATE['last_error'], 'home': config.HOME,
            'threads': config.threads(), 'precision': config.PRECISION}


# ---------------------------------------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = 'sentidos-worker'

    def log_message(self, fmt, *args):   # quiet: the parent keeps stderr for real errors
        pass

    def _send(self, code, obj):
        raw = json.dumps(_clean(obj), ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n).decode('utf-8')) if n else {}

    def do_GET(self):
        if self.path.startswith('/health'):
            return self._send(200, {'ok': True, 'service': 'sentidos-worker', 'version': __version__})
        if self.path.startswith('/status'):
            return self._send(200, status())
        self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        try:
            body = self._body()
            if self.path == '/call':
                return self._send(200, call(str(body.get('tool') or ''), body.get('args') or {}))
            if self.path == '/fetch':
                fetch_models()
                return self._send(200, {'ok': True, 'fetch': STATE['fetch']})
            if self.path == '/warm':
                warm()
                return self._send(200, {'ok': True})
            if self.path == '/shutdown':
                self._send(200, {'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self._send(404, {'ok': False, 'error': 'not found'})
        except ToolFailure as e:
            self._send(200, {'ok': False, 'error': str(e)})
        except Exception as e:  # noqa: BLE001
            STATE['last_error'] = f'{type(e).__name__}: {e}'
            if os.environ.get('SENTIDOS_DEBUG'):
                traceback.print_exc()
            self._send(200, {'ok': False, 'error': f'{type(e).__name__}: {e}'})


def _alive(pid):
    """is process `pid` still there (a wait with zero timeout on Windows, signal 0 elsewhere: never touches the process)"""
    if os.name == 'nt':
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x00100000, False, int(pid))   # SYNCHRONIZE
        if not handle:
            return False
        try:
            return k32.WaitForSingleObject(handle, 0) == 0x102   # WAIT_TIMEOUT: still running
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(prog='sentidos.worker')
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--warm', action='store_true', help='load the models in the background at startup')
    ap.add_argument('--parent-pid', type=int, default=0,
                    help='exit when this process is gone: never leaves an orphan holding the models')
    args = ap.parse_args(argv)
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    sys.stdout.write(json.dumps({'sentidos_worker': {'port': srv.server_address[1], 'pid': os.getpid(),
                                                      'version': __version__}}) + '\n')
    sys.stdout.flush()
    if args.warm:
        warm()
    if args.parent_pid:
        def watch():
            while _alive(args.parent_pid):
                time.sleep(3)
            srv.shutdown()
        threading.Thread(target=watch, daemon=True).start()
    try:
        srv.serve_forever()
    finally:
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
