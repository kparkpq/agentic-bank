import { executeTool, startSession, type ToolResult } from "./agents.js";
import type { Db } from "./db.js";
import {
  availableBalance,
  getAccount,
  getJournal,
  getJournalByIdempotency,
  pendingOut,
} from "./ledger.js";
import { nowUtcIso } from "./time.js";
import {
  COPY_DENIED,
  COPY_PENDING,
  COPY_POSTED,
  type Journal,
  type JournalStatus,
} from "./types.js";

export const TREASURY_CUSTOMER_ID = "syn_alice";
export const ACC_ALICE_CHK = "acc_alice_chk";
export const ACC_ALICE_MMF = "acc_alice_mmf";
export const ACC_ALICE_EQ = "acc_alice_eq";
export const ACC_ALICE_BOND = "acc_alice_bond";

/** Keep this much spendable KRW in checking; sweep the rest to the MMF sleeve. */
export const CHECKING_BUFFER_KRW = 8_000_000;
/** 70.00% equity / 30.00% bond of the brokerage sleeves. */
export const TARGET_EQUITY_BPS = 7000;

export const IDLE_IDEMPOTENCY_KEY = "eval:treasury-idle:v0";
export const REBALANCE_IDEMPOTENCY_KEY = "eval:rebalance:v0";

export const CHECKING_APY_BPS = 10;
export const MMF_APY_BPS = 350;

export type ProposalId = "treasury-idle" | "rebalance";
export type SleeveKind = "checking" | "mmf" | "equity" | "bond";

export type SleeveMeta = {
  account_id: string;
  kind: SleeveKind;
  label: string;
  institution: string;
  product_name: string;
  kind_label: string;
  apy_bps: number | null;
};

/** Synthetic house names — not licensed banks or real product codes. */
export const INST_HANBIT = "한빛은행";
export const INST_CHEONGUN = "청운증권";

export const PRODUCT_CHECKING = "한빛 입출금통장";
export const PRODUCT_SAVINGS = "한빛 자유적금";
export const PRODUCT_MMF = "한빛 파킹MMF";
export const PRODUCT_EQ_ETF = "청운 코스피200 ETF";
export const PRODUCT_BOND_ETF = "청운 국고채 ETF";

export const RAIL_NOTE_TRANSFER = "샌드박스 원장 이체 · 오픈뱅킹·실시간 펌뱅킹 아님";
export const RAIL_NOTE_ENROLL = "샌드박스 가입 시도 · 실제 상품 가입 아님";

export const ALICE_SLEEVES: readonly SleeveMeta[] = [
  {
    account_id: ACC_ALICE_CHK,
    kind: "checking",
    label: PRODUCT_CHECKING,
    institution: INST_HANBIT,
    product_name: "생활비 예금",
    kind_label: "예금",
    apy_bps: CHECKING_APY_BPS,
  },
  {
    account_id: ACC_ALICE_MMF,
    kind: "mmf",
    label: PRODUCT_MMF,
    institution: INST_HANBIT,
    product_name: "단기금융 MMF",
    kind_label: "MMF",
    apy_bps: MMF_APY_BPS,
  },
  {
    account_id: ACC_ALICE_EQ,
    kind: "equity",
    label: PRODUCT_EQ_ETF,
    institution: INST_CHEONGUN,
    product_name: "합성 주식형 ETF",
    kind_label: "ETF",
    apy_bps: null,
  },
  {
    account_id: ACC_ALICE_BOND,
    kind: "bond",
    label: PRODUCT_BOND_ETF,
    institution: INST_CHEONGUN,
    product_name: "합성 채권형 ETF",
    kind_label: "ETF",
    apy_bps: null,
  },
] as const;

export type ProposalLeg = {
  from_account_id: string;
  to_account_id: string;
  amount: number;
  label: string;
};

export type TransferStepState = "done" | "current" | "upcoming";

export type TransferStep = {
  id: string;
  label: string;
  state: TransferStepState;
};

