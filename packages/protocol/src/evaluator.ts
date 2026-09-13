import {
  KRW_TRANSFER_EVALUATOR_VERSION,
  KRW_TRANSFER_INTERPRETER,
  KRW_TRANSFER_POLICY,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type DecisionInputSnapshot,
  type EvaluatorReasonCode,
  type InterpreterDescriptor,
  type Mandate,
  type PolicyArtifact,
  type ProposedAction,
  type TransferEffect,
} from "./types.js";

export interface EvaluatorResult {
  outcome: "ALLOW" | "DENY" | "STEP_UP";
  reason_code: EvaluatorReasonCode;
}

function deny(reasonCode: Exclude<EvaluatorReasonCode, "POLICY_ALLOW" | "STEP_UP_REQUIRED">) {
  return {
    outcome: "DENY",
    reason_code: reasonCode,
  } as const;
}

function stepUp() {
  return {
    outcome: "STEP_UP",
    reason_code: "STEP_UP_REQUIRED",
  } as const;
}

export function isKrwTransferDescriptorCompatible(descriptor: InterpreterDescriptor): boolean {
  return (
    descriptor.interpreter_id === KRW_TRANSFER_INTERPRETER &&
    descriptor.interpreter_version === KRW_TRANSFER_EVALUATOR_VERSION &&
    descriptor.policy_type === KRW_TRANSFER_POLICY &&
    descriptor.supported_protocol_version === PROTOCOL_VERSION &&
    descriptor.supported_schema_version === SCHEMA_VERSION
  );
}

export function isActionWithinMandate(mandate: Mandate, action: ProposedAction): boolean {
  return (
    action.mandate_id === mandate.mandate_id &&
    action.customer_id === mandate.customer_id &&
    action.agent_id === mandate.agent_id &&
    action.transfer.from_account_id === mandate.from_account_id &&
    action.transfer.to_account_id === mandate.to_account_id &&
    action.transfer.currency === mandate.currency &&
    BigInt(action.transfer.amount) <= BigInt(mandate.max_amount)
  );
}

export function isMandateValidAtAuthorization(
  mandate: Mandate,
  action: ProposedAction,
  authorizedAt: string,
): boolean {
  const authorizationTime = Date.parse(authorizedAt);
  return (
    Date.parse(mandate.issued_at) <= authorizationTime &&
    Date.parse(mandate.not_before) <= authorizationTime &&
    authorizationTime < Date.parse(mandate.expires_at) &&
    Date.parse(action.issued_at) <= authorizationTime
  );
}

export function deriveTransferEffect(action: ProposedAction): TransferEffect {
  return {
    object_type: "TransferEffect",
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    action_id: action.action_id,
    from_account_id: action.transfer.from_account_id,
    to_account_id: action.transfer.to_account_id,
    currency: "KRW",
    amount: action.transfer.amount,
  };
}

export function evaluateKrwTransfer(
  mandate: Mandate,
  action: ProposedAction,
  policy: PolicyArtifact,
  snapshot: DecisionInputSnapshot,
): EvaluatorResult {
  if (snapshot.from_account_status !== "OPEN") {
    return deny("SOURCE_ACCOUNT_NOT_OPEN");
  }
  if (snapshot.to_account_status !== "OPEN") {
    return deny("DESTINATION_ACCOUNT_NOT_OPEN");
  }
  if (snapshot.from_owner_customer_id !== mandate.customer_id) {
    return deny("SENDER_OWNERSHIP_MISMATCH");
  }

  const amount = BigInt(action.transfer.amount);
  if (BigInt(snapshot.spendable_funds) < amount) {
    return deny("INSUFFICIENT_SPENDABLE_FUNDS");
  }
  if (BigInt(snapshot.daily_spent) + amount > BigInt(policy.daily_cap)) {
    return deny("DAILY_CAP_EXCEEDED");
  }
  if (snapshot.from_owner_customer_id !== snapshot.to_owner_customer_id) {
    return deny("CROSS_CUSTOMER_TRANSFER");
  }
  if (amount >= BigInt(policy.step_up_threshold)) {
    return stepUp();
  }
  return {
    outcome: "ALLOW",
    reason_code: "POLICY_ALLOW",
  };
}
