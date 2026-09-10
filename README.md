> **Trust Layer 시제품 추가**: 실행과 현재 지원 범위는 [START_HERE_KO.md](START_HERE_KO.md)를 먼저 보세요. 아래 원래 문서의 무서명 송금·운영자 승인 API는 이제 428을 반환합니다. 서명된 단일 이체는 `/trust-demo`에서 수행합니다.

# SapiensQ Agentic AI Bank sandbox v0

Simulated KRW **neutral money layer** plus the v0 control plane. Not a bank. Not a brokerage. A buyer watches Alice's idle cash move into a higher-yield sleeve and a tiny 70/30 book rebalance — then the same ledger+policy posts or waits for dual-control.

**Never real money, live payment rails, real PII, or licensed-bank claims.** Customer `syn_alice` is synthetic. Currency is integer won. Calendar-day caps use `Asia/Seoul`; timestamps are stored in UTC.

Kyoungsun Park signs off before merge. Do not auto-merge. Sandbox only — never deploy publicly.

## Customer demo (start here)

```bash
pnpm install
rm -f data/bank.sqlite   # pick up new sleeves if you already seeded v0
pnpm seed                # writes data/bank.sqlite
make dev                 # API :3001 + web :5173
```

Open **http://localhost:5173/money** (role defaults to 고객 / 앨리스 · `syn_alice`). Sidebar: 내 돈, 제안, 상품, 장부, 실행 기록.

| Path | Screen | What you should see |
|---|---|---|
| `/money` | 내 돈 | 한빛 입출금통장 idle cash, 한빛 파킹MMF (연 3.50% fixture), 청운 코스피200/국고채 ETF |
| `/proposals` | 제안 | idle-cash sweep + 70/30 비중 맞추기; **실행** or **건너뛰기** |
| `/products` | 상품 | 예금·보험·대출 비교 (한빛/들판/남산). **가입 진행** collects docs then **실명 확인이 필요합니다**. After sandbox KYC, **가입 완료하기** posts a demo enrollment (no live rails). |
| `/kyc` | 실명 확인 | Synthetic KYC for `syn_alice`: 미완료 → 검토 중 → 완료/거절. No RRN/PII. |
| `/books` | 장부 | 가계부 (ledger in/out), 절세 (rule notes labeled 참고이지 세무 자문이 아닙니다), 서류 챙김/미챙김 |
| `/activity` | 실행 기록 | 접수→진행→완료 / 승인 대기 / 거절 / 실명 확인이 필요합니다; 출금→입금 상품명 |

`실행` calls the existing transfer agent: `policy.decide` then `writeTransferJournal`. Idle cash is 2,000,000 KRW so it sits **승인 대기** until an operator 승인 (dual-control ≥ 1,000,000). Rebalance is 100,000 KRW so it **완료** immediately. Idempotency keys: `eval:treasury-idle:v0`, `eval:rebalance:v0`.

`가입 진행` writes `shop.enroll` audit + `enrollment_attempts` with status `KYC_REQUIRED` until sandbox KYC. `POST /api/kyc` is synthetic-only (`syn_*`); PASS unlocks **가입 완료하기** (`ENROLL_COMPLETE`, copy `완료`, no transfer journal). Replay keys: `eval:shop-deposit:v0`, `eval:kyc:syn_alice:v0`.

Operator pages stay at 계좌 / 원장 / 승인 대기 / 트레이스 / 감사 로그 — switch 역할 to 운영자.

Screenshots: `docs/demo/{money_sleeves,proposals_both,proposals_after_execute,activity_history,audit_why,products_list,products_kyc_stop,books}.png` plus step-2 `docs/demo/{money_realistic_names,proposals_transfer_path,products_checkbox,activity_execution}.png` plus step-3 `docs/demo/{products_join,kyc_sandbox,products_enrolled,money_hanbit_deposit,activity_enrolled}.png`.

Production-style (API serves the built web UI):

```bash
pnpm start         # http://localhost:3001/money
docker compose up --build   # http://localhost:3000/money
```

### CI / goldens

```bash
pnpm check         # typecheck + 64 core tests + production web build
make eval          # core tests + 14 goldens + scripted walk
```

Goldens live in `evals/golden/` including `treasury-idle.json`, `rebalance.json`, `shop-kyc.json` (KYC_REQUIRED blocks), `shop-enroll-posted.json` (KYC then POSTED), and `shop-kyc-denied.json`. Seed fixture: `fixtures/v0.json`. Yields and shop rates are fixture constants, not market data.

Scripted walk (`make walk`): v0 loop plus treasury idle PENDING + rebalance POSTED + shopper KYC stop then sandbox KYC + 한빛 정기예금 enrollment POSTED (no transfer journal) + bookkeeper disclaimer.

GitHub Actions runs the same checks on `main` and pull requests. The package dry-run workflow packs `@sapiensq/core` until `@execution-closure/protocol` exists, then switches to the Protocol package automatically; it never publishes.

## Architecture

```
apps/web     customer money layer + operator console (React)
apps/api     Hono HTTP over the core Bank
packages/core
  ledger     writeTransferJournal: double-entry SQLite; available = posted credits − posted debits
             DENIED/PENDING = two unapplied postings; pending_out = pending source debits
             decision_ref = Guard decide audit_id (immutable on operator 승인/거절)
  policy     deterministic decide() — not a prompt
  treasury   rule proposals (idle buffer, 70/30); execute = handoff + transfer
  shopper    better 예금/보험/대출; enroll collects docs, sandbox KYC, then demo POSTED (no live rails)
  bookkeeper 가계부 + 절세 참고 + 서류 챙김; not a 세무사
  agents     teller | transfer | dispute, one session, one customer
  audit      every tool call writes audit_id (missing = fail)
evals/       golden replay + walk
```

