import { describe, expect, it } from "vitest";
import { createSyntheticClosureFixture } from "./testing.js";
import { validateObject } from "./validation.js";

describe("schema validation", () => {
  const fixture = createSyntheticClosureFixture();

  it("accepts the synthetic fixture objects", () => {
    expect(validateObject("TrustStore", fixture.trust_store).valid).toBe(true);
    expect(validateObject("ClosureProof", fixture.proof).valid).toBe(true);
    expect(validateObject("Mandate", fixture.proof.body.mandate.body).valid).toBe(true);
    expect(validateObject("TransferEffect", fixture.proof.body.effect).valid).toBe(true);
    expect(validateObject("SignedEnvelope", fixture.proof.body.action).valid).toBe(true);
  });

  it("rejects invalid timestamps, identifiers, and integer strings", () => {
    const mandate = {
      ...fixture.proof.body.mandate.body,
      issued_at: "2026-01-01T00:00:00Z",
      max_amount: "01",
      from_account_id: "acc\u0001",
    };
    const result = validateObject("Mandate", mandate);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path.includes("issued_at") || issue.path.includes("max_amount"))).toBe(
        true,
      );
    }
    expect(validateObject("UnknownType", {}).valid).toBe(false);
  });
});
