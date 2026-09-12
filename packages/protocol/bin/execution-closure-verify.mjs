#!/usr/bin/env -S node --import tsx

import { readFileSync } from "node:fs";
import process from "node:process";
import {
  formatCliResult,
  verifyJsonDocuments
} from "../src/cli.ts";

const args = process.argv.slice(2);
let result;

if (args.length !== 2) {
  result = {
    valid: false,
    code: "CLI_USAGE_ERROR",
    path: "/",
    message: "usage: execution-closure-verify <proof.json> <trust-store.json>"
  };
} else {
  try {
    result = verifyJsonDocuments(
      readFileSync(args[0], "utf8"),
      readFileSync(args[1], "utf8")
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
process.exitCode = result.valid ? 0 : 1;
