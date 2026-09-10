import { describe, expect, it } from "vitest";
import { Bank } from "./bank.js";
import { findAuditByIdempotency } from "./audit.js";
import { writeTransferJournal } from "./ledger.js";
import {
  COPY_ACCOUNT_CLOSED,
  COPY_ACCOUNT_FROZEN,
  COPY_ACCOUNT_OPEN,
  COPY_DENIED,
} from "./types.js";

function transferAgent(customerId: string): { bank: Bank; sessionId: string } {
  const bank = new Bank(":memory:");
  bank.seed();
  const session = bank.startSession(customerId);
  bank.tool(session.id, "handoff", { to: "transfer" });
  return { bank, sessionId: session.id };
}

describe("v0.1 account status", () => {
  it("fixture accounts default OPEN; house stays hidden; freeze is not a journal", () => {
    const bank = new Bank(":memory:");
    bank.seed();
    expect(bank.account("acc_alice_chk")?.status).toBe("OPEN");
    expect(bank.account("acc_alice_sav")?.status).toBe("OPEN");
    expect(bank.account("acc_bob_chk")?.status).toBe("OPEN");
    expect(bank.account("acc_house_equity")?.status).toBe("OPEN");
    expect(COPY_ACCOUNT_OPEN).toBe("정상");
    expect(COPY_ACCOUNT_FROZEN).toBe("동결");
    expect(COPY_ACCOUNT_CLOSED).toBe("해지");

    const before = bank.journals().length;
    const beforeChk = bank.account("acc_alice_chk")?.available;
    const frozen = bank.setStatus("acc_alice_chk", "FROZEN");
    expect(frozen.ok).toBe(true);
    expect(frozen.journal_id ?? null).toBeNull();
    expect(frozen.copy).toBe("동결");
    expect(bank.journals().length).toBe(before);
    expect(bank.account("acc_alice_chk")?.status).toBe("FROZEN");
    expect(bank.account("acc_alice_chk")?.available).toBe(beforeChk);

    const house = bank.setStatus("acc_house_equity", "FROZEN");
    expect(house.ok).toBe(false);
    expect(bank.account("acc_house_equity")?.status).toBe("OPEN");
    expect(bank.accounts("operator").some((a) => a.product === "HOUSE")).toBe(true);
    bank.close();
  });

  it("from OR to FROZEN/CLOSED is DENY_POLICY ACCOUNT_FROZEN before NSF, cap, and dual-control", () => {
    const { bank, sessionId } = transferAgent("syn_bob");
    bank.setStatus("acc_bob_chk", "FROZEN");
    const nsfWould = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_bob_chk",
      to_account_id: "acc_bob_sav",
      amount: 600_000,
      idempotency_key: "test:frozen-before-nsf:v0",
    });
    expect(nsfWould.decision).toBe("DENY_POLICY");
    expect(nsfWould.rule_id).toBe("ACCOUNT_FROZEN");
    expect(nsfWould.decision).not.toBe("DENY_NSF");
    expect(nsfWould.journal_id ?? null).toBeNull();
    expect(nsfWould.copy).toBe(COPY_DENIED);
    expect(bank.account("acc_bob_chk")?.available).toBe(500_000);
    bank.close();

    const { bank: alice, sessionId: aliceSession } = transferAgent("syn_alice");
    alice.setStatus("acc_alice_chk", "FROZEN");
    const capWould = alice.tool(aliceSession, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 6_000_000,
      idempotency_key: "test:frozen-before-cap:v0",
    });
    expect(capWould.decision).toBe("DENY_POLICY");
    expect(capWould.rule_id).toBe("ACCOUNT_FROZEN");
    expect(capWould.decision).not.toBe("DENY_LIMIT");
    expect(capWould.journal_id ?? null).toBeNull();

    const dualWould = alice.tool(aliceSession, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      idempotency_key: "test:frozen-before-dual:v0",
    });
    expect(dualWould.decision).toBe("DENY_POLICY");
    expect(dualWould.rule_id).toBe("ACCOUNT_FROZEN");
    expect(dualWould.decision).not.toBe("DUAL_CONTROL");
    expect(alice.pending()).toHaveLength(0);

    alice.setStatus("acc_alice_chk", "OPEN");
    alice.setStatus("acc_alice_sav", "CLOSED");
    const toClosed = alice.tool(aliceSession, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "test:closed-to:v0",
    });
    expect(toClosed.decision).toBe("DENY_POLICY");
    expect(toClosed.rule_id).toBe("ACCOUNT_FROZEN");
    expect(toClosed.journal_id ?? null).toBeNull();
    alice.close();
  });

  it("eval:account-frozen:v0 is audit-only; replay reuses decide audit_id; blast_radius medium", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const journalsBefore = bank.journals().length;
    bank.setStatus("acc_alice_chk", "FROZEN");
    const args = {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "eval:account-frozen:v0",
    };
    const first = bank.tool(sessionId, "transfer", args);
    expect(first.ok).toBe(false);
    expect(first.decision).toBe("DENY_POLICY");
    expect(first.rule_id).toBe("ACCOUNT_FROZEN");
    expect(first.journal_id ?? null).toBeNull();
    expect(first.audit_id.length).toBeGreaterThan(0);
    expect(first.blast_radius).toBe("medium");
    const decide = bank.audit().find((a) => a.audit_id === first.audit_id);
    expect(decide?.action).toBe("policy.decide");
    expect(decide?.blast_radius).toBe("medium");
    expect(decide?.journal_id ?? null).toBeNull();
    expect(bank.journals().length).toBe(journalsBefore);
    expect(bank.pending()).toHaveLength(0);

    const second = bank.tool(sessionId, "transfer", args);
    expect(second.audit_id).toBe(first.audit_id);
    expect(second.decision_ref).toBe(first.decision_ref);
    expect(second.journal_id ?? null).toBeNull();
    expect(second.rule_id).toBe("ACCOUNT_FROZEN");
    const keyed = findAuditByIdempotency(bank.db, "policy.decide", "eval:account-frozen:v0", "DENY_POLICY");
    expect(keyed?.audit_id).toBe(first.audit_id);
    expect(
      bank.audit().filter(
        (a) =>
          a.action === "policy.decide" &&
          a.rule_id === "ACCOUNT_FROZEN" &&
          (a.args as { idempotency_key?: string }).idempotency_key === "eval:account-frozen:v0",
      ),
    ).toHaveLength(1);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    expect(bank.account("acc_alice_chk")?.pending_out).toBe(0);
    expect(bank.account("acc_alice_sav")?.available).toBe(200_000);
    bank.close();
  });

  it("in-flight PENDING survives freeze; decide audit is not rewritten; operator can still clear it", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const pending = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      idempotency_key: "test:pending-then-freeze:v0",
    });
    expect(pending.journal_status).toBe("PENDING");
    const decideId = pending.decision_ref!;
    const decideBefore = bank.audit().find((a) => a.audit_id === decideId)!;
    bank.setStatus("acc_alice_chk", "FROZEN");
    const journal = bank.journal(pending.journal_id!);
    expect(journal?.status).toBe("PENDING");
    expect(journal?.decision_ref).toBe(decideId);
    expect(bank.pending()).toHaveLength(1);
    const decideAfter = bank.audit().find((a) => a.audit_id === decideId)!;
    expect(decideAfter).toEqual(decideBefore);
    const approved = bank.approve(pending.journal_id!);
    expect(approved.ok).toBe(true);
    expect(approved.journal_status).toBe("POSTED");
    expect(approved.decision_ref).toBe(decideId);
    expect(bank.journal(pending.journal_id!)?.decision_ref).toBe(decideId);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_000_000);
    bank.close();
  });

  it("ACCOUNT_FROZEN is not journalable; blast_radius enum matches join contract", () => {
    const { bank, sessionId } = transferAgent("syn_alice");
    const allow = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "test:blast-allow:v0",
    });
    expect(allow.blast_radius).toBe("low");
    expect(bank.audit().find((a) => a.audit_id === allow.decision_ref)?.blast_radius).toBe("low");

    const dual = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 1_000_000,
      idempotency_key: "test:blast-dual:v0",
    });
    expect(dual.blast_radius).toBe("high");

    const { bank: bob, sessionId: bobSession } = transferAgent("syn_bob");
    const nsf = bob.tool(bobSession, "transfer", {
      from_account_id: "acc_bob_chk",
      to_account_id: "acc_bob_sav",
      amount: 600_000,
      idempotency_key: "test:blast-nsf:v0",
    });
    expect(nsf.blast_radius).toBe("medium");
    bob.close();

    bank.setStatus("acc_alice_sav", "FROZEN");
    const frozen = bank.tool(sessionId, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 50_000,
      idempotency_key: "test:blast-frozen:v0",
    });
    expect(frozen.blast_radius).toBe("medium");
    const written = writeTransferJournal(bank.db, {
      idempotency_key: "test:frozen-not-journalable:v0",
      decision: "DENY_POLICY",
      decision_ref: frozen.audit_id,
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 50_000,
      rule_id: "ACCOUNT_FROZEN",
      reason: "frozen",
    });
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.code).toBe("NOT_JOURNALABLE");
    bank.close();
  });

  it("assertAgentTool writes audit first; teller transfer is DENY_POLICY AGENT_TOOL_DENIED with no journal", () => {
    const bank = new Bank(":memory:");
    bank.seed();
    const session = bank.startSession("syn_alice");
    const before = bank.journals().length;
    const denied = bank.tool(session.id, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "test:teller-denied:v0",
    });
    expect(denied.decision).toBe("DENY_POLICY");
    expect(denied.rule_id).toBe("AGENT_TOOL_DENIED");
    expect(denied.audit_id).not.toBe("");
    expect(denied.audit_id.length).toBeGreaterThan(0);
    expect(denied.journal_id ?? null).toBeNull();
    expect(denied.blast_radius).toBe("medium");
    expect(bank.journals().length).toBe(before);
    expect(bank.audit().some((a) => a.audit_id === denied.audit_id && a.rule_id === "AGENT_TOOL_DENIED")).toBe(
      true,
    );
    bank.close();
  });
});
