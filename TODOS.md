# TODOS

## Execution Closure Protocol

### Add an external checkpoint witness

**What:** Anchor trust and ledger checkpoints to an independent transparency log or timestamp witness.

**Why:** Protocol v0 cannot independently detect split views, malicious suffix deletion, or attestor backdating outside its pinned trust snapshot.

**Context:** The engineering review narrowed EC-6 to zero action-labelled mutation at a finalized trusted checkpoint and made historical verdicts snapshot-relative. Start by comparing a transparency log, RFC 3161 timestamping, and a public-chain anchor against the first adopter's non-equivocation and privacy requirements.

**Effort:** XL
**Priority:** P3
**Depends on:** Stable v0 proof/checkpoint format and adopter evidence requiring stronger non-equivocation

### Separate executor and ledger attestor custody

**What:** Move the reference executor and ledger attestor into separate processes and separate key-custody boundaries.

**Why:** Protocol v0's two development signatures validate role-specific wire semantics but do not provide independent corroboration while one process can access both keys.

**Context:** v0 proofs are required to carry the signed `single_process_simulation` assurance profile. Upgrade this profile only after separate deployment, provisioning, failure handling, and key custody are implemented and tested.

**Effort:** XL
**Priority:** P3
**Depends on:** Stable `Executor` and `SignerProvider` contracts plus an adopter deployment model

### Add a signed trust-store update channel

**What:** Implement signed trust-store updates with freshness policy, rollback protection, and offline synchronization.

**Why:** The v0 CLI can verify only against the explicitly supplied trust snapshot and cannot know whether a newer revocation exists.

**Context:** v0 prints the pinned manifest head, epoch, installation age, and snapshot-relative verdict. Design the update channel after repeated verification or air-gapped deployment requirements reveal the necessary network and recovery model.

**Effort:** L
**Priority:** P3
**Depends on:** Stable manifest schema and a concrete deployment/network model

## Completed
