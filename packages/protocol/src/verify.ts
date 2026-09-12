import {
  hashSignedObjectBody,
  hashTransferEffect,
  signaturesAreSorted,
  verifyObjectSignature,
  type SignableObject,
} from "./crypto.js";
import {
  deriveTransferEffect,
  evaluateKrwTransfer,
  isActionWithinMandate,
  isKrwTransferDescriptorCompatible,
  isMandateValidAtAuthorization,
} from "./evaluator.js";
import { isSuccessfulStatePath } from "./state.js";
import {
  ASSURANCE_PROFILE,
  KRW_TRANSFER_POLICY,
  type AuthorityBinding,
  type AuthorityRole,
  type ClosureFailureCode,
  type ClosureProof,
  type ClosureVerificationResult,
  type SignedEnvelope,
  type SignedObjectType,
  type TrustRootManifest,
  type TrustStore,
} from "./types.js";
import { validateObject } from "./validation.js";

const REQUIRED_ROLES: readonly AuthorityRole[] = [
  "trust_root",
  "mandate_authority",
  "action_proposer",
  "policy_authority",
  "interpreter_authority",
  "snapshot_authority",
  "decision_authority",
  "capsule_authority",
  "executor",
  "ledger",
  "closure_authority",
];

const ENVELOPE_ROLES: Record<string, readonly AuthorityRole[]> = {
  manifest: ["trust_root"],
  mandate: ["mandate_authority"],
  action: ["action_proposer"],
  policy: ["policy_authority"],
  interpreter: ["interpreter_authority"],
  decision_input: ["snapshot_authority"],
  decision: ["decision_authority"],
  capsule: ["capsule_authority"],
  receipt: ["executor", "ledger"],
  ledger_observation: ["ledger"],
};

function failure(code: ClosureFailureCode, path: string, message: string): ClosureVerificationResult {
  return { valid: false, code, path, message };
}

function firstMismatch(
  pairs: ReadonlyArray<readonly [string, unknown, unknown]>,
): readonly [string, unknown, unknown] | undefined {
  return pairs.find(([, left, right]) => left !== right);
}

