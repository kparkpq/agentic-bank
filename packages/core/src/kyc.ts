import { randomUUID } from "node:crypto";
import type { ToolResult } from "./agents.js";
import { writeAudit } from "./audit.js";
import type { Db } from "./db.js";
import { nowUtcIso } from "./time.js";
import {
  COPY_KYC_DENIED,
  COPY_KYC_INCOMPLETE,
  COPY_KYC_PASSED,
  COPY_KYC_REVIEWING,
} from "./types.js";

export const KYC_CUSTOMER_ID = "syn_alice";
export const KYC_IDEMPOTENCY_KEY = "eval:kyc:syn_alice:v0";
export const KYC_DENIED_KEY = "eval:kyc-denied:syn_alice:v0";

export const SYN_DISPLAY_NAME = "앨리스";
export const SYN_PHONE = "syn_phone_01000000000";
export const SYN_EMAIL = "syn_alice@sandbox.invalid";
export const SYN_ID_PLACEHOLDER = "syn_id_placeholder";

export type KycStatus = "INCOMPLETE" | "REVIEWING" | "PASSED" | "DENIED";
export type KycScenario = "pass" | "deny";

export type KycAck = { id: string; label: string };

export const KYC_ACKNOWLEDGEMENTS: readonly KycAck[] = [
  {
    id: "ack_sandbox",
    label: "이 화면은 샌드박스 실명 확인이며 실제 신원 확인·AML이 아닙니다.",
  },
  {
    id: "ack_no_rrn",
    label: "주민등록번호나 실명 신분증 번호를 입력하지 않습니다. 합성 값(syn_*)만 씁니다.",
  },
  {
    id: "ack_not_bank",
    label: "라이선스 은행이 아니며 실제 자금이 아닙니다.",
  },
];

export type KycSubmitInput = {
  display_name?: string;
  phone?: string;
  email?: string;
  id_placeholder?: string;
  acknowledgements?: string[];
  scenario?: string;
};

export type KycView = {
  customer_id: string;
  status: KycStatus;
  status_label: string;
  display_name: string;
  phone: string;
  email: string;
  id_placeholder: string;
  acknowledgements: string[];
  copy: string;
  audit_id: string | null;
  can_enroll: boolean;
  timeline: { id: string; label: string; state: "done" | "current" | "upcoming" }[];
};

const ALLOWED_NAMES = new Set(["앨리스", "Alice", "alice", "syn_alice"]);
const RRN_LIKE = /\d{6}[-\s]?\d{7}/;
const DIGITS_13 = /\d{13}/;
const SYN_PHONE_OK = /^syn_phone_[0-9a-z_]+$/i;
const SYN_EMAIL_OK = /^syn_[a-z0-9._+-]+@sandbox\.invalid$/i;
const SYN_ID_OK = /^syn_id_[a-z0-9._-]+$/i;

export function kycStatusLabel(status: KycStatus): string {
  if (status === "REVIEWING") return "검토 중";
  if (status === "PASSED") return "완료";
  if (status === "DENIED") return "거절";
  return "미완료";
}

export function kycTimeline(status: KycStatus): KycView["timeline"] {
  if (status === "PASSED") {
    return [
      { id: "incomplete", label: "미완료", state: "done" },
      { id: "reviewing", label: "검토 중", state: "done" },
      { id: "complete", label: "완료", state: "current" },
    ];
  }
  if (status === "DENIED") {
    return [
      { id: "incomplete", label: "미완료", state: "done" },
      { id: "reviewing", label: "검토 중", state: "done" },
      { id: "denied", label: "거절", state: "current" },
    ];
  }
  if (status === "REVIEWING") {
    return [
      { id: "incomplete", label: "미완료", state: "done" },
      { id: "reviewing", label: "검토 중", state: "current" },
      { id: "complete", label: "완료", state: "upcoming" },
    ];
  }
  return [
    { id: "incomplete", label: "미완료", state: "current" },
    { id: "reviewing", label: "검토 중", state: "upcoming" },
    { id: "complete", label: "완료", state: "upcoming" },
  ];
}

function looksLikeRealPii(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (RRN_LIKE.test(trimmed)) return true;
  if (DIGITS_13.test(trimmed.replace(/\D/g, ""))) return true;
  return false;
}

function normalizeName(value: string | undefined): string | { error: string } {
  const raw = (value ?? SYN_DISPLAY_NAME).trim();
  if (looksLikeRealPii(raw)) return { error: "real_pii" };
  if (!ALLOWED_NAMES.has(raw)) {
    return { error: "name_must_be_synthetic" };
  }
  return SYN_DISPLAY_NAME;
}

function normalizePhone(value: string | undefined): string | { error: string } {
  const raw = (value ?? "").trim();
  if (!raw) return SYN_PHONE;
  if (looksLikeRealPii(raw)) return { error: "real_pii" };
  if (!SYN_PHONE_OK.test(raw)) return { error: "phone_must_be_syn" };
  return raw;
}

