import { randomBytes, randomUUID } from "node:crypto";
import {
  ASSURANCE_PROFILE,
  SUCCESSFUL_STATE_PATH,
  SUCCESSFUL_STEP_UP_STATE_PATH,
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
  type NegativeClosureProof,
  type NegativeClosureProofBody,
  type NegativeTerminalReason,
  type ProposedAction,
  type ProtocolState,
  type SignedEnvelope,
  type StepUpApproval,
  type TransferEffect,
  type TrustStore,
} from "@execution-closure/protocol";
import { Bank, withTx } from "@sapiensq/core";
import { createClosureRuntimeKeys, signatureInput, type ClosureRuntimeKeys } from "./authorities.js";
import {
  defaultClosureExecutor,
  ExecutionTimeoutError,
  type ClosureExecutor,
  type ExecutedTransfer,
} from "./executor.js";
import {
  backoffJob,
  claimDueJobs,
  completeJob,
  consumeCapsule,
  countActionMutations,
  enqueueReconciliationJob,
  ensureClosureSchema,
  getAuthorization,
  getIdempotency,
  getJobByDecision,
  getMandate,
  getProof,
  getProofByDecision,
  isMandateRevoked,
  listAuthorizationsByMandate,
  listUnresolvedJobs,
  markAuthorizationClosed,
  nextLedgerSequence,
  observeClock,
  revokeMandate as persistMandateRevocation,
  saveAuthorization,
  saveIdempotency,
  saveMandate,
  saveProof,
  updateAuthorization,
} from "./repository.js";
import { extractLiveAccountSnapshot } from "./snapshot.js";

export type ServiceError = {
  status: 400 | 404 | 409 | 422 | 503;
  code: string;
  message: string;
};

export type ServiceResult<T> =
  | { ok: true; status: number; replay: boolean; value: T }
  | { ok: false; error: ServiceError };

export type AnyStoredProof = ClosureProof | NegativeClosureProof;

type AuthorizationRecord = {
  mandate: SignedEnvelope<Mandate>;
  action: SignedEnvelope<ProposedAction>;
  effect: TransferEffect;
  decision_input: SignedEnvelope<DecisionInputSnapshot>;
  decision: SignedEnvelope<AuthorizationDecision>;
  capsule: SignedEnvelope<ExecutionCapsule> | null;
  approval: SignedEnvelope<StepUpApproval> | null;
  state_path: ProtocolState[];
};

type AuthorizeValue = {
  decision_id: string;
  outcome: "ALLOW" | "DENY" | "STEP_UP";
  reason_code: string;
  capsule_id: string | null;
  proof_id: string | null;
};

const LEDGER_ID = "synthetic-ledger-1";
const AGENT_ID = "synthetic-agent-1";
const ALLOWED_CUSTOMERS = new Set(["syn_alice"]);
const ALLOWED_APPROVERS = new Set(["syn_operator"]);
const OPEN_STATES = new Set(["AUTHORIZED", "STEP_UP_REQUIRED", "APPROVED"]);
const INTENDED_STATES = new Set(["EXECUTION_INTENT_RECORDED", "EXECUTION_UNKNOWN"]);
const WORKER_ID = "closure-worker-1";
const LEASE_MS = 2_000;
const MAX_ATTEMPTS = 5;

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

function parseMandate(stored: unknown): SignedEnvelope<Mandate> | undefined {
  const parsed = stored ? validateObject("SignedEnvelope", stored) : undefined;
  return parsed?.valid &&
    typeof parsed.value.body === "object" &&
    parsed.value.body !== null &&
    (parsed.value.body as { object_type?: string }).object_type === "Mandate"
    ? (parsed.value as SignedEnvelope<Mandate>)
    : undefined;
}

function asRecord(value: unknown): AuthorizationRecord {
  return value as AuthorizationRecord;
}

export class ExecutionClosureService {
  readonly keys: ClosureRuntimeKeys;
  readonly executor: ClosureExecutor;

