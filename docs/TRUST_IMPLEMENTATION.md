# Trust Layer implementation and handoff

## Scope and source
Built on the supplied TypeScript monorepo and its `trust-layer-4w-prd.md`. Core requirements implemented for **one registered transfer agent, one source account per customer, one destination per signed grant, single-transfer requests**. Core bank fixture, daily cap, double-entry balances, policy decisions and dual-control are retained.

Signed JSON/Ed25519 was selected from the PRD's permitted grant options. There is no DID resolver, W3C VC implementation, remote agent enrollment UI, HSM, actual KYC provider, autonomous LLM, payroll batch or multi-asset signed rebalance in this version. The two legacy treasury proposals remain visible but their old unsigned execution paths are blocked. New signed single transfers use the existing bank transfer tool. The PRD's 300m KRW happy path is incompatible with the bank's 5m KRW daily cap; the demo uses 300k KRW and documents the difference.

## Files

| File | Responsibility |
|---|---|
| packages/core/src/trust.ts | Ed25519 verification, synthetic sessions, signed grants, expiry, revocation, cumulative grant budget, explicit approvals, existing bank bridge, evidence chain |
| packages/core/src/db.ts | Nestable synchronous transactions via savepoints; bank execution and Trust evidence commit/rollback together |
| apps/api/src/trust-routes.ts | Hono Trust API, bearer session checks, customer scoping, local agent key, domain persistence |
| apps/api/src/money-gate.ts | Deny unsigned legacy transfer and settlement HTTP paths |
| apps/api/src/chain.ts | Compile, deploy, anchor, recover receipts and verify actual EVM state |
| apps/api/contracts/TrustAnchor.sol | One writer, sequential append, previous hash check, nonzero commitment, immutable historic mapping entries |
| apps/web/src/pages/Trust.tsx | Human key creation/signing, delegation, approval, operator approval, revocation and evidence display |
| packages/core/src/trust.test.ts | Core regression and adversarial cases |
| apps/api/src/trust-smoke.ts | HTTP + WebCrypto + EVM integration check, no external network required after install |

## Trust boundary

Identity bootstrap is deliberately a **synthetic SSO stub**. `/api/trust/session` lets the demo operator choose `syn_alice`, `syn_bob`, or `syn_operator` and bind a submitted Ed25519 public key to a one-hour bearer session. This is not real authentication of a named person. Subsequent grants and transaction approvals require the private key corresponding to the bound public key. The UI holds non-extractable private keys only in page memory. A reload loses those keys; create a new session and grant.

The local server runs on `127.0.0.1` by default. Do not expose it as a public service without replacing synthetic SSO, original role headers, session lifecycle, CSRF/origin controls, rate limits and operational key management. Existing read/product/KYC demo endpoints retain their original role-header sandbox semantics. Bank KYC originally gates product enrollment, not transfers; this change does not claim a new production KYC gate on transfers.

A persisted backend Ed25519 key signs the seeded agent's requests. Registry public key mismatch fails startup rather than silently rekeying. The registry supports seeded-agent listing/revocation; dynamic cryptographic onboarding of other agents is follow-up work. Revocation endpoints require a validated bearer session and ownership/operator checks; they do not provide a separate step-up signature.

## Signed messages

- Canonicalization: recursively lexicographic key sort, JSON serialization, UTF-8; omit undefined object fields, null for undefined array values. This is a documented application serialization, not a claim of RFC 8785 compliance for arbitrary input.
- Grant signed by human: installation domain, random grant ID/nonce, human ID/public key, agent ID, action, source/destination, currency, per-transfer max, total budget, expiry.
- Request signed by agent, then approved with human signature over the same exact message: installation domain, request ID/nonce, human ID/public key, grant ID, agent ID, action, source/destination, amount, currency, expiry.
- Refusal signs a separate domain-bound object containing request ID, request-message SHA-256 and DENY decision.
- Operator settlement uses a separate one-use challenge bound to the operator key, request hash, action and expiry. Ordinary customer sessions cannot approve pending journals. The entire SSO environment remains a mock, so this demonstrates protocol separation rather than real organizational separation of duties.

## Execution and idempotency

`Trust.execute` validates signatures, live registry/grant status, amount, cumulative grant consumption and expiry. It opens a bank transaction, creates a fresh bank session, performs existing `handoff` to transfer, then calls the existing `transfer` tool. Fresh sessions avoid reusing an old remembered policy. Original daily cap, ownership, frozen-account checks, insufficient-funds logic, other-customer/large-amount dual-control still run.

The request ID becomes the bank idempotency key `trust:<request_id>`. Repeated approval of the same completed/pending request does not debit twice. Different request IDs represent separate business instructions. Evidence and bank entries commit atomically using the same SQLite transaction. Pending approval is rechecked for agent/grant expiry/revocation and frozen accounts; rejection remains available even after expiry/revocation. A completed transfer is not reversed by grant revocation.

