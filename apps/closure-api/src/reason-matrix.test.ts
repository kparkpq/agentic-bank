import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HTTP_STATUS_BY_REASON,
  PROTOCOL_REASON_CODES,
  isProtocolReasonCode,
} from "@execution-closure/protocol";

const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../packages/protocol/fixtures/reason-codes.json"),
    "utf8",
  ),
) as Record<string, { http_status: number }>;

const LIVE_HTTP_REASONS = {
  IDEMPOTENCY_CONFLICT: 409,
  CLOCK_ROLLBACK: 422,
  MANDATE_EXPIRED: 422,
  MANDATE_REVOKED: 422,
  OUT_OF_SCOPE: 422,
  POLICY_DENY: 422,
  STEP_UP_REQUIRED: 202,
  SEPARATION_FAILURE: 422,
  CAPSULE_REUSED: 409,
  EXECUTION_UNKNOWN: 202,
} as const;

describe("HTTP reason-code matrix", () => {
  it("uses the closed protocol table for every live protocol reason", () => {
    expect(Object.keys(HTTP_STATUS_BY_REASON).sort()).toEqual([...PROTOCOL_REASON_CODES].sort());
    for (const [code, status] of Object.entries(LIVE_HTTP_REASONS)) {
      expect(isProtocolReasonCode(code)).toBe(true);
      if (isProtocolReasonCode(code)) {
        expect(HTTP_STATUS_BY_REASON[code]).toBe(status);
        expect(FIXTURE[code]?.http_status).toBe(status);
      }
    }
  });
});
