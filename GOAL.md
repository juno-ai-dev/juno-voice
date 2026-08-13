# Goal: remediate the Juno Voice v1 security review

**Status:** Active remediation goal; funded use remains blocked.

**Opened:** 2026-08-12

**Scope owner:** Juno Voice contracts and release engineering

**Authoritative findings:** [Juno Voice security audit](audit/SECURITY_AUDIT.md)

**Normative architecture:** [Backend architecture](docs/architecture/ARCHITECTURE.md)

**Policy design:** [Incentives and governance](docs/design/INCENTIVES_AND_GOVERNANCE.md)

This goal supersedes the historical root backend-build goal. That goal remains
available in repository history. The deployed Program Vault must remain
unfunded, and no gauge epoch may be opened, until the pre-canary release gates
are met. An explicitly authorized, tightly capped canary is the only funded
epoch permitted before this goal is complete.

## Outcome

Ship a reviewed Juno Voice contract revision in which:

1. partial ballots can spend only the share of voting power actually allocated
   to eligible projects;
2. deliberate `do-not-distribute` votes, unallocated ballot power, excluded
   allocations, cap overflow, and integer dust remain unspent without being
   renormalized;
3. an epoch cannot be opened without its configured maximum budget and cannot
   remain indefinitely open after an execution failure;
4. project identity uses registry-assigned numeric IDs rather than caller-chosen
   identifiers;
5. bounty graduation replay protection is namespaced by the source contract;
6. every project-status transition preserves its registration-bond invariant;
   and
7. a fresh v2 system is deployed, verified, and independently reviewed before
   any public use or funding; no v1 state is imported.

Completion requires contract code, upstream gauge changes, fresh-deployment tooling, schemas,
clients, deployment tooling, deterministic artifacts, tests, live verification,
and security evidence. A source-only fix is not completion.

## Non-negotiable protocol invariants

### Voting quantities

For one epoch, define:

- `snapshot_total_power`: total voting power at the epoch snapshot height;
- `participating_power`: the full snapshotted power of every voter with a
  non-empty ballot, counted once;
- `option_power[o]`: power allocated to option `o`; and
- `allocated_power`: the sum of power allocated across every option, including
  the retained option.

The implementation must maintain:

```text
allocated_power <= participating_power <= snapshot_total_power
```

Turnout is:

```text
participating_power / snapshot_total_power
```

Every project threshold, cap, and uncapped payout share uses
`participating_power` as its denominator. No payout calculation may use
`allocated_power` or the sum of winning allocations as the denominator.

For an eligible project `p`:

```text
raw_share[p] = option_power[p] / participating_power
payable_share[p] = min(raw_share[p], max_project_share)
```

The minimum-project-share check also uses `raw_share[p]`. The total emitted
value is the sum of individually floored project payouts and must never exceed
the epoch budget or available Vault balance.

### Retained value

The following value remains in the Program Vault for the current tranche:

- power explicitly allocated to `do-not-distribute`;
- `participating_power - allocated_power`;
- allocations below the project threshold;
- allocations to projects invalid at execution;
- allocation above a project's cap; and
- integer rounding dust.

None of it is redistributed to other projects. It does not automatically return
to the community pool after an epoch. Any eventual return occurs only through
the separately authorized unused-funds recovery path and tranche-expiry policy.

`do-not-distribute` is an affirmative voting signal. An omitted portion of a
non-empty ballot is unallocated power. An empty ballot is abstention and does
not count toward turnout. Clients must not silently convert one meaning into
another.

### Identity and provenance

- A project ID is an immutable, monotonically increasing `u64` assigned by the
  registry.
- IDs are never supplied by applicants or bounty creators and are never reused.
- Human-readable names and slugs are presentation metadata, not security keys.
- Gauge option encoding is canonical, for example `project:<base-10-id>` with
  no leading zeroes.
- `do-not-distribute` is a reserved non-project option and cannot collide with
  the numeric namespace.
- A graduated bounty is uniquely identified by
  `(source_bounty_contract, source_bounty_id)`.

### Project and bond state

For a bonded project, `ACTIVE` or `SUSPENDED` requires a fully backed
`DEPOSITED` bond. A graduated project has explicit bond-free provenance.
`REFUNDED`, `FORFEITED`, or `CLAIMED` bonds cannot back an active project.

Every status change, including a governor override, must pass through one
shared transition validator. Administrative authority may choose among valid
transitions; it may not bypass state invariants.

## Workstream A: snapshot gauge allocation repair

### A1. Correct denominator and accounting

In the pinned upstream `dao-contracts` gauge:

- preserve `participating_power` independently of allocated tallies;
- use it for project thresholds, caps, and adapter shares;
- retain partial-ballot remainder without synthesizing a vote;
- preserve exact revision accounting when a ballot changes between partial,
  full, retained-only, and empty states;
