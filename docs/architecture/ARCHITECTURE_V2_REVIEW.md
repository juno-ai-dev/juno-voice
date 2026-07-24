# Juno Voice Architecture V2 Review

**Status:** Accepted on 2026-07-24 and superseded by canonical documentation
**Scope:** consolidated protocol, product/operations, and contract-feasibility review
**Canonical sources:** [`ARCHITECTURE.md`](./ARCHITECTURE.md), accepted ADRs in [`decisions/`](./decisions/), [`PRODUCT_DESIGN.md`](../design/PRODUCT_DESIGN.md), and [`2026-07-23-mvp.md`](../plans/2026-07-23-mvp.md)

> This review is retained as decision history. Its recommendations were accepted with the launch-policy qualifications recorded in the canonical sources. It is no longer an implementation specification and imposes no implementation pause.

## 1. Review verdict

At review time, the existing architecture was strong enough to establish the product boundary, fixed-snapshot voting model, and non-binding posture, but was not yet safe to freeze behavior-complete contract schemas. The accepted canonical architecture now closes those gaps.

The current draft credibly supports:

```text
suggest → prioritize
```

Architecture V2 should support the full accountable loop:

```text
suggest → prioritize → select → build → review → attest shipment
```

The contract cannot prove that external software is correct. It can preserve what was requested, how it was prioritized, who accepted responsibility, which immutable evidence was cited, and who attested that the acceptance criteria were met.

This document consolidated the review findings. Acceptance authorized canonical MVP implementation, but not deployment or fund acceptance; the intended launch profile is selected in canonical architecture and remains explicit deployment input subject to live revalidation.

## 2. Product objective and non-objectives

### Objective

Juno Voice is a neutral, chain-auditable roadmap prioritization and delivery-attestation system:

- any wallet can submit a bounded request with immutable acceptance criteria and an anti-spam bond;
- JUNO stakers can cast immutable `SUPPORT` or `OPPOSE` votes using power fixed at the request's historical snapshot;
- deterministic thresholds separate qualified from non-prioritized requests;
- a publicly accountable steward can accept qualified work and assign a builder;
- the assigned builder can attach immutable evidence and request review;
- a verifier can attest shipment against the original acceptance criteria;
- humans and agents can reproduce canonical request, vote, bond, assignment, evidence, attestation, and history state from chain queries.

### Non-objectives

The MVP does not provide:

- binding governance or treasury execution;
- bounties, builder bonds, or automatic payouts;
- automatic code execution or GitHub authentication;
- cryptographic proof that software is safe or correct;
- comments or arbitrary files stored on-chain;
- mutable votes, delegation, quadratic voting, conviction voting, or identity claims;
- private requests or cross-chain voting power;
- automatic duplicate detection or vote merging.

Prioritization remains non-binding. Steward acceptance and shipment attestations are accountable judgments, not community mandates.

## 3. Canonical request brief

The current `acceptance_uri: Option<String>` is insufficient as the canonical contract between voters and builders. External HTTPS content can change, and an optional URI does not give agents a stable definition of done.

### Accepted request fields

```rust
RequestBrief {
  title: String,
  summary: String,
  acceptance_criteria: String,
  category: String,
  detail_uri: Option<String>,
  detail_digest: Option<String>,
}
```

Rules:

- `acceptance_criteria` is required, bounded, stored on-chain, and immutable.
- `category` is a bounded lowercase slug matching `[a-z0-9-]`; it is not a closed Rust enum.
- `detail_uri` is supplementary. The inline brief remains canonical. Detail fields accept only `(None, None)` or `(Some(uri), Some(digest))`; unpaired values are rejected.
- A supplied URI must use `https://` or `ipfs://` followed by a non-empty locator, and its digest must be `sha256:<64 lowercase hex>`.
- Submitted requests cannot be edited. Material corrections create a replacement request and may be linked through archival or duplicate metadata.

## 4. Fixed-snapshot voting and qualification

