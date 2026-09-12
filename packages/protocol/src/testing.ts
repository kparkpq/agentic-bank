import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createSignedEnvelope, exportPublicKey, hashSignedObjectBody, hashTransferEffect } from "./crypto.js";
import { deriveTransferEffect } from "./evaluator.js";
import {
  ASSURANCE_PROFILE,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type AuthorityBinding,
  type AuthorityRole,
  type AuthorizationDecision,
  type ClosureProof,
  type ClosureProofBody,
  type ConsumptionRecord,
  type DecisionInputSnapshot,
  type ExecutionCapsule,
  type ExecutionReceipt,
  type InterpreterDescriptor,
  type LedgerObservation,
  type Mandate,
  type NegativeClosureProof,
  type NegativeClosureProofBody,
  type PolicyArtifact,
  type ProposedAction,
  type SignatureInput,
  type StepUpApproval,
  type TrustRootManifest,
  type TrustStore,
} from "./types.js";

export interface SyntheticAuthority {
  binding: AuthorityBinding;
  private_key: KeyObject;
}

export type SyntheticAuthorities = Record<AuthorityRole, SyntheticAuthority>;

export interface SyntheticProtocolFixture {
  proof: ClosureProof;
  trust_store: TrustStore;
  authorities: SyntheticAuthorities;
}

export interface SyntheticNegativeProtocolFixture {
  proof: NegativeClosureProof;
  trust_store: TrustStore;
  authorities: SyntheticAuthorities;
}

function createAuthority(role: AuthorityRole, issuer: string): SyntheticAuthority {
  const pair = generateKeyPairSync("ed25519");
  return {
    binding: {
      role,
      issuer,
      key_id: `${role}-key-1`,
      algorithm: "Ed25519",
      public_key: exportPublicKey(pair.publicKey),
    },
    private_key: pair.privateKey,
  };
}

function signatureInput(authority: SyntheticAuthority): SignatureInput {
  return {
    role: authority.binding.role,
    issuer: authority.binding.issuer,
    key_id: authority.binding.key_id,
    private_key: authority.private_key,
  };
}

function pin(manifestVersion: string, manifestHash: string, trustEpoch: string) {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    manifest_version: manifestVersion,
    manifest_hash: manifestHash,
    trust_epoch: trustEpoch,
  } as const;
}

