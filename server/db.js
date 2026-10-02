// Single SQLite connection (node:sqlite, WAL, busy_timeout) with ordered migrations: the opening, the migration runner and the
// transactions are the shared openDatabase of hoard-commons/server.js; the schema (MIGRATIONS) is Links'.
// Only the HTTP server process opens the database; the MCP bridge proxies.
import path from "node:path";
import crypto from "node:crypto";
import { openDatabase } from "./hoard-commons/server.js";
import { normalizeUrl, siteOf } from "./url.js";

export const DB_FILE = "links-hoard.db";

const MIGRATIONS = [
  `
  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    url_original TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    content_text TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    byline TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT '',
    word_count INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'other',
    saved_at TEXT NOT NULL,
    read_at TEXT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    fetch_status TEXT NOT NULL DEFAULT 'pending',
    fetch_error TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NULL
  );
  CREATE INDEX links_saved_at ON links(saved_at);
  CREATE INDEX links_site ON links(site);
  CREATE INDEX links_archived ON links(archived);
  CREATE INDEX links_favorite ON links(favorite);
  CREATE TABLE highlights (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX highlights_link ON highlights(link_id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: watches — feeds, GitHub repositories and pages checked on a schedule (see watches.js)
  `
  CREATE TABLE watches (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    source_url TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    every_min INTEGER NOT NULL DEFAULT 60,
    tags TEXT NOT NULL DEFAULT '[]',
    auto_save INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_check_at TEXT NULL,
    last_ok_at TEXT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    last_hash TEXT NOT NULL DEFAULT '',
    last_text TEXT NOT NULL DEFAULT '',
    item_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE watch_items (
    id TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    published_at TEXT NULL,
    seen_at TEXT NOT NULL,
    link_id TEXT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(watch_id, guid)
  );
  CREATE INDEX watch_items_seen ON watch_items(seen_at);
  CREATE INDEX watch_items_watch ON watch_items(watch_id, seen_at);
  `,
  // 3: media downloads — video, audio and photos pulled to disk with yt-dlp / gallery-dl (see media.js)
  `
  CREATE TABLE media_downloads (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'auto',
    quality TEXT NOT NULL DEFAULT 'best',
    kind TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    speed TEXT NOT NULL DEFAULT '',
    eta TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    uploader TEXT NOT NULL DEFAULT '',
    upload_date TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    duration REAL NULL,
    dir TEXT NOT NULL DEFAULT '',
    files TEXT NOT NULL DEFAULT '[]',
    total_bytes INTEGER NOT NULL DEFAULT 0,
    save_link INTEGER NOT NULL DEFAULT 1,
    playlist INTEGER NOT NULL DEFAULT 0,
    max_items INTEGER NOT NULL DEFAULT 50,
    link_id TEXT NULL,
    error TEXT NOT NULL DEFAULT '',
    cookies_request TEXT NOT NULL DEFAULT '',
    cookies_browser TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT NULL,
    finished_at TEXT NULL
  );
  CREATE INDEX media_downloads_created ON media_downloads(created_at);
  CREATE INDEX media_downloads_status ON media_downloads(status);
  `,
  // 4: which highlights already became Hypatia cards, and when a link was last put in front of the user ("Para leer hoy")
  `
  ALTER TABLE highlights ADD COLUMN card_sent_at TEXT NULL;
  ALTER TABLE highlights ADD COLUMN card_deck TEXT NOT NULL DEFAULT '';
  ALTER TABLE links ADD COLUMN resurfaced_at TEXT NULL;
  `,
  // 5: what the family's media service asks for besides the URL: sections to cut (JSON [[start_s, end_s]]), a duration limit, a height cap
  // and the "audio for speech to text" flag (the file is a mono 16 kHz WAV), so a retry or a restart repeats the same request
  `
  ALTER TABLE media_downloads ADD COLUMN sections TEXT NOT NULL DEFAULT '';
  ALTER TABLE media_downloads ADD COLUMN max_duration_s INTEGER NULL;
  ALTER TABLE media_downloads ADD COLUMN max_height INTEGER NULL;
  ALTER TABLE media_downloads ADD COLUMN asr INTEGER NOT NULL DEFAULT 0;
  `,
  // 6: validators of a page watch, so an unchanged page answers 304 instead of being downloaded again
  `
  ALTER TABLE watches ADD COLUMN last_etag TEXT NOT NULL DEFAULT '';
  ALTER TABLE watches ADD COLUMN last_modified TEXT NOT NULL DEFAULT '';
  `,
  // 7: the shared URL rules and the shared page comparison. Saved links are re-keyed with the shared normalizeUrl (from the URL as it was
  // saved; a key already taken by another link is left alone), and a watch that was compared with the old text extractor starts over
  // silently: its first check afterwards is a new baseline, not a "change".
  (raw) => {
    raw.exec("ALTER TABLE watches ADD COLUMN check_engine INTEGER NOT NULL DEFAULT 0");
    const rows = raw.prepare("SELECT id, url, url_original FROM links").all();
    const taken = new Set(rows.map((r) => r.url));
    const update = raw.prepare("UPDATE links SET url = ?, site = ? WHERE id = ?");
    for (const r of rows) {
      const next = normalizeUrl(r.url_original) || normalizeUrl(r.url);
      if (!next || next === r.url || taken.has(next)) continue;
      taken.delete(r.url);
      taken.add(next);
      update.run(next, siteOf(next), r.id);
    }
  },
];

// FTS5 is attempted at init(); if the runtime's SQLite build lacks it we fall
// back to LIKE search and flag it in module state (surfaced at /api/state).
let ftsAvailable = false;

function tryCreateFts(conn) {
  try {
    conn.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(title, description, content_text, notes, tags, link_id UNINDEXED)",
    );
    ftsAvailable = true;
  } catch {
    ftsAvailable = false;
  }
}

export function ftsEnabled() {
  return ftsAvailable;
}

let handle = null;
let connection = null;
let dataDirectory = null;

export function init(dataDir) {
  if (connection) return connection;
  handle = openDatabase(path.join(dataDir, DB_FILE), { migrations: MIGRATIONS });
  dataDirectory = dataDir;
  connection = handle.raw;
  tryCreateFts(connection);
  return connection;
}

export function db() {
  if (!connection) throw new Error("Database not initialised. Call init(dataDir) first.");
  return connection;
}

/** True once init(dataDir) has run and close() has not. Background jobs (the
 * fetch queue) check this before writing, since a job can still be in flight
 * when the app is shutting down. */
export function isOpen() {
  return connection !== null;
}

export function dataDir() {
  return dataDirectory;
}

export function close() {
  if (handle) handle.close(); // checkpoints the WAL
  handle = null;
  connection = null;
  dataDirectory = null;
  ftsAvailable = false;
}

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

/** Run fn (synchronous) inside a transaction; nested calls become savepoints. */
export function transaction(fn) {
  db();
  return handle.tx(fn);
}

export function getSetting(key, fallback = null) {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
  return value;
}
