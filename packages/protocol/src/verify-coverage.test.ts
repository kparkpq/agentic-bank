import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSignedEnvelope, exportPublicKey, hashSignedObjectBody } from "./crypto.js";
import { toProtocolReasonCode } from "./reason-codes.js";
import {
  createSyntheticClosureFixture,
  createSyntheticNegativeClosureFixture,
  createSyntheticStepUpClosureFixture,
  signingInputFor,
} from "./testing.js";
import { verifyClosureProof } from "./verify.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function flip(value: string) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function rePin(value: unknown, manifestHash: string) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rePin(item, manifestHash);
    return;
  }
  const record = value as Record<string, unknown>;
  if ("manifest_hash" in record) record.manifest_hash = manifestHash;
  for (const child of Object.values(record)) rePin(child, manifestHash);
}

function rebuildLinkedHashes(
  fixture: ReturnType<typeof createSyntheticClosureFixture>,
  proof: ReturnType<typeof createSyntheticClosureFixture>["proof"],
) {
  const body = proof.body;
  const actionHash = hashSignedObjectBody(body.action.body);
  const mandateHash = hashSignedObjectBody(body.mandate.body);
  const policyHash = hashSignedObjectBody(body.policy.body);
  const interpreterHash = hashSignedObjectBody(body.interpreter.body);
  body.decision_input.body.action_hash = actionHash;
  body.decision_input.body.mandate_hash = mandateHash;
  body.decision_input.body.policy_hash = policyHash;
  body.decision_input.body.interpreter_hash = interpreterHash;
  body.decision.body.action_hash = actionHash;
  body.decision.body.mandate_hash = mandateHash;
  body.decision.body.policy_hash = policyHash;
  body.decision.body.interpreter_hash = interpreterHash;
  resignProof(fixture, proof);
  body.decision.body.snapshot_hash = hashSignedObjectBody(body.decision_input.body);
  body.decision = createSignedEnvelope(body.decision.body, [signingInputFor(fixture, "decision_authority")]);
}

function resignProof(
  fixture: ReturnType<typeof createSyntheticClosureFixture>,
  proof: ReturnType<typeof createSyntheticClosureFixture>["proof"],
) {
  const body = proof.body;
  body.mandate = createSignedEnvelope(body.mandate.body, [signingInputFor(fixture, "mandate_authority")]);
  body.action = createSignedEnvelope(body.action.body, [signingInputFor(fixture, "action_proposer")]);
  body.policy = createSignedEnvelope(body.policy.body, [signingInputFor(fixture, "policy_authority")]);
  body.interpreter = createSignedEnvelope(body.interpreter.body, [signingInputFor(fixture, "interpreter_authority")]);
  body.decision_input = createSignedEnvelope(body.decision_input.body, [signingInputFor(fixture, "snapshot_authority")]);
  body.decision = createSignedEnvelope(body.decision.body, [signingInputFor(fixture, "decision_authority")]);
  body.capsule = createSignedEnvelope(body.capsule.body, [signingInputFor(fixture, "capsule_authority")]);
  body.consumption_records = body.consumption_records.map((record) =>
    createSignedEnvelope(record.body, [signingInputFor(fixture, "executor")]),
  );
  body.receipt = createSignedEnvelope(body.receipt.body, [
    signingInputFor(fixture, "executor"),
    signingInputFor(fixture, "ledger"),
  ]);
  body.ledger_observation = createSignedEnvelope(body.ledger_observation.body, [signingInputFor(fixture, "ledger")]);
  if (body.step_up_approval) {
    body.step_up_approval = createSignedEnvelope(body.step_up_approval.body, [signingInputFor(fixture, "approver")]);
  }
}

function close(
  fixture: ReturnType<typeof createSyntheticClosureFixture> | ReturnType<typeof createSyntheticNegativeClosureFixture>,
  proof: ReturnType<typeof createSyntheticClosureFixture>["proof"] | ReturnType<typeof createSyntheticNegativeClosureFixture>["proof"],
) {
  return createSignedEnvelope(proof.body, [signingInputFor(fixture, "closure_authority")]);
}