- record raw allocated, retained-option, unallocated, selected, emitted, and
  retained values through bounded queries and stable events; and
- terminally distribute nothing when turnout fails.

Division-by-zero paths must produce an explicit no-distribution outcome. All
arithmetic remains checked.

### A2. Treat the retained option as a sink, not a project

Do not hard-code the Juno Voice option string into the generic gauge. Add a
versioned, explicit retained-option configuration or equivalent typed adapter
metadata.

For the configured retained option:

- validate its existence when opening an epoch;
- tally and report its raw power;
- exclude it from project minimum-share and maximum-share rules;
- exclude it from project top-N selection and the selected-project count;
- never produce an execution message for it; and
- preserve legacy behavior for gauges that configure no retained option.

The current adapter may keep its defensive no-send check, but safety and
selection correctness must not depend on the adapter receiving the retained
option as a winning project.

### A3. Gauge regression tests

At minimum, prove:

- a voter allocating 5% to projects can cause at most 5% of that voter's
  participating-power share to be emitted;
- 5% project plus 95% `do-not-distribute` and 5% project plus 95% unallocated
  both retain 95%, while reporting different signals;
- a 100% retained-only ballot counts for turnout and emits zero;
- an empty ballot removes the voter from participating power;
- tiny project allocations cannot be renormalized to exhaust the epoch;
- thresholds and caps use participating power at exact below/equal/above
  boundaries;
- the retained option never consumes a selected-project slot;
- threshold exclusions, suspended projects, cap overflow, and dust stay in the
  Vault;
- revision and removal preserve every tally and participation invariant; and
- hook-mode and gauges without a retained option have no semantic regression.

Include model/property tests over arbitrary bounded ballots. Assert after every
successful mutation that option tallies equal the reference-model sum and that
total payable share is no greater than total project allocation divided by
participating power.

## Workstream B: epoch funding and terminal liveness

### B1. Funded opening

`OpenEpoch` may remain permissionless, but it must atomically query the Program
Vault and reject opening unless the Vault holds at least the epoch's full fixed
budget in the configured denomination. A failed opening creates no epoch,
snapshot, receipt, or schedule mutation.

The epoch stores its budget and policy version at opening. Economic policy
changes do not retroactively alter an open epoch.

Because Juno `x/gov` is the trusted Vault root, a balance gate is sufficient for
this revision; a new escrow or reservation contract is out of scope. Removing
funds after opening must nevertheless lead to a safe terminal outcome.

### B2. Execution and failure outcomes

Execution must:

1. calculate selected project shares without renormalization;
2. obtain or validate the adapter's bounded messages and actual emitted value;
3. require only `emitted_value`, not the full nominal epoch budget, to be
   available at execution; and
4. atomically emit all messages or none.

If the current balance is below the actual emitted value, record a terminal
`INSUFFICIENT_FUNDS` outcome with no messages. Later funding must not make that
stale ballot executable.

Add a bounded execution deadline. After it, anyone may terminally expire an
otherwise unexecuted epoch with no distribution. Provide a governor-only,
reasoned abort path for unrecoverable adapter or deployment-configuration failures. Guardian
stop authority remains stop-only and cannot abort, resume, or allocate funds.

All terminal paths advance scheduling exactly once and are idempotently
queryable. No failure budget rolls into a later epoch implicitly.

### B3. Epoch liveness tests

Cover:

- direct callers bypassing the frontend funding check;
- balances immediately below, equal to, and above the epoch budget at open;
- no state change after rejected opening;
- partial and retained-only execution requiring only actual emitted value;
- Vault balance removal between open and execution;
- terminal insufficient-funds behavior and later top-up resistance;
- adapter errors followed by governor abort;
- permissionless expiry at the exact deadline and rejection before it;
- double execute, double abort, and execute-after-expiry rejection; and
- schedule behavior across at least two subsequent epochs.

## Workstream C: registry-assigned project identity

### C1. Numeric IDs

Replace caller-supplied string project IDs with a checked `NEXT_PROJECT_ID`
counter and numeric storage keys.

- Bonded registration allocates an ID atomically after all validation succeeds.
- Bounty graduation allocates an ID atomically after authentication and replay
  checks succeed.
- Failed transactions do not consume an ID.
- Rejected and retired records remain historical and their IDs are not reused.
- Queries paginate in numeric order.
- Events and response data return the assigned ID.
- The UI resolves gauge option IDs to project metadata and does not present the
  raw number as the project's primary name.

Do not enforce permanent uniqueness on a display name, slug, payout address, or
metadata URI. Duplicate-project detection remains a curation decision rather
than a storage-key collision.

### C2. Bounty graduation handshake

