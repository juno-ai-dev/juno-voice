# Juno Voice architecture

**Status:** proposed  
**Scope:** MVP architecture; no deployment authorization  
**Chain dependency:** Juno v30 `x/voting-snapshot`

## 1. Goal

Create a neutral, auditable roadmap where:

- any wallet can submit a scoped feature request with an anti-spam deposit;
- Juno stakers can support requests with power fixed at a declared historical block;
- agents can discover the ranked backlog through stable queries;
- maintainers can move work through a transparent lifecycle; and
- builders can attach content-addressed delivery evidence.

Juno Voice is **prioritization**, not binding governance. It cannot spend treasury funds, upgrade contracts, or execute arbitrary messages.

## 2. System boundary

```text
┌──────────────────────┐       tx/query       ┌────────────────────────┐
│ Web UI / agent client│ ───────────────────▶ │ Juno Voice CosmWasm    │
│ Juno Design System   │ ◀─────────────────── │ contract               │
└──────────┬───────────┘                       └───────────┬────────────┘
           │ indexed reads                                 │ custom query
           ▼                                               ▼
┌──────────────────────┐                       ┌────────────────────────┐
│ Optional indexer/API │                       │ Juno x/voting-snapshot │
│ derived, non-trusted │                       │ historical stake power │
└──────────────────────┘                       └────────────────────────┘
           │
           ▼
┌──────────────────────┐
│ GitHub / IPFS / HTTPS│
│ evidence destinations│
└──────────────────────┘
```

### Trust boundaries

- **Consensus truth:** request records, snapshot height, weighted support, lifecycle events, and evidence references live in contract state.
- **Chain truth:** voting power comes from Juno's voting-snapshot custom query.
- **Presentation only:** search, analytics, notifications, previews, and cached ranking may be indexed off-chain and must be reproducible from chain events/state.
- **External evidence:** GitHub/IPFS/HTTPS content is not trusted merely because a URI was submitted. The record includes a digest where practical and clearly identifies who attested it.
- **Privileged actions:** a configurable steward address may moderate malformed/spam content and advance lifecycle state, but cannot alter recorded votes or snapshot heights. A DAO can replace the steward later.

## 3. Snapshot semantics

Juno v30 exposes contract custom queries:

```json
{"voting_power_at":{"address":"juno1…","height":123}}
{"total_voting_power_at":{"height":123}}
```

The module returns the most recent snapshot **at or before** the requested height. Power is a base-10 unsigned string and must be checked into `Uint128`. The module records staking changes during EndBlock and backfilled history starts at its activation height. Power is bonded JUNO delegated to validators currently in `Bonded` status.

Governance-allowlisted LST addresses receive zero direct power and their bonded stake is removed from total power. The v30 default allowlist is empty: an unlisted LST therefore behaves like an ordinary staking account until governance classifies it. Allowlist updates affect snapshots from their update height forward; they do not rewrite prior history.

For Juno Voice, every request stores an immutable `snapshot_height` chosen as the **last fully settled block when the request opens**. If creation executes in block `H`, the contract stores `H - 1`. This makes the rule explicit and avoids reading the current block before its EndBlock snapshot exists.

Consequences:

- later stake movement does not change a request's electorate;
- the first request-safe height must be after the module activation/backfill boundary;
- a query that resolves before available history can return zero, so request creation must reject zero total power;
- retention parameters are governance-controlled. The contract must refuse a configuration/request window that could outlive retained history;
- exported-genesis restarts lose pre-restart history, so requests whose snapshot predates a restart boundary cannot safely accept new votes.

Deployment governance must keep retained history longer than the maximum active voting age. If an upgrade or restart removes a still-open request's history, the contract must not silently reinterpret zero power as a valid electorate; the operational response is to pause new requests and expire or migrate affected requests under an explicit policy.

This is related to—but separate from—the DAO DAO convention where proposal beginning height `h` reads snapshot `h - 1`.

## 4. Contract model

### Configuration

