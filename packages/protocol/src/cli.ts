import { canonicalizeJson } from "./canonical.js";
import type { ClosureVerificationResult } from "./types.js";
import { verifyClosureProof } from "./verify.js";

export type CliVerificationResult =
  | ClosureVerificationResult
  | {
      valid: false;
      code: "CLI_INPUT_ERROR";
      path: "/";
      message: "proof and trust-store files must contain valid JSON";
    };

export function verifyJsonDocuments(proofJson: string, trustStoreJson: string): CliVerificationResult {
  try {
    return verifyClosureProof(JSON.parse(proofJson) as unknown, JSON.parse(trustStoreJson) as unknown);
  } catch {
    return {
      valid: false,
      code: "CLI_INPUT_ERROR",
      path: "/",
      message: "proof and trust-store files must contain valid JSON",
    };
  }
}

export function formatCliResult(result: CliVerificationResult): string {
  return `${canonicalizeJson(result)}\n`;
}