export function createSyntheticClosureFixture(): SyntheticProtocolFixture {
  const authorities: SyntheticAuthorities = {
    trust_root: createAuthority("trust_root", "synthetic-root"),
    mandate_authority: createAuthority("mandate_authority", "synthetic-mandate-authority"),
    action_proposer: createAuthority("action_proposer", "synthetic-agent"),
    policy_authority: createAuthority("policy_authority", "synthetic-policy-authority"),
    interpreter_authority: createAuthority("interpreter_authority", "synthetic-interpreter-authority"),
    snapshot_authority: createAuthority("snapshot_authority", "synthetic-snapshot-authority"),
    decision_authority: createAuthority("decision_authority", "synthetic-decision-authority"),
    capsule_authority: createAuthority("capsule_authority", "synthetic-capsule-authority"),
    approver: createAuthority("approver", "synthetic-approver"),
    executor: createAuthority("executor", "synthetic-executor"),
    ledger: createAuthority("ledger", "synthetic-ledger"),
    closure_authority: createAuthority("closure_authority", "synthetic-closure-authority"),
  };

  const root = authorities.trust_root;
  const manifestBody: TrustRootManifest = {
    object_type: "TrustRootManifest",
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    issuer: root.binding.issuer,
    key_id: root.binding.key_id,
    issued_at: "2026-01-01T00:00:00.000Z",
    manifest_version: "1",
    trust_epoch: "1",
    assurance_profile: ASSURANCE_PROFILE,
    authorities: Object.values(authorities).map((authority) => authority.binding),
    supported_policy_ids: ["synthetic-krw-policy-1"],
    supported_interpreter_ids: ["krw-transfer-v0"],
  };
  const manifest = createSignedEnvelope(manifestBody, [signatureInput(root)]);
  const manifestHash = hashSignedObjectBody(manifestBody);
  const pinned = pin("1", manifestHash, "1");

  const mandateAuthority = authorities.mandate_authority;
  const mandateBody: Mandate = {
    object_type: "Mandate",
    ...pinned,
    issuer: mandateAuthority.binding.issuer,
    key_id: mandateAuthority.binding.key_id,
    issued_at: "2026-01-01T00:00:00.000Z",
    mandate_id: "synthetic-mandate-1",
    customer_id: "synthetic-customer-1",
    agent_id: "synthetic-agent-1",
    from_account_id: "synthetic-account-checking",
    to_account_id: "synthetic-account-savings",
    currency: "KRW",
    max_amount: "500000",
    not_before: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T01:00:00.000Z",
  };
  const mandate = createSignedEnvelope(mandateBody, [signatureInput(mandateAuthority)]);

  const actionAuthority = authorities.action_proposer;
  const actionBody: ProposedAction = {
    object_type: "ProposedAction",
    ...pinned,
    issuer: actionAuthority.binding.issuer,
    key_id: actionAuthority.binding.key_id,
    issued_at: "2026-01-01T00:01:00.000Z",
    action_id: "synthetic-action-1",
    mandate_id: mandateBody.mandate_id,
    customer_id: mandateBody.customer_id,
    agent_id: mandateBody.agent_id,
    transfer: {
      from_account_id: mandateBody.from_account_id,
      to_account_id: mandateBody.to_account_id,
      currency: "KRW",
      amount: "100000",
    },
  };
  const action = createSignedEnvelope(actionBody, [signatureInput(actionAuthority)]);
  const effect = deriveTransferEffect(actionBody);

  const policyAuthority = authorities.policy_authority;
  const policyBody: PolicyArtifact = {
    object_type: "PolicyArtifact",
    ...pinned,
    issuer: policyAuthority.binding.issuer,
    key_id: policyAuthority.binding.key_id,
    issued_at: "2026-01-01T00:00:00.000Z",
    policy_id: "synthetic-krw-policy-1",
    policy_type: "krw-transfer-v0",
    daily_cap: "1000000",
    step_up_threshold: "500000",
  };
  const policy = createSignedEnvelope(policyBody, [signatureInput(policyAuthority)]);

  const interpreterAuthority = authorities.interpreter_authority;
  const interpreterBody: InterpreterDescriptor = {
    object_type: "InterpreterDescriptor",
    ...pinned,
    issuer: interpreterAuthority.binding.issuer,
    key_id: interpreterAuthority.binding.key_id,
    issued_at: "2026-01-01T00:00:00.000Z",
    interpreter_id: "krw-transfer-v0",
    interpreter_version: "1",
    policy_id: policyBody.policy_id,
    policy_type: "krw-transfer-v0",
    supported_protocol_version: PROTOCOL_VERSION,
    supported_schema_version: SCHEMA_VERSION,
  };
  const interpreter = createSignedEnvelope(interpreterBody, [signatureInput(interpreterAuthority)]);

  const actionHash = hashSignedObjectBody(actionBody);
  const mandateHash = hashSignedObjectBody(mandateBody);
  const policyHash = hashSignedObjectBody(policyBody);
  const interpreterHash = hashSignedObjectBody(interpreterBody);

  const snapshotAuthority = authorities.snapshot_authority;
  const snapshotBody: DecisionInputSnapshot = {
    object_type: "DecisionInputSnapshot",
    ...pinned,
    issuer: snapshotAuthority.binding.issuer,
    key_id: snapshotAuthority.binding.key_id,
    issued_at: "2026-01-01T00:02:00.000Z",
    snapshot_id: "synthetic-snapshot-1",
    action_hash: actionHash,
    mandate_hash: mandateHash,
    policy_hash: policyHash,
    interpreter_hash: interpreterHash,
    from_account_status: "OPEN",
    to_account_status: "OPEN",
    from_owner_customer_id: mandateBody.customer_id,
    to_owner_customer_id: mandateBody.customer_id,
    spendable_funds: "1000000",
    daily_spent: "100000",
  };
  const decisionInput = createSignedEnvelope(snapshotBody, [signatureInput(snapshotAuthority)]);

  const decisionAuthority = authorities.decision_authority;
  const decisionBody: AuthorizationDecision = {
    object_type: "AuthorizationDecision",
    ...pinned,
    issuer: decisionAuthority.binding.issuer,
    key_id: decisionAuthority.binding.key_id,
    issued_at: "2026-01-01T00:03:00.000Z",
    decision_id: "synthetic-decision-1",
    action_hash: actionHash,
    mandate_hash: mandateHash,
    policy_hash: policyHash,
    interpreter_hash: interpreterHash,
    snapshot_hash: hashSignedObjectBody(snapshotBody),
    outcome: "ALLOW",
    reason_code: "POLICY_ALLOW",
    approved_effect_hash: hashTransferEffect(effect),
    authorized_at: "2026-01-01T00:03:00.000Z",
  };
  const decision = createSignedEnvelope(decisionBody, [signatureInput(decisionAuthority)]);

  const capsuleAuthority = authorities.capsule_authority;
  const capsuleBody: ExecutionCapsule = {
    object_type: "ExecutionCapsule",
    ...pinned,
    issuer: capsuleAuthority.binding.issuer,
    key_id: capsuleAuthority.binding.key_id,
    issued_at: "2026-01-01T00:04:00.000Z",
    capsule_id: "synthetic-capsule-1",
    action_hash: actionHash,
    decision_hash: hashSignedObjectBody(decisionBody),
    approved_effect_hash: hashTransferEffect(effect),
    not_before: "2026-01-01T00:04:00.000Z",
    expires_at: "2026-01-01T00:10:00.000Z",
    nonce: "synthetic_nonce_1",
  };
  const capsule = createSignedEnvelope(capsuleBody, [signatureInput(capsuleAuthority)]);

  const executor = authorities.executor;
  const consumptionBody: ConsumptionRecord = {
    object_type: "ConsumptionRecord",
    ...pinned,
    issuer: executor.binding.issuer,
    key_id: executor.binding.key_id,
    issued_at: "2026-01-01T00:05:00.000Z",
    consumption_id: "synthetic-consumption-1",
    capsule_hash: hashSignedObjectBody(capsuleBody),
    action_hash: actionHash,
    decision_hash: hashSignedObjectBody(decisionBody),
    checkpoint_sequence: "1",
    previous_checkpoint_hash: null,
    consumed_at: "2026-01-01T00:05:00.000Z",
  };
  const consumption = createSignedEnvelope(consumptionBody, [signatureInput(executor)]);

  const ledger = authorities.ledger;
  const receiptBody: ExecutionReceipt = {
    object_type: "ExecutionReceipt",
    ...pinned,
    issuer: executor.binding.issuer,
    key_id: executor.binding.key_id,
    issued_at: "2026-01-01T00:06:00.000Z",
    receipt_id: "synthetic-receipt-1",
    executor_issuer: executor.binding.issuer,
    executor_key_id: executor.binding.key_id,
    ledger_issuer: ledger.binding.issuer,
    ledger_key_id: ledger.binding.key_id,
    ledger_id: "synthetic-ledger-1",
    capsule_hash: hashSignedObjectBody(capsuleBody),
    consumption_hash: hashSignedObjectBody(consumptionBody),
    action_hash: actionHash,
    decision_hash: hashSignedObjectBody(decisionBody),
    effect_hash: hashTransferEffect(effect),
    status: "EXECUTED",
    executed_at: "2026-01-01T00:06:00.000Z",
  };
  const receipt = createSignedEnvelope(receiptBody, [signatureInput(executor), signatureInput(ledger)]);

  const observationBody: LedgerObservation = {
    object_type: "LedgerObservation",
    ...pinned,
    issuer: ledger.binding.issuer,
    key_id: ledger.binding.key_id,
    issued_at: "2026-01-01T00:07:00.000Z",
    observation_id: "synthetic-observation-1",
    ledger_id: receiptBody.ledger_id,
    receipt_body_hash: hashSignedObjectBody(receiptBody),
    effect_hash: hashTransferEffect(effect),
    status: "POSTED",
    mutation_count: "1",
    action_id: actionBody.action_id,
    ledger_sequence: "1",
    observed_at: "2026-01-01T00:07:00.000Z",
  };
  const ledgerObservation = createSignedEnvelope(observationBody, [signatureInput(ledger)]);

  const closureAuthority = authorities.closure_authority;
  const proofBody: ClosureProofBody = {
    object_type: "ClosureProof",
    ...pinned,
    issuer: closureAuthority.binding.issuer,
    key_id: closureAuthority.binding.key_id,
    issued_at: "2026-01-01T00:08:00.000Z",
    proof_id: "synthetic-proof-1",
    assurance_profile: ASSURANCE_PROFILE,
    manifest,
    mandate,
    action,
    effect,
    policy,
    interpreter,
    decision_input: decisionInput,
    decision,
    capsule,
    consumption_records: [consumption],
    receipt,
    ledger_observation: ledgerObservation,
    state_path: ["PROPOSED", "AUTHORIZED", "EXECUTION_INTENT_RECORDED", "EXECUTED", "CLOSED"],
    closed_at: "2026-01-01T00:08:00.000Z",
  };
  const proof = createSignedEnvelope(proofBody, [signatureInput(closureAuthority)]);

  const trustStore: TrustStore = {
    object_type: "TrustStore",
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    expected_assurance_profile: ASSURANCE_PROFILE,
    manifest_version: manifestBody.manifest_version,
    manifest_hash: manifestHash,
    trust_epoch: manifestBody.trust_epoch,
    trusted_roots: [{ ...root.binding, role: "trust_root" }],
  };

  return { proof, trust_store: trustStore, authorities };
}

