import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listAudit } from "./audit.js";
import { openDb, type Db } from "./db.js";
import {
  executeTool,
  listDisputes,
  listEntries,
  listJournals,
  listPending,
  listSessions,
  listTraces,
  operatorApprove,
  operatorDeny,
  operatorSetAccountStatus,
  startSession,
} from "./agents.js";
import { accountView, getJournal, journalEntries, listAccountViews } from "./ledger.js";
import { seed } from "./seed.js";
import {
  RAIL_NOTE_ENROLL,
  customerWhyForRule,
  dismissProposal,
  enrollmentTimeline,
  executeProposal,
  listExecutions,
  listProposals,
  moneyPicture,
  type ProposalId,
} from "./treasury.js";
import { getKyc, submitKyc, type KycSubmitInput } from "./kyc.js";
import {
  dismissShopProduct,
  enrollProduct,
  isShopProductId,
  listEnrollments,
  listShopHoldings,
  listShopProducts,
} from "./shopper.js";
import { booksView, setBookDocument } from "./bookkeeper.js";
import type { AccountStatus, Actor, Role, ToolName } from "./types.js";

export class Bank {
  readonly db: Db;
  readonly dbPath: string;

  constructor(dbPath = ":memory:") {
    this.dbPath = dbPath;
    this.db = openDb(dbPath);
  }

  seed(fixturePath?: string): void {
    seed(this.db, fixturePath);
  }

  startSession(customerId: string) {
    return startSession(this.db, customerId);
  }

  tool(
    sessionId: string,
    action: ToolName,
    args: Record<string, unknown> = {},
    opts?: { actor?: Actor; audit_id?: string },
  ) {
    return executeTool(this.db, {
      session_id: sessionId,
      action,
      args,
      actor: opts?.actor,
      audit_id: opts?.audit_id,
    });
  }

  approve(journalId: string, opts?: { actor?: Actor; audit_id?: string }) {
    return operatorApprove(this.db, {
      journal_id: journalId,
      actor: opts?.actor,
      audit_id: opts?.audit_id,
    });
  }

  deny(journalId: string, opts?: { actor?: Actor; audit_id?: string }) {
    return operatorDeny(this.db, {
      journal_id: journalId,
      actor: opts?.actor,
      audit_id: opts?.audit_id,
    });
  }

  setStatus(accountId: string, status: AccountStatus, opts?: { actor?: Actor; audit_id?: string }) {
    return operatorSetAccountStatus(this.db, {
      account_id: accountId,
      status,
      actor: opts?.actor,
      audit_id: opts?.audit_id,
    });
  }

  accounts(role: Role, customerId?: string) {
    if (role === "customer") {
      if (!customerId) return [];
      return listAccountViews(this.db, customerId);
    }
    return listAccountViews(this.db);
  }

  account(id: string) {
    return accountView(this.db, id);
  }

  journals() {
    return listJournals(this.db);
  }

  journal(id: string) {
    return getJournal(this.db, id);
  }

  journalEntries(id: string) {
    return journalEntries(this.db, id);
  }

  pending() {
    return listPending(this.db);
  }

  entries() {
    return listEntries(this.db);
  }

  audit() {
    return listAudit(this.db);
  }

  sessions() {
    return listSessions(this.db);
  }

  traces(sessionId?: string) {
    return listTraces(this.db, sessionId);
  }

  disputes() {
    return listDisputes(this.db);
  }

  money(customerId: string) {
    return {
      ...moneyPicture(this.db, customerId),
      shop_holdings: listShopHoldings(this.db, customerId),
    };
  }

  proposals(customerId: string) {
    return listProposals(this.db, customerId);
  }

  executeProposal(customerId: string, proposalId: ProposalId) {
    return executeProposal(this.db, customerId, proposalId);
  }

  dismissProposal(customerId: string, proposalId: ProposalId) {
    dismissProposal(this.db, customerId, proposalId);
  }

  executions(customerId: string) {
    const transfers = listExecutions(this.db, customerId);
    const enrollments = listEnrollments(this.db, customerId).map((row) => {
      const posted = row.status === "POSTED";
      const denied = row.status === "KYC_DENIED";
      const rule_id = posted ? "ENROLL_COMPLETE" : denied ? "KYC_DENIED" : "KYC_REQUIRED";
      return {
        id: row.id,
        kind: "enrollment" as const,
        journal_id: null,
        proposal_id: null,
        title: `${row.kind_label} 가입 · ${row.product_title}`,
        counterparty: row.institution,
        from_account_id: "",
        to_account_id: "",
        from_label: "",
        to_label: `${row.institution} · ${row.product_title}`,
        amount: 0,
        amount_label: "—",
        status: row.status,
        copy: row.copy,
        decision: posted ? "ALLOW" : "DENY_POLICY",
        rule_id,
        why: customerWhyForRule(rule_id),
        decision_ref: row.audit_id,
        idempotency_key: row.idempotency_key,
        created_at: row.created_at,
        posted_at: posted ? row.created_at : null,
        timeline: enrollmentTimeline(row.status),
        rail_note: posted ? "샌드박스 가입 완료 · 실제 상품·라이선스 은행 아님" : RAIL_NOTE_ENROLL,
      };
    });
    return [...transfers, ...enrollments].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  shopProducts(customerId: string) {
    return listShopProducts(this.db, customerId);
  }

  enrollProduct(customerId: string, productId: string, checkedDocuments: string[]) {
    return enrollProduct(this.db, customerId, productId, checkedDocuments);
  }

  kyc(customerId: string) {
    return getKyc(this.db, customerId);
  }

  submitKyc(customerId: string, input: KycSubmitInput = {}) {
    return submitKyc(this.db, customerId, input);
  }

  dismissShopProduct(customerId: string, productId: string) {
    if (!isShopProductId(productId)) throw new Error("unknown product");
    dismissShopProduct(this.db, customerId, productId);
  }

  books(customerId: string) {
    return booksView(this.db, customerId);
  }

  setBookDocument(customerId: string, docId: string, held: boolean) {
    return setBookDocument(this.db, customerId, docId, held);
  }

  close(): void {
    this.db.close();
  }
}

export function defaultDatabasePath(): string {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../data/bank.sqlite");
}
