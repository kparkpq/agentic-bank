export const CURRENCY = "KRW" as const;
export const TIMEZONE = "Asia/Seoul" as const;

export const DAILY_OUTBOUND_CAP_KRW = 5_000_000;
export const DUAL_CONTROL_AMOUNT_KRW = 1_000_000;

export type Product = "CHECKING" | "SAVINGS" | "HOUSE";
export type AccountStatus = "OPEN" | "FROZEN" | "CLOSED";
export type JournalStatus = "PENDING" | "POSTED" | "DENIED";
export type AgentName = "teller" | "transfer" | "dispute";
export type Actor = "agent" | "operator";
export type Role = "operator" | "customer";
export type BlastRadius = "low" | "medium" | "high";

export type Decision =
  | "ALLOW"
  | "DENY_LIMIT"
  | "DENY_NSF"
  | "DENY_POLICY"
  | "DUAL_CONTROL"
  | "OPERATOR_APPROVE"
  | "OPERATOR_DENY";

export const COPY_POSTED = "완료";
export const COPY_PENDING = "승인 대기";
export const COPY_DENIED = "거절";
export const COPY_KYC_REQUIRED = "실명 확인이 필요합니다";
export const COPY_KYC_INCOMPLETE = "실명 확인 미완료";
export const COPY_KYC_REVIEWING = "실명 확인 검토 중";
export const COPY_KYC_PASSED = "실명 확인이 완료되었습니다";
export const COPY_KYC_DENIED = "실명 확인이 거절되었습니다";
export const COPY_ACCOUNT_OPEN = "정상";
export const COPY_ACCOUNT_FROZEN = "동결";
export const COPY_ACCOUNT_CLOSED = "해지";

export type RuleId =
  | "ALLOW"
  | "INVALID_AMOUNT"
  | "UNKNOWN_ACCOUNT"
  | "NOT_OWNED"
  | "SAME_ACCOUNT"
  | "NSF"
  | "DAILY_CAP"
  | "DUAL_AMOUNT"
  | "DUAL_OTHER_CUSTOMER"
  | "OPERATOR_APPROVE"
  | "OPERATOR_DENY"
  | "SELF_APPROVE_FORBIDDEN"
  | "AGENT_TOOL_DENIED"
  | "HANDOFF"
  | "BALANCE"
  | "DISPUTE_INTAKE"
  | "POLICY_DECIDE"
  | "IDEMPOTENT_REPLAY"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "ACCOUNT_FROZEN"
  | "ACCOUNT_STATUS"
  | "KYC_REQUIRED"
  | "KYC_INCOMPLETE"
  | "KYC_REVIEWING"
  | "KYC_PASSED"
  | "KYC_DENIED"
  | "PII_FORBIDDEN"
  | "DOCUMENTS_INCOMPLETE"
  | "ENROLL_COMPLETE";

export type Customer = {
  id: string;
  display_name: string;
};

export type Account = {
  id: string;
  customer_id: string | null;
  product: Product;
  status: AccountStatus;
};

export type AccountView = Account & {
  available: number;
  pending_out: number;
  posted_credits: number;
  posted_debits: number;
};

export type Journal = {
  id: string;
  idempotency_key: string | null;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  status: JournalStatus;
  rule_id: string | null;
  reason: string | null;
  decision: string | null;
  decision_ref: string | null;
  created_by: string | null;
  created_at: string;
  posted_at: string | null;
};

export type Entry = {
  id: string;
  journal_id: string;
  account_id: string;
  side: "DEBIT" | "CREDIT";
  amount: number;
  posted: number;
  created_at: string;
};

export type AuditRow = {
  audit_id: string;
  timestamp: string;
  actor: Actor;
  action: string;
  args: unknown;
  decision: Decision;
  rule_id: string;
  reason: string;
  why: string;
  blast_radius: BlastRadius;
  session_id: string | null;
  journal_id: string | null;
  agent: AgentName | null;
};

export type Session = {
  id: string;
  customer_id: string;
  current_agent: AgentName;
  created_at: string;
};

export type PolicyInput = {
  from_account_id: string;
  to_account_id: string;
  amount: number;
  actor_customer_id?: string;
  now?: Date;
};

export type PolicyResult = {
  decision: Extract<Decision, "ALLOW" | "DENY_LIMIT" | "DENY_NSF" | "DENY_POLICY" | "DUAL_CONTROL">;
  rule_id: RuleId;
  reason: string;
  copy: string;
};

export type ToolName = "balance" | "handoff" | "transfer" | "open_dispute" | "policy.decide";

export const AGENT_TOOLS: Record<AgentName, readonly ToolName[]> = {
  teller: ["balance", "handoff"],
  transfer: ["balance", "policy.decide", "transfer"],
  dispute: ["balance", "open_dispute"],
} as const;