export type ProposalView = {
  id: ProposalId;
  title: string;
  why: string;
  from_account_id: string;
  to_account_id: string;
  from_label: string;
  to_label: string;
  amount: number;
  amount_label: string;
  idempotency_key: string;
  legs: ProposalLeg[];
  dismissed: boolean;
  journal_id: string | null;
  journal_status: JournalStatus | null;
  copy: string | null;
  timeline: TransferStep[] | null;
  rail_note: string;
};

export type SleeveView = SleeveMeta & {
  available: number;
  pending_out: number;
  status: string;
};

export type ShopHoldingView = {
  product_id: string;
  kind: string;
  kind_label: string;
  institution: string;
  title: string;
  headline: string;
  available: number;
  status: string;
  copy: string;
  rail_note: string;
};

export type MoneyPicture = {
  customer_id: string;
  display_name: string;
  total_available: number;
  checking: SleeveView | null;
  mmf: SleeveView | null;
  brokerage: {
    equity: SleeveView | null;
    bond: SleeveView | null;
    total: number;
    target_equity_bps: number;
    current_equity_bps: number;
  };
  sleeves: SleeveView[];
  shop_holdings: ShopHoldingView[];
};

export type ExecutionKind = "transfer" | "enrollment";

export type ExecutionView = {
  id: string;
  kind: ExecutionKind;
  journal_id: string | null;
  proposal_id: ProposalId | null;
  title: string;
  counterparty: string;
  from_account_id: string;
  to_account_id: string;
  from_label: string;
  to_label: string;
  amount: number;
  amount_label: string;
  status: string;
  copy: string;
  decision: string | null;
  rule_id: string | null;
  why: string;
  decision_ref: string | null;
  idempotency_key: string | null;
  created_at: string;
  posted_at: string | null;
  timeline: TransferStep[];
  rail_note: string;
};

export function formatWonAmount(n: number): string {
  return `${n.toLocaleString("ko-KR")}원`;
}

export function productName(accountId: string): string {
  const sleeve = ALICE_SLEEVES.find((s) => s.account_id === accountId);
  if (sleeve) return sleeve.label;
  if (accountId === "acc_alice_sav") return PRODUCT_SAVINGS;
  if (accountId === "acc_bob_chk") return PRODUCT_CHECKING;
  if (accountId === "acc_bob_sav") return PRODUCT_SAVINGS;
  return "계좌";
}

export function availableLabel(accountId: string): string {
  return productName(accountId);
}

export function transferTimeline(status: JournalStatus): TransferStep[] {
  if (status === "POSTED") {
    return [
      { id: "received", label: "접수", state: "done" },
      { id: "processing", label: "진행", state: "done" },
      { id: "complete", label: "완료", state: "current" },
    ];
  }
  if (status === "PENDING") {
    return [
      { id: "received", label: "접수", state: "done" },
      { id: "awaiting_approval", label: "승인 대기", state: "current" },
      { id: "complete", label: "완료", state: "upcoming" },
    ];
  }
  return [
    { id: "received", label: "접수", state: "done" },
    { id: "denied", label: "거절", state: "current" },
  ];
}

export function enrollmentTimeline(status = "KYC_REQUIRED"): TransferStep[] {
  if (status === "POSTED") {
    return [
      { id: "received", label: "접수", state: "done" },
      { id: "kyc", label: "실명 확인", state: "done" },
      { id: "complete", label: "가입 완료", state: "current" },
    ];
  }
  if (status === "KYC_DENIED" || status === "DENIED") {
    return [
      { id: "received", label: "접수", state: "done" },
      { id: "kyc", label: "실명 확인", state: "done" },
      { id: "denied", label: "거절", state: "current" },
    ];
  }
  return [
    { id: "received", label: "접수", state: "done" },
    { id: "kyc", label: "실명 확인이 필요합니다", state: "current" },
    { id: "complete", label: "가입 완료", state: "upcoming" },
  ];
}