export function signingInputFor(
  fixture: SyntheticProtocolFixture | SyntheticNegativeProtocolFixture,
  role: AuthorityRole,
): SignatureInput {
  return signatureInput(fixture.authorities[role]);
}

export function createSyntheticStepUpClosureFixture(): SyntheticProtocolFixture {
  const fixture = createSyntheticClosureFixture();
  const { authorities } = fixture;
  const actionBody = {
    ...fixture.proof.body.action.body,
    transfer: { ...fixture.proof.body.action.body.transfer, amount: "500000" },
  };
  const action = createSignedEnvelope(actionBody, [signatureInput(authorities.action_proposer)]);
  const effect = deriveTransferEffect(actionBody);
  const actionHash = hashSignedObjectBody(actionBody);
  const effectHash = hashTransferEffect(effect);

  const snapshotBody = {
    ...fixture.proof.body.decision_input.body,
    action_hash: actionHash,
    spendable_funds: "1000000",
    daily_spent: "0",
  };
  const decisionInput = createSignedEnvelope(snapshotBody, [signatureInput(authorities.snapshot_authority)]);

  const decisionBody: AuthorizationDecision = {
    ...fixture.proof.body.decision.body,
    action_hash: actionHash,
    snapshot_hash: hashSignedObjectBody(snapshotBody),
    outcome: "STEP_UP",
    reason_code: "STEP_UP_REQUIRED",
    approved_effect_hash: effectHash,
  };
  const decision = createSignedEnvelope(decisionBody, [signatureInput(authorities.decision_authority)]);
  const decisionHash = hashSignedObjectBody(decisionBody);

  const approvalBody: StepUpApproval = {
    object_type: "StepUpApproval",
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    issuer: authorities.approver.binding.issuer,
    key_id: authorities.approver.binding.key_id,
    issued_at: "2026-01-01T00:03:30.000Z",
    manifest_version: fixture.proof.body.manifest_version,
    manifest_hash: fixture.proof.body.manifest_hash,
    trust_epoch: fixture.proof.body.trust_epoch,
    approval_id: "synthetic-approval-1",
    action_hash: actionHash,
    decision_hash: decisionHash,
    approved_effect_hash: effectHash,
    requester_id: actionBody.customer_id,
    approver_id: "synthetic-operator-1",
    not_before: "2026-01-01T00:03:30.000Z",
    expires_at: "2026-01-01T00:10:00.000Z",
  };
  const approval = createSignedEnvelope(approvalBody, [signatureInput(authorities.approver)]);

  const capsuleBody = {
    ...fixture.proof.body.capsule.body,
    action_hash: actionHash,
    decision_hash: decisionHash,
    approved_effect_hash: effectHash,
  };
  const capsule = createSignedEnvelope(capsuleBody, [signatureInput(authorities.capsule_authority)]);
  const capsuleHash = hashSignedObjectBody(capsuleBody);

  const consumptionBody = {
    ...fixture.proof.body.consumption_records[0]!.body,
    capsule_hash: capsuleHash,
    action_hash: actionHash,
    decision_hash: decisionHash,
  };
  const consumption = createSignedEnvelope(consumptionBody, [signatureInput(authorities.executor)]);

  const receiptBody = {
    ...fixture.proof.body.receipt.body,
    capsule_hash: capsuleHash,
    consumption_hash: hashSignedObjectBody(consumptionBody),
    action_hash: actionHash,
    decision_hash: decisionHash,
    effect_hash: effectHash,
  };
  const receipt = createSignedEnvelope(receiptBody, [
    signatureInput(authorities.executor),
    signatureInput(authorities.ledger),
  ]);

  const observationBody = {
    ...fixture.proof.body.ledger_observation.body,
    receipt_body_hash: hashSignedObjectBody(receiptBody),
    effect_hash: effectHash,
    mutation_count: "1",
    action_id: actionBody.action_id,
  };
  const ledgerObservation = createSignedEnvelope(observationBody, [signatureInput(authorities.ledger)]);

  const proofBody: ClosureProofBody = {
    ...fixture.proof.body,
    action,
    effect,
    decision_input: decisionInput,
    decision,
    step_up_approval: approval,
    capsule,
    consumption_records: [consumption],
    receipt,
    ledger_observation: ledgerObservation,
    state_path: ["PROPOSED", "STEP_UP_REQUIRED", "APPROVED", "EXECUTION_INTENT_RECORDED", "EXECUTED", "CLOSED"],
  };
  return {
    proof: createSignedEnvelope(proofBody, [signatureInput(authorities.closure_authority)]),
    trust_store: fixture.trust_store,
    authorities,
  };
}