When submission executes in block `H`, the request stores:

```text
snapshot_height = H - 1
```

At submission, the contract queries and stores total voting power `T` at that height. Each wallet may cast one immutable receipt containing its historical power and `SUPPORT` or `OPPOSE` choice.

For support `S`, opposition `O`, and participation `P = S + O`, qualification at the end-exclusive close height is:

```text
P > 0
P × 10,000 >= T × quorum_bps
S × 10,000 >= P × support_bps
```

All multiplication uses checked wide integers. Thresholds and closing height are copied into the request at submission so later configuration changes cannot rewrite outcomes.

### Snapshot-history trust boundary

The current Juno custom query resolves voting power at or before the requested height but does not return the height it actually resolved. It also does not expose voting-snapshot retention parameters. The contract therefore **cannot prove that the exact requested historical snapshot still exists**. Re-querying total power and comparing it with the value stored at submission is only a consistency check: an older fallback can have the same total while individual delegations differ.

Architecture V2 consequently treats retained snapshot history as an explicit external deployment trust assumption:

- operators must verify that chain retention exceeds the maximum voting age with a documented safety margin;
- production launch must publish that assumption and monitor chain upgrades/restarts that can invalidate it;
- each vote still requires a nonzero historical total equal to the stored total, returning `SnapshotIntegrityMismatch` without state changes when it differs;
- equality does **not** prove exact-height availability and must never be presented as such;
- if Juno adds a binding that returns the resolved snapshot height, a later contract version should require exact equality with the request's query height.

This limitation is a launch risk, not something application code can fully repair. The chain-level trust assumption was accepted; a stronger binding remains a future improvement.

## 5. Ranking

Keep `SUPPORT / OPPOSE` for MVP. It distinguishes broadly supported work from equally popular but strongly opposed work and matches the qualification model.

Canonical rank for a selected status is:

1. signed net support `S - O`, descending;
2. support power `S`, descending;
3. oldest request ID, ascending.

The UI must also display raw support, opposition, participation, total snapshot power, voter count, snapshot height, and whether a displayed row number is a canonical rank or merely a filtered position.

### Storage-safe signed ordering and pagination

Never subtract `Uint128` directly. Maintain two secondary indexes:

```text
STATUS_RANK:          (status, rank_key) → request_id
STATUS_CATEGORY_RANK: (status, category, rank_key) → request_id
```

`rank_key` has this fixed-width byte layout and is iterated descending:

```text
version:u8 = 1
sign_bucket:u8       // 1 for net >= 0; 0 for net < 0
sortable_net:[u8;16] // positive magnitude; MAX-abs(net) for negative
support:[u8;16]      // big-endian Uint128
reverse_id:[u8;8]    // big-endian (u64::MAX - request_id)
```

Zero belongs to the non-negative bucket with magnitude zero. Numeric status codes and cursor version are frozen in the public schema. The index entry is removed and reinserted atomically whenever a vote or status transition changes its key.

The opaque cursor is base64url-without-padding over:

```text
cursor_version:u8
schema_version:u16
status:u8
category_length:u8
category:utf8-bytes // zero length for an unfiltered status query
rank_key
```

Decoding rejects an unknown version, malformed length, invalid UTF-8/category, or filters that differ from the current query. Exact encoding and ordering test vectors are required before schema freeze.

Pagination over mutable `OPEN` requests is weakly consistent: votes between pages can move keys and cause omissions or duplicates. Responses include the query height, and clients must refresh from page one when they require a current view. Rankings of closed requests are stable unless their lifecycle status changes.

## 6. Bond accounting

Bond state is independent of lifecycle status:

```text
LOCKED → REFUNDABLE → CLAIMED
LOCKED → FORFEITED
```

Rules:

- submission requires exactly the configured native-denom bond;
- every other execute message rejects attached funds;
- `NOT_PRIORITIZED`, `QUALIFIED`, `DUPLICATE`, and non-spam `ARCHIVED` make the bond irrevocably refundable;
- only `OPEN → SPAM` may forfeit a still-locked bond;
- a refundable or claimed bond can never be forfeited;
- only the request author may withdraw, and payment always returns to the author;
- refunds use pull payments and state-before-message ordering;
- forfeited funds are accounted for but have no withdrawal path in MVP.

Recommended aggregate accounting:

```rust
BondTotals {
  locked: Uint128,
  refundable: Uint128,
  forfeited: Uint128,
}
```

Every bond transition updates the request and aggregate totals atomically. The contract's native-denom balance must never be less than their sum. Unsolicited bank sends are surplus and do not create a claim.

## 7. Roles and authority

Separate five actors/authorities:

1. **Chain contract admin** — can replace contract code through CosmWasm migration and is therefore an effective custodian of every locked or refundable bond.
2. **Governor** — replaces operational roles and controls durable protocol configuration.
3. **Steward** — moderates requests, selects work, assigns builders, and handles stale-work recovery.
4. **Verifier** — reviews evidence, rejects review, adds verification evidence, and attests shipment.
5. **Builder** — the request's current-round assignee; adds delivery evidence and requests review.

The production chain admin and governor must be DAO or multisig authorities; a unilateral admin must never accept production bonds. Their addresses, powers, proposal/review process, and any enforceable delay must be disclosed to depositors. Governor transfer uses propose/accept semantics. Steward and verifier cannot replace the governor or themselves. The assigned builder and verifier must be different addresses for each shipment.

The steward cannot alter:

- request briefs or acceptance criteria;
- votes, receipts, tallies, snapshot heights, or request-copied thresholds;
- submitted evidence or attestations;
- prior lifecycle history;
- duplicate targets after transition;
- bond ownership or refund recipient.

Every privileged action records the actor, block height, timestamp, bounded non-empty reason, and relevant old/new values in the canonical typed action logs defined in Section 13.

## 8. Lifecycle

`DRAFT` is off-chain only.

| Transition | Controller | Guard and effect |
|---|---|---|
| submission → `OPEN` | Any wallet | Exact bond and valid immutable brief |
| `OPEN → QUALIFIED` | Anyone | At/after close; deterministic formula passes; bond refundable |
| `OPEN → NOT_PRIORITIZED` | Anyone | At/after close; formula fails; bond refundable |
| `OPEN → SPAM` | Steward | Bounded reason; locked bond forfeited |
| `OPEN → DUPLICATE` | Steward | Earlier non-duplicate canonical request and reason; bond refundable |
| `QUALIFIED → DUPLICATE` | Steward | Canonical request and reason |
| `QUALIFIED → BUILDING` | Steward | Assign one builder; records operational commitment |
| `QUALIFIED → ARCHIVED` | Steward | Reason |
| `BUILDING → REVIEW` | Assigned builder | Current work-round delivery evidence required |
| `BUILDING → BLOCKED` | Assigned builder | Reason |
| `BUILDING → BLOCKED` | Steward | Copied inactivity timeout elapsed; reason |
| `REVIEW → SHIPPED` | Verifier | Exact attestation predicate passes |
| `REVIEW → BUILDING` | Verifier | Rejection reason; increments work round |
| `REVIEW → BLOCKED` | Verifier | Reason |
| `BLOCKED → BUILDING` | Steward | Assign or reassign builder; always increments work round |
| `BLOCKED → ARCHIVED` | Steward | Reason |

Terminal statuses:

```text
NOT_PRIORITIZED
DUPLICATE
SPAM
ARCHIVED
SHIPPED
```

`CloseRequest` rejects any status other than `OPEN`. Clients must present `OPEN && height >= closes_height` as `AWAITING_FINALIZATION`, and a non-trusted keeper may call the same public close method.

`QUALIFIED` means the request crossed deterministic signal thresholds. Operational commitment is recorded by `QUALIFIED → BUILDING` with an explicit builder assignment. Removing `ACCEPTED` avoids an indefinitely unassigned intermediate state.

