# Juno Voice architecture

**Status:** Accepted (Architecture V2)
**Scope:** MVP architecture; no deployment authorization  
**Chain dependency:** Juno v30 `x/voting-snapshot`

## 1. Product boundary

Juno Voice is a neutral, chain-auditable roadmap prioritization and delivery-attestation system:

- any wallet can submit a bounded request with immutable inline acceptance criteria and an anti-spam bond;
- JUNO stakers cast one immutable `SUPPORT` or `OPPOSE` vote using historical power fixed per request;
- deterministic thresholds and signed net support produce an inspectable signal;
- a steward selects qualified work and assigns a builder;
- the assigned builder supplies delivery evidence and a distinct verifier attests shipment; and
- humans and agents can reproduce canonical state through direct chain queries.

Juno Voice is **non-binding prioritization**. It cannot spend treasury funds, bind Juno governance, upgrade itself, or execute arbitrary messages. Selection and shipment attestations are accountable judgments, not community mandates or cryptographic proof that software is correct.

The MVP excludes bounties, builder bonds, automatic payouts or execution, mutable/delegated/quadratic/conviction voting, identity claims, automatic duplicate merging, comments or files on-chain, private requests, and cross-chain power.

## 2. Trust and authority boundaries

- **Contract truth:** briefs, snapshot inputs, receipts and tallies, lifecycle, bonds, assignments, evidence, attestations, and typed action logs.
- **Chain truth:** historical voting power returned by Juno's voting-snapshot binding.
- **External evidence:** an evidence digest is the submitter's assertion; the contract validates syntax and authority but does not fetch or verify content.
- **Derived presentation:** optional search, analytics, notifications, and caches can be rebuilt and never become authoritative.
- **Chain contract admin:** can replace code through CosmWasm migration and is consequently an effective custodian of all locked/refundable bonds.
- **Governor:** controls durable configuration and replaces operational roles.
- **Steward:** moderates, selects work, assigns/reassigns builders, and performs stale-work recovery.
- **Verifier:** adds verification evidence, rejects/blocks review, and attests shipment.
- **Builder:** a request- and work-round-specific assignee who adds delivery evidence and requests review.

These are separate authorities in the contract permission model. For every shipment, current builder and verifier must be distinct addresses. Governor transfer uses propose/accept semantics; steward and verifier cannot replace the governor or themselves. No role may edit briefs, votes, snapshots, evidence, attestations, prior logs, duplicate targets, bond ownership, or refund recipients.

A production chain admin and governor must be a disclosed DAO or threshold multisig; a unilateral admin must not accept production bonds. Addresses, powers, review process, and any enforceable delay are launch disclosures.

## 3. Fixed snapshot and retention trust

If submission executes in block `H`, the request stores `snapshot_height = H - 1`, rejecting genesis/underflow. Submission queries and stores nonzero total power `T` at that height. Juno returns the most recent snapshot **at or before** the requested height; power is a base-10 unsigned value checked into `Uint128`. Snapshots settle during EndBlock, which is why current height is not used.

Each wallet can cast one immutable receipt containing `SUPPORT` or `OPPOSE`, historical voter power, and cast height. Every vote re-queries total power and requires it to be nonzero and equal to stored `T`; mismatch returns `SnapshotIntegrityMismatch` without state changes.

The current binding does not return the height actually resolved or expose retention configuration. Equal totals are only a consistency check and **do not prove exact-height availability**, because an older snapshot can have the same total and different account powers. Retention is an accepted external deployment trust assumption.

Deployment policy must:

- set a positive voting duration no longer than two months;
- derive `voting_period_blocks` for the target chain rather than claim a universal hardcoded block count;
- verify retained history exceeds that duration with a documented safety margin; and
- monitor retention, upgrades, activation/exported-genesis boundaries, and restarts.

This trust assumption does not gate MVP implementation. If history becomes suspect, operators use the submission-only pause and typed recovery in Section 10.

## 4. Canonical schema