function normalizeEmail(value: string | undefined): string | { error: string } {
  const raw = (value ?? "").trim();
  if (!raw) return SYN_EMAIL;
  if (looksLikeRealPii(raw)) return { error: "real_pii" };
  if (!SYN_EMAIL_OK.test(raw)) return { error: "email_must_be_syn" };
  return raw;
}

function normalizeIdPlaceholder(value: string | undefined): string | { error: string } {
  const raw = (value ?? "").trim();
  if (!raw) return SYN_ID_PLACEHOLDER;
  if (looksLikeRealPii(raw)) return { error: "real_pii" };
  if (!SYN_ID_OK.test(raw)) return { error: "id_must_be_syn" };
  return raw;
}

function parseScenario(value: string | undefined): KycScenario {
  return value === "deny" ? "deny" : "pass";
}

function missingAcknowledgements(checked: string[] | undefined): string[] {
  const have = new Set(checked ?? []);
  return KYC_ACKNOWLEDGEMENTS.filter((a) => !have.has(a.id)).map((a) => a.label);
}

type KycRow = {
  id: string;
  customer_id: string;
  status: KycStatus;
  display_name: string;
  phone: string | null;
  email: string | null;
  id_placeholder: string;
  acknowledgements_json: string;
  scenario: string;
  copy: string;
  audit_id: string;
  created_at: string;
  updated_at: string;
};

function readCase(db: Db, customerId: string): KycRow | undefined {
  return db.prepare("SELECT * FROM kyc_cases WHERE customer_id = ?").get(customerId) as KycRow | undefined;
}

function viewFromRow(row: KycRow): KycView {
  return {
    customer_id: row.customer_id,
    status: row.status,
    status_label: kycStatusLabel(row.status),
    display_name: row.display_name,
    phone: row.phone ?? SYN_PHONE,
    email: row.email ?? SYN_EMAIL,
    id_placeholder: row.id_placeholder,
    acknowledgements: JSON.parse(row.acknowledgements_json) as string[],
    copy: row.copy,
    audit_id: row.audit_id,
    can_enroll: row.status === "PASSED",
    timeline: kycTimeline(row.status),
  };
}

export function getKyc(db: Db, customerId: string): KycView {
  if (customerId !== KYC_CUSTOMER_ID) {
    return {
      customer_id: customerId,
      status: "INCOMPLETE",
      status_label: kycStatusLabel("INCOMPLETE"),
      display_name: customerId === "syn_bob" ? "밥" : customerId,
      phone: "",
      email: "",
      id_placeholder: "",
      acknowledgements: [],
      copy: COPY_KYC_INCOMPLETE,
      audit_id: null,
      can_enroll: false,
      timeline: kycTimeline("INCOMPLETE"),
    };
  }
  const row = readCase(db, customerId);
  if (!row) {
    return {
      customer_id: customerId,
      status: "INCOMPLETE",
      status_label: kycStatusLabel("INCOMPLETE"),
      display_name: SYN_DISPLAY_NAME,
      phone: SYN_PHONE,
      email: SYN_EMAIL,
      id_placeholder: SYN_ID_PLACEHOLDER,
      acknowledgements: [],
      copy: COPY_KYC_INCOMPLETE,
      audit_id: null,
      can_enroll: false,
      timeline: kycTimeline("INCOMPLETE"),
    };
  }
  return viewFromRow(row);
}

function piiDenied(db: Db, customerId: string, reason: string): ToolResult {
  const audit = writeAudit(db, {
    actor: "agent",
    action: "shop.kyc.submit",
    args: { customer_id: customerId, rejected: reason, synthetic_only: true },
    decision: "DENY_POLICY",
    rule_id: "PII_FORBIDDEN",
    reason,
    why: "실제 주민등록번호나 개인정보는 받지 않습니다. 합성 값(syn_*)만 허용합니다.",
    blast_radius: "medium",
  });
  return {
    ok: false,
    copy: "실제 개인정보는 저장하지 않습니다. 합성 값(syn_*)만 입력하세요.",
    decision: "DENY_POLICY",
    rule_id: "PII_FORBIDDEN",
    reason: audit.reason,
    audit_id: audit.audit_id,
    blast_radius: "medium",
    journal_id: null,
    data: { kyc_status: "INCOMPLETE" },
  };
}

function replayResult(row: KycRow): ToolResult {
  const passed = row.status === "PASSED";
  return {
    ok: passed,
    copy: row.copy,
    decision: passed ? "ALLOW" : "DENY_POLICY",
    rule_id: passed ? "KYC_PASSED" : row.status === "DENIED" ? "KYC_DENIED" : "KYC_REVIEWING",
    reason: "idempotent replay of sandbox KYC",
    audit_id: row.audit_id,
    blast_radius: passed ? "low" : "medium",
    journal_id: null,
    data: { replay: true, kyc_status: row.status },
  };
}