## 9. Builders, evidence, and shipment attestation

The existing authorization allowing only the author or steward to attach evidence contradicts the documented agent workflow. In V2:

- one builder address, one monotonically increasing work-round number, and one work-activity height are canonical while a request is `BUILDING` or `REVIEW`;
- the assigned builder may add delivery evidence in `BUILDING` and request review;
- the configured verifier may add verification evidence in `REVIEW`, reject review, or attest shipment;
- the request author has no special evidence authority unless assigned as builder or configured in another role.

MVP evidence kinds are frozen into disjoint classes:

```rust
enum EvidenceKind {
  // Delivery class; assigned builder only in BUILDING
  PullRequest,
  Commit,
  Release,
  Deployment,
  Document,

  // Verification class; configured verifier only in REVIEW
  TestReport,
  AuditReport,
  ReviewRecord,
}
```

Evidence is immutable provenance:

```rust
Evidence {
  id: u64,
  request_id: u64,
  submitter: Addr,
  kind: EvidenceKind,
  uri: String,
  digest: String,
  note: String,
  work_round: u32,
  submitted_at: Timestamp,
  submitted_height: u64,
}
```

Evidence IDs are request-local and monotonically increasing. Every item requires an `https://` or `ipfs://` URI with a non-empty locator and a `sha256:<64 lowercase hex>` digest, regardless of URI scheme. The digest is a submitter assertion: the contract validates syntax and authority but does not fetch or hash external content.

`RequestReview` carries a non-empty bounded list of unique evidence IDs. Every ID must belong to this request and current round and identify delivery-class evidence from the current builder; failure leaves the request in `BUILDING`.

`SHIPPED` requires a distinct verification attestation:

```rust
ShipmentAttestation {
  verifier: Addr,
  rationale: String,
  evidence_ids: Vec<u64>,
  work_round: u32,
  submitted_at: Timestamp,
  submitted_height: u64,
}
```

The exact `REVIEW → SHIPPED` predicate is:

1. sender is the configured verifier and differs from the assigned builder;
2. rationale is non-empty and bounded and explicitly attests that the immutable acceptance criteria were met;
3. the bounded reference list is non-empty and unique, and all referenced evidence exists on this request and in the current work round;
4. at least one referenced item is delivery-class evidence submitted by the currently assigned builder; and
5. at least one different referenced item is verification-class evidence submitted by the current verifier.

No evidence kind can satisfy both classes. `QUALIFIED → BUILDING` initializes work round 1. Every later transition from `REVIEW` or `BLOCKED` into `BUILDING` increments the round, including a same-builder resume, so evidence from abandoned, rejected, or prior assignments cannot satisfy a later shipment predicate.

Product copy should say **attested shipment** or **delivery attestation**, not cryptographic proof of correctness.

## 10. Duplicate requests

Duplicates are a subjective moderation decision, not an automatic contract fact.

- `DUPLICATE` records an immutable `canonical_request_id` and reason.
- The canonical target must exist, have an earlier ID, and not itself be `DUPLICATE` or `SPAM`.
- A reverse-reference count/index is maintained. Any request referenced as canonical can no longer transition to `DUPLICATE` or `SPAM`, preventing chains and poisoned canonical pointers.
- Votes remain attached to the original request and are never merged or transferred because requests may have different briefs, snapshots, and electorates.
- Duplicate bonds are refundable.
- UIs may provide derived similarity suggestions before submission, but they are not consensus-critical.

## 11. Pause and recovery

A submission pause blocks only new requests. Voting, permissionless finalization, evidence, review, lifecycle recovery, and refunds remain available.

The governor and steward may pause submissions with a reason. Only the governor may unpause or change durable configuration.

