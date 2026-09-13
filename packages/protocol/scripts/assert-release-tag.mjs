#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8"));
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
const expected = `${pkg.name}@${pkg.version}`;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!tag) fail("release tag is missing");
if (pkg.private === true) fail("refusing to publish a private package.json");
if (pkg.name !== "@execution-closure/protocol") fail(`unexpected package name: ${pkg.name}`);
if (pkg.publishConfig?.access !== "public") fail("publishConfig.access must be public");
if (!semver.test(pkg.version)) fail(`unsupported version: ${pkg.version}`);
if (tag !== expected) fail(`tag ${tag} does not match ${expected}`);
if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
  fail("release-manifest.json does not match package.json name/version");
}

process.stdout.write(`release-tag-ok ${tag}\n`);