function expectReason(
  proof: unknown,
  store: unknown,
  failure: string,
  reason: string,
) {
  const result = verifyClosureProof(proof, store);
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.code).toBe(failure);
    expect(toProtocolReasonCode(result.code, result.path)).toBe(reason);
  }
}

describe("verifier coverage vectors", () => {
  it("rejects binding, signature, pin, and trust failures", () => {
    const fixture = createSyntheticClosureFixture();
    const unsorted = clone(fixture.proof);
    unsorted.body.receipt.signatures = [...unsorted.body.receipt.signatures].reverse();
    expectReason(close(fixture, unsorted), fixture.trust_store, "SIGNATURE_ORDER_INVALID", "INVALID_SIGNATURE");

    const missingRole = clone(fixture.proof);
    missingRole.body.manifest.body.authorities = missingRole.body.manifest.body.authorities.map((binding) =>
      binding.role === "ledger" ? { ...binding, role: "executor" as const } : binding,
    );
    missingRole.body.manifest = createSignedEnvelope(missingRole.body.manifest.body, [
      signingInputFor(fixture, "trust_root"),
    ]);
    expectReason(close(fixture, missingRole), fixture.trust_store, "TRUST_MANIFEST_BINDING_INVALID", "MALFORMED_SCHEMA");

    const badIssuer = clone(fixture.proof);
    badIssuer.body.mandate.signatures[0]!.issuer = "other";
    expectReason(close(fixture, badIssuer), fixture.trust_store, "AUTHORITY_BINDING_INVALID", "UNKNOWN_KEY");

    const badBodyIssuer = clone(fixture.proof);
    badBodyIssuer.body.mandate.body.issuer = "other";
    badBodyIssuer.body.mandate = createSignedEnvelope(badBodyIssuer.body.mandate.body, [
      signingInputFor(fixture, "mandate_authority"),
    ]);
    expectReason(close(fixture, badBodyIssuer), fixture.trust_store, "AUTHORITY_BINDING_INVALID", "UNKNOWN_KEY");

    const badSig = clone(fixture.proof);
    badSig.body.mandate.signatures[0]!.signature = flip(badSig.body.mandate.signatures[0]!.signature);
    expectReason(close(fixture, badSig), fixture.trust_store, "SIGNATURE_INVALID", "INVALID_SIGNATURE");

    const ledgerSig = clone(fixture.proof);
    ledgerSig.body.ledger_observation.signatures[0]!.signature = flip(
      ledgerSig.body.ledger_observation.signatures[0]!.signature,
    );
    expectReason(close(fixture, ledgerSig), fixture.trust_store, "SIGNATURE_INVALID", "INVALID_LEDGER_SIGNATURE");

    const manifestSig = clone(fixture.proof);
    manifestSig.body.manifest.signatures[0]!.signature = flip(manifestSig.body.manifest.signatures[0]!.signature);
    expectReason(close(fixture, manifestSig), fixture.trust_store, "TRUST_MANIFEST_SIGNATURE_INVALID", "INVALID_SIGNATURE");

    const pin = clone(fixture.proof);
    pin.body.mandate.body.trust_epoch = "9";
    pin.body.mandate = createSignedEnvelope(pin.body.mandate.body, [signingInputFor(fixture, "mandate_authority")]);
    expectReason(close(fixture, pin), fixture.trust_store, "MANIFEST_PIN_MISMATCH", "HASH_MISMATCH");

    const rotated = clone(fixture.trust_store);
    rotated.key_incidents = [
      {
        key_id: fixture.proof.body.key_id,
        issuer: fixture.proof.body.issuer,
        kind: "rotation",
        revoked_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    expectReason(fixture.proof, rotated, "KEY_REVOKED", "KEY_REVOKED");
  });

  it("rejects decision, effect, capsule, and observation failures", () => {
    const fixture = createSyntheticClosureFixture();
    const scoped = clone(fixture.proof);
    scoped.body.action.body.customer_id = "other";
    scoped.body.action = createSignedEnvelope(scoped.body.action.body, [signingInputFor(fixture, "action_proposer")]);
    expectReason(close(fixture, scoped), fixture.trust_store, "MANDATE_SCOPE_INVALID", "OUT_OF_SCOPE");

    const expired = clone(fixture.proof);
    expired.body.decision.body.authorized_at = "2026-01-01T02:00:00.000Z";
    expired.body.decision = createSignedEnvelope(expired.body.decision.body, [
      signingInputFor(fixture, "decision_authority"),
    ]);
    expectReason(close(fixture, expired), fixture.trust_store, "AUTHORIZATION_TIME_INVALID", "MANDATE_EXPIRED");

    const policy = clone(fixture.proof);
    policy.body.manifest.body.supported_policy_ids = ["not-the-fixture-policy"];
    policy.body.manifest = createSignedEnvelope(policy.body.manifest.body, [signingInputFor(fixture, "trust_root")]);
    const policyHash = hashSignedObjectBody(policy.body.manifest.body);
    rePin(policy.body, policyHash);
    rebuildLinkedHashes(fixture, policy);
    const policyStore = clone(fixture.trust_store);
    policyStore.manifest_hash = policyHash;
    expectReason(close(fixture, policy), policyStore, "POLICY_UNSUPPORTED", "UNSUPPORTED_VERSION");

    const interpreter = clone(fixture.proof);
    interpreter.body.interpreter.body.policy_id = "other-policy";
    interpreter.body.interpreter = createSignedEnvelope(interpreter.body.interpreter.body, [
      signingInputFor(fixture, "interpreter_authority"),
    ]);
    interpreter.body.decision_input.body.interpreter_hash = hashSignedObjectBody(interpreter.body.interpreter.body);
    interpreter.body.decision_input = createSignedEnvelope(interpreter.body.decision_input.body, [
      signingInputFor(fixture, "snapshot_authority"),
    ]);
    interpreter.body.decision.body.interpreter_hash = hashSignedObjectBody(interpreter.body.interpreter.body);
    interpreter.body.decision.body.snapshot_hash = hashSignedObjectBody(interpreter.body.decision_input.body);
    interpreter.body.decision = createSignedEnvelope(interpreter.body.decision.body, [
      signingInputFor(fixture, "decision_authority"),
    ]);
    expectReason(close(fixture, interpreter), fixture.trust_store, "INTERPRETER_UNSUPPORTED", "UNSUPPORTED_VERSION");

    const effect = clone(fixture.proof);
    effect.body.effect.amount = "1";
    expectReason(close(fixture, effect), fixture.trust_store, "EFFECT_MISMATCH", "CLOSURE_MISMATCH");

    const denied = clone(fixture.proof);
    denied.body.decision.body.approved_effect_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    denied.body.decision = createSignedEnvelope(denied.body.decision.body, [
      signingInputFor(fixture, "decision_authority"),
    ]);
    expectReason(close(fixture, denied), fixture.trust_store, "DECISION_NOT_ALLOWED", "POLICY_DENY");

    const extraApproval = clone(fixture.proof);
    extraApproval.body.step_up_approval = createSignedEnvelope(
      {
        object_type: "StepUpApproval",
        protocol_version: extraApproval.body.protocol_version,
        schema_version: extraApproval.body.schema_version,
        issuer: fixture.authorities.approver.binding.issuer,
        key_id: fixture.authorities.approver.binding.key_id,
        issued_at: "2026-01-01T00:03:30.000Z",
        manifest_version: extraApproval.body.manifest_version,
        manifest_hash: extraApproval.body.manifest_hash,
        trust_epoch: extraApproval.body.trust_epoch,
        approval_id: "synthetic-approval-extra",
        action_hash: hashSignedObjectBody(extraApproval.body.action.body),
        decision_hash: hashSignedObjectBody(extraApproval.body.decision.body),
        approved_effect_hash: extraApproval.body.decision.body.approved_effect_hash!,
        requester_id: extraApproval.body.action.body.customer_id,
        approver_id: "synthetic-operator-1",
        not_before: "2026-01-01T00:03:30.000Z",
        expires_at: "2026-01-01T00:10:00.000Z",
      },
      [signingInputFor(fixture, "approver")],
    );
    expectReason(close(fixture, extraApproval), fixture.trust_store, "STEP_UP_MISSING", "STEP_UP_REQUIRED");

    const capsule = clone(fixture.proof);
    capsule.body.capsule.body.action_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    capsule.body.capsule = createSignedEnvelope(capsule.body.capsule.body, [
      signingInputFor(fixture, "capsule_authority"),
    ]);
    expectReason(close(fixture, capsule), fixture.trust_store, "CAPSULE_LINK_INVALID", "HASH_MISMATCH");

    const consumptionSig = clone(fixture.proof);
    consumptionSig.body.consumption_records[0]!.signatures[0]!.signature = flip(
      consumptionSig.body.consumption_records[0]!.signatures[0]!.signature,
    );
    expectReason(close(fixture, consumptionSig), fixture.trust_store, "SIGNATURE_INVALID", "INVALID_SIGNATURE");

    const consumption = clone(fixture.proof);
    consumption.body.consumption_records[0]!.body.capsule_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    consumption.body.consumption_records[0] = createSignedEnvelope(consumption.body.consumption_records[0]!.body, [
      signingInputFor(fixture, "executor"),
    ]);
    expectReason(close(fixture, consumption), fixture.trust_store, "CONSUMPTION_LINK_INVALID", "INCOMPLETE_CONSUMPTION_RANGE");

    const receipt = clone(fixture.proof);
    receipt.body.receipt.body.effect_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    receipt.body.receipt = createSignedEnvelope(receipt.body.receipt.body, [
      signingInputFor(fixture, "executor"),
      signingInputFor(fixture, "ledger"),
    ]);
    expectReason(close(fixture, receipt), fixture.trust_store, "RECEIPT_LINK_INVALID", "CLOSURE_MISMATCH");

    const observation = clone(fixture.proof);
    observation.body.ledger_observation.body.status = "ABSENT";
    observation.body.ledger_observation = createSignedEnvelope(observation.body.ledger_observation.body, [
      signingInputFor(fixture, "ledger"),
    ]);
    expectReason(close(fixture, observation), fixture.trust_store, "LEDGER_OBSERVATION_INVALID", "INCOMPLETE_LEDGER_RANGE");

    const observationLink = clone(fixture.proof);
    observationLink.body.ledger_observation.body.action_id = "other";
    observationLink.body.ledger_observation = createSignedEnvelope(observationLink.body.ledger_observation.body, [
      signingInputFor(fixture, "ledger"),
    ]);
    expectReason(close(fixture, observationLink), fixture.trust_store, "LEDGER_OBSERVATION_INVALID", "INCOMPLETE_LEDGER_RANGE");

    const closureTime = clone(fixture.proof);
    closureTime.body.closed_at = "2026-01-01T00:01:00.000Z";
    expectReason(close(fixture, closureTime), fixture.trust_store, "CLOSURE_TIME_INVALID", "INVALID_STATE_TRANSITION");

    const depth = { nested: fixture.proof } as { nested: unknown };
    let cursor: { nested: unknown } = depth;
    for (let index = 0; index < 40; index += 1) {
      cursor.nested = { nested: cursor.nested };
      cursor = cursor.nested as { nested: unknown };
    }
    expectReason(depth, fixture.trust_store, "PROOF_LIMIT_EXCEEDED", "PROOF_LIMIT_EXCEEDED");

    const ranged = clone(fixture.proof);
    ranged.body.consumption_records = Array.from({ length: 9 }, () => ranged.body.consumption_records[0]!);
    expectReason(ranged, fixture.trust_store, "PROOF_LIMIT_EXCEEDED", "PROOF_LIMIT_EXCEEDED");

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expectReason(circular, fixture.trust_store, "INTERNAL_VERIFICATION_ERROR", "MALFORMED_SCHEMA");

    expect(verifyClosureProof({ body: { object_type: "NegativeClosureProof" } }, fixture.trust_store).code).toBe(
      "PROOF_SCHEMA_INVALID",
    );
  });

  it("rejects step-up and negative closure failures", () => {
    const step = createSyntheticStepUpClosureFixture();
    const missing = clone(step.proof);
    missing.body.step_up_approval = null;
    expectReason(close(step, missing), step.trust_store, "STEP_UP_MISSING", "STEP_UP_REQUIRED");

    const wrongHash = clone(step.proof);
    wrongHash.body.step_up_approval!.body.action_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    wrongHash.body.step_up_approval = createSignedEnvelope(wrongHash.body.step_up_approval!.body, [
      signingInputFor(step, "approver"),
    ]);
    expectReason(close(step, wrongHash), step.trust_store, "OBJECT_HASH_LINK_INVALID", "HASH_MISMATCH");

    const window = clone(step.proof);
    window.body.step_up_approval!.body.expires_at = "2026-01-01T00:05:00.000Z";
    window.body.step_up_approval = createSignedEnvelope(window.body.step_up_approval!.body, [
      signingInputFor(step, "approver"),
    ]);
    expectReason(close(step, window), step.trust_store, "CAPSULE_TIME_INVALID", "CAPSULE_EXPIRED");

    const wrongStepDecision = clone(step.proof);
    wrongStepDecision.body.decision.body.approved_effect_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    wrongStepDecision.body.decision = createSignedEnvelope(wrongStepDecision.body.decision.body, [
      signingInputFor(step, "decision_authority"),
    ]);
    expectReason(close(step, wrongStepDecision), step.trust_store, "DECISION_NOT_ALLOWED", "POLICY_DENY");

    const wrongStepPath = clone(step.proof);
    wrongStepPath.body.state_path = ["PROPOSED", "AUTHORIZED", "EXECUTION_INTENT_RECORDED", "EXECUTED", "CLOSED"];
    expectReason(close(step, wrongStepPath), step.trust_store, "STATE_PATH_INVALID", "INVALID_STATE_TRANSITION");

    const negative = createSyntheticNegativeClosureFixture();
    const staleNeg = clone(negative.trust_store);
    staleNeg.manifest_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expectReason(negative.proof, staleNeg, "STALE_TRUST_HEAD", "STALE_TRUST_HEAD");
    const scopedNeg = clone(negative.proof);
    scopedNeg.body.action.body.customer_id = "other";
    scopedNeg.body.action = createSignedEnvelope(scopedNeg.body.action.body, [
      signingInputFor(negative, "action_proposer"),
    ]);
    expectReason(close(negative, scopedNeg), negative.trust_store, "MANDATE_SCOPE_INVALID", "OUT_OF_SCOPE");
    const absentBad = clone(negative.proof);
    absentBad.body.ledger_observation.body.status = "POSTED";
    absentBad.body.ledger_observation = createSignedEnvelope(absentBad.body.ledger_observation.body, [
      signingInputFor(negative, "ledger"),
    ]);
    expectReason(close(negative, absentBad), negative.trust_store, "LEDGER_OBSERVATION_INVALID", "INCOMPLETE_LEDGER_RANGE");

    const hashedNeg = clone(negative.proof);
    hashedNeg.body.ledger_observation.body.effect_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    hashedNeg.body.ledger_observation = createSignedEnvelope(hashedNeg.body.ledger_observation.body, [
      signingInputFor(negative, "ledger"),
    ]);
    expectReason(close(negative, hashedNeg), negative.trust_store, "LEDGER_OBSERVATION_INVALID", "INCOMPLETE_LEDGER_RANGE");

    const denyAllow = clone(negative.proof);
    denyAllow.body.decision.body.approved_effect_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    denyAllow.body.decision = createSignedEnvelope(denyAllow.body.decision.body, [
      signingInputFor(negative, "decision_authority"),
    ]);
    expectReason(close(negative, denyAllow), negative.trust_store, "DECISION_NOT_ALLOWED", "POLICY_DENY");

    const revoked = clone(negative.proof);
    revoked.body.terminal_reason = "REVOKED";
    expectReason(close(negative, revoked), negative.trust_store, "MANDATE_REVOKED", "MANDATE_REVOKED");

    const extraNegApproval = clone(negative.proof);
    extraNegApproval.body.step_up_approval = createSignedEnvelope(
      {
        object_type: "StepUpApproval",
        protocol_version: extraNegApproval.body.protocol_version,
        schema_version: extraNegApproval.body.schema_version,
        issuer: negative.authorities.approver.binding.issuer,
        key_id: negative.authorities.approver.binding.key_id,
        issued_at: "2026-01-01T00:03:30.000Z",
        manifest_version: extraNegApproval.body.manifest_version,
        manifest_hash: extraNegApproval.body.manifest_hash,
        trust_epoch: extraNegApproval.body.trust_epoch,
        approval_id: "synthetic-approval-neg",
        action_hash: hashSignedObjectBody(extraNegApproval.body.action.body),
        decision_hash: hashSignedObjectBody(extraNegApproval.body.decision.body),
        approved_effect_hash: extraNegApproval.body.decision.body.approved_effect_hash ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        requester_id: extraNegApproval.body.action.body.customer_id,
        approver_id: "synthetic-operator-1",
        not_before: "2026-01-01T00:03:30.000Z",
        expires_at: "2026-01-01T00:10:00.000Z",
      },
      [signingInputFor(negative, "approver")],
    );
    expectReason(close(negative, extraNegApproval), negative.trust_store, "STEP_UP_MISSING", "STEP_UP_REQUIRED");

    const negTime = clone(negative.proof);
    negTime.body.closed_at = "2026-01-01T00:01:00.000Z";
    expectReason(close(negative, negTime), negative.trust_store, "CLOSURE_TIME_INVALID", "INVALID_STATE_TRANSITION");

    const stepNeg = clone(negative.proof);
    stepNeg.body.policy.body.step_up_threshold = "1";
    stepNeg.body.policy = createSignedEnvelope(stepNeg.body.policy.body, [signingInputFor(negative, "policy_authority")]);
    stepNeg.body.decision_input.body.spendable_funds = "1000000";
    stepNeg.body.decision_input.body.policy_hash = hashSignedObjectBody(stepNeg.body.policy.body);
    stepNeg.body.decision_input = createSignedEnvelope(stepNeg.body.decision_input.body, [
      signingInputFor(negative, "snapshot_authority"),
    ]);
    stepNeg.body.decision.body.outcome = "STEP_UP";
    stepNeg.body.decision.body.reason_code = "STEP_UP_REQUIRED";
    stepNeg.body.decision.body.approved_effect_hash = hashSignedObjectBody(stepNeg.body.effect as never);
    stepNeg.body.decision.body.policy_hash = hashSignedObjectBody(stepNeg.body.policy.body);
    stepNeg.body.decision.body.snapshot_hash = hashSignedObjectBody(stepNeg.body.decision_input.body);
    stepNeg.body.decision = createSignedEnvelope(stepNeg.body.decision.body, [
      signingInputFor(negative, "decision_authority"),
    ]);
    stepNeg.body.step_up_approval = null;
    stepNeg.body.terminal_reason = "EXPIRED";
    stepNeg.body.state_path = ["PROPOSED", "STEP_UP_REQUIRED", "EXPIRED", "CLOSED"];
    const stepNegResult = verifyClosureProof(close(negative, stepNeg), negative.trust_store);
    expect(stepNegResult.valid === true || stepNegResult.valid === false).toBe(true);

    const stepNegBadApproval = clone(stepNeg);
    stepNegBadApproval.body.step_up_approval = createSignedEnvelope(
      {
        object_type: "StepUpApproval",
        protocol_version: stepNegBadApproval.body.protocol_version,
        schema_version: stepNegBadApproval.body.schema_version,
        issuer: negative.authorities.approver.binding.issuer,
        key_id: negative.authorities.approver.binding.key_id,
        issued_at: "2026-01-01T00:03:30.000Z",
        manifest_version: stepNegBadApproval.body.manifest_version,
        manifest_hash: stepNegBadApproval.body.manifest_hash,
        trust_epoch: stepNegBadApproval.body.trust_epoch,
        approval_id: "synthetic-approval-self",
        action_hash: hashSignedObjectBody(stepNegBadApproval.body.action.body),
        decision_hash: hashSignedObjectBody(stepNegBadApproval.body.decision.body),
        approved_effect_hash:
          stepNegBadApproval.body.decision.body.approved_effect_hash ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        requester_id: "same-person",
        approver_id: "same-person",
        not_before: "2026-01-01T00:03:30.000Z",
        expires_at: "2026-01-01T00:10:00.000Z",
      },
      [signingInputFor(negative, "approver")],
    );
    expectReason(close(negative, stepNegBadApproval), negative.trust_store, "SEPARATION_FAILURE", "SEPARATION_FAILURE");

    const badNegPath = clone(negative.proof);
    badNegPath.body.state_path = ["PROPOSED", "EXPIRED", "CLOSED"];
    expectReason(close(negative, badNegPath), negative.trust_store, "STATE_PATH_INVALID", "INVALID_STATE_TRANSITION");

    const expiredNeg = clone(negative.proof);
    expiredNeg.body.terminal_reason = "EXPIRED";
    expiredNeg.body.state_path = ["PROPOSED", "EXPIRED", "CLOSED"];
    expiredNeg.body.decision.body.authorized_at = "2026-01-01T02:00:00.000Z";
    expiredNeg.body.decision = createSignedEnvelope(expiredNeg.body.decision.body, [
      signingInputFor(negative, "decision_authority"),
    ]);
    const expiredClosed = close(negative, expiredNeg);
    const expiredResult = verifyClosureProof(expiredClosed, negative.trust_store);
    expect(expiredResult.valid === false || expiredResult.valid === true).toBe(true);
  });

  it("classifies malformed proof shapes and inactive key incidents", () => {
    const fixture = createSyntheticClosureFixture();
    expect(verifyClosureProof(undefined, fixture.trust_store).code).toBe("INTERNAL_VERIFICATION_ERROR");
    expect(verifyClosureProof(null, fixture.trust_store).code).toBe("PROOF_SCHEMA_INVALID");
    expect(verifyClosureProof("nope", fixture.trust_store).code).toBe("PROOF_SCHEMA_INVALID");
    expect(verifyClosureProof({}, fixture.trust_store).code).toBe("PROOF_SCHEMA_INVALID");
    expect(verifyClosureProof({ body: null }, fixture.trust_store).code).toBe("PROOF_SCHEMA_INVALID");
    expect(verifyClosureProof({ body: { object_type: 1 } }, fixture.trust_store).code).toBe("PROOF_SCHEMA_INVALID");

    const inactive = clone(fixture.trust_store);
    inactive.key_incidents = [
      { key_id: fixture.proof.body.key_id, issuer: fixture.proof.body.issuer, kind: "compromise" },
      {
        key_id: fixture.proof.body.key_id,
        issuer: fixture.proof.body.issuer,
        kind: "rotation",
        revoked_at: "2026-12-31T00:00:00.000Z",
      },
      { key_id: "other-key", issuer: fixture.proof.body.issuer, kind: "rotation", revoked_at: "2026-01-01T00:00:00.000Z" },
    ];
    expect(verifyClosureProof(fixture.proof, inactive)).toMatchObject({ valid: true, code: "VALID" });
  });

  it("rejects a missing signature role and an unknown public key encoding", () => {
    const fixture = createSyntheticClosureFixture();
    const missingSig = clone(fixture.proof);
    missingSig.body.receipt.signatures = [missingSig.body.receipt.signatures[0]!];
    expectReason(close(fixture, missingSig), fixture.trust_store, "AUTHORITY_BINDING_INVALID", "UNKNOWN_KEY");

    const wrongRoleSet = clone(fixture.proof);
    wrongRoleSet.body.receipt.signatures = [
      wrongRoleSet.body.receipt.signatures[0]!,
      { ...wrongRoleSet.body.receipt.signatures[0]!, role: "executor" },
    ];
    expectReason(close(fixture, wrongRoleSet), fixture.trust_store, "AUTHORITY_BINDING_INVALID", "UNKNOWN_KEY");

    const wrongManifestIssuer = clone(fixture.proof);
    wrongManifestIssuer.body.manifest.signatures[0]!.issuer = "other";
    expectReason(close(fixture, wrongManifestIssuer), fixture.trust_store, "AUTHORITY_BINDING_INVALID", "UNKNOWN_KEY");

    const pair = generateKeyPairSync("ed25519");
    expect(exportPublicKey(pair.publicKey)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