export function customerWhyForRule(ruleId: string | null | undefined): string {
  if (ruleId === "ALLOW") return "같은 고객의 계좌이고 한도 안이라서 바로 반영했습니다.";
  if (ruleId === "DUAL_AMOUNT") return "금액이 100만 원 이상이어서 운영자 승인이 필요합니다.";
  if (ruleId === "DUAL_OTHER_CUSTOMER") return "다른 고객에게 보내는 이체라서 운영자 승인이 필요합니다.";
  if (ruleId === "NSF") return "쓸 수 있는 잔액이 부족해서 거절했습니다.";
  if (ruleId === "DAILY_CAP") return "하루 출금 한도를 넘어서 거절했습니다.";
  if (ruleId === "KYC_REQUIRED") return "서류는 확인했으나 실명 확인이 필요합니다. 가입은 완료되지 않았고 원장은 바뀌지 않습니다.";
  if (ruleId === "KYC_INCOMPLETE") return "샌드박스 실명 확인 안내를 모두 확인해야 합니다.";
  if (ruleId === "KYC_PASSED") return "샌드박스 실명 확인이 완료되었습니다. 실제 신원 확인이 아니며, 이제 데모 가입을 계속할 수 있습니다.";
  if (ruleId === "KYC_DENIED") return "샌드박스 실명 확인이 거절되었습니다. 가입을 완료할 수 없고 원장은 바뀌지 않습니다.";
  if (ruleId === "ENROLL_COMPLETE") return "샌드박스 실명 확인을 마쳐 데모 가입을 완료했습니다. 실제 상품·실제 자금이 아니며 라이선스 은행이 아닙니다.";
  if (ruleId === "DOCUMENTS_INCOMPLETE") return "가입에 필요한 서류를 모두 확인해야 합니다.";
  if (ruleId === "PII_FORBIDDEN") return "실제 주민등록번호나 개인정보는 받지 않습니다. 합성 값(syn_*)만 허용합니다.";
  return "정책이 이 실행을 기록했습니다.";
}

export function formatApyBps(bps: number): string {
  return `연 ${(bps / 100).toFixed(2)}%`;
}

export function copyForJournalStatus(status: JournalStatus): string {
  if (status === "POSTED") return COPY_POSTED;
  if (status === "PENDING") return COPY_PENDING;
  return COPY_DENIED;
}

function sleeveView(db: Db, meta: SleeveMeta): SleeveView | null {
  const acc = getAccount(db, meta.account_id);
  if (!acc) return null;
  return {
    ...meta,
    available: availableBalance(db, meta.account_id),
    pending_out: pendingOut(db, meta.account_id),
    status: acc.status,
  };
}

function customerDisplayName(db: Db, customerId: string): string {
  if (customerId === "syn_alice") return "앨리스";
  if (customerId === "syn_bob") return "밥";
  const row = db.prepare("SELECT display_name FROM customers WHERE id = ?").get(customerId) as
    | { display_name: string }
    | undefined;
  return row?.display_name ?? customerId;
}

export function idleSweepAmount(db: Db): number {
  const spendable = availableBalance(db, ACC_ALICE_CHK) - pendingOut(db, ACC_ALICE_CHK);
  const excess = spendable - CHECKING_BUFFER_KRW;
  return excess > 0 ? Math.floor(excess) : 0;
}

