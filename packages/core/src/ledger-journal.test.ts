import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { writeAudit } from "./audit.js";
import { Bank } from "./bank.js";
import {
  applyPendingJournal,
  availableBalance,
  entrySides,
  journalEntries,
  pendingDebits,
  pendingOut,
  rejectPendingJournal,
  writeTransferJournal,
} from "./ledger.js";

function seeded(): Bank {
  const bank = new Bank(":memory:");
  bank.seed();
  return bank;
}

function plantDecide(
  bank: Bank,
  decision: "ALLOW" | "DENY_NSF" | "DENY_LIMIT" | "DUAL_CONTROL" | "DENY_POLICY",
  rule_id: string,
): string {
  const id = randomUUID();
  writeAudit(bank.db, {
    audit_id: id,
    actor: "agent",
    action: "policy.decide",
    args: {},
    decision,
    rule_id,
    reason: "ledger-journal test decide",
  });
  return id;
}

describe("ledger writeTransferJournal contract", () => {
  it("DENIED NSF writes two balanced unapplied entries and does not move available", () => {
    const bank = seeded();
    const before = availableBalance(bank.db, "acc_bob_chk");
    const ref = plantDecide(bank, "DENY_NSF", "NSF");
    const written = writeTransferJournal(bank.db, {
      idempotency_key: "eval:deny-nsf:v0",
      decision: "DENY_NSF",
      decision_ref: ref,
      from_account_id: "acc_bob_chk",
      to_account_id: "acc_bob_sav",
      amount: 600_000,
      rule_id: "NSF",
      reason: "NSF",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.journal.status).toBe("DENIED");
    expect(written.journal.decision_ref).toBe(ref);
    const entries = journalEntries(bank.db, written.journal.id);
    expect(entries).toHaveLength(2);
    const { debit, credit } = entrySides(entries);
    expect(debit).toBe(credit);
    expect(debit).toBe(600_000);
    expect(entries.every((e) => e.posted === 0)).toBe(true);
    expect(availableBalance(bank.db, "acc_bob_chk")).toBe(before);
    expect(pendingOut(bank.db, "acc_bob_chk")).toBe(0);
    bank.close();
  });

  it("DENIED DAILY_CAP writes two balanced unapplied entries and does not move available", () => {
    const bank = seeded();
    const before = availableBalance(bank.db, "acc_alice_chk");
    const ref = plantDecide(bank, "DENY_LIMIT", "DAILY_CAP");
    const written = writeTransferJournal(bank.db, {
      idempotency_key: "eval:deny-limit:v0",
      decision: "DENY_LIMIT",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 6_000_000,
      rule_id: "DAILY_CAP",
      reason: "cap",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const entries = journalEntries(bank.db, written.journal.id);
    expect(entries).toHaveLength(2);
    expect(entrySides(entries).debit).toBe(entrySides(entries).credit);
    expect(entries.every((e) => e.posted === 0)).toBe(true);
    expect(availableBalance(bank.db, "acc_alice_chk")).toBe(before);
    bank.close();
  });

  it("PENDING writes unapplied debit+credit and pending_out equals pending debits on source", () => {
    const bank = seeded();
    const before = availableBalance(bank.db, "acc_alice_chk");
    const ref = plantDecide(bank, "DUAL_CONTROL", "DUAL_AMOUNT");
    const written = writeTransferJournal(bank.db, {
      idempotency_key: "eval:dual-pending:v0",
      decision: "DUAL_CONTROL",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      rule_id: "DUAL_AMOUNT",
      reason: "dual",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const entries = journalEntries(bank.db, written.journal.id);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.posted === 0)).toBe(true);
    expect(availableBalance(bank.db, "acc_alice_chk")).toBe(before);
    expect(pendingOut(bank.db, "acc_alice_chk")).toBe(pendingDebits(bank.db, "acc_alice_chk"));
    expect(pendingOut(bank.db, "acc_alice_chk")).toBe(1_000_000);
    bank.close();
  });

  it("stores decision_ref from decide audit_id and operator apply/deny do not overwrite it", () => {
    const bank = seeded();
    const ref = plantDecide(bank, "DUAL_CONTROL", "DUAL_AMOUNT");
    const written = writeTransferJournal(bank.db, {
      idempotency_key: "eval:dual-pending:v0",
      decision: "DUAL_CONTROL",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      rule_id: "DUAL_AMOUNT",
      reason: "dual",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.journal.decision_ref).toBe(ref);
    const posted = applyPendingJournal(bank.db, written.journal.id)!;
    expect(posted.status).toBe("POSTED");
    expect(posted.decision_ref).toBe(ref);
    expect(journalEntries(bank.db, posted.id).every((e) => e.posted === 1)).toBe(true);

    const ref2 = plantDecide(bank, "DUAL_CONTROL", "DUAL_AMOUNT");
    const hold = writeTransferJournal(bank.db, {
      idempotency_key: "eval:dual-pending-deny:v0",
      decision: "DUAL_CONTROL",
      decision_ref: ref2,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      rule_id: "DUAL_AMOUNT",
      reason: "dual",
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    const denied = rejectPendingJournal(bank.db, hold.journal.id)!;
    expect(denied.status).toBe("DENIED");
    expect(denied.decision_ref).toBe(ref2);
    expect(journalEntries(bank.db, denied.id).every((e) => e.posted === 0)).toBe(true);
    bank.close();
  });

  it("refuses journal write when inbound audit_id or decision is missing, or decide audit does not exist", () => {
    const bank = seeded();
    const before = bank.journals().length;
    const ref = plantDecide(bank, "ALLOW", "ALLOW");
    const noKey = writeTransferJournal(bank.db, {
      idempotency_key: "",
      decision: "ALLOW",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      rule_id: "ALLOW",
      reason: "x",
    });
    expect(noKey.ok).toBe(false);
    if (noKey.ok) return;
    expect(noKey.code).toBe("MISSING_KEY");

    const noDecision = writeTransferJournal(bank.db, {
      idempotency_key: "eval:allow:v0",
      decision: "",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      rule_id: "ALLOW",
      reason: "x",
    });
    expect(noDecision.ok).toBe(false);
    if (noDecision.ok) return;
    expect(noDecision.code).toBe("MISSING_DECISION");

    const noAudit = writeTransferJournal(bank.db, {
      idempotency_key: "eval:allow:v0",
      decision: "ALLOW",
      decision_ref: "",
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      rule_id: "ALLOW",
      reason: "x",
    });
    expect(noAudit.ok).toBe(false);
    if (noAudit.ok) return;
    expect(noAudit.code).toBe("MISSING_AUDIT");

    const missingRow = writeTransferJournal(bank.db, {
      idempotency_key: "eval:allow:v0",
      decision: "ALLOW",
      decision_ref: randomUUID(),
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      rule_id: "ALLOW",
      reason: "x",
    });
    expect(missingRow.ok).toBe(false);
    if (missingRow.ok) return;
    expect(missingRow.code).toBe("DECIDE_AUDIT_MISSING");

    const otherAudit = writeAudit(bank.db, {
      actor: "agent",
      action: "transfer",
      args: {},
      decision: "ALLOW",
      rule_id: "ALLOW",
      reason: "not a decide row",
    });
    const wrongAction = writeTransferJournal(bank.db, {
      idempotency_key: "eval:allow:v0",
      decision: "ALLOW",
      decision_ref: otherAudit.audit_id,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      rule_id: "ALLOW",
      reason: "x",
    });
    expect(wrongAction.ok).toBe(false);
    if (wrongAction.ok) return;
    expect(wrongAction.code).toBe("DECIDE_AUDIT_MISSING");
    expect(bank.journals().length).toBe(before);
    bank.close();
  });

  it("SAME_ACCOUNT / invalid amount / unknown-or-unowned are not journalable", () => {
    const bank = seeded();
    const before = bank.journals().length;
    const cases: { decision: "DENY_POLICY" | "DENY_LIMIT"; rule_id: string }[] = [
      { decision: "DENY_POLICY", rule_id: "SAME_ACCOUNT" },
      { decision: "DENY_POLICY", rule_id: "INVALID_AMOUNT" },
      { decision: "DENY_POLICY", rule_id: "UNKNOWN_ACCOUNT" },
      { decision: "DENY_POLICY", rule_id: "NOT_OWNED" },
      { decision: "DENY_POLICY", rule_id: "ACCOUNT_FROZEN" },
      { decision: "DENY_LIMIT", rule_id: "SAME_ACCOUNT" },
    ];
    for (const c of cases) {
      const ref = plantDecide(bank, c.decision, c.rule_id);
      const written = writeTransferJournal(bank.db, {
        idempotency_key: `test:${c.rule_id}`,
        decision: c.decision,
        decision_ref: ref,
        from_account_id: "acc_alice_chk",
        to_account_id: "acc_alice_chk",
        amount: 1,
        rule_id: c.rule_id,
        reason: c.rule_id,
      });
      expect(written.ok).toBe(false);
      if (written.ok) return;
      expect(written.code).toBe("NOT_JOURNALABLE");
    }
    expect(bank.journals().length).toBe(before);
    bank.close();
  });

  it("idempotency key is required (not minted); same key returns same journal_id; same key + different body is 409", () => {
    const bank = seeded();
    const ref = plantDecide(bank, "ALLOW", "ALLOW");
    const first = writeTransferJournal(bank.db, {
      idempotency_key: "eval:allow:v0",
      decision: "ALLOW",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      rule_id: "ALLOW",
      reason: "ok",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = writeTransferJournal(bank.db, {
      idempotency_key: "eval:allow:v0",
      decision: "ALLOW",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      rule_id: "ALLOW",
      reason: "ok",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replay).toBe(true);
    expect(replay.journal.id).toBe(first.journal.id);
    expect(replay.journal.decision_ref).toBe(ref);

    const count = bank.journals().length;
    const conflict = writeTransferJournal(bank.db, {
      idempotency_key: "eval:allow:v0",
      decision: "ALLOW",
      decision_ref: ref,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 200_000,
      rule_id: "ALLOW",
      reason: "ok",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(bank.journals().length).toBe(count);
    expect(availableBalance(bank.db, "acc_alice_chk")).toBe(9_900_000);
    bank.close();
  });
});
