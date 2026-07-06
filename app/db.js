import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || "./data/coursecraft.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    license_key TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS usage (
    user_id INTEGER NOT NULL REFERENCES users(id),
    month TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_microusd INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
  );
`);

export function upsertUser(email, { licenseKey = null, status = "active" } = {}) {
  db.prepare(
    `INSERT INTO users (email, license_key, status) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       license_key = COALESCE(excluded.license_key, users.license_key),
       status = excluded.status`,
  ).run(email.toLowerCase(), licenseKey, status);
  return getUserByEmail(email);
}

export function getUserByEmail(email) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase());
}

export function setUserStatus(email, status) {
  db.prepare(`UPDATE users SET status = ? WHERE email = ?`).run(status, email.toLowerCase());
}

export function createSession(token, userId) {
  db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`).run(token, userId);
}

export function getSession(token) {
  // Sessions expire after 30 days
  return db
    .prepare(
      `SELECT s.token, s.user_id, u.email, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', '-30 days')`,
    )
    .get(token);
}

export function deleteSession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // "2026-07"
}

export function getMonthlyUsage(userId) {
  return (
    db
      .prepare(`SELECT * FROM usage WHERE user_id = ? AND month = ?`)
      .get(userId, currentMonth()) || {
      input_tokens: 0,
      output_tokens: 0,
      cost_microusd: 0,
    }
  );
}

export function addUsage(userId, inputTokens, outputTokens, costMicroUsd) {
  db.prepare(
    `INSERT INTO usage (user_id, month, input_tokens, output_tokens, cost_microusd)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       input_tokens = usage.input_tokens + excluded.input_tokens,
       output_tokens = usage.output_tokens + excluded.output_tokens,
       cost_microusd = usage.cost_microusd + excluded.cost_microusd`,
  ).run(userId, currentMonth(), inputTokens, outputTokens, costMicroUsd);
}

export default db;