Remove `project_id` from a new-project bounty candidate. On graduation, the
registry returns a typed response containing the assigned project ID. The
bounty contract uses a reply-on-success flow or an equivalently atomic typed
handshake to store its graduation record.

The complete bounty-to-registry transaction must roll back if ID allocation,
registry creation, response decoding, or bounty record finalization fails.
Repeated graduation of one bounty must fail without allocating another ID.

Linking a bounty to a pre-existing project is outside this remediation goal and
must not be smuggled in through a user-supplied numeric ID.

### C3. Source-contract namespace

Replace the global `source_bounty_id` replay map with a map keyed by the
validated source contract address and source bounty ID. Store both fields in
admission provenance and expose them in queries and events.

After an authorized bounty-contract replacement:

- the old contract is no longer authorized to graduate;
- an ID used by the old contract does not collide with the same numeric ID from
  the new contract; and
- an already consumed `(contract, id)` pair remains permanently consumed.

### C4. Identity tests

At minimum, cover:

- sequential registration and graduation IDs;
- atomic rollback without counter consumption;
- concurrent ordering as determined by chain transaction order;
- inability to reserve or predictively squat another project's ID;
- retained historical IDs after every terminal project state;
- canonical gauge-option encoding and malformed encoding rejection;
- bounty reply success, malformed reply, submessage failure, and replay;
- same bounty ID from two authorized contract generations; and
- old-source rejection after source replacement.

## Workstream D: project/bond transition repair

### D1. One transition engine

Replace ad hoc review, retirement, and override bond mutations with one
transition function that validates:

- admission provenance;
- current and requested project status;
- current bond state and actual liability backing;
- caller authority and typed reason; and
- option-index additions/removals and accounting deltas.

The minimum supported bonded flow is:

```text
PENDING + DEPOSITED -> ACTIVE + DEPOSITED
PENDING + DEPOSITED -> REJECTED + REFUNDED       (soft reject)
PENDING + DEPOSITED -> REJECTED + FORFEITED      (hard reject)
ACTIVE  + DEPOSITED -> SUSPENDED + DEPOSITED
SUSPENDED + DEPOSITED -> ACTIVE + DEPOSITED
ACTIVE|SUSPENDED + DEPOSITED -> RETIRED + CLAIMABLE
RETIRED + CLAIMABLE -> RETIRED + CLAIMED          (claim)
```

A governor may restore `RETIRED + CLAIMABLE` to `ACTIVE + DEPOSITED` only while
the bond remains unclaimed and fully backed. Reactivation from `REFUNDED`,
`FORFEITED`, or `CLAIMED` is prohibited. Graduated bond-free projects follow a
separate explicit transition table.

Bond claims require both the expected bond state and a compatible terminal
project status. Option membership, active-project counts, pending counts, and
bond liabilities must update atomically with the transition.

### D2. Transition tests

Table-test every valid and invalid status × provenance × bond-state
combination, including every governor override target. Add a state-machine test
that proves after every generated sequence:

```text
bond_liability <= actual_registry_balance
ACTIVE bonded project => bond.state == DEPOSITED
SUSPENDED bonded project => bond.state == DEPOSITED
settled bond => project is not an active gauge option
```

Also cover failed bank-send rollback, repeated terminal actions, reactivation
before and after claim, and exact active/pending/option counts.

## Workstream E: fresh deployment and compatibility

### E1. Guarded fresh deployment

The audited live state contained no bounties, projects, bond liabilities, open
epoch, or Program Vault funds. Deploy new v2 instances instead of migrating or
transforming v1 state.

Immediately before cutover, independently query and record those conditions. If
any user state or funds appear, stop this plan and design a separately reviewed
recovery and disposition plan. Do not copy that state into v2.

The fresh deployment must:

- create new contract addresses from reviewed v2 salts and exact checksums;
- wire and verify every authority relationship explicitly;
- initialize the numeric project counter and new provenance indexes through
  normal v2 instantiation;
- configure the immutable retained option under the new option encoding;
- prove the new bounty, registry, and epoch state is empty before funding; and
- record the old and new compositions so clients and operators cannot confuse
  their addresses or code identities.

Deployment and cutover are performed through the documented Juno `x/gov`
administration path. No script may infer an address, code ID, checksum, or
authority.

### E2. Public interface and clients

Version and regenerate all changed JSON schemas. Update:

- the web application and transaction builders;
- deployment configuration and message generation;
- integration fixtures and captured expected events;
- monitoring, reconciliation, and operator runbooks;
- release manifests and exact-artifact verification; and
- architecture and governance documentation.

Breaking message changes must fail loudly against old clients. Do not retain a
second caller-chosen-ID path for convenience.

### E3. Upstream pin

All gauge changes are authored, tested, reviewed, and committed in the upstream
`dao-contracts` repository. The root repository then advances to one clean
exact gitlink. Neither repository may release from a dirty tree or floating
branch.

