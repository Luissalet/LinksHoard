"""sentidos: the listening module of Links Hoard (describe, match, find, time-align and measure sound files).

Derived from earshot (https://github.com/Leonxlnx/earshot, MIT, (c) 2026 Leon Lin) at version 0.4.0: the listening
core (audio I/O, CLAP and AudioSet models, calibrated vocabulary, find, timeline, sheet, realness, measurements) kept
as a detached copy that evolves with Links Hoard's own names, worker and tools. The licence and the attribution are in
LICENSE.earshot and NOTICE.

Python API (models load lazily on first use and stay warm in a process):

    import sentidos
    sentidos.describe('whoosh.wav')
    sentidos.match('key.ogg', 'a deep thocky mechanical keyboard press', alts=['a clicky blue switch'])
    sentidos.find('typing.ogg', 'a single isolated key press')
    sentidos.timeline('soundtrack.wav', video='film.mp4')
"""
import importlib

__version__ = '0.4.0-links.1'

# modules that are callable as their main function (see _callable.py)
_CALLABLE = {'describe', 'match', 'realness', 'timeline', 'sheet'}
# functions whose name is not a module name
_FUNCS = {'rank': ('search', 'rank'), 'find': ('search', 'find'), 'measure': ('features', 'measure')}


def __getattr__(name):
    if name in _CALLABLE:
        return importlib.import_module(f'sentidos.{name}')
    if name in _FUNCS:
        mod, fn = _FUNCS[name]
        return getattr(importlib.import_module(f'sentidos.{mod}'), fn)
    raise AttributeError(name)  # anything else: normal submodule import
