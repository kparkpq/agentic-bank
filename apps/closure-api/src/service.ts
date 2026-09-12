import { randomBytes, randomUUID } from "node:crypto";
import {
  ASSURANCE_PROFILE,
  SUCCESSFUL_STATE_PATH,
  createSignedEnvelope,
  deriveTransferEffect,
  evaluateKrwTransfer,
  hashDomainSeparatedJson,
  hashSignedObjectBody,
  hashTransferEffect,
  isActionWithinMandate,
  isMandateValidAtAuthorization,
  validateObject,
  verifyClosureProof,
  type AuthorizationDecision,
  type ClosureProof,
  type ClosureProofBody,
  type ConsumptionRecord,
  type DecisionInputSnapshot,
  type ExecutionCapsule,
  type ExecutionReceipt,
  type LedgerObservation,
  type Mandate,
  type ProposedAction,
  type SignedEnvelope,
  type TransferEffect,
  type TrustStore,
} from "@execution-closure/protocol";
import { Bank, withTx } from "@sapiensq/core";
import { createClosureRuntimeKeys, signatureInput, type ClosureRuntimeKeys } from "./authorities.js";
import { executeSyntheticTransfer } from "./executor.js";
import {
  consumeCapsule,
  ensureClosureSchema,
  getAuthorization,
  getIdempotency,
  getMandate,
  getProof,
  getProofByDecision,
  markAuthorizationClosed,
  saveAuthorization,
  saveIdempotency,
  saveMandate,
  saveProof,
} from "./repository.js";
import { extractLiveAccountSnapshot } from "./snapshot.js";

export type ServiceError = {
  status: 400 | 404 | 409 | 422;
  code: string;
  message: string;
};

export type ServiceResult<T> =
  | { ok: true; status: number; replay: boolean; value: T }
  | { ok: false; error: ServiceError };

type AuthorizationRecord = {
  mandate: SignedEnvelope<Mandate>;
  action: SignedEnvelope<ProposedAction>;
  effect: TransferEffect;
  decision_input: SignedEnvelope<DecisionInputSnapshot>;
  decision: SignedEnvelope<AuthorizationDecision>;
  capsule: SignedEnvelope<ExecutionCapsule>;
};

const LEDGER_ID = "synthetic-ledger-1";
const AGENT_ID = "synthetic-agent-1";
const ALLOWED_CUSTOMERS = new Set(["syn_alice"]);

function nowIso(now: Date): string {
  return now.toISOString();
}

function fail(status: ServiceError["status"], code: string, message: string): ServiceResult<never> {
  return { ok: false, error: { status, code, message } };
}

function requestHash(value: unknown): string {
  return hashDomainSeparatedJson("EC-v0/idempotency\u0000", value);
}

function readIdempotencyKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim() ?? "";
  return trimmed || undefined;
}

function replayOrConflict<T>(
  existing: { request_hash: string; status: number; response: unknown } | undefined,
  hash: string,
): ServiceResult<T> | undefined {
  if (!existing) return undefined;
  if (existing.request_hash !== hash) {
    return fail(409, "IDEMPOTENCY_CONFLICT", "idempotency key reused with a different body");
  }
  return { ok: true, status: existing.status, replay: true, value: existing.response as T };
}

