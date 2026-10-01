// SQLite kalıcılık katmanı (node:sqlite, harici bağımlılık yok).
// Tüm durum (agent'lar, odalar, mesajlar, görevler, dosya rezervasyonları, olaylar) burada tutulur.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'other',      -- claude-code | codex | hermes | human | other
  role          TEXT NOT NULL DEFAULT 'worker',     -- orchestrator | worker | observer | admin
  capabilities  TEXT NOT NULL DEFAULT '[]',         -- JSON dizi: ["typescript","research",...]
  machine       TEXT,
  token_hash    TEXT UNIQUE,
  revoked       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'offline',    -- idle | working | blocked | error | offline
  activity      TEXT,
  current_task  INTEGER,
  last_seen     INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  topic       TEXT,
  repo        TEXT,                                 -- odaya bağlı ortak GitHub reposu (opsiyonel)
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  agent       TEXT NOT NULL,
  room        TEXT NOT NULL,
  last_read   INTEGER NOT NULL DEFAULT 0,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (agent, room)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  sender      TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'chat',          -- chat | system | task | dm
  body        TEXT NOT NULL,
  mentions    TEXT NOT NULL DEFAULT '[]',
  recipient   TEXT,                                  -- dm ise alıcı
  thread_id   INTEGER,
  task_id     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room          TEXT NOT NULL,
  parent_id     INTEGER REFERENCES tasks(id),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',        -- open | claimed | in_progress | review | done | failed | cancelled
  priority      INTEGER NOT NULL DEFAULT 2,          -- 0 kritik .. 3 düşük
  capabilities  TEXT NOT NULL DEFAULT '[]',          -- gereken yetenekler
  depends_on    TEXT NOT NULL DEFAULT '[]',          -- JSON dizi: görev id'leri
  created_by    TEXT NOT NULL,
  assignee      TEXT,
  lease_until   INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  branch        TEXT,
  progress      TEXT,
  result        TEXT,
  artifacts     TEXT NOT NULL DEFAULT '[]',
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS reservations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  exclusive   INTEGER NOT NULL DEFAULT 1,
  reason      TEXT,
  task_id     INTEGER,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',          -- info | warn | error
  agent       TEXT,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_level ON events(level, id);

-- İstişareler: bir agent masadan görüş/oy ister (plan taslağı, tasarım kararı, başkan seçimi).
CREATE TABLE IF NOT EXISTS consults (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  asker       TEXT NOT NULL,                         -- 'system' = sunucunun açtığı başkan seçimi
  kind        TEXT NOT NULL DEFAULT 'opinion',       -- opinion | vote | election
  question    TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '[]',            -- vote/election seçenekleri
  invitees    TEXT NOT NULL DEFAULT '[]',            -- yanıt beklenen agent'lar
  status      TEXT NOT NULL DEFAULT 'open',          -- open | closed
  decision    TEXT,
  task_id     INTEGER,
  deadline    INTEGER NOT NULL,
  nudged      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_consults_room ON consults(room, status);

CREATE TABLE IF NOT EXISTS consult_replies (
  consult_id  INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  body        TEXT NOT NULL,
  choice      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (consult_id, agent)
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Eski veritabanlarına sonradan eklenen sütunları ekler. */
function migrate(db: DatabaseSync): void {
  const cols = (db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('closed_at')) db.exec('ALTER TABLE rooms ADD COLUMN closed_at INTEGER');
  if (!cols.includes('closed_by')) db.exec('ALTER TABLE rooms ADD COLUMN closed_by TEXT');
  // Başkan: birden çok orkestratör varsa planı yöneten seçilmiş orkestratör.
  if (!cols.includes('chair')) db.exec('ALTER TABLE rooms ADD COLUMN chair TEXT');
  if (!cols.includes('chair_since')) db.exec('ALTER TABLE rooms ADD COLUMN chair_since INTEGER');
  if (!cols.includes('chair_by')) db.exec('ALTER TABLE rooms ADD COLUMN chair_by TEXT'); // sole | election | transfer
}

export function now(): number {
  return Date.now();
}

/** JSON sütunlarını çözerek satırı düz nesneye çevirir. */
export function parseRow<T>(row: unknown, jsonCols: string[]): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const c of jsonCols) {
    if (typeof out[c] === 'string') {
      try {
        out[c] = JSON.parse(out[c] as string);
      } catch {
        /* bozuk JSON: olduğu gibi bırak */
      }
    }
  }
  return out as T;
}

/** Birden çok ifadeyi tek atomik işlemde çalıştırır. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
