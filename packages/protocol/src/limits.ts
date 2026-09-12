export const PROOF_LIMITS = Object.freeze({
  max_bytes: 1_048_576,
  max_depth: 32,
  max_range_entries: 8,
});

export function jsonDepth(value: unknown, depth = 1): number {
  if (value === null || typeof value !== "object") return depth;
  const next = Array.isArray(value) ? value : Object.values(value);
  if (next.length === 0) return depth;
  return Math.max(...next.map((child) => jsonDepth(child, depth + 1)));
}

export function encodedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function proofExceedsLimits(proof: unknown, trustStore: unknown): string | undefined {
  const bytes = encodedJsonBytes(proof) + encodedJsonBytes(trustStore);
  if (bytes > PROOF_LIMITS.max_bytes) return "proof exceeds the versioned byte limit";
  if (jsonDepth(proof) > PROOF_LIMITS.max_depth || jsonDepth(trustStore) > PROOF_LIMITS.max_depth) {
    return "proof exceeds the versioned JSON depth limit";
  }
  const records = (proof as { body?: { consumption_records?: unknown[] } } | null)?.body?.consumption_records;
  if (Array.isArray(records) && records.length > PROOF_LIMITS.max_range_entries) {
    return "proof exceeds the versioned range-entry limit";
  }
  return undefined;
}
