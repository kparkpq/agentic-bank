import { getJournal, getJournalByIdempotency, journalEntries, type Bank } from "@sapiensq/core";

export class ExecutionTimeoutError extends Error {
  readonly code = "EXECUTION_TIMEOUT";
  constructor(message = "executor timed out before a definitive result") {
    super(message);
    this.name = "ExecutionTimeoutError";
  }
}

export type ClosureExecutor = {
  execute: typeof executeSyntheticTransfer;
  lookup: (bank: Bank, idempotencyKey: string) => ExecutedTransfer | undefined;
};

export type ExecutedTransfer = {
  journal_id: string;
  ledger_sequence: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
};

export function executeSyntheticTransfer(
  bank: Bank,
  input: {
    customer_id: string;
    from_account_id: string;
    to_account_id: string;
    amount: number;
    idempotency_key: string;
  },
): ExecutedTransfer {
  const session = bank.startSession(input.customer_id);
  bank.tool(session.id, "handoff", { to: "transfer" });
  const result = bank.tool(session.id, "transfer", {
    from_account_id: input.from_account_id,
    to_account_id: input.to_account_id,
    amount: input.amount,
    idempotency_key: input.idempotency_key,
  });
  const posted =
    result.ok &&
    result.journal_id &&
    result.journal_status === "POSTED" &&
    result.decision === "ALLOW" &&
    result.rule_id === "ALLOW"
      ? result
      : result.ok &&
          result.journal_id &&
          result.journal_status === "PENDING" &&
          result.decision === "DUAL_CONTROL"
        ? bank.approve(result.journal_id)
        : result;
  if (
    !posted.ok ||
    posted.journal_status !== "POSTED" ||
    !posted.journal_id ||
    (posted.decision !== "ALLOW" && posted.decision !== "OPERATOR_APPROVE")
  ) {
    throw new Error(posted.reason || result.reason || "synthetic executor did not post an ALLOW transfer");
  }

  const journal = getJournal(bank.db, posted.journal_id);
  const entries = journalEntries(bank.db, posted.journal_id);
  if (
    !journal ||
    journal.status !== "POSTED" ||
    Number(journal.amount) !== input.amount ||
    journal.from_account_id !== input.from_account_id ||
    journal.to_account_id !== input.to_account_id ||
    entries.length !== 2 ||
    entries.some((entry) => entry.posted !== 1)
  ) {
    throw new Error("posted journal does not match the authorized transfer");
  }

  const row = bank.db.prepare("SELECT rowid AS seq FROM journals WHERE id = ?").get(journal.id) as
    | { seq: number }
    | undefined;
  if (!row || !Number.isSafeInteger(row.seq) || row.seq < 1) {
    throw new Error("journal sequence is unavailable");
  }

  return {
    journal_id: journal.id,
    ledger_sequence: String(row.seq),
    from_account_id: journal.from_account_id,
    to_account_id: journal.to_account_id,
    amount: Number(journal.amount),
  };
}

export function lookupSyntheticTransfer(bank: Bank, idempotencyKey: string): ExecutedTransfer | undefined {
  const journal = getJournalByIdempotency(bank.db, idempotencyKey);
  if (!journal || journal.status !== "POSTED") return undefined;
  const entries = journalEntries(bank.db, journal.id);
  if (entries.length !== 2 || entries.some((entry) => entry.posted !== 1)) return undefined;
  const row = bank.db.prepare("SELECT rowid AS seq FROM journals WHERE id = ?").get(journal.id) as
    | { seq: number }
    | undefined;
  if (!row) return undefined;
  return {
    journal_id: journal.id,
    ledger_sequence: String(row.seq),
    from_account_id: journal.from_account_id,
    to_account_id: journal.to_account_id,
    amount: Number(journal.amount),
  };
}

export const defaultClosureExecutor: ClosureExecutor = {
  execute: executeSyntheticTransfer,
  lookup: lookupSyntheticTransfer,
};
