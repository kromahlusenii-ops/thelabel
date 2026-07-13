import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'thelabel.db');

let _db;

export function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS verdict_cache (
      product_key TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL,
      price       REAL NOT NULL,
      currency    TEXT NOT NULL DEFAULT 'USD',
      observed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_price_obs_key
      ON price_observations(product_key, observed_at);

    CREATE TABLE IF NOT EXISTS fetch_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      domain      TEXT NOT NULL,
      tier        INTEGER NOT NULL,
      success     INTEGER NOT NULL,
      status_code INTEGER,
      elapsed_ms  INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  return _db;
}

// --- Verdict cache ---

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function getCachedVerdict(productKey) {
  const db = getDb();
  const row = db.prepare(
    'SELECT result_json, created_at FROM verdict_cache WHERE product_key = ?'
  ).get(productKey);

  if (!row) return null;
  if (Date.now() - row.created_at > CACHE_TTL_MS) {
    db.prepare('DELETE FROM verdict_cache WHERE product_key = ?').run(productKey);
    return null;
  }
  return JSON.parse(row.result_json);
}

export function setCachedVerdict(productKey, result) {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO verdict_cache (product_key, result_json, created_at) VALUES (?, ?, ?)'
  ).run(productKey, JSON.stringify(result), Date.now());
}

// --- Price observations ---

export function logPrice(productKey, price, currency = 'USD') {
  const db = getDb();
  db.prepare(
    'INSERT INTO price_observations (product_key, price, currency, observed_at) VALUES (?, ?, ?, ?)'
  ).run(productKey, price, currency, Date.now());
}

export function getPriceHistory(productKey) {
  const db = getDb();
  return db.prepare(
    'SELECT price, currency, observed_at FROM price_observations WHERE product_key = ? ORDER BY observed_at ASC'
  ).all(productKey);
}

// --- Fetch log ---

export function logFetch(domain, tier, success, statusCode, elapsedMs) {
  const db = getDb();
  db.prepare(
    'INSERT INTO fetch_log (domain, tier, success, status_code, elapsed_ms) VALUES (?, ?, ?, ?, ?)'
  ).run(domain, tier, success ? 1 : 0, statusCode, elapsedMs);
}

export function getDomainStats(domain) {
  const db = getDb();
  return db.prepare(`
    SELECT tier,
           COUNT(*) as attempts,
           SUM(success) as successes
    FROM fetch_log
    WHERE domain = ?
    GROUP BY tier
  `).all(domain);
}