function duplicateBinding(authorities: readonly AuthorityBinding[]): boolean {
  const seen = new Set<string>();
  for (const binding of authorities) {
    const key = `${binding.role}\0${binding.issuer}\0${binding.key_id}`;
    if (seen.has(key) || [...seen].some((item) => item.startsWith(`${binding.role}\0`))) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

function bindingByRole(
  authorities: readonly AuthorityBinding[],
  role: AuthorityRole,
): AuthorityBinding | undefined {
  return authorities.find((binding) => binding.role === role);
}

function trustedRootMatches(store: TrustStore, manifest: TrustRootManifest): boolean {
  return store.trusted_roots.some(
    (root) =>
      root.role === "trust_root" &&
      root.issuer === manifest.issuer &&
      root.key_id === manifest.key_id &&
      root.algorithm === "Ed25519" &&
      root.public_key ===
        bindingByRole(manifest.authorities, "trust_root")?.public_key,
  );
}

type SignedBody = SignableObject & { issuer: string; key_id: string };

function verifyEnvelope(
  envelope: SignedEnvelope<SignedBody>,
  roles: readonly AuthorityRole[],
  authorities: readonly AuthorityBinding[],
  path: string,
): ClosureVerificationResult | undefined {
  if (!signaturesAreSorted(envelope.signatures)) {
    return failure("SIGNATURE_ORDER_INVALID", `${path}/signatures`, "signatures must be in canonical order");
  }
  if (envelope.signatures.length !== roles.length) {
    return failure(
      "AUTHORITY_BINDING_INVALID",
      `${path}/signatures`,
      "signature set does not match the required authority roles",
    );
  }
  for (const role of roles) {
    const signature = envelope.signatures.find((item) => item.role === role);
    const binding = bindingByRole(authorities, role);
    if (!signature || !binding) {
      return failure("AUTHORITY_BINDING_INVALID", `${path}/signatures`, `missing ${role} signature or binding`);
    }
    if (signature.issuer !== binding.issuer || signature.key_id !== binding.key_id) {
      return failure(
        "AUTHORITY_BINDING_INVALID",
        `${path}/signatures`,
        `${role} signature does not match the trust manifest binding`,
      );
    }
    if (role === roles[0] && (envelope.body.issuer !== binding.issuer || envelope.body.key_id !== binding.key_id)) {
      return failure(
        "AUTHORITY_BINDING_INVALID",
        `${path}/body`,
        "object issuer and key_id must match the primary authority",
      );
    }
    if (!verifyObjectSignature(envelope.body, signature, binding.public_key)) {
      return failure("SIGNATURE_INVALID", `${path}/signatures`, `${role} signature is invalid`);
    }
  }
  return undefined;
}

function verifyProofSemantics(proof: ClosureProof, trustStore: TrustStore): ClosureVerificationResult | undefined {
  const body = proof.body;
  const manifest = body.manifest.body;
  const authorities = manifest.authorities;

  if (duplicateBinding(authorities) || REQUIRED_ROLES.some((role) => !bindingByRole(authorities, role))) {
    return failure(
      "TRUST_MANIFEST_BINDING_INVALID",
      "/body/manifest/body/authorities",
      "trust manifest must bind each Stage 1 authority role exactly once",
    );
  }

  if (!trustedRootMatches(trustStore, manifest)) {
    return failure("TRUST_ROOT_NOT_TRUSTED", "/trust_store/trusted_roots", "manifest trust root is not in the trust store");
  }

  if (
    trustStore.manifest_version !== manifest.manifest_version ||
    trustStore.trust_epoch !== manifest.trust_epoch ||
    trustStore.manifest_hash !== hashSignedObjectBody(manifest)
  ) {
    return failure("MANIFEST_PIN_MISMATCH", "/trust_store", "trust store pin does not match the proof manifest");
  }

  const manifestSignature = verifyEnvelope(body.manifest, ["trust_root"], authorities, "/body/manifest");
  if (manifestSignature) {
    return manifestSignature.code === "SIGNATURE_INVALID"
      ? failure("TRUST_MANIFEST_SIGNATURE_INVALID", "/body/manifest/signatures", manifestSignature.message)
      : manifestSignature;
  }

  if (
    body.assurance_profile !== ASSURANCE_PROFILE ||
    trustStore.expected_assurance_profile !== ASSURANCE_PROFILE ||
    manifest.assurance_profile !== ASSURANCE_PROFILE
  ) {
    return failure("ASSURANCE_PROFILE_MISMATCH", "/body/assurance_profile", "assurance profile is not single_process_simulation");
  }

  const pin = {
    protocol_version: manifest.protocol_version,
    schema_version: manifest.schema_version,
    manifest_version: manifest.manifest_version,
    manifest_hash: hashSignedObjectBody(manifest),
    trust_epoch: manifest.trust_epoch,
  };

  const pinnedObjects: Array<[string, { protocol_version: string; schema_version: string; manifest_version: string; manifest_hash: string; trust_epoch: string }]> = [
    ["/body", body],
    ["/body/mandate/body", body.mandate.body],
    ["/body/action/body", body.action.body],
    ["/body/policy/body", body.policy.body],
    ["/body/interpreter/body", body.interpreter.body],
    ["/body/decision_input/body", body.decision_input.body],
    ["/body/decision/body", body.decision.body],
    ["/body/capsule/body", body.capsule.body],
    ["/body/receipt/body", body.receipt.body],
    ["/body/ledger_observation/body", body.ledger_observation.body],
  ];
  for (const record of body.consumption_records) {
    pinnedObjects.push(["/body/consumption_records/0/body", record.body]);
  }
  for (const [path, object] of pinnedObjects) {
    const mismatch = firstMismatch([
      [`${path}/protocol_version`, object.protocol_version, pin.protocol_version],
      [`${path}/schema_version`, object.schema_version, pin.schema_version],
      [`${path}/manifest_version`, object.manifest_version, pin.manifest_version],
      [`${path}/manifest_hash`, object.manifest_hash, pin.manifest_hash],
      [`${path}/trust_epoch`, object.trust_epoch, pin.trust_epoch],
    ]);
    if (mismatch) {
      return failure("MANIFEST_PIN_MISMATCH", mismatch[0], "object is not pinned to the trusted manifest");
    }
  }

  for (const [field, roles] of Object.entries(ENVELOPE_ROLES)) {
    const envelope = (body as unknown as Record<string, SignedEnvelope<SignedBody>>)[field];
    if (!envelope) continue;
    const invalid = verifyEnvelope(envelope, roles, authorities, `/body/${field}`);
    if (invalid) return invalid;
  }
  const proofSig = verifyEnvelope(proof, ["closure_authority"], authorities, "");
  if (proofSig) return proofSig;

  if (body.consumption_records.length !== 1) {
    return failure(
      "CONSUMPTION_CARDINALITY_INVALID",
      "/body/consumption_records",
      "Stage 1 proofs must contain exactly one consumption record",
    );
  }
  const consumptionEnvelope = body.consumption_records[0]!;
  const consumptionSig = verifyEnvelope(consumptionEnvelope, ["executor"], authorities, "/body/consumption_records/0");
  if (consumptionSig) return consumptionSig;

  if (!isActionWithinMandate(body.mandate.body, body.action.body)) {
    return failure("MANDATE_SCOPE_INVALID", "/body/action/body", "proposed action is outside the signed mandate");
  }
  if (!isMandateValidAtAuthorization(body.mandate.body, body.action.body, body.decision.body.authorized_at)) {
    return failure("AUTHORIZATION_TIME_INVALID", "/body/decision/body/authorized_at", "authorization time is outside the mandate window");
  }

  const actionHash = hashSignedObjectBody(body.action.body);
  const mandateHash = hashSignedObjectBody(body.mandate.body);
  const policyHash = hashSignedObjectBody(body.policy.body);
  const interpreterHash = hashSignedObjectBody(body.interpreter.body);
  const snapshotHash = hashSignedObjectBody(body.decision_input.body);
  const decisionHash = hashSignedObjectBody(body.decision.body);
  const capsuleHash = hashSignedObjectBody(body.capsule.body);
  const consumptionHash = hashSignedObjectBody(consumptionEnvelope.body);
  const receiptHash = hashSignedObjectBody(body.receipt.body);
  const effectHash = hashTransferEffect(body.effect);
  const derivedEffect = deriveTransferEffect(body.action.body);

  const hashMismatch = firstMismatch([
    ["/body/decision_input/body/action_hash", body.decision_input.body.action_hash, actionHash],
    ["/body/decision_input/body/mandate_hash", body.decision_input.body.mandate_hash, mandateHash],
    ["/body/decision_input/body/policy_hash", body.decision_input.body.policy_hash, policyHash],
    ["/body/decision_input/body/interpreter_hash", body.decision_input.body.interpreter_hash, interpreterHash],
    ["/body/decision/body/action_hash", body.decision.body.action_hash, actionHash],
    ["/body/decision/body/mandate_hash", body.decision.body.mandate_hash, mandateHash],
    ["/body/decision/body/policy_hash", body.decision.body.policy_hash, policyHash],
    ["/body/decision/body/interpreter_hash", body.decision.body.interpreter_hash, interpreterHash],
    ["/body/decision/body/snapshot_hash", body.decision.body.snapshot_hash, snapshotHash],
  ]);
  if (hashMismatch) {
    return failure("OBJECT_HASH_LINK_INVALID", hashMismatch[0], "hash-linked objects do not form a closed chain");
  }

  if (
    body.policy.body.policy_type !== KRW_TRANSFER_POLICY ||
    !manifest.supported_policy_ids.includes(body.policy.body.policy_id)
  ) {
    return failure("POLICY_UNSUPPORTED", "/body/policy/body", "policy is not supported by the trust manifest");
  }
  if (
    !isKrwTransferDescriptorCompatible(body.interpreter.body) ||
    body.interpreter.body.policy_id !== body.policy.body.policy_id ||
    !manifest.supported_interpreter_ids.includes(body.interpreter.body.interpreter_id)
  ) {
    return failure("INTERPRETER_UNSUPPORTED", "/body/interpreter/body", "interpreter is not supported for this policy");
  }

  const replayed = evaluateKrwTransfer(
    body.mandate.body,
    body.action.body,
    body.policy.body,
    body.decision_input.body,
  );
  if (replayed.outcome !== body.decision.body.outcome || replayed.reason_code !== body.decision.body.reason_code) {
    return failure("DECISION_REPLAY_MISMATCH", "/body/decision/body", "authorization decision does not replay from the attested snapshot");
  }
  if (body.decision.body.outcome !== "ALLOW" || body.decision.body.approved_effect_hash !== effectHash) {
    return failure("DECISION_NOT_ALLOWED", "/body/decision/body", "Stage 1 closure requires an ALLOW decision and matching effect hash");
  }
  if (
    derivedEffect.action_id !== body.effect.action_id ||
    derivedEffect.from_account_id !== body.effect.from_account_id ||
    derivedEffect.to_account_id !== body.effect.to_account_id ||
    derivedEffect.amount !== body.effect.amount ||
    derivedEffect.currency !== body.effect.currency
  ) {
    return failure("EFFECT_MISMATCH", "/body/effect", "transfer effect does not match the proposed action");
  }

  const capsuleMismatch = firstMismatch([
    ["/body/capsule/body/action_hash", body.capsule.body.action_hash, actionHash],
    ["/body/capsule/body/decision_hash", body.capsule.body.decision_hash, decisionHash],
    ["/body/capsule/body/approved_effect_hash", body.capsule.body.approved_effect_hash, effectHash],
  ]);
  if (capsuleMismatch) {
    return failure("CAPSULE_LINK_INVALID", capsuleMismatch[0], "execution capsule is not linked to the approved decision");
  }

  const consumption = consumptionEnvelope.body;
  const consumptionMismatch = firstMismatch([
    ["/body/consumption_records/0/body/capsule_hash", consumption.capsule_hash, capsuleHash],
    ["/body/consumption_records/0/body/action_hash", consumption.action_hash, actionHash],
    ["/body/consumption_records/0/body/decision_hash", consumption.decision_hash, decisionHash],
  ]);
  if (consumptionMismatch) {
    return failure("CONSUMPTION_LINK_INVALID", consumptionMismatch[0], "consumption record is not linked to the capsule");
  }

  const receipt = body.receipt.body;
  const receiptMismatch = firstMismatch([
    ["/body/receipt/body/capsule_hash", receipt.capsule_hash, capsuleHash],
    ["/body/receipt/body/consumption_hash", receipt.consumption_hash, consumptionHash],
    ["/body/receipt/body/action_hash", receipt.action_hash, actionHash],
    ["/body/receipt/body/decision_hash", receipt.decision_hash, decisionHash],
    ["/body/receipt/body/effect_hash", receipt.effect_hash, effectHash],
    ["/body/receipt/body/executor_issuer", receipt.executor_issuer, bindingByRole(authorities, "executor")?.issuer],
    ["/body/receipt/body/executor_key_id", receipt.executor_key_id, bindingByRole(authorities, "executor")?.key_id],
    ["/body/receipt/body/ledger_issuer", receipt.ledger_issuer, bindingByRole(authorities, "ledger")?.issuer],
    ["/body/receipt/body/ledger_key_id", receipt.ledger_key_id, bindingByRole(authorities, "ledger")?.key_id],
  ]);
  if (receiptMismatch) {
    return failure("RECEIPT_LINK_INVALID", receiptMismatch[0], "execution receipt is not linked to the consumed capsule");
  }

  const observation = body.ledger_observation.body;
  const observationMismatch = firstMismatch([
    ["/body/ledger_observation/body/receipt_body_hash", observation.receipt_body_hash, receiptHash],
    ["/body/ledger_observation/body/effect_hash", observation.effect_hash, effectHash],
    ["/body/ledger_observation/body/issuer", observation.issuer, receipt.ledger_issuer],
    ["/body/ledger_observation/body/key_id", observation.key_id, receipt.ledger_key_id],
    ["/body/ledger_observation/body/ledger_id", observation.ledger_id, receipt.ledger_id],
  ]);
  if (observationMismatch) {
    return failure(
      "LEDGER_OBSERVATION_INVALID",
      observationMismatch[0],
      "positive ledger observation does not match receipt and effect",
    );
  }

  const timelineIsValid = [
    Date.parse(body.decision.body.authorized_at) <= Date.parse(body.capsule.body.issued_at),
    Date.parse(body.capsule.body.not_before) <= Date.parse(consumption.consumed_at),
    Date.parse(consumption.consumed_at) <= Date.parse(receipt.executed_at),
    Date.parse(receipt.executed_at) < Date.parse(body.capsule.body.expires_at),
  ].every(Boolean);
  if (!timelineIsValid) {
    return failure(
      "CAPSULE_TIME_INVALID",
      "/body/capsule/body",
      "capsule was not consumed and executed within its validity window",
    );
  }

  if (!isSuccessfulStatePath(body.state_path)) {
    return failure(
      "STATE_PATH_INVALID",
      "/body/state_path",
      "closure state path is not the exact legal Stage 1 success path",
    );
  }

  const closureTimelineIsValid = [
    Date.parse(receipt.executed_at) <= Date.parse(observation.observed_at),
    Date.parse(observation.observed_at) <= Date.parse(body.closed_at),
    Date.parse(body.closed_at) <= Date.parse(body.issued_at),
  ].every(Boolean);
  if (!closureTimelineIsValid) {
    return failure(
      "CLOSURE_TIME_INVALID",
      "/body/closed_at",
      "ledger observation, closure, and proof issuance are out of order",
    );
  }
  return undefined;
}

export function verifyClosureProof(proofInput: unknown, trustStoreInput: unknown): ClosureVerificationResult {
  try {
    const trustStore = validateObject("TrustStore", trustStoreInput);
    if (!trustStore.valid) {
      return failure("TRUST_STORE_SCHEMA_INVALID", trustStore.issues[0]?.path ?? "/", "trust store does not match the protocol schema");
    }
    const proof = validateObject("ClosureProof", proofInput);
    if (!proof.valid) {
      return failure("PROOF_SCHEMA_INVALID", proof.issues[0]?.path ?? "/", "closure proof does not match the protocol schema");
    }
    const semantic = verifyProofSemantics(proof.value, trustStore.value);
    if (semantic) return semantic;
    return {
      valid: true,
      code: "VALID",
      proof_id: proof.value.body.proof_id,
      manifest_hash: hashSignedObjectBody(proof.value.body.manifest.body),
      receipt_body_hash: hashSignedObjectBody(proof.value.body.receipt.body),
      effect_hash: hashTransferEffect(proof.value.body.effect),
    };
  } catch {
    return failure("INTERNAL_VERIFICATION_ERROR", "/", "verification failed unexpectedly");
  }
}