export function createSyntheticNegativeClosureFixture(): SyntheticNegativeProtocolFixture {
  const fixture = createSyntheticClosureFixture();
  const { authorities } = fixture;
  const snapshotBody = {
    ...fixture.proof.body.decision_input.body,
    spendable_funds: "1",
  };
  const decisionInput = createSignedEnvelope(snapshotBody, [signatureInput(authorities.snapshot_authority)]);
  const decisionBody: AuthorizationDecision = {
    ...fixture.proof.body.decision.body,
    snapshot_hash: hashSignedObjectBody(snapshotBody),
    outcome: "DENY",
    reason_code: "INSUFFICIENT_SPENDABLE_FUNDS",
    approved_effect_hash: null,
  };
  const decision = createSignedEnvelope(decisionBody, [signatureInput(authorities.decision_authority)]);
  const observationBody: LedgerObservation = {
    ...fixture.proof.body.ledger_observation.body,
    receipt_body_hash: null,
    effect_hash: null,
    status: "ABSENT",
    mutation_count: "0",
    action_id: fixture.proof.body.action.body.action_id,
  };
  const ledgerObservation = createSignedEnvelope(observationBody, [signatureInput(authorities.ledger)]);
  const proofBody: NegativeClosureProofBody = {
    object_type: "NegativeClosureProof",
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    issuer: authorities.closure_authority.binding.issuer,
    key_id: authorities.closure_authority.binding.key_id,
    issued_at: "2026-01-01T00:08:00.000Z",
    manifest_version: fixture.proof.body.manifest_version,
    manifest_hash: fixture.proof.body.manifest_hash,
    trust_epoch: fixture.proof.body.trust_epoch,
    proof_id: "synthetic-negative-proof-1",
    assurance_profile: ASSURANCE_PROFILE,
    terminal_reason: "AUTHORIZATION_DENIED",
    manifest: fixture.proof.body.manifest,
    mandate: fixture.proof.body.mandate,
    action: fixture.proof.body.action,
    effect: fixture.proof.body.effect,
    policy: fixture.proof.body.policy,
    interpreter: fixture.proof.body.interpreter,
    decision_input: decisionInput,
    decision,
    step_up_approval: null,
    ledger_observation: ledgerObservation,
    state_path: ["PROPOSED", "AUTHORIZATION_DENIED", "CLOSED"],
    closed_at: "2026-01-01T00:08:00.000Z",
  };
  return {
    proof: createSignedEnvelope(proofBody, [signatureInput(authorities.closure_authority)]),
    trust_store: fixture.trust_store,
    authorities,
  };
}
