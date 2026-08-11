# GOAL: build the Juno Voice v1 backend

**Status:** In progress — implemented locally but not release-approved or deployed

**Scope owner:** Juno Voice backend

**Normative design:** [Backend architecture](docs/architecture/ARCHITECTURE.md)

**Policy design:** [Incentives and governance](docs/design/INCENTIVES_AND_GOVERNANCE.md)

## Outcome

Ship a production-reviewable on-chain backend in which:

1. people create and pool native-Juno social bounties;
2. a sole contributor explicitly confirms delivery, while multiple contributors receive a full 72-hour contribution-weighted ratification period;
3. successful bounties can graduate into a curated project registry;
4. existing projects can enter through bonded registration;
5. Juno stakers direct a capped Hack Juno epoch using one historical Juno staking snapshot; and
6. Juno `x/gov`, a minimal Program Vault, and a bounded Agent Operations DAO enforce the authority split in the accepted architecture.

The result is backend-complete when the contracts, upstream gauge changes, schemas, deployment composition, deterministic artifacts, public-testnet evidence, and security/release evidence below are complete. It does not require a frontend or mainnet funding proposal.

## Scope

### In scope

- A new `juno-voice-bounties` CosmWasm contract.
- A new `hack-juno-registry-adapter` CosmWasm contract.
- Upstream `dao-contracts` changes adding epoch-snapshot gauge power, turnout accounting, and stop-only guardian behavior.
- Independent integration with pinned `dao-dao-core`, `dao-voting-juno-staked`, reviewed proposal/membership components for Agent Operations, and the gauge stack.
- Versioned JSON schemas, stable events, bounded queries, and deployment configuration.
- Deterministic Wasm builds and a release manifest binding source to deployed identities.
- Unit, model, property, integration, gas, and exact-artifact `uni-7` testing.
- Operational runbooks for configuration, deployment, monitoring, pause, recovery, submodule updates, and releases.

### Out of scope

- Frontend or prototype application changes.
- A hosted indexer, search service, keeper service, or notification system.
- Mainnet upload, instantiation, community-pool transfer, or submission of a Juno governance proposal.
- Migrating data or funds from the pre-release prototype contract.
- CW20, multiple denominations, cross-chain funds, transferable contribution shares, delegated contributor votes, milestones, or partial bounty payouts.
- Per-bounty DAO cores or arbitrary execution messages.
- Automatic subjective verification of off-chain delivery evidence.
- A separate feasibility gate for nested DAO-core/governance messages; the accepted composition is implemented and exercised as ordinary integration behavior.

## Repository and ownership boundary

```text
contracts/juno-voice-bounties/       Juno Voice-owned bounty escrow
contracts/hack-juno-registry-adapter/ Juno Voice-owned project registry and gauge adapter
packages/                             shared Juno Voice types, if a real reuse boundary emerges
schema/                               canonical pre-release prototype schemas
contracts/*/schema/                   canonical v1 owned-contract schemas
deployment/                           validated configs, manifests, and orchestration
integration/                          exact-artifact scenario capture and validation
release/                              readiness, evidence, and release-decision gates
artifacts/                            deterministic Juno Voice Wasm and checksums
deps/dao-contracts/                   independently built upstream submodule
```

Do not add `deps/dao-contracts` packages to the root Cargo workspace. The repositories currently use different CosmWasm dependency generations and must build independently. Integration occurs through stable JSON messages, generated schemas, exact Wasm artifacts, and chain-level tests.

All gauge-orchestrator changes are authored and reviewed in the upstream `dao-contracts` repository. After upstream acceptance, advance the Juno Voice gitlink to the exact commit. Do not ship with a dirty submodule.

The existing `contracts/juno-voice` package is a pre-release prototype. It is not a v1 migration source and must not appear in the v1 release manifest. The bounty, registry, Program Vault, Juno voting module, and snapshot gauge are instantiated fresh; migrating prototype state or an existing gauge instance is outside this goal. A separately reviewed Agent Operations DAO may still be bound by address without migrating it. Removing or archiving the prototype code can be a separate cleanup once no build tooling depends on it.

## Workstream A: bounty escrow

### A1. Messages and state

Implement the bounded execute surface defined by the architecture:

- create and fund a bounty;
- add contributions;
- nominate a delivery and recipient;
- confirm or decline a sole-contributor nomination;
- cast or revise a contributor `YES`/`NO` vote;
- finalize a mature ratification;
- cancel a sole-funded bounty;
- expire a bounty;
- claim an individual refund;
- moderate an open bounty into a typed refund path;
- graduate a paid project through the configured registry;
- pause new activity, unpause through the governor, replace bounded roles, and update future-only configuration.

