import { describe, expect, it } from "vitest";
import { Bank } from "./bank.js";
import { availableSumAll, entrySides, pendingDebits, postedEntrySum } from "./ledger.js";
import { COPY_DENIED, COPY_PENDING, COPY_POSTED, DAILY_OUTBOUND_CAP_KRW, DUAL_CONTROL_AMOUNT_KRW } from "./types.js";

function seeded(): Bank {
  const bank = new Bank(":memory:");
  bank.seed();
  return bank;
}

function transferAgent(customerId: string): { bank: Bank; sessionId: string } {
  const bank = seeded();
  const session = bank.startSession(customerId);
  bank.tool(session.id, "handoff", { to: "transfer" });
  return { bank, sessionId: session.id };
}

describe("ledger invariants", () => {
  it("seed opening is double-entry and sums to zero available", () => {
    const bank = seeded();
    const { debit, credit } = postedEntrySum(bank.db);
    expect(debit).toBe(credit);
    expect(debit).toBe(11_900_000);
    expect(availableSumAll(bank.db)).toBe(0);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    expect(bank.account("acc_alice_sav")?.available).toBe(200_000);
    expect(bank.account("acc_alice_mmf")?.available).toBe(100_000);
    expect(bank.account("acc_alice_eq")?.available).toBe(800_000);
    expect(bank.account("acc_alice_bond")?.available).toBe(200_000);
    expect(bank.account("acc_bob_chk")?.available).toBe(500_000);
    expect(bank.account("acc_bob_sav")?.available).toBe(100_000);
    expect(bank.account("acc_house_equity")?.available).toBe(-11_900_000);
    expect(COPY_POSTED).toBe("완료");
    expect(COPY_PENDING).toBe("승인 대기");
    expect(COPY_DENIED).toBe("거절");
    bank.close();
  });

  it("posted transfer keeps debit=credit and global available 0", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const result = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "test:post:v0",
    });
    expect(result.journal_status).toBe("POSTED");
    expect(result.rule_id).toBe("ALLOW");
    expect(result.copy).toBe(COPY_POSTED);
    expect(result.blast_radius).toBe("low");
    expect(result.copy).not.toContain("이체 완료");
    expect(result.copy).not.toContain("이중통제 대기");
    const { debit, credit } = postedEntrySum(bank.db);
    expect(debit).toBe(credit);
    expect(availableSumAll(bank.db)).toBe(0);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_900_000);
    expect(bank.account("acc_alice_sav")?.available).toBe(300_000);
    bank.close();
  });

  it("pending dual-control writes unposted pair and does not change available", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const result = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      idempotency_key: "test:pending:v0",
    });
    expect(result.journal_status).toBe("PENDING");
    expect(result.copy).toBe(COPY_PENDING);
    expect(result.blast_radius).toBe("high");
    expect(result.copy).not.toContain(COPY_POSTED);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    expect(bank.account("acc_alice_chk")?.pending_out).toBe(1_000_000);
    expect(pendingDebits(bank.db, "acc_alice_chk")).toBe(1_000_000);
    const entries = bank.journalEntries(result.journal_id!);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.posted === 0)).toBe(true);
    const { debit, credit } = postedEntrySum(bank.db);
    expect(debit).toBe(credit);
    expect(debit).toBe(11_900_000);
    bank.close();
  });

  it("DENIED NSF/cap journals write two balanced posted=0 rows", () => {
    const { bank, sessionId } = transferAgent("syn_bob");
    const r = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_bob_chk",
      to_account_id: "acc_bob_sav",
      amount: 600_000,
      idempotency_key: "eval:deny-nsf:v0",
    });
    expect(r.journal_status).toBe("DENIED");
    expect(r.blast_radius).toBe("medium");
    const entries = bank.journalEntries(r.journal_id!);
    expect(entries).toHaveLength(2);
    const { debit, credit } = entrySides(entries);
    expect(debit).toBe(credit);
    expect(debit).toBe(600_000);
    expect(entries.every((e) => e.posted === 0)).toBe(true);
    expect(bank.account("acc_bob_chk")?.available).toBe(500_000);

    const { bank: aliceBank, sessionId: aliceSession } = transferAgent("syn_alice");
    const cap = aliceBank.tool(aliceSession, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 6_000_000,
      idempotency_key: "eval:deny-limit:v0",
    });
    expect(cap.journal_status).toBe("DENIED");
    expect(cap.decision).toBe("DENY_LIMIT");
    const capEntries = aliceBank.journalEntries(cap.journal_id!);
    expect(capEntries).toHaveLength(2);
    expect(capEntries.every((e) => Number(e.posted) === 0)).toBe(true);
    expect(aliceBank.account("acc_alice_chk")?.available).toBe(10_000_000);
    aliceBank.close();
    bank.close();
  });

  it("idempotent posting does not double-apply", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const args = {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "eval:allow:v0",
    };
    const a = bank.tool(sessionId, "transfer", args);
    const b = bank.tool(sessionId, "transfer", args);
    expect(a.journal_id).toBe(b.journal_id);
    expect(b.decision_ref).toBe(a.decision_ref);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_900_000);
    expect(bank.account("acc_alice_sav")?.available).toBe(300_000);
    bank.close();
  });
});

