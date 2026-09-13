# @execution-closure/protocol

Offline types, RFC 8785 canonicalization, and a CLI that verifies Execution Closure proofs.

Synthetic sandbox only. Not a bank. No real money, rails, or production identity.

## Install

```bash
npm install @execution-closure/protocol
```

Publish happens only from an annotated git tag `@execution-closure/protocol@<version>` via GitHub Actions. The public npm tarball is the only v0 distribution artifact. Do not publish from `main`, and do not publish the Gateway or `apps/api`.

```bash
git tag -a '@execution-closure/protocol@0.1.0' -m 'Release @execution-closure/protocol@0.1.0'
git push origin '@execution-closure/protocol@0.1.0'
```

npm Trusted Publisher must allow GitHub Actions on `kparkpq/agentic-bank` workflow `release.yml` with `npm publish`. The repository is public so npm can attach provenance to those tag publishes.

## Verify a proof

```bash
npx --package=@execution-closure/protocol execution-closure-verify proof.json trust-store.json
```

The CLI reads an explicit trust-store snapshot. A matching proof is `VALID` only for that snapshot.
