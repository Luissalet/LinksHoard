// Single SQLite connection (node:sqlite, WAL) with ordered migrations.
// Only the HTTP server process opens the database; the MCP bridge proxies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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

let connection = null;
let dataDirectory = null;

export function init(dataDir) {
  if (connection) return connection;
  fs.mkdirSync(dataDir, { recursive: true });
  dataDirectory = dataDir;
  connection = new DatabaseSync(path.join(dataDir, DB_FILE));
  connection.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(connection);
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
  if (connection) connection.close();
  connection = null;
  dataDirectory = null;
  ftsAvailable = false;
}

function migrate(conn) {
  conn.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = conn.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  const current = row?.v || 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    conn.exec("BEGIN");
    try {
      conn.exec(MIGRATIONS[i]);
      conn.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(i + 1, now());
      conn.exec("COMMIT");
    } catch (error) {
      conn.exec("ROLLBACK");
      throw error;
    }
  }
}

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

/** Run fn inside a transaction; nested calls reuse the outer one. */
let depth = 0;
export function transaction(fn) {
  const conn = db();
  if (depth > 0) return fn();
  conn.exec("BEGIN");
  depth++;
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  } finally {
    depth--;
  }
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