```rust
Config {
  steward: Addr,
  denom: String,                 // MVP: ujuno
  submission_deposit: Uint128,
  voting_period_blocks: u64,
  qualification_quorum_bps: u16,
  qualification_support_bps: u16,
  max_title_bytes: u16,
  max_summary_bytes: u16,
  evidence_uri_schemes: Vec<String>,
}
```

### Request

```rust
Request {
  id: u64,
  author: Addr,
  title: String,
  summary: String,
  category: Category,
  acceptance_uri: Option<String>,
  content_hash: Option<String>,
  deposit: Coin,
  snapshot_height: u64,
  total_power: Uint128,
  opened_height: u64,
  closes_height: u64,            // end-exclusive
  quorum_bps: u16,               // copied from config at creation
  support_bps: u16,              // copied from config at creation
  status: Status,
  support_power: Uint128,
  oppose_power: Uint128,
  voter_count: u64,
  created_at: Timestamp,
  updated_at: Timestamp,
}
```

### Vote receipt

```rust
VoteReceipt {
  request_id: u64,
  voter: Addr,
  choice: Support | Oppose,
  power: Uint128,
  cast_height: u64,
}
```

One receipt per `(request_id, voter)`. MVP votes are immutable after casting. This makes tally behavior simple and prevents repeated custom queries and vote flipping games.

### Evidence

```rust
Evidence {
  id: u64,
  request_id: u64,
  submitter: Addr,
  kind: Commit | PullRequest | Deployment | TestReport | Other,
  uri: String,
  digest: Option<String>,
  note: String,
  submitted_at: Timestamp,
}
```

### Lifecycle

```text
DRAFT (off-chain only)
  └─ submit ─▶ OPEN ── close ─▶ QUALIFIED / NOT_PRIORITIZED
                             └▶ ACCEPTED ─▶ BUILDING ─▶ REVIEW ─▶ SHIPPED
                                              └───────────────▶ BLOCKED
OPEN / QUALIFIED / ACCEPTED ────────────────────────────────▶ ARCHIVED
OPEN / QUALIFIED / ACCEPTED ────────────────────────────────▶ SPAM
```

- Voting is allowed while `opened_height <= env.block.height < closes_height`.
- `OPEN → QUALIFIED` is permissionless and deterministic at or after `closes_height`: participation quorum is `(support + oppose) / total_power`; support is `support / (support + oppose)`, with a defined zero-denominator failure. Both thresholds are copied into the request at creation.
- `QUALIFIED → ACCEPTED` and delivery states are steward actions with public reason/evidence.
- Every status change emits an event and appends immutable history.
- `SHIPPED` requires at least one evidence item; it is an attestation, not proof that external code is safe.

### Execute messages

- `SubmitRequest { … }` — exact configured deposit required.
- `CastVote { request_id, choice }` — queries power at immutable snapshot and stores receipt.
- `CloseRequest { request_id }` — permissionless after closing height.
- `SetStatus { request_id, status, reason }` — steward only; constrained transition graph.
- `AddEvidence { request_id, … }` — request author or steward in MVP.
- `ModerateRequest { request_id, reason }` — steward; preserves record and reason.
- `WithdrawRefund { request_id }` — pull-payment refund when policy permits.
- `UpdateConfig { … }` — steward; affects future requests only.

### Queries

- `Config {}`
- `Request { id }`
- `Requests { status, category, author, start_after, limit, order_by }`
- `Vote { request_id, voter }`
- `Votes { request_id, start_after, limit }`
- `Evidence { request_id, start_after, limit }`
- `StatusHistory { request_id, start_after, limit }`
- `RankedRequests { status, category, start_after, limit }`

The canonical ranking key for MVP is `net_support = support_power - oppose_power`, with deterministic tie-breaks by `support_power`, then oldest request ID. The UI also displays raw support, opposition, participation, and voter count so ranking is not a black box.

## 5. Deposits and moderation

The submission deposit is an anti-spam bond, not a purchase of priority.

Proposed MVP policy:

