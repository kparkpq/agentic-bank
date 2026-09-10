import { randomUUID } from "node:crypto";
import type { ToolResult } from "./agents.js";
import { writeAudit } from "./audit.js";
import type { Db } from "./db.js";
import { getKyc } from "./kyc.js";
import { nowUtcIso } from "./time.js";
import { COPY_KYC_DENIED, COPY_KYC_REQUIRED, COPY_POSTED } from "./types.js";

export const SHOP_CUSTOMER_ID = "syn_alice";
export const SHOP_DEPOSIT_KEY = "eval:shop-deposit:v0";
export const SHOP_INSURANCE_KEY = "eval:shop-insurance:v0";
export const SHOP_LOAN_KEY = "eval:shop-loan:v0";

export type ShopKind = "deposit" | "insurance" | "loan";
export type ShopDoc = { id: string; label: string };
export type EnrollmentStatus = "KYC_REQUIRED" | "KYC_DENIED" | "POSTED";

export type ShopProduct = {
  id: string;
  kind: ShopKind;
  kind_label: string;
  institution: string;
  title: string;
  headline: string;
  why: string;
  documents: ShopDoc[];
  idempotency_key: string;
};

export type ShopProductView = ShopProduct & {
  dismissed: boolean;
  attempt_id: string | null;
  attempt_status: EnrollmentStatus | null;
  attempt_copy: string | null;
  audit_id: string | null;
  kyc_status: string;
  kyc_copy: string;
  can_complete: boolean;
};

export type ShopHolding = {
  product_id: string;
  kind: ShopKind;
  kind_label: string;
  institution: string;
  title: string;
  headline: string;
  available: number;
  status: "POSTED";
  copy: string;
  rail_note: string;
};

const PRODUCTS: readonly ShopProduct[] = [
  {
    id: "prod_deposit_hanbit",
    kind: "deposit",
    kind_label: "예금",
    institution: "한빛저축은행",
    title: "한빛 정기예금",
    headline: "연 4.20%",
    why: "지금 들고 있는 한빛 파킹MMF 표시 이율은 연 3.50%입니다. 한빛저축은행 정기예금은 연 4.20%로 더 높습니다. 한 은행에 묶지 않고 비교한 표시 이율이며, 시장 시세가 아닙니다.",
    documents: [
      { id: "id_card", label: "신분증" },
      { id: "resident_copy", label: "주민등록등본" },
      { id: "purpose_form", label: "금융거래 목적 확인서" },
    ],
    idempotency_key: SHOP_DEPOSIT_KEY,
  },
  {
    id: "prod_insurance_deulpan",
    kind: "insurance",
    kind_label: "보험",
    institution: "들판손해보험",
    title: "들판 실손의료보험",
    headline: "월 28,000원",
    why: "장부에 가입된 실손 보장이 없습니다. 들판손해보험 실손은 월 28,000원 표시 보험료로 입원·통원 공백을 채우는 비교안입니다. 실제 청약이나 보험금 지급이 아닙니다.",
    documents: [
      { id: "id_card", label: "신분증" },
      { id: "health_notice", label: "건강 고지서" },
      { id: "prior_policy", label: "기존 보험 증권 또는 미가입 확인" },
    ],
    idempotency_key: SHOP_INSURANCE_KEY,
  },
  {
    id: "prod_loan_namsan",
    kind: "loan",
    kind_label: "대출",
    institution: "남산캐피탈",
    title: "남산 신용대출",
    headline: "연 5.20%",
    why: "현재 대출 잔액은 없습니다. 남산캐피탈 신용대출 표시 금리는 연 5.20%로, 비교용 마이너스통장 연 8.90%보다 낮습니다. 실행해도 원장에 대출이 생기지 않습니다.",
    documents: [
      { id: "id_card", label: "신분증" },
      { id: "income_proof", label: "소득금액증명" },
      { id: "employment", label: "재직증명서" },
    ],
    idempotency_key: SHOP_LOAN_KEY,
  },
];

