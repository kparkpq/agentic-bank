import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliExitCode, formatCliResult, missingSchemaResult, schemaArtifactPath, verifyJsonDocuments } from "./cli.js";
import { createSyntheticClosureFixture } from "./testing.js";

const VERIFY_BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/execution-closure-verify.mjs");

describe("offline closure verifier CLI", () => {
  it("exits zero for valid proof and nonzero for invalid proof", () => {
    const fixture = createSyntheticClosureFixture();
    const dir = mkdtempSync(join(tmpdir(), "ec-verify-"));
    const proofFile = join(dir, "proof.json");
    const trustFile = join(dir, "trust.json");
    writeFileSync(proofFile, JSON.stringify(fixture.proof));
    writeFileSync(trustFile, JSON.stringify(fixture.trust_store));

    const valid = execFileSync(process.execPath, ["--import", "tsx", VERIFY_BIN, proofFile, trustFile], {
      encoding: "utf8",
    });
    expect(JSON.parse(valid)).toMatchObject({ valid: true, code: "VALID" });

    writeFileSync(trustFile, "{}");
    try {
      execFileSync(process.execPath, ["--import", "tsx", VERIFY_BIN, proofFile, trustFile], { encoding: "utf8" });
      throw new Error("expected verifier to fail");
    } catch (error) {
      expect(error).toMatchObject({ status: 2 });
    }

    try {
      execFileSync(process.execPath, ["--import", "tsx", VERIFY_BIN], { encoding: "utf8" });
      throw new Error("expected usage error");
    } catch (error) {
      expect(error).toMatchObject({ status: 1 });
    }

    try {
      execFileSync(process.execPath, ["--import", "tsx", VERIFY_BIN, "/missing-proof.json", "/missing-trust.json"], {
        encoding: "utf8",
      });
      throw new Error("expected file error");
    } catch (error) {
      expect(error).toMatchObject({ status: 1 });
    }
  });

  it("reports JSON parse errors without throwing and names a missing schema", () => {
    const result = verifyJsonDocuments("{", "{}");
    expect(result).toMatchObject({ valid: false, code: "CLI_INPUT_ERROR" });
    expect(formatCliResult(result)).toContain("CLI_INPUT_ERROR");
    expect(cliExitCode(result)).toBe(1);
    expect(cliExitCode({ valid: true, code: "VALID", proof_id: "p", closure_kind: "success", manifest_hash: "m", receipt_body_hash: null, effect_hash: null })).toBe(0);
    expect(cliExitCode({ valid: false, code: "PROOF_SCHEMA_INVALID", path: "/", message: "bad" })).toBe(2);
    expect(cliExitCode({ valid: false, code: "NOT_A_PROTOCOL_CODE" as "PROOF_SCHEMA_INVALID", path: "/", message: "bad" })).toBe(2);
    expect(missingSchemaResult("/definitely-missing-ec-schema.json")).toMatchObject({ code: "MISSING_SCHEMA" });
    expect(missingSchemaResult()).toBeUndefined();
    expect(schemaArtifactPath()).toContain("ec-v0.schema.json");
  });
});
