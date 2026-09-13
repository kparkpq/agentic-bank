import { describe, expect, it } from "vitest";
import { encodedJsonBytes, jsonDepth, proofExceedsLimits } from "./limits.js";
import { createSyntheticClosureFixture } from "./testing.js";

describe("proof limits", () => {
  it("accepts empty objects and rejects depth and range overflows", () => {
    expect(jsonDepth({})).toBe(1);
    expect(jsonDepth([])).toBe(1);
    expect(encodedJsonBytes({ a: 1 })).toBeGreaterThan(0);
    const fixture = createSyntheticClosureFixture();
    expect(proofExceedsLimits(fixture.proof, fixture.trust_store)).toBeUndefined();

    let nested: unknown = "leaf";
    for (let index = 0; index < 40; index += 1) nested = { nested };
    expect(proofExceedsLimits(nested, {})).toMatch(/depth/);

    const ranged = structuredClone(fixture.proof);
    ranged.body.consumption_records = Array.from({ length: 9 }, () => ranged.body.consumption_records[0]!);
    expect(proofExceedsLimits(ranged, fixture.trust_store)).toMatch(/range-entry/);
  });
});
