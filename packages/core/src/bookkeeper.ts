import type { Db } from "./db.js";
import { nowUtcIso } from "./time.js";
import {
  ACC_ALICE_CHK,
  CHECKING_APY_BPS,
  MMF_APY_BPS,
  TREASURY_CUSTOMER_ID,
  availableLabel,
} from "./treasury.js";
import { availableBalance } from "./ledger.js";
import { listEnrollments } from "./shopper.js";

export const PENSION_SAVINGS_ROOM_KRW = 6_000_000;
export const TAX_ADVICE_DISCLAIMER = "참고이지 세무 자문이 아닙니다.";

export type BookFlowKind = "in" | "out" | "internal";

export type BookFlow = {
  journal_id: string;
  kind: BookFlowKind;
  kind_label: string;
  title: string;
  amount: number;
  created_at: string;
  copy: string;
};

export type TaxNote = {
  id: string;
  title: string;
  body: string;
  disclaimer: string;
};

export type BookDoc = {
  id: string;
  label: string;
  held: boolean;
  held_label: string;
};

export type BookEnrollment = {
  id: string;
  product_title: string;
  institution: string;
  kind_label: string;
  copy: string;
  created_at: string;
};

export type BooksView = {
  customer_id: string;
  household: {
    in_total: number;
    out_total: number;
    internal_total: number;
    flows: BookFlow[];
    empty_copy: string | null;
  };
  enrollments: BookEnrollment[];
  tax_notes: TaxNote[];
  documents: BookDoc[];
};

const BOOK_DOCS: { id: string; label: string }[] = [
  { id: "transfer_confirm", label: "이체 확인" },
  { id: "insurance_policy", label: "보험 증권" },
  { id: "yearend_pack", label: "연말정산 자료" },
];

function sleeveName(accountId: string): string {
  return availableLabel(accountId);
}

export function listBookDocuments(db: Db, customerId: string): BookDoc[] {
  const heldRows = db
    .prepare("SELECT doc_id, held FROM book_documents WHERE customer_id = ?")
    .all(customerId) as { doc_id: string; held: number }[];
  const held = new Map(heldRows.map((r) => [r.doc_id, Number(r.held) === 1]));
  return BOOK_DOCS.map((d) => {
    const on = held.get(d.id) ?? false;
    return {
      id: d.id,
      label: d.label,
      held: on,
      held_label: on ? "챙김" : "미챙김",
    };
  });
}

