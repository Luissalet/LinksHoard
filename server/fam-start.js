// Start the family app that owns a service through the Hub, and wait until that service answers.
//
// A service of the family (speech to text, OCR, voice, embeddings) is owned by an app, and an app can be absorbed by another:
// Funes lives inside Talos's Hoard, so asking the Hub to start "funes" answers "the manifest has no process launch hint" and
// nothing happens. This module asks the Hub who owns the app, starts that one, and polls the service until it is there or the
// wait runs out. Nothing here throws: a failure is { ok: false, error } with the reason, so the caller can say it plainly.
import fs from "node:fs";
import { status as familyStatus } from "./hoard-link.js";
import { serviceAvailable, forgetAvailability } from "./hoard-commons/fam-services.js";

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function tokenOf(st) {
  try { return fs.readFileSync(st.tokenFile, "utf8").replace(/^\uFEFF/, "").trim(); } catch { return ""; }
}

async function hubJson(hub, path, { method = "GET", body = null, timeoutMs = 10_000 } = {}) {
  const st = familyStatus();
  const headers = { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) };
  const token = tokenOf(st);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${hub}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** The app that actually runs `appId`: itself, or the one that absorbed it (Funes → Talos). { id, absorbed, launchable, stopped_by_hand }. */
export async function ownerOf(appId, { hub = null } = {}) {
  const base = hub || familyStatus().hub;
  if (!base) return { id: appId, absorbed: null, launchable: null, error: "hub unreachable" };
  try {
    const { status, data } = await hubJson(base, `/api/apps/${encodeURIComponent(appId)}`);
    if (status !== 200 || !data) return { id: appId, absorbed: null, launchable: null, error: `hub answered ${status}` };
    const absorbed = data.family?.absorbed_by?.id || null;
    let stoppedByHand = !!data.manually_stopped;
    if (absorbed) {
      // an absorbed identity answers for itself; whether it can be started depends on the app that owns it
      const owner = await hubJson(base, `/api/apps/${encodeURIComponent(absorbed)}`).catch(() => null);
      if (owner?.status === 200 && owner.data) stoppedByHand = !!owner.data.manually_stopped;
    }
    return { id: absorbed || appId, absorbed, launchable: data.launchable !== false, stopped_by_hand: stoppedByHand, error: "" };
  } catch (e) {
    // the Hub did not answer at all (a refused connection, a timeout)
    return { id: appId, absorbed: null, launchable: null, error: "hub unreachable", detail: String(e?.message || e) };
  }
}

/** Ask the Hub to start an app (the one that owns it when it was absorbed). { ok, started, error }. */
export async function startFamilyApp(appId, { hub = null, timeoutMs = 20_000 } = {}) {
  const base = hub || familyStatus().hub;
  if (!base) return { ok: false, started: null, error: "hub unreachable" };
  const owner = await ownerOf(appId, { hub: base });
  if (owner.error === "hub unreachable") return { ok: false, started: null, absorbed: null, error: "hub unreachable" };
  // A stop the person asked for in the Hub stays: starting the app again is theirs to do there.
  if (owner.stopped_by_hand) return { ok: false, started: owner.id, absorbed: owner.absorbed, error: `${owner.id} está parado a mano en el Hub: arráncalo allí`, stopped_by_hand: true };
  try {
    const { status, data } = await hubJson(base, `/api/apps/${encodeURIComponent(owner.id)}/start`, { method: "POST", body: {}, timeoutMs });
    if (status === 200 && data?.ok !== false) return { ok: true, started: owner.id, absorbed: owner.absorbed, error: "" };
    return { ok: false, started: owner.id, absorbed: owner.absorbed, error: String(data?.error || `hub answered ${status}`) };
  } catch (e) {
    return { ok: false, started: owner.id, absorbed: owner.absorbed, error: "hub unreachable", detail: String(e?.message || e) };
  }
}

/** True when the service answers; when it does not, the app that owns it is started through the Hub and the service is polled
 *  until it answers or waitS runs out. { ok, started, waited_s, error }. */
export async function ensureService(service, appId, { waitS = 60, signal, hub = null, pollMs = 3000 } = {}) {
  if (await serviceAvailable(service)) return { ok: true, started: null, waited_s: 0, error: "" };
  const started = await startFamilyApp(appId, { hub });
  const t0 = Date.now();
  // when the Hub would not start it (it is down, or the app was stopped by hand) a short wait is enough: it may have been starting already
  const patience = started.ok ? waitS : started.error === "hub unreachable" ? 0 : Math.min(waitS, 6);
  for (let waited = 0; waited < patience * 1000; waited += pollMs) {
    if (signal?.aborted) return { ok: false, started: started.started, waited_s: Math.round(waited / 1000), error: "aborted" };
    await sleep(pollMs);
    forgetAvailability();
    if (await serviceAvailable(service)) return { ok: true, started: started.started, waited_s: Math.round((Date.now() - t0) / 1000), error: "" };
  }
  const why = started.ok
    ? `se pidió arrancar ${started.started} al Hub y no respondió en ${waitS} s`
    : `no se pudo arrancar ${started.started || appId} por el Hub (${started.error})`;
  return { ok: false, started: started.started, waited_s: Math.round((Date.now() - t0) / 1000), error: why };
}