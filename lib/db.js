import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = process.env.DB_DIR || path.join(__dirname, '..', 'db');
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'schedule.db');

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ig_user_id TEXT,
    ig_username TEXT,
    page_id TEXT,
    page_name TEXT,
    token_type TEXT DEFAULT 'fb',
    access_token_enc TEXT,
    token_refreshed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    media_paths TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    ig_media_id TEXT,
    permalink TEXT,
    error TEXT,
    share_to_feed INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    posted_at INTEGER,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pending ON posts(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_client ON posts(client_id);

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    source TEXT NOT NULL,
    action TEXT,
    client_id INTEGER,
    post_id INTEGER,
    actor TEXT,
    message TEXT,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_client ON logs(client_id, ts DESC);
`);

// migration: add token_type column to existing tables
try {
  db.exec("ALTER TABLE clients ADD COLUMN token_type TEXT DEFAULT 'fb'");
} catch { /* already exists */ }
try {
  db.exec("ALTER TABLE posts ADD COLUMN retry_count INTEGER DEFAULT 0");
} catch { /* already exists */ }

// ─── clients ───
export const insertClient = ({ name, notes }) =>
  db.prepare('INSERT INTO clients (name, notes, created_at) VALUES (?, ?, ?)')
    .run(name, notes || '', Date.now()).lastInsertRowid;

export const listClients = () =>
  db.prepare(`SELECT id, name, ig_username, ig_user_id, page_name, status, token_refreshed_at, notes
              FROM clients ORDER BY created_at DESC`).all();

export const getClient = (id) =>
  db.prepare('SELECT * FROM clients WHERE id = ?').get(id);

export const updateClient = (id, fields) => {
  const allowed = ['name', 'ig_user_id', 'ig_username', 'page_id', 'page_name',
                   'token_type', 'access_token_enc', 'token_refreshed_at', 'status', 'notes'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE clients SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), id);
};

export const deleteClient = (id) =>
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);

// ─── posts ───
export const insertPost = ({ clientId, type, caption, mediaPaths, scheduledAt, shareToFeed = 1 }) =>
  db.prepare(`INSERT INTO posts (client_id, type, caption, media_paths, scheduled_at, share_to_feed, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(clientId, type, caption, JSON.stringify(mediaPaths), scheduledAt, shareToFeed, Date.now()).lastInsertRowid;

const hydrate = (r) => r ? { ...r, media_paths: JSON.parse(r.media_paths) } : null;

export const listPosts = ({ clientId = null, status = null } = {}) => {
  const where = [];
  const args = [];
  if (clientId) { where.push('p.client_id = ?'); args.push(clientId); }
  if (status)   { where.push('p.status = ?');    args.push(status); }
  const sql = `SELECT p.*, c.name AS client_name, c.ig_username
               FROM posts p LEFT JOIN clients c ON c.id = p.client_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY p.scheduled_at DESC`;
  return db.prepare(sql).all(...args).map(hydrate);
};

export const getPost = (id) => hydrate(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));

export const getDuePosts = () =>
  db.prepare(`SELECT * FROM posts
              WHERE status = 'pending' AND scheduled_at <= ?
              ORDER BY scheduled_at ASC`).all(Date.now()).map(hydrate);

export const updatePostStatus = (id, fields) => {
  const allowed = ['status', 'ig_media_id', 'permalink', 'error', 'posted_at'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const sql = `UPDATE posts SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...updates.map(([, v]) => v), id);
};

export const deletePost = (id) =>
  db.prepare('DELETE FROM posts WHERE id = ? AND status = ?').run(id, 'pending');

// ─── sessions ───
export const insertSession = (id, user, expiresAt) =>
  db.prepare('INSERT INTO sessions (id, user, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, user, Date.now(), expiresAt);

export const getSession = (id) =>
  db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, Date.now());

export const deleteSession = (id) =>
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

export const purgeExpiredSessions = () =>
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// ─── logs ───
export const insertLog = ({ level = 'info', source, action, clientId, postId, actor, message, metadata }) => {
  db.prepare(`INSERT INTO logs (ts, level, source, action, client_id, post_id, actor, message, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Date.now(), level, source, action || null, clientId || null, postId || null,
    actor || null, message || null, metadata ? JSON.stringify(metadata) : null,
  );
};

export const listLogs = ({ level = null, source = null, clientId = null, limit = 200, sinceTs = null } = {}) => {
  const where = [];
  const args = [];
  if (level)    { where.push('level = ?');     args.push(level); }
  if (source)   { where.push('source = ?');    args.push(source); }
  if (clientId) { where.push('client_id = ?'); args.push(clientId); }
  if (sinceTs)  { where.push('ts > ?');        args.push(sinceTs); }
  const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ts DESC LIMIT ?`;
  args.push(Math.min(limit, 1000));
  return db.prepare(sql).all(...args).map(r => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  }));
};

export const purgeOldLogs = (olderThanDays = 30) =>
  db.prepare('DELETE FROM logs WHERE ts < ?').run(Date.now() - olderThanDays * 86400000);

// atomic claim: 把待發 → 發送中（避免兩個 worker 撞）
export const claimPost = (id) => {
  const r = db.prepare(`UPDATE posts SET status='publishing' WHERE id=? AND status='pending'`).run(id);
  return r.changes === 1;
};

export const incrementRetry = (id) =>
  db.prepare('UPDATE posts SET retry_count = retry_count + 1 WHERE id = ?').run(id);

// 已發布 N 天以上的貼文，回傳尚在 uploads 的檔名（給 cleanup 用）
export const getOldPostedMediaPaths = (olderThanDays = 7) => {
  const rows = db.prepare(`
    SELECT media_paths FROM posts
    WHERE status = 'posted' AND posted_at < ?
  `).all(Date.now() - olderThanDays * 86400000);
  const paths = new Set();
  for (const r of rows) {
    for (const p of JSON.parse(r.media_paths)) {
      if (p.startsWith('/media/')) paths.add(p.slice('/media/'.length));
    }
  }
  return Array.from(paths);
};

// 哪些上傳檔案還在被未發送或最近已發送的貼文引用
export const getActiveMediaFilenames = () => {
  const rows = db.prepare(`SELECT media_paths FROM posts WHERE status IN ('pending','publishing','failed')
                           OR (status='posted' AND posted_at >= ?)`).all(Date.now() - 7 * 86400000);
  const set = new Set();
  for (const r of rows) {
    for (const p of JSON.parse(r.media_paths)) {
      if (p.startsWith('/media/')) set.add(p.slice('/media/'.length));
    }
  }
  return set;
};