export function submitKyc(db: Db, customerId: string, input: KycSubmitInput = {}): ToolResult {
  if (customerId !== KYC_CUSTOMER_ID) {
    throw new Error("sandbox KYC is syn_alice only");
  }

  const existing = readCase(db, customerId);
  if (existing && (existing.status === "PASSED" || existing.status === "DENIED")) {
    return replayResult(existing);
  }

  const name = normalizeName(input.display_name);
  if (typeof name !== "string") return piiDenied(db, customerId, name.error);
  const phone = normalizePhone(input.phone);
  if (typeof phone !== "string") return piiDenied(db, customerId, phone.error);
  const email = normalizeEmail(input.email);
  if (typeof email !== "string") return piiDenied(db, customerId, email.error);
  const idPlaceholder = normalizeIdPlaceholder(input.id_placeholder);
  if (typeof idPlaceholder !== "string") return piiDenied(db, customerId, idPlaceholder.error);

  const missing = missingAcknowledgements(input.acknowledgements);
  if (missing.length > 0) {
    const audit = writeAudit(db, {
      actor: "agent",
      action: "shop.kyc.submit",
      args: { customer_id: customerId, missing, idempotency_key: KYC_IDEMPOTENCY_KEY },
      decision: "DENY_POLICY",
      rule_id: "KYC_INCOMPLETE",
      reason: `missing acknowledgements: ${missing.join(", ")}`,
      why: "샌드박스 실명 확인 안내를 모두 확인해야 합니다.",
      blast_radius: "medium",
    });
    return {
      ok: false,
      copy: `샌드박스 실명 확인 안내를 모두 확인해야 합니다. 아직 ${missing.join(" · ")}가 빠졌습니다.`,
      decision: "DENY_POLICY",
      rule_id: "KYC_INCOMPLETE",
      reason: audit.reason,
      audit_id: audit.audit_id,
      blast_radius: "medium",
      journal_id: null,
      data: { missing, kyc_status: "INCOMPLETE" },
    };
  }

  const scenario = parseScenario(input.scenario);
  const now = nowUtcIso();
  const id = existing?.id ?? randomUUID();
  const acks = [...(input.acknowledgements ?? [])];

  const reviewAudit = writeAudit(db, {
    actor: "agent",
    action: "shop.kyc.submit",
    args: {
      customer_id: customerId,
      idempotency_key: scenario === "deny" ? KYC_DENIED_KEY : KYC_IDEMPOTENCY_KEY,
      id_placeholder: idPlaceholder,
      acknowledgements: acks,
      scenario,
      synthetic_only: true,
    },
    decision: "ALLOW",
    rule_id: "KYC_REVIEWING",
    reason: "sandbox KYC submitted; reviewing synthetic fields only",
    why: "합성 실명 확인 서류를 접수했습니다. 실제 신원 확인이 아니며 검토 중입니다.",
    blast_radius: "low",
  });

  const denied = scenario === "deny";
  const finalStatus: KycStatus = denied ? "DENIED" : "PASSED";
  const finalCopy = denied ? COPY_KYC_DENIED : COPY_KYC_PASSED;
  const resolveAudit = writeAudit(db, {
    actor: "agent",
    action: "shop.kyc.resolve",
    args: {
      customer_id: customerId,
      idempotency_key: scenario === "deny" ? KYC_DENIED_KEY : KYC_IDEMPOTENCY_KEY,
      scenario,
      synthetic_only: true,
    },
    decision: denied ? "DENY_POLICY" : "ALLOW",
    rule_id: denied ? "KYC_DENIED" : "KYC_PASSED",
    reason: denied
      ? "sandbox KYC denied golden; enrollment stays blocked"
      : "sandbox KYC passed for syn_alice; enrollment may continue",
    why: denied
      ? "샌드박스 실명 확인이 거절되었습니다. 가입을 완료할 수 없고 원장은 바뀌지 않습니다."
      : "샌드박스 실명 확인이 완료되었습니다. 실제 신원 확인이 아니며, 이제 데모 가입을 계속할 수 있습니다.",
    blast_radius: denied ? "medium" : "low",
  });

  db.prepare(
    `INSERT INTO kyc_cases (
       id, customer_id, status, display_name, phone, email, id_placeholder,
       acknowledgements_json, scenario, copy, audit_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET
       status = excluded.status,
       display_name = excluded.display_name,
       phone = excluded.phone,
       email = excluded.email,
       id_placeholder = excluded.id_placeholder,
       acknowledgements_json = excluded.acknowledgements_json,
       scenario = excluded.scenario,
       copy = excluded.copy,
       audit_id = excluded.audit_id,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    customerId,
    finalStatus,
    name,
    phone,
    email,
    idPlaceholder,
    JSON.stringify(acks),
    scenario,
    finalCopy,
    resolveAudit.audit_id,
    existing?.created_at ?? now,
    now,
  );

  return {
    ok: !denied,
    copy: finalCopy,
    decision: denied ? "DENY_POLICY" : "ALLOW",
    rule_id: denied ? "KYC_DENIED" : "KYC_PASSED",
    reason: resolveAudit.reason,
    audit_id: resolveAudit.audit_id,
    blast_radius: denied ? "medium" : "low",
    journal_id: null,
    data: {
      kyc_status: finalStatus,
      reviewed: true,
      review_audit_id: reviewAudit.audit_id,
      display_name: name,
      id_placeholder: idPlaceholder,
    },
  };
}
