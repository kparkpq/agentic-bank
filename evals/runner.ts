import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bank, entrySides, pendingDebits, type ToolResult } from "@sapiensq/core";

type Step = {
  do: string;
  args?: Record<string, unknown>;
  expect?: Record<string, unknown>;
};

type Golden = {
  id: string;
  description: string;
  customer_id: string;
  fail_if?: string[];
  steps: Step[];
  expect_balances: Record<string, { available: number; pending_out?: number }>;
};

const here = dirname(fileURLToPath(import.meta.url));

function loadGoldens(): Golden[] {
  const dir = join(here, "golden");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Golden);
}

function fail(id: string, message: string): never {
  throw new Error(`[${id}] ${message}`);
}

type EvalCtx = {
  bank: Bank;
  sessionId?: string;
  lastJournalId?: string;
  lastTransferAuditId?: string;
  lastApproveAuditId?: string;
  lastDecisionRef?: string;
  lastFrom?: string;
  journalCount?: number;
};

function assertUnappliedPair(id: string, step: string, ctx: EvalCtx, journalId: string): void {
  const entries = ctx.bank.journalEntries(journalId);
  if (entries.length !== 2) {
    fail(id, `${step}: journal must have 2 posting rows, got ${entries.length}`);
  }
  const { debit, credit } = entrySides(entries);
  if (debit !== credit) {
    fail(id, `${step}: entries debit ${debit} != credit ${credit}`);
  }
  if (entries.some((e) => Number(e.posted) !== 0)) {
    fail(id, `${step}: entries must be unapplied (posted=0)`);
  }
}

function assertDecideRef(id: string, step: string, ctx: EvalCtx, journalId: string, result: ToolResult): void {
  const journal = ctx.bank.journal(journalId);
  if (!journal?.decision_ref) {
    fail(id, `${step}: missing journal.decision_ref`);
  }
  const decide = ctx.bank.audit().find((a) => a.audit_id === journal.decision_ref);
  if (!decide || decide.action !== "policy.decide") {
    fail(id, `${step}: decision_ref ${journal.decision_ref} is not a policy.decide audit_id`);
  }
  if (result.decision_ref && result.decision_ref !== journal.decision_ref) {
    fail(id, `${step}: result.decision_ref != journal.decision_ref`);
  }
}

