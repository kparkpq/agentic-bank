import { createTrustRoutes } from "./trust-routes.js";
import { moneyGate } from "./money-gate.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  Bank,
  defaultDatabasePath,
  formatApyBps,
  isAccountStatus,
  isProposalId,
  isShopProductId,
  KYC_ACKNOWLEDGEMENTS,
  SYN_DISPLAY_NAME,
  SYN_EMAIL,
  SYN_ID_PLACEHOLDER,
  SYN_PHONE,
  type AuditRow,
  type Journal,
  type Role,
  type ToolName,
} from "@sapiensq/core";
import { Hono } from "hono";
import { cors } from "hono/cors";

const bank = new Bank(defaultDatabasePath());
bank.seed();

type Auth = { role: Role; customer_id?: string };

const app = new Hono<{ Variables: { auth: Auth } }>();

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"],
    allowHeaders: ["Content-Type", "X-Role", "X-Customer-Id"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.use("/api/*", async (c, next) => {
  const roleHeader = (c.req.header("X-Role") ?? "operator").toLowerCase();
  const role: Role = roleHeader === "customer" ? "customer" : "operator";
  const customer_id = c.req.header("X-Customer-Id") ?? undefined;
  if (role === "customer" && customer_id !== "syn_alice" && customer_id !== "syn_bob") {
    return c.json({ error: "customer role requires syn_alice or syn_bob" }, 401);
  }
  c.set("auth", { role, customer_id });
  await next();
});

app.use("/api/*", moneyGate(bank));
const trustRuntime = await createTrustRoutes(bank, join(dirname(bank.dbPath), "trust"));
app.route("/api/trust", trustRuntime.app);

function forbidCustomer(pathHint: string) {
  return { error: `customer role cannot access ${pathHint}` };
}

function presentJournal(j: Journal) {
  return {
    id: j.id,
    journal_id: j.id,
    idempotency_key: j.idempotency_key,
    from_account_id: j.from_account_id,
    to_account_id: j.to_account_id,
    amount: Number(j.amount),
    status: j.status,
    decision: j.decision,
    decision_ref: j.decision_ref,
    created_by: j.created_by ?? null,
    rule_id: j.rule_id,
    reason: j.reason,
    why: j.reason,
    created_at: j.created_at,
    posted_at: j.posted_at,
  };
}

function presentEntry(e: {
  id: unknown;
  journal_id: unknown;
  account_id: unknown;
  side: unknown;
  amount: unknown;
  posted: unknown;
  created_at: unknown;
}) {
  return {
    id: String(e.id),
    journal_id: String(e.journal_id),
    account_id: String(e.account_id),
    side: e.side,
    amount: Number(e.amount),
    posted: Number(e.posted),
    created_at: String(e.created_at),
  };
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function presentAudit(row: AuditRow, journal?: Journal) {
  const args = argsRecord(row.args);
  return {
    audit_id: row.audit_id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
    args: row.args,
    decision: row.decision,
    rule_id: row.rule_id,
    reason: row.reason,
    why: row.why ?? row.reason,
    blast_radius: row.blast_radius,
    session_id: row.session_id,
    journal_id: row.journal_id,
    agent: row.agent,
    idempotency_key:
      journal?.idempotency_key ?? (typeof args.idempotency_key === "string" ? args.idempotency_key : null),
  };
}

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    product: "SapiensQ Agentic Bank sandbox v0",
    disclaimer: "Not a bank. Simulated KRW only. No real money, live rails, or real PII.",
  }),
);

app.get("/api/me", (c) => c.json(c.get("auth")));

app.get("/api/money", (c) => {
  const auth = c.get("auth");
  const customer_id = auth.customer_id ?? "syn_alice";
  if (auth.role === "customer" && customer_id !== auth.customer_id) {
    return c.json({ error: "forbidden" }, 403);
  }
  const money = bank.money(customer_id);
  return c.json({
    money,
    yields: {
      checking: money.checking?.apy_bps != null ? formatApyBps(money.checking.apy_bps) : null,
      mmf: money.mmf?.apy_bps != null ? formatApyBps(money.mmf.apy_bps) : null,
    },
    disclaimer: "Not a bank. Simulated KRW only. Yields are fixture constants, not market data.",
  });
});

app.get("/api/proposals", (c) => {
  const auth = c.get("auth");
  const customer_id = auth.customer_id ?? "syn_alice";
  return c.json({
    proposals: bank.proposals(customer_id),
    copy: { execute: "실행", skip: "건너뛰기" },
  });
});

