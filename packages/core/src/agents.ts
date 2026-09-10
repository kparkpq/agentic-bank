import { randomUUID } from "node:crypto";
import { findAuditByIdempotency, getAudit, redactArgs, writeAudit } from "./audit.js";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import {
  accountView,
  availableBalance,
  applyPendingJournal,
  getAccount,
  getJournal,
  getJournalByIdempotency,
  pendingOut,
  rejectPendingJournal,
  setAccountStatus,
  writeTransferJournal,
} from "./ledger.js";
import { decide } from "./policy.js";
import { nowUtcIso } from "./time.js";
import {
  AGENT_TOOLS,
  COPY_ACCOUNT_CLOSED,
  COPY_ACCOUNT_FROZEN,
  COPY_ACCOUNT_OPEN,
  COPY_DENIED,
  COPY_PENDING,
  COPY_POSTED,
  type AccountStatus,
  type Actor,
  type AgentName,
  type AuditRow,
  type BlastRadius,
  type Decision,
  type Journal,
  type JournalStatus,
  type Session,
  type ToolName,
} from "./types.js";
export type ToolResult = {
  ok: boolean;
  copy: string;
  decision: Decision;
  rule_id: string;
  reason: string;
  audit_id: string;
  blast_radius?: BlastRadius;
  decision_ref?: string | null;
  journal_id?: string | null;
  journal_status?: JournalStatus;
  data?: unknown;
};

function requireAudit(audit: AuditRow): string {
  if (!audit.audit_id) {
    throw new Error("Missing audit_id = fail");
  }
  return audit.audit_id;
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function sameTransferBody(args: unknown, from: string, to: string, amount: number): boolean {
  const rec = argsRecord(args);
  return rec.from_account_id === from && rec.to_account_id === to && Number(rec.amount) === amount;
}

function idempotencyOf(args: Record<string, unknown>): string {
  return typeof args.idempotency_key === "string" ? args.idempotency_key.trim() : "";
}

function getSession(db: Db, sessionId: string): Session | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Session | undefined;
}

function appendTrace(
  db: Db,
  session: Session,
  action: string,
  args: unknown,
  result: unknown,
): void {
  const seqRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM traces WHERE session_id = ?")
    .get(session.id) as { seq: number };
  db.prepare(
    `INSERT INTO traces (id, session_id, seq, agent, action, args_json, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    session.id,
    Number(seqRow.seq) + 1,
    session.current_agent,
    action,
    JSON.stringify(redactArgs(args ?? {})),
    JSON.stringify(result ?? null),
    nowUtcIso(),
  );
}

function linkDecideAudit(db: Db, decideAuditId: string, journalId: string): void {
  db.prepare("UPDATE audit SET journal_id = ? WHERE id = ? AND journal_id IS NULL").run(
    journalId,
    decideAuditId,
  );
}

function assertAgentTool(
  db: Db,
  session: Session,
  action: ToolName,
  args: Record<string, unknown>,
  actor: Actor,
  audit_id?: string,
): ToolResult | null {
  const allowed = AGENT_TOOLS[session.current_agent];
  if ((allowed as readonly string[]).includes(action)) {
    return null;
  }
  const reason = `${session.current_agent} cannot call ${action}; handoff required`;
  const audit = writeAudit(db, {
    audit_id,
    actor,
    action,
    args,
    decision: "DENY_POLICY",
    rule_id: "AGENT_TOOL_DENIED",
    reason,
    blast_radius: "medium",
    session_id: session.id,
    journal_id: null,
    agent: session.current_agent,
  });
  const id = requireAudit(audit);
  if (!id) {
    throw new Error("Missing audit_id = fail");
  }
  return {
    ok: false,
    copy: "이 에이전트는 해당 도구를 호출할 수 없습니다. 핸드오프가 필요합니다.",
    decision: "DENY_POLICY",
    rule_id: "AGENT_TOOL_DENIED",
    reason,
    audit_id: id,
    blast_radius: audit.blast_radius,
    journal_id: null,
  };
}

function rememberPolicy(
  db: Db,
  sessionId: string,
  from: string,
  to: string,
  amount: number,
  decision: string,
  rule_id: string,
  decide_audit_id: string,
): void {
  db.prepare("DELETE FROM session_policy WHERE session_id = ?").run(sessionId);
  db.prepare(
    `INSERT INTO session_policy (session_id, from_account_id, to_account_id, amount, decision, rule_id, decide_audit_id, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, from, to, amount, decision, rule_id, decide_audit_id, nowUtcIso());
}

function matchingPolicy(
  db: Db,
  sessionId: string,
  from: string,
  to: string,
  amount: number,
): { decide_audit_id: string; decision: string; rule_id: string } | null {
  const row = db.prepare("SELECT * FROM session_policy WHERE session_id = ?").get(sessionId) as
    | {
        from_account_id: string;
        to_account_id: string;
        amount: number;
        decide_audit_id: string;
        decision: string;
        rule_id: string;
      }
    | undefined;
  if (!row) return null;
  if (
    row.from_account_id === from &&
    row.to_account_id === to &&
    Number(row.amount) === amount &&
    row.decide_audit_id
  ) {
    return { decide_audit_id: row.decide_audit_id, decision: row.decision, rule_id: row.rule_id };
  }
  return null;
}

function copyForDecision(decision: string): string {
  if (decision === "ALLOW") return COPY_POSTED;
  if (decision === "DUAL_CONTROL") return COPY_PENDING;
  return COPY_DENIED;
}

export function startSession(db: Db, customerId: string): Session {
  const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId) as
    | { id: string }
    | undefined;
  if (!customer) {
    throw new Error(`unknown customer ${customerId}`);
  }
  const session: Session = {
    id: randomUUID(),
    customer_id: customerId,
    current_agent: "teller",
    created_at: nowUtcIso(),
  };
  db.prepare(
    "INSERT INTO sessions (id, customer_id, current_agent, created_at) VALUES (?, ?, ?, ?)",
  ).run(session.id, session.customer_id, session.current_agent, session.created_at);
  return session;
}

