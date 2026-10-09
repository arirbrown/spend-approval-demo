import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.SPEND_DB || join(root, 'data', 'spend.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  motion TEXT NOT NULL,
  region TEXT NOT NULL,
  channel TEXT NOT NULL,
  owner TEXT NOT NULL,
  lead TEXT NOT NULL,          -- the bucket's motion or regional lead (Tier 2 approver)
  budget REAL NOT NULL,
  metric TEXT NOT NULL,
  is_reserve INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  requester TEXT NOT NULL,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id),
  vendor TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL,
  success_metric TEXT NOT NULL,
  success_target REAL NOT NULL,
  contract_length TEXT NOT NULL,
  cancellable INTEGER NOT NULL DEFAULT 0,
  spend_date TEXT,              -- when the money is expected to go out (optional)
  tier INTEGER NOT NULL,
  status TEXT NOT NULL,         -- pending | approved | rejected
  source TEXT NOT NULL DEFAULT 'web',  -- web | slack
  split_flag TEXT,              -- explanation when the splitting check bumped the tier
  tier_reasons TEXT NOT NULL DEFAULT '[]',
  required_role TEXT,           -- who must act next: lead | head_of_marketing | finance
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  actor TEXT NOT NULL,
  role TEXT NOT NULL,           -- auto | lead | head_of_marketing | finance
  action TEXT NOT NULL,         -- approved | rejected
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  receipt_id TEXT NOT NULL UNIQUE,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id),
  committed REAL NOT NULL,
  actual REAL NOT NULL DEFAULT 0,
  approver TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,  -- 1 once the row was read back and matched
  mismatch TEXT,
  date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slack_messages (
  id INTEGER PRIMARY KEY,
  author TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted',  -- unprocessed | awaiting_confirmation | filed | needs_info | posted (bot/system)
  parsed TEXT,                            -- JSON of the parsed request fields
  request_id INTEGER REFERENCES requests(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Light migration: databases created before Slack intake existed won't have
  // the source column.
  const cols = db.prepare('PRAGMA table_info(requests)').all().map(c => c.name);
  if (!cols.includes('source'))
    db.exec("ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");
  return db;
}
