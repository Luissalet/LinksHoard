"""Read one page with Camoufox (an anti-detection Firefox) and print what a reader sees as one JSON line.

Run by server/camoufox.js, never by hand: `python camoufox_read.py <request.json>`. The request is one JSON object in that file:

  { "url": "...", "profile": "<folder of the persistent profile>", "cookies": "<cookies.txt, Netscape format, or empty>",
    "script": "<JavaScript expression that returns null until the page is ready, else the post>", "wait_ms": 25000, "navigate_ms": 15000 }

The answer is one JSON line on stdout: { "ok": true, "value": <what the script returned or null>, "final_url": "...", "cookies": N }
or { "ok": false, "error": "..." }. The browser has no window (headless) and its profile persists, so the session it was given or
earned (cookies, local storage) is there the next time. Nothing is clicked, typed or posted: the page is opened and read.
"""
import json
import sys
import time


def netscape_cookies(path):
    """Cookies of a Netscape cookies.txt as Playwright cookie dicts (the ones that have not expired)."""
    out = []
    if not path:
        return out
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return out
    now = time.time()
    for raw in lines:
        http_only = raw.startswith("#HttpOnly_")
        line = raw[len("#HttpOnly_"):] if http_only else raw
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _flag, cpath, secure, expires, name, value = parts[:7]
        try:
            expiry = int(float(expires))
        except ValueError:
            expiry = 0
        if expiry and expiry < now:
            continue
        cookie = {"name": name, "value": value, "domain": domain, "path": cpath or "/", "secure": secure.upper() == "TRUE", "httpOnly": http_only}
        if expiry:
            cookie["expires"] = expiry
        out.append(cookie)
    return out


def main():
    try:
        with open(sys.argv[1], encoding="utf-8") as handle:
            req = json.load(handle)
    except (IndexError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": f"bad request: {exc}"}))
        return 2
    url = str(req.get("url") or "")
    if not url.startswith(("http://", "https://")):
        print(json.dumps({"ok": False, "error": "the url must be http(s)"}))
        return 2
    try:
        from camoufox.sync_api import Camoufox
    except ImportError as exc:
        print(json.dumps({"ok": False, "error": f"camoufox is not installed: {exc}", "missing": "camoufox"}))
        return 3
    wait_ms = int(req.get("wait_ms") or 25000)
    navigate_ms = int(req.get("navigate_ms") or 15000)
    script = str(req.get("script") or "null")
    try:
        with Camoufox(headless=True, persistent_context=True, user_data_dir=str(req.get("profile") or ""), humanize=False, i_know_what_im_doing=True,
                      main_world_eval=True) as context:
            seeded = netscape_cookies(req.get("cookies") or "")
            if seeded:
                try:
                    context.add_cookies(seeded)
                except Exception:  # a cookie the browser refuses must not stop the read
                    for cookie in seeded:
                        try:
                            context.add_cookies([cookie])
                        except Exception:
                            pass
            page = context.pages[0] if context.pages else context.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=navigate_ms)
            except Exception:
                pass  # a page that keeps loading is still read while it loads
            value = None
            deadline = time.time() + wait_ms / 1000.0
            while time.time() < deadline:
                time.sleep(0.7)
                try:
                    value = page.evaluate(script)
                except Exception:
                    value = None
                if value:
                    break
            print(json.dumps({"ok": True, "value": value, "final_url": page.url, "cookies": len(context.cookies())}))
        return 0
    except Exception as exc:  # the browser could not start or crashed
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:400]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
