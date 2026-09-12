import type { ProtocolState } from "./types.js";

export const SUCCESSFUL_STATE_PATH = Object.freeze([
  "PROPOSED",
  "AUTHORIZED",
  "EXECUTION_INTENT_RECORDED",
  "EXECUTED",
  "CLOSED",
] as const satisfies readonly ProtocolState[]);

function states(...values: ProtocolState[]): readonly ProtocolState[] {
  return Object.freeze(values);
}

export const LEGAL_STATE_TRANSITIONS = Object.freeze({
  PROPOSED: states("AUTHORIZED", "AUTHORIZATION_DENIED", "CANCELLED", "EXPIRED"),
  AUTHORIZED: states("EXECUTION_INTENT_RECORDED", "CANCELLED", "EXPIRED"),
  AUTHORIZATION_DENIED: states("CLOSED"),
  EXECUTION_INTENT_RECORDED: states("EXECUTED", "EXECUTION_FAILED", "EXPIRED"),
  EXECUTED: states("CLOSED"),
  EXECUTION_FAILED: states("CLOSED"),
  CANCELLED: states("CLOSED"),
  EXPIRED: states("CLOSED"),
  CLOSED: states(),
}) satisfies Readonly<Record<ProtocolState, readonly ProtocolState[]>>;

export function isLegalStateTransition(from: ProtocolState, to: ProtocolState): boolean {
  return LEGAL_STATE_TRANSITIONS[from].includes(to);
}

export function isLegalStatePath(path: readonly ProtocolState[]): boolean {
  return path.length > 0 && path.slice(1).every((state, index) => isLegalStateTransition(path[index]!, state));
}

export function isSuccessfulStatePath(path: readonly ProtocolState[]): boolean {
  return (
    path.length === SUCCESSFUL_STATE_PATH.length &&
    isLegalStatePath(path) &&
    path.every((state, index) => state === SUCCESSFUL_STATE_PATH[index])
  );
}