function assertStep(id: string, step: Step, result: ToolResult, ctx: EvalCtx, prev: EvalCtx): void {
  if (!result.audit_id) {
    fail(id, `${step.do}: Missing audit_id = fail`);
  }
  const storedAudit = ctx.bank.audit().find((a) => a.audit_id === result.audit_id);
  if (!storedAudit) {
    fail(id, `${step.do}: audit_id ${result.audit_id} was not written to the audit log`);
  }
  if (result.rule_id === "AGENT_TOOL_DENIED" && storedAudit && !storedAudit.audit_id) {
    fail(id, `${step.do}: AGENT_TOOL_DENIED must not leave empty audit_id`);
  }
  const exp = step.expect;
  if (!exp) return;
  if (exp.journal_status && result.journal_status !== exp.journal_status) {
    fail(id, `${step.do}: journal_status ${result.journal_status} != ${exp.journal_status}`);
  }
  if (exp.decision && result.decision !== exp.decision) {
    fail(id, `${step.do}: decision ${result.decision} != ${exp.decision}`);
  }
  if (exp.not_decision && result.decision === exp.not_decision) {
    fail(id, `${step.do}: decision must not be ${exp.not_decision}`);
  }
  if (exp.rule_id && result.rule_id !== exp.rule_id) {
    fail(id, `${step.do}: rule_id ${result.rule_id} != ${exp.rule_id}`);
  }
  if (exp.copy_contains && !result.copy.includes(String(exp.copy_contains))) {
    fail(id, `${step.do}: copy "${result.copy}" missing "${exp.copy_contains}"`);
  }
  if (exp.copy_excludes && result.copy.includes(String(exp.copy_excludes))) {
    fail(id, `${step.do}: copy "${result.copy}" must not contain "${exp.copy_excludes}"`);
  }
  if (exp.ok === false && result.ok) {
    fail(id, `${step.do}: expected failure`);
  }
  if (exp.no_journal) {
    if (result.journal_id) fail(id, `${step.do}: expected no journal, got ${result.journal_id}`);
    const count = ctx.bank.journals().length;
    if (prev.journalCount !== undefined && count !== prev.journalCount) {
      fail(id, `${step.do}: DENY_POLICY must be audit-only; journals ${count} != ${prev.journalCount}`);
    }
  }
  if (exp.pending_out !== undefined) {
    const from = String(step.args?.from_account_id ?? ctx.lastFrom);
    const pending = ctx.bank.account(from)?.pending_out;
    if (pending !== exp.pending_out) {
      fail(id, `${step.do}: pending_out ${pending} != ${exp.pending_out}`);
    }
  }
  if (exp.idempotent || exp.same_journal_id) {
    if (result.journal_id !== prev.lastJournalId) {
      fail(id, `${step.do}: journal_id ${result.journal_id} != ${prev.lastJournalId}`);
    }
  }
  if (exp.new_audit_id) {
    if (!result.audit_id || result.audit_id === prev.lastTransferAuditId || result.audit_id === prev.lastDecisionRef) {
      fail(id, `${step.do}: expected new operator audit_id, got ${result.audit_id}`);
    }
  }
  if (exp.same_audit_id) {
    const previous = prev.lastApproveAuditId ?? prev.lastTransferAuditId;
    if (!previous || result.audit_id !== previous) {
      fail(id, `${step.do}: replay audit_id ${result.audit_id} != ${previous}`);
    }
  }
  if (exp.blast_radius) {
    const got = result.blast_radius ?? storedAudit.blast_radius;
    if (got !== exp.blast_radius) {
      fail(id, `${step.do}: blast_radius ${got} != ${exp.blast_radius}`);
    }
  }
  const journalId = result.journal_id ?? prev.lastJournalId;
  if (exp.decision_ref_is_decide) {
    if (!journalId) fail(id, `${step.do}: no journal for decision_ref`);
    assertDecideRef(id, step.do, ctx, journalId, result);
  }
  if (exp.same_decision_ref) {
    const ref = result.decision_ref ?? (journalId ? ctx.bank.journal(journalId)?.decision_ref : undefined);
    if (!prev.lastDecisionRef || ref !== prev.lastDecisionRef) {
      fail(id, `${step.do}: decision_ref ${ref} != ${prev.lastDecisionRef}`);
    }
    if (journalId && ctx.bank.journal(journalId)?.decision_ref !== prev.lastDecisionRef) {
      fail(id, `${step.do}: journal.decision_ref changed on ${step.do}`);
    }
  }
  if (exp.denied_entries || exp.unapplied_entries) {
    if (!journalId) fail(id, `${step.do}: no journal for unapplied entries`);
    assertUnappliedPair(id, step.do, ctx, journalId);
  }
  if (exp.pending_out_matches_debits) {
    const from = String(step.args?.from_account_id ?? ctx.lastFrom);
    const pending = ctx.bank.account(from)?.pending_out;
    const debits = pendingDebits(ctx.bank.db, from);
    if (pending !== debits) {
      fail(id, `${step.do}: pending_out ${pending} != pending debits ${debits}`);
    }
  }
  if (exp.no_operator_approve) {
    if (ctx.bank.audit().some((a) => a.decision === "OPERATOR_APPROVE")) {
      fail(id, `${step.do}: self-approve must write no OPERATOR_APPROVE row`);
    }
    if (journalId && ctx.bank.journal(journalId)?.status !== "PENDING") {
      fail(id, `${step.do}: self-approve must leave PENDING`);
    }
  }
}

