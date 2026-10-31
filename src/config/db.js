const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const logger = require("../utils/logger");

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "..", "data", "gpa.db");

let db;

function getDb() {
  if (!db) connectDB();
  return db;
}

function connectDB() {
  if (db) return db;
  // Ensure data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Schema ───────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      email                    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password                 TEXT,
      name                     TEXT,
      role                     TEXT    NOT NULL DEFAULT 'user',
      github_id                TEXT    UNIQUE,
      github_login             TEXT,
      avatar_url               TEXT,
      github_access_token      TEXT,
      email_verified           INTEGER NOT NULL DEFAULT 0,
      email_verification_token TEXT,
      password_reset_token     TEXT,
      password_reset_expires   INTEGER,
      failed_login_attempts    INTEGER NOT NULL DEFAULT 0,
      locked_until             INTEGER,
      weekly_digest            INTEGER NOT NULL DEFAULT 0,
      last_login_at            INTEGER,
      created_at               INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at               INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT    NOT NULL UNIQUE,
      expires_at  INTEGER NOT NULL,
      revoked_at  INTEGER,
      user_agent  TEXT,
      ip          TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_hash TEXT    NOT NULL UNIQUE,
      ip                 TEXT,
      user_agent         TEXT,
      device             TEXT,
      last_seen_at       INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      revoked_at         INTEGER,
      expires_at         INTEGER NOT NULL,
      suspicious         INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS history_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username   TEXT    NOT NULL,
      score      REAL,
      rank       TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS leaderboard (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL UNIQUE,
      avatar_url TEXT,
      score      REAL    NOT NULL DEFAULT 0,
      rank       TEXT    NOT NULL DEFAULT 'D',
      languages  TEXT    NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username   TEXT    NOT NULL,
      profile    TEXT    NOT NULL,
      stats      TEXT    NOT NULL,
      score      TEXT    NOT NULL,
      ai         TEXT,
      public     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS resume_analyses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      filename        TEXT,
      text            TEXT,
      skills          TEXT    NOT NULL DEFAULT '[]',
      ats_score       REAL    NOT NULL DEFAULT 0,
      issues          TEXT    NOT NULL DEFAULT '[]',
      suggestions     TEXT    NOT NULL DEFAULT '[]',
      github_username TEXT,
      match_score     REAL    NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action     TEXT    NOT NULL,
      resource   TEXT,
      ip         TEXT,
      user_agent TEXT,
      metadata   TEXT,
      status     TEXT    NOT NULL DEFAULT 'success',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_history_user    ON history_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_leaderboard_score ON leaderboard(score DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_user    ON reports(user_id);
    CREATE INDEX IF NOT EXISTS idx_rt_user         ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_rt_hash         ON refresh_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_audit_user      ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp    ON sessions(expires_at);
  `);

  logger.info(`✅ SQLite connected: ${DB_PATH}`);
}

module.exports = connectDB;
module.exports.getDb = getDb;
