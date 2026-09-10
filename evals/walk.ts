import { Bank } from "@sapiensq/core";

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const bank = new Bank(":memory:");
bank.seed();

console.log("1. seed");
must(bank.account("acc_alice_chk")?.available === 10_000_000, "alice chk seed");
must(bank.account("acc_alice_sav")?.available === 200_000, "alice sav seed");
must(bank.account("acc_alice_mmf")?.available === 100_000, "alice mmf seed");
must(bank.account("acc_alice_eq")?.available === 800_000, "alice eq seed");
must(bank.account("acc_alice_bond")?.available === 200_000, "alice bond seed");

console.log("2. balance");
const session = bank.startSession("syn_alice");
const bal = bank.tool(session.id, "balance", { account_id: "acc_alice_chk" });
must(bal.audit_id, "balance audit_id");
must(bal.ok, "balance ok");

console.log("2b. teller DENY_POLICY is audit-only");
const tellerDenied = bank.tool(session.id, "transfer", {
  from_account_id: "acc_alice_chk",
  to_account_id: "acc_alice_sav",
  amount: 100_000,
  idempotency_key: "walk:teller-denied:v0",
});
must(tellerDenied.decision === "DENY_POLICY", "teller DENY_POLICY");
must(tellerDenied.rule_id === "AGENT_TOOL_DENIED", "AGENT_TOOL_DENIED");
must(tellerDenied.audit_id, "AGENT_TOOL_DENIED audit_id");
must(!tellerDenied.journal_id, "teller transfer must not journal");
must(bank.journals().length === 1, "DENY_POLICY leaves only seed journal");

console.log("3. small transfer posted");
bank.tool(session.id, "handoff", { to: "transfer" });
const small = bank.tool(session.id, "transfer", {
  from_account_id: "acc_alice_chk",
  to_account_id: "acc_alice_sav",
  amount: 100_000,
  idempotency_key: "walk:small:v0",
});
must(small.journal_status === "POSTED", "small posted");
must(small.copy.includes("완료"), "copy 완료");
must(bank.account("acc_alice_chk")?.available === 9_900_000, "chk after small");
must(bank.account("acc_alice_sav")?.available === 300_000, "sav after small");

console.log("4. 1M pending");
const pending = bank.tool(session.id, "transfer", {
  from_account_id: "acc_alice_chk",
  to_account_id: "acc_alice_sav",
  amount: 1_000_000,
  idempotency_key: "walk:dual:v0",
});
must(pending.journal_status === "PENDING", "1M pending");
must(pending.decision === "DUAL_CONTROL", "dual control");
must(pending.copy.includes("승인 대기"), "copy 승인 대기");
must(!pending.copy.includes("이체 완료"), "pending copy must not be 이체 완료");
must(!pending.copy.includes("이중통제 대기"), "pending copy must not be 이중통제 대기");
must(pending.decision_ref, "decide audit_id on journal");
must(bank.account("acc_alice_chk")?.pending_out === 1_000_000, "pending_out");

console.log("5. operator approve");
const self = bank.approve(pending.journal_id!, { actor: "agent" });
must(!self.ok, "self-approve must fail");
must(self.copy.includes("본인 건은 승인할 수 없음"), "self-approve copy");
must(!bank.audit().some((a) => a.decision === "OPERATOR_APPROVE"), "self-approve writes no OPERATOR_APPROVE");
const approved = bank.approve(pending.journal_id!);
must(approved.journal_status === "POSTED", "approved posted");
must(approved.audit_id !== pending.audit_id, "new audit_id");
must(approved.decision_ref === pending.decision_ref, "decision_ref must not change on approve");
must(bank.account("acc_alice_chk")?.available === 8_900_000, "chk after approve");
must(bank.account("acc_alice_sav")?.available === 1_300_000, "sav after approve");

console.log("6. audit rows exist");
const audit = bank.audit();
must(audit.length >= 5, `expected several audit rows, got ${audit.length}`);
must(audit.every((a) => a.audit_id), "Missing audit_id = fail");
const decisions = new Set(audit.map((a) => a.decision));
must(decisions.has("ALLOW"), "ALLOW audit");
must(decisions.has("DUAL_CONTROL"), "DUAL_CONTROL audit");
must(decisions.has("OPERATOR_APPROVE"), "OPERATOR_APPROVE audit");
must(decisions.has("DENY_LIMIT"), "self-approve DENY audit");