Store explicit bounty, nomination, round, contribution, receipt, claim, moderation, graduation, authority, pause, and accounting records. Every list has stable bounded pagination. Exact state enums and errors are part of the checked-in schema.

### A2. Settlement semantics

The implementation must enforce:

- native `ujuno` only;
- immutable funded terms and acceptance criteria;
- positive bounded contributions aggregated per address;
- no live contribution withdrawal or transfer;
- a snapshotted contributor set and weights when a nomination opens;
- separate explicit confirmation for one contributor within a bounded deadline;
- permissionless refund finalization for an unconfirmed sole round at its deadline or bounty expiry;
- `closes_at = opens_at + 259_200 seconds` for multiple contributors;
- no early finalization;
- vote revision through checked removal/addition of the same fixed weight;
- payout only when participation is positive and `yes_weight > no_weight` after close;
- reset for no majority, tie, or no votes, with expired resets entering refunds;
- full-pot, one-recipient payout only;
- pull refunds with no loop over contributors; and
- no agent or governor runtime path that can redirect active bounty principal.

State changes precede bank messages so CosmWasm transaction atomicity protects accounting. Every execute except creation and contribution rejects funds.

### A3. Bounty acceptance tests

At minimum, automate:

- creation amount, denomination, metadata, lifetime, and attached-funds bounds;
- repeated and multi-address contributions and exact contributor counting;
- immutable terms and frozen nomination round data;
- sole confirmation, bounded-deadline decline, permissionless timeout/expiry refund, and failed-transfer rollback;
- two or more contributors with unequal weights;
- vote creation and every revision pair (`YES→NO`, `NO→YES`, and same-vote replacement policy);
- rejection of non-contributor, zero-weight, late, and wrong-round votes;
- rejection at one nanosecond before close and finalization at/after close;
- yes majority, no majority, tie, no votes, and low-participation yes majority;
- round reset, top-up, later nomination, and old-receipt isolation;
- expiry before nomination and expiry during ratification;
- sole cancellation and prohibited multi-contributor cancellation;
- typed moderation, agent authorization, and full principal refunds;
- double-payout, double-refund, and cross-bounty replay resistance;
- unsolicited native transfer accounting isolation;
- stop-only agent behavior and continued settlement/refund liveness while paused;
- governor-only recovery and future-only configuration changes; and
- pagination/order stability at every configured maximum.

Add a state-machine/model test that generates valid and invalid sequences and checks liability backing after every successful transition:

```text
accounted active escrow + outstanding refund claims + pending payout liabilities
<= accounted contract native balance
```

The model must also prove that each contributed unit is paid once, refunded once, or remains an explicit live liability—never more than one of those.

## Workstream B: project registry adapter

### B1. Registry behavior

Implement stable project IDs and explicit `PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED`, and `RETIRED` states.

Support two authenticated admission paths:

- a paid, project-candidate bounty may be graduated by Agent Operations through the configured bounty-contract address without a registration bond; and
- an existing project may deposit the exact registration bond and await agent review.

The contract must preserve admission provenance, metadata digest, current/pending payout address, bond accounting, typed review reason, and status history. Address changes use propose/accept and a configured delay. Only active records pass option validation.

Cap active records at 99 and reserve the 100th option as immutable `do-not-distribute`. Capacity errors fail atomically; no query or execution path truncates the registry silently.

### B2. Adapter behavior

Implement the minimum gauge interface required by the pinned orchestrator while narrowing its authority to:

- fixed native denomination;
- fixed epoch ceiling and supplied available budget;
- active stable project IDs resolved at execution time;
- one bank send per selected eligible project;
- bounded selected projects and total messages;
- no send for `do-not-distribute`, threshold exclusions, cap overflow, or integer dust; and
- no stored or forwarded arbitrary `CosmosMsg`.

Economic configuration is Program-Vault-governor-only. Project review is curator-only. Agent suspension and stop are one-way; resume and overrides are governor-only.

### B3. Registry acceptance tests

At minimum, automate:

- graduation authentication, paid-bounty provenance, duplicate source, and duplicate project ID;
- existing-project bond denomination/amount and pending isolation from gauge options;
- approval, soft rejection/refund, hard spam rejection/destination, suspension, reactivation, retirement, and bond claim;
- active capacity at 98, 99, and attempted 100th project;
- stable identity across payout-address changes;
- address proposal, acceptance, delay, cancellation/replacement policy, and unauthorized calls;
- suspension after tally but before adapter execution;
- governor override and curator replacement;
- exact epoch ceiling, integer flooring, share cap, threshold, dust, abstention, and unallocated treatment;
- invalid option, duplicate selected option, too many options/messages, wrong denom, overflow, and insufficient available balance; and
- proof that every produced message is a bounded bank send to the currently approved address.

