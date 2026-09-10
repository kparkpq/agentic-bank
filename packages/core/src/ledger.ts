import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { nowUtcIso, seoulCalendarDay } from "./time.js";
import type { Account, AccountStatus, AccountView, Decision, Journal, JournalStatus } from "./types.js";

export function getAccount(db: Db, accountId: string): Account | undefined {
  const row = db.prepare("SELECT id, customer_id, product, status FROM accounts WHERE id = ?").get(accountId) as
    | { id: string; customer_id: string | null; product: string; status?: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    customer_id: row.customer_id,
    product: row.product as Account["product"],
    status: (row.status as AccountStatus | null | undefined) ?? "OPEN",
  };
}

const ACCOUNT_STATUSES: readonly AccountStatus[] = ["OPEN", "FROZEN", "CLOSED"];

export function isAccountStatus(value: string): value is AccountStatus {
  return (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

/** Status write only. Never a reversing journal. House stays hidden from callers. */
export function setAccountStatus(db: Db, accountId: string, status: AccountStatus): Account | undefined {
  const acc = getAccount(db, accountId);
  if (!acc) return undefined;
  if (!isAccountStatus(status)) return acc;
  db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, accountId);
  return getAccount(db, accountId);
}

function postedSides(db: Db, accountId: string): { credits: number; debits: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN side = 'CREDIT' AND posted = 1 THEN amount ELSE 0 END), 0) AS credits,
         COALESCE(SUM(CASE WHEN side = 'DEBIT' AND posted = 1 THEN amount ELSE 0 END), 0) AS debits
       FROM entries WHERE account_id = ?`,
    )
    .get(accountId) as { credits: number; debits: number };
  return { credits: Number(row.credits), debits: Number(row.debits) };
}

/** Banking-liability convention: available = posted credits − posted debits. */
export function availableBalance(db: Db, accountId: string): number {
  const { credits, debits } = postedSides(db, accountId);
  return credits - debits;
}

/** Unapplied PENDING debit postings on the source account. */
export function pendingDebits(db: Db, accountId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(e.amount), 0) AS pending
       FROM entries e
       JOIN journals j ON j.id = e.journal_id
       WHERE e.account_id = ?
         AND e.side = 'DEBIT'
         AND e.posted = 0
         AND j.status = 'PENDING'`,
    )
    .get(accountId) as { pending: number };
  return Number(row.pending);
}

export function pendingOut(db: Db, accountId: string): number {
  return pendingDebits(db, accountId);
}

export function accountView(db: Db, accountId: string): AccountView | undefined {
  const acc = getAccount(db, accountId);
  if (!acc) return undefined;
  const { credits, debits } = postedSides(db, accountId);
  return {
    id: acc.id,
    customer_id: acc.customer_id,
    product: acc.product,
    status: acc.status,
    available: credits - debits,
    pending_out: pendingOut(db, accountId),
    posted_credits: credits,
    posted_debits: debits,
  };
}

export function listAccountViews(db: Db, customerId?: string): AccountView[] {
  const rows = customerId
    ? (db
        .prepare(
          "SELECT id FROM accounts WHERE customer_id = ? ORDER BY id",
        )
        .all(customerId) as { id: string }[])
    : (db.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: string }[]);
  return rows.map((r) => accountView(db, r.id)!);
}

export function getJournal(db: Db, journalId: string): Journal | undefined {
  return db.prepare("SELECT * FROM journals WHERE id = ?").get(journalId) as Journal | undefined;
}

export function journalEntries(db: Db, journalId: string): {
  id: string;
  journal_id: string;
  account_id: string;
  side: "DEBIT" | "CREDIT";
  amount: number;
  posted: number;
  created_at: string;
}[] {
  return db
    .prepare("SELECT * FROM entries WHERE journal_id = ? ORDER BY side ASC")
    .all(journalId) as {
    id: string;
    journal_id: string;
    account_id: string;
    side: "DEBIT" | "CREDIT";
    amount: number;
    posted: number;
    created_at: string;
  }[];
}

export function entrySides(entries: { side: string; amount: number; posted: number }[]): {
  debit: number;
  credit: number;
} {
  return {
    debit: entries.filter((e) => e.side === "DEBIT").reduce((s, e) => s + Number(e.amount), 0),
    credit: entries.filter((e) => e.side === "CREDIT").reduce((s, e) => s + Number(e.amount), 0),
  };
}

