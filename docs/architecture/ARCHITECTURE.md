# Juno Voice backend architecture

**Status:** Accepted architecture for Juno Voice v2; implemented locally but
not release-approved or deployed

**Scope:** On-chain backend, deployment composition, and trust boundaries

**Implementation contract:** [GOAL.md](../../GOAL.md)

**Policy rationale:** [INCENTIVES_AND_GOVERNANCE.md](../design/INCENTIVES_AND_GOVERNANCE.md)

## 1. System purpose

Juno Voice turns public demand into two bounded funding loops:

1. contributors escrow native Juno behind a requested outcome and decide whether a proposed delivery receives the pooled bounty; and
2. Juno stakers direct a separately funded Hack Juno epoch among eligible projects using historical staking power.

These loops share project graduation, but not voters, funds, or settlement authority. Contributor weight comes only from bounty contributions. Gauge power comes only from one Juno staking snapshot per epoch. Juno `x/gov` remains the root authority for public funding and code administration.

## 2. Topology

```text
Juno x/gov module account
  │ external admin, funding proposals, upgrades, recovery
  ▼
Program Vault (dao-dao-core; no independent policy electorate)
  ├── application governor for bounty and registry contracts
  ├── holds bounded Hack Juno tranche and unused epoch funds
  └── executes only adapter-produced gauge payments
          ▲
          │ fixed epoch budget
          │
Epoch-snapshot gauge ◄──── dao-voting-juno-staked ◄──── x/voting-snapshot
          │
          │ validates options and requests bounded bank sends
          ▼
Hack Juno registry adapter ◄──── Agent Operations DAO
          ▲                         │ curation, graduation,
          │ authenticated           │ suspension, stop-only safety
          │ graduation              ▼
Juno Voice bounties ◄──────── contributors and delivery submitters
```

The backend consists of:

- a new Juno Voice bounty contract owned in this repository;
- a new Hack Juno project-registry gauge adapter owned in this repository;
- DAO DAO core, proposal, voting, and gauge components pinned under [`deps/dao-contracts`](../../deps/dao-contracts);
- Juno's `x/gov` and `x/voting-snapshot` chain modules; and
- deployment configuration that binds exact code identities, roles, and economic limits.

No trusted application server is required for correctness. Indexers and keepers may improve discovery and liveness but never become canonical state.

## 3. Authority model

| Authority | May | Must not |
|---|---|---|
| Juno `x/gov` | fund tranches; administer and migrate code; replace roles; resume stopped components; recover unused funds | decide an individual pooled bounty outside its contributor rules |
| Program Vault | hold the authorized tranche; act as stable application governor; execute bounded gauge messages | create an independent policy electorate or exceed its funded balance |
| Agent Operations DAO | moderate open bounties into refunds; nominate delivery; graduate, approve, suspend, or retire projects; pause/stop in one direction | pay pooled bounties; redirect principal; allocate rewards; increase budgets; unpause/resume; migrate code |
| Bounty creator | set immutable terms; contribute; nominate delivery; cancel while sole-funded | alter terms after funding; override other contributors |
| Contributors | add funds; ratify delivery at contribution weight; claim their refunds | vote with stake or transfer contribution shares |
| Juno stakers | allocate one epoch's funded budget at historical stake weight | administer contracts or promise later funding |
| Any account | finalize matured votes/epochs; expire bounties; run bounded cleanup | mutate authority or bypass state preconditions |

Authority is granted by explicit contract addresses, not by descriptive DAO/subDAO registration. The migration admin and application governor are distinct and must be queryable.

## 4. Program Vault

The Program Vault is a minimal `dao-dao-core` deployment with its external administrator set to the Juno `x/gov` module account. It exists to give the program a stable treasury and execution address while keeping constitutional decisions in Juno governance.

The vault has no general-purpose public proposal path. It:

- receives only a governance-authorized, loss-bounded program tranche;
- holds funds not allocated or not distributed by an epoch;
- acts as `governor` for the bounty and registry contracts;
- owns the gauge execution module and its economic configuration; and
- executes external-admin messages authorized by Juno governance.

The funded governance proposal must specify denomination, maximum tranche, epoch ceilings, term, and unused-funds policy. A new tranche or renewal is a new governance decision.