export function executeTool(
  db: Db,
  input: {
    session_id: string;
    action: ToolName;
    args: Record<string, unknown>;
    actor?: Actor;
    audit_id?: string;
  },
): ToolResult {
  return withTx(db, () => executeToolInner(db, input));
}

function executeToolInner(
  db: Db,
  input: {
    session_id: string;
    action: ToolName;
    args: Record<string, unknown>;
    actor?: Actor;
    audit_id?: string;
  },
): ToolResult {
  const actor: Actor = input.actor ?? "agent";
  const session = getSession(db, input.session_id);
  if (!session) {
    throw new Error("unknown session");
  }

  const denied = assertAgentTool(db, session, input.action, input.args, actor, input.audit_id);
  if (denied) {
    appendTrace(db, session, input.action, input.args, denied);
    return denied;
  }

  if (input.action === "balance") {
    return toolBalance(db, session, actor, input.args, input.audit_id);
  }
  if (input.action === "handoff") {
    return toolHandoff(db, session, actor, input.args, input.audit_id);
  }
  if (input.action === "policy.decide") {
    return toolPolicyDecide(db, session, actor, input.args, input.audit_id);
  }
  if (input.action === "transfer") {
    return toolTransfer(db, session, actor, input.args, input.audit_id);
  }
  if (input.action === "open_dispute") {
    return toolOpenDispute(db, session, actor, input.args, input.audit_id);
  }
  throw new Error(`unknown action ${input.action}`);
}

function toolBalance(
  db: Db,
  session: Session,
  actor: Actor,
  args: Record<string, unknown>,
  audit_id?: string,
): ToolResult {
  const accountId = String(args.account_id ?? "");
  const acc = getAccount(db, accountId);
  if (!acc || (acc.customer_id && acc.customer_id !== session.customer_id)) {
    const audit = writeAudit(db, {
      audit_id,
      actor,
      action: "balance",
      args,
      decision: "DENY_POLICY",
      rule_id: "UNKNOWN_ACCOUNT",
      reason: "account not in session customer",
      session_id: session.id,
      agent: session.current_agent,
    });
    const result: ToolResult = {
      ok: false,
      copy: "계좌를 확인할 수 없습니다",
      decision: "DENY_POLICY",
      rule_id: "UNKNOWN_ACCOUNT",
      reason: "account not in session customer",
      audit_id: requireAudit(audit),
    };
    appendTrace(db, session, "balance", args, result);
    return result;
  }
  const view = accountView(db, accountId)!;
  const audit = writeAudit(db, {
    audit_id,
    actor,
    action: "balance",
    args,
    decision: "ALLOW",
    rule_id: "BALANCE",
    reason: "balance inquiry",
    session_id: session.id,
    agent: session.current_agent,
  });
  const result: ToolResult = {
    ok: true,
    copy: "잔액 조회 완료",
    decision: "ALLOW",
    rule_id: "BALANCE",
    reason: "balance inquiry",
    audit_id: requireAudit(audit),
    data: view,
  };
  appendTrace(db, session, "balance", args, result);
  return result;
}