describe("policy", () => {
  it("DENY_POLICY for invalid amount / unknown / not owned — audit only, no journal", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const before = bank.journals().length;
    const zero = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 0,
      idempotency_key: "test:invalid-amount:v0",
    });
    expect(zero.decision).toBe("DENY_POLICY");
    expect(zero.rule_id).toBe("INVALID_AMOUNT");
    expect(zero.journal_id).toBeNull();

    const unknown = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_nobody",
      to_account_id: "acc_alice_sav",
      amount: 1,
      idempotency_key: "test:unknown-account:v0",
    });
    expect(unknown.decision).toBe("DENY_POLICY");
    expect(unknown.rule_id).toBe("UNKNOWN_ACCOUNT");
    expect(unknown.journal_id).toBeNull();

    const same = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_chk",
      amount: 1,
      idempotency_key: "test:same-account:v0",
    });
    expect(same.decision).toBe("DENY_POLICY");
    expect(same.rule_id).toBe("SAME_ACCOUNT");
    expect(same.journal_id).toBeNull();

    const owned = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_bob_chk",
      to_account_id: "acc_alice_sav",
      amount: 1,
      idempotency_key: "test:not-owned:v0",
    });
    expect(owned.decision).toBe("DENY_POLICY");
    expect(owned.rule_id).toBe("NOT_OWNED");
    expect(owned.journal_id).toBeNull();
    expect(bank.journals().length).toBe(before);
    bank.close();
  });

  it("omitted idempotency_key is minted and reused; never stored null", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const r = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
    });
    expect(r.journal_status).toBe("POSTED");
    expect(r.journal_id).toBeTruthy();
    const journal = bank.journal(r.journal_id!);
    expect(journal?.idempotency_key).toBeTruthy();
    expect(journal?.idempotency_key).not.toBeNull();
    const replay = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
    });
    expect(replay.journal_id).toBe(r.journal_id);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_900_000);
    bank.close();
  });

  it("NSF when spendable < amount; balances unchanged; not pending", () => {
    const { bank, sessionId } = transferAgent("syn_bob");
    const r = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_bob_chk",
      to_account_id: "acc_bob_sav",
      amount: 600_000,
      idempotency_key: "test:nsf:v0",
    });
    expect(r.decision).toBe("DENY_NSF");
    expect(r.copy).toBe(COPY_DENIED);
    expect(r.journal_status).toBe("DENIED");
    expect(bank.account("acc_bob_chk")?.available).toBe(500_000);
    expect(bank.account("acc_bob_chk")?.pending_out).toBe(0);
    expect(bank.pending()).toHaveLength(0);
    bank.close();
  });

  it("after 1M PENDING, amount > remaining spendable is DENY_NSF not another pending", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const pending = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      idempotency_key: "test:hold:v0",
    });
    expect(pending.journal_status).toBe("PENDING");
    const nsf = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 10_000_000,
      idempotency_key: "test:nsf-after-pending:v0",
    });
    expect(nsf.decision).toBe("DENY_NSF");
    expect(nsf.journal_status).toBe("DENIED");
    expect(nsf.copy).toBe(COPY_DENIED);
    expect(bank.pending()).toHaveLength(1);
    expect(bank.pending()[0]!.id).toBe(pending.journal_id);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    expect(bank.account("acc_alice_chk")?.pending_out).toBe(1_000_000);
    bank.close();
  });

  it("daily cap 5,000,000 same-customer is DENY_LIMIT not NSF or pending", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const r = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 6_000_000,
      idempotency_key: "eval:deny-limit:v0",
    });
    expect(r.decision).toBe("DENY_LIMIT");
    expect(r.rule_id).toBe("DAILY_CAP");
    expect(r.copy).toBe(COPY_DENIED);
    expect(r.decision).not.toBe("DENY_NSF");
    expect(bank.pending()).toHaveLength(0);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    expect(DAILY_OUTBOUND_CAP_KRW).toBe(5_000_000);
    bank.close();
  });

  it("amount >= 1,000,000 same-customer is DUAL_AMOUNT pending", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const r = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: DUAL_CONTROL_AMOUNT_KRW,
      idempotency_key: "eval:dual-pending:v0",
    });
    expect(r.decision).toBe("DUAL_CONTROL");
    expect(r.rule_id).toBe("DUAL_AMOUNT");
    expect(r.copy).toBe(COPY_PENDING);
    expect(r.journal_status).toBe("PENDING");
    expect(bank.account("acc_alice_chk")?.pending_out).toBe(1_000_000);
    bank.close();
  });

  it("other-customer transfer is dual-control even under 1M", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const r = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_bob_chk",
      amount: 50_000,
      idempotency_key: "eval:dual-other:v0",
    });
    expect(r.decision).toBe("DUAL_CONTROL");
    expect(r.rule_id).toBe("DUAL_OTHER_CUSTOMER");
    expect(r.decision).not.toBe("ALLOW");
    expect(r.copy).toBe(COPY_PENDING);
    bank.close();
  });

  it("teller cannot transfer; handoff required", () => {
    const bank = seeded();
    const session = bank.startSession("syn_alice");
    expect(session.current_agent).toBe("teller");
    const r = bank.tool(session.id, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
    });
    expect(r.ok).toBe(false);
    expect(r.rule_id).toBe("AGENT_TOOL_DENIED");
    expect(r.decision).toBe("DENY_POLICY");
    expect(r.journal_id ?? null).toBeNull();
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    expect(r.audit_id).toBeTruthy();
    expect(r.audit_id.length).toBeGreaterThan(0);
    expect(bank.audit().some((a) => a.audit_id === r.audit_id && a.rule_id === "AGENT_TOOL_DENIED")).toBe(
      true,
    );
    expect(bank.journals()).toHaveLength(1);
    bank.close();
  });

  it("agent self-approve writes no OPERATOR_APPROVE and leaves PENDING; decision_ref stable", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const pending = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      idempotency_key: "eval:dual-pending:v0",
    });
    expect(pending.journal_status).toBe("PENDING");
    const decideId = pending.decision_ref;
    expect(decideId).toBeTruthy();
    const self = bank.approve(pending.journal_id!, { actor: "agent" });
    expect(self.ok).toBe(false);
    expect(self.rule_id).toBe("SELF_APPROVE_FORBIDDEN");
    expect(self.copy).toBe("본인 건은 승인할 수 없음");
    expect(bank.journal(pending.journal_id!)?.status).toBe("PENDING");
    expect(bank.journal(pending.journal_id!)?.decision_ref).toBe(decideId);
    expect(bank.audit().some((a) => a.decision === "OPERATOR_APPROVE")).toBe(false);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const approved = bank.approve(pending.journal_id!);
    expect(approved.ok).toBe(true);
    expect(approved.decision).toBe("OPERATOR_APPROVE");
    expect(approved.journal_status).toBe("POSTED");
    expect(approved.copy).toBe(COPY_POSTED);
    expect(approved.audit_id).not.toBe(pending.audit_id);
    const approveRow = bank.audit().find((a) => a.decision === "OPERATOR_APPROVE")!;
    const posted = bank.journal(pending.journal_id!);
    expect(posted?.created_by).toBe("agent");
    expect(posted?.posted_at).toBeTruthy();
    expect(posted!.posted_at! >= approveRow.timestamp).toBe(true);
    expect(bank.audit().filter((a) => a.decision === "OPERATOR_APPROVE")).toHaveLength(1);
    expect(approved.decision_ref).toBe(decideId);
    expect(bank.journal(pending.journal_id!)?.decision_ref).toBe(decideId);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_000_000);
    expect(bank.account("acc_alice_sav")?.available).toBe(1_200_000);

    const replay = bank.approve(pending.journal_id!, { audit_id: approved.audit_id });
    expect(replay.ok).toBe(true);
    expect(replay.audit_id).toBe(approved.audit_id);
    expect(replay.decision_ref).toBe(decideId);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_000_000);
    bank.close();
  });

  it("idempotent transfer replay after operator deny keeps stored dual-control decision_ref", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const args = {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      idempotency_key: "eval:dual-pending-deny:v0",
    };
    const pending = bank.tool(sessionId, "transfer", args);
    const denied = bank.deny(pending.journal_id!);
    expect(denied.journal_status).toBe("DENIED");
    const replay = bank.tool(sessionId, "transfer", args);
    expect(replay.journal_id).toBe(pending.journal_id);
    expect(replay.decision_ref).toBe(pending.decision_ref);
    expect(replay.decision).toBe("DUAL_CONTROL");
    expect(replay.decision).not.toBe("DENY_LIMIT");
    expect(replay.journal_status).toBe("DENIED");
    expect(bank.journalEntries(replay.journal_id!).every((e) => Number(e.posted) === 0)).toBe(true);
    bank.close();
  });

  it("every tool call writes audit_id", () => {
    const bank = seeded();
    const session = bank.startSession("syn_alice");
    const bal = bank.tool(session.id, "balance", { account_id: "acc_alice_chk" });
    expect(bal.audit_id.length).toBeGreaterThan(0);
    expect(bank.audit().every((a) => a.audit_id)).toBe(true);
    expect(bank.audit().every((a) => a.why)).toBe(true);
    expect(bank.audit().every((a) => a.blast_radius)).toBe(true);
    bank.close();
  });

  it("transfer gates ledger on inbound decide and does not re-run decide", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const r = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "test:once-decide:v0",
    });
    expect(r.rule_id).toBe("ALLOW");
    const decides = bank.audit().filter((a) => a.action === "policy.decide");
    expect(decides).toHaveLength(1);
    expect(r.decision_ref).toBe(decides[0]!.audit_id);
    expect(bank.journal(r.journal_id!)?.decision_ref).toBe(decides[0]!.audit_id);
    expect(bank.journal(r.journal_id!)?.created_by).toBe("agent");
    bank.close();
  });
});