  constructor(
    readonly bank: Bank,
    readonly clock: () => Date = () => new Date(),
    executor: ClosureExecutor = defaultClosureExecutor,
  ) {
    ensureClosureSchema(bank.db);
    this.executor = executor;
    this.keys = createClosureRuntimeKeys(nowIso(this.clock()));
  }

  private observedNow(): ServiceResult<Date> {
    const now = this.clock();
    const observed = observeClock(this.bank.db, now.getTime());
    if (!observed.ok) {
      return fail(422, "CLOCK_ROLLBACK", "system clock moved behind the persisted last observed time");
    }
    return { ok: true, status: 200, replay: false, value: new Date(observed.observed_ms) };
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

    const observed = this.observedNow();
    if (!observed.ok) return observed;
    const now = observed.value;
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
  ): ServiceResult<AuthorizeValue> {
    const key = readIdempotencyKey(idempotencyKey);
    if (!key) return fail(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
    const request = { mandate_id: mandateId, amount: input.amount };
    const hash = requestHash(request);
    const replay = replayOrConflict<AuthorizeValue>(getIdempotency(this.bank.db, "authorizations", key), hash);
    if (replay) return replay;

    const mandate = parseMandate(getMandate(this.bank.db, mandateId));
    if (!mandate) return fail(404, "MANDATE_NOT_FOUND", "mandate was not found");
    if (isMandateRevoked(this.bank.db, mandateId)) {
      return fail(422, "MANDATE_REVOKED", "mandate has been revoked");
    }

    const amount = typeof input.amount === "string" ? input.amount : "";
    const observed = this.observedNow();
    if (!observed.ok) return observed;
    const now = observed.value;
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
    const expired = !isMandateValidAtAuthorization(mandate.body, actionBody, issuedAt);
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
      approved_effect_hash:
        evaluated.outcome === "ALLOW" || evaluated.outcome === "STEP_UP" ? hashTransferEffect(effect) : null,
      authorized_at: issuedAt,
    };
    const decision = createSignedEnvelope(decisionBody, [signatureInput(decisionAuthority)]);
    const record: AuthorizationRecord = {
      mandate,
      action,
      effect,
      decision_input: decisionInput,
      decision,
      capsule: null,
      approval: null,
      state_path: ["PROPOSED"],
    };

    if (expired) {
      const proof = this.closeNegative(record, "EXPIRED", ["PROPOSED", "EXPIRED", "CLOSED"], issuedAt);
      const value: AuthorizeValue = {
        decision_id: decisionBody.decision_id,
        outcome: evaluated.outcome,
        reason_code: "MANDATE_EXPIRED",
        capsule_id: null,
        proof_id: proof.body.proof_id,
      };
      withTx(this.bank.db, () => {
        saveAuthorization(
          this.bank.db,
          decisionBody.decision_id,
          mandate.body.mandate_id,
          actionBody.action_id,
          null,
          "CLOSED",
          { ...record, state_path: proof.body.state_path },
        );
        saveProof(this.bank.db, proof.body.proof_id, decisionBody.decision_id, proof);
        saveIdempotency(this.bank.db, "authorizations", key, hash, 422, value);
      });
      return { ok: true, status: 422, replay: false, value };
    }

    if (evaluated.outcome === "DENY") {
      const proof = this.closeNegative(record, "AUTHORIZATION_DENIED", ["PROPOSED", "AUTHORIZATION_DENIED", "CLOSED"], issuedAt);
      const value: AuthorizeValue = {
        decision_id: decisionBody.decision_id,
        outcome: "DENY",
        reason_code: evaluated.reason_code,
        capsule_id: null,
        proof_id: proof.body.proof_id,
      };
      withTx(this.bank.db, () => {
        saveAuthorization(
          this.bank.db,
          decisionBody.decision_id,
          mandate.body.mandate_id,
          actionBody.action_id,
          null,
          "CLOSED",
          { ...record, state_path: proof.body.state_path },
        );
        saveProof(this.bank.db, proof.body.proof_id, decisionBody.decision_id, proof);
        saveIdempotency(this.bank.db, "authorizations", key, hash, 422, value);
      });
      return { ok: true, status: 422, replay: false, value };
    }

    if (evaluated.outcome === "STEP_UP") {
      record.state_path = ["PROPOSED", "STEP_UP_REQUIRED"];
      const value: AuthorizeValue = {
        decision_id: decisionBody.decision_id,
        outcome: "STEP_UP",
        reason_code: evaluated.reason_code,
        capsule_id: null,
        proof_id: null,
      };
      withTx(this.bank.db, () => {
        saveAuthorization(
          this.bank.db,
          decisionBody.decision_id,
          mandate.body.mandate_id,
          actionBody.action_id,
          null,
          "STEP_UP_REQUIRED",
          record,
        );
        saveIdempotency(this.bank.db, "authorizations", key, hash, 202, value);
      });
      return { ok: true, status: 202, replay: false, value };
    }

    const capsule = this.issueCapsule(decisionBody, issuedAt, now);
    record.capsule = capsule;
    record.state_path = ["PROPOSED", "AUTHORIZED"];
    const value: AuthorizeValue = {
      decision_id: decisionBody.decision_id,
      outcome: "ALLOW",
      reason_code: evaluated.reason_code,
      capsule_id: capsule.body.capsule_id,
      proof_id: null,
    };
    withTx(this.bank.db, () => {
      saveAuthorization(
        this.bank.db,
        decisionBody.decision_id,
        mandate.body.mandate_id,
        actionBody.action_id,
        capsule.body.capsule_id,
        "AUTHORIZED",
        record,
      );
      saveIdempotency(this.bank.db, "authorizations", key, hash, 201, value);
    });
    return { ok: true, status: 201, replay: false, value };
  }

