import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,          -- p.ej. A202047813-8806097827146
  url             TEXT NOT NULL,
  name            TEXT,
  image           TEXT,
  created_at      TEXT NOT NULL,
  last_checked_at TEXT,
  last_error      TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0
);

-- Un precio por producto y día (día en la zona horaria configurada).
CREATE TABLE IF NOT EXISTS prices (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,                  -- YYYY-MM-DD
  price      REAL NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (product_id, day)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,           -- para darse de baja
  created_at TEXT NOT NULL,
  UNIQUE (product_id, email)
);

CREATE TABLE IF NOT EXISTS email_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  text       TEXT NOT NULL,
  html       TEXT NOT NULL,
  unsub_url  TEXT,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status, id);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Fecha YYYY-MM-DD en la zona horaria dada. */
export function today(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
