import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  product TEXT NOT NULL CHECK (product IN ('CHECKING', 'SAVINGS', 'HOUSE')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FROZEN', 'CLOSED'))
);

CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  to_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'POSTED', 'DENIED')),
  decision TEXT,
  rule_id TEXT,
  reason TEXT,
  decision_ref TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  posted_at TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journals(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  side TEXT NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
  amount INTEGER NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  current_agent TEXT NOT NULL CHECK (current_agent IN ('teller', 'transfer', 'dispute')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent', 'operator')),
  action TEXT NOT NULL,
  args_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  why TEXT,
  blast_radius TEXT,
  session_id TEXT,
  journal_id TEXT,
  agent TEXT
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  customer_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_policy (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  from_account_id TEXT NOT NULL,
  to_account_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  decision TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  decide_audit_id TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_dismissals (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS enrollment_attempts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  documents_json TEXT NOT NULL,
  status TEXT NOT NULL,
  copy TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_cases (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  display_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  id_placeholder TEXT NOT NULL,
  acknowledgements_json TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT 'pass',
  copy TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_dismissals (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS book_documents (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  doc_id TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, doc_id)
);
`;

function tableColumns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function migrate(db: Db): void {
  const accounts = tableColumns(db, "accounts");
  if (accounts.size > 0 && !accounts.has("status")) {
    db.exec("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN'");
  }
  const journals = tableColumns(db, "journals");
  if (!journals.has("decision_ref")) {
    db.exec("ALTER TABLE journals ADD COLUMN decision_ref TEXT");
  }
  if (!journals.has("decision")) {
    db.exec("ALTER TABLE journals ADD COLUMN decision TEXT");
  }
  if (!journals.has("created_by")) {
    db.exec("ALTER TABLE journals ADD COLUMN created_by TEXT");
  }
  const audit = tableColumns(db, "audit");
  if (audit.size > 0 && !audit.has("why")) {
    db.exec("ALTER TABLE audit ADD COLUMN why TEXT");
  }
  if (audit.size > 0 && !audit.has("blast_radius")) {
    db.exec("ALTER TABLE audit ADD COLUMN blast_radius TEXT");
  }
  const policy = tableColumns(db, "session_policy");
  if (policy.size > 0 && !policy.has("decide_audit_id")) {
    db.exec("ALTER TABLE session_policy ADD COLUMN decide_audit_id TEXT");
  }
}

export function openDb(path: string): Db {
  if (path !== ":memory:" && path !== "") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path === "" ? ":memory:" : path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const txDepth = new WeakMap<Db, number>();
export function withTx<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const savepoint = `bank_nested_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}`);
    if (depth > 0) db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw err;
  } finally { txDepth.set(db, depth); }
}