  approve(
    decisionId: string,
    idempotencyKey: string | undefined,
    approverId: string | undefined,
  ): ServiceResult<{
    decision_id: string;
    approval_id: string;
    capsule_id: string;
    state: "APPROVED";
  }> {
    const key = readIdempotencyKey(idempotencyKey);
    if (!key) return fail(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
    const requesterOrApprover = typeof approverId === "string" ? approverId.trim() : "";
    const request = { decision_id: decisionId, approver_id: requesterOrApprover };
    const hash = requestHash(request);
    const replay = replayOrConflict<{
      decision_id: string;
      approval_id: string;
      capsule_id: string;
      state: "APPROVED";
    }>(getIdempotency(this.bank.db, "approvals", key), hash);
    if (replay) return replay;

    const authorization = getAuthorization(this.bank.db, decisionId);
    if (!authorization) return fail(404, "AUTHORIZATION_NOT_FOUND", "authorization was not found");
    if (authorization.state !== "STEP_UP_REQUIRED") {
      return fail(422, "STEP_UP_NOT_PENDING", "authorization is not waiting for step-up approval");
    }
    const record = asRecord(authorization.record);
    if (isMandateRevoked(this.bank.db, record.mandate.body.mandate_id)) {
      return fail(422, "MANDATE_REVOKED", "mandate has been revoked");
    }
    if (requesterOrApprover === record.action.body.customer_id || requesterOrApprover === record.action.body.agent_id) {
      return fail(422, "SEPARATION_FAILURE", "requester and approver must be distinct");
    }
    if (!ALLOWED_APPROVERS.has(requesterOrApprover)) {
      return fail(400, "UNKNOWN_APPROVER", "only the synthetic operator may approve step-up");
    }

    const now = this.clock();
    const issuedAt = nowIso(now);
    if (!isMandateValidAtAuthorization(record.mandate.body, record.action.body, issuedAt)) {
      return this.expireAuthorization(authorization, key, hash, issuedAt);
    }

    const approvalAuthority = this.keys.authorities.approver;
    const approvalBody: StepUpApproval = {
      object_type: "StepUpApproval",
      ...this.keys.pin,
      issuer: approvalAuthority.binding.issuer,
      key_id: approvalAuthority.binding.key_id,
      issued_at: issuedAt,
      approval_id: `approval-${randomUUID()}`,
      action_hash: record.decision.body.action_hash,
      decision_hash: hashSignedObjectBody(record.decision.body),
      approved_effect_hash: record.decision.body.approved_effect_hash!,
      requester_id: record.action.body.customer_id,
      approver_id: requesterOrApprover,
      not_before: issuedAt,
      expires_at: addMinutes(now, 10),
    };
    const approval = createSignedEnvelope(approvalBody, [signatureInput(approvalAuthority)]);
    const capsule = this.issueCapsule(record.decision.body, issuedAt, now);
    const nextRecord: AuthorizationRecord = {
      ...record,
      approval,
      capsule,
      state_path: ["PROPOSED", "STEP_UP_REQUIRED", "APPROVED"],
    };
    const value = {
      decision_id: decisionId,
      approval_id: approvalBody.approval_id,
      capsule_id: capsule.body.capsule_id,
      state: "APPROVED" as const,
    };
    const moved = withTx(this.bank.db, () =>
      updateAuthorization(this.bank.db, decisionId, "STEP_UP_REQUIRED", authorization.state_version, {
        state: "APPROVED",
        capsuleId: capsule.body.capsule_id,
        record: nextRecord,
      }),
    );
    if (!moved) return fail(409, "STATE_CONFLICT", "authorization changed before approval was recorded");
    saveIdempotency(this.bank.db, "approvals", key, hash, 201, value);
    return { ok: true, status: 201, replay: false, value };
  }

  revokeMandate(
    mandateId: string,
    idempotencyKey: string | undefined,
  ): ServiceResult<{ mandate_id: string; proof_ids: string[] }> {
    const key = readIdempotencyKey(idempotencyKey);
    if (!key) return fail(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
    const hash = requestHash({ mandate_id: mandateId });
    const replay = replayOrConflict<{ mandate_id: string; proof_ids: string[] }>(
      getIdempotency(this.bank.db, "revocations", key),
      hash,
    );
    if (replay) return replay;

    const mandate = parseMandate(getMandate(this.bank.db, mandateId));
    if (!mandate) return fail(404, "MANDATE_NOT_FOUND", "mandate was not found");

    const now = this.clock();
    const revokedAt = nowIso(now);
    const open = listAuthorizationsByMandate(this.bank.db, mandateId);
    if (open.some((row) => INTENDED_STATES.has(row.state))) {
      return fail(409, "ALREADY_INTENDED", "mandate cannot be revoked after execution intent is recorded");
    }

    const proofIds = withTx(this.bank.db, () => {
      persistMandateRevocation(this.bank.db, mandateId, revokedAt);
      const ids: string[] = [];
      for (const row of open) {
        if (!OPEN_STATES.has(row.state) || getProofByDecision(this.bank.db, row.decision_id)) continue;
        const record = asRecord(row.record);
        const proof = this.closeNegative(
          record,
          "REVOKED",
          [...record.state_path, "REVOKED", "CLOSED"],
          revokedAt,
        );
        saveProof(this.bank.db, proof.body.proof_id, row.decision_id, proof);
        markAuthorizationClosed(this.bank.db, row.decision_id);
        ids.push(proof.body.proof_id);
      }
      const value = { mandate_id: mandateId, proof_ids: ids };
      saveIdempotency(this.bank.db, "revocations", key, hash, 200, value);
      return ids;
    });
    return { ok: true, status: 200, replay: false, value: { mandate_id: mandateId, proof_ids: proofIds } };
  }

  commit(
    decisionId: string,
    idempotencyKey: string | undefined,
  ): ServiceResult<{ proof_id: string; proof: AnyStoredProof } | { decision_id: string; state: "EXECUTION_UNKNOWN"; job_id: string }> {
    const key = readIdempotencyKey(idempotencyKey);
    if (!key) return fail(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
    const request = { decision_id: decisionId };
    const hash = requestHash(request);
    const replay = replayOrConflict<{ proof_id: string; proof: AnyStoredProof }>(
      getIdempotency(this.bank.db, "commits", key),
      hash,
    );
    if (replay) return replay;

    const existingProof = getProofByDecision(this.bank.db, decisionId);
    if (existingProof) {
      const proof = existingProof as AnyStoredProof;
      const value = { proof_id: proof.body.proof_id, proof };
      saveIdempotency(this.bank.db, "commits", key, hash, 200, value);
      return { ok: true, status: 200, replay: false, value };
    }

    const authorization = getAuthorization(this.bank.db, decisionId);
    if (!authorization) return fail(404, "AUTHORIZATION_NOT_FOUND", "authorization was not found");
    if (INTENDED_STATES.has(authorization.state)) {
      return this.reconcile(decisionId, key);
    }
    const record = asRecord(authorization.record);
    if (authorization.state !== "AUTHORIZED" && authorization.state !== "APPROVED") {
      return fail(422, "DECISION_NOT_ALLOWED", "only ALLOW or approved step-up decisions can be committed");
    }
    if (!record.capsule || !record.decision.body.approved_effect_hash) {
      return fail(422, "DECISION_NOT_ALLOWED", "authorization is missing an executable capsule");
    }
    if (isMandateRevoked(this.bank.db, record.mandate.body.mandate_id)) {
      return fail(422, "MANDATE_REVOKED", "mandate has been revoked");
    }

    const observed = this.observedNow();
    if (!observed.ok) return observed;
    const now = observed.value;
    const executedAt = nowIso(now);
    if (
      Date.parse(executedAt) >= Date.parse(record.capsule.body.expires_at) ||
      !isMandateValidAtAuthorization(record.mandate.body, record.action.body, executedAt)
    ) {
      const proof = this.closeNegative(
        record,
        "EXPIRED",
        [...record.state_path, "EXPIRED", "CLOSED"],
        executedAt,
      );
      const value = { proof_id: proof.body.proof_id, proof };
      withTx(this.bank.db, () => {
        saveProof(this.bank.db, proof.body.proof_id, decisionId, proof);
        markAuthorizationClosed(this.bank.db, decisionId);
        saveIdempotency(this.bank.db, "commits", key, hash, 422, value);
      });
      return { ok: true, status: 422, replay: false, value };
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
    const jobId = `job-${randomUUID()}`;
    const idempotencyKeyForLedger = `closure:${record.capsule.body.capsule_id}`;
    try {
      withTx(this.bank.db, () => {
        if (!consumeCapsule(this.bank.db, record.capsule!.body.capsule_id, executedAt)) {
          throw new Error("CAPSULE_REUSED");
        }
        const intended: AuthorizationRecord = {
          ...record,
          state_path: [...record.state_path, "EXECUTION_INTENT_RECORDED"],
        };
        if (
          !updateAuthorization(this.bank.db, decisionId, authorization.state, authorization.state_version, {
            state: "EXECUTION_INTENT_RECORDED",
            capsuleId: record.capsule!.body.capsule_id,
            record: intended,
          })
        ) {
          throw new Error("STATE_CONFLICT");
        }
        enqueueReconciliationJob(this.bank.db, {
          job_id: jobId,
          decision_id: decisionId,
          now_ms: now.getTime(),
          max_attempts: MAX_ATTEMPTS,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "intent record failed";
      if (message === "CAPSULE_REUSED") {
        return fail(409, "CAPSULE_REUSED", "execution capsule was already consumed");
      }
      return fail(409, "STATE_CONFLICT", "authorization changed before execution intent was recorded");
    }

    try {
      const posted = this.executor.execute(this.bank, {
        customer_id: record.action.body.customer_id,
        from_account_id: record.action.body.transfer.from_account_id,
        to_account_id: record.action.body.transfer.to_account_id,
        amount,
        idempotency_key: idempotencyKeyForLedger,
      });
      return this.finishPostedCommit(decisionId, record, posted, executedAt, key, hash);
    } catch (error) {
      if (error instanceof ExecutionTimeoutError) {
        const latest = getAuthorization(this.bank.db, decisionId);
        if (latest) {
          updateAuthorization(this.bank.db, decisionId, latest.state, latest.state_version, {
            state: "EXECUTION_UNKNOWN",
            capsuleId: record.capsule.body.capsule_id,
            record: { ...asRecord(latest.record), state_path: [...asRecord(latest.record).state_path, "EXECUTION_UNKNOWN"] },
          });
        }
        return {
          ok: true,
          status: 202,
          replay: false,
          value: { decision_id: decisionId, state: "EXECUTION_UNKNOWN", job_id: jobId },
        };
      }
      const message = error instanceof Error ? error.message : "synthetic commit failed";
      const proof = this.closeNegative(
        record,
        "EXECUTION_FAILED",
        [...record.state_path, "EXECUTION_INTENT_RECORDED", "EXECUTION_FAILED", "CLOSED"],
        executedAt,
      );
      const value = { proof_id: proof.body.proof_id, proof };
      withTx(this.bank.db, () => {
        if (!getProofByDecision(this.bank.db, decisionId)) {
          saveProof(this.bank.db, proof.body.proof_id, decisionId, proof);
          markAuthorizationClosed(this.bank.db, decisionId);
          const job = getJobByDecision(this.bank.db, decisionId);
          if (job) completeJob(this.bank.db, job.job_id);
        }
        saveIdempotency(this.bank.db, "commits", key, hash, 422, value);
      });
      return { ok: true, status: 422, replay: false, value };
    }
  }

  reconcile(
    decisionId: string,
    idempotencyKey?: string | undefined,
  ): ServiceResult<{ proof_id: string; proof: AnyStoredProof } | { decision_id: string; state: "EXECUTION_UNKNOWN"; job_id: string }> {
    const observed = this.observedNow();
    if (!observed.ok) return observed;
    const now = observed.value;
    const existingProof = getProofByDecision(this.bank.db, decisionId);
    if (existingProof) {
      const proof = existingProof as AnyStoredProof;
      return { ok: true, status: 200, replay: false, value: { proof_id: proof.body.proof_id, proof } };
    }
    const authorization = getAuthorization(this.bank.db, decisionId);
    if (!authorization) return fail(404, "AUTHORIZATION_NOT_FOUND", "authorization was not found");
    if (!INTENDED_STATES.has(authorization.state)) {
      return fail(422, "NOT_RECONCILABLE", "authorization is not waiting for execution lookup");
    }
    const record = asRecord(authorization.record);
    if (!record.capsule) return fail(422, "DECISION_NOT_ALLOWED", "authorization is missing an executable capsule");
    const job = getJobByDecision(this.bank.db, decisionId);
    const posted = this.executor.lookup(this.bank, `closure:${record.capsule.body.capsule_id}`);
    if (posted) {
      const result = this.finishPostedCommit(decisionId, record, posted, nowIso(now));
      if (job) completeJob(this.bank.db, job.job_id);
      return result;
    }
    if (job) {
      const next = backoffJob(this.bank.db, job.job_id, now.getTime(), "EXECUTION_UNKNOWN");
      if (next?.state === "unresolved") {
        return {
          ok: true,
          status: 202,
          replay: false,
          value: { decision_id: decisionId, state: "EXECUTION_UNKNOWN", job_id: job.job_id },
        };
      }
    }
    return {
      ok: true,
      status: 202,
      replay: false,
      value: { decision_id: decisionId, state: "EXECUTION_UNKNOWN", job_id: job?.job_id ?? `job-${decisionId}` },
    };
  }

  authorizationStatus(decisionId: string): ServiceResult<{
    decision_id: string;
    state: string;
    proof_id: string | null;
    job: ReturnType<typeof getJobByDecision>;
  }> {
    const authorization = getAuthorization(this.bank.db, decisionId);
    if (!authorization) return fail(404, "AUTHORIZATION_NOT_FOUND", "authorization was not found");
    const proof = getProofByDecision(this.bank.db, decisionId) as AnyStoredProof | undefined;
    return {
      ok: true,
      status: 200,
      replay: false,
      value: {
        decision_id: decisionId,
        state: authorization.state,
        proof_id: proof?.body.proof_id ?? null,
        job: getJobByDecision(this.bank.db, decisionId),
      },
    };
  }

  unresolvedQueue(): ServiceResult<{ jobs: ReturnType<typeof listUnresolvedJobs> }> {
    return { ok: true, status: 200, replay: false, value: { jobs: listUnresolvedJobs(this.bank.db) } };
  }

  runReconciliationWorker(limit = 4): { claimed: number; closed: number; unknown: number } {
    const observed = this.observedNow();
    if (!observed.ok) return { claimed: 0, closed: 0, unknown: 0 };
    const claimed = claimDueJobs(this.bank.db, WORKER_ID, observed.value.getTime(), LEASE_MS, limit);
    let closed = 0;
    let unknown = 0;
    for (const job of claimed) {
      const result = this.reconcile(job.decision_id);
      if (result.ok && result.status === 201) closed += 1;
      else if (result.ok && result.status === 202) unknown += 1;
      else if (result.ok && "proof_id" in result.value) closed += 1;
      else unknown += 1;
    }
    return { claimed: claimed.length, closed, unknown };
  }

  private finishPostedCommit(
    decisionId: string,
    record: AuthorizationRecord,
    posted: ExecutedTransfer,
    executedAt: string,
    idempotencyKey?: string,
    requestHashValue?: string,
  ): ServiceResult<{ proof_id: string; proof: AnyStoredProof }> {
    const closed = this.closeSuccess(record, posted.ledger_sequence, executedAt);
    const value = { proof_id: closed.body.proof_id, proof: closed };
    withTx(this.bank.db, () => {
      if (!getProofByDecision(this.bank.db, decisionId)) {
        saveProof(this.bank.db, closed.body.proof_id, decisionId, closed);
        markAuthorizationClosed(this.bank.db, decisionId);
        const job = getJobByDecision(this.bank.db, decisionId);
        if (job) completeJob(this.bank.db, job.job_id);
      }
      if (idempotencyKey && requestHashValue) {
        saveIdempotency(this.bank.db, "commits", idempotencyKey, requestHashValue, 201, value);
      }
    });
    return { ok: true, status: 201, replay: false, value };
  }

  loadProof(proofId: string): ServiceResult<{ proof_id: string; proof: AnyStoredProof }> {
    const stored = getProof(this.bank.db, proofId);
    if (!stored) return fail(404, "PROOF_NOT_FOUND", "proof was not found");
    const proof = stored as AnyStoredProof;
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

  private expireAuthorization(
    authorization: NonNullable<ReturnType<typeof getAuthorization>>,
    key: string,
    hash: string,
    closedAt: string,
  ): ServiceResult<never> {
    const record = asRecord(authorization.record);
    const proof = this.closeNegative(record, "EXPIRED", [...record.state_path, "EXPIRED", "CLOSED"], closedAt);
    withTx(this.bank.db, () => {
      saveProof(this.bank.db, proof.body.proof_id, authorization.decision_id, proof);
      markAuthorizationClosed(this.bank.db, authorization.decision_id);
      saveIdempotency(this.bank.db, "approvals", key, hash, 422, {
        decision_id: authorization.decision_id,
        outcome: record.decision.body.outcome,
        reason_code: "MANDATE_EXPIRED",
        capsule_id: null,
        proof_id: proof.body.proof_id,
      });
    });
    return fail(422, "MANDATE_EXPIRED", "mandate is not valid at approval time");
  }

  private issueCapsule(
    decision: AuthorizationDecision,
    issuedAt: string,
    now: Date,
  ): SignedEnvelope<ExecutionCapsule> {
    const capsuleAuthority = this.keys.authorities.capsule_authority;
    const capsuleBody: ExecutionCapsule = {
      object_type: "ExecutionCapsule",
      ...this.keys.pin,
      issuer: capsuleAuthority.binding.issuer,
      key_id: capsuleAuthority.binding.key_id,
      issued_at: issuedAt,
      capsule_id: `capsule-${randomUUID()}`,
      action_hash: decision.action_hash,
      decision_hash: hashSignedObjectBody(decision),
      approved_effect_hash: decision.approved_effect_hash!,
      not_before: issuedAt,
      expires_at: addMinutes(now, 10),
      nonce: `nonce-${randomBytes(8).toString("hex")}`,
    };
    return createSignedEnvelope(capsuleBody, [signatureInput(capsuleAuthority)]);
  }

  private closeSuccess(record: AuthorizationRecord, ledgerSequence: string, executedAt: string): ClosureProof {
    const executor = this.keys.authorities.executor;
    const ledger = this.keys.authorities.ledger;
    const capsule = record.capsule!;
    const consumptionBody: ConsumptionRecord = {
      object_type: "ConsumptionRecord",
      ...this.keys.pin,
      issuer: executor.binding.issuer,
      key_id: executor.binding.key_id,
      issued_at: executedAt,
      consumption_id: `consumption-${randomUUID()}`,
      capsule_hash: hashSignedObjectBody(capsule.body),
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
      mutation_count: "1",
      action_id: record.action.body.action_id,
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
      step_up_approval: record.approval,
      capsule,
      consumption_records: [consumption],
      receipt,
      ledger_observation: ledgerObservation,
      state_path: record.approval ? [...SUCCESSFUL_STEP_UP_STATE_PATH] : [...SUCCESSFUL_STATE_PATH],
      closed_at: executedAt,
    };
    return createSignedEnvelope(proofBody, [signatureInput(closureAuthority)]);
  }

  private closeNegative(
    record: AuthorizationRecord,
    terminalReason: NegativeTerminalReason,
    statePath: ProtocolState[],
    closedAt: string,
  ): NegativeClosureProof {
    const mutations = countActionMutations(
      this.bank.db,
      record.action.body.action_id,
      record.capsule?.body.capsule_id ?? null,
    );
    const ledger = this.keys.authorities.ledger;
    const observationBody: LedgerObservation = {
      object_type: "LedgerObservation",
      ...this.keys.pin,
      issuer: ledger.binding.issuer,
      key_id: ledger.binding.key_id,
      issued_at: closedAt,
      observation_id: `observation-${randomUUID()}`,
      ledger_id: LEDGER_ID,
      receipt_body_hash: null,
      effect_hash: null,
      status: "ABSENT",
      mutation_count: String(mutations),
      action_id: record.action.body.action_id,
      ledger_sequence: nextLedgerSequence(this.bank.db),
      observed_at: closedAt,
    };
    const ledgerObservation = createSignedEnvelope(observationBody, [signatureInput(ledger)]);
    const closureAuthority = this.keys.authorities.closure_authority;
    const proofBody: NegativeClosureProofBody = {
      object_type: "NegativeClosureProof",
      ...this.keys.pin,
      issuer: closureAuthority.binding.issuer,
      key_id: closureAuthority.binding.key_id,
      issued_at: closedAt,
      proof_id: `proof-${randomUUID()}`,
      assurance_profile: ASSURANCE_PROFILE,
      terminal_reason: terminalReason,
      manifest: this.keys.manifest,
      mandate: record.mandate,
      action: record.action,
      effect: record.effect,
      policy: this.keys.policy,
      interpreter: this.keys.interpreter,
      decision_input: record.decision_input,
      decision: record.decision,
      step_up_approval: record.approval,
      ledger_observation: ledgerObservation,
      state_path: statePath,
      closed_at: closedAt,
    };
    return createSignedEnvelope(proofBody, [signatureInput(closureAuthority)]);
  }
}
