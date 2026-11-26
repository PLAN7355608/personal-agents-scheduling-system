// SQLite 账本：连接、迁移、事务。
// 驱动用 Node 内置 node:sqlite（DSH 运行时 Node 24，已实测可用，含 FTS5）。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_VERSION } from './types.js'

const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  ts             INTEGER NOT NULL,
  owner_id       TEXT NOT NULL DEFAULT 'owner',
  type           TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  workitem_id    TEXT,
  session_id     TEXT,
  channel        TEXT,
  actor          TEXT NOT NULL,
  payload        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_workitem ON events(workitem_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type_ts  ON events(type, ts);

CREATE TABLE IF NOT EXISTS workitems (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  owner_id       TEXT NOT NULL DEFAULT 'owner',
  source_channel TEXT NOT NULL,
  source_peer    TEXT NOT NULL,
  source_msg_id  TEXT,
  kind           TEXT NOT NULL,
  intent         TEXT,
  topic          TEXT,
  status         TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 50,
  needs_human    INTEGER NOT NULL DEFAULT 0,
  deadline       INTEGER,
  budget         TEXT,
  parent_id      TEXT,
  worker_type    TEXT,
  result         TEXT,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  metrics        TEXT
);
CREATE INDEX IF NOT EXISTS idx_wi_status ON workitems(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_wi_parent ON workitems(parent_id);
CREATE INDEX IF NOT EXISTS idx_wi_owner  ON workitems(owner_id, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_msg
  ON workitems(owner_id, source_channel, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL DEFAULT 'owner',
  channel         TEXT NOT NULL,
  peer            TEXT NOT NULL,
  relay_session   TEXT,
  rolling_summary TEXT,
  last_active_at  INTEGER NOT NULL,
  UNIQUE(owner_id, channel, peer)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT,
  workitem_id TEXT,
  role        TEXT NOT NULL,
  preset      TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_wi ON sessions(workitem_id);

CREATE TABLE IF NOT EXISTS item_members (
  workitem_id TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  PRIMARY KEY (workitem_id, event_id)
);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL DEFAULT 'owner',
  type          TEXT NOT NULL,
  key           TEXT,
  text          TEXT NOT NULL,
  tags          TEXT DEFAULT '',
  source_event  TEXT,
  source_wi     TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0,
  valid_from    INTEGER NOT NULL,
  valid_to      INTEGER,
  superseded_by TEXT,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type, deleted_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tags, content='memories', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  workitem_id TEXT NOT NULL,
  path        TEXT NOT NULL,
  kind        TEXT,
  size        INTEGER,
  sha256      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_calls (
  id          TEXT PRIMARY KEY,
  workitem_id TEXT,
  kind        TEXT NOT NULL,
  schema_ver  INTEGER NOT NULL,
  input_hash  TEXT NOT NULL,
  output      TEXT NOT NULL,
  source      TEXT NOT NULL,
  latency_ms  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL DEFAULT 'owner',
  workitem_id  TEXT,
  action       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  answered_at  INTEGER
);

CREATE TABLE IF NOT EXISTS channel_health (
  channel    TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT,
  checked_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
`,
  },
  {
    version: 18,
    sql: `
CREATE TABLE IF NOT EXISTS cost_usage (
  workitem_id  TEXT PRIMARY KEY,
  session_id   TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_write  INTEGER NOT NULL DEFAULT 0,
  cost_cny     REAL NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
`,
  },
  {
    version: 17,
    sql: `
CREATE TABLE IF NOT EXISTS revisions (
  id          TEXT PRIMARY KEY,
  workitem_id TEXT NOT NULL,
  path        TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  source      TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_item ON revisions(workitem_id, created_at);
`,
  },
  {
    version: 16,
    sql: `
ALTER TABLE workitems ADD COLUMN source_session_id TEXT;
ALTER TABLE workitems ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 15,
    sql: `
ALTER TABLE events ADD COLUMN peer TEXT;
`,
  },
  {
    version: 14,
    sql: `
ALTER TABLE workitems ADD COLUMN model TEXT;
`,
  },
  {
    version: 13,
    sql: `
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 12,
    sql: `
ALTER TABLE workitems ADD COLUMN origin TEXT;
`,
  },
  {
    version: 11,
    sql: `
ALTER TABLE workitems ADD COLUMN workspace TEXT;
ALTER TABLE lanes ADD COLUMN workspace TEXT;
`,
  },
  {
    version: 10,
    sql: `
CREATE TABLE IF NOT EXISTS tool_requests (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  lane_id       TEXT,
  workitem_id   TEXT,
  session_id    TEXT,
  tool          TEXT NOT NULL,
  reason        TEXT,
  want_scope    TEXT NOT NULL DEFAULT 'once',
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_by    TEXT,
  decided_at    INTEGER,
  scope_granted TEXT,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_requests_status ON tool_requests(status);
ALTER TABLE lanes ADD COLUMN extra_tools TEXT;
`,
  },
  {
    version: 9,
    sql: `
CREATE TABLE IF NOT EXISTS lanes (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  key                TEXT NOT NULL,
  label              TEXT,
  scope_mode         TEXT NOT NULL DEFAULT 'suggest',
  project_root       TEXT,
  scope              TEXT,
  session_id         TEXT,
  worker_type        TEXT,
  status             TEXT NOT NULL DEFAULT 'idle',
  current_workitem_id TEXT,
  permission         TEXT,
  last_used_at       INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  meta               TEXT,
  UNIQUE(owner_id, key)
);
ALTER TABLE workitems ADD COLUMN lane_id TEXT;
ALTER TABLE workitems ADD COLUMN project_root TEXT;
ALTER TABLE workitems ADD COLUMN scope TEXT;
ALTER TABLE workitems ADD COLUMN scope_source TEXT;
ALTER TABLE workitems ADD COLUMN scope_confidence REAL;
CREATE INDEX IF NOT EXISTS idx_workitems_lane_status ON workitems(lane_id, status);
`,
  },
  {
    version: 8,
    sql: `
ALTER TABLE workitems ADD COLUMN permission TEXT;
`,
  },
  {
    version: 7,
    sql: `
ALTER TABLE workitems ADD COLUMN inputs TEXT;
`,
  },
  {
    version: 6,
    sql: `
ALTER TABLE workitems ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wi_session ON workitems(session_id);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS persona_overrides (
  owner_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key)
);
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE IF NOT EXISTS channel_policies (
  channel        TEXT PRIMARY KEY,
  mode           TEXT NOT NULL DEFAULT 'direct',
  enabled        INTEGER NOT NULL DEFAULT 1,
  max_chars      INTEGER NOT NULL DEFAULT 1500,
  allow_files    INTEGER NOT NULL DEFAULT 1,
  allow_groups   INTEGER NOT NULL DEFAULT 0,
  rate_per_min   INTEGER NOT NULL DEFAULT 30,
  quiet_hours    TEXT,
  allowed_peers  TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  channel     TEXT NOT NULL,
  peer        TEXT NOT NULL,
  thread_id   TEXT,
  workitem_id TEXT,
  content     TEXT NOT NULL,
  files       TEXT NOT NULL DEFAULT '[]',
  level       TEXT NOT NULL DEFAULT 'L2',
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, seq);
INSERT OR IGNORE INTO channel_policies
  (channel, mode, enabled, max_chars, allow_files, allow_groups, rate_per_min, allowed_peers, updated_at)
VALUES ('mock', 'direct', 1, 1500, 1, 0, 30, '["tester"]', (strftime('%s','now') * 1000));
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS merge_members (
  merged_workitem_id TEXT NOT NULL,
  member_workitem_id TEXT NOT NULL,
  member_text       TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (merged_workitem_id, member_workitem_id)
);
`,
  },
]

export function getSchemaVersion(db) {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()
  return row ? Number(row.value) : 0
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  let current = getSchemaVersion(db)
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schemaVersion', ?)").run(String(m.version))
      db.exec('COMMIT')
      current = m.version
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  if (current !== SCHEMA_VERSION) {
    throw new Error(`schema 版本不匹配：库=${current} 代码=${SCHEMA_VERSION}（只加不删，按迁移处理）`)
  }
  return current
}

export function openDb({ path = ':memory:' } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA synchronous = NORMAL;')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  migrate(db)
  return db
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
}
