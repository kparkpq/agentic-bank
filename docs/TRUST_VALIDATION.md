# Validation record — Trust prototype

Validated in the provided Linux environment, Node.js v24.19.0. These are executed checks, not projected acceptance criteria.

| Check | Result |
|---|---|
| Existing core unit tests | 47 passed |
| Added Trust unit tests | 17 passed |
| Core aggregate | 7 files, 64 tests passed |
| API/WebCrypto/Solidity/local EVM smoke | 25 assertions passed |
| TypeScript core, API and web | Passed |
| Web production build | Passed; Vite 6.4.3, 56 modules transformed |
| Manifest vs lockfile dependency specifiers | Matched |
| Browser click/visual QA | Not run |
| Docker startup | Not run |
| Real bank / external LLM / public or consortium chain | Not connected or tested |

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm trust:smoke
pnpm typecheck
pnpm --filter @sapiensq/web build
```

The smoke script creates temporary bank/chain state, compiles/deploys the included Solidity contract, generates a non-extractable WebCrypto human key, obtains a mock identity session, signs a grant and transaction, executes the original bank transfer, mines evidence, verifies it and cleans up. It uses Hono's in-process HTTP request harness and does not require a listening port. It closes and reopens the persistent development EVM to verify recovery.

## Unit failure cases
Wrong human/key; changed grant or amount; grant issue replay; invalid approval; expiry; revoked agent/grant; delegated per-transaction and cumulative limits; bank daily cap; NSF; frozen account; independent operator-only settlement; operator challenge replay; signed refusal; duplicate debit prevention; rollback when evidence insert fails; mutated bank journal; modified evidence; invalidated session.

## Integration assertions
Four old unsigned money endpoint bypass checks; unauthenticated read rejection; session/public-key binding; signed grant anchoring; no premature execution; existing journal success; successful EVM execution receipt; chain verification; no duplicate debit on replay; limit denial and its anchored evidence; unauthorized contract writer; wrong sequence; wrong previous hash; zero commitment; receipt recovery without a new anchor; recovered receipt verification; forged receipt detection; recomputed local hash accepted locally but rejected against the chain; deleted tail detection; chain persistence across restart.

The development deployment address printed by a run is an ephemeral test artifact, not a public network deployment. Ganache may print a native µWS fallback notice on Node.js 24; the tests passed using its JavaScript fallback. Tests demonstrate the bounded prototype behavior and do not establish production security or regulatory compliance.