Property-test that total emitted native value never exceeds the supplied budget or configured epoch ceiling under arbitrary valid allocations.

## Workstream C: dao-contracts epoch-snapshot gauge

### C1. Upstream implementation

In the upstream `dao-contracts` gauge orchestrator:

- add an explicit `EpochSnapshot` power-source mode without changing hook-mode semantics;
- snapshot one historical height and nonzero total power when an epoch opens;
- query every ballot's power at exactly that height;
- scope receipts, votes, tallies, and cleanup by epoch;
- allow ballot revision without changing fixed voter power;
- reject hook configuration/calls in snapshot mode;
- track full participating voter power separately from allocated power;
- enforce configurable `min_turnout_bps` with checked ratio arithmetic;
- terminally record a no-distribution outcome when turnout fails;
- add an authenticated guardian that may stop but cannot resume; and
- expose snapshot, turnout, allocation, terminal outcome, health, and cleanup progress through bounded queries/events.

Do not synthesize Juno staking hooks. Do not mix snapshot heights within an epoch. Do not roll a failed-turnout budget automatically into a later epoch.

### C2. Gauge acceptance tests

Extend upstream unit/model/property coverage for:

- snapshot selection and zero/failed total-power queries;
- every voter and denominator queried at the identical height;
- delegation or current-power changes after opening with unchanged epoch weight;
- allocation revision and exact tally subtraction/addition;
- partial allocation with full voter power counted once for turnout;
- empty ballot removal and participation decrement;
- turnout immediately below, equal to, and above threshold;
- terminal no-distribution and no rollover;
- complete epoch isolation and bounded cleanup;
- hook-mode regression compatibility;
- rejection of hooks in snapshot mode;
- agent stop, prohibited agent resume, and governor resume;
- option, selected-set, message, and gas bounds; and
- adapter failure, project suspension, and atomic execution rollback.

Model at least two consecutive epochs with stake changes between their snapshot heights. Prove that an epoch's stored total and every ballot use its own height only.

### C3. Upstream acceptance and pin

The workstream is not complete while gauge changes exist only as a dirty submodule. It completes when:

1. changes and schemas are committed in upstream `dao-contracts`;
2. its full required checks pass;
3. the Juno Voice gitlink advances to that reviewed commit; and
4. Juno Voice records the exact commit in its release manifest.

## Workstream D: governance composition and deployment

### D1. Versioned deployment configuration

Create a validated, environment-specific configuration format containing:

- chain ID, RPC/gRPC endpoints used for verification, native denom, and bech32 prefix;
- every Wasm checksum and expected code identity;
- Juno `x/gov` module account used as external admin;
- Program Vault, voting module, gauge, bounty, registry, and Agent Operations addresses or instantiate definitions;
- CosmWasm code admin and application governor separately;
- bounty limits and immutable 72-hour duration;
- registration bond and disposition destinations;
- gauge snapshot mode, epoch duration, turnout, share/selection caps, project capacity, and epoch ceiling;
- tranche term and unused-funds policy; and
- submodule commit and build-tool identities.

No deploy command accepts an unvalidated free-form address, moving source branch, unknown checksum, unexpected denom, or implicit authority default.

### D2. Composition

Provide reproducible orchestration for:

1. uploading exact artifacts;
2. instantiating or binding the reviewed Agent Operations DAO;
3. instantiating `dao-voting-juno-staked` and the Program Vault composition;
4. instantiating bounty and registry contracts with the correct split roles;
5. instantiating epoch-snapshot gauge components;
6. registering only the required execution modules and adapter relationships;
7. transferring final application ownership/admin relationships; and
8. querying every resulting relationship back into a signed-off deployment manifest.

The orchestration must support dry-run/message generation separately from broadcast. It must stop on an address, checksum, chain ID, code ID, role, or config mismatch and must be restartable without silently duplicating instantiated state.

### D3. Agent Operations DAO

Use one reusable DAO with public on-chain proposals and a reviewed CW4 or CW721-roles membership/threshold, either newly instantiated from the pinned source or bound through an explicit deployment record. Its executable permissions are limited by the bounty, registry, and gauge message APIs; membership alone grants no contract authority.

The deployment record must disclose members, threshold, voting duration, core/proposal/voting code identities, and every assigned role.

## Workstream E: integration and release evidence

### E1. Cross-contract integration

Use a chain-capable harness for dependency-generation boundaries that cannot safely share one Rust test graph. Cover complete flows:

1. create → multi-fund → nominate → wait 72 hours → vote → pay;
2. create → reject/tie/no-vote → reset → re-nominate → pay;
3. moderate/expire → independent refunds;
4. paid bounty → agent graduation → active project;
5. bonded existing project → approval → active project;
6. open epoch → historical Juno power ballot → meet turnout → bounded transfers;
7. failed turnout → no transfers and retained vault funds;
8. suspension between vote and execution → no project transfer;
9. agent stop → failed resume → governor recovery; and
10. consecutive epochs with distinct snapshots and no state leakage.

Assertions inspect final chain balances, contract states, emitted events, authorities, code IDs, and exact message destinations—not only transaction success.

### E2. Juno snapshot behavior

On a Juno v30-compatible public testnet:

- record the snapshot module activation/export boundary and observed retention policy;
- exercise native staking changes across EndBlock and query exact historical voter/total power;
- demonstrate that one epoch remains fixed while a later epoch observes the change;
- record the configured liquid-staking-token allowlist and resulting power basis; and
- fail deployment readiness if required history is not retained beyond the longest open epoch plus operational margin.

### E3. Deterministic artifacts

Produce optimized Wasm in a pinned builder environment. For every release candidate:

- rebuild from a clean recursive clone;
- prove byte-for-byte repeatability;
- reject floating dependencies and dirty repositories/submodules;
- generate and diff schemas;
- record SHA-256 checksums and contract CW2 versions; and
- generate a machine-readable manifest binding both repository commits to artifacts, code IDs, addresses, config, and test evidence.

CI must initialize submodules and test the two workspaces independently before integration checks.

### E4. Security and operational readiness

Before funded production use:

- complete an independent review/audit of bounty escrow, registry adapter, and changed gauge paths;
- resolve all critical/high findings and explicitly disposition lower findings;
- measure target-chain gas at configured maxima: contributors, projects, selected options, messages, pagination, history, and cleanup;
- run exact-artifact public-testnet scenarios and publish transaction/evidence references;
- document snapshot-retention, balance-liability, overdue-finalization, stopped-state, adapter-failure, and tranche-balance alerts;
- document pause, refund, epoch failure, role replacement, and unused-funds recovery procedures; and
- complete at least two low-value canary epochs before proposing a larger recurring tranche.

The canary's actual economic settings are deployment/governance inputs, not contract constants. Recommended values in the design report are hypotheses to validate, not defaults to hide in code.

## Implementation order

1. Freeze shared terms, schemas, error taxonomy, limits, and event conventions.
2. Implement bounty escrow and its model/property test suite.
3. Implement project registry/adapter and integrate bounty graduation.
4. Implement and upstream epoch-snapshot gauge changes; advance the submodule pin.
5. Build validated deployment composition and release manifest generation.
6. Run cross-contract integration and Juno snapshot testnet scenarios.
7. Complete deterministic builds, maximum-bound gas evidence, independent review, and runbooks.
8. Produce a testnet release candidate and evidence packet suitable for a later Juno governance funding decision.

Parallel work is acceptable after shared schemas and authority boundaries are frozen, but no release may substitute mocked DAO/gauge behavior for exact pinned artifacts.

## Definition of done

The backend goal is complete only when all of the following are true:

- [ ] Bounty and registry contracts implement the accepted state machines and authority split.
- [ ] Every protocol invariant in the architecture has a direct automated test or model assertion.
- [ ] No unbounded contributor, voter, project, history, message, or cleanup loop exists.
- [ ] `ujuno` liability accounting reconciles across success, reset, expiry, moderation, refund, and failure paths.
- [ ] Multi-contributor settlement cannot occur before the complete 72-hour window.
- [ ] Gauge epoch voting uses one historical height and passes turnout/epoch-isolation tests.
- [ ] Adapter output is restricted to capped native sends to active registered projects.
- [ ] Agent Operations can stop but cannot pay pooled bounties, allocate rewards, raise limits, resume, or migrate.
- [ ] Program Vault and Juno `x/gov` relationships are explicit and query-confirmed.
- [ ] Gauge changes are accepted upstream and the clean submodule pin references them.
- [ ] Schemas and stable events cover all public messages, states, outcomes, and authorities.
- [ ] CI builds/tests both workspaces independently and runs cross-contract integration.
- [ ] Clean recursive-clone deterministic Wasm checks pass and the release manifest is complete.
- [ ] Exact-artifact `uni-7` flows and maximum-bound gas evidence are published.
- [ ] Independent security review has no unresolved critical/high findings.
- [ ] Deployment, monitoring, pause, recovery, and submodule-update runbooks are usable.
- [ ] The existing prototype frontend redesign remains outside v1 backend release approval; no v1 frontend release, mainnet deployment, funding transfer, or prototype state/fund migration is smuggled into the goal.

Completion produces a backend release candidate and evidence packet. Uploading it to mainnet, assigning live admins, transferring community-pool funds, or enabling a production tranche requires a separate explicit authorization.
