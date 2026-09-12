import canonicalize from "canonicalize";
import type { JsonValue } from "./types.js";

const encoder = new TextEncoder();

export function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function reject(path: string, reason: string): never {
  throw new TypeError(`unsupported JSON value at ${path}: ${reason}`);
}

function assertJsonValueAt(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    if (!hasOnlyUnicodeScalarValues(value)) {
      reject(path, "lone Unicode surrogate");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      reject(path, "non-finite number");
    }
    return;
  }
  if (typeof value !== "object") {
    reject(path, typeof value);
  }
  if (ancestors.has(value)) {
    reject(path, "cyclic reference");
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        reject(`${path}/${index}`, "sparse array entry");
      }
      assertJsonValueAt(value[index], `${path}/${index}`, ancestors);
    }
  } else {
    for (const key of Object.keys(value).sort()) {
      if (!hasOnlyUnicodeScalarValues(key)) {
        reject(`${path}/${pathToken(key)}`, "lone Unicode surrogate in key");
      }
      assertJsonValueAt(
        (value as Record<string, unknown>)[key],
        `${path}/${pathToken(key)}`,
        ancestors,
      );
    }
  }
  ancestors.delete(value);
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueAt(value, "", new Set());
}

export function canonicalizeJson(value: unknown): string {
  assertJsonValue(value);
  const encoded = canonicalize(value);
  if (typeof encoded !== "string") {
    throw new TypeError("unable to canonicalize JSON value");
  }
  return encoded;
}

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8Bytes(canonicalizeJson(value));
}

export function concatenateBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Bytes(left);
  const rightBytes = utf8Bytes(right);
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < limit; index += 1) {
    const delta = leftBytes[index]! - rightBytes[index]!;
    if (delta !== 0) return delta;
  }
  return leftBytes.length - rightBytes.length;
}
