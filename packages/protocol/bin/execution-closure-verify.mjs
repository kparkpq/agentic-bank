#!/usr/bin/env -S node --import tsx

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../schemas/ec-v0.schema.json");

if (!existsSync(schemaPath)) {
  process.stdout.write(
    `${JSON.stringify({
      valid: false,
      code: "MISSING_SCHEMA",
      path: "/schemas/ec-v0.schema.json",
      message: "MISSING_SCHEMA: schemas/ec-v0.schema.json is not packaged"
    })}\n`
  );
  process.exitCode = 1;
} else {
  const { cliExitCode, formatCliResult, verifyJsonDocuments } = await import("../src/cli.ts");
  let result;
  if (process.argv.length !== 4) {
    result = {
      valid: false,
      code: "CLI_USAGE_ERROR",
      path: "/",
      message: "usage: execution-closure-verify <proof.json> <trust-store.json>"
    };
  } else {
    try {
      result = verifyJsonDocuments(
        readFileSync(process.argv[2], "utf8"),
        readFileSync(process.argv[3], "utf8")
      );
    } catch {
      result = {
        valid: false,
        code: "CLI_FILE_ERROR",
        path: "/",
        message: "unable to read proof or trust-store file"
      };
    }
  }
  process.stdout.write(formatCliResult(result));
  process.exitCode = cliExitCode(result);
}