House contra `acc_house_equity` funds opening balances. Postings are idempotent on `idempotency_key`. Operator approve/deny is idempotent on `journal_id` + `audit_id`.

### Seed balances (KRW)

| Account | Product | Opening available | Customer picture |
|---|---|---|---|
| acc_alice_chk | CHECKING | 10,000,000 | 한빛 입출금통장 · 한빛은행 · 연 0.10% |
| acc_alice_mmf | SAVINGS | 100,000 | 한빛 파킹MMF · 한빛은행 · 연 3.50% |
| acc_alice_eq | CHECKING | 800,000 | 청운 코스피200 ETF · 청운증권 |
| acc_alice_bond | CHECKING | 200,000 | 청운 국고채 ETF · 청운증권 |
| acc_alice_sav | SAVINGS | 200,000 | 한빛 자유적금 · v0 operator/eval path only |
| acc_bob_chk | CHECKING | 500,000 | |
| acc_bob_sav | SAVINGS | 100,000 | |
| acc_house_equity | HOUSE | contra | hidden |

### Policy (deterministic)

1. amount ≤ 0, unknown account, or not owned → `DENY_POLICY` (audit only, no journal)  
2. NSF: spendable = available − pending_out < amount → `DENY_NSF`, journal `DENIED` with two balanced `posted=0` rows (원장 거절); available unchanged  
3. daily outbound cap 5,000,000 KRW / customer / Seoul calendar day (posted + pending out) → `DENY_LIMIT` / `DAILY_CAP` (same unposted pair)  
4. amount ≥ 1,000,000 KRW **or** other customer → `DUAL_CONTROL`, journal `PENDING`, copy `승인 대기`; agent cannot approve  
5. else `ALLOW` and POST immediately; copy includes `완료`

`journal.decision_ref` is the `policy.decide` `audit_id` and does not change on operator 승인/거절. The operator row is a second audit joined by `journal_id`.

NSF/cap denials and dual-control use idempotency keys (`eval:allow:v0`, `eval:deny-limit:v0`, `eval:deny-nsf:v0`, …): replay returns the same `journal_id` + same decide `audit_id`.

Only Console `operator.approve` / `operator.deny` may clear `PENDING`. Self-approve fails and is audited.

### Agent graph

Sessions start as **teller** (`balance`, `handoff`). Teller never posts and cannot call `transfer` or `open_dispute`. Handoff to **transfer** (`balance`, `policy.decide`, `transfer`) or **dispute** (`balance`, `open_dispute` intake only). Transfer always calls `policy.decide` first. Thin typed-tool loop; no LLM required.

Every tool call writes: timestamp, actor (`agent`\|`operator`), action, args, decision (`ALLOW`\|`DENY_LIMIT`\|`DENY_NSF`\|`DENY_POLICY`\|`DUAL_CONTROL`\|`OPERATOR_APPROVE`\|`OPERATOR_DENY`), rule_id, reason, audit_id.

### Console roles

- **고객 / customer** (default) — 내 돈, 제안, 상품, 장부, 실행 기록  
- **운영자 / operator** — v0 pages plus freeze/approve/deny  

Sandbox auth is headers `X-Role` and `X-Customer-Id` (not production identity).

## Out of scope

- Real money movement, cards, SWIFT/wires, open banking, or any live rail  
- Licensed deposit-taking, KYC/AML production systems, real names/SSNs/PII  
- Multi-currency, FX, interest accrual, loans  
- LLM orchestration frameworks (optional later; v0 is ledger + policy + console + evals)  
- Live shopper rails, real KYC, licensed 세무사/세무 대리, Plaid/MyData, live prices, cards  
- Production SSO, secrets, or network isolation beyond this sandbox  

## API sketch

| Method | Path | Notes |
|---|---|---|
| GET | `/api/money` | Alice sleeves + fixture yields |
| GET | `/api/proposals` | idle-cash + rebalance from rules |
| POST | `/api/proposals/:id/execute` | handoff + transfer via Bank |
| POST | `/api/proposals/:id/dismiss` | 건너뛰기; no journal |
| GET | `/api/activity` | executions + decide why (includes KYC enrollment attempts) |
| GET | `/api/products` | shopper catalog + KYC status for syn_alice |
| POST | `/api/products/:id/enroll` | `{ checked_documents }`; KYC_REQUIRED until sandbox KYC PASS, then POSTED |
| GET | `/api/kyc` | sandbox KYC case + synthetic defaults |
| POST | `/api/kyc` | `{ acknowledgements, scenario? }`; syn_* only; never stores RRN |
| POST | `/api/products/:id/dismiss` | 건너뛰기 |
| GET | `/api/books` | 가계부 / 절세 / 서류 |
| POST | `/api/books/documents/:id` | `{ held }` 챙김/미챙김 |
| GET | `/api/accounts` | role-filtered |
| GET | `/api/ledger` | journals + entries |
| GET | `/api/pending` | operator only |
| GET | `/api/traces` | operator only |
| GET | `/api/audit` | operator all; customer own rows |
| POST | `/api/sessions` | starts teller |
| POST | `/api/tools` | `{ session_id, action, args }` |
| POST | `/api/operator/approve` | `{ journal_id, audit_id? }` |
| POST | `/api/operator/deny` | `{ journal_id, audit_id? }` |