`/api/tools` transfer, legacy `/api/proposals/:id/execute`, and `/api/operator/approve|deny` return 428; the Trust endpoints are the only HTTP settlement route. Core package functions remain callable by internal code and tests. This is an HTTP service boundary, not a guarantee against an administrator executing arbitrary database/code operations.

## Evidence and actual chain

For each grant issue, authorization result, handled valid/invalid approval, execution, operator decision/block, and revocation, a local receipt contains a salted canonical payload and `SHA256(previous_hex + "\n" + payload)`. Malformed requests and missing sessions return API errors and are not all included in the evidence journal; comprehensive rejected-request logging is follow-up work.

The contract stores sequence→hash plus head/count and emits sequence, previous hash and commitment. It accepts only its deployment writer. Only hashes and sequence information go on-chain; raw synthetic transaction records stay off-chain.

Ganache provides an in-process, **persistent, single-node development EVM**, chain ID 1337. There is no public RPC listener and no mainnet transaction or purchased cryptocurrency. Solidity is genuinely compiled and executed, with mined blocks and receipts. This is not a multi-institution consensus deployment. Deterministic Ganache development accounts are intentionally not production signing keys.

`chain.flush` serializes writes, reconciles existing on-chain sequence/hash and recovers missing receipts after a process failure. Bank completion and anchoring are separate states. Evidence without a confirmed receipt is pending; an anchor error never relabels an executed bank transfer as reversed. Retry is explicit through operator `/anchor`, later state-changing requests, or restart; there is no continuously running background outbox worker yet.

Verification recomputes the evidence hash chain, compares the most recent evidence snapshot per affected journal and its entries with the bank database, checks on-chain sequence hashes/head/count, successful receipt, emitted event, contract, chain ID, block number/hash and canonical block. It detects log mutation, recomputed local hash tampering, forged receipt references and deleted tails while the external comparison chain remains intact. It does not audit all unrelated account/journal/history records.

**An administrator controlling both the bank files and the local development chain can replace the entire environment.** Independent deployment, separately governed validators/checkpoints and key custody are required before claiming external immutability. A single local confirmation is the demo rule, not a production finality policy.

## API
All below use `/api/trust`; except `/session`, require `Authorization: Bearer <token>`.

| Method | Path | Input / purpose |
|---|---|---|
| POST | /session | human_id, base64 SPKI public_key; synthetic identity bootstrap |
| POST | /logout | Revoke current bearer session |
| GET | /state | Scoped grants, requests, receipts, agent status, accounts and chain metadata |
| POST | /grants/challenge | max_amount, to_account_id; prepare exact human signing message |
| POST | /grants | grant_id, signature; verify and issue |
| POST | /requests | grant_id, integer amount; agent signs; verify delegation |
| POST | /requests/:id/approve | approve boolean, signature; execute or refuse |
| POST | /requests/:id/operator-challenge | approve boolean; independent operator signing message |
| POST | /operator-decision | challenge_id, signature |
| POST | /revoke | kind=agent/grant, id; grant owner/operator or agent operator |
| POST | /anchor | Operator retries pending anchors |
| GET | /evidence | Scoped receipts |
| GET | /evidence/:id | Receipt visible to current principal |
| GET | /verify | Recompute bank/evidence/chain consistency; returns chain_verified and reason |

## Storage and restart
`DATABASE_PATH` defaults to `data/bank.sqlite`. Adjacent `trust/` contains the agent key (0600), installation domain and `chain/` with Ganache DB and deployment metadata. Keep the whole bank+trust folder together. Do not reset only one component. To start a completely new demo, stop the server and choose a new `DATABASE_PATH`; do not overwrite old evidence.

Browser key loss does not erase receipts. For pending transactions the operator can still settle using the original request's stored public key and signatures, within request/grant validity.

## Next engineering steps
1. Institution IdP/real session and step-up proof; stable user key enrollment and recovery.
2. Separately governed permissioned EVM/RPC and production writer custody; finality/reorg policy and background outbox reconciliation.
3. Signed multi-leg proposals and payroll batches with per-leg/aggregate authority and replay protection.
4. Optional external LLM adapter producing strictly validated proposals only; keep settlement tools behind the same signed gate.
5. Real bank sandbox adapter with UNKNOWN status, timeout/retry and reconciliation; local SQLite atomicity does not span bank APIs.
6. UI browser QA, accessibility review, deployment review and independent security assessment.

## Official references
- [Node.js crypto](https://nodejs.org/api/crypto.html)
- [Ethers contract API](https://docs.ethers.org/v6/api/contract/)
- [Ethers provider API](https://docs.ethers.org/v6/api/providers/)
- [Solidity contracts](https://docs.soliditylang.org/en/latest/contracts.html)