## Workstream F: verification and release

### F1. Automated verification

Required green checks include:

- both Rust workspaces' full locked test suites;
- formatting, clippy, schema regeneration, and schema-diff checks;
- new model/property tests for allocation and registry transitions;
- root deployment and cross-contract integration suites;
- clean-instantiation and cutover tests proving new-state emptiness and explicit
  old/new address separation;
- deterministic optimized Wasm builds from a clean recursive clone;
- `cosmwasm-check`, export allowlists, artifact-size limits, and checksum
  verification; and
- maximum-bound target-chain gas tests for ballots, options, selected projects,
  fresh instantiation, execution, and queries.

Tests must include a red/green regression for every audit finding and every
new invariant in this goal.

### F2. Chain evidence

Before mainnet deployment:

- deploy exact candidate artifacts to a Juno-compatible testnet;
- run funded, partial, retained-only, underfunded, expired, and aborted epochs;
- run bonded registration and bounty graduation through numeric ID assignment;
- rotate the configured bounty contract and prove namespaced replay behavior;
- exercise the complete bond transition table used operationally;
- record transactions, balances, events, code identities, admins, and gas; and
- reconcile emitted plus retained value for every epoch.

Immediately after mainnet deployment, query back code IDs, checksums, CW2
versions, admins, authorities, configs, counters, retained option, balances,
liabilities, project/bounty emptiness, and absence of an open epoch. Publish the
signed release manifest before funding.

### F3. Security disposition

The remediation is not approved by its implementers alone. Before authorizing
the canary:

- independently re-review the changed gauge, registry, bounty reply, and fresh
  deployment/cutover paths;
- close JV-01 through JV-05 with direct code and test evidence;
- disposition the retained-option/top-N and epoch-expiry design explicitly;
- resolve all new critical/high findings and document lower-severity decisions.

After those gates pass, run at least one explicitly authorized low-value canary
epoch and reconcile it before any production tranche or recurring epoch.

## Out of scope

- Automatic per-epoch return of retained value to the community pool.
- A majority-veto interpretation of `do-not-distribute`.
- A new epoch escrow/reservation contract.
- Linking a bounty candidate to an existing project.
- Reusing or renaming numeric project IDs.
- Migrating the historical `contracts/juno-voice` prototype.
- Broad bounty settlement, DAO-governance, or frontend redesign unrelated to
  the changed interfaces.
- Funding the Program Vault or opening a production epoch.

## Implementation order

1. Freeze the formulas, retained-option semantics, epoch terminal states,
   numeric ID encoding, provenance key, and transition tables in an ADR.
2. Implement and test the upstream gauge allocation and liveness changes.
3. Implement and test registry IDs, namespaced provenance, and bond transitions.
4. Implement the bounty graduation reply handshake.
5. Regenerate schemas and update clients, documentation, deployment tooling,
   monitoring, and integration tests.
6. Rehearse a fresh v2 deployment and explicit client/operator cutover.
7. Produce deterministic artifacts and complete testnet/gas evidence.
8. Complete independent remediation review, fresh mainnet deployment,
   post-deployment verification, and a low-value canary.

Parallel work is acceptable only after step 1 freezes the shared interfaces.
The Program Vault remains unfunded throughout implementation and review, until
the separately authorized canary.

## Definition of done

- [ ] JV-01 through JV-05 have fixes, regression tests, and explicit audit
      dispositions.
- [ ] Project payouts use participating power and cannot be renormalized.
- [ ] Deliberate retained votes and implicit unallocated power are separately
      observable and economically retained.
- [ ] The retained option never consumes a funded-project selection slot.
- [ ] An unfunded epoch cannot open, and every opened epoch reaches one terminal
      outcome within a bounded time.
- [ ] Only actual emitted value is required at execution.
- [ ] Registry-assigned numeric IDs eliminate caller-controlled ID squatting.
- [ ] Graduation replay keys and provenance include the source contract.
- [ ] Every project/status/bond combination is accepted or rejected by one
      tested transition table.
- [ ] Old-state emptiness predicates are reverified immediately before cutover.
- [ ] Fresh v2 deployment and cutover pass rehearsal and mainnet verification.
- [ ] Both repositories are clean and pinned to reviewed commits.
- [ ] Schemas, clients, docs, runbooks, monitoring, and release manifests match
      the new protocol.
- [ ] Locked tests, properties, integration scenarios, deterministic builds,
      artifact checks, and target-chain gas gates pass.
- [ ] Independent review reports no unresolved critical/high issue.
- [ ] A low-value canary reconciles exactly before any larger funding action.

Completion authorizes preparation of a separate funding decision. It does not
itself authorize a community-pool transfer, Program Vault funding, or recurring
production epochs.
