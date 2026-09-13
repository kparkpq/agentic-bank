# Execution Closure quickstart

Synthetic sandbox only. No real money, rails, or production identity.

## 30-minute path

1. Install Node 22+ and `pnpm`.
2. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @execution-closure/protocol --filter @execution-closure/api test
```

3. The Stage 1 happy path is `apps/closure-api/src/integration.test.ts`:
   register a mandate for `syn_alice`, authorize `"300000"`, commit, then verify the proof with the CLI.

4. Offline verify of a saved proof:

```bash
node --import tsx packages/protocol/bin/execution-closure-verify.mjs proof.json trust-store.json
```

The CLI reads an explicit trust-store snapshot. A matching proof is `VALID` only for that snapshot. A different head is `STALE_TRUST_HEAD`.

## Stage 3 recovery

If commit returns `202` with `state: EXECUTION_UNKNOWN`, do not retry execution. Call:

```http
POST /v1/authorizations/:decisionId/reconcile
GET  /v1/unresolved
```

Reconciliation looks up the original idempotency key. It never posts a second transfer.