If the historical-total consistency check mismatches, the vote fails without state changes and clients show `SNAPSHOT_INTEGRITY_MISMATCH`. This does not detect every exact-height history failure. Operators may pause new submissions while externally verifying chain history. Recovery is a disclosed governor action, not a mechanically proven contract fact: while submissions are paused, the governor may emergency-archive an `OPEN` request with refund and a typed `SnapshotHistoryRisk` reason. Ordinary steward `OPEN → ARCHIVED` is not allowed.

Entering or re-entering `BUILDING` sets the canonical work-activity height; successful delivery evidence by the current builder resets it and unrelated actions do not. Steward-forced `BUILDING → BLOCKED` requires checked `height >= work_activity_height + copied_timeout`; overflow means not elapsed. The builder may voluntarily block earlier.

## 12. Configuration mutability

Immutable after instantiate:

- native denom;
- contract identity.
- evidence policy version 1;
- lifecycle/protocol reason bound;
- default and maximum query page bounds.

Future requests only; values are copied into each new request:

- submission bond amount;
- voting period;
- quorum and support thresholds;
- work inactivity timeout; and
- request limits, including all string, URI, digest, evidence-count, review-reference, and attestation-reference limits.

Immediate:

- pause state;
- governor transfer after acceptance; and
- steward and verifier replacement after governor action.

MVP evidence policy version 1 is fixed to exactly `1` at instantiate and permits only the kinds, schemes, digest syntax, and role/status matrix in Section 9. Instantiate and future-request limit updates require `max_uri_bytes >= 9`, `max_digest_bytes >= 71`, `max_evidence_items >= 2`, `max_review_evidence_refs >= 1`, and `max_attestation_evidence_refs >= 2`; the URI minimum admits a non-empty locator under either accepted scheme, both reference maxima must not exceed `max_evidence_items`, and every other byte/count limit is nonzero. Existing requests are always completed under the copied policy and limits they were submitted with; configuration changes cannot make required evidence, review, or shipment structurally unreachable.

## 13. Bounded public schema

Accepted schema defaults (deployment overrides remain launch choices):

| Field | Bound |
|---|---:|
| Title | 120 bytes |
| Summary | 2,000 bytes |
| Acceptance criteria | 4,000 bytes |
| Category slug | 32 bytes |
| URI | 512 bytes |
| Digest | 71 bytes for `sha256:` plus hex |
| Evidence note | 1,024 bytes |
| Lifecycle/attestation reason | 1,024 bytes |
| Evidence items per request | 64 |
| Review evidence references | 16 |
| Attestation evidence references | 16 |
| Query page size | immutable contract-wide default 30, maximum 100 |

Status history is not the complete audit model. Canonical state contains bounded, paginated typed logs:

```text
REQUEST_ACTIONS:  (request_id, action_id) → RequestActionRecord
PROTOCOL_ACTIONS: action_id → ProtocolActionRecord
```

`RequestAction` covers submission, vote finalization, status transition, duplicate link, builder assignment/reassignment, evidence addition, review rejection, shipment attestation, bond-state transition, and refund claim. `ProtocolAction` covers pause/unpause, configuration update, governor transfer, steward replacement, verifier replacement, and migration record. Each record stores actor, height, timestamp, bounded reason where applicable, and typed old/new values or referenced IDs. Queries paginate by monotonically increasing action ID with the same page bounds as other list queries.

Status history records contain:

```rust
StatusHistoryRecord {
  request_id: u64,
  from: Option<Status>,
  to: Status,
  actor: Addr,
  reason: String,
  evidence_ids: Vec<u64>,
  height: u64,
  timestamp: Timestamp,
}
```

Events mirror action records for indexing but are not the only audit source. Current state plus these logs must reproduce role, config, pause, assignment, moderation, bond, evidence, and attestation history. The canonical architecture now fixes the execute/query variants, filters, cursors, limits, and typed behavior; generated JSON schema and exact encoding vectors must match it.

## 14. Indexer and direct RPC

Direct RPC should be the primary MVP path for bounded status-ranked and status-plus-category-ranked lists, request detail, and typed histories. Text search and cross-request activity indexing are deferrable. Mutable-list responses expose query height and weak-consistency semantics as specified in Section 5.