app.post("/api/proposals/:id/execute", async (c) => {
  const auth = c.get("auth");
  const customer_id = auth.role === "customer" ? auth.customer_id : (auth.customer_id ?? "syn_alice");
  const id = c.req.param("id");
  if (!customer_id) return c.json({ error: "customer required" }, 401);
  if (!isProposalId(id)) return c.json({ error: "unknown proposal" }, 404);
  if (customer_id !== "syn_alice") {
    return c.json({ error: "treasury demo is syn_alice only" }, 404);
  }
  try {
    const result = bank.executeProposal(customer_id, id);
    const journal = result.journal_id ? bank.journal(result.journal_id) : undefined;
    return c.json({
      result,
      journal: journal ? presentJournal(journal) : null,
      proposals: bank.proposals(customer_id),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "execute failed" }, 400);
  }
});

app.post("/api/proposals/:id/dismiss", async (c) => {
  const auth = c.get("auth");
  const customer_id = auth.role === "customer" ? auth.customer_id : (auth.customer_id ?? "syn_alice");
  const id = c.req.param("id");
  if (!customer_id) return c.json({ error: "customer required" }, 401);
  if (!isProposalId(id)) return c.json({ error: "unknown proposal" }, 404);
  bank.dismissProposal(customer_id, id);
  return c.json({ ok: true, proposals: bank.proposals(customer_id) });
});

app.get("/api/activity", (c) => {
  const auth = c.get("auth");
  const customer_id = auth.customer_id ?? "syn_alice";
  const executions = bank.executions(customer_id);
  const journals = new Map(bank.journals().map((j) => [j.id, j]));
  const audit = bank.audit();
  const rows = executions.map((ex) => {
    const decide = ex.decision_ref ? audit.find((a) => a.audit_id === ex.decision_ref) : undefined;
    const transfer = ex.journal_id
      ? audit.find((a) => a.journal_id === ex.journal_id && a.action === "transfer")
      : undefined;
    return {
      ...ex,
      audit: decide ? presentAudit(decide, ex.journal_id ? journals.get(ex.journal_id) : undefined) : null,
      transfer_audit: transfer ? presentAudit(transfer, ex.journal_id ? journals.get(ex.journal_id) : undefined) : null,
    };
  });
  return c.json({ executions: rows });
});

app.get("/api/products", (c) => {
  const auth = c.get("auth");
  const customer_id = auth.customer_id ?? "syn_alice";
  return c.json({
    products: bank.shopProducts(customer_id),
    kyc: bank.kyc(customer_id),
    copy: {
      enroll: "가입 진행",
      complete: "가입 완료하기",
      skip: "건너뛰기",
      kyc: "실명 확인이 필요합니다",
      kyc_start: "실명 확인 시작",
    },
  });
});

app.get("/api/kyc", (c) => {
  const auth = c.get("auth");
  const customer_id = auth.customer_id ?? "syn_alice";
  return c.json({
    kyc: bank.kyc(customer_id),
    acknowledgements: KYC_ACKNOWLEDGEMENTS,
    defaults: {
      display_name: SYN_DISPLAY_NAME,
      phone: SYN_PHONE,
      email: SYN_EMAIL,
      id_placeholder: SYN_ID_PLACEHOLDER,
    },
    copy: {
      submit: "실명 확인 제출",
      pass: "샌드박스 통과",
      deny: "거절 시나리오 (데모)",
    },
  });
});