- exact `ujuno` deposit on submission;
- refundable after a valid request reaches `QUALIFIED`, `ACCEPTED`, or `SHIPPED`;
- refundable on steward archive unless explicitly marked as spam;
- forfeited only through a reasoned `SPAM` moderation action;
- forfeited deposits accumulate in contract state pending a later governance-approved destination—no hidden operator withdrawal.

Use pull-based refunds to avoid making lifecycle transitions fail because a receiver cannot accept funds.

## 6. Agent interface

Agents require no private API. They use chain queries and transactions like any wallet.

A builder loop can:

1. query `RankedRequests { status: QUALIFIED }`;
2. inspect acceptance criteria and evidence links;
3. claim work off-chain or through a later explicit `ClaimWork` extension;
4. publish commits/PRs/tests;
5. call `AddEvidence`;
6. ask the steward/DAO to advance the lifecycle.

MVP deliberately avoids automatic code execution, arbitrary callbacks, agent custody, treasury payouts, and GitHub OAuth inside the contract.

## 7. Indexing and UI

The contract is authoritative but not a search engine. The production UI may use an indexer for text search, categories, activity feeds, and ranking pages. Every indexed response should include the chain height used and support a direct RPC fallback for request detail.

Wallet signing must show:

- request ID and title;
- selected vote;
- snapshot height;
- immutable voting power to be recorded;
- attached funds, if any.

## 8. Security requirements

- Validate all addresses and checked-convert signed heights/power strings.
- Store `H - 1` with saturation/explicit genesis rejection; never query unsettled current height.
- Reject request creation if total snapshot power is zero.
- Bound all strings, list limits, and evidence count/size.
- Require exact deposit denom/amount; reject extra funds.
- Use indexed maps and bounded pagination; never iterate every voter during execution.
- Update aggregate tallies atomically with receipt creation.
- Evaluate basis-point thresholds with checked wide-integer cross-multiplication; avoid lossy division and define zero denominators explicitly.
- Enforce the lifecycle graph and role checks in one module.
- Use pull refunds and reentrancy-safe state-before-message order.
- Protect migration with CW2 contract identity/version checks.
- Test custom-query wire JSON exactly and smoke the final Wasm against a live Juno v30 chain before deployment.

## 9. MVP non-goals

- binding governance or treasury execution;
- quadratic, conviction, delegated, or time-decay voting;
- one-agent-one-vote identity claims;
- bounties and automatic payouts;
- comments stored on-chain;
- arbitrary attachments stored on-chain;
- mutable votes;
- private requests;
- cross-chain voting power.

## 10. Authoritative implementation references

Verified against [`CosmosContracts/juno@c0b3a8d` (`v30.0.0`)](https://github.com/CosmosContracts/juno/tree/c0b3a8d258d52d16e5bc39a75168a99aab9d098e):

Verification command: `go test ./x/voting-snapshot/keeper ./wasmbindings/...` — keeper and binding tests passed; packages without tests compiled successfully.

- [`proto/juno/votingsnapshot/v1/query.proto`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/proto/juno/votingsnapshot/v1/query.proto) — REST/gRPC methods, at-or-before behavior, string power.
- [`proto/juno/votingsnapshot/v1/params.proto`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/proto/juno/votingsnapshot/v1/params.proto) — LST allowlist, retention, pruning controls.
- [`wasmbindings/types/query.go`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/wasmbindings/types/query.go) — exact custom-query JSON shape.
- [`wasmbindings/queries.go`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/wasmbindings/queries.go) — address validation, gas charge, keeper dispatch.
- [`x/voting-snapshot/keeper/snapshot.go`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/x/voting-snapshot/keeper/snapshot.go) — at-or-before store lookup.
- [`x/voting-snapshot/keeper/abci.go`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/x/voting-snapshot/keeper/abci.go) — EndBlock snapshot settlement.
- [`x/voting-snapshot/keeper/backfill.go`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/x/voting-snapshot/keeper/backfill.go) — activation-height backfill.
- [`x/voting-snapshot/keeper/genesis.go`](https://github.com/CosmosContracts/juno/blob/c0b3a8d258d52d16e5bc39a75168a99aab9d098e/x/voting-snapshot/keeper/genesis.go) — exported-genesis history boundary.
