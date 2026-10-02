// A stand-in for the Hoard Link hub: the events this app posts and the tool calls it proxies to other apps.
import http from "node:http";

export async function startFakeHub() {
  const state = {
    events: [],     // posted to /api/events: { type, source, data }
    calls: [],      // proxy calls: { app, tool, arguments }
    tools: {},      // "app.tool" -> (arguments) => result, or { __error: { status, error } }
    emitStatus: 200,
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://hub");
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const send = (status, payload) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (req.method === "POST" && url.pathname === "/api/events") {
        if (state.emitStatus !== 200) return send(state.emitStatus, { error: "nope" });
        state.events.push(body);
        return send(200, { ok: true });
      }
      const proxy = url.pathname.match(/^\/api\/apps\/([^/]+)\/call$/);
      if (req.method === "POST" && proxy) {
        const fn = state.tools[`${proxy[1]}.${body.tool}`];
        if (!fn) return send(404, { ok: false, app: proxy[1], tool: body.tool, status: 404, error: "unknown tool" });
        state.calls.push({ app: proxy[1], tool: body.tool, arguments: body.arguments });
        const result = fn(body.arguments);
        if (result && result.__error) return send(200, { ok: false, app: proxy[1], tool: body.tool, status: result.__error.status, error: result.__error.error });
        return send(200, { ok: true, app: proxy[1], tool: body.tool, status: 200, result });
      }
      return send(404, { error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state,
    stop: () => new Promise((resolve) => server.close(resolve)),
    ofType: (type) => state.events.filter((e) => e.type === type),
  };
}

export const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
};