export function rebalancePlan(db: Db): {
  amount: number;
  from_account_id: string;
  to_account_id: string;
  equity: number;
  bond: number;
  target_equity: number;
  target_bond: number;
} {
  const equity = availableBalance(db, ACC_ALICE_EQ);
  const bond = availableBalance(db, ACC_ALICE_BOND);
  const total = equity + bond;
  if (total <= 0) {
    return {
      amount: 0,
      from_account_id: ACC_ALICE_EQ,
      to_account_id: ACC_ALICE_BOND,
      equity,
      bond,
      target_equity: 0,
      target_bond: 0,
    };
  }
  const target_equity = Math.round((total * TARGET_EQUITY_BPS) / 10_000);
  const target_bond = total - target_equity;
  const drift = equity - target_equity;
  if (drift > 0) {
    return {
      amount: drift,
      from_account_id: ACC_ALICE_EQ,
      to_account_id: ACC_ALICE_BOND,
      equity,
      bond,
      target_equity,
      target_bond,
    };
  }
  if (drift < 0) {
    return {
      amount: -drift,
      from_account_id: ACC_ALICE_BOND,
      to_account_id: ACC_ALICE_EQ,
      equity,
      bond,
      target_equity,
      target_bond,
    };
  }
  return {
    amount: 0,
    from_account_id: ACC_ALICE_EQ,
    to_account_id: ACC_ALICE_BOND,
    equity,
    bond,
    target_equity,
    target_bond,
  };
}

function dismissedSet(db: Db, customerId: string): Set<string> {
  const rows = db
    .prepare("SELECT proposal_id FROM proposal_dismissals WHERE customer_id = ?")
    .all(customerId) as { proposal_id: string }[];
  return new Set(rows.map((r) => r.proposal_id));
}

function overlayJournal(db: Db, key: string): Pick<ProposalView, "journal_id" | "journal_status" | "copy"> {
  const journal = getJournalByIdempotency(db, key);
  if (!journal) {
    return { journal_id: null, journal_status: null, copy: null };
  }
  return {
    journal_id: journal.id,
    journal_status: journal.status,
    copy: copyForJournalStatus(journal.status),
  };
}

export function buildIdleProposal(db: Db, dismissed: boolean): ProposalView {
  const amount = idleSweepAmount(db);
  const overlay = overlayJournal(db, IDLE_IDEMPOTENCY_KEY);
  const journal = overlay.journal_id ? getJournal(db, overlay.journal_id) : undefined;
  const shownAmount = journal ? Number(journal.amount) : amount;
  const from = journal?.from_account_id ?? ACC_ALICE_CHK;
  const to = journal?.to_account_id ?? ACC_ALICE_MMF;
  return {
    id: "treasury-idle",
    title: "유휴 현금을 한빛 파킹MMF로",
    why: `${PRODUCT_CHECKING}에 생활비 버퍼 ${formatWonAmount(CHECKING_BUFFER_KRW)}을 남기고, 나머지 ${formatWonAmount(shownAmount)}을 연 ${(MMF_APY_BPS / 100).toFixed(2)}% ${PRODUCT_MMF}로 옮깁니다. 표시 이율은 데모 상수이며 시세가 아닙니다.`,
    from_account_id: from,
    to_account_id: to,
    from_label: productName(from),
    to_label: productName(to),
    amount: shownAmount,
    amount_label: formatWonAmount(shownAmount),
    idempotency_key: IDLE_IDEMPOTENCY_KEY,
    legs: [
      {
        from_account_id: from,
        to_account_id: to,
        amount: shownAmount,
        label: `${productName(from)} → ${productName(to)}`,
      },
    ],
    dismissed,
    timeline: overlay.journal_status ? transferTimeline(overlay.journal_status) : null,
    rail_note: RAIL_NOTE_TRANSFER,
    ...overlay,
  };
}