export function getJournalByIdempotency(db: Db, key: string): Journal | undefined {
  return db.prepare("SELECT * FROM journals WHERE idempotency_key = ?").get(key) as Journal | undefined;
}

export function customerOutboundOnSeoulDay(db: Db, customerId: string, now = new Date()): number {
  const day = seoulCalendarDay(now);
  const rows = db
    .prepare(
      `SELECT j.amount AS amount, j.created_at AS created_at
       FROM journals j
       JOIN accounts a ON a.id = j.from_account_id
       WHERE a.customer_id = ?
         AND j.status IN ('POSTED', 'PENDING')`,
    )
    .all(customerId) as { amount: number; created_at: string }[];
  let sum = 0;
  for (const row of rows) {
    if (seoulCalendarDay(new Date(row.created_at)) === day) {
      sum += Number(row.amount);
    }
  }
  return sum;
}

export function postedEntrySum(db: Db): { debit: number; credit: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN side = 'DEBIT' AND posted = 1 THEN amount ELSE 0 END), 0) AS debit,
         COALESCE(SUM(CASE WHEN side = 'CREDIT' AND posted = 1 THEN amount ELSE 0 END), 0) AS credit
       FROM entries`,
    )
    .get() as { debit: number; credit: number };
  return { debit: Number(row.debit), credit: Number(row.credit) };
}

export function availableSumAll(db: Db): number {
  const accounts = db.prepare("SELECT id FROM accounts").all() as { id: string }[];
  return accounts.reduce((sum, a) => sum + availableBalance(db, a.id), 0);
}

export const JOURNALABLE_DECISIONS = ["ALLOW", "DENY_NSF", "DENY_LIMIT", "DUAL_CONTROL"] as const;
export type JournalableDecision = (typeof JOURNALABLE_DECISIONS)[number];

export type TransferJournalInput = {
  idempotency_key: string;
  decision: Decision | string;
  decision_ref: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  rule_id: string;
  reason: string;
  created_by?: string;
};

export type JournalWriteOk = { ok: true; journal: Journal; replay: boolean };
export type JournalWriteErr = {
  ok: false;
  status: 400 | 409;
  code:
    | "MISSING_KEY"
    | "MISSING_AUDIT"
    | "MISSING_DECISION"
    | "DECIDE_AUDIT_MISSING"
    | "NOT_JOURNALABLE"
    | "UNKNOWN_ACCOUNT"
    | "IDEMPOTENCY_CONFLICT";
  reason: string;
};
export type JournalWriteResult = JournalWriteOk | JournalWriteErr;

function isJournalable(decision: string, rule_id: string): decision is JournalableDecision {
  if (decision === "ALLOW") return true;
  if (decision === "DENY_NSF") return true;
  if (decision === "DENY_LIMIT" && rule_id === "DAILY_CAP") return true;
  if (decision === "DUAL_CONTROL") return true;
  return false;
}

function statusFor(decision: JournalableDecision): JournalStatus {
  if (decision === "ALLOW") return "POSTED";
  if (decision === "DUAL_CONTROL") return "PENDING";
  return "DENIED";
}

function sameTransferBody(journal: Journal, input: TransferJournalInput): boolean {
  return (
    journal.from_account_id === input.from_account_id &&
    journal.to_account_id === input.to_account_id &&
    Number(journal.amount) === input.amount
  );
}

function requireDecideAudit(db: Db, decision_ref: string, decision: string): boolean {
  const row = db.prepare("SELECT id, action, decision FROM audit WHERE id = ?").get(decision_ref) as
    | { id: string; action: string; decision: string }
    | undefined;
  return Boolean(row && row.action === "policy.decide" && row.decision === decision);
}

function insertEntryPair(db: Db, journal: Journal, posted: 0 | 1, ts: string): void {
  const existing = journalEntries(db, journal.id);
  if (existing.length >= 2) return;
  const insert = db.prepare(
    `INSERT INTO entries (id, journal_id, account_id, side, amount, posted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(randomUUID(), journal.id, journal.from_account_id, "DEBIT", journal.amount, posted, ts);
  insert.run(randomUUID(), journal.id, journal.to_account_id, "CREDIT", journal.amount, posted, ts);
}

/**
 * Transfer journal write path. Missing idempotency_key, decision, or decision_ref (decide audit_id)
 * refuses with no journal. Does not mint keys. Always writes two balanced postings.
 */
