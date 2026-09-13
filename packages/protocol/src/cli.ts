import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJson } from "./canonical.js";
import { CLI_EXIT_BY_REASON, toProtocolReasonCode } from "./reason-codes.js";
import type { ClosureVerificationResult } from "./types.js";
import { verifyClosureProof } from "./verify.js";

export type CliInputErrorCode = "CLI_INPUT_ERROR" | "CLI_USAGE_ERROR" | "CLI_FILE_ERROR" | "MISSING_SCHEMA";

export type CliVerificationResult =
  | ClosureVerificationResult
  | {
      valid: false;
      code: CliInputErrorCode;
      path: string;
      message: string;
    };

export function schemaArtifactPath(fromUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(fromUrl)), "../schemas/ec-v0.schema.json");
}

export function missingSchemaResult(schemaPath = schemaArtifactPath()): CliVerificationResult | undefined {
  if (existsSync(schemaPath)) return undefined;
  return {
    valid: false,
    code: "MISSING_SCHEMA",
    path: "/schemas/ec-v0.schema.json",
    message: "MISSING_SCHEMA: schemas/ec-v0.schema.json is not packaged",
  };
}

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

export function cliExitCode(result: CliVerificationResult): 0 | 1 | 2 {
  if (result.valid) return 0;
  if (
    result.code === "CLI_INPUT_ERROR" ||
    result.code === "CLI_USAGE_ERROR" ||
    result.code === "CLI_FILE_ERROR" ||
    result.code === "MISSING_SCHEMA"
  ) {
    return 1;
  }
  const reason = toProtocolReasonCode(result.code, result.path);
  return reason ? CLI_EXIT_BY_REASON[reason] : 2;
}