console.log("7. frozen account is DENY_POLICY ACCOUNT_FROZEN, audit-only");
const freeze = bank.setStatus("acc_bob_chk", "FROZEN");
must(freeze.ok, "freeze ok");
must(!freeze.journal_id, "freeze is not a journal");
const bob = bank.startSession("syn_bob");
bank.tool(bob.id, "handoff", { to: "transfer" });
const frozen = bank.tool(bob.id, "transfer", {
  from_account_id: "acc_bob_chk",
  to_account_id: "acc_bob_sav",
  amount: 100_000,
  idempotency_key: "walk:frozen:v0",
});
must(frozen.decision === "DENY_POLICY", "frozen DENY_POLICY");
must(frozen.rule_id === "ACCOUNT_FROZEN", "ACCOUNT_FROZEN");
must(frozen.blast_radius === "medium", "ACCOUNT_FROZEN blast_radius medium");
must(frozen.audit_id, "frozen audit_id");
must(!frozen.journal_id, "frozen must not journal");
const frozenReplay = bank.tool(bob.id, "transfer", {
  from_account_id: "acc_bob_chk",
  to_account_id: "acc_bob_sav",
  amount: 100_000,
  idempotency_key: "walk:frozen:v0",
});
must(frozenReplay.audit_id === frozen.audit_id, "frozen replay reuses decide audit_id");
must(!frozenReplay.journal_id, "frozen replay no journal");
must(bank.account("acc_bob_chk")?.available === 500_000, "bob chk unchanged");

console.log("8. treasury idle PENDING + rebalance POSTED");
const treasury = new Bank(":memory:");
treasury.seed();
const idle = treasury.executeProposal("syn_alice", "treasury-idle");
must(idle.journal_status === "PENDING", "idle pending");
must(idle.copy.includes("승인 대기"), "idle copy 승인 대기");
must(idle.decision === "DUAL_CONTROL", "idle dual-control");
must(treasury.account("acc_alice_chk")?.pending_out === 2_000_000, "idle pending_out");
must(treasury.account("acc_alice_mmf")?.available === 100_000, "mmf unmoved while pending");
const reb = treasury.executeProposal("syn_alice", "rebalance");
must(reb.journal_status === "POSTED", "rebalance posted");
must(reb.copy.includes("완료"), "rebalance copy 완료");
must(treasury.account("acc_alice_eq")?.available === 700_000, "eq after rebalance");
must(treasury.account("acc_alice_bond")?.available === 300_000, "bond after rebalance");
const idleWhy = treasury.audit().find((a) => a.audit_id === idle.decision_ref);
must(idleWhy?.action === "policy.decide", "idle why is policy.decide");
treasury.close();

console.log("9. shopper KYC stop does not enroll or move money");
const shop = new Bank(":memory:");
shop.seed();
const incomplete = shop.enrollProduct("syn_alice", "prod_deposit_hanbit", ["id_card"]);
must(incomplete.rule_id === "DOCUMENTS_INCOMPLETE", "docs incomplete");
must(!incomplete.journal_id, "incomplete no journal");
const kyc = shop.enrollProduct("syn_alice", "prod_deposit_hanbit", [
  "id_card",
  "resident_copy",
  "purpose_form",
]);
must(kyc.copy.includes("실명 확인이 필요합니다"), "kyc copy");
must(kyc.rule_id === "KYC_REQUIRED", "KYC_REQUIRED");
must(!kyc.journal_id, "kyc no journal");
must(shop.account("acc_alice_chk")?.available === 10_000_000, "chk unchanged after shop");
must(shop.executions("syn_alice").some((e) => e.copy.includes("실명 확인")), "activity has kyc");
const books = shop.books("syn_alice");
must(books.tax_notes.every((n) => n.disclaimer.includes("세무 자문이 아닙니다")), "tax disclaimer");
must(books.documents.some((d) => d.label === "이체 확인"), "book docs");

console.log("10. sandbox KYC pass then enroll POSTED without moving money");
const passed = shop.submitKyc("syn_alice", {
  acknowledgements: ["ack_sandbox", "ack_no_rrn", "ack_not_bank"],
});
must(passed.rule_id === "KYC_PASSED", "KYC_PASSED");
must(passed.copy.includes("실명 확인이 완료되었습니다"), "kyc passed copy");
const enrolled = shop.enrollProduct("syn_alice", "prod_deposit_hanbit", [
  "id_card",
  "resident_copy",
  "purpose_form",
]);
must(enrolled.ok, "enroll ok");
must(enrolled.rule_id === "ENROLL_COMPLETE", "ENROLL_COMPLETE");
must(enrolled.journal_status === "POSTED", "enroll POSTED");
must(!enrolled.journal_id, "enroll completes without transfer journal");
must(shop.account("acc_alice_chk")?.available === 10_000_000, "chk unchanged after enroll");
must(
  shop.money("syn_alice").shop_holdings.some((h) => h.title === "한빛 정기예금"),
  "money shows 한빛 정기예금",
);
must(
  shop.executions("syn_alice").some((e) => e.kind === "enrollment" && e.copy.includes("완료")),
  "activity has enrolled",
);
must(
  shop.books("syn_alice").enrollments.some((e) => e.product_title === "한빛 정기예금"),
  "books has enrollment",
);
shop.close();

console.log("\nWALK PASS — seed → balance → posted → pending → approve → audit → frozen → treasury → shop → kyc enroll");
bank.close();