export function writeTransferJournal(db: Db, input: TransferJournalInput): JournalWriteResult {
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (!key) {
    return { ok: false, status: 400, code: "MISSING_KEY", reason: "idempotency_key is required" };
  }
  if (!input.decision) {
    return { ok: false, status: 400, code: "MISSING_DECISION", reason: "decision is required" };
  }
  if (!input.decision_ref) {
    return { ok: false, status: 400, code: "MISSING_AUDIT", reason: "decision_ref (decide audit_id) is required" };
  }
  if (!isJournalable(input.decision, input.rule_id)) {
    return {
      ok: false,
      status: 400,
      code: "NOT_JOURNALABLE",
      reason: `decision ${input.decision}/${input.rule_id} is audit-only; no journal`,
    };
  }
  if (!requireDecideAudit(db, input.decision_ref, input.decision)) {
    return {
      ok: false,
      status: 400,
      code: "DECIDE_AUDIT_MISSING",
      reason: "decision_ref must be a policy.decide audit_id for this decision",
    };
  }
  const fromAcc = getAccount(db, input.from_account_id);
  const toAcc = getAccount(db, input.to_account_id);
  if (!fromAcc || !toAcc) {
    return { ok: false, status: 400, code: "UNKNOWN_ACCOUNT", reason: "unknown account" };
  }
  if (fromAcc.status !== "OPEN" || toAcc.status !== "OPEN") {
    return {
      ok: false,
      status: 400,
      code: "NOT_JOURNALABLE",
      reason: `decision DENY_POLICY/ACCOUNT_FROZEN is audit-only; no journal`,
    };
  }

  const existing = getJournalByIdempotency(db, key);
  if (existing) {
    if (!sameTransferBody(existing, input)) {
      return {
        ok: false,
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        reason: "idempotency key reused with a different body",
      };
    }
    return { ok: true, journal: existing, replay: true };
  }

  const status = statusFor(input.decision);
  const posted: 0 | 1 = status === "POSTED" ? 1 : 0;
  const ts = nowUtcIso();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO journals (
       id, idempotency_key, from_account_id, to_account_id, amount, status,
       decision, rule_id, reason, decision_ref, created_by, created_at, posted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    key,
    input.from_account_id,
    input.to_account_id,
    input.amount,
    status,
    input.decision,
    input.rule_id,
    input.reason,
    input.decision_ref,
    input.created_by ?? "agent",
    ts,
    posted === 1 ? ts : null,
  );
  const journal = getJournal(db, id)!;
  insertEntryPair(db, journal, posted, ts);
  const pair = journalEntries(db, id);
  const { debit, credit } = entrySides(pair);
  if (pair.length !== 2 || debit !== credit || debit !== Number(journal.amount)) {
    db.prepare("DELETE FROM entries WHERE journal_id = ?").run(id);
    db.prepare("DELETE FROM journals WHERE id = ?").run(id);
    return {
      ok: false,
      status: 400,
      code: "NOT_JOURNALABLE",
      reason: "header-only journal is a fail; two balanced postings are required",
    };
  }
  return { ok: true, journal: getJournal(db, id)!, replay: false };
}

/** Mark PENDING journal POSTED. Never overwrites decision_ref. */
export function applyPendingJournal(db: Db, journalId: string): Journal | undefined {
  const journal = getJournal(db, journalId);
  if (!journal || journal.status !== "PENDING") return journal;
  const ref = journal.decision_ref;
  const ts = nowUtcIso();
  db.prepare("UPDATE journals SET status = 'POSTED', posted_at = ? WHERE id = ?").run(ts, journalId);
  db.prepare("UPDATE entries SET posted = 1 WHERE journal_id = ?").run(journalId);
  const fresh = getJournal(db, journalId);
  if (fresh && fresh.decision_ref !== ref) {
    throw new Error("decision_ref must not change on operator approve");
  }
  return fresh;
}

/** Mark PENDING journal DENIED. Never overwrites decision_ref. Unapplied rows stay posted=0. */
export function rejectPendingJournal(db: Db, journalId: string): Journal | undefined {
  const journal = getJournal(db, journalId);
  if (!journal || journal.status !== "PENDING") return journal;
  const ref = journal.decision_ref;
  db.prepare("UPDATE journals SET status = 'DENIED' WHERE id = ?").run(journalId);
  const fresh = getJournal(db, journalId);
  if (fresh && fresh.decision_ref !== ref) {
    throw new Error("decision_ref must not change on operator deny");
  }
  return fresh;
}
