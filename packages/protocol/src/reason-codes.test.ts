import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_EXIT_BY_REASON,
  CLOSURE_FAILURE_CODES,
  EVALUATOR_CODE_TO_REASON,
  FAILURE_CODE_TO_REASON,
  HTTP_STATUS_BY_REASON,
  PROTOCOL_REASON_CODES,
  cliExitForReason,
  httpStatusForReason,
  isProtocolReasonCode,
  toProtocolReasonCode,
} from "./reason-codes.js";

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/reason-codes.json"), "utf8"),
) as Record<string, { http_status: number; cli_exit: number; source: string }>;

describe("closed reason-code matrix", () => {
  it("keeps fixture, HTTP, and CLI keysets equal to the closed union", () => {
    const closed = [...PROTOCOL_REASON_CODES].sort();
    expect(Object.keys(HTTP_STATUS_BY_REASON).sort()).toEqual(closed);
    expect(Object.keys(CLI_EXIT_BY_REASON).sort()).toEqual(closed);
    expect(Object.keys(FIXTURE).sort()).toEqual(closed);
    for (const code of PROTOCOL_REASON_CODES) {
      expect(FIXTURE[code]?.http_status).toBe(HTTP_STATUS_BY_REASON[code]);
      expect(FIXTURE[code]?.cli_exit).toBe(CLI_EXIT_BY_REASON[code]);
      expect(httpStatusForReason(code)).toBe(FIXTURE[code]?.http_status);
      expect(cliExitForReason(code)).toBe(FIXTURE[code]?.cli_exit);
    }
  });

  it("maps every verifier failure code onto the closed union", () => {
    expect(Object.keys(FAILURE_CODE_TO_REASON).sort()).toEqual([...CLOSURE_FAILURE_CODES].sort());
    for (const code of CLOSURE_FAILURE_CODES) {
      expect(isProtocolReasonCode(FAILURE_CODE_TO_REASON[code])).toBe(true);
    }
  });

  it("maps evaluator denials onto POLICY_DENY or OUT_OF_SCOPE", () => {
    expect(toProtocolReasonCode("INSUFFICIENT_SPENDABLE_FUNDS")).toBe("POLICY_DENY");
    expect(toProtocolReasonCode("CROSS_CUSTOMER_TRANSFER")).toBe("OUT_OF_SCOPE");
    expect(toProtocolReasonCode("STEP_UP_REQUIRED")).toBe("STEP_UP_REQUIRED");
    expect(Object.values(EVALUATOR_CODE_TO_REASON)).toEqual(
      expect.arrayContaining(["POLICY_DENY", "OUT_OF_SCOPE", "STEP_UP_REQUIRED"]),
    );
  });

  it("special-cases a ledger signature path as INVALID_LEDGER_SIGNATURE", () => {
    expect(toProtocolReasonCode("SIGNATURE_INVALID", "/body/ledger_observation/signatures")).toBe(
      "INVALID_LEDGER_SIGNATURE",
    );
    expect(toProtocolReasonCode("SIGNATURE_INVALID", "/body/mandate/signatures")).toBe("INVALID_SIGNATURE");
    expect(toProtocolReasonCode("STALE_TRUST_HEAD")).toBe("STALE_TRUST_HEAD");
    expect(toProtocolReasonCode("not-a-reason")).toBeUndefined();
    expect(isProtocolReasonCode("VALID")).toBe(false);
  });
});