```rust
Config {
  governor: Addr,
  pending_governor: Option<Addr>,
  steward: Addr,
  verifier: Addr,
  native_denom: String,          // immutable; deployment choice
  submission_bond: Uint128,
  voting_period_blocks: u64,     // > 0; deployment policy <= two months
  quorum_bps: u16,
  support_bps: u16,
  work_inactivity_blocks: u64,
  request_limits: RequestLimits,
  max_reason_bytes: u16,         // immutable contract-wide
  default_query_limit: u8,       // immutable contract-wide
  max_query_limit: u8,           // immutable contract-wide
  evidence_policy_version: u16, // MVP = 1
  submissions_paused: bool,
}

RequestLimits {
  max_title_bytes: u16,
  max_summary_bytes: u16,
  max_acceptance_criteria_bytes: u16,
  max_category_bytes: u8,
  max_uri_bytes: u16,
  max_digest_bytes: u8,
  max_evidence_note_bytes: u16,
  max_evidence_items: u16,
  max_review_evidence_refs: u8,
  max_attestation_evidence_refs: u8,
}

Request {
  id: u64,
  author: Addr,
  title: String,
  summary: String,
  acceptance_criteria: String,
  category: String,
  detail_uri: Option<String>,
  detail_digest: Option<String>,
  canonical_request_id: Option<u64>,
  snapshot_height: u64,
  total_power: Uint128,
  opened_height: u64,
  closes_height: u64,           // end-exclusive
  quorum_bps: u16,
  support_bps: u16,
  work_inactivity_blocks: u64,
  limits: RequestLimits,
  evidence_policy_version: u16,
  status: Status,
  support_power: Uint128,
  oppose_power: Uint128,
  voter_count: u64,
  bond: Bond,
  builder: Option<Addr>,
  work_round: u32,
  work_activity_height: Option<u64>,
  created_at: Timestamp,
  updated_at: Timestamp,
}

VoteReceipt {
  request_id: u64,
  voter: Addr,
  choice: Support | Oppose,
  power: Uint128,
  cast_height: u64,
}

Bond { amount: Uint128, state: Locked | Refundable | Claimed | Forfeited }
BondTotals { locked: Uint128, refundable: Uint128, forfeited: Uint128 }
```

The brief is required, bounded, inline, immutable, and canonical. `category` is a lowercase `[a-z0-9-]` slug, not a closed enum. Supplementary detail fields accept exactly `(None, None)` or `(Some(uri), Some(digest))`; either unpaired form is rejected. The URI must use `https://` or `ipfs://`, and the digest must be `sha256:<64 lowercase hex>`. Material corrections create a new request.

Configuration values copied into a request cannot rewrite active behavior. `native_denom`, contract identity, MVP evidence policy version 1, reason bound, and query page bounds are immutable. Governor updates to bond, voting period, thresholds, inactivity timeout, and request limits affect future requests only. Pause and role changes are immediate. A later code version may introduce a new, fully specified evidence policy version without changing version 1 semantics.

Instantiate and future-config validation require: non-empty valid native denom; nonzero bond; nonzero voting and inactivity periods; `1 <= quorum_bps <= 10,000`; `1 <= support_bps <= 10,000`; valid distinct role addresses where a rule requires address distinction; every byte/count limit nonzero; `default_query_limit <= max_query_limit`; and checked `opened_height + voting_period_blocks`. The contract applies the same validation to every updated field set before changing configuration.

### Accepted schema defaults

These defaults are instantiate values and may be deployment-configured within schema validation; addresses and economic/numeric policy remain deployment choices.

| Field | Default bound |
|---|---:|
| Title | 120 bytes |
| Summary | 2,000 bytes |
| Acceptance criteria | 4,000 bytes |
| Category slug | 32 bytes |
| URI | 512 bytes |
| Digest | 71 bytes (`sha256:` plus hex) |
| Evidence note | 1,024 bytes |
| Lifecycle/attestation reason | 1,024 bytes |
| Evidence items per request | 64 |
| Review evidence references | 16 |
| Attestation evidence references | 16 |
| Query page size | immutable contract-wide default 30, maximum 100 |

All strings are UTF-8 byte-bounded. Reasons required by transitions are non-empty. Counts are enforced before writes.

## 5. Voting, closing, and lifecycle

Voting is allowed exactly while `opened_height <= height < closes_height`. At or after close, anyone can finalize an `OPEN` request. For `S = support`, `O = oppose`, and `P = S + O`, qualification requires:

```text
P > 0
P * 10,000 >= T * quorum_bps
S * 10,000 >= P * support_bps
```

Checked wide-integer cross multiplication is mandatory. Passing yields `QUALIFIED`; failure yields `NOT_PRIORITIZED`.

