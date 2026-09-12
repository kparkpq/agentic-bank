import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bank } from "@sapiensq/core";
import { describe, expect, it } from "vitest";
import { createClosureApp } from "./app.js";
import {
  defaultClosureExecutor,
  ExecutionTimeoutError,
  executeSyntheticTransfer,
  lookupSyntheticTransfer,
  type ClosureExecutor,
} from "./executor.js";
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

function runtime(clock?: () => Date, executor?: ClosureExecutor) {
  const bank = new Bank(":memory:");
  bank.seed();
  const service = new ExecutionClosureService(bank, clock ?? (() => new Date()), executor ?? defaultClosureExecutor);
  return { bank, service, app: createClosureApp(service) };
}

async function requestJson(
  app: ReturnType<typeof createClosureApp>,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string; approverId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  if (init.approverId) headers.set("X-Approver-Id", init.approverId);
  const response = await app.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function registerMandate(
  app: ReturnType<typeof createClosureApp>,
  key: string,
  body: Record<string, string> = MANDATE_BODY,
) {
  return requestJson(app, "/v1/mandates", { method: "POST", idempotencyKey: key, body });
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

  it("rejects stale snapshots without posting a success proof", async () => {
    const { bank, app } = runtime();

    const missing = await requestJson(app, "/v1/mandates", { method: "POST", body: MANDATE_BODY });
    expect(missing.status).toBe(400);

    const mandate = await registerMandate(app, "mandate-stale");
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

describe("closure-api Stage 2 controls", () => {
  it("closes NSF, out-of-scope, and frozen denials with no action-labelled mutation", async () => {
    const { bank, service, app } = runtime();
    const mandate = await registerMandate(app, "mandate-deny", { ...MANDATE_BODY, max_amount: "20000000" });

    const nsf = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-nsf",
      body: { amount: "11000000" },
    });
    expect(nsf.status).toBe(422);
    expect(nsf.body.outcome).toBe("DENY");
    expect(nsf.body.reason_code).toBe("INSUFFICIENT_SPENDABLE_FUNDS");
    expect(nsf.body.proof_id).toBeTruthy();
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    const nsfVerify = await requestJson(app, `/v1/proofs/${nsf.body.proof_id}/verify`, { method: "POST" });
    expect(nsfVerify.body).toMatchObject({ valid: true, code: "VALID", closure_kind: "negative" });

    const scoped = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-scope",
      body: { amount: "20000001" },
    });
    expect(scoped.status).toBe(422);
    expect((scoped.body.error as { code: string }).code).toBe("OUT_OF_SCOPE");
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    bank.setStatus("acc_alice_chk", "FROZEN");
    const frozen = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-frozen",
      body: { amount: "300000" },
    });
    expect(frozen.status).toBe(422);
    expect(frozen.body.reason_code).toBe("SOURCE_ACCOUNT_NOT_OPEN");
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    const frozenVerify = await requestJson(app, `/v1/proofs/${frozen.body.proof_id}/verify`, { method: "POST" });
    expect(frozenVerify.body).toMatchObject({ valid: true, code: "VALID", closure_kind: "negative" });
    expect(service.trustStore().trusted_roots).toHaveLength(1);
  });

  it("requires a distinct approver for step-up, then commits and verifies offline", async () => {
    const { bank, service, app } = runtime();
    const mandate = await registerMandate(app, "mandate-step-up", { ...MANDATE_BODY, max_amount: "2000000" });
    const stepUp = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-step-up",
      body: { amount: "1000000" },
    });
    expect(stepUp.status).toBe(202);
    expect(stepUp.body.outcome).toBe("STEP_UP");
    expect(stepUp.body.reason_code).toBe("STEP_UP_REQUIRED");
    expect(stepUp.body.capsule_id).toBeNull();
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const selfApprove = await requestJson(app, `/v1/authorizations/${stepUp.body.decision_id}/approvals`, {
      method: "POST",
      idempotencyKey: "approve-self",
      approverId: "syn_alice",
    });
    expect(selfApprove.status).toBe(422);
    expect((selfApprove.body.error as { code: string }).code).toBe("SEPARATION_FAILURE");

    const approved = await requestJson(app, `/v1/authorizations/${stepUp.body.decision_id}/approvals`, {
      method: "POST",
      idempotencyKey: "approve-operator",
      approverId: "syn_operator",
    });
    expect(approved.status).toBe(201);
    expect(approved.body.state).toBe("APPROVED");
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const commit = await requestJson(app, `/v1/authorizations/${stepUp.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-step-up",
    });
    expect(commit.status).toBe(201);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_000_000);
    expect(bank.account("acc_alice_sav")?.available).toBe(1_200_000);
    expect((commit.body.proof as { body: { state_path: string[] } }).body.state_path).toEqual([
      "PROPOSED",
      "STEP_UP_REQUIRED",
      "APPROVED",
      "EXECUTION_INTENT_RECORDED",
      "EXECUTED",
      "CLOSED",
    ]);

    const verified = await requestJson(app, `/v1/proofs/${commit.body.proof_id}/verify`, { method: "POST" });
    expect(verified.body).toMatchObject({ valid: true, code: "VALID", closure_kind: "success" });

    const dir = mkdtempSync(join(tmpdir(), "closure-step-up-"));
    const proofFile = join(dir, "proof.json");
    const trustFile = join(dir, "trust-store.json");
    writeFileSync(proofFile, JSON.stringify(commit.body.proof));
    writeFileSync(trustFile, JSON.stringify(service.trustStore()));
    const cli = execFileSync(process.execPath, ["--import", "tsx", PROTOCOL_VERIFY, proofFile, trustFile], {
      encoding: "utf8",
    });
    expect(JSON.parse(cli)).toMatchObject({ valid: true, code: "VALID" });
  });

  it("revokes an authorized action without moving money", async () => {
    const { bank, app } = runtime();
    const mandate = await registerMandate(app, "mandate-revoke");
    const authorize = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-revoke",
      body: { amount: "300000" },
    });
    expect(authorize.status).toBe(201);

    const revoked = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/revoke`, {
      method: "POST",
      idempotencyKey: "revoke-1",
    });
    expect(revoked.status).toBe(200);
    expect((revoked.body.proof_ids as string[]).length).toBe(1);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const commit = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-revoked",
    });
    expect(commit.status).toBe(200);
    expect((commit.body.proof as { body: { object_type: string; terminal_reason: string } }).body.object_type).toBe(
      "NegativeClosureProof",
    );
    expect((commit.body.proof as { body: { terminal_reason: string } }).body.terminal_reason).toBe("REVOKED");
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const later = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-after-revoke",
      body: { amount: "300000" },
    });
    expect(later.status).toBe(422);
    expect((later.body.error as { code: string }).code).toBe("MANDATE_REVOKED");
  });

  it("closes an expired mandate without moving money", async () => {
    let now = new Date("2026-06-01T00:00:00.000Z");
    const { bank, app } = runtime(() => now);
    const mandate = await registerMandate(app, "mandate-expiry");
    now = new Date("2026-06-01T02:00:00.000Z");
    const expired = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-expired",
      body: { amount: "300000" },
    });
    expect(expired.status).toBe(422);
    expect(expired.body.reason_code).toBe("MANDATE_EXPIRED");
    expect(expired.body.proof_id).toBeTruthy();
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);
    const verified = await requestJson(app, `/v1/proofs/${expired.body.proof_id}/verify`, { method: "POST" });
    expect(verified.body).toMatchObject({ valid: true, code: "VALID", closure_kind: "negative" });
  });
});

