import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Bank } from "./bank.js";
import {
  ACC_ALICE_BOND,
  ACC_ALICE_CHK,
  ACC_ALICE_EQ,
  ACC_ALICE_MMF,
  ALICE_SLEEVES,
  CHECKING_BUFFER_KRW,
  IDLE_IDEMPOTENCY_KEY,
  REBALANCE_IDEMPOTENCY_KEY,
  idleSweepAmount,
  listProposals,
  rebalancePlan,
} from "./treasury.js";
import { COPY_PENDING, COPY_POSTED } from "./types.js";

function seeded(): Bank {
  const bank = new Bank(":memory:");
  bank.seed();
  return bank;
}

describe("treasury proposals", () => {
  it("idle cash keeps an 8M buffer and proposes the rest to MMF", () => {
    const bank = seeded();
    expect(idleSweepAmount(bank.db)).toBe(10_000_000 - CHECKING_BUFFER_KRW);
    expect(idleSweepAmount(bank.db)).toBe(2_000_000);
    const proposals = listProposals(bank.db, "syn_alice");
    const idle = proposals.find((p) => p.id === "treasury-idle");
    expect(idle?.amount).toBe(2_000_000);
    expect(idle?.from_account_id).toBe(ACC_ALICE_CHK);
    expect(idle?.to_account_id).toBe(ACC_ALICE_MMF);
    expect(idle?.idempotency_key).toBe(IDLE_IDEMPOTENCY_KEY);
    expect(idle?.why).toContain("버퍼");
    expect(idle?.from_label).toBe("한빛 입출금통장");
    expect(idle?.to_label).toBe("한빛 파킹MMF");
    expect(idle?.legs[0]?.label).toBe("한빛 입출금통장 → 한빛 파킹MMF");
    expect(idle?.amount_label).toBe("2,000,000원");
    expect(idle?.timeline).toBeNull();
    bank.close();
  });

  it("rebalance sells 100000 equity into bond vs 70/30", () => {
    const bank = seeded();
    const plan = rebalancePlan(bank.db);
    expect(plan.equity).toBe(800_000);
    expect(plan.bond).toBe(200_000);
    expect(plan.target_equity).toBe(700_000);
    expect(plan.target_bond).toBe(300_000);
    expect(plan.amount).toBe(100_000);
    expect(plan.from_account_id).toBe(ACC_ALICE_EQ);
    expect(plan.to_account_id).toBe(ACC_ALICE_BOND);
    const proposals = listProposals(bank.db, "syn_alice");
    const reb = proposals.find((p) => p.id === "rebalance");
    expect(reb?.amount).toBe(100_000);
    expect(reb?.idempotency_key).toBe(REBALANCE_IDEMPOTENCY_KEY);
    expect(reb?.legs).toHaveLength(1);
    expect(reb?.from_label).toBe("청운 코스피200 ETF");
    expect(reb?.to_label).toBe("청운 국고채 ETF");
    expect(reb?.legs[0]?.label).toBe("청운 코스피200 ETF → 청운 국고채 ETF");
    bank.close();
  });

  it("execute idle cash goes through policy and sits PENDING over 1M", () => {
    const bank = seeded();
    const result = bank.executeProposal("syn_alice", "treasury-idle");
    expect(result.ok).toBe(true);
    expect(result.journal_status).toBe("PENDING");
    expect(result.decision).toBe("DUAL_CONTROL");
    expect(result.rule_id).toBe("DUAL_AMOUNT");
    expect(result.copy).toBe(COPY_PENDING);
    expect(result.decision_ref).toBeTruthy();
    const journal = bank.journal(result.journal_id!);
    expect(journal?.idempotency_key).toBe(IDLE_IDEMPOTENCY_KEY);
    expect(journal?.decision_ref).toBe(result.decision_ref);
    expect(bank.account(ACC_ALICE_CHK)?.available).toBe(10_000_000);
    expect(bank.account(ACC_ALICE_CHK)?.pending_out).toBe(2_000_000);
    expect(bank.account(ACC_ALICE_MMF)?.available).toBe(100_000);
    const idleView = bank.proposals("syn_alice").find((p) => p.id === "treasury-idle");
    expect(idleView?.timeline?.map((s) => s.label)).toEqual(["접수", "승인 대기", "완료"]);
    expect(idleView?.timeline?.find((s) => s.state === "current")?.label).toBe("승인 대기");
    const activity = bank.executions("syn_alice").find((e) => e.proposal_id === "treasury-idle");
    expect(activity?.counterparty).toBe("한빛 입출금통장 → 한빛 파킹MMF");
    expect(activity?.amount_label).toBe("2,000,000원");
    expect(activity?.rail_note).toContain("오픈뱅킹");
    const replay = bank.executeProposal("syn_alice", "treasury-idle");
    expect(replay.journal_id).toBe(result.journal_id);
    expect(replay.decision_ref).toBe(result.decision_ref);
    bank.close();
  });

  it("execute rebalance posts a book-entry between brokerage sleeves", () => {
    const bank = seeded();
    const result = bank.executeProposal("syn_alice", "rebalance");
    expect(result.ok).toBe(true);
    expect(result.journal_status).toBe("POSTED");
    expect(result.decision).toBe("ALLOW");
    expect(result.copy).toBe(COPY_POSTED);
    expect(bank.account(ACC_ALICE_EQ)?.available).toBe(700_000);
    expect(bank.account(ACC_ALICE_BOND)?.available).toBe(300_000);
    const replay = bank.executeProposal("syn_alice", "rebalance");
    expect(replay.journal_id).toBe(result.journal_id);
    expect(bank.account(ACC_ALICE_EQ)?.available).toBe(700_000);
    const picture = bank.money("syn_alice");
    expect(picture.brokerage.current_equity_bps).toBe(7000);
    const rebView = bank.proposals("syn_alice").find((p) => p.id === "rebalance");
    expect(rebView?.timeline?.map((s) => s.label)).toEqual(["접수", "진행", "완료"]);
    expect(rebView?.timeline?.find((s) => s.state === "current")?.label).toBe("완료");
    const activity = bank.executions("syn_alice").find((e) => e.proposal_id === "rebalance");
    expect(activity?.counterparty).toBe("청운 코스피200 ETF → 청운 국고채 ETF");
    expect(activity?.amount_label).toBe("100,000원");
    bank.close();
  });

  it("dismiss hides a live proposal and does not move money", () => {
    const bank = seeded();
    bank.dismissProposal("syn_alice", "treasury-idle");
    const proposals = bank.proposals("syn_alice");
    expect(proposals.some((p) => p.id === "treasury-idle")).toBe(false);
    expect(bank.account(ACC_ALICE_CHK)?.available).toBe(10_000_000);
    expect(bank.account(ACC_ALICE_MMF)?.available).toBe(100_000);
    bank.close();
  });

  it("fixture sleeve names match ALICE_SLEEVES", () => {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/v0.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      accounts: { id: string; label?: string; institution?: string; product_name?: string }[];
    };
    for (const sleeve of ALICE_SLEEVES) {
      const row = fixture.accounts.find((a) => a.id === sleeve.account_id);
      expect(row?.label).toBe(sleeve.label);
      expect(row?.institution).toBe(sleeve.institution);
      expect(row?.product_name).toBe(sleeve.product_name);
    }
  });

  it("money picture is Alice sleeves only; Bob has no treasury proposals", () => {
    const bank = seeded();
    const alice = bank.money("syn_alice");
    expect(alice.checking?.available).toBe(10_000_000);
    expect(alice.checking?.label).toBe("한빛 입출금통장");
    expect(alice.checking?.institution).toBe("한빛은행");
    expect(alice.mmf?.apy_bps).toBe(350);
    expect(alice.mmf?.label).toBe("한빛 파킹MMF");
    expect(alice.brokerage.equity?.available).toBe(800_000);
    expect(alice.brokerage.equity?.label).toBe("청운 코스피200 ETF");
    expect(alice.brokerage.bond?.available).toBe(200_000);
    expect(alice.brokerage.bond?.label).toBe("청운 국고채 ETF");
    expect(alice.brokerage.equity?.institution).toBe("청운증권");
    expect(bank.proposals("syn_bob")).toEqual([]);
    bank.close();
  });
});