| Transition | Controller | Guard/effect |
|---|---|---|
| submission → `OPEN` | any wallet | valid immutable brief and exact bond |
| `OPEN → QUALIFIED` / `NOT_PRIORITIZED` | anyone | deterministic close formula |
| `OPEN → SPAM` | steward | reason; locked bond forfeited |
| `OPEN/QUALIFIED → DUPLICATE` | steward | valid canonical target and reason |
| `QUALIFIED → BUILDING` | steward | assign builder; initialize work round 1 and activity height |
| `QUALIFIED → ARCHIVED` | steward | reason |
| `BUILDING → REVIEW` | assigned builder | exact bounded current-round delivery references |
| `BUILDING → BLOCKED` | assigned builder | reason |
| `BUILDING → BLOCKED` | steward | copied inactivity timeout elapsed from work activity; reason |
| `REVIEW → SHIPPED` | verifier | exact attestation predicate |
| `REVIEW → BUILDING` | verifier | rejection reason; increment round and reset activity height |
| `REVIEW → BLOCKED` | verifier | reason |
| `BLOCKED → BUILDING` | steward | assign/reassign; increment round and reset activity height |
| `BLOCKED → ARCHIVED` | steward | reason |

`NOT_PRIORITIZED`, `DUPLICATE`, `SPAM`, `ARCHIVED`, and `SHIPPED` are terminal. `DRAFT` is off-chain only. There is no `ACCEPTED`: operational commitment starts only with builder assignment into `BUILDING`. Every re-entry into `BUILDING`, including same-builder resume, increments the work round so old-round evidence cannot satisfy shipment.

The frozen status codes used by ranking keys/cursors are `OPEN=1`, `QUALIFIED=2`, `NOT_PRIORITIZED=3`, `DUPLICATE=4`, `SPAM=5`, `BUILDING=6`, `REVIEW=7`, `BLOCKED=8`, `ARCHIVED=9`, and `SHIPPED=10`. They are schema values, not an implied lifecycle order.

Clients display `OPEN && height >= closes_height` as `AWAITING_FINALIZATION`; this is derived UI state, not a stored status. A non-trusted keeper can call the same public close method.

A duplicate stores immutable `canonical_request_id` and reason. Its target must exist, have an earlier ID, and not be `DUPLICATE` or `SPAM`. A reverse-reference index prevents a referenced target later becoming duplicate or spam. Votes never merge or transfer.

## 6. Independent bond lifecycle

Bond state is independent of request status:

```text
LOCKED → REFUNDABLE → CLAIMED
LOCKED → FORFEITED
```

- Submission requires exactly the configured native-denom bond; every other execute rejects attached funds.
- `NOT_PRIORITIZED`, `QUALIFIED`, `DUPLICATE`, non-spam `ARCHIVED`, and emergency archival make a locked bond irrevocably refundable.
- Only `OPEN → SPAM` can forfeit a locked bond; refundable/claimed bonds cannot be forfeited.
- Only the author may withdraw, and funds always return to that author.
- Refunds are pull payments with state updated before the bank message.
- Forfeited funds are accounted for but have no withdrawal path in MVP.
- Request bond and aggregate totals update atomically. Native-denom balance must cover `locked + refundable + forfeited`; unsolicited bank sends are surplus and create no claim.

## 7. Assignment, evidence, and shipment

```rust
Evidence {
  id: u64,                       // request-local, increasing
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

EvidenceKind = PullRequest | Commit | Release | Deployment | Document
             | TestReport | AuditReport | ReviewRecord

ShipmentAttestation {
  verifier: Addr,
  rationale: String,
  evidence_ids: Vec<u64>,
  work_round: u32,
  submitted_at: Timestamp,
  submitted_height: u64,
}
```

The first five kinds are delivery class (current builder in `BUILDING`); the last three are verification class (current verifier in `REVIEW`). No kind belongs to both. Every item requires `https://` or `ipfs://` and a valid SHA-256 digest.

`RequestReview` accepts a non-empty list of at most the request-copied `max_review_evidence_refs`. IDs must be unique, exist on this request and current round, and each must be delivery-class evidence submitted by the current builder. Failure rejects without changing status. A successful request stores the references in status history and enters `REVIEW`.

`REVIEW → SHIPPED` requires all of:

1. sender is configured verifier and differs from current builder;
2. bounded non-empty rationale explicitly attests the immutable acceptance criteria were met;
3. the reference list is non-empty, unique, no longer than copied `max_attestation_evidence_refs`, and every ID exists on this request and current round;
4. at least one reference is delivery-class evidence submitted by the current builder; and
5. at least one *different* reference is verification-class evidence submitted by the current verifier.