function toolHandoff(
  db: Db,
  session: Session,
  actor: Actor,
  args: Record<string, unknown>,
  audit_id?: string,
): ToolResult {
  const to = String(args.to ?? "") as AgentName;
  if (to !== "transfer" && to !== "dispute" && to !== "teller") {
    const audit = writeAudit(db, {
      audit_id,
      actor,
      action: "handoff",
      args,
      decision: "DENY_POLICY",
      rule_id: "AGENT_TOOL_DENIED",
      reason: `unknown agent ${to}`,
      session_id: session.id,
      agent: session.current_agent,
    });
    const result: ToolResult = {
      ok: false,
      copy: "대상 에이전트를 확인할 수 없습니다",
      decision: "DENY_POLICY",
      rule_id: "AGENT_TOOL_DENIED",
      reason: `unknown agent ${to}`,
      audit_id: requireAudit(audit),
    };
    appendTrace(db, session, "handoff", args, result);
    return result;
  }
  db.prepare("UPDATE sessions SET current_agent = ? WHERE id = ?").run(to, session.id);
  session.current_agent = to;
  const audit = writeAudit(db, {
    audit_id,
    actor,
    action: "handoff",
    args,
    decision: "ALLOW",
    rule_id: "HANDOFF",
    reason: `handoff to ${to}`,
    session_id: session.id,
    agent: to,
  });
  const result: ToolResult = {
    ok: true,
    copy: `${to} 에이전트로 연결되었습니다`,
    decision: "ALLOW",
    rule_id: "HANDOFF",
    reason: `handoff to ${to}`,
    audit_id: requireAudit(audit),
    data: { current_agent: to },
  };
  appendTrace(db, session, "handoff", args, result);
  return result;
}

function toolPolicyDecide(
  db: Db,
  session: Session,
  actor: Actor,
  args: Record<string, unknown>,
  audit_id?: string,
): ToolResult {
  const from_account_id = String(args.from_account_id ?? "");
  const to_account_id = String(args.to_account_id ?? "");
  const amount = Number(args.amount);
  const key = idempotencyOf(args);

  if (key) {
    const existing = findAuditByIdempotency(db, "policy.decide", key, "DENY_POLICY");
    if (
      existing &&
      existing.decision === "DENY_POLICY" &&
      sameTransferBody(existing.args, from_account_id, to_account_id, amount)
    ) {
      rememberPolicy(
        db,
        session.id,
        from_account_id,
        to_account_id,
        amount,
        existing.decision,
        existing.rule_id,
        existing.audit_id,
      );
      const result: ToolResult = {
        ok: false,
        copy: copyForDecision(existing.decision),
        decision: existing.decision,
        rule_id: existing.rule_id,
        reason: existing.reason,
        audit_id: requireAudit(existing),
        blast_radius: existing.blast_radius,
        decision_ref: existing.audit_id,
        journal_id: null,
        data: { replay: true },
      };
      appendTrace(db, session, "policy.decide", args, result);
      return result;
    }
  }

  const policy = decide(db, {
    from_account_id,
    to_account_id,
    amount,
    actor_customer_id: session.customer_id,
  });
  const audit = writeAudit(db, {
    audit_id,
    actor,
    action: "policy.decide",
    args,
    decision: policy.decision,
    rule_id: policy.rule_id,
    reason: policy.reason,
    blast_radius: policy.rule_id === "ACCOUNT_FROZEN" ? "medium" : undefined,
    session_id: session.id,
    agent: session.current_agent,
  });
  const decideId = requireAudit(audit);
  rememberPolicy(
    db,
    session.id,
    from_account_id,
    to_account_id,
    amount,
    policy.decision,
    policy.rule_id,
    decideId,
  );
  const result: ToolResult = {
    ok: policy.decision === "ALLOW" || policy.decision === "DUAL_CONTROL",
    copy: policy.copy,
    decision: policy.decision,
    rule_id: policy.rule_id,
    reason: policy.reason,
    audit_id: decideId,
    blast_radius: audit.blast_radius,
    decision_ref: decideId,
    journal_id: policy.decision === "DENY_POLICY" ? null : undefined,
    data: policy,
  };
  appendTrace(db, session, "policy.decide", args, result);
  return result;
}

