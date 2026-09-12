import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatCliResult, verifyJsonDocuments } from "./cli.js";
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
      expect(error).toMatchObject({ status: 1 });
    }
  });

  it("reports JSON parse errors without throwing", () => {
    const result = verifyJsonDocuments("{", "{}");
    expect(result).toMatchObject({ valid: false, code: "CLI_INPUT_ERROR" });
    expect(formatCliResult(result)).toContain("CLI_INPUT_ERROR");
  });
});