When an indexer is added, responses expose:

- chain ID and contract address;
- indexed height and current RPC height;
- schema version;
- stale/lag state;
- a direct-chain verification path.

The indexer never becomes authoritative for votes, ranking inputs, lifecycle, evidence, bonds, or attestations.

## 15. Migration and release posture

Migration design and rehearsal do not gate starting MVP implementation. Production upgrade policy is a launch concern. If launch is upgradeable, the chain admin remains an effective bond custodian and must be a disclosed DAO or threshold multisig; no unilateral production admin may accept bonds. Launch review must define version/CW2 checks, preservation and invariant checks for all canonical state, disclosure metadata, and the lack of automatic rollback.

Testnet smoke coverage must include duplicate, spam, insufficient participation, negative net signal, awaiting finalization, stale/block/reassign, snapshot mismatch, submission-only pause continuity, refunds, and the full distinct-verifier shipment predicate. Migration smoke is required only if the selected launch policy is upgradeable.

## 16. Accepted decision disposition

### Accepted architecture decisions

- Keep `SUPPORT / OPPOSE` rather than support-only voting.
- Remove `ACCEPTED`; operational commitment begins with explicit builder assignment into `BUILDING`.
- Require immutable inline acceptance criteria.
- Add canonical builder assignment and builder-controlled review request.
- Define `SHIPPED` as a separate verifier attestation tied to evidence.
- Add terminal refundable `DUPLICATE` with a canonical target.
- Adopt the exact lifecycle and independent bond state above.
- Split chain admin, governor, steward, and verifier authority.
- Accept exact-height snapshot retention as an external chain trust assumption; keep total-power equality only as a consistency check.
- Use submission-only pause, typed emergency recovery, signed-safe canonical ranking, category-aware indexes, and filter-bound full-key cursors.
- Keep direct RPC primary for MVP.
- Preserve chain-admin custody disclosure; production upgrade/migration policy is a launch concern and does not gate starting MVP implementation.

### Launch parameters

The accepted canonical architecture selects the intended MVP profile: `juno-1` production target, `uni-7` exact-artifact smoke, 10 JUNO bond, 432,000-block voting and inactivity windows, 50 bps quorum, 5,001 bps support, documented Juno Agents DAO/Juno agent roles, and a pinned design-system source subtree. These are deployment inputs rather than universal protocol constants and require live pre-deployment revalidation; see canonical `ARCHITECTURE.md` for exact values and addresses.

## 17. Rejected alternatives for MVP

- binding governance or treasury execution;
- live-balance or mutable voting;
- support-only, quadratic, conviction, delegated, or time-decay voting;
- builder bonds, bounties, or automatic payouts;
- automatic duplicate merging or vote transfer;
- automatic external artifact verification;
- permissionless self-service work claims;
- comments and discussion stored on-chain;
- consensus-critical indexer/search;

## 18. Implementation disposition

Architecture V2 is accepted and canonical documents now govern implementation. The intended launch addresses and numeric profile are selected, while production migration design remains a launch concern. MVP work may begin; deployment, accepting funds, and production custody still require live revalidation, launch disclosures, retained-history checks, artifact smoke, and independent review specified by the canonical architecture and plan.

## Sources reviewed

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`ADR-001: fixed snapshot power`](./decisions/001-fixed-snapshot-power.md)
- [`ADR-002: non-binding prioritization`](./decisions/002-non-binding-prioritization.md)
- [`ADR-003: chain-canonical state`](./decisions/003-chain-canonical-index-derived.md)
- [`PRODUCT_DESIGN.md`](../design/PRODUCT_DESIGN.md)
- [`2026-07-23-mvp.md`](../plans/2026-07-23-mvp.md)
- GitHub issue #1 and its architecture-readiness comments
- Juno v30 voting-snapshot custom-query source pinned in the canonical architecture