## 5. Bounty contract

### 5.1 Stored identity and configuration

Global configuration includes:

- immutable native denomination (`ujuno` for the first release);
- Program Vault governor address;
- replaceable Agent Operations DAO curator/guardian address;
- registry contract address;
- exact ratification duration of `259_200` seconds;
- minimum contribution and bounded bounty-lifetime parameters;
- text, evidence, pagination, and batch-work limits; and
- pause state that blocks only new economic activity.

Configuration affecting a live bounty is copied into that bounty or round, including every metadata limit used by nomination, voting, decline, cancellation, and moderation. Later governance changes cannot rewrite its electorate, deadline, metadata bounds, or settlement rule.

### 5.2 Creation and contributions

`CreateBounty` requires a positive native contribution and stores immutable bounded terms:

- title, summary, and inline acceptance criteria;
- optional content URI plus SHA-256 digest;
- expiry within configured bounds; and
- optional project-candidate metadata.

While `OPEN` and before expiry, `Contribute` adds positive `ujuno`. Repeated deposits from one address aggregate. Contributions are committed until payout or a refunding terminal path; they are not transferable and cannot be withdrawn from a live multi-contributor bounty.

The contract tracks total contributions, per-address contributions, contributor count, paid value, and outstanding refunds with checked arithmetic. Direct unsolicited bank transfers create no contribution or claim.

### 5.3 Nomination and round snapshot

The creator or Agent Operations DAO may create one active delivery nomination containing:

- recipient;
- evidence URI and digest;
- bounded rationale against the acceptance criteria; and
- optional project metadata.

Nomination freezes contributions and records a round snapshot: round number, nomination, total contribution, contributor count, each contributor's already-canonical weight, opening time, and rule version. No transition computes by iterating over all contributors.

### 5.4 Sole-contributor settlement

With exactly one contributor, nomination enters `SINGLE_CONFIRMATION`. Its deadline is the earlier of bounty expiry and `opens_at + 259,200 seconds`. The contributor must make a separate transaction before that deadline to confirm the exact recipient and evidence; confirmation marks the bounty paid before emitting one bank send. The contributor may decline, clearing the nomination and reopening the bounty unless it has expired. At or after the deadline, any account may finalize the unconfirmed nomination into refunds while preserving the pending-liability accounting transition. The refund reason is `EXPIRED` when bounty expiry has also been reached and `SOLE_CONFIRMATION_TIMEOUT` otherwise.

### 5.5 Multi-contributor ratification

With more than one contributor, nomination enters `RATIFYING`:

```text
opens_at  = nomination block time
closes_at = opens_at + 259,200 seconds
vote valid while opens_at <= block time < closes_at
finalize valid when block time >= closes_at
```

Each contributor may vote `YES` or `NO` and revise that vote before close. Weight equals that contributor's snapshotted contribution. Checked-difference updates maintain `yes_weight` and `no_weight` without scanning receipts.

After the complete window, anyone may finalize:

```text
participating_weight = yes_weight + no_weight

if participating_weight > 0 and yes_weight > no_weight:
    mark paid and send the full escrow to the nominated recipient
else:
    clear nomination and advance to the next round
```

This is deliberately a majority of **voting contribution weight**, not a quorum of all contributed funds. A tie, no votes, or a no majority never pays. Finalization cannot happen early even if every contributor votes.

A reset preserves contributions and reopens top-ups. If expiry has passed, it enters `REFUNDING` instead. Receipts remain queryable by round but can never affect a later round.

### 5.6 Refund and moderation paths

- Anyone may expire an open bounty after its deadline.
- The creator may cancel only while they are the sole contributor and no nomination is active.
- The Agent Operations DAO may moderate only an open bounty into typed `SPAM`, `DUPLICATE`, or `POLICY_VIOLATION` outcomes.
- Every such path opens pull refunds; bounty principal is never slashed.
- Each contributor claims independently, with state updated before the bank message.
- Pause does not block voting, finalization, expiry, payout claims, or refunds.

### 5.7 Bounty state machine