export function buildRebalanceProposal(db: Db, dismissed: boolean): ProposalView {
  const plan = rebalancePlan(db);
  const overlay = overlayJournal(db, REBALANCE_IDEMPOTENCY_KEY);
  const journal = overlay.journal_id ? getJournal(db, overlay.journal_id) : undefined;
  const shownAmount = journal ? Number(journal.amount) : plan.amount;
  const from = journal?.from_account_id ?? plan.from_account_id;
  const to = journal?.to_account_id ?? plan.to_account_id;
  const sellLabel = productName(from);
  const buyLabel = productName(to);
  return {
    id: "rebalance",
    title: "ETF 슬리브 70/30 비중 맞추기",
    why: `청운증권 ETF가 목표 70/30에서 벗어나 ${PRODUCT_EQ_ETF} ${formatWonAmount(plan.equity)}·${PRODUCT_BOND_ETF} ${formatWonAmount(plan.bond)}입니다. ${sellLabel} ${formatWonAmount(shownAmount)}을 매도하고 ${buyLabel}를 매수합니다. 장부 대체이며 실시간 체결이 아닙니다.`,
    from_account_id: from,
    to_account_id: to,
    from_label: sellLabel,
    to_label: buyLabel,
    amount: shownAmount,
    amount_label: formatWonAmount(shownAmount),
    idempotency_key: REBALANCE_IDEMPOTENCY_KEY,
    legs: [
      {
        from_account_id: from,
        to_account_id: to,
        amount: shownAmount,
        label: `${sellLabel} → ${buyLabel}`,
      },
    ],
    dismissed,
    timeline: overlay.journal_status ? transferTimeline(overlay.journal_status) : null,
    rail_note: RAIL_NOTE_TRANSFER,
    ...overlay,
  };
}

export function listProposals(db: Db, customerId: string): ProposalView[] {
  if (customerId !== TREASURY_CUSTOMER_ID) return [];
  const dismissed = dismissedSet(db, customerId);
  const idle = buildIdleProposal(db, dismissed.has("treasury-idle"));
  const rebalance = buildRebalanceProposal(db, dismissed.has("rebalance"));
  return [idle, rebalance].filter((p) => {
    if (p.journal_id) return true;
    if (p.dismissed) return false;
    return p.amount > 0;
  });
}

export function moneyPicture(db: Db, customerId: string): MoneyPicture {
  const display_name = customerDisplayName(db, customerId);
  if (customerId !== TREASURY_CUSTOMER_ID) {
    const accounts = db
      .prepare("SELECT id FROM accounts WHERE customer_id = ? ORDER BY id")
      .all(customerId) as { id: string }[];
    const sleeves: SleeveView[] = accounts.map((row) => {
      const acc = getAccount(db, row.id)!;
      return {
        account_id: acc.id,
        kind: acc.product === "SAVINGS" ? "mmf" : "checking",
        label: acc.product === "SAVINGS" ? PRODUCT_SAVINGS : PRODUCT_CHECKING,
        institution: INST_HANBIT,
        product_name: acc.product === "SAVINGS" ? "자유적금" : "입출금 예금",
        kind_label: acc.product === "SAVINGS" ? "적금" : "예금",
        apy_bps: acc.product === "SAVINGS" ? MMF_APY_BPS : CHECKING_APY_BPS,
        available: availableBalance(db, acc.id),
        pending_out: pendingOut(db, acc.id),
        status: acc.status,
      };
    });
    const checking = sleeves.find((s) => s.kind === "checking") ?? null;
    const mmf = sleeves.find((s) => s.kind === "mmf") ?? null;
    return {
      customer_id: customerId,
      display_name,
      total_available: sleeves.reduce((s, a) => s + a.available, 0),
      checking,
      mmf,
      brokerage: {
        equity: null,
        bond: null,
        total: 0,
        target_equity_bps: TARGET_EQUITY_BPS,
        current_equity_bps: 0,
      },
      sleeves,
      shop_holdings: [],
    };
  }

  const checking = sleeveView(db, ALICE_SLEEVES[0]!);
  const mmf = sleeveView(db, ALICE_SLEEVES[1]!);
  const equity = sleeveView(db, ALICE_SLEEVES[2]!);
  const bond = sleeveView(db, ALICE_SLEEVES[3]!);
  const sleeves = [checking, mmf, equity, bond].filter((s): s is SleeveView => Boolean(s));
  const eqAmt = equity?.available ?? 0;
  const bondAmt = bond?.available ?? 0;
  const brokerageTotal = eqAmt + bondAmt;
  const current_equity_bps =
    brokerageTotal > 0 ? Math.round((eqAmt * 10_000) / brokerageTotal) : 0;
  return {
    customer_id: customerId,
    display_name,
    total_available: sleeves.reduce((s, a) => s + a.available, 0),
    checking,
    mmf,
    brokerage: {
      equity,
      bond,
      total: brokerageTotal,
      target_equity_bps: TARGET_EQUITY_BPS,
      current_equity_bps,
    },
    sleeves,
    shop_holdings: [],
  };
}

