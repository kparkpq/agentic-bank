import type { Db } from "@sapiensq/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS closure_schema_version (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO closure_schema_version (version) VALUES (1);
INSERT OR IGNORE INTO closure_schema_version (version) VALUES (2);

CREATE TABLE IF NOT EXISTS closure_idempotency (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS closure_mandates (
  mandate_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  revoked_at TEXT,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json))
);

CREATE TABLE IF NOT EXISTS closure_authorizations (
  decision_id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  action_id TEXT,
  capsule_id TEXT UNIQUE,
  state TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 1,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE TABLE IF NOT EXISTS closure_consumptions (
  capsule_id TEXT PRIMARY KEY,
  consumed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closure_proofs (
  proof_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  proof_json TEXT NOT NULL CHECK (json_valid(proof_json))
);
`;

export type IdempotencyRow = {
  request_hash: string;
  status: number;
  response: unknown;
};

export type AuthorizationRow = {
  decision_id: string;
  mandate_id: string;
  action_id: string | null;
  capsule_id: string | null;
  state: string;
  state_version: number;
  record: unknown;
};

function tableColumns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
  return new Set(rows.map((row) => row.name));
}

function migrate(db: Db): void {
  const mandates = tableColumns(db, "closure_mandates");
  if (mandates.size > 0 && !mandates.has("revoked_at")) {
    db.exec("ALTER TABLE closure_mandates ADD COLUMN revoked_at TEXT");
  }
  const authorizations = db.prepare("PRAGMA table_info(closure_authorizations)").all() as {
    name: string;
    notnull: number;
  }[];
  const capsule = authorizations.find((column) => column.name === "capsule_id");
  if (capsule?.notnull === 1) {
    db.exec(`
      CREATE TABLE closure_authorizations_v2 (
        decision_id TEXT PRIMARY KEY,
        mandate_id TEXT NOT NULL,
        action_id TEXT,
        capsule_id TEXT UNIQUE,
        state TEXT NOT NULL,
        state_version INTEGER NOT NULL DEFAULT 1,
        record_json TEXT NOT NULL CHECK (json_valid(record_json))
      );
      INSERT INTO closure_authorizations_v2 (decision_id, mandate_id, capsule_id, state, record_json)
      SELECT decision_id, mandate_id, capsule_id, state, record_json FROM closure_authorizations;
      DROP TABLE closure_authorizations;
      ALTER TABLE closure_authorizations_v2 RENAME TO closure_authorizations;
    `);
  } else {
    const names = new Set(authorizations.map((column) => column.name));
    if (authorizations.length > 0 && !names.has("action_id")) {
      db.exec("ALTER TABLE closure_authorizations ADD COLUMN action_id TEXT");
    }
    if (authorizations.length > 0 && !names.has("state_version")) {
      db.exec("ALTER TABLE closure_authorizations ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1");
    }
  }
}

export function ensureClosureSchema(db: Db): void {
  db.exec(SCHEMA);
  migrate(db);
}

export function getIdempotency(db: Db, scope: string, key: string): IdempotencyRow | undefined {
  const row = db
    .prepare(
      "SELECT request_hash, status, response_json FROM closure_idempotency WHERE scope = ? AND idempotency_key = ?",
    )
    .get(scope, key) as { request_hash: string; status: number; response_json: string } | undefined;
  if (!row) return undefined;
  return {
    request_hash: row.request_hash,
    status: row.status,
    response: JSON.parse(row.response_json) as unknown,
  };
}

export function saveIdempotency(
  db: Db,
  scope: string,
  key: string,
  requestHash: string,
  status: number,
  response: unknown,
): void {
  db.prepare(
    `INSERT INTO closure_idempotency (scope, idempotency_key, request_hash, status, response_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(scope, key, requestHash, status, JSON.stringify(response));
}

export function saveMandate(db: Db, mandateId: string, customerId: string, envelope: unknown): void {
  db.prepare(
    "INSERT INTO closure_mandates (mandate_id, customer_id, revoked_at, envelope_json) VALUES (?, ?, NULL, ?)",
  ).run(mandateId, customerId, JSON.stringify(envelope));
}

export function getMandate(db: Db, mandateId: string): unknown | undefined {
  const row = db.prepare("SELECT envelope_json FROM closure_mandates WHERE mandate_id = ?").get(mandateId) as
    | { envelope_json: string }
    | undefined;
  return row ? (JSON.parse(row.envelope_json) as unknown) : undefined;
}

export function isMandateRevoked(db: Db, mandateId: string): boolean {
  const row = db.prepare("SELECT revoked_at FROM closure_mandates WHERE mandate_id = ?").get(mandateId) as
    | { revoked_at: string | null }
    | undefined;
  return Boolean(row?.revoked_at);
}

export function revokeMandate(db: Db, mandateId: string, revokedAt: string): boolean {
  const result = db
    .prepare("UPDATE closure_mandates SET revoked_at = ? WHERE mandate_id = ? AND revoked_at IS NULL")
    .run(revokedAt, mandateId);
  return Number(result.changes) === 1;
}

export function saveAuthorization(
  db: Db,
  decisionId: string,
  mandateId: string,
  actionId: string,
  capsuleId: string | null,
  state: string,
  record: unknown,
): void {
  db.prepare(
    `INSERT INTO closure_authorizations
      (decision_id, mandate_id, action_id, capsule_id, state, state_version, record_json)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(decisionId, mandateId, actionId, capsuleId, state, JSON.stringify(record));
}

export function getAuthorization(db: Db, decisionId: string): AuthorizationRow | undefined {
  const row = db
    .prepare(
      `SELECT decision_id, mandate_id, action_id, capsule_id, state, state_version, record_json
       FROM closure_authorizations WHERE decision_id = ?`,
    )
    .get(decisionId) as
    | {
        decision_id: string;
        mandate_id: string;
        action_id: string | null;
        capsule_id: string | null;
        state: string;
        state_version: number;
        record_json: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    decision_id: row.decision_id,
    mandate_id: row.mandate_id,
    action_id: row.action_id,
    capsule_id: row.capsule_id,
    state: row.state,
    state_version: row.state_version,
    record: JSON.parse(row.record_json) as unknown,
  };
}

export function listAuthorizationsByMandate(db: Db, mandateId: string): AuthorizationRow[] {
  const rows = db
    .prepare(
      `SELECT decision_id, mandate_id, action_id, capsule_id, state, state_version, record_json
       FROM closure_authorizations WHERE mandate_id = ?`,
    )
    .all(mandateId) as Array<{
    decision_id: string;
    mandate_id: string;
    action_id: string | null;
    capsule_id: string | null;
    state: string;
    state_version: number;
    record_json: string;
  }>;
  return rows.map((row) => ({
    decision_id: row.decision_id,
    mandate_id: row.mandate_id,
    action_id: row.action_id,
    capsule_id: row.capsule_id,
    state: row.state,
    state_version: row.state_version,
    record: JSON.parse(row.record_json) as unknown,
  }));
}

export function updateAuthorization(
  db: Db,
  decisionId: string,
  expectedState: string,
  expectedVersion: number,
  next: { state: string; capsuleId: string | null; record: unknown },
): boolean {
  const result = db
    .prepare(
      `UPDATE closure_authorizations
       SET state = ?, capsule_id = ?, record_json = ?, state_version = state_version + 1
       WHERE decision_id = ? AND state = ? AND state_version = ?`,
    )
    .run(next.state, next.capsuleId, JSON.stringify(next.record), decisionId, expectedState, expectedVersion);
  return Number(result.changes) === 1;
}

export function consumeCapsule(db: Db, capsuleId: string, consumedAt: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO closure_consumptions (capsule_id, consumed_at) VALUES (?, ?)")
    .run(capsuleId, consumedAt);
  return Number(result.changes) === 1;
}

export function markAuthorizationClosed(db: Db, decisionId: string): void {
  db.prepare("UPDATE closure_authorizations SET state = 'CLOSED' WHERE decision_id = ?").run(decisionId);
}

export function countActionMutations(db: Db, actionId: string, capsuleId: string | null): number {
  const keys = [`action:${actionId}`];
  if (capsuleId) keys.push(`closure:${capsuleId}`);
  let count = 0;
  for (const key of keys) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM journals
         WHERE idempotency_key = ? AND status IN ('POSTED', 'PENDING')`,
      )
      .get(key) as { n: number };
    count += Number(row.n);
  }
  return count;
}

export function nextLedgerSequence(db: Db): string {
  const row = db.prepare("SELECT COALESCE(MAX(rowid), 1) AS seq FROM journals").get() as { seq: number };
  return String(Math.max(1, Number(row.seq)));
}

export function saveProof(db: Db, proofId: string, decisionId: string, proof: unknown): void {
  db.prepare("INSERT INTO closure_proofs (proof_id, decision_id, proof_json) VALUES (?, ?, ?)").run(
    proofId,
    decisionId,
    JSON.stringify(proof),
  );
}

export function getProof(db: Db, proofId: string): unknown | undefined {
  const row = db.prepare("SELECT proof_json FROM closure_proofs WHERE proof_id = ?").get(proofId) as
    | { proof_json: string }
    | undefined;
  return row ? (JSON.parse(row.proof_json) as unknown) : undefined;
}

export function getProofByDecision(db: Db, decisionId: string): unknown | undefined {
  const row = db.prepare("SELECT proof_json FROM closure_proofs WHERE decision_id = ?").get(decisionId) as
    | { proof_json: string }
    | undefined;
  return row ? (JSON.parse(row.proof_json) as unknown) : undefined;
}
