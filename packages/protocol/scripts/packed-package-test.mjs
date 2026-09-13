#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspace = join(root, "../..");
const packDir = mkdtempSync(join(tmpdir(), "ec-pack-"));
const installDir = mkdtempSync(join(tmpdir(), "ec-install-"));

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
  mkdirSync(packDir, { recursive: true });
  run("pnpm", ["--filter", "@execution-closure/protocol", "pack", "--pack-destination", packDir], workspace);
  const tarball = run("bash", ["-lc", "ls *.tgz"], packDir).trim().split("\n")[0];
  if (!tarball) throw new Error("packed tarball was not created");
  const tarballPath = join(packDir, tarball);
  const listing = run("tar", ["-tzf", tarballPath], packDir);
  for (const required of [
    "package/schemas/ec-v0.schema.json",
    "package/fixtures/interop-vector.json",
    "package/fixtures/reason-codes.json",
    "package/bin/execution-closure-verify.mjs",
    "package/release-manifest.json",
    "package/LICENSE",
    "package/README.md",
    "package/src/cli.ts",
  ]) {
    if (!listing.includes(required)) {
      throw new Error(`packed tarball is missing ${required}`);
    }
  }

  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "ec-packed-consumer", private: true, type: "module" }, null, 2),
  );
  run("npm", ["install", "--ignore-scripts", tarballPath], installDir);

  const consumer = join(installDir, "verify-packed.mjs");
  writeFileSync(
    consumer,
    `
import { writeFileSync } from "node:fs";
import { createSyntheticClosureFixture } from "@execution-closure/protocol/testing";
import { cliExitCode, verifyJsonDocuments } from "@execution-closure/protocol/cli";

const fixture = createSyntheticClosureFixture();
writeFileSync("proof.json", JSON.stringify(fixture.proof));
writeFileSync("trust.json", JSON.stringify(fixture.trust_store));
const result = verifyJsonDocuments(JSON.stringify(fixture.proof), JSON.stringify(fixture.trust_store));
if (!result.valid || cliExitCode(result) !== 0) {
  throw new Error("packed package failed to verify its own synthetic proof");
}
console.log("packed-package-verify-ok");
`,
  );
  const verified = run("node", ["--import", "tsx", consumer], installDir);
  if (!verified.includes("packed-package-verify-ok")) {
    throw new Error("packed consumer did not print success");
  }

  const schemaPath = join(installDir, "node_modules/@execution-closure/protocol/schemas/ec-v0.schema.json");
  const verifyBin = join(installDir, "node_modules/@execution-closure/protocol/bin/execution-closure-verify.mjs");
  if (!existsSync(schemaPath)) throw new Error("installed schema is missing");
  unlinkSync(schemaPath);
  let missing;
  try {
    missing = run("node", ["--import", "tsx", verifyBin, "proof.json", "trust.json"], installDir);
    throw new Error("expected CLI to fail after the packaged schema was removed");
  } catch (error) {
    missing = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (error.status !== 1 && !String(missing).includes("MISSING_SCHEMA")) {
      throw error;
    }
  }
  if (!missing.includes("MISSING_SCHEMA")) {
    throw new Error(`missing schema process test failed: ${missing}`);
  }
  console.log("packed-package-test-ok");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
}
