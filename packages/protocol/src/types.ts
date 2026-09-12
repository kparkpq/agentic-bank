import type { KeyLike } from "node:crypto";

export const PROTOCOL_VERSION = "ec-v0" as const;
export const SCHEMA_VERSION = "1" as const;
export const ASSURANCE_PROFILE = "single_process_simulation" as const;
export const KRW_TRANSFER_POLICY = "krw-transfer-v0" as const;
export const KRW_TRANSFER_INTERPRETER = "krw-transfer-v0" as const;
export const KRW_TRANSFER_EVALUATOR_VERSION = "1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type SchemaVersion = typeof SCHEMA_VERSION;
export type AssuranceProfile = typeof ASSURANCE_PROFILE;
export type AmountString = string;
export type NonNegativeIntegerString = string;
export type AccountId = string;
export type Timestamp = string;
export type HashString = string;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AuthorityRole =
  | "trust_root"
  | "mandate_authority"
  | "action_proposer"
  | "policy_authority"
  | "interpreter_authority"
  | "snapshot_authority"
  | "decision_authority"
  | "capsule_authority"
  | "approver"
  | "executor"
  | "ledger"
  | "closure_authority";

export type SignedObjectType =
  | "TrustRootManifest"
  | "Mandate"
  | "ProposedAction"
  | "PolicyArtifact"
  | "InterpreterDescriptor"
  | "DecisionInputSnapshot"
  | "AuthorizationDecision"
  | "StepUpApproval"
  | "ExecutionCapsule"
  | "ConsumptionRecord"
  | "ExecutionReceipt"
  | "LedgerObservation"
  | "ClosureProof"
  | "NegativeClosureProof";

export type ProtocolObjectType =
  | SignedObjectType
  | "TrustStore"
  | "TransferEffect";

export type SchemaObjectType =
  | ProtocolObjectType
  | "Signature"
  | "SignedEnvelope";

export interface Signature {
  role: AuthorityRole;
  issuer: string;
  key_id: string;
  algorithm: "Ed25519";
  signature: string;
}

export interface SignatureInput {
  role: AuthorityRole;
  issuer: string;
  key_id: string;
  private_key: KeyLike;
}

export interface SignedEnvelope<T> {
  body: T;
  signatures: Signature[];
}

export interface AuthorityBinding {
  role: AuthorityRole;
  issuer: string;
  key_id: string;
  algorithm: "Ed25519";
  public_key: string;
}

export interface TrustRootManifest {
  object_type: "TrustRootManifest";
  protocol_version: ProtocolVersion;
  schema_version: SchemaVersion;
  issuer: string;
  key_id: string;
  issued_at: Timestamp;
  manifest_version: string;
  trust_epoch: string;
  assurance_profile: AssuranceProfile;
  authorities: AuthorityBinding[];
  supported_policy_ids: string[];
  supported_interpreter_ids: string[];
}

export interface TrustedRoot {
  role: "trust_root";
  issuer: string;
  key_id: string;
  algorithm: "Ed25519";
  public_key: string;
}

export type KeyIncidentKind = "rotation" | "compromise";

export interface KeyIncident {
  key_id: string;
  issuer: string;
  kind: KeyIncidentKind;
  revoked_at?: Timestamp;
  invalid_from?: Timestamp;
}

export interface TrustStore {
  object_type: "TrustStore";
  protocol_version: ProtocolVersion;
  schema_version: SchemaVersion;
  expected_assurance_profile: AssuranceProfile;
  manifest_version: string;
  manifest_hash: HashString;
  trust_epoch: string;
  trusted_roots: TrustedRoot[];
  installed_at?: Timestamp;
  key_incidents?: KeyIncident[];
}

export interface ManifestPinnedObject<T extends SignedObjectType> {
  object_type: T;
  protocol_version: ProtocolVersion;
  schema_version: SchemaVersion;
  issuer: string;
  key_id: string;
  issued_at: Timestamp;
  manifest_version: string;
  manifest_hash: HashString;
  trust_epoch: string;
}

export interface Mandate extends ManifestPinnedObject<"Mandate"> {
  mandate_id: string;
  customer_id: string;
  agent_id: string;
  from_account_id: AccountId;
  to_account_id: AccountId;
  currency: "KRW";
  max_amount: AmountString;
  not_before: Timestamp;
  expires_at: Timestamp;
}

export interface TransferInstruction {
  from_account_id: AccountId;
  to_account_id: AccountId;
  currency: "KRW";
  amount: AmountString;
}

export interface ProposedAction extends ManifestPinnedObject<"ProposedAction"> {
  action_id: string;
  mandate_id: string;
  customer_id: string;
  agent_id: string;
  transfer: TransferInstruction;
}

export interface TransferEffect {
  object_type: "TransferEffect";
  protocol_version: ProtocolVersion;
  schema_version: SchemaVersion;
  action_id: string;
  from_account_id: AccountId;
  to_account_id: AccountId;
  currency: "KRW";
  amount: AmountString;
}