export function dismissProposal(db: Db, customerId: string, proposalId: ProposalId): void {
  db.prepare(
    `INSERT OR REPLACE INTO proposal_dismissals (customer_id, proposal_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(customerId, proposalId, nowUtcIso());
}

export function executeProposal(db: Db, customerId: string, proposalId: ProposalId): ToolResult {
  if (customerId !== TREASURY_CUSTOMER_ID) {
    throw new Error("treasury demo is syn_alice only");
  }
  const proposals = listProposals(db, customerId);
  let proposal = proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    proposal =
      proposalId === "treasury-idle"
        ? buildIdleProposal(db, false)
        : buildRebalanceProposal(db, false);
  }
  if (proposal.amount <= 0 && !proposal.journal_id) {
    throw new Error("nothing to execute");
  }
  const session = startSession(db, customerId);
  executeTool(db, {
    session_id: session.id,
    action: "handoff",
    args: { to: "transfer" },
    actor: "agent",
  });
  return executeTool(db, {
    session_id: session.id,
    action: "transfer",
    args: {
      from_account_id: proposal.from_account_id,
      to_account_id: proposal.to_account_id,
      amount: proposal.amount,
      idempotency_key: proposal.idempotency_key,
    },
    actor: "agent",
  });
}

function proposalTitleForKey(key: string | null): { id: ProposalId | null; title: string } {
  if (key === IDLE_IDEMPOTENCY_KEY) return { id: "treasury-idle", title: "한빛 파킹MMF로 이동" };
  if (key === REBALANCE_IDEMPOTENCY_KEY) return { id: "rebalance", title: "ETF 70/30 비중 맞추기" };
  return { id: null, title: "내부 이체" };
}

export function listExecutions(db: Db, customerId: string): ExecutionView[] {
  const mine = new Set(
    (db.prepare("SELECT id FROM accounts WHERE customer_id = ?").all(customerId) as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const journals = db
    .prepare("SELECT * FROM journals ORDER BY created_at DESC")
    .all() as Journal[];
  return journals
    .filter((j) => j.rule_id !== "SEED_OPENING")
    .filter((j) => mine.has(j.from_account_id) || mine.has(j.to_account_id))
    .map((j) => {
      const named = proposalTitleForKey(j.idempotency_key);
      const from_label = productName(j.from_account_id);
      const to_label = productName(j.to_account_id);
      const amount = Number(j.amount);
      return {
        id: j.id,
        kind: "transfer" as const,
        journal_id: j.id,
        proposal_id: named.id,
        title: named.title,
        counterparty: `${from_label} → ${to_label}`,
        from_account_id: j.from_account_id,
        to_account_id: j.to_account_id,
        from_label,
        to_label,
        amount,
        amount_label: formatWonAmount(amount),
        status: j.status,
        copy: copyForJournalStatus(j.status),
        decision: j.decision,
        rule_id: j.rule_id,
        why: customerWhyForRule(j.rule_id),
        decision_ref: j.decision_ref,
        idempotency_key: j.idempotency_key,
        created_at: j.created_at,
        posted_at: j.posted_at,
        timeline: transferTimeline(j.status),
        rail_note: RAIL_NOTE_TRANSFER,
      };
    });
}

export function isProposalId(value: string): value is ProposalId {
  return value === "treasury-idle" || value === "rebalance";
}