function runGolden(g: Golden): void {
  const bank = new Bank(":memory:");
  bank.seed();
  const ctx: EvalCtx = { bank };

  for (const step of g.steps) {
    if (step.do === "session.start") {
      const session = bank.startSession(g.customer_id);
      ctx.sessionId = session.id;
      continue;
    }
    if (!ctx.sessionId) fail(g.id, "session.start required");
    ctx.journalCount = bank.journals().length;
    const prev = { ...ctx };

    if (step.do === "handoff") {
      const result = bank.tool(ctx.sessionId, "handoff", step.args ?? {});
      assertStep(g.id, step, result, ctx, prev);
      continue;
    }
    if (step.do === "shop.enroll") {
      const productId = String(step.args?.product_id ?? "");
      const checked = Array.isArray(step.args?.checked_documents)
        ? (step.args?.checked_documents as unknown[]).map((d) => String(d))
        : [];
      const result = bank.enrollProduct(g.customer_id, productId, checked);
      assertStep(g.id, step, result, ctx, prev);
      ctx.lastTransferAuditId = result.audit_id;
      continue;
    }
    if (step.do === "kyc.submit") {
      const acks = Array.isArray(step.args?.acknowledgements)
        ? (step.args?.acknowledgements as unknown[]).map((d) => String(d))
        : [];
      const result = bank.submitKyc(g.customer_id, {
        display_name: typeof step.args?.display_name === "string" ? step.args.display_name : undefined,
        phone: typeof step.args?.phone === "string" ? step.args.phone : undefined,
        email: typeof step.args?.email === "string" ? step.args.email : undefined,
        id_placeholder: typeof step.args?.id_placeholder === "string" ? step.args.id_placeholder : undefined,
        acknowledgements: acks,
        scenario: typeof step.args?.scenario === "string" ? step.args.scenario : undefined,
      });
      assertStep(g.id, step, result, ctx, prev);
      ctx.lastTransferAuditId = result.audit_id;
      continue;
    }
    if (step.do === "account.freeze" || step.do === "account.close" || step.do === "account.set_status") {
      const accountId = String(step.args?.account_id ?? "");
      const status =
        step.do === "account.freeze"
          ? "FROZEN"
          : step.do === "account.close"
            ? "CLOSED"
            : String(step.args?.status ?? "OPEN");
      if (status !== "OPEN" && status !== "FROZEN" && status !== "CLOSED") {
        fail(g.id, `${step.do}: invalid status ${status}`);
      }
      const result = bank.setStatus(accountId, status);
      assertStep(g.id, step, result, ctx, prev);
      continue;
    }
    if (step.do === "transfer") {
      ctx.lastFrom = String(step.args?.from_account_id ?? "");
      const result = bank.tool(ctx.sessionId, "transfer", step.args ?? {});
      assertStep(g.id, step, result, ctx, prev);
      ctx.lastJournalId = result.journal_id ?? ctx.lastJournalId;
      ctx.lastTransferAuditId = result.audit_id;
      ctx.lastDecisionRef = result.decision_ref ?? ctx.lastDecisionRef;
      if (result.journal_id) {
        ctx.lastDecisionRef = bank.journal(result.journal_id)?.decision_ref ?? ctx.lastDecisionRef;
      }
      continue;
    }
    if (step.do === "agent.approve") {
      if (!ctx.lastJournalId) fail(g.id, "no journal to approve");
      const result = bank.approve(ctx.lastJournalId, { actor: "agent" });
      assertStep(g.id, step, result, ctx, prev);
      if (bank.pending().every((j) => j.id !== ctx.lastJournalId) && bank.journal(ctx.lastJournalId)?.status !== "PENDING") {
        fail(g.id, "self-approve must leave journal PENDING");
      }
      continue;
    }
    if (step.do === "operator.approve") {
      if (!ctx.lastJournalId) fail(g.id, "no journal to approve");
      const result = bank.approve(ctx.lastJournalId);
      assertStep(g.id, step, result, ctx, prev);
      ctx.lastApproveAuditId = result.audit_id;
      continue;
    }
    if (step.do === "operator.deny") {
      if (!ctx.lastJournalId) fail(g.id, "no journal to deny");
      const result = bank.deny(ctx.lastJournalId);
      assertStep(g.id, step, result, ctx, prev);
      ctx.lastApproveAuditId = result.audit_id;
      continue;
    }
    if (step.do === "replay.approve") {
      if (!ctx.lastJournalId || !ctx.lastApproveAuditId) fail(g.id, "nothing to replay");
      const beforeChk = bank.account("acc_alice_chk")?.available;
      const result = bank.approve(ctx.lastJournalId, { audit_id: ctx.lastApproveAuditId });
      assertStep(g.id, step, result, ctx, prev);
      if (bank.account("acc_alice_chk")?.available !== beforeChk) {
        fail(g.id, "replay changed balances");
      }
      continue;
    }
    fail(g.id, `unknown step ${step.do}`);
  }

  if (g.fail_if?.includes("pending") && bank.pending().length > 0) {
    fail(g.id, "fail_if pending: found PENDING journals");
  }
  if (g.fail_if?.includes("journal")) {
    const extra = bank.journals().filter((j) => j.id !== "journal_seed_opening");
    if (extra.length > 0) {
      fail(g.id, `fail_if journal: found ${extra.length} non-seed journal(s)`);
    }
  }
  if (g.fail_if?.includes("nsf")) {
    const nsf = bank.audit().some((a) => a.decision === "DENY_NSF" || a.rule_id === "NSF");
    if (nsf) fail(g.id, "fail_if nsf: NSF decision recorded");
  }
  if (bank.audit().some((a) => !a.audit_id)) {
    fail(g.id, "Missing audit_id = fail");
  }

  for (const [accountId, want] of Object.entries(g.expect_balances)) {
    const view = bank.account(accountId);
    if (!view) fail(g.id, `missing account ${accountId}`);
    if (view.available !== want.available) {
      fail(g.id, `${accountId} available ${view.available} != ${want.available}`);
    }
    if (want.pending_out !== undefined && view.pending_out !== want.pending_out) {
      fail(g.id, `${accountId} pending_out ${view.pending_out} != ${want.pending_out}`);
    }
  }

  bank.close();
  console.log(`PASS  ${g.id}  — ${g.description}`);
}

function main(): void {
  const goldens = loadGoldens();
  if (goldens.length === 0) {
    throw new Error("no golden files in evals/golden");
  }
  for (const g of goldens) {
    runGolden(g);
  }
  console.log(`\nAll ${goldens.length} golden evals passed.`);
}

main();