export interface PolicyArtifact extends ManifestPinnedObject<"PolicyArtifact"> {
  policy_id: string;
  policy_type: typeof KRW_TRANSFER_POLICY;
  daily_cap: AmountString;
  step_up_threshold: AmountString;
}

export interface InterpreterDescriptor extends ManifestPinnedObject<"InterpreterDescriptor"> {
  interpreter_id: typeof KRW_TRANSFER_INTERPRETER;
  interpreter_version: typeof KRW_TRANSFER_EVALUATOR_VERSION;
  policy_id: string;
  policy_type: typeof KRW_TRANSFER_POLICY;
  supported_protocol_version: ProtocolVersion;
  supported_schema_version: SchemaVersion;
}

export type AccountStatus = "OPEN" | "FROZEN" | "CLOSED";

export interface DecisionInputSnapshot extends ManifestPinnedObject<"DecisionInputSnapshot"> {
  snapshot_id: string;
  action_hash: HashString;
  mandate_hash: HashString;
  policy_hash: HashString;
  interpreter_hash: HashString;
  from_account_status: AccountStatus;
  to_account_status: AccountStatus;
  from_owner_customer_id: string;
  to_owner_customer_id: string;
  spendable_funds: NonNegativeIntegerString;
  daily_spent: NonNegativeIntegerString;
}

export type EvaluatorReasonCode =
  | "POLICY_ALLOW"
  | "SOURCE_ACCOUNT_NOT_OPEN"
  | "DESTINATION_ACCOUNT_NOT_OPEN"
  | "SENDER_OWNERSHIP_MISMATCH"
  | "INSUFFICIENT_SPENDABLE_FUNDS"
  | "DAILY_CAP_EXCEEDED"
  | "CROSS_CUSTOMER_TRANSFER"
  | "STEP_UP_REQUIRED";

export interface AuthorizationDecision extends ManifestPinnedObject<"AuthorizationDecision"> {
  decision_id: string;
  action_hash: HashString;
  mandate_hash: HashString;
  policy_hash: HashString;
  interpreter_hash: HashString;
  snapshot_hash: HashString;
  outcome: "ALLOW" | "DENY" | "STEP_UP";
  reason_code: EvaluatorReasonCode;
  approved_effect_hash: HashString | null;
  authorized_at: Timestamp;
}

export interface StepUpApproval extends ManifestPinnedObject<"StepUpApproval"> {
  approval_id: string;
  action_hash: HashString;
  decision_hash: HashString;
  approved_effect_hash: HashString;
  requester_id: string;
  approver_id: string;
  not_before: Timestamp;
  expires_at: Timestamp;
}

export interface ExecutionCapsule extends ManifestPinnedObject<"ExecutionCapsule"> {
  capsule_id: string;
  action_hash: HashString;
  decision_hash: HashString;
  approved_effect_hash: HashString;
  not_before: Timestamp;
  expires_at: Timestamp;
  nonce: string;
}

export interface ConsumptionRecord extends ManifestPinnedObject<"ConsumptionRecord"> {
  consumption_id: string;
  capsule_hash: HashString;
  action_hash: HashString;
  decision_hash: HashString;
  checkpoint_sequence: "1";
  previous_checkpoint_hash: null;
  consumed_at: Timestamp;
}

export interface ExecutionReceipt extends ManifestPinnedObject<"ExecutionReceipt"> {
  receipt_id: string;
  executor_issuer: string;
  executor_key_id: string;
  ledger_issuer: string;
  ledger_key_id: string;
  ledger_id: string;
  capsule_hash: HashString;
  consumption_hash: HashString;
  action_hash: HashString;
  decision_hash: HashString;
  effect_hash: HashString;
  status: "EXECUTED";
  executed_at: Timestamp;
}

export interface LedgerObservation extends ManifestPinnedObject<"LedgerObservation"> {
  observation_id: string;
  ledger_id: string;
  receipt_body_hash: HashString | null;
  effect_hash: HashString | null;
  status: "POSTED" | "ABSENT";
  mutation_count: NonNegativeIntegerString;
  action_id: string;
  ledger_sequence: string;
  observed_at: Timestamp;
}

export type ProtocolState =
  | "PROPOSED"
  | "AUTHORIZED"
  | "AUTHORIZATION_DENIED"
  | "STEP_UP_REQUIRED"
  | "APPROVED"
  | "EXECUTION_INTENT_RECORDED"
  | "EXECUTED"
  | "EXECUTION_FAILED"
  | "EXECUTION_UNKNOWN"
  | "CANCELLED"
  | "EXPIRED"
  | "REVOKED"
  | "CLOSED";

export type NegativeTerminalReason =
  | "AUTHORIZATION_DENIED"
  | "REVOKED"
  | "EXPIRED"
  | "EXECUTION_FAILED";