function replayCopy(status: JournalStatus): string {
  if (status === "POSTED") return COPY_POSTED;
  if (status === "PENDING") return COPY_PENDING;
  return COPY_DENIED;
}

function replayDecision(journal: Journal): Decision {
  const stored = journal.decision;
  if (
    stored === "ALLOW" ||
    stored === "DENY_NSF" ||
    stored === "DENY_LIMIT" ||
    stored === "DUAL_CONTROL"
  ) {
    return stored;
  }
  if (journal.status === "POSTED") return "ALLOW";
  if (journal.status === "PENDING") return "DUAL_CONTROL";
  if (journal.rule_id === "NSF") return "DENY_NSF";
  if (journal.rule_id === "DAILY_CAP") return "DENY_LIMIT";
  return "DENY_POLICY";
}

function toolTransfer(
  db: Db,
  session: Session,
  actor: Actor,
  args: Record<string, unknown>,
  audit_id?: string,
): ToolResult {
  const from_account_id = String(args.from_account_id ?? "");
  const to_account_id = String(args.to_account_id ?? "");
  const amount = Number(args.amount);
  let idempotency_key =
    typeof args.idempotency_key === "string" ? args.idempotency_key.trim() : "";
  if (!idempotency_key) {
    idempotency_key = `mint:${session.id}:${from_account_id}:${to_account_id}:${amount}`;
  }
  const transferArgs = { ...args, idempotency_key };

  const existing = getJournalByIdempotency(db, idempotency_key);
  if (existing) {
    const sameBody =
      existing.from_account_id === from_account_id &&
      existing.to_account_id === to_account_id &&
      Number(existing.amount) === amount;
    if (!sameBody) {
      const audit = writeAudit(db, {
        audit_id,
        actor,
        action: "transfer",
        args: transferArgs,
        decision: "DENY_POLICY",
        rule_id: "IDEMPOTENCY_CONFLICT",
        reason: "idempotency key reused with a different body",
        session_id: session.id,
        agent: session.current_agent,
      });
      const result: ToolResult = {
        ok: false,
        copy: "멱등 키 충돌",
        decision: "DENY_POLICY",
        rule_id: "IDEMPOTENCY_CONFLICT",
        reason: "idempotency key reused with a different body",
        audit_id: requireAudit(audit),
        decision_ref: existing.decision_ref,
        journal_id: existing.id,
        data: { status: 409 },
      };
      appendTrace(db, session, "transfer", transferArgs, result);
      return result;
    }
    const audit = writeAudit(db, {
      audit_id,
      actor,
      action: "transfer",
      args: transferArgs,
      decision: replayDecision(existing),
      rule_id: existing.rule_id ?? "IDEMPOTENT_REPLAY",
      reason: "idempotent replay",
      session_id: session.id,
      journal_id: existing.id,
      agent: session.current_agent,
    });
    const result: ToolResult = {
      ok: existing.status !== "DENIED",
      copy: replayCopy(existing.status),
      decision: replayDecision(existing),
      rule_id: existing.rule_id ?? "IDEMPOTENT_REPLAY",
      reason: "idempotent replay",
      audit_id: requireAudit(audit),
      decision_ref: existing.decision_ref,
      journal_id: existing.id,
      journal_status: existing.status,
      data: { replay: true, journal: existing },
    };
    appendTrace(db, session, "transfer", transferArgs, result);
    return result;
  }

  const priorDeny = findAuditByIdempotency(db, "transfer", idempotency_key, "DENY_POLICY");
  const priorDecide = findAuditByIdempotency(db, "policy.decide", idempotency_key, "DENY_POLICY");
  if (
    priorDeny &&
    priorDeny.decision === "DENY_POLICY" &&
    sameTransferBody(priorDeny.args, from_account_id, to_account_id, amount)
  ) {
    const decideId = priorDecide && priorDecide.decision === "DENY_POLICY" ? priorDecide.audit_id : priorDeny.audit_id;
    const result: ToolResult = {
      ok: false,
      copy: copyForDecision("DENY_POLICY"),
      decision: "DENY_POLICY",
      rule_id: priorDeny.rule_id,
      reason: priorDeny.reason,
      audit_id: requireAudit(priorDeny),
      blast_radius: priorDeny.blast_radius,
      decision_ref: decideId,
      journal_id: null,
      data: { replay: true },
    };
    appendTrace(db, session, "transfer", transferArgs, result);
    return result;
  }

  const remembered = matchingPolicy(db, session.id, from_account_id, to_account_id, amount);
  const livePolicy = decide(db, {
    from_account_id,
    to_account_id,
    amount,
    actor_customer_id: session.customer_id,
  });
  const useRemembered = Boolean(remembered) && livePolicy.rule_id !== "ACCOUNT_FROZEN";
  let inboundDecision: string;
  let inboundRule: string;
  let inboundReason: string;
  let inboundCopy: string;
  let decideAuditId: string;
  if (useRemembered && remembered) {
    decideAuditId = remembered.decide_audit_id;
    inboundDecision = remembered.decision;
    inboundRule = remembered.rule_id;
    inboundReason = getAudit(db, decideAuditId)?.reason ?? remembered.decision;
    inboundCopy = copyForDecision(remembered.decision);
  } else {
    const decided = toolPolicyDecide(db, session, actor, transferArgs);
    decideAuditId = decided.audit_id;
    inboundDecision = decided.decision;
    inboundRule = decided.rule_id;
    inboundReason = decided.reason;
    inboundCopy = decided.copy;
  }
  if (
    inboundDecision === "ALLOW" ||
    inboundDecision === "DUAL_CONTROL" ||
    inboundDecision === "DENY_NSF" ||
    inboundDecision === "DENY_LIMIT"
  ) {
    inboundCopy = copyForDecision(inboundDecision);
  }

  if (!decideAuditId || !inboundDecision) {
    const audit = writeAudit(db, {
      audit_id,
      actor,
      action: "transfer",
      args: transferArgs,
      decision: "DENY_POLICY",
      rule_id: "POLICY_DECIDE",
      reason: "transfer requires inbound decision + audit_id from policy.decide",
      session_id: session.id,
      agent: session.current_agent,
    });
    const result: ToolResult = {
      ok: false,
      copy: "정책 결정이 필요합니다",
      decision: "DENY_POLICY" as const,
      rule_id: "POLICY_DECIDE",
      reason: "missing inbound decision or audit_id",
      audit_id: requireAudit(audit),
      journal_id: null,
    };
    appendTrace(db, session, "transfer", transferArgs, result);
    return result;
  }

  if (inboundDecision === "DENY_POLICY") {
    const decideRow = getAudit(db, decideAuditId);
    const result: ToolResult = {
      ok: false,
      copy: inboundCopy,
      decision: "DENY_POLICY",
      rule_id: inboundRule,
      reason: inboundReason,
      audit_id: decideAuditId,
      blast_radius: decideRow?.blast_radius ?? "medium",
      decision_ref: decideAuditId,
      journal_id: null,
    };
    appendTrace(db, session, "transfer", transferArgs, result);
    return result;
  }

  const written = writeTransferJournal(db, {
    idempotency_key,
    decision: inboundDecision,
    decision_ref: decideAuditId,
    from_account_id,
    to_account_id,
    amount,
    rule_id: inboundRule,
    reason: inboundReason,
    created_by: actor,
  });

  if (!written.ok) {
    const audit = writeAudit(db, {
      audit_id,
      actor,
      action: "transfer",
      args: transferArgs,
      decision: "DENY_POLICY",
      rule_id: written.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : inboundRule,
      reason: written.reason,
      session_id: session.id,
      agent: session.current_agent,
    });
    const result: ToolResult = {
      ok: false,
      copy: written.status === 409 ? "멱등 키 충돌" : inboundCopy,
      decision: "DENY_POLICY",
      rule_id: written.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : inboundRule,
      reason: written.reason,
      audit_id: requireAudit(audit),
      decision_ref: decideAuditId,
      journal_id: null,
      data: { status: written.status },
    };
    appendTrace(db, session, "transfer", transferArgs, result);
    return result;
  }

  const journal = written.journal;
  linkDecideAudit(db, decideAuditId, journal.id);
  const audit = writeAudit(db, {
    audit_id,
    actor,
    action: "transfer",
    args: transferArgs,
    decision: inboundDecision as Decision,
    rule_id: inboundRule,
    reason: inboundReason,
    session_id: session.id,
    journal_id: journal.id,
    agent: session.current_agent,
  });
  const result: ToolResult = {
    ok: inboundDecision === "ALLOW" || inboundDecision === "DUAL_CONTROL",
    copy: inboundCopy,
    decision: inboundDecision as Decision,
    rule_id: inboundRule,
    reason: inboundReason,
    audit_id: requireAudit(audit),
    blast_radius: audit.blast_radius,
    decision_ref: journal.decision_ref,
    journal_id: journal.id,
    journal_status: journal.status,
    data:
      journal.status === "PENDING"
        ? { pending_out: pendingOut(db, from_account_id), available: availableBalance(db, from_account_id) }
        : undefined,
  };
  appendTrace(db, session, "transfer", transferArgs, result);
  return result;
}