function addHours(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function addMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

export class ExecutionClosureService {
  readonly keys: ClosureRuntimeKeys;

  constructor(
    readonly bank: Bank,
    readonly clock: () => Date = () => new Date(),
  ) {
    ensureClosureSchema(bank.db);
    this.keys = createClosureRuntimeKeys(nowIso(this.clock()));
  }

  trustStore(): TrustStore {
    return this.keys.trust_store;
  }

  registerMandate(
    idempotencyKey: string | undefined,
    input: {
      customer_id?: unknown;
      from_account_id?: unknown;
      to_account_id?: unknown;
      max_amount?: unknown;
      agent_id?: unknown;
    },
  ): ServiceResult<{ mandate_id: string; mandate: SignedEnvelope<Mandate> }> {
    const key = readIdempotencyKey(idempotencyKey);
    if (!key) return fail(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
    const request = {
      customer_id: input.customer_id,
      from_account_id: input.from_account_id,
      to_account_id: input.to_account_id,
      max_amount: input.max_amount,
      agent_id: input.agent_id ?? AGENT_ID,
    };
    const hash = requestHash(request);
    const replay = replayOrConflict<{ mandate_id: string; mandate: SignedEnvelope<Mandate> }>(
      getIdempotency(this.bank.db, "mandates", key),
      hash,
    );
    if (replay) return replay;

    const customerId = typeof request.customer_id === "string" ? request.customer_id : "";
    const fromAccountId = typeof request.from_account_id === "string" ? request.from_account_id : "";
    const toAccountId = typeof request.to_account_id === "string" ? request.to_account_id : "";
    const maxAmount = typeof request.max_amount === "string" ? request.max_amount : "";
    const agentId = typeof request.agent_id === "string" ? request.agent_id : AGENT_ID;
    if (!ALLOWED_CUSTOMERS.has(customerId)) {
      return fail(400, "UNKNOWN_CUSTOMER", "only synthetic customers may register a mandate");
    }
    const live = extractLiveAccountSnapshot(this.bank, fromAccountId, toAccountId, this.clock());
    if (!live || live.from_owner_customer_id !== customerId) {
      return fail(400, "UNKNOWN_ACCOUNT", "mandate accounts must exist and belong to the customer");
    }

    const now = this.clock();
    const issuedAt = nowIso(now);
    const mandateAuthority = this.keys.authorities.mandate_authority;
    const mandateBody: Mandate = {
      object_type: "Mandate",
      ...this.keys.pin,
      issuer: mandateAuthority.binding.issuer,
      key_id: mandateAuthority.binding.key_id,
      issued_at: issuedAt,
      mandate_id: `mandate-${randomUUID()}`,
      customer_id: customerId,
      agent_id: agentId,
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      currency: "KRW",
      max_amount: maxAmount,
      not_before: issuedAt,
      expires_at: addHours(now, 1),
    };
    const valid = validateObject("Mandate", mandateBody);
    if (!valid.valid) {
      return fail(400, "MALFORMED_MANDATE", valid.issues[0]?.message ?? "mandate is invalid");
    }
    const mandate = createSignedEnvelope(mandateBody, [signatureInput(mandateAuthority)]);
    const value = { mandate_id: mandateBody.mandate_id, mandate };
    withTx(this.bank.db, () => {
      saveMandate(this.bank.db, mandateBody.mandate_id, customerId, mandate);
      saveIdempotency(this.bank.db, "mandates", key, hash, 201, value);
    });
    return { ok: true, status: 201, replay: false, value };
  }

  authorize(
    mandateId: string,
    idempotencyKey: string | undefined,
    input: { amount?: unknown },
  ): ServiceResult<{
    decision_id: string;
    outcome: "ALLOW" | "DENY";
    reason_code: string;
    capsule_id: string | null;
  }> {
    const key = readIdempotencyKey(idempotencyKey);
    if (!key) return fail(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
    const request = { mandate_id: mandateId, amount: input.amount };
    const hash = requestHash(request);
    const replay = replayOrConflict<{
      decision_id: string;
      outcome: "ALLOW" | "DENY";
      reason_code: string;
      capsule_id: string | null;
    }>(getIdempotency(this.bank.db, "authorizations", key), hash);
    if (replay) return replay;

    const stored = getMandate(this.bank.db, mandateId);
    const parsed = stored ? validateObject("SignedEnvelope", stored) : undefined;
    const mandate =
      parsed?.valid &&
      typeof parsed.value.body === "object" &&
      parsed.value.body !== null &&
      (parsed.value.body as { object_type?: string }).object_type === "Mandate"
        ? (parsed.value as SignedEnvelope<Mandate>)
        : undefined;
    if (!mandate) return fail(404, "MANDATE_NOT_FOUND", "mandate was not found");

    const amount = typeof input.amount === "string" ? input.amount : "";
    const now = this.clock();
    const issuedAt = nowIso(now);
    const actionAuthority = this.keys.authorities.action_proposer;
    const actionBody: ProposedAction = {
      object_type: "ProposedAction",
      ...this.keys.pin,
      issuer: actionAuthority.binding.issuer,
      key_id: actionAuthority.binding.key_id,
      issued_at: issuedAt,
      action_id: `action-${randomUUID()}`,
      mandate_id: mandate.body.mandate_id,
      customer_id: mandate.body.customer_id,
      agent_id: mandate.body.agent_id,
      transfer: {
        from_account_id: mandate.body.from_account_id,
        to_account_id: mandate.body.to_account_id,
        currency: "KRW",
        amount,
      },
    };
    const actionValid = validateObject("ProposedAction", actionBody);
    if (!actionValid.valid) {
      return fail(400, "MALFORMED_ACTION", actionValid.issues[0]?.message ?? "action is invalid");
    }
    if (!isActionWithinMandate(mandate.body, actionBody)) {
      return fail(422, "OUT_OF_SCOPE", "action is outside the registered mandate");
    }
    if (!isMandateValidAtAuthorization(mandate.body, actionBody, issuedAt)) {
      return fail(422, "MANDATE_EXPIRED", "mandate is not valid at authorization time");
    }

    const live = extractLiveAccountSnapshot(
      this.bank,
      actionBody.transfer.from_account_id,
      actionBody.transfer.to_account_id,
      now,
    );
    if (!live) return fail(400, "UNKNOWN_ACCOUNT", "authorization accounts are unavailable");

    const action = createSignedEnvelope(actionBody, [signatureInput(actionAuthority)]);
    const effect = deriveTransferEffect(actionBody);
    const snapshotAuthority = this.keys.authorities.snapshot_authority;
    const snapshotBody: DecisionInputSnapshot = {
      object_type: "DecisionInputSnapshot",
      ...this.keys.pin,
      issuer: snapshotAuthority.binding.issuer,
      key_id: snapshotAuthority.binding.key_id,
      issued_at: issuedAt,
      snapshot_id: `snapshot-${randomUUID()}`,
      action_hash: hashSignedObjectBody(actionBody),
      mandate_hash: hashSignedObjectBody(mandate.body),
      policy_hash: hashSignedObjectBody(this.keys.policy.body),
      interpreter_hash: hashSignedObjectBody(this.keys.interpreter.body),
      ...live,
    };
    const decisionInput = createSignedEnvelope(snapshotBody, [signatureInput(snapshotAuthority)]);
    const evaluated = evaluateKrwTransfer(mandate.body, actionBody, this.keys.policy.body, snapshotBody);
    const decisionAuthority = this.keys.authorities.decision_authority;
    const decisionBody: AuthorizationDecision = {
      object_type: "AuthorizationDecision",
      ...this.keys.pin,
      issuer: decisionAuthority.binding.issuer,
      key_id: decisionAuthority.binding.key_id,
      issued_at: issuedAt,
      decision_id: `decision-${randomUUID()}`,
      action_hash: snapshotBody.action_hash,
      mandate_hash: snapshotBody.mandate_hash,
      policy_hash: snapshotBody.policy_hash,
      interpreter_hash: snapshotBody.interpreter_hash,
      snapshot_hash: hashSignedObjectBody(snapshotBody),
      outcome: evaluated.outcome,
      reason_code: evaluated.reason_code,
      approved_effect_hash: evaluated.outcome === "ALLOW" ? hashTransferEffect(effect) : null,
      authorized_at: issuedAt,
    };
    const decision = createSignedEnvelope(decisionBody, [signatureInput(decisionAuthority)]);

    if (evaluated.outcome !== "ALLOW" || !decisionBody.approved_effect_hash) {
      const value = {
        decision_id: decisionBody.decision_id,
        outcome: evaluated.outcome,
        reason_code: evaluated.reason_code,
        capsule_id: null,
      };
      saveIdempotency(this.bank.db, "authorizations", key, hash, 422, value);
      return { ok: true, status: 422, replay: false, value };
    }

    const capsuleAuthority = this.keys.authorities.capsule_authority;
    const capsuleBody: ExecutionCapsule = {
      object_type: "ExecutionCapsule",
      ...this.keys.pin,
      issuer: capsuleAuthority.binding.issuer,
      key_id: capsuleAuthority.binding.key_id,
      issued_at: issuedAt,
      capsule_id: `capsule-${randomUUID()}`,
      action_hash: decisionBody.action_hash,
      decision_hash: hashSignedObjectBody(decisionBody),
      approved_effect_hash: decisionBody.approved_effect_hash,
      not_before: issuedAt,
      expires_at: addMinutes(now, 10),
      nonce: `nonce-${randomBytes(8).toString("hex")}`,
    };
    const capsule = createSignedEnvelope(capsuleBody, [signatureInput(capsuleAuthority)]);
    const record: AuthorizationRecord = {
      mandate,
      action,
      effect,
      decision_input: decisionInput,
      decision,
      capsule,
    };
    const value = {
      decision_id: decisionBody.decision_id,
      outcome: evaluated.outcome,
      reason_code: evaluated.reason_code,
      capsule_id: capsuleBody.capsule_id,
    };
    withTx(this.bank.db, () => {
      saveAuthorization(
        this.bank.db,
        decisionBody.decision_id,
        mandate.body.mandate_id,
        capsuleBody.capsule_id,
        record,
      );
      saveIdempotency(this.bank.db, "authorizations", key, hash, 201, value);
    });
    return { ok: true, status: 201, replay: false, value };
  }

  commit(
    decisionId: string,
    idempotencyKey: string | undefined,
  ): ServiceResult<{ proof_id: string; proof: ClosureProof }> {
    const key = readIdempotencyKey(idempotencyKey);
    if (!key) return fail(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
    const request = { decision_id: decisionId };
    const hash = requestHash(request);
    const replay = replayOrConflict<{ proof_id: string; proof: ClosureProof }>(
      getIdempotency(this.bank.db, "commits", key),
      hash,
    );
    if (replay) return replay;

    const existingProof = getProofByDecision(this.bank.db, decisionId);
    if (existingProof) {
      const proof = existingProof as ClosureProof;
      const value = { proof_id: proof.body.proof_id, proof };
      saveIdempotency(this.bank.db, "commits", key, hash, 200, value);
      return { ok: true, status: 200, replay: false, value };
    }

    const authorization = getAuthorization(this.bank.db, decisionId);
    if (!authorization) return fail(404, "AUTHORIZATION_NOT_FOUND", "authorization was not found");
    const record = authorization.record as AuthorizationRecord;
    if (record.decision.body.outcome !== "ALLOW" || !record.decision.body.approved_effect_hash) {
      return fail(422, "DECISION_NOT_ALLOWED", "only ALLOW decisions can be committed");
    }

    const now = this.clock();
    const executedAt = nowIso(now);
    if (Date.parse(executedAt) >= Date.parse(record.capsule.body.expires_at)) {
      return fail(422, "CAPSULE_EXPIRED", "execution capsule has expired");
    }

    const live = extractLiveAccountSnapshot(
      this.bank,
      record.action.body.transfer.from_account_id,
      record.action.body.transfer.to_account_id,
      now,
    );
    if (
      !live ||
      live.spendable_funds !== record.decision_input.body.spendable_funds ||
      live.daily_spent !== record.decision_input.body.daily_spent ||
      live.from_account_status !== record.decision_input.body.from_account_status ||
      live.to_account_status !== record.decision_input.body.to_account_status
    ) {
      return fail(409, "SNAPSHOT_STALE", "live account state no longer matches the authorized snapshot");
    }

    const amount = Number(record.action.body.transfer.amount);
    try {
      const proof = withTx(this.bank.db, () => {
        if (!consumeCapsule(this.bank.db, record.capsule.body.capsule_id, executedAt)) {
          throw new Error("CAPSULE_REUSED");
        }
        const posted = executeSyntheticTransfer(this.bank, {
          customer_id: record.action.body.customer_id,
          from_account_id: record.action.body.transfer.from_account_id,
          to_account_id: record.action.body.transfer.to_account_id,
          amount,
          idempotency_key: `closure:${record.capsule.body.capsule_id}`,
        });
        const closed = this.closeProof(record, posted.ledger_sequence, executedAt);
        const value = { proof_id: closed.body.proof_id, proof: closed };
        saveProof(this.bank.db, closed.body.proof_id, decisionId, closed);
        markAuthorizationClosed(this.bank.db, decisionId);
        saveIdempotency(this.bank.db, "commits", key, hash, 201, value);
        return closed;
      });
      return { ok: true, status: 201, replay: false, value: { proof_id: proof.body.proof_id, proof } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "synthetic commit failed";
      if (message === "CAPSULE_REUSED") {
        return fail(409, "CAPSULE_REUSED", "execution capsule was already consumed");
      }
      return fail(422, "EXECUTION_FAILED", message);
    }
  }

  loadProof(proofId: string): ServiceResult<{ proof_id: string; proof: ClosureProof }> {
    const stored = getProof(this.bank.db, proofId);
    if (!stored) return fail(404, "PROOF_NOT_FOUND", "proof was not found");
    const proof = stored as ClosureProof;
    return { ok: true, status: 200, replay: false, value: { proof_id: proof.body.proof_id, proof } };
  }

  verifyStoredProof(proofId: string): ServiceResult<ReturnType<typeof verifyClosureProof>> {
    const loaded = this.loadProof(proofId);
    if (!loaded.ok) return loaded;
    return {
      ok: true,
      status: 200,
      replay: false,
      value: verifyClosureProof(loaded.value.proof, this.keys.trust_store),
    };
  }

  private closeProof(record: AuthorizationRecord, ledgerSequence: string, executedAt: string): ClosureProof {
    const executor = this.keys.authorities.executor;
    const ledger = this.keys.authorities.ledger;
    const consumptionBody: ConsumptionRecord = {
      object_type: "ConsumptionRecord",
      ...this.keys.pin,
      issuer: executor.binding.issuer,
      key_id: executor.binding.key_id,
      issued_at: executedAt,
      consumption_id: `consumption-${randomUUID()}`,
      capsule_hash: hashSignedObjectBody(record.capsule.body),
      action_hash: record.decision.body.action_hash,
      decision_hash: hashSignedObjectBody(record.decision.body),
      checkpoint_sequence: "1",
      previous_checkpoint_hash: null,
      consumed_at: executedAt,
    };
    const consumption = createSignedEnvelope(consumptionBody, [signatureInput(executor)]);
    const receiptBody: ExecutionReceipt = {
      object_type: "ExecutionReceipt",
      ...this.keys.pin,
      issuer: executor.binding.issuer,
      key_id: executor.binding.key_id,
      issued_at: executedAt,
      receipt_id: `receipt-${randomUUID()}`,
      executor_issuer: executor.binding.issuer,
      executor_key_id: executor.binding.key_id,
      ledger_issuer: ledger.binding.issuer,
      ledger_key_id: ledger.binding.key_id,
      ledger_id: LEDGER_ID,
      capsule_hash: consumptionBody.capsule_hash,
      consumption_hash: hashSignedObjectBody(consumptionBody),
      action_hash: consumptionBody.action_hash,
      decision_hash: consumptionBody.decision_hash,
      effect_hash: record.decision.body.approved_effect_hash!,
      status: "EXECUTED",
      executed_at: executedAt,
    };
    const receipt = createSignedEnvelope(receiptBody, [signatureInput(executor), signatureInput(ledger)]);
    const observationBody: LedgerObservation = {
      object_type: "LedgerObservation",
      ...this.keys.pin,
      issuer: ledger.binding.issuer,
      key_id: ledger.binding.key_id,
      issued_at: executedAt,
      observation_id: `observation-${randomUUID()}`,
      ledger_id: LEDGER_ID,
      receipt_body_hash: hashSignedObjectBody(receiptBody),
      effect_hash: receiptBody.effect_hash,
      status: "POSTED",
      ledger_sequence: ledgerSequence,
      observed_at: executedAt,
    };
    const ledgerObservation = createSignedEnvelope(observationBody, [signatureInput(ledger)]);
    const closureAuthority = this.keys.authorities.closure_authority;
    const proofBody: ClosureProofBody = {
      object_type: "ClosureProof",
      ...this.keys.pin,
      issuer: closureAuthority.binding.issuer,
      key_id: closureAuthority.binding.key_id,
      issued_at: executedAt,
      proof_id: `proof-${randomUUID()}`,
      assurance_profile: ASSURANCE_PROFILE,
      manifest: this.keys.manifest,
      mandate: record.mandate,
      action: record.action,
      effect: record.effect,
      policy: this.keys.policy,
      interpreter: this.keys.interpreter,
      decision_input: record.decision_input,
      decision: record.decision,
      capsule: record.capsule,
      consumption_records: [consumption],
      receipt,
      ledger_observation: ledgerObservation,
      state_path: [...SUCCESSFUL_STATE_PATH],
      closed_at: executedAt,
    };
    return createSignedEnvelope(proofBody, [signatureInput(closureAuthority)]);
  }
}