export interface ClosureProofBody extends ManifestPinnedObject<"ClosureProof"> {
  proof_id: string;
  assurance_profile: AssuranceProfile;
  manifest: SignedEnvelope<TrustRootManifest>;
  mandate: SignedEnvelope<Mandate>;
  action: SignedEnvelope<ProposedAction>;
  effect: TransferEffect;
  policy: SignedEnvelope<PolicyArtifact>;
  interpreter: SignedEnvelope<InterpreterDescriptor>;
  decision_input: SignedEnvelope<DecisionInputSnapshot>;
  decision: SignedEnvelope<AuthorizationDecision>;
  step_up_approval?: SignedEnvelope<StepUpApproval> | null;
  capsule: SignedEnvelope<ExecutionCapsule>;
  consumption_records: SignedEnvelope<ConsumptionRecord>[];
  receipt: SignedEnvelope<ExecutionReceipt>;
  ledger_observation: SignedEnvelope<LedgerObservation>;
  state_path: ProtocolState[];
  closed_at: Timestamp;
}

export type ClosureProof = SignedEnvelope<ClosureProofBody>;

export interface NegativeClosureProofBody extends ManifestPinnedObject<"NegativeClosureProof"> {
  proof_id: string;
  assurance_profile: AssuranceProfile;
  terminal_reason: NegativeTerminalReason;
  manifest: SignedEnvelope<TrustRootManifest>;
  mandate: SignedEnvelope<Mandate>;
  action: SignedEnvelope<ProposedAction>;
  effect: TransferEffect;
  policy: SignedEnvelope<PolicyArtifact>;
  interpreter: SignedEnvelope<InterpreterDescriptor>;
  decision_input: SignedEnvelope<DecisionInputSnapshot>;
  decision: SignedEnvelope<AuthorizationDecision>;
  step_up_approval: SignedEnvelope<StepUpApproval> | null;
  ledger_observation: SignedEnvelope<LedgerObservation>;
  state_path: ProtocolState[];
  closed_at: Timestamp;
}

export type NegativeClosureProof = SignedEnvelope<NegativeClosureProofBody>;
export type AnyClosureProof = ClosureProof | NegativeClosureProof;

export type ProtocolObject =
  | TrustRootManifest
  | TrustStore
  | Mandate
  | ProposedAction
  | TransferEffect
  | PolicyArtifact
  | InterpreterDescriptor
  | DecisionInputSnapshot
  | AuthorizationDecision
  | StepUpApproval
  | ExecutionCapsule
  | ConsumptionRecord
  | ExecutionReceipt
  | LedgerObservation
  | ClosureProofBody
  | NegativeClosureProofBody;

export interface ValidationIssue {
  object_type: SchemaObjectType | "Unknown";
  path: string;
  keyword: string;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; issues: readonly ValidationIssue[] };

export type ClosureFailureCode =
  | "TRUST_STORE_SCHEMA_INVALID"
  | "PROOF_SCHEMA_INVALID"
  | "TRUST_ROOT_NOT_TRUSTED"
  | "TRUST_MANIFEST_BINDING_INVALID"
  | "TRUST_MANIFEST_SIGNATURE_INVALID"
  | "MANIFEST_PIN_MISMATCH"
  | "ASSURANCE_PROFILE_MISMATCH"
  | "AUTHORITY_BINDING_INVALID"
  | "SIGNATURE_ORDER_INVALID"
  | "SIGNATURE_INVALID"
  | "MANDATE_SCOPE_INVALID"
  | "AUTHORIZATION_TIME_INVALID"
  | "OBJECT_HASH_LINK_INVALID"
  | "POLICY_UNSUPPORTED"
  | "INTERPRETER_UNSUPPORTED"
  | "DECISION_REPLAY_MISMATCH"
  | "DECISION_NOT_ALLOWED"
  | "EFFECT_MISMATCH"
  | "CAPSULE_LINK_INVALID"
  | "CAPSULE_TIME_INVALID"
  | "CONSUMPTION_CARDINALITY_INVALID"
  | "CONSUMPTION_LINK_INVALID"
  | "RECEIPT_LINK_INVALID"
  | "LEDGER_OBSERVATION_INVALID"
  | "STATE_PATH_INVALID"
  | "CLOSURE_TIME_INVALID"
  | "SEPARATION_FAILURE"
  | "STEP_UP_MISSING"
  | "MANDATE_REVOKED"
  | "SIDE_EFFECT_PRESENT"
  | "STALE_TRUST_HEAD"
  | "KEY_REVOKED"
  | "UNKNOWN_KEY"
  | "PROOF_LIMIT_EXCEEDED"
  | "INTERNAL_VERIFICATION_ERROR";

export type ClosureKind = "success" | "negative";

export type ClosureVerificationResult =
  | {
      valid: true;
      code: "VALID";
      proof_id: string;
      closure_kind: ClosureKind;
      manifest_hash: HashString;
      receipt_body_hash: HashString | null;
      effect_hash: HashString | null;
    }
  | {
      valid: false;
      code: ClosureFailureCode;
      path: string;
      message: string;
    };
