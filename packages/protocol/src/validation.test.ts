import { describe, expect, it } from "vitest";
import { createSyntheticClosureFixture } from "./testing.js";
import { mapValidatorIssues, resolveModuleConstructor, validateObject } from "./validation.js";

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

  it("maps missing required fields and empty validator errors", () => {
    const result = validateObject("Signature", {});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path.includes("role") || issue.keyword === "required")).toBe(true);
    }
    expect(mapValidatorIssues("Signature", undefined)).toEqual([]);
    expect(
      mapValidatorIssues("Signature", [
        {
          instancePath: "",
          schemaPath: "#/required",
          keyword: "required",
          params: { missingProperty: "role" },
          message: undefined,
        },
      ]),
    ).toMatchObject([{ path: "/role", message: "schema validation failed" }]);
    expect(
      mapValidatorIssues("Signature", [
        {
          instancePath: "",
          schemaPath: "#/type",
          keyword: "type",
          params: {},
          message: "bad type",
        },
      ]),
    ).toMatchObject([{ path: "/" }]);
    expect(resolveModuleConstructor({ default: Array })).toBe(Array);
    expect(resolveModuleConstructor(Array)).toBe(Array);
  });
});
