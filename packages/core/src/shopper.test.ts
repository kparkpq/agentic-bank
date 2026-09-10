import { describe, expect, it } from "vitest";
import { Bank } from "./bank.js";
import { COPY_KYC_DENIED, COPY_KYC_PASSED, COPY_KYC_REQUIRED, COPY_POSTED } from "./types.js";
import { SHOP_DEPOSIT_KEY, listShopHoldings, listShopProducts } from "./shopper.js";
import { KYC_ACKNOWLEDGEMENTS, SYN_ID_PLACEHOLDER } from "./kyc.js";
import { PENSION_SAVINGS_ROOM_KRW, TAX_ADVICE_DISCLAIMER } from "./bookkeeper.js";

const DEPOSIT_DOCS = ["id_card", "resident_copy", "purpose_form"];
const ALL_ACKS = KYC_ACKNOWLEDGEMENTS.map((a) => a.id);

function seeded(): Bank {
  const bank = new Bank(":memory:");
  bank.seed();
  return bank;
}

describe("shopper", () => {
  it("lists 예금 보험 대출 from three different institutions", () => {
    const bank = seeded();
    const products = listShopProducts(bank.db, "syn_alice");
    expect(products.map((p) => p.kind).sort()).toEqual(["deposit", "insurance", "loan"]);
    const institutions = new Set(products.map((p) => p.institution));
    expect(institutions.size).toBe(3);
    expect(institutions.has("코어은행")).toBe(false);
    expect(institutions.has("한빛은행")).toBe(false);
    expect(products.find((p) => p.kind === "deposit")?.why).toContain("한빛 파킹MMF");
    expect(products.every((p) => p.documents.length >= 2)).toBe(true);
    expect(bank.shopProducts("syn_bob")).toEqual([]);
    bank.close();
  });

  it("가입 진행 without all documents does not enroll and does not move money", () => {
    const bank = seeded();
    const before = bank.account("acc_alice_chk")?.available;
    const result = bank.enrollProduct("syn_alice", "prod_deposit_hanbit", ["id_card"]);
    expect(result.ok).toBe(false);
    expect(result.rule_id).toBe("DOCUMENTS_INCOMPLETE");
    expect(result.copy).toContain("서류를 모두 확인해야 합니다");
    expect(result.journal_id ?? null).toBeNull();
    expect(bank.account("acc_alice_chk")?.available).toBe(before);
    expect(bank.executions("syn_alice").some((e) => e.kind === "enrollment")).toBe(false);
    bank.close();
  });

  it("가입 진행 with documents stops at 실명 확인 and records 실행 기록", () => {
    const bank = seeded();
    const docs = ["id_card", "resident_copy", "purpose_form"];
    const result = bank.enrollProduct("syn_alice", "prod_deposit_hanbit", docs);
    expect(result.ok).toBe(false);
    expect(result.copy).toBe(COPY_KYC_REQUIRED);
    expect(result.rule_id).toBe("KYC_REQUIRED");
    expect(result.journal_id ?? null).toBeNull();
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    const activity = bank.executions("syn_alice");
    const enroll = activity.find((e) => e.kind === "enrollment");
    expect(enroll?.copy).toBe(COPY_KYC_REQUIRED);
    expect(enroll?.idempotency_key).toBe(SHOP_DEPOSIT_KEY);
    expect(enroll?.why).toContain("실명 확인");
    const replay = bank.enrollProduct("syn_alice", "prod_deposit_hanbit", docs);
    expect(replay.audit_id).toBe(result.audit_id);
    expect(replay.copy).toBe(COPY_KYC_REQUIRED);
    bank.close();
  });

  it("rejects real-looking PII and never stores a resident-registration number", () => {
    const bank = seeded();
    const result = bank.submitKyc("syn_alice", {
      display_name: "앨리스",
      id_placeholder: "900101-1234567",
      acknowledgements: ALL_ACKS,
    });
    expect(result.ok).toBe(false);
    expect(result.rule_id).toBe("PII_FORBIDDEN");
    expect(bank.kyc("syn_alice").status).toBe("INCOMPLETE");
    const audit = bank.audit().find((a) => a.audit_id === result.audit_id);
    expect(JSON.stringify(audit?.args)).not.toContain("900101");
    bank.close();
  });

  it("sandbox KYC pass unlocks 한빛 정기예금 enrollment without moving money", () => {
    const bank = seeded();
    const before = bank.account("acc_alice_chk")?.available;
    const blocked = bank.enrollProduct("syn_alice", "prod_deposit_hanbit", DEPOSIT_DOCS);
    expect(blocked.rule_id).toBe("KYC_REQUIRED");
    const incomplete = bank.submitKyc("syn_alice", { acknowledgements: ["ack_sandbox"] });
    expect(incomplete.rule_id).toBe("KYC_INCOMPLETE");
    const kyc = bank.submitKyc("syn_alice", {
      display_name: "앨리스",
      phone: "syn_phone_01000000000",
      email: "syn_alice@sandbox.invalid",
      id_placeholder: SYN_ID_PLACEHOLDER,
      acknowledgements: ALL_ACKS,
    });
    expect(kyc.ok).toBe(true);
    expect(kyc.copy).toBe(COPY_KYC_PASSED);
    expect(kyc.rule_id).toBe("KYC_PASSED");
    expect(bank.kyc("syn_alice").status).toBe("PASSED");
    expect(bank.kyc("syn_alice").can_enroll).toBe(true);
    const replayKyc = bank.submitKyc("syn_alice", { acknowledgements: ALL_ACKS });
    expect(replayKyc.audit_id).toBe(kyc.audit_id);
    const done = bank.enrollProduct("syn_alice", "prod_deposit_hanbit", []);
    expect(done.ok).toBe(true);
    expect(done.copy).toBe(COPY_POSTED);
    expect(done.rule_id).toBe("ENROLL_COMPLETE");
    expect(done.journal_status).toBe("POSTED");
    expect(done.journal_id ?? null).toBeNull();
    expect(bank.account("acc_alice_chk")?.available).toBe(before);
    const holding = listShopHoldings(bank.db, "syn_alice")[0];
    expect(holding?.title).toBe("한빛 정기예금");
    expect(bank.money("syn_alice").shop_holdings.some((h) => h.title === "한빛 정기예금")).toBe(true);
    const activity = bank.executions("syn_alice").find((e) => e.kind === "enrollment");
    expect(activity?.copy).toBe(COPY_POSTED);
    expect(activity?.rule_id).toBe("ENROLL_COMPLETE");
    expect(activity?.why).toContain("데모 가입");
    expect(bank.books("syn_alice").enrollments.some((e) => e.product_title === "한빛 정기예금")).toBe(true);
    const replay = bank.enrollProduct("syn_alice", "prod_deposit_hanbit", DEPOSIT_DOCS);
    expect(replay.audit_id).toBe(done.audit_id);
    bank.close();
  });

  it("denied sandbox KYC keeps enrollment blocked", () => {
    const bank = seeded();
    bank.enrollProduct("syn_alice", "prod_deposit_hanbit", DEPOSIT_DOCS);
    const denied = bank.submitKyc("syn_alice", { acknowledgements: ALL_ACKS, scenario: "deny" });
    expect(denied.ok).toBe(false);
    expect(denied.copy).toBe(COPY_KYC_DENIED);
    expect(denied.rule_id).toBe("KYC_DENIED");
    const again = bank.enrollProduct("syn_alice", "prod_deposit_hanbit", DEPOSIT_DOCS);
    expect(again.ok).toBe(false);
    expect(again.rule_id).toBe("KYC_DENIED");
    expect(again.journal_id ?? null).toBeNull();
    expect(listShopHoldings(bank.db, "syn_alice")).toEqual([]);
    bank.close();
  });
});

describe("bookkeeper", () => {
  it("가계부 reads ledger; 절세 notes are labeled not tax advice; 서류 defaults 미챙김", () => {
    const bank = seeded();
    bank.executeProposal("syn_alice", "rebalance");
    const books = bank.books("syn_alice");
    expect(books.household.internal_total).toBe(100_000);
    expect(books.household.flows.some((f) => f.kind === "internal")).toBe(true);
    expect(books.tax_notes.some((n) => n.body.includes("연금저축"))).toBe(true);
    expect(books.tax_notes.every((n) => n.disclaimer === TAX_ADVICE_DISCLAIMER)).toBe(true);
    expect(PENSION_SAVINGS_ROOM_KRW).toBe(6_000_000);
    expect(books.documents.map((d) => d.label)).toEqual(["이체 확인", "보험 증권", "연말정산 자료"]);
    expect(books.documents.every((d) => d.held_label === "미챙김")).toBe(true);
    const after = bank.setBookDocument("syn_alice", "insurance_policy", true);
    expect(after.find((d) => d.id === "insurance_policy")?.held_label).toBe("챙김");
    bank.close();
  });
});