```text
CREATE ──► OPEN ──► SINGLE_CONFIRMATION ──confirm before deadline──► PAID
              ▲              │
              └────decline───┤
                             └──deadline/expiry finalize──► REFUNDING
              │
              └──► RATIFYING ──YES wins after 72h──► PAID
                        │
                        └──NO/tie/no vote──► OPEN or REFUNDING

OPEN ──expiry/cancel/moderation──► REFUNDING ──pull claims──► REFUNDED
```

## 6. Project registry adapter

The adapter combines a governed project registry with a deliberately narrow gauge message boundary.

### 6.1 Stable project records

Each record uses an immutable, registry-assigned, monotonically increasing
numeric project ID and contains:

- metadata URI and digest;
- current and pending payout addresses;
- admission path and optional source bounty contract plus bounty ID;
- native registration bond, if any;
- `PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED`, or `RETIRED` status; and
- typed status/address history.

An address is a payout destination, not project identity. Payout changes use propose/accept plus a configured delay.

### 6.2 Admission paths

**Graduation:** after a successful payout, the Agent Operations DAO may instruct the authenticated bounty contract to register a qualifying project without a bond. The registry allocates the ID and returns it through an atomic reply-on-success handshake; neither the bounty nor its creator supplies one. Graduation is explicit, not automatic, and creates only future eligibility.

**Existing project:** an applicant deposits the configured native bond and enters `PENDING`. The Agent Operations DAO may approve, soft-reject with refund, hard-reject clear spam with the bond sent to the configured public destination, request corrected metadata, or later suspend/retire an active project. Good-standing retirement returns the bond.

Only `ACTIVE` projects are valid gauge options. The Program Vault governor may override status and replace the curator.

### 6.3 Capacity and abstention

The first release supports at most 99 active project options plus one immutable `do-not-distribute` option, matching the gauge's 100-option limit. Admission fails rather than truncating if capacity is full. A retired project frees a slot.

The reserved option produces no bank message. Its allocation, unallocated ballot power, threshold exclusions, cap overflow, and integer dust remain in the Program Vault and are never renormalized among winners.

### 6.4 Message boundary

The adapter may return only native bank sends that satisfy all of these conditions:

- denomination is immutable and matches the funded epoch;
- total is no greater than the epoch ceiling and available budget;
- every recipient resolves from a currently active stable project ID;
- at most one send exists per selected project;
- selected-project and message counts remain bounded;
- `do-not-distribute` produces no send; and
- no stored or user-supplied arbitrary `CosmosMsg` is executed.

Suspension before execution invalidates a previously tallied project. The associated amount remains in the vault; it is not reassigned.

## 7. Epoch-snapshot gauge

The existing gauge orchestrator cannot be paired unchanged with `dao-voting-juno-staked`: the voting module intentionally emits no staking-delta hooks, while the current gauge expects authenticated power-change hooks after a vote.

The orchestrator therefore gains an explicit `EpochSnapshot` mode upstream in `dao-contracts`:

1. Opening an epoch requires the Vault's full fixed budget, then records one historical snapshot height, total voting power, fixed option set, budget, denomination, execution deadline, and policy version.
2. Every ballot queries `VotingPowerAtHeight` at that same height.
3. A voter may revise allocations, but their epoch power never changes.
4. Votes, receipts, tallies, and cleanup are scoped by epoch.
5. No power-change hook is registered or accepted in this mode.
6. Execution advances only through a terminal epoch state; a new epoch uses a new snapshot.

The gauge tracks two distinct values:

- `participating_power`: full snapshot power of each address with a nonempty current ballot, counted once, for turnout; and
- `allocated_power` (also exposed as legacy `total_cast`): power actually allocated across options, for accounting; project payout shares still use `participating_power` as their denominator.

Execution requires:

```text
participating_power * 10_000 >= snapshot_total_power * min_turnout_bps
```

Failure produces a terminal no-distribution epoch and leaves the full budget in the vault. Successful execution requires only actual emitted value. Execution-time underfunding terminalizes without messages; anyone may expire an epoch at its deadline, and only Program Vault governance may abort an unrecoverable open epoch with a reason. No terminal path automatically enlarges the next epoch.

The Agent Operations DAO receives guardian permission to stop an epoch or future execution, but only the Program Vault under Juno governance may resume it. Every snapshot, policy value, option set, ballot total, outcome, and actual transfer remains queryable.

## 8. Public execute and query boundaries

