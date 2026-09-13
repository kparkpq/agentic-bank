import { describe, expect, it } from "vitest";
import {
  deriveTransferEffect,
  evaluateKrwTransfer,
  isActionWithinMandate,
  isKrwTransferDescriptorCompatible,
  isMandateValidAtAuthorization,
} from "./evaluator.js";
import {
  isLegalStatePath,
  isNegativeClosedPath,
  isSuccessfulStatePath,
  isSuccessfulStepUpStatePath,
  SUCCESSFUL_STATE_PATH,
  SUCCESSFUL_STEP_UP_STATE_PATH,
} from "./state.js";
import { createSyntheticClosureFixture } from "./testing.js";

describe("evaluator and state", () => {
  const fixture = createSyntheticClosureFixture();
  const mandate = fixture.proof.body.mandate.body;
  const action = fixture.proof.body.action.body;
  const policy = fixture.proof.body.policy.body;
  const snapshot = fixture.proof.body.decision_input.body;
  const interpreter = fixture.proof.body.interpreter.body;

  it("accepts the Stage 1 happy-path action", () => {
    expect(isActionWithinMandate(mandate, action)).toBe(true);
    expect(isMandateValidAtAuthorization(mandate, action, fixture.proof.body.decision.body.authorized_at)).toBe(true);
    expect(isKrwTransferDescriptorCompatible(interpreter)).toBe(true);
    expect(evaluateKrwTransfer(mandate, action, policy, snapshot)).toEqual({
      outcome: "ALLOW",
      reason_code: "POLICY_ALLOW",
    });
    expect(deriveTransferEffect(action).amount).toBe("100000");
  });

  it("denies known policy reasons", () => {
    expect(evaluateKrwTransfer(mandate, action, policy, { ...snapshot, from_account_status: "FROZEN" }).reason_code).toBe(
      "SOURCE_ACCOUNT_NOT_OPEN",
    );
    expect(evaluateKrwTransfer(mandate, action, policy, { ...snapshot, to_account_status: "CLOSED" }).reason_code).toBe(
      "DESTINATION_ACCOUNT_NOT_OPEN",
    );
    expect(
      evaluateKrwTransfer(mandate, action, policy, { ...snapshot, from_owner_customer_id: "other" }).reason_code,
    ).toBe("SENDER_OWNERSHIP_MISMATCH");
    expect(evaluateKrwTransfer(mandate, action, policy, { ...snapshot, spendable_funds: "1" }).reason_code).toBe(
      "INSUFFICIENT_SPENDABLE_FUNDS",
    );
    expect(evaluateKrwTransfer(mandate, action, policy, { ...snapshot, daily_spent: "1000000" }).reason_code).toBe(
      "DAILY_CAP_EXCEEDED",
    );
    expect(
      evaluateKrwTransfer(mandate, action, policy, { ...snapshot, to_owner_customer_id: "other" }).reason_code,
    ).toBe("CROSS_CUSTOMER_TRANSFER");
    expect(
      evaluateKrwTransfer(mandate, { ...action, transfer: { ...action.transfer, amount: "500000" } }, policy, snapshot),
    ).toEqual({
      outcome: "STEP_UP",
      reason_code: "STEP_UP_REQUIRED",
    });
  });

  it("rejects actions outside mandate scope or time", () => {
    expect(isActionWithinMandate(mandate, { ...action, customer_id: "other" })).toBe(false);
    expect(isMandateValidAtAuthorization(mandate, action, "2026-01-01T02:00:00.000Z")).toBe(false);
  });

  it("accepts the exact ALLOW and step-up success paths", () => {
    expect(isSuccessfulStatePath([...SUCCESSFUL_STATE_PATH])).toBe(true);
    expect(isSuccessfulStatePath([...SUCCESSFUL_STEP_UP_STATE_PATH])).toBe(true);
    expect(isLegalStatePath(["PROPOSED", "AUTHORIZATION_DENIED", "CLOSED"])).toBe(true);
    expect(isLegalStatePath(["PROPOSED", "STEP_UP_REQUIRED", "APPROVED", "EXECUTION_INTENT_RECORDED", "EXECUTED", "CLOSED"])).toBe(
      true,
    );
    expect(isLegalStatePath(["PROPOSED", "AUTHORIZED", "REVOKED", "CLOSED"])).toBe(true);
    expect(
      isLegalStatePath([
        "PROPOSED",
        "AUTHORIZED",
        "EXECUTION_INTENT_RECORDED",
        "EXECUTION_UNKNOWN",
        "EXECUTED",
        "CLOSED",
      ]),
    ).toBe(true);
    expect(isSuccessfulStatePath(["PROPOSED", "AUTHORIZATION_DENIED", "CLOSED"])).toBe(false);
    expect(isNegativeClosedPath(["PROPOSED", "AUTHORIZATION_DENIED", "CLOSED"], "AUTHORIZATION_DENIED")).toBe(true);
    expect(isNegativeClosedPath(["PROPOSED", "AUTHORIZATION_DENIED", "CLOSED"], "REVOKED")).toBe(false);
    expect(isSuccessfulStepUpStatePath([...SUCCESSFUL_STATE_PATH])).toBe(false);
    expect(isLegalStatePath(["CLOSED", "PROPOSED"])).toBe(false);
    expect(isKrwTransferDescriptorCompatible({ ...interpreter, interpreter_id: "other" as typeof interpreter.interpreter_id })).toBe(false);
  });
});