export function setBookDocument(db: Db, customerId: string, docId: string, held: boolean): BookDoc[] {
  if (!BOOK_DOCS.some((d) => d.id === docId)) {
    throw new Error("unknown document");
  }
  db.prepare(
    `INSERT OR REPLACE INTO book_documents (customer_id, doc_id, held, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(customerId, docId, held ? 1 : 0, nowUtcIso());
  return listBookDocuments(db, customerId);
}

function householdFlows(db: Db, customerId: string): BookFlow[] {
  const mine = new Set(
    (db.prepare("SELECT id FROM accounts WHERE customer_id = ?").all(customerId) as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const journals = db
    .prepare(
      `SELECT id, from_account_id, to_account_id, amount, status, created_at, rule_id
       FROM journals ORDER BY created_at DESC`,
    )
    .all() as {
    id: string;
    from_account_id: string;
    to_account_id: string;
    amount: number;
    status: string;
    created_at: string;
    rule_id: string | null;
  }[];
  return journals
    .filter((j) => j.rule_id !== "SEED_OPENING")
    .filter((j) => mine.has(j.from_account_id) || mine.has(j.to_account_id))
    .map((j) => {
      const fromMine = mine.has(j.from_account_id);
      const toMine = mine.has(j.to_account_id);
      let kind: BookFlowKind = "internal";
      let kind_label = "내부 이동";
      if (fromMine && !toMine) {
        kind = "out";
        kind_label = "출금";
      } else if (!fromMine && toMine) {
        kind = "in";
        kind_label = "입금";
      }
      const copy = j.status === "POSTED" ? "완료" : j.status === "PENDING" ? "승인 대기" : "거절";
      return {
        journal_id: j.id,
        kind,
        kind_label,
        title: `${sleeveName(j.from_account_id)} → ${sleeveName(j.to_account_id)}`,
        amount: Number(j.amount),
        created_at: j.created_at,
        copy,
      };
    });
}

function taxNotes(db: Db, customerId: string): TaxNote[] {
  if (customerId !== TREASURY_CUSTOMER_ID) return [];
  const checking = availableBalance(db, ACC_ALICE_CHK);
  const notes: TaxNote[] = [];
  if (checking > 0) {
    notes.push({
      id: "idle-checking",
      title: "낮은 이율 입출금에 현금이 있습니다",
      body: `한빛 입출금통장에 ${checking.toLocaleString("ko-KR")}원이 연 ${(CHECKING_APY_BPS / 100).toFixed(2)}%로 잠들어 있습니다. 한빛 파킹MMF 표시 이율은 연 ${(MMF_APY_BPS / 100).toFixed(2)}%입니다. 이자를 더 받으려면 유휴 현금을 옮기는 쪽을 검토할 수 있습니다.`,
      disclaimer: TAX_ADVICE_DISCLAIMER,
    });
  }
  notes.push({
    id: "pension-room",
    title: "연금저축 한도를 쓰지 않고 있습니다",
    body: `연금저축 계좌가 없습니다. 표시된 연간 납입 한도 ${PENSION_SAVINGS_ROOM_KRW.toLocaleString("ko-KR")}원을 아직 채우지 않았습니다. 한도와 공제율은 샌드박스 상수입니다.`,
    disclaimer: TAX_ADVICE_DISCLAIMER,
  });
  const enrolledInsurance = listEnrollments(db, customerId).some(
    (e) => e.product_id === "prod_insurance_deulpan" && e.status === "POSTED",
  );
  notes.push({
    id: "insurance-deduction",
    title: enrolledInsurance ? "샌드박스 보험 가입 기록이 있습니다" : "보험 증권이 장부에 없습니다",
    body: enrolledInsurance
      ? "상품 화면의 들판 실손은 샌드박스 가입만 완료했습니다. 실제 증권이 아니며 세액공제 대상이 아닙니다."
      : "보험료 세액공제에 쓸 증권이 아직 챙김 상태가 아닙니다. 상품 화면의 비교 보험은 실명 확인 전에는 가입이 완료되지 않습니다.",
    disclaimer: TAX_ADVICE_DISCLAIMER,
  });
  return notes;
}

export function booksView(db: Db, customerId: string): BooksView {
  const flows = householdFlows(db, customerId);
  const posted = flows.filter((f) => f.copy === "완료");
  const in_total = posted.filter((f) => f.kind === "in").reduce((s, f) => s + f.amount, 0);
  const out_total = posted.filter((f) => f.kind === "out").reduce((s, f) => s + f.amount, 0);
  const internal_total = posted.filter((f) => f.kind === "internal").reduce((s, f) => s + f.amount, 0);
  const enrollments = listEnrollments(db, customerId)
    .filter((e) => e.status === "POSTED")
    .map((e) => ({
      id: e.id,
      product_title: e.product_title,
      institution: e.institution,
      kind_label: e.kind_label,
      copy: e.copy,
      created_at: e.created_at,
    }));
  return {
    customer_id: customerId,
    household: {
      in_total,
      out_total,
      internal_total,
      flows,
      empty_copy:
        flows.length === 0
          ? "아직 고객이 실행한 이체가 없습니다. 아래 절세 메모는 지금 잔액을 기준으로 한 참고입니다."
          : null,
    },
    enrollments,
    tax_notes: taxNotes(db, customerId),
    documents: listBookDocuments(db, customerId),
  };
}
