import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bank } from "@sapiensq/core";
import { describe, expect, it } from "vitest";
import { createClosureApp } from "./app.js";
import { ExecutionClosureService } from "./service.js";

const PROTOCOL_VERIFY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/protocol/bin/execution-closure-verify.mjs",
);

const MANDATE_BODY = {
  customer_id: "syn_alice",
  from_account_id: "acc_alice_chk",
  to_account_id: "acc_alice_sav",
  max_amount: "500000",
};

function runtime() {
  const bank = new Bank(":memory:");
  bank.seed();
  const service = new ExecutionClosureService(bank);
  return { bank, service, app: createClosureApp(service) };
}

async function requestJson(
  app: ReturnType<typeof createClosureApp>,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  const response = await app.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("closure-api Stage 1 happy path", () => {
  it("authorizes without moving money, then commits, closes, and verifies offline", async () => {
    const { bank, service, app } = runtime();

    const mandate = await requestJson(app, "/v1/mandates", {
      method: "POST",
      idempotencyKey: "mandate-1",
      body: MANDATE_BODY,
    });
    expect(mandate.status).toBe(201);
    const mandateId = mandate.body.mandate_id as string;

    const replayMandate = await requestJson(app, "/v1/mandates", {
      method: "POST",
      idempotencyKey: "mandate-1",
      body: MANDATE_BODY,
    });
    expect(replayMandate.status).toBe(201);
    expect(replayMandate.body.mandate_id).toBe(mandateId);

    const conflict = await requestJson(app, "/v1/mandates", {
      method: "POST",
      idempotencyKey: "mandate-1",
      body: { ...MANDATE_BODY, max_amount: "400000" },
    });
    expect(conflict.status).toBe(409);

    const authorize = await requestJson(app, `/v1/mandates/${mandateId}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-1",
      body: { amount: "300000" },
    });
    expect(authorize.status).toBe(201);
    expect(authorize.body.outcome).toBe("ALLOW");
    expect(authorize.body.reason_code).toBe("POLICY_ALLOW");
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    expect(bank.account("acc_alice_sav")?.available).toBe(200_000);

    const replayAuthorize = await requestJson(app, `/v1/mandates/${mandateId}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-1",
      body: { amount: "300000" },
    });
    expect(replayAuthorize.status).toBe(201);
    expect(replayAuthorize.body.decision_id).toBe(authorize.body.decision_id);

    const commit = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-1",
    });
    expect(commit.status).toBe(201);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_700_000);
    expect(bank.account("acc_alice_sav")?.available).toBe(500_000);

    const replayCommit = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-1",
    });
    expect(replayCommit.status).toBe(201);
    expect(replayCommit.body.proof_id).toBe(commit.body.proof_id);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_700_000);

    const loaded = await requestJson(app, `/v1/proofs/${commit.body.proof_id}`);
    expect(loaded.status).toBe(200);
    expect((loaded.body.proof as { body: { state_path: string[] } }).body.state_path).toEqual([
      "PROPOSED",
      "AUTHORIZED",
      "EXECUTION_INTENT_RECORDED",
      "EXECUTED",
      "CLOSED",
    ]);

    const verified = await requestJson(app, `/v1/proofs/${commit.body.proof_id}/verify`, { method: "POST" });
    expect(verified.status).toBe(200);
    expect(verified.body.valid).toBe(true);
    expect(verified.body.code).toBe("VALID");

    const dir = mkdtempSync(join(tmpdir(), "closure-proof-"));
    const proofFile = join(dir, "proof.json");
    const trustFile = join(dir, "trust-store.json");
    writeFileSync(proofFile, JSON.stringify(commit.body.proof));
    writeFileSync(trustFile, JSON.stringify(service.trustStore()));
    const cli = execFileSync(process.execPath, ["--import", "tsx", PROTOCOL_VERIFY, proofFile, trustFile], {
      encoding: "utf8",
    });
    expect(JSON.parse(cli)).toMatchObject({ valid: true, code: "VALID" });
  });

  it("rejects step-up amounts and stale snapshots without posting a success proof", async () => {
    const { bank, app } = runtime();

    const missing = await requestJson(app, "/v1/mandates", { method: "POST", body: MANDATE_BODY });
    expect(missing.status).toBe(400);

    const mandate = await requestJson(app, "/v1/mandates", {
      method: "POST",
      idempotencyKey: "mandate-deny",
      body: { ...MANDATE_BODY, max_amount: "2000000" },
    });
    const stepUp = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-step-up",
      body: { amount: "1000000" },
    });
    expect(stepUp.status).toBe(422);
    expect(stepUp.body.outcome).toBe("DENY");
    expect(stepUp.body.reason_code).toBe("STEP_UP_REQUIRED");
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const allowed = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-stale",
      body: { amount: "300000" },
    });
    const session = bank.startSession("syn_alice");
    bank.tool(session.id, "handoff", { to: "transfer" });
    bank.tool(session.id, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      idempotency_key: "outside-closure",
    });
    const stale = await requestJson(app, `/v1/authorizations/${allowed.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-stale",
    });
    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe("SNAPSHOT_STALE");
    expect(bank.account("acc_alice_chk")?.available).toBe(9_900_000);
  });
});
