import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSignedEnvelope,
  decodeBase64Url,
  encodeBase64Url,
  exportPublicKey,
  hashSignedObjectBody,
  hashTransferEffect,
  signaturesAreSorted,
  verifyObjectSignature,
} from "./crypto.js";
import { PROTOCOL_VERSION, SCHEMA_VERSION, type TransferEffect } from "./types.js";

describe("crypto helpers", () => {
  it("round-trips canonical base64url", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(Array.from(decodeBase64Url(encodeBase64Url(bytes)))).toEqual([1, 2, 3, 4]);
    expect(() => decodeBase64Url("+++")).toThrow(/invalid base64url/);
  });

  it("signs and verifies a pinned object", () => {
    const pair = generateKeyPairSync("ed25519");
    const body = {
      object_type: "Mandate" as const,
      protocol_version: PROTOCOL_VERSION,
      schema_version: SCHEMA_VERSION,
      issuer: "issuer",
      key_id: "key",
      issued_at: "2026-01-01T00:00:00.000Z",
      manifest_version: "1",
      manifest_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      trust_epoch: "1",
      mandate_id: "m1",
      customer_id: "c1",
      agent_id: "a1",
      from_account_id: "from",
      to_account_id: "to",
      currency: "KRW" as const,
      max_amount: "1",
      not_before: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-01T01:00:00.000Z",
    };
    const envelope = createSignedEnvelope(body, [
      { role: "mandate_authority", issuer: "issuer", key_id: "key", private_key: pair.privateKey },
    ]);
    expect(signaturesAreSorted(envelope.signatures)).toBe(true);
    expect(verifyObjectSignature(body, envelope.signatures[0]!, exportPublicKey(pair.publicKey))).toBe(true);
    expect(hashSignedObjectBody(body)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("sorts signatures by role, key, issuer, then signature and rejects bad keys", () => {
    const pair = generateKeyPairSync("ed25519");
    const body = {
      object_type: "Mandate" as const,
      protocol_version: PROTOCOL_VERSION,
      schema_version: SCHEMA_VERSION,
      issuer: "issuer",
      key_id: "key",
      issued_at: "2026-01-01T00:00:00.000Z",
      manifest_version: "1",
      manifest_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      trust_epoch: "1",
      mandate_id: "m1",
      customer_id: "c1",
      agent_id: "a1",
      from_account_id: "from",
      to_account_id: "to",
      currency: "KRW" as const,
      max_amount: "1",
      not_before: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-01T01:00:00.000Z",
    };
    const first = {
      role: "executor" as const,
      issuer: "b",
      key_id: "k2",
      algorithm: "Ed25519" as const,
      signature: "b",
    };
    const second = { ...first, issuer: "a", signature: "a" };
    const third = { ...first, key_id: "k1" };
    expect(signaturesAreSorted([first, third])).toBe(false);
    expect(signaturesAreSorted([second, { ...second, signature: "c" }])).toBe(true);
    expect(exportPublicKey(pair.publicKey)).toEqual(exportPublicKey(pair.privateKey));
    expect(
      verifyObjectSignature(body, { ...first, signature: "%%%%" }, exportPublicKey(pair.publicKey)),
    ).toBe(false);
    expect(() => decodeBase64Url("A")).toThrow(/invalid base64url/);
    expect(() => decodeBase64Url("+++")).toThrow(/invalid base64url/);
    expect(() => decodeBase64Url("aa")).toThrow(/non-canonical/);
  });

  it("hashes transfer effects in a dedicated domain", () => {
    const effect: TransferEffect = {
      object_type: "TransferEffect",
      protocol_version: PROTOCOL_VERSION,
      schema_version: SCHEMA_VERSION,
      action_id: "a1",
      from_account_id: "from",
      to_account_id: "to",
      currency: "KRW",
      amount: "100000",
    };
    expect(hashTransferEffect(effect)).not.toBe(hashSignedObjectBody({ ...effect, object_type: "Mandate" } as never));
  });
});