export function isShopProductId(value: string): boolean {
  return PRODUCTS.some((p) => p.id === value);
}

export function listShopCatalog(): ShopProduct[] {
  return PRODUCTS.map((p) => ({ ...p, documents: [...p.documents] }));
}

function dismissedSet(db: Db, customerId: string): Set<string> {
  const rows = db
    .prepare("SELECT product_id FROM shop_dismissals WHERE customer_id = ?")
    .all(customerId) as { product_id: string }[];
  return new Set(rows.map((r) => r.product_id));
}

function attemptFor(db: Db, customerId: string, productId: string): {
  id: string;
  status: EnrollmentStatus;
  copy: string;
  audit_id: string;
} | null {
  const row = db
    .prepare(
      `SELECT id, status, copy, audit_id FROM enrollment_attempts
       WHERE customer_id = ? AND product_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(customerId, productId) as
    | { id: string; status: EnrollmentStatus; copy: string; audit_id: string }
    | undefined;
  return row ?? null;
}

export function listShopProducts(db: Db, customerId: string): ShopProductView[] {
  if (customerId !== SHOP_CUSTOMER_ID) return [];
  const dismissed = dismissedSet(db, customerId);
  const kyc = getKyc(db, customerId);
  return PRODUCTS.map((p) => {
    const attempt = attemptFor(db, customerId, p.id);
    const attemptStatus = attempt?.status ?? null;
    const can_complete =
      kyc.status === "PASSED" && attemptStatus !== "POSTED" && attemptStatus !== "KYC_DENIED";
    return {
      ...p,
      documents: [...p.documents],
      dismissed: dismissed.has(p.id) && !attempt,
      attempt_id: attempt?.id ?? null,
      attempt_status: attemptStatus,
      attempt_copy: attempt?.copy ?? null,
      audit_id: attempt?.audit_id ?? null,
      kyc_status: kyc.status,
      kyc_copy: kyc.copy,
      can_complete,
    };
  }).filter((p) => !p.dismissed || p.attempt_id);
}

export function dismissShopProduct(db: Db, customerId: string, productId: string): void {
  if (!isShopProductId(productId)) throw new Error("unknown product");
  db.prepare(
    `INSERT OR REPLACE INTO shop_dismissals (customer_id, product_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(customerId, productId, nowUtcIso());
}

function missingDocuments(product: ShopProduct, checked: string[]): string[] {
  const have = new Set(checked);
  return product.documents.filter((d) => !have.has(d.id)).map((d) => d.label);
}

function kycDeniedResult(auditId: string, attemptId: string | null, productId: string): ToolResult {
  return {
    ok: false,
    copy: COPY_KYC_DENIED,
    decision: "DENY_POLICY",
    rule_id: "KYC_DENIED",
    reason: "sandbox KYC denied; enrollment stays blocked",
    audit_id: auditId,
    blast_radius: "medium",
    journal_id: null,
    data: { attempt_id: attemptId, product_id: productId, enrolled: false },
  };
}

function completeEnrollment(
  db: Db,
  customerId: string,
  product: ShopProduct,
  checkedDocuments: string[],
  existing?: { id: string },
): ToolResult {
  const audit = writeAudit(db, {
    actor: "agent",
    action: "shop.enroll",
    args: {
      product_id: product.id,
      idempotency_key: product.idempotency_key,
      checked: checkedDocuments,
    },
    decision: "ALLOW",
    rule_id: "ENROLL_COMPLETE",
    reason: "sandbox KYC passed; demo enrollment completed; no live bank rails",
    why: "샌드박스 실명 확인을 마쳐 데모 가입을 완료했습니다. 실제 상품·실제 자금이 아니며 라이선스 은행이 아닙니다.",
    blast_radius: "low",
  });
  const id = existing?.id ?? randomUUID();
  const now = nowUtcIso();
  if (existing) {
    db.prepare(
      `UPDATE enrollment_attempts
       SET documents_json = ?, status = 'POSTED', copy = ?, audit_id = ?
       WHERE id = ?`,
    ).run(JSON.stringify(checkedDocuments), COPY_POSTED, audit.audit_id, existing.id);
  } else {
    db.prepare(
      `INSERT INTO enrollment_attempts (
         id, customer_id, product_id, idempotency_key, documents_json, status, copy, audit_id, created_at
       ) VALUES (?, ?, ?, ?, ?, 'POSTED', ?, ?, ?)`,
    ).run(
      id,
      customerId,
      product.id,
      product.idempotency_key,
      JSON.stringify(checkedDocuments),
      COPY_POSTED,
      audit.audit_id,
      now,
    );
  }
  return {
    ok: true,
    copy: COPY_POSTED,
    decision: "ALLOW",
    rule_id: "ENROLL_COMPLETE",
    reason: audit.reason,
    audit_id: audit.audit_id,
    blast_radius: "low",
    journal_id: null,
    journal_status: "POSTED",
    data: { attempt_id: id, product_id: product.id, enrolled: true, product_title: product.title },
  };
}

export function enrollProduct(
  db: Db,
  customerId: string,
  productId: string,
  checkedDocuments: string[],
): ToolResult {
  if (customerId !== SHOP_CUSTOMER_ID) {
    throw new Error("shopper demo is syn_alice only");
  }
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) {
    throw new Error("unknown product");
  }

  const kyc = getKyc(db, customerId);
  const existing = db
    .prepare("SELECT * FROM enrollment_attempts WHERE idempotency_key = ?")
    .get(product.idempotency_key) as
    | {
        id: string;
        status: EnrollmentStatus;
        copy: string;
        audit_id: string;
        documents_json: string;
      }
    | undefined;

  if (existing?.status === "POSTED") {
    return {
      ok: true,
      copy: existing.copy,
      decision: "ALLOW",
      rule_id: "ENROLL_COMPLETE",
      reason: "idempotent replay of completed sandbox enrollment",
      audit_id: existing.audit_id,
      blast_radius: "low",
      journal_id: null,
      journal_status: "POSTED",
      data: { replay: true, attempt_id: existing.id, product_id: productId, enrolled: true },
    };
  }

  if (kyc.status === "DENIED") {
    if (existing && existing.status !== "KYC_DENIED") {
      db.prepare(
        `UPDATE enrollment_attempts SET status = 'KYC_DENIED', copy = ?, audit_id = ? WHERE id = ?`,
      ).run(COPY_KYC_DENIED, kyc.audit_id ?? existing.audit_id, existing.id);
    }
    return kycDeniedResult(kyc.audit_id ?? existing?.audit_id ?? "", existing?.id ?? null, productId);
  }

  if (existing && kyc.status !== "PASSED") {
    return {
      ok: false,
      copy: existing.copy,
      decision: "DENY_POLICY",
      rule_id: "KYC_REQUIRED",
      reason: "idempotent replay of KYC stop; enrollment is not complete",
      audit_id: existing.audit_id,
      blast_radius: "medium",
      journal_id: null,
      data: { replay: true, attempt_id: existing.id, product_id: productId },
    };
  }

  const storedDocs = existing?.documents_json
    ? (JSON.parse(existing.documents_json) as unknown[]).map((d) => String(d))
    : [];
  const docsForGate = checkedDocuments.length > 0 ? checkedDocuments : storedDocs;
  const missing = missingDocuments(product, docsForGate);
  if (missing.length > 0) {
    const audit = writeAudit(db, {
      actor: "agent",
      action: "shop.enroll",
      args: {
        product_id: productId,
        idempotency_key: product.idempotency_key,
        checked: checkedDocuments,
        missing,
      },
      decision: "DENY_POLICY",
      rule_id: "DOCUMENTS_INCOMPLETE",
      reason: `missing documents: ${missing.join(", ")}`,
      why: `가입에 필요한 서류를 모두 확인해야 합니다. 아직 ${missing.join(", ")}이(가) 빠졌습니다.`,
      blast_radius: "medium",
    });
    return {
      ok: false,
      copy: `가입에 필요한 서류를 모두 확인해야 합니다. 아직 ${missing.join(" · ")}가 빠졌습니다.`,
      decision: "DENY_POLICY",
      rule_id: "DOCUMENTS_INCOMPLETE",
      reason: audit.reason,
      audit_id: audit.audit_id,
      blast_radius: "medium",
      journal_id: null,
      data: { missing },
    };
  }

  if (kyc.status === "PASSED") {
    return completeEnrollment(db, customerId, product, docsForGate, existing);
  }

  const audit = writeAudit(db, {
    actor: "agent",
    action: "shop.enroll",
    args: {
      product_id: productId,
      idempotency_key: product.idempotency_key,
      checked: checkedDocuments,
    },
    decision: "DENY_POLICY",
    rule_id: "KYC_REQUIRED",
    reason: "documents collected; real-name KYC required; enrollment not completed",
    why: "서류는 확인했으나 실명 확인이 필요합니다. 가입은 완료되지 않았고 원장은 바뀌지 않습니다.",
    blast_radius: "medium",
  });
  const id = randomUUID();
  db.prepare(
    `INSERT INTO enrollment_attempts (
       id, customer_id, product_id, idempotency_key, documents_json, status, copy, audit_id, created_at
     ) VALUES (?, ?, ?, ?, ?, 'KYC_REQUIRED', ?, ?, ?)`,
  ).run(
    id,
    customerId,
    productId,
    product.idempotency_key,
    JSON.stringify(checkedDocuments),
    COPY_KYC_REQUIRED,
    audit.audit_id,
    nowUtcIso(),
  );
  return {
    ok: false,
    copy: COPY_KYC_REQUIRED,
    decision: "DENY_POLICY",
    rule_id: "KYC_REQUIRED",
    reason: audit.reason,
    audit_id: audit.audit_id,
    blast_radius: "medium",
    journal_id: null,
    data: { attempt_id: id, product_id: productId, enrolled: false },
  };
}

export const RAIL_NOTE_HOLDING = "샌드박스 가입 완료 · 실제 상품·라이선스 은행 아님";

export function listShopHoldings(db: Db, customerId: string): ShopHolding[] {
  return listEnrollments(db, customerId)
    .filter((row) => row.status === "POSTED")
    .map((row) => {
      const product = PRODUCTS.find((p) => p.id === row.product_id);
      return {
        product_id: row.product_id,
        kind: product?.kind ?? "deposit",
        kind_label: row.kind_label,
        institution: row.institution,
        title: row.product_title,
        headline: product?.headline ?? "가입 완료",
        available: 0,
        status: "POSTED" as const,
        copy: COPY_POSTED,
        rail_note: RAIL_NOTE_HOLDING,
      };
    });
}

export type EnrollmentRow = {
  id: string;
  customer_id: string;
  product_id: string;
  product_title: string;
  institution: string;
  kind_label: string;
  idempotency_key: string;
  status: EnrollmentStatus;
  copy: string;
  audit_id: string;
  created_at: string;
};

export function listEnrollments(db: Db, customerId: string): EnrollmentRow[] {
  const rows = db
    .prepare(
      `SELECT id, customer_id, product_id, idempotency_key, status, copy, audit_id, created_at
       FROM enrollment_attempts WHERE customer_id = ? ORDER BY created_at DESC`,
    )
    .all(customerId) as {
    id: string;
    customer_id: string;
    product_id: string;
    idempotency_key: string;
    status: EnrollmentStatus;
    copy: string;
    audit_id: string;
    created_at: string;
  }[];
  return rows.map((r) => {
    const product = PRODUCTS.find((p) => p.id === r.product_id);
    return {
      ...r,
      product_title: product?.title ?? r.product_id,
      institution: product?.institution ?? "",
      kind_label: product?.kind_label ?? "상품",
    };
  });
}