app.post("/api/kyc", async (c) => {
  const auth = c.get("auth");
  const customer_id = auth.role === "customer" ? auth.customer_id : (auth.customer_id ?? "syn_alice");
  if (!customer_id) return c.json({ error: "고객이 필요합니다" }, 401);
  if (customer_id !== "syn_alice") {
    return c.json({ error: "샌드박스 실명 확인은 앨리스 데모 전용입니다" }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    display_name?: unknown;
    phone?: unknown;
    email?: unknown;
    id_placeholder?: unknown;
    acknowledgements?: unknown;
    scenario?: unknown;
  };
  const acknowledgements = Array.isArray(body.acknowledgements)
    ? body.acknowledgements.map((d) => String(d))
    : [];
  try {
    const result = bank.submitKyc(customer_id, {
      display_name: typeof body.display_name === "string" ? body.display_name : undefined,
      phone: typeof body.phone === "string" ? body.phone : undefined,
      email: typeof body.email === "string" ? body.email : undefined,
      id_placeholder: typeof body.id_placeholder === "string" ? body.id_placeholder : undefined,
      acknowledgements,
      scenario: typeof body.scenario === "string" ? body.scenario : undefined,
    });
    return c.json({ result, kyc: bank.kyc(customer_id), products: bank.shopProducts(customer_id) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "실명 확인을 진행할 수 없습니다" }, 400);
  }
});

app.post("/api/products/:id/enroll", async (c) => {
  const auth = c.get("auth");
  const customer_id = auth.role === "customer" ? auth.customer_id : (auth.customer_id ?? "syn_alice");
  const id = c.req.param("id");
  if (!customer_id) return c.json({ error: "고객이 필요합니다" }, 401);
  if (!isShopProductId(id)) return c.json({ error: "상품을 찾을 수 없습니다" }, 404);
  if (customer_id !== "syn_alice") {
    return c.json({ error: "이 상품 비교는 앨리스 데모 전용입니다" }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as { checked_documents?: unknown };
  const checked = Array.isArray(body.checked_documents)
    ? body.checked_documents.map((d) => String(d))
    : [];
  try {
    const result = bank.enrollProduct(customer_id, id, checked);
    return c.json({ result, products: bank.shopProducts(customer_id) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "가입을 진행할 수 없습니다" }, 400);
  }
});

app.post("/api/products/:id/dismiss", async (c) => {
  const auth = c.get("auth");
  const customer_id = auth.role === "customer" ? auth.customer_id : (auth.customer_id ?? "syn_alice");
  const id = c.req.param("id");
  if (!customer_id) return c.json({ error: "고객이 필요합니다" }, 401);
  if (!isShopProductId(id)) return c.json({ error: "상품을 찾을 수 없습니다" }, 404);
  bank.dismissShopProduct(customer_id, id);
  return c.json({ ok: true, products: bank.shopProducts(customer_id) });
});

app.get("/api/books", (c) => {
  const auth = c.get("auth");
  const customer_id = auth.customer_id ?? "syn_alice";
  return c.json({ books: bank.books(customer_id) });
});

app.post("/api/books/documents/:id", async (c) => {
  const auth = c.get("auth");
  const customer_id = auth.role === "customer" ? auth.customer_id : (auth.customer_id ?? "syn_alice");
  if (!customer_id) return c.json({ error: "고객이 필요합니다" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { held?: boolean };
  try {
    const documents = bank.setBookDocument(customer_id, c.req.param("id"), Boolean(body.held));
    return c.json({ documents, books: bank.books(customer_id) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "서류를 바꿀 수 없습니다" }, 400);
  }
});



app.get("/api/accounts", (c) => {
  const auth = c.get("auth");
  const accounts = bank.accounts(auth.role, auth.customer_id).filter((a) => a.product !== "HOUSE");
  return c.json({ accounts });
});

app.get("/api/accounts/:id", (c) => {
  const auth = c.get("auth");
  const view = bank.account(c.req.param("id"));
  if (!view) return c.json({ error: "not found" }, 404);
  if (view.product === "HOUSE") return c.json({ error: "not found" }, 404);
  if (auth.role === "customer" && view.customer_id !== auth.customer_id) {
    return c.json({ error: "forbidden" }, 403);
  }
  return c.json({ account: view });
});

app.post("/api/accounts/:id/status", async (c) => {
  if (c.get("auth").role !== "operator") {
    return c.json({ error: "only operator may set account status" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  if (!body.status || !isAccountStatus(body.status)) {
    return c.json({ error: "status must be OPEN | FROZEN | CLOSED" }, 400);
  }
  const view = bank.account(c.req.param("id"));
  if (!view || view.product === "HOUSE") return c.json({ error: "not found" }, 404);
  const result = bank.setStatus(c.req.param("id"), body.status, { actor: "operator" });
  return c.json({ result, account: bank.account(c.req.param("id")) });
});

app.get("/api/ledger", (c) => {
  const auth = c.get("auth");
  let journals = bank.journals();
  let entries = bank.entries();
  if (auth.role === "customer") {
    const mine = new Set(bank.accounts("customer", auth.customer_id).map((a) => a.id));
    journals = journals.filter((j) => mine.has(j.from_account_id) || mine.has(j.to_account_id));
    entries = entries.filter((e) => mine.has(String(e.account_id)));
  }
  return c.json({
    journals: journals.map(presentJournal),
    entries: entries.map((e) => presentEntry(e as Parameters<typeof presentEntry>[0])),
  });
});

app.get("/api/journals/:id", (c) => {
  const auth = c.get("auth");
  const journal = bank.journal(c.req.param("id"));
  if (!journal) return c.json({ error: "not found" }, 404);
  if (auth.role === "customer") {
    const mine = new Set(bank.accounts("customer", auth.customer_id).map((a) => a.id));
    if (!mine.has(journal.from_account_id) && !mine.has(journal.to_account_id)) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  return c.json({
    journal: presentJournal(journal),
    entries: bank.journalEntries(journal.id).map(presentEntry),
  });
});

app.get("/api/pending", (c) => {
  if (c.get("auth").role === "customer") return c.json(forbidCustomer("승인 대기"), 403);
  return c.json({ pending: bank.pending().map(presentJournal) });
});

app.get("/api/traces", (c) => {
  if (c.get("auth").role === "customer") return c.json(forbidCustomer("트레이스"), 403);
  return c.json({ sessions: bank.sessions(), traces: bank.traces() });
});

app.get("/api/audit", (c) => {
  const auth = c.get("auth");
  const journals = new Map(bank.journals().map((j) => [j.id, j]));
  let audit = bank
    .audit()
    .map((row) => presentAudit(row, row.journal_id ? journals.get(row.journal_id) : undefined))
    .reverse();
  if (auth.role === "customer") {
    const mine = new Set(bank.accounts("customer", auth.customer_id).map((a) => a.id));
    const myJournals = new Set(
      bank
        .journals()
        .filter((j) => mine.has(j.from_account_id) || mine.has(j.to_account_id))
        .map((j) => j.id),
    );
    const mySessions = new Set(bank.sessions().filter((s) => s.customer_id === auth.customer_id).map((s) => s.id));
    audit = audit.filter(
      (row) =>
        (row.journal_id && myJournals.has(row.journal_id)) ||
        (row.session_id && mySessions.has(row.session_id)),
    );
  }
  return c.json({ audit });
});

app.get("/api/disputes", (c) => {
  const auth = c.get("auth");
  let rows = bank.disputes();
  if (auth.role === "customer") {
    rows = rows.filter((d) => d.customer_id === auth.customer_id);
  }
  return c.json({ disputes: rows });
});

app.post("/api/sessions", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => ({}))) as { customer_id?: string };
  const customer_id =
    auth.role === "customer" ? auth.customer_id : (body.customer_id ?? "syn_alice");
  if (customer_id !== "syn_alice" && customer_id !== "syn_bob") {
    return c.json({ error: "unknown synthetic customer" }, 400);
  }
  const session = bank.startSession(customer_id!);
  return c.json({ session });
});

app.post("/api/tools", async (c) => {
  const body = (await c.req.json()) as {
    session_id: string;
    action: ToolName;
    args?: Record<string, unknown>;
    audit_id?: string;
  };
  if (!body.session_id || !body.action) {
    return c.json({ error: "session_id and action required" }, 400);
  }
  const result = bank.tool(body.session_id, body.action, body.args ?? {}, {
    actor: "agent",
    audit_id: body.audit_id,
  });
  return c.json({ result });
});

app.post("/api/operator/approve", async (c) => {
  if (c.get("auth").role !== "operator") {
    return c.json({ error: "only operator may approve" }, 403);
  }
  const body = (await c.req.json()) as { journal_id: string; audit_id?: string };
  if (!body.journal_id || !body.audit_id) {
    return c.json({ error: "journal_id and audit_id required" }, 400);
  }
  const result = bank.approve(body.journal_id, { actor: "operator", audit_id: body.audit_id });
  return c.json({ result });
});

app.post("/api/operator/deny", async (c) => {
  if (c.get("auth").role !== "operator") {
    return c.json({ error: "only operator may deny" }, 403);
  }
  const body = (await c.req.json()) as { journal_id: string; audit_id?: string };
  if (!body.journal_id || !body.audit_id) {
    return c.json({ error: "journal_id and audit_id required" }, 400);
  }
  const result = bank.deny(body.journal_id, { actor: "operator", audit_id: body.audit_id });
  return c.json({ result });
});

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "../../web/dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.notFound(async (c) => {
    const index = join(webDist, "index.html");
    if (existsSync(index) && !c.req.path.startsWith("/api/")) {
      const { readFileSync } = await import("node:fs");
      return c.html(readFileSync(index, "utf8"));
    }
    return c.json({ error: "not found" }, 404);
  });
}

const port = Number(process.env.PORT ?? 3001);
console.log(`SapiensQ sandbox API http://localhost:${port} (simulated KRW, not a bank)`);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.close(() => { void trustRuntime.chain.close().finally(() => { bank.close(); process.exit(0); }); });
});
