import type { NegativeTerminalReason, ProtocolState } from "./types.js";

export const SUCCESSFUL_STATE_PATH = Object.freeze([
  "PROPOSED",
  "AUTHORIZED",
  "EXECUTION_INTENT_RECORDED",
  "EXECUTED",
  "CLOSED",
] as const satisfies readonly ProtocolState[]);

export const SUCCESSFUL_STEP_UP_STATE_PATH = Object.freeze([
  "PROPOSED",
  "STEP_UP_REQUIRED",
  "APPROVED",
  "EXECUTION_INTENT_RECORDED",
  "EXECUTED",
  "CLOSED",
] as const satisfies readonly ProtocolState[]);

function states(...values: ProtocolState[]): readonly ProtocolState[] {
  return Object.freeze(values);
}

export const LEGAL_STATE_TRANSITIONS = Object.freeze({
  PROPOSED: states("AUTHORIZED", "AUTHORIZATION_DENIED", "STEP_UP_REQUIRED", "CANCELLED", "EXPIRED", "REVOKED"),
  AUTHORIZED: states("EXECUTION_INTENT_RECORDED", "CANCELLED", "EXPIRED", "REVOKED"),
  AUTHORIZATION_DENIED: states("CLOSED"),
  STEP_UP_REQUIRED: states("APPROVED", "AUTHORIZATION_DENIED", "EXPIRED", "REVOKED"),
  APPROVED: states("EXECUTION_INTENT_RECORDED", "CANCELLED", "EXPIRED", "REVOKED"),
  EXECUTION_INTENT_RECORDED: states("EXECUTED", "EXECUTION_FAILED", "EXECUTION_UNKNOWN"),
  EXECUTION_UNKNOWN: states("EXECUTED", "EXECUTION_FAILED"),
  EXECUTED: states("CLOSED"),
  EXECUTION_FAILED: states("CLOSED"),
  CANCELLED: states("CLOSED"),
  EXPIRED: states("CLOSED"),
  REVOKED: states("CLOSED"),
  CLOSED: states(),
}) satisfies Readonly<Record<ProtocolState, readonly ProtocolState[]>>;

export function isLegalStateTransition(from: ProtocolState, to: ProtocolState): boolean {
  return LEGAL_STATE_TRANSITIONS[from].includes(to);
}

export function isLegalStatePath(path: readonly ProtocolState[]): boolean {
  return path.length > 0 && path.slice(1).every((state, index) => isLegalStateTransition(path[index]!, state));
}

function matchesPath(path: readonly ProtocolState[], expected: readonly ProtocolState[]): boolean {
  return path.length === expected.length && path.every((state, index) => state === expected[index]);
}

export function isSuccessfulStatePath(path: readonly ProtocolState[]): boolean {
  return (
    isLegalStatePath(path) &&
    (matchesPath(path, SUCCESSFUL_STATE_PATH) || matchesPath(path, SUCCESSFUL_STEP_UP_STATE_PATH))
  );
}

export function isSuccessfulStepUpStatePath(path: readonly ProtocolState[]): boolean {
  return isLegalStatePath(path) && matchesPath(path, SUCCESSFUL_STEP_UP_STATE_PATH);
}

export function isNegativeClosedPath(
  path: readonly ProtocolState[],
  terminalReason: NegativeTerminalReason,
): boolean {
  return (
    isLegalStatePath(path) &&
    path[0] === "PROPOSED" &&
    path[path.length - 1] === "CLOSED" &&
    path.includes(terminalReason) &&
    !isSuccessfulStatePath(path)
  );
}