Product copy says **attested shipment** or **delivery attestation**, never proof of correctness.

## 8. Ranking and pagination

Canonical rank within a status is signed `S - O` descending, then `S` descending, then oldest request ID ascending. Never subtract `Uint128` directly. Maintain both indexes atomically:

```text
STATUS_RANK:          (status, rank_key) → request_id
STATUS_CATEGORY_RANK: (status, category, rank_key) → request_id
```

Descending `rank_key` is fixed-width:

```text
version:u8 = 1
sign_bucket:u8       // 1 for net >= 0; 0 for net < 0
sortable_net:[u8;16] // magnitude if nonnegative; MAX - magnitude if negative
support:[u8;16]      // big-endian
reverse_id:[u8;8]    // u64::MAX - request_id, big-endian
```

Zero is nonnegative. Numeric status codes and cursor version are frozen public schema. The opaque cursor is base64url without padding over:

```text
cursor_version:u8 | schema_version:u16 | status:u8 | category_length:u8
| category:utf8 | rank_key
```

Decode rejects unknown versions, malformed lengths/UTF-8/category, and filters differing from the current query. Exact encoding/ordering vectors are required in tests. Mutable `OPEN` pagination is weakly consistent: responses include query height and clients refresh from page one for a current view.

The UI displays raw support, opposition, participation, total power, voter count, snapshot height, and whether a number is canonical rank or filtered position.

## 9. Public execute/query surface and audit logs

Execute variants are:

- `SubmitRequest { title, summary, acceptance_criteria, category, detail_uri, detail_digest }`
- `CastVote { request_id, choice }`; `CloseRequest { request_id }`
- `MarkSpam { request_id, reason }`; `MarkDuplicate { request_id, canonical_request_id, reason }`; `ArchiveRequest { request_id, reason }` (steward, only `QUALIFIED` or `BLOCKED`)
- `StartBuilding { request_id, builder, reason }`; `BlockBuilding { request_id, reason }`; `ResumeBuilding { request_id, builder, reason }`
- `AddEvidence { request_id, kind, uri, digest, note }`; `RequestReview { request_id, reason, evidence_ids }`
- `RejectReview { request_id, reason }`; `BlockReview { request_id, reason }`; `AttestShipment { request_id, rationale, evidence_ids }`
- `WithdrawRefund { request_id }`
- `PauseSubmissions { reason }`; `UnpauseSubmissions { reason }`; `EmergencyArchiveOpen { request_id, reason: SnapshotHistoryRisk }`
- `UpdateConfig { submission_bond, voting_period_blocks, quorum_bps, support_bps, work_inactivity_blocks, request_limits, reason }` (optional update fields, future requests only); `ProposeGovernor { address, reason }`; `CancelGovernorTransfer { reason }`; `AcceptGovernor { reason }`; `ReplaceSteward { address, reason }`; and `ReplaceVerifier { address, reason }` (replacement messages are governor-only except acceptance).

Queries are:

- `Config {}`, `BondTotals {}`, `Request { id }`, and `ShipmentAttestation { request_id }`;
- `Requests { status, category, author, start_after_id, limit }`;
- `Vote { request_id, voter }` and `Votes { request_id, start_after_voter, limit }`;
- `Evidence { request_id, start_after_id, limit }` and `StatusHistory { request_id, start_after_id, limit }`;
- `RequestActions { request_id, start_after_id, limit }` and `ProtocolActions { start_after_id, limit }`; and
- `RankedRequests { status, category, cursor, limit }`.

Optional filters/cursors/limits are represented by `Option`; `status` is required for ranked queries. Every list response includes `items`, `next_cursor` (or `next_start_after` for ID/address order), and `query_height`, and enforces the accepted page bounds.

Canonical typed logs are:

```text
REQUEST_ACTIONS:  (request_id, action_id) → RequestActionRecord
PROTOCOL_ACTIONS: action_id → ProtocolActionRecord
```

Request actions cover submission, finalization, status transition, duplicate link, assignment/reassignment, evidence, review rejection, attestation, bond transition, and refund. Protocol actions cover pause/unpause, config, governor transfer, role replacement, and migration record. Every record stores actor, height, timestamp, bounded reason where applicable, and typed old/new values or referenced IDs. Status history additionally stores from/to status and evidence IDs. Events mirror logs but are not the only audit source.