describe("closure-api Stage 3 recovery", () => {
  it("treats a pre-effect timeout as EXECUTION_UNKNOWN and does not move money", async () => {
    const executor: ClosureExecutor = {
      execute: () => {
        throw new ExecutionTimeoutError();
      },
      lookup: lookupSyntheticTransfer,
    };
    const { bank, app } = runtime(undefined, executor);
    const mandate = await registerMandate(app, "mandate-unknown");
    const authorize = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-unknown",
      body: { amount: "300000" },
    });
    const commit = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-unknown",
    });
    expect(commit.status).toBe(202);
    expect(commit.body.state).toBe("EXECUTION_UNKNOWN");
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const status = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}`);
    expect(status.body.state).toBe("EXECUTION_UNKNOWN");

    const reconcile = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}/reconcile`, {
      method: "POST",
    });
    expect(reconcile.status).toBe(202);
    expect(bank.account("acc_alice_chk")?.available).toBe(10_000_000);

    const unresolved = await requestJson(app, "/v1/unresolved");
    expect((unresolved.body.jobs as unknown[]).length).toBeGreaterThan(0);
  });

  it("looks up the original receipt after a post-effect timeout and does not double-post", async () => {
    const executor: ClosureExecutor = {
      execute: (bank, input) => {
        const posted = executeSyntheticTransfer(bank, input);
        throw new ExecutionTimeoutError();
        return posted;
      },
      lookup: lookupSyntheticTransfer,
    };
    const { bank, app } = runtime(undefined, executor);
    const mandate = await registerMandate(app, "mandate-after-effect");
    const authorize = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-after-effect",
      body: { amount: "300000" },
    });
    const commit = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-after-effect",
    });
    expect(commit.status).toBe(202);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_700_000);

    const reconcile = await requestJson(app, `/v1/authorizations/${authorize.body.decision_id}/reconcile`, {
      method: "POST",
    });
    expect(reconcile.status).toBe(201);
    expect(bank.account("acc_alice_chk")?.available).toBe(9_700_000);
    expect((reconcile.body.proof as { body: { state_path: string[] } }).body.state_path).toEqual([
      "PROPOSED",
      "AUTHORIZED",
      "EXECUTION_INTENT_RECORDED",
      "EXECUTED",
      "CLOSED",
    ]);
    const verified = await requestJson(app, `/v1/proofs/${reconcile.body.proof_id}/verify`, { method: "POST" });
    expect(verified.body).toMatchObject({ valid: true, code: "VALID", closure_kind: "success" });
  });

  it("fails closed on clock rollback and keeps an unresolved queue after budget exhaustion", async () => {
    let now = new Date("2026-06-01T00:00:00.000Z");
    const { app, service } = runtime(() => now);
    const mandate = await registerMandate(app, "mandate-clock");
    now = new Date("2026-05-31T23:00:00.000Z");
    const authorize = await requestJson(app, `/v1/mandates/${mandate.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-clock",
      body: { amount: "300000" },
    });
    expect(authorize.status).toBe(422);
    expect((authorize.body.error as { code: string }).code).toBe("CLOCK_ROLLBACK");

    now = new Date("2026-06-01T00:01:00.000Z");
    const timeoutExecutor: ClosureExecutor = {
      execute: () => {
        throw new ExecutionTimeoutError();
      },
      lookup: () => undefined,
    };
    const timed = runtime(() => now, timeoutExecutor);
    const mandate2 = await registerMandate(timed.app, "mandate-budget");
    const allowed = await requestJson(timed.app, `/v1/mandates/${mandate2.body.mandate_id}/authorizations`, {
      method: "POST",
      idempotencyKey: "auth-budget",
      body: { amount: "300000" },
    });
    await requestJson(timed.app, `/v1/authorizations/${allowed.body.decision_id}/commit`, {
      method: "POST",
      idempotencyKey: "commit-budget",
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      now = new Date(now.getTime() + 120_000);
      timed.service.runReconciliationWorker();
    }
    const queue = await requestJson(timed.app, "/v1/unresolved");
    expect((queue.body.jobs as Array<{ state: string }>).some((job) => job.state === "unresolved")).toBe(true);
    expect(service.trustStore().installed_at).toBeTruthy();
  });
});
