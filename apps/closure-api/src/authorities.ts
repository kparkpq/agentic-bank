import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  ASSURANCE_PROFILE,
  KRW_TRANSFER_EVALUATOR_VERSION,
  KRW_TRANSFER_INTERPRETER,
  KRW_TRANSFER_POLICY,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  createSignedEnvelope,
  exportPublicKey,
  hashSignedObjectBody,
  type AuthorityBinding,
  type AuthorityRole,
  type InterpreterDescriptor,
  type PolicyArtifact,
  type SignatureInput,
  type SignedEnvelope,
  type TrustRootManifest,
  type TrustStore,
} from "@execution-closure/protocol";

export type RuntimeAuthority = {
  binding: AuthorityBinding;
  private_key: KeyObject;
};

export type RuntimeAuthorities = Record<AuthorityRole, RuntimeAuthority>;

export type ClosureRuntimeKeys = {
  authorities: RuntimeAuthorities;
  manifest: SignedEnvelope<TrustRootManifest>;
  policy: SignedEnvelope<PolicyArtifact>;
  interpreter: SignedEnvelope<InterpreterDescriptor>;
  trust_store: TrustStore;
  pin: {
    protocol_version: typeof PROTOCOL_VERSION;
    schema_version: typeof SCHEMA_VERSION;
    manifest_version: string;
    manifest_hash: string;
    trust_epoch: string;
  };
};

const POLICY_ID = "synthetic-krw-policy-1";

function createAuthority(role: AuthorityRole, issuer: string): RuntimeAuthority {
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

export function signatureInput(authority: RuntimeAuthority): SignatureInput {
  return {
    role: authority.binding.role,
    issuer: authority.binding.issuer,
    key_id: authority.binding.key_id,
    private_key: authority.private_key,
  };
}

export function createClosureRuntimeKeys(issuedAt: string): ClosureRuntimeKeys {
  const authorities: RuntimeAuthorities = {
    trust_root: createAuthority("trust_root", "synthetic-root"),
    mandate_authority: createAuthority("mandate_authority", "synthetic-mandate-authority"),
    action_proposer: createAuthority("action_proposer", "synthetic-agent"),
    policy_authority: createAuthority("policy_authority", "synthetic-policy-authority"),
    interpreter_authority: createAuthority("interpreter_authority", "synthetic-interpreter-authority"),
    snapshot_authority: createAuthority("snapshot_authority", "synthetic-snapshot-authority"),
    decision_authority: createAuthority("decision_authority", "synthetic-decision-authority"),
    capsule_authority: createAuthority("capsule_authority", "synthetic-capsule-authority"),
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
    issued_at: issuedAt,
    manifest_version: "1",
    trust_epoch: "1",
    assurance_profile: ASSURANCE_PROFILE,
    authorities: Object.values(authorities).map((authority) => authority.binding),
    supported_policy_ids: [POLICY_ID],
    supported_interpreter_ids: [KRW_TRANSFER_INTERPRETER],
  };
  const manifest = createSignedEnvelope(manifestBody, [signatureInput(root)]);
  const manifestHash = hashSignedObjectBody(manifestBody);
  const pin = {
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    manifest_version: "1",
    manifest_hash: manifestHash,
    trust_epoch: "1",
  } as const;

  const policyAuthority = authorities.policy_authority;
  const policyBody: PolicyArtifact = {
    object_type: "PolicyArtifact",
    ...pin,
    issuer: policyAuthority.binding.issuer,
    key_id: policyAuthority.binding.key_id,
    issued_at: issuedAt,
    policy_id: POLICY_ID,
    policy_type: KRW_TRANSFER_POLICY,
    daily_cap: "5000000",
    step_up_threshold: "1000000",
  };
  const policy = createSignedEnvelope(policyBody, [signatureInput(policyAuthority)]);

  const interpreterAuthority = authorities.interpreter_authority;
  const interpreterBody: InterpreterDescriptor = {
    object_type: "InterpreterDescriptor",
    ...pin,
    issuer: interpreterAuthority.binding.issuer,
    key_id: interpreterAuthority.binding.key_id,
    issued_at: issuedAt,
    interpreter_id: KRW_TRANSFER_INTERPRETER,
    interpreter_version: KRW_TRANSFER_EVALUATOR_VERSION,
    policy_id: POLICY_ID,
    policy_type: KRW_TRANSFER_POLICY,
    supported_protocol_version: PROTOCOL_VERSION,
    supported_schema_version: SCHEMA_VERSION,
  };
  const interpreter = createSignedEnvelope(interpreterBody, [signatureInput(interpreterAuthority)]);

  return {
    authorities,
    manifest,
    policy,
    interpreter,
    pin,
    trust_store: {
      object_type: "TrustStore",
      protocol_version: PROTOCOL_VERSION,
      schema_version: SCHEMA_VERSION,
      expected_assurance_profile: ASSURANCE_PROFILE,
      manifest_version: "1",
      manifest_hash: manifestHash,
      trust_epoch: "1",
      trusted_roots: [{ ...root.binding, role: "trust_root" }],
    },
  };
}
