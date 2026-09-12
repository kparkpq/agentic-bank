import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalizeJson, compareUtf8, concatenateBytes, utf8Bytes } from "./canonical.js";

describe("canonical JSON", () => {
  it("sorts object keys and keeps array order", () => {
    expect(canonicalizeJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });

  it("rejects cyclic values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(/cyclic reference/);
  });

  it("rejects lone surrogates and non-finite numbers", () => {
    expect(() => canonicalizeJson("\uD800")).toThrow(/surrogate/);
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("compares UTF-8 bytes in order", () => {
    expect(compareUtf8("a", "b")).toBeLessThan(0);
    expect(compareUtf8("ab", "ab")).toBe(0);
    expect(compareUtf8("abc", "ab")).toBeGreaterThan(0);
  });

  it("concatenates byte arrays", () => {
    expect(Array.from(concatenateBytes(utf8Bytes("ec"), utf8Bytes("-v0")))).toEqual(
      Array.from(utf8Bytes("ec-v0")),
    );
  });

  it("matches the committed Python interop vector", () => {
    const vector = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/interop-vector.json"), "utf8"),
    ) as { object: unknown; expected_canonical: string; expected_sha256_hex: string };
    const canonical = canonicalizeJson(vector.object);
    expect(canonical).toBe(vector.expected_canonical);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(vector.expected_sha256_hex);
  });
});
