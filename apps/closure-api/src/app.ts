import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ExecutionClosureService, ServiceResult } from "./service.js";

function idempotencyKey(header: string | undefined): string | undefined {
  const trimmed = header?.trim();
  return trimmed ? trimmed : undefined;
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

function reply(c: Context, result: ServiceResult<unknown>) {
  if (!result.ok) {
    return c.json({ error: { code: result.error.code, message: result.error.message } }, result.error.status);
  }
  return c.json(result.value, result.status as ContentfulStatusCode);
}

export function createClosureApp(service: ExecutionClosureService): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, surface: "closure-api" }));

  app.get("/v1/trust-store", (c) => c.json(service.trustStore()));

  app.post("/v1/mandates", async (c) => {
    const body = await readJson(c.req.raw);
    if (!body.ok || typeof body.value !== "object" || body.value === null) {
      return c.json({ error: { code: "MALFORMED_JSON", message: "request body must be JSON" } }, 400);
    }
    const input = body.value as Record<string, unknown>;
    return reply(
      c,
      service.registerMandate(idempotencyKey(c.req.header("Idempotency-Key")), {
        customer_id: input.customer_id,
        from_account_id: input.from_account_id,
        to_account_id: input.to_account_id,
        max_amount: input.max_amount,
        agent_id: input.agent_id,
      }),
    );
  });

  app.post("/v1/mandates/:mandateId/authorizations", async (c) => {
    const body = await readJson(c.req.raw);
    if (!body.ok || typeof body.value !== "object" || body.value === null) {
      return c.json({ error: { code: "MALFORMED_JSON", message: "request body must be JSON" } }, 400);
    }
    const input = body.value as Record<string, unknown>;
    return reply(
      c,
      service.authorize(c.req.param("mandateId"), idempotencyKey(c.req.header("Idempotency-Key")), {
        amount: input.amount,
      }),
    );
  });

  app.post("/v1/authorizations/:decisionId/approvals", async (c) => {
    return reply(
      c,
      service.approve(
        c.req.param("decisionId"),
        idempotencyKey(c.req.header("Idempotency-Key")),
        c.req.header("X-Approver-Id"),
      ),
    );
  });

  app.post("/v1/mandates/:mandateId/revoke", async (c) => {
    return reply(c, service.revokeMandate(c.req.param("mandateId"), idempotencyKey(c.req.header("Idempotency-Key"))));
  });

  app.post("/v1/authorizations/:decisionId/commit", async (c) => {
    return reply(c, service.commit(c.req.param("decisionId"), idempotencyKey(c.req.header("Idempotency-Key"))));
  });

  app.post("/v1/authorizations/:decisionId/reconcile", async (c) => {
    return reply(c, service.reconcile(c.req.param("decisionId"), idempotencyKey(c.req.header("Idempotency-Key"))));
  });

  app.get("/v1/authorizations/:decisionId", (c) => reply(c, service.authorizationStatus(c.req.param("decisionId"))));

  app.get("/v1/unresolved", (c) => reply(c, service.unresolvedQueue()));

  app.get("/v1/proofs/:proofId", (c) => reply(c, service.loadProof(c.req.param("proofId"))));

  app.post("/v1/proofs/:proofId/verify", (c) => reply(c, service.verifyStoredProof(c.req.param("proofId"))));

  return app;
}
