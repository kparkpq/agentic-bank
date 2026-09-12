import {
  createHash,
  createPublicKey,
  KeyObject,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyLike,
} from "node:crypto";
import {
  canonicalJsonBytes,
  compareUtf8,
  concatenateBytes,
  utf8Bytes,
} from "./canonical.js";
import type {
  SchemaVersion,
  Signature,
  SignatureInput,
  SignedEnvelope,
  SignedObjectType,
  TransferEffect,
} from "./types.js";

export const TRANSFER_EFFECT_HASH_DOMAIN = "EC-v0/transfer-effect\u0000" as const;

export interface SignableObject {
  object_type: SignedObjectType;
  schema_version: SchemaVersion;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("invalid base64url encoding");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new TypeError("non-canonical base64url encoding");
  }
  return new Uint8Array(decoded);
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

export function hashDomainSeparatedJson(domain: string, value: unknown): string {
  return hashBytes(concatenateBytes(utf8Bytes(domain), canonicalJsonBytes(value)));
}

export function signedObjectBytes(body: SignableObject): Uint8Array {
  const domain = `EC-v0/${body.object_type}/${body.schema_version}\u0000`;
  return concatenateBytes(utf8Bytes(domain), canonicalJsonBytes(body));
}

export function hashSignedObjectBody(body: SignableObject): string {
  return hashBytes(signedObjectBytes(body));
}

export function hashTransferEffect(effect: TransferEffect): string {
  return hashDomainSeparatedJson(TRANSFER_EFFECT_HASH_DOMAIN, effect);
}

function compareSignatures(left: Signature, right: Signature): number {
  return (
    compareUtf8(left.role, right.role) ||
    compareUtf8(left.key_id, right.key_id) ||
    compareUtf8(left.issuer, right.issuer) ||
    compareUtf8(left.signature, right.signature)
  );
}

export function sortSignatures(signatures: readonly Signature[]): Signature[] {
  return [...signatures].sort(compareSignatures);
}

export function signaturesAreSorted(signatures: readonly Signature[]): boolean {
  return signatures.every(
    (signature, index) => index === 0 || compareSignatures(signatures[index - 1]!, signature) <= 0,
  );
}

export function signObject(body: SignableObject, input: SignatureInput): Signature {
  return {
    role: input.role,
    issuer: input.issuer,
    key_id: input.key_id,
    algorithm: "Ed25519",
    signature: encodeBase64Url(ed25519Sign(null, signedObjectBytes(body), input.private_key)),
  };
}

export function createSignedEnvelope<T extends SignableObject>(
  body: T,
  signatureInputs: readonly SignatureInput[],
): SignedEnvelope<T> {
  return {
    body,
    signatures: sortSignatures(signatureInputs.map((input) => signObject(body, input))),
  };
}

export function verifyObjectSignature(
  body: SignableObject,
  signature: Signature,
  publicKey: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(decodeBase64Url(publicKey)),
      format: "der",
      type: "spki",
    });
    return ed25519Verify(null, signedObjectBytes(body), key, decodeBase64Url(signature.signature));
  } catch {
    return false;
  }
}

export function exportPublicKey(publicOrPrivateKey: KeyLike): string {
  const publicKey =
    publicOrPrivateKey instanceof KeyObject && publicOrPrivateKey.type === "public"
      ? publicOrPrivateKey
      : createPublicKey(publicOrPrivateKey);
  return encodeBase64Url(publicKey.export({ format: "der", type: "spki" }));
}