The exact schemas are produced during implementation, but the minimum execute surface is:

```rust
// Bounties
CreateBounty { ... }
Contribute { bounty_id }
NominatePayout { bounty_id, ... }
ConfirmSolePayout { bounty_id }
DeclineSolePayout { bounty_id, reason }
VotePayout { bounty_id, vote, rationale }
FinalizePayout { bounty_id }
CancelSoleFunded { bounty_id, reason }
Expire { bounty_id }
ClaimRefund { bounty_id }
Moderate { bounty_id, outcome, reason }
GraduateProject { bounty_id }
PauseNewActivity { reason }
UnpauseNewActivity { reason }
UpdateConfig { ... }

// Registry adapter
RegisterProject { ... }
ReviewRegistration { project_id, decision, reason }
Graduate { source_bounty_id, ... }
ProposePayoutAddress { project_id, address }
AcceptPayoutAddress { project_id }
SetProjectStatus { project_id, status, reason }
Retire { project_id }
ClaimRegistrationBond { project_id }
UpdateEconomicConfig { ... }
```

Queries must support bounded pagination for configuration, authority, pause state, bounties, contribution/receipt history, claims, projects, applications, epochs, ballots, allocations, health, and typed event-equivalent history. Querying one object must not require an unbounded scan.

Every execute rejects unexpected funds. Only creation, contribution, and bonded registration accept the exact native denomination and amount conditions they define.

## 9. Protocol invariants

1. Accounted bounty liabilities are fully backed by the contract's accounted native balance.
2. Principal is paid at most once and each contribution is refunded at most once.
3. Agent moderation never confiscates bounty principal.
4. A multi-contributor payout never executes before `closes_at`.
5. A round's weights, total, contributor count, nomination, duration, and rule are immutable.
6. Votes never cross round or bounty boundaries.
7. Failed, tied, and empty ratifications never pay.
8. Settlement and refunds never require iterating over all contributors.
9. A gauge pays only a project active when execution messages are produced.
10. Every epoch voter and the total use exactly one historical Juno snapshot.
11. Failed turnout produces no distribution and no automatic rollover.
12. Agent, contributor, staker, governor, and migration authorities are separately queryable and logged.
13. Active-object semantics cannot be changed by a later config update.
14. All amounts use checked arithmetic and all work has hard bounds.

## 10. Pause and recovery

Stop powers are intentionally asymmetric:

- Agent Operations may block new bounties, contributions, nominations, admissions, or gauge execution and may suspend projects.
- Existing contributor votes, finalization, expiry, claims, and refunds continue so funds are not trapped.
- Agent Operations cannot unpause, resume, increase caps, or change recipients.
- Program Vault governance can recover after Juno `x/gov` authorization and can replace the agent role.
- The bounty, registry, Program Vault, Juno voting module, and snapshot gauge are instantiated fresh. Prototype and existing-gauge migrations are outside the backend goal; a separately reviewed Agent Operations DAO may be bound without migrating it. The disclosed Juno governance code admin remains a trust boundary, but any future upgrade or state migration requires a separate specification and test plan.

Keepers are optional. All deadline-based progress calls are public and idempotent under their state preconditions.

## 11. Source and artifact boundaries

`dao-contracts` is pinned as a Git submodule because deployment consumes its exact core, Juno voting, gauge, interfaces, and release tooling. It is not added to the Juno Voice root Cargo workspace: the two workspaces currently use different CosmWasm dependency generations and build independent Wasm artifacts.

Gauge changes land upstream first. Juno Voice then advances the gitlink to a reviewed commit. A release manifest binds:

- parent repository commit and submodule commit;
- Rust/toolchain and optimizer identity;
- Wasm SHA-256 checksums and schema versions;
- chain ID, code IDs, instantiated addresses, and CosmWasm code admins; and
- every authority address and economic configuration value.

No deployment resolves a moving branch or an unpinned package.

## 12. Delivery boundary

The delivery plan is [GOAL.md](../../GOAL.md). An indexer, live mainnet funding,
and governance proposal submission remain outside the implementation authority.
Public testnet integration, deterministic artifacts, target-chain gas evidence,
independent security review, and a loss-bounded canary are release gates, not
optional follow-up work.
