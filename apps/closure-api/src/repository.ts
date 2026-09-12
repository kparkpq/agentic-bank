import type { Db } from "@sapiensq/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS closure_schema_version (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO closure_schema_version (version) VALUES (1);

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
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json))
);

CREATE TABLE IF NOT EXISTS closure_authorizations (
  decision_id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  capsule_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
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

export function ensureClosureSchema(db: Db): void {
  db.exec(SCHEMA);
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
  db.prepare("INSERT INTO closure_mandates (mandate_id, customer_id, envelope_json) VALUES (?, ?, ?)").run(
    mandateId,
    customerId,
    JSON.stringify(envelope),
  );
}

export function getMandate(db: Db, mandateId: string): unknown | undefined {
  const row = db.prepare("SELECT envelope_json FROM closure_mandates WHERE mandate_id = ?").get(mandateId) as
    | { envelope_json: string }
    | undefined;
  return row ? (JSON.parse(row.envelope_json) as unknown) : undefined;
}

export function saveAuthorization(
  db: Db,
  decisionId: string,
  mandateId: string,
  capsuleId: string,
  record: unknown,
): void {
  db.prepare(
    `INSERT INTO closure_authorizations (decision_id, mandate_id, capsule_id, state, record_json)
     VALUES (?, ?, ?, 'AUTHORIZED', ?)`,
  ).run(decisionId, mandateId, capsuleId, JSON.stringify(record));
}

export function getAuthorization(
  db: Db,
  decisionId: string,
): { state: string; record: unknown; capsule_id: string } | undefined {
  const row = db
    .prepare("SELECT state, record_json, capsule_id FROM closure_authorizations WHERE decision_id = ?")
    .get(decisionId) as { state: string; record_json: string; capsule_id: string } | undefined;
  if (!row) return undefined;
  return { state: row.state, record: JSON.parse(row.record_json) as unknown, capsule_id: row.capsule_id };
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