## 10. Pause and recovery

Pause blocks **only new submissions**. Voting, closing, evidence, review, recovery, and refunds continue. Governor or steward may pause with a reason; only governor may unpause or change durable configuration.

`ProposeGovernor` validates an address different from both the current governor and current pending nominee, then sets or replaces `pending_governor`; replacement is explicit in the typed log. `CancelGovernorTransfer` clears a pending proposal and rejects when none exists. Only the exact pending address may call `AcceptGovernor` with a non-empty bounded reason; acceptance atomically sets governor and clears pending state. `Config {}` exposes pending state.

A snapshot-total mismatch fails a vote without changes. Operators may pause submissions while checking history. While paused, governor may emergency-archive an `OPEN` request with a refund and typed `SnapshotHistoryRisk` reason. This is a disclosed recovery judgment, not exact-height proof. Ordinary steward `OPEN → ARCHIVED` is forbidden.

Entering or re-entering `BUILDING` sets `work_activity_height` to the current height. Successful current-builder delivery evidence in `BUILDING` resets it; unrelated actions do not. Steward-forced blocking is allowed exactly when checked addition proves `height >= work_activity_height + work_inactivity_blocks`; overflow is treated as not elapsed. A builder can block earlier voluntarily. The field remains exposed for derived stale warnings in every later status.

## 11. Direct RPC and optional indexing

Direct RPC is primary for bounded status-ranked/category-ranked lists, request detail, and typed histories. Text search and cross-request feeds are deferrable. An optional indexer exposes chain ID, contract address, schema version, indexed/current RPC heights, and lag state plus a direct-chain verification path. It is never authoritative for votes, ranking, lifecycle, evidence, bonds, or attestations.

## 12. Security and release posture

Implementation must validate addresses, checked-convert heights and powers, reject zero totals and extra funds, bound all inputs/counts/pages, use indexed maps, update receipts/tallies/ranks/bonds atomically, centralize role/transition checks, and test custom-query JSON exactly. Smoke the final Wasm against Juno v30 before deployment.

MVP implementation can start without designing or rehearsing migrations. Production upgrade/migration policy is a **launch concern**, not an implementation gate. If launch remains upgradeable, disclose the chain admin custody risk and require versioned/CW2-checked migration that preserves all canonical state. Publish checksum, code/contract IDs, schema/config, and role/admin addresses. None of the defaults below authorizes deployment or accepting funds.

### Launch defaults

These choices freeze the intended MVP deployment profile while remaining explicit instantiate/deployment inputs:

| Setting | Decision |
|---|---|
| Production chain | `juno-1` |
| Exact-artifact smoke | `uni-7`, because it permits throwaway upload/instantiate testing |
| Native denom | `ujuno` on `juno-1`; use the target chain's native denom for smoke |
| Submission bond | `10,000,000 ujuno` (10 JUNO) on `juno-1` |
| Voting period | `432,000` blocks; revalidate at deployment that observed target-chain cadence keeps the expected duration positive and no longer than two months |
| Qualification quorum | `50` bps (0.5% participation) |
| Qualification support | `5,001` bps (strictly more than 50% of participation) |
| Work inactivity timeout | `432,000` blocks |
| Chain admin and governor | Juno Agents DAO core `juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac` for the intended production profile |
| Steward | Juno agent wallet `juno1xsx746x4375g39f9fj07hr7qm0wuf0ksl0an76` for the intended production profile |
| Verifier | Juno Agents DAO core for the intended production profile; it must remain distinct from the assigned builder for every shipment |
| Design system | Pinned source subtree from `juno-ai-dev/juno-design-system` commit `0dc0ae9ae80e0378b61fc9f67cbf417f291d6f16` until a versioned package exists |

Before deployment, re-query every address and target-chain parameter, confirm admin/governor execution semantics, measure block cadence over a documented window, and publish the exact instantiated values. A material safety failure in that check is a launch blocker, not permission to silently change the accepted contract semantics.

## 13. Authoritative chain references

Verified against [`CosmosContracts/juno@c0b3a8d` (`v30.0.0`)](https://github.com/CosmosContracts/juno/tree/c0b3a8d258d52d16e5bc39a75168a99aab9d098e): voting-snapshot query/parameter protos, custom-query types/dispatch, keeper snapshot/EndBlock/backfill/genesis implementations. The source confirms at-or-before lookup, string power, EndBlock settlement, retention controls, and exported-genesis boundary.
