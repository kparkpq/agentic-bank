import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { nowUtcIso } from "./time.js";
import type { Actor, AgentName, AuditRow, BlastRadius, Decision } from "./types.js";

export type WriteAuditInput = {
  audit_id?: string;
  actor: Actor;
  action: string;
  args: unknown;
  decision: Decision;
  rule_id: string;
  reason: string;
  why?: string;
  blast_radius?: BlastRadius;
  session_id?: string | null;
  journal_id?: string | null;
  agent?: AgentName | null;
  timestamp?: string;
};

const SECRET_KEY =
  /password|secret|token|authorization|cookie|ssn|pan|cvv|pin|email|e-mail|phone|mobile|tel|rrn|jumin|resident/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_VALUE = /^(?:\+82[-.\s]?)?0?1[0-9][-.\s]?\d{3,4}[-.\s]?\d{4}$/;
const RRN_VALUE = /^\d{6}[-\s]?\d{7}$/;

function looksLikePiiValue(value: string): boolean {
  const trimmed = value.trim();
  return EMAIL_VALUE.test(trimmed) || PHONE_VALUE.test(trimmed) || RRN_VALUE.test(trimmed);
}

export function redactArgs(args: unknown): unknown {
  if (typeof args === "string") return looksLikePiiValue(args) ? "[redacted]" : args;
  if (args == null || typeof args !== "object") return args ?? {};
  if (Array.isArray(args)) return args.map(redactArgs);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactArgs(value);
  }
  return out;
}

const BLAST: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/** Join-contract enum: allow=low, deny-*=medium, dual=high, ACCOUNT_FROZEN=medium. */
export function blastRadiusFor(decision: Decision, rule_id?: string): BlastRadius {
  if (rule_id === "ACCOUNT_FROZEN") return "medium";
  if (decision === "DUAL_CONTROL") return "high";
  if (decision === "ALLOW") return "low";
  if (decision === "OPERATOR_APPROVE") return "high";
  return "medium";
}

function deriveBlastRadius(input: WriteAuditInput): BlastRadius {
  if (input.blast_radius && BLAST.has(input.blast_radius)) return input.blast_radius;
  return blastRadiusFor(input.decision, input.rule_id);
}

export function findAuditByIdempotency(
  db: Db,
  action: string,
  key: string,
  decision?: string,
): AuditRow | undefined {
  const trimmed = key.trim();
  if (!trimmed) return undefined;
  const row = (
    decision
      ? db.prepare(
          `SELECT id FROM audit
           WHERE action = ?
             AND decision = ?
             AND json_extract(args_json, '$.idempotency_key') = ?
           ORDER BY timestamp ASC, id ASC
           LIMIT 1`,
        ).get(action, decision, trimmed)
      : db.prepare(
          `SELECT id FROM audit
           WHERE action = ?
             AND json_extract(args_json, '$.idempotency_key') = ?
           ORDER BY timestamp ASC, id ASC
           LIMIT 1`,
        ).get(action, trimmed)
  ) as { id: string } | undefined;
  if (!row) return undefined;
  return getAudit(db, row.id);
}

export function writeAudit(db: Db, input: WriteAuditInput): AuditRow {
  const audit_id = input.audit_id ?? randomUUID();
  if (!audit_id) {
    throw new Error("Missing audit_id = fail");
  }

  const existing = db.prepare("SELECT id FROM audit WHERE id = ?").get(audit_id) as
    | { id: string }
    | undefined;
  if (existing) {
    return getAudit(db, audit_id)!;
  }

  const timestamp = input.timestamp ?? nowUtcIso();
  const why = input.why ?? input.reason;
  const blast_radius = deriveBlastRadius(input);
  db.prepare(
    `INSERT INTO audit (id, timestamp, actor, action, args_json, decision, rule_id, reason, why, blast_radius, session_id, journal_id, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    audit_id,
    timestamp,
    input.actor,
    input.action,
    JSON.stringify(redactArgs(input.args ?? {})),
    input.decision,
    input.rule_id,
    input.reason,
    why,
    blast_radius,
    input.session_id ?? null,
    input.journal_id ?? null,
    input.agent ?? null,
  );

  const row = getAudit(db, audit_id);
  if (!row || !row.audit_id) {
    throw new Error("Missing audit_id = fail");
  }
  return row;
}

export function getAudit(db: Db, auditId: string): AuditRow | undefined {
  const row = db.prepare("SELECT * FROM audit WHERE id = ?").get(auditId) as
    | {
        id: string;
        timestamp: string;
        actor: Actor;
        action: string;
        args_json: string;
        decision: Decision;
        rule_id: string;
        reason: string;
        why?: string | null;
        blast_radius?: BlastRadius | string | null;
        session_id: string | null;
        journal_id: string | null;
        agent: AgentName | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    audit_id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
    args: JSON.parse(row.args_json) as unknown,
    decision: row.decision,
    rule_id: row.rule_id,
    reason: row.reason,
    why: row.why ?? row.reason,
    blast_radius: BLAST.has(row.blast_radius ?? "")
      ? (row.blast_radius as BlastRadius)
      : blastRadiusFor(row.decision, row.rule_id),
    session_id: row.session_id,
    journal_id: row.journal_id,
    agent: row.agent,
  };
}

export function listAudit(db: Db): AuditRow[] {
  const rows = db.prepare("SELECT id FROM audit ORDER BY timestamp ASC, id ASC").all() as {
    id: string;
  }[];
  return rows.map((r) => getAudit(db, r.id)!);
}