function toolOpenDispute(
  db: Db,
  session: Session,
  actor: Actor,
  args: Record<string, unknown>,
  audit_id?: string,
): ToolResult {
  const account_id = String(args.account_id ?? "");
  const reason = String(args.reason ?? "unspecified");
  const acc = getAccount(db, account_id);
  if (!acc || acc.customer_id !== session.customer_id) {
    const audit = writeAudit(db, {
      audit_id,
      actor,
      action: "open_dispute",
      args,
      decision: "DENY_POLICY",
      rule_id: "UNKNOWN_ACCOUNT",
      reason: "account not in session customer",
      session_id: session.id,
      agent: session.current_agent,
    });
    const result: ToolResult = {
      ok: false,
      copy: "계좌를 확인할 수 없습니다",
      decision: "DENY_POLICY",
      rule_id: "UNKNOWN_ACCOUNT",
      reason: "account not in session customer",
      audit_id: requireAudit(audit),
    };
    appendTrace(db, session, "open_dispute", args, result);
    return result;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO disputes (id, account_id, customer_id, reason, status, created_at)
     VALUES (?, ?, ?, ?, 'OPEN', ?)`,
  ).run(id, account_id, session.customer_id, reason, nowUtcIso());
  const audit = writeAudit(db, {
    audit_id,
    actor,
    action: "open_dispute",
    args,
    decision: "ALLOW",
    rule_id: "DISPUTE_INTAKE",
    reason: "dispute intake only; no money movement",
    session_id: session.id,
    agent: session.current_agent,
  });
  const result: ToolResult = {
    ok: true,
    copy: "분쟁 접수 완료 (자금 이동 없음)",
    decision: "ALLOW",
    rule_id: "DISPUTE_INTAKE",
    reason: "dispute intake only; no money movement",
    audit_id: requireAudit(audit),
    data: { dispute_id: id, status: "OPEN" },
  };
  appendTrace(db, session, "open_dispute", args, result);
  return result;
}

export function operatorApprove(
  db: Db,
  input: { journal_id: string; audit_id?: string; actor?: Actor },
): ToolResult {
  return withTx(db, () => {
    const actor: Actor = input.actor ?? "operator";
    const journal = getJournal(db, input.journal_id);
    const createdBy = journal?.created_by ?? "agent";

    if (actor === createdBy) {
      const audit = writeAudit(db, {
        audit_id: input.audit_id,
        actor,
        action: "operator.approve",
        args: { journal_id: input.journal_id },
        decision: "DENY_LIMIT",
        rule_id: "SELF_APPROVE_FORBIDDEN",
        reason: "requesting agent cannot self-approve; only Console operator.approve may clear PENDING",
        journal_id: input.journal_id,
      });
      return {
        ok: false,
        copy: "본인 건은 승인할 수 없음",
        decision: "DENY_LIMIT" as const,
        rule_id: "SELF_APPROVE_FORBIDDEN",
        reason: "requesting agent cannot self-approve",
        audit_id: requireAudit(audit),
        decision_ref: journal?.decision_ref ?? null,
        journal_id: input.journal_id,
        journal_status: journal?.status,
      };
    }

    if (!journal) {
      const audit = writeAudit(db, {
        audit_id: input.audit_id,
        actor,
        action: "operator.approve",
        args: { journal_id: input.journal_id },
        decision: "DENY_LIMIT",
        rule_id: "UNKNOWN_ACCOUNT",
        reason: "unknown journal",
        journal_id: input.journal_id,
      });
      return {
        ok: false,
        copy: "전표를 확인할 수 없습니다",
        decision: "DENY_LIMIT" as const,
        rule_id: "UNKNOWN_ACCOUNT",
        reason: "unknown journal",
        audit_id: requireAudit(audit),
        journal_id: input.journal_id,
      };
    }

    if (journal.status === "POSTED") {
      const existingApprove = db
        .prepare(
          "SELECT id FROM audit WHERE journal_id = ? AND action = 'operator.approve' AND decision = 'OPERATOR_APPROVE' ORDER BY timestamp ASC LIMIT 1",
        )
        .get(journal.id) as { id: string } | undefined;
      const audit = writeAudit(db, {
        audit_id: input.audit_id ?? existingApprove?.id,
        actor,
        action: "operator.approve",
        args: { journal_id: journal.id },
        decision: "OPERATOR_APPROVE",
        rule_id: "OPERATOR_APPROVE",
        reason: "idempotent replay of approve",
        journal_id: journal.id,
      });
      return {
        ok: true,
        copy: COPY_POSTED,
        decision: "OPERATOR_APPROVE" as const,
        rule_id: "OPERATOR_APPROVE",
        reason: "idempotent replay of approve",
        audit_id: requireAudit(audit),
        decision_ref: journal.decision_ref,
        journal_id: journal.id,
        journal_status: "POSTED" as const,
        data: { replay: true },
      };
    }

    if (journal.status !== "PENDING") {
      const audit = writeAudit(db, {
        audit_id: input.audit_id,
        actor,
        action: "operator.approve",
        args: { journal_id: journal.id },
        decision: "DENY_LIMIT",
        rule_id: "OPERATOR_APPROVE",
        reason: `journal is ${journal.status}, not PENDING`,
        journal_id: journal.id,
      });
      return {
        ok: false,
        copy: "대기 전표가 아닙니다",
        decision: "DENY_LIMIT" as const,
        rule_id: "OPERATOR_APPROVE",
        reason: `journal is ${journal.status}`,
        audit_id: requireAudit(audit),
        journal_id: journal.id,
        journal_status: journal.status,
      };
    }

    const audit = writeAudit(db, {
      audit_id: input.audit_id,
      actor,
      action: "operator.approve",
      args: { journal_id: journal.id },
      decision: "OPERATOR_APPROVE",
      rule_id: "OPERATOR_APPROVE",
      reason: "operator approved pending journal",
      journal_id: journal.id,
    });
    applyPendingJournal(db, journal.id);
    const fresh = getJournal(db, journal.id)!;
    return {
      ok: true,
      copy: COPY_POSTED,
      decision: "OPERATOR_APPROVE" as const,
      rule_id: "OPERATOR_APPROVE",
      reason: "operator approved pending journal",
      audit_id: requireAudit(audit),
      decision_ref: fresh.decision_ref,
      journal_id: journal.id,
      journal_status: "POSTED" as const,
    };
  });
}

export function operatorDeny(
  db: Db,
  input: { journal_id: string; audit_id?: string; actor?: Actor },
): ToolResult {
  return withTx(db, () => {
    const actor: Actor = input.actor ?? "operator";
    const existing = getJournal(db, input.journal_id);
    const createdBy = existing?.created_by ?? "agent";
    if (actor === createdBy) {
      const audit = writeAudit(db, {
        audit_id: input.audit_id,
        actor,
        action: "operator.deny",
        args: { journal_id: input.journal_id },
        decision: "DENY_LIMIT",
        rule_id: "SELF_APPROVE_FORBIDDEN",
        reason: "requesting agent cannot clear PENDING",
        journal_id: input.journal_id,
      });
      return {
        ok: false,
        copy: "본인 건은 승인할 수 없음",
        decision: "DENY_LIMIT" as const,
        rule_id: "SELF_APPROVE_FORBIDDEN",
        reason: "requesting agent cannot clear PENDING",
        audit_id: requireAudit(audit),
        journal_id: input.journal_id,
      };
    }
    const journal = getJournal(db, input.journal_id);
    if (!journal || journal.status !== "PENDING") {
      const audit = writeAudit(db, {
        audit_id: input.audit_id,
        actor,
        action: "operator.deny",
        args: { journal_id: input.journal_id },
        decision: "DENY_LIMIT",
        rule_id: "OPERATOR_DENY",
        reason: "journal is not PENDING",
        journal_id: input.journal_id,
      });
      return {
        ok: false,
        copy: "대기 전표가 아닙니다",
        decision: "DENY_LIMIT" as const,
        rule_id: "OPERATOR_DENY",
        reason: "journal is not PENDING",
        audit_id: requireAudit(audit),
        journal_id: input.journal_id,
      };
    }
    const audit = writeAudit(db, {
      audit_id: input.audit_id,
      actor,
      action: "operator.deny",
      args: { journal_id: journal.id },
      decision: "OPERATOR_DENY",
      rule_id: "OPERATOR_DENY",
      reason: "operator denied pending journal",
      journal_id: journal.id,
    });
    rejectPendingJournal(db, journal.id);
    const fresh = getJournal(db, journal.id)!;
    return {
      ok: true,
      copy: COPY_DENIED,
      decision: "OPERATOR_DENY" as const,
      rule_id: "OPERATOR_DENY",
      reason: "operator denied pending journal",
      audit_id: requireAudit(audit),
      decision_ref: fresh.decision_ref,
      journal_id: journal.id,
      journal_status: "DENIED" as const,
    };
  });
}

export function operatorSetAccountStatus(
  db: Db,
  input: { account_id: string; status: AccountStatus; actor?: Actor; audit_id?: string },
): ToolResult {
  return withTx(db, () => {
    const actor: Actor = input.actor ?? "operator";
    const acc = getAccount(db, input.account_id);
    if (!acc || acc.product === "HOUSE") {
      const audit = writeAudit(db, {
        audit_id: input.audit_id,
        actor,
        action: "account.status",
        args: { account_id: input.account_id, status: input.status },
        decision: "DENY_POLICY",
        rule_id: "UNKNOWN_ACCOUNT",
        reason: "unknown or hidden house account",
        blast_radius: "medium",
      });
      return {
        ok: false,
        copy: "계좌를 확인할 수 없습니다",
        decision: "DENY_POLICY" as const,
        rule_id: "UNKNOWN_ACCOUNT",
        reason: "unknown or hidden house account",
        audit_id: requireAudit(audit),
        blast_radius: audit.blast_radius,
        journal_id: null,
      };
    }
    setAccountStatus(db, input.account_id, input.status);
    const copy =
      input.status === "FROZEN"
        ? COPY_ACCOUNT_FROZEN
        : input.status === "CLOSED"
          ? COPY_ACCOUNT_CLOSED
          : COPY_ACCOUNT_OPEN;
    const audit = writeAudit(db, {
      audit_id: input.audit_id,
      actor,
      action: "account.status",
      args: { account_id: input.account_id, status: input.status },
      decision: "ALLOW",
      rule_id: "ACCOUNT_STATUS",
      reason: `status write ${acc.status} → ${input.status}; not a reversing journal`,
      blast_radius: "low",
    });
    return {
      ok: true,
      copy,
      decision: "ALLOW" as const,
      rule_id: "ACCOUNT_STATUS",
      reason: `status write ${acc.status} → ${input.status}; not a reversing journal`,
      audit_id: requireAudit(audit),
      blast_radius: audit.blast_radius,
      journal_id: null,
      data: { account: accountView(db, input.account_id) },
    };
  });
}

export function listSessions(db: Db) {
  return db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as Session[];
}

export function listTraces(db: Db, sessionId?: string) {
  if (sessionId) {
    return db
      .prepare("SELECT * FROM traces WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as Record<string, unknown>[];
  }
  return db.prepare("SELECT * FROM traces ORDER BY created_at ASC, seq ASC").all() as Record<
    string,
    unknown
  >[];
}

export function listJournals(db: Db, status?: JournalStatus) {
  if (status) {
    return db
      .prepare("SELECT * FROM journals WHERE status = ? ORDER BY created_at DESC")
      .all(status) as Journal[];
  }
  return db.prepare("SELECT * FROM journals ORDER BY created_at DESC").all() as Journal[];
}

export function listPending(db: Db): Journal[] {
  return db
    .prepare(
      "SELECT * FROM journals WHERE status = 'PENDING' AND decision = 'DUAL_CONTROL' ORDER BY created_at ASC",
    )
    .all() as Journal[];
}

export function listEntries(db: Db) {
  return db.prepare("SELECT * FROM entries ORDER BY created_at ASC").all() as Record<string, unknown>[];
}

export function listDisputes(db: Db) {
  return db.prepare("SELECT * FROM disputes ORDER BY created_at DESC").all() as Record<string, unknown>[];
}
