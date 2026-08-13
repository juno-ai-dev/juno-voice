# Juno Voice v1 smart-contract security audit

## Executive summary

The review identified **one High-, three Medium-, and one Low-severity
confirmed finding**. No Critical issue was found. No confirmed unauthorized
withdrawal, double payout, double refund, or principal-redirection path was
found in the bounty escrow.

The release-blocking issue is in the epoch-snapshot gauge. Partial ballots are
tracked as partially allocated during voting, but the allocated portion is
renormalized at execution. A voter can therefore express a very small
allocation while causing a much larger fraction—and under the deployed policy,
potentially all—of an epoch budget to be distributed. This directly violates
the protocol rule that unused ballot weight remains in the Program Vault.

The deployed Program Vault held **0 `ujuno`** and there was no open epoch at the
point-in-time observation. No loss has occurred through this issue according
to the observed state. Funding should remain blocked until the gauge is fixed
and a separately reviewed v2 composition is freshly deployed.

## Scope and source identity

Reviewed production scope:

- `contracts/juno-voice-bounties`;
- `contracts/hack-juno-registry-adapter`;
- `deps/dao-contracts/contracts/gauges/gauge` snapshot-mode paths;
- `deps/dao-contracts/packages/gauge-interface`;
- relevant architecture, deployment, release, schema, and integration code.

Source identities:

- working tree commit: `3fd4855aeca6ce40bc8df4a7c771b005cdacd5a2`;
- documented deployed owned-contract source: `e606d6071ff4febb2dbe4ca65165223bdfa23e54`;
- pinned/deployed `dao-contracts`: `8f26e510dc89e56576e2dbbd35c96edb45d4b778`.

The production owned-contract sources are unchanged between the documented
deployment commit and the reviewed working-tree commit. The submodule was at
the documented deployed commit and clean during review.

Excluded or limited:

- the historical `contracts/juno-voice` prototype is not a v1 production
  contract or migration source;
- no formal proof or exhaustive symbolic execution was performed;
- the five deployed Wasm files are not retained in the repository, so this
  review verified live code IDs/checksums against the documented values but
  could not independently reproduce and byte-compare all deployed artifacts;
- this report is not the signed independent security attestation required by
  the release manifest.

## Severity model

- **Critical:** direct, broadly exploitable loss or takeover with minimal
  preconditions.
- **High:** material loss or protocol-integrity failure under realistic system
  conditions.
- **Medium:** significant denial of service, recovery failure, or bounded
  economic harm requiring meaningful preconditions.
- **Low:** privileged or edge-case invariant failure with limited immediate
  impact.

## Findings

### JV-01 — High — Partial ballots are renormalized and can overspend expressed allocations

**Status:** Confirmed; release/funding blocker.

**Affected code**

- `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs:2916-2944`
- `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs:2953-2976`
- `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs:3249-3279`
- `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs:3297-3304`
- `contracts/hack-juno-registry-adapter/src/contract.rs:1073-1110`

**Specification conflict**

- `docs/architecture/ARCHITECTURE.md:207-223`
- `docs/design/INCENTIVES_AND_GOVERNANCE.md:312-318`
- `deps/dao-contracts/packages/gauge-interface/src/lib.rs:17-27`

**Description**

Snapshot voting correctly permits a ballot whose weights sum to less than one.
Only `power * weight` is added to `epoch.total_cast`, while a nonempty ballot
adds the voter's full power to `epoch.participating_power` for turnout.

At execution, however, option thresholds, per-project caps, and the shares sent
to the adapter are all calculated using `epoch.total_cast` as the denominator.
This normalizes the allocated subset back toward 100%. The adapter then
multiplies those normalized shares by the entire epoch budget.

**Concrete deployed-policy scenario**

The observed mainnet policy has 1% minimum turnout, 1% minimum project share,
20% maximum project share, and up to 20 selected projects. A voter holding 1%
of snapshot power can meet turnout, allocate only 1% of their ballot to each of
five projects, and leave 95% of their ballot unused. Each project nevertheless
becomes 20% of `total_cast`; the five projects can receive 20% each and exhaust
the full epoch budget. The expressed allocation represented only 0.05% of
total network snapshot power.

**Impact**

Voters can cause transfers far larger than their expressed allocations. The
maximum loss per execution is bounded by the configured epoch ceiling and the
Vault's available balance. The observed ceiling is 1,000,000,000 `ujuno`
(1,000 JUNO). Repeated funded epochs repeat the exposure.

**Recommendation**

Use a denominator that preserves unused participant weight—normally
`epoch.participating_power`—for selection thresholds, caps, and adapter shares.
Alternatively, explicitly include unallocated weight in the denominator. Keep
`participating_power` as the turnout numerator. Add end-to-end tests asserting:

- a 50%-weighted ballot can emit at most 50% of its participating-power share;
- unallocated ballot weight remains in the Vault;
- minimum-share and maximum-share calculations use the same non-renormalizing
  denominator;
- five tiny partial allocations cannot exhaust an epoch;
- integer dust remains retained.

### JV-02 — Medium — A permissionless unfunded epoch can become non-terminal and later execute stale allocations

**Status:** Confirmed; must be fixed with JV-01 before funding.

**Affected code**

- `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs:2141-2245`
- `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs:3187-3219`
- `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs:3306-3319`
- `contracts/hack-juno-registry-adapter/src/contract.rs:1025-1037`

**Trust-boundary mismatch**

- `app/src/gaugeActions.ts:41-52` checks funding client-side.
- `docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md:129-136` instructs operators not to
  open an unfunded epoch.
- The on-chain `OpenEpoch` entry point is permissionless and does not enforce
  that rule.

**Description**

Opening an epoch snapshots power, policy, and options without verifying or
reserving the epoch budget. If turnout later passes and at least one option is
selected, execution queries the current Vault balance and calls the adapter.
The adapter rejects when the Vault balance is below the full epoch budget.
CosmWasm atomicity rolls back the attempted terminal state, leaving the epoch
open. There is no cancel or abort transition for an expired open epoch.
Stopping the gauge prevents execution but does not terminalize the epoch.

**Exploit scenario**

An account or coalition with the required snapshot turnout opens an epoch while
the Vault is empty and casts a qualifying ballot. After close, the epoch cannot
finalize until enough funds arrive or the contract is migrated. If eligible
project allocations were snapshotted, later funding makes those stale
allocations executable. JV-01 lets the attacker commit little ballot weight
while retaining large eventual payout influence.

**Impact**

- epoch liveness can be blocked;
- funding can unexpectedly activate an old vote rather than a newly reviewed
  epoch;
- guardian stop cannot recover the epoch;
- governance must fund, migrate, or otherwise intervene.

**Recommendation**

Verify and reserve the full budget when opening an epoch, or introduce an
authenticated terminal `AbortEpoch` outcome for expired unfunded/failed epochs
that emits no messages. Prefer both explicit budget reservation and a bounded
recovery path. Test direct callers that bypass the frontend, fund-after-vote,
adapter failure, stop/resume, and abort authorization.

### JV-03 — Medium — Public registration can permanently squat a bounty candidate's project ID

**Status:** Confirmed.

**Affected code**

- `contracts/hack-juno-registry-adapter/src/contract.rs:195-217`
- `contracts/hack-juno-registry-adapter/src/contract.rs:278-283`
- `contracts/hack-juno-registry-adapter/src/contract.rs:399-419`
- `contracts/hack-juno-registry-adapter/src/contract.rs:436`
- `contracts/hack-juno-registry-adapter/src/contract.rs:539-588`
- `contracts/hack-juno-registry-adapter/src/contract.rs:1216-1220`

**Description**

Anyone can register any unused project ID by posting the configured bond. Every
existing `PROJECTS` record permanently blocks the same ID, regardless of
whether the record is Pending, Rejected, Suspended, or Retired. Review removes
the application index but never the project record. Authenticated bounty
graduation uses the same uniqueness check. No message can safely reassign the
record's owner, admission provenance, metadata, or initial identity to the paid
bounty recipient.

**Exploit scenario**

An attacker watches public bounty candidate metadata and registers its project
ID before payout/graduation. The subsequent authenticated `Graduate` call fails
forever with `DuplicateProject`. The observed bond is 100,000,000 `ujuno`
(100 JUNO). A hard rejection can forfeit the bond, but a soft rejection refunds
the attacker while preserving the blocking tombstone.

**Impact**

A paid project can be permanently denied graduation and gauge eligibility.
There is no safe in-contract recovery path.

**Recommendation**

Add an authenticated link/supersession flow. The bounty contract should be able
to claim a Pending or Rejected collision under curator/governor review with
deterministic bond disposition. Active collisions should use an explicit
identity dispute/link process. Consider reserving candidate IDs when a bounty
is created. Test collisions in every status and bond state.

### JV-04 — Medium — Source-bounty replay protection is not namespaced by bounty contract

**Status:** Confirmed.

**Affected code**

- `contracts/hack-juno-registry-adapter/src/state.rs:46-48`
- `contracts/hack-juno-registry-adapter/src/state.rs:150`
- `contracts/hack-juno-registry-adapter/src/contract.rs:281-283`
- `contracts/hack-juno-registry-adapter/src/contract.rs:312`
- `contracts/hack-juno-registry-adapter/src/contract.rs:842-853`
- `contracts/juno-voice-bounties/src/contract.rs:82`
- `contracts/juno-voice-bounties/src/contract.rs:215-220`

**Description**

The registry's `SOURCE_BOUNTIES` replay key and stored provenance contain only
a numeric bounty ID. Governance can replace the authorized bounty contract,
and every fresh bounty contract begins allocating IDs at one.

**Failure scenario**

If old contract A graduates bounty 1, a replacement contract B's unrelated
bounty 1 is permanently rejected as a duplicate. The entire used ID prefix from
A collides with B. This undermines the documented replacement/recovery path and
makes historical provenance ambiguous.

**Impact**

Graduation can fail for many or all early bounties after a supported contract
rotation. Recovery requires migration or a nonstandard ID namespace.

**Recommendation**

Key replay protection by `(source_contract, source_bounty_id)` and record both
values in admission provenance. A migration must backfill the historical source
contract for existing records. Test multiple source contracts with overlapping
numeric IDs.

### JV-05 — Low — Governor overrides can violate the active-bond invariant and create unterminable states

**Status:** Confirmed; privileged precondition.

**Affected code**

- `contracts/hack-juno-registry-adapter/src/contract.rs:399-418`
- `contracts/hack-juno-registry-adapter/src/contract.rs:487-530`
- `contracts/hack-juno-registry-adapter/src/contract.rs:539-588`
- `contracts/hack-juno-registry-adapter/src/contract.rs:726-759`
- `contracts/hack-juno-registry-adapter/src/contract.rs:1300-1307`

**Specification conflict**

- `docs/design/INCENTIVES_AND_GOVERNANCE.md:294-301`

**Description**

Governor override can reactivate a bonded registration after its bond becomes
Claimable, Refunded, Forfeited, or Claimed. Reactivating Claimable leaves the
depositor able to claim while the project remains Active. Reactivating a
Refunded, Forfeited, or Claimed record creates an Active project with no locked
bond. Later retirement or a terminal override calls `make_bond_claimable`,
which errors for Refunded or Forfeited bonds, so some reactivated projects
cannot reach Retired or Rejected without migration.

**Impact**

The continuing active-bond invariant can be bypassed and the status machine can
enter an unterminable state. Exploitation requires Program Vault/governor
action, limiting severity.

**Recommendation**

Define and enforce an explicit status/bond transition matrix. Activation of a
bonded registration should require `Deposited`; a still-funded Claimable bond
may be explicitly relocked. Terminal bond states should require a new bond or
remain ineligible for activation. Make terminalization idempotent where the
bond was already disposed. Test every status × bond-state transition.

## Defense-in-depth observations

These are not counted as confirmed vulnerabilities:

1. Use a two-step governor transfer for the v1 bounty contract. Its current
   `UpdateRoles` changes governor directly at
   `contracts/juno-voice-bounties/src/contract.rs:1094-1134`; a typo can lose
   administrative recovery capability.
2. Add applicant cancellation or expiry for pending registry applications.
   Applicants currently depend on curator/governor liveness to recover a bond.
3. Freeze or version registry economic policy per open epoch. Registry caps are
   read at adapter execution time and can change after gauge voting opens.
4. Keep verifying the Program Vault execution-module boundary. The adapter's
   smart query is intentionally unauthenticated and returns bank messages; its
   safety depends on only the configured gauge being able to invoke Vault
   proposal hooks.
5. Continue prominently disclosing the bounty's intentional low-participation
   rule. Multi-contributor payout requires `YES > NO` among participating
   weight and has no quorum by design.

## Strong controls observed

- Native denomination and attached-fund shapes are strictly validated.
- Bounty value transitions use checked arithmetic and update storage before
  emitting bank messages; transaction atomicity protects rollback.
- Contribution weights are snapshotted by round, and vote revisions subtract
  the old fixed weight before adding the replacement.
- Bounty settlement and pull refunds have explicit terminal states and replay
  checks; property/state-machine tests exercise accounting and single
  disposition.
- The Agent role is stop-only; governor-only paths resume or change economic
  configuration.
- Registry gauge messages are constructed only as bounded native bank sends to
  currently Active records; selected options, shares, message count, total
  emitted value, denomination, ceiling, and available balance are checked.
- Snapshot voter power and total power use one exact historical height, and
  epoch state is scoped by epoch ID.
- Collection traversals and list queries have configured or hard bounds.
- Deployed contract administrators are the documented Juno governance module
  account, and the observed code IDs/checksums match repository documentation.

## Verification performed

- `rustup run stable cargo test --workspace --locked --quiet`: **passed**, 140
  tests across the root workspace (11 + 1 + 107 + 19 + 2).
- `python3 -m unittest discover -s deployment -p 'test_*.py'`: **20 passed**.
- `python3 -m unittest discover -s integration -p 'test_*.py'`: **24 passed**.
- `git diff --check` in the root and submodule: **passed**.
- Root contract source comparison against the documented deployment commit:
  **no differences**.
- Live read-only mainnet queries: documented code IDs/checksums/admins matched;
  current economic and state observations are recorded in `LIVE_STATE.md`.

The repository-pinned Rust 1.85.1 initialization initially failed due to a
local `rust-std-wasm32-unknown-unknown` component installation conflict. The
root suite was therefore rerun successfully through the installed stable
toolchain. A separate gauge-package run did not complete: after compiling the
large upstream dependency graph, the local build reported missing
`cosmwasm_std` and `cw_storage_plus` crates while compiling
`cw-paginate-storage`. The reviewed source and existing snapshot tests, not a
newly completed upstream test run, are therefore the evidence for JV-01 and
JV-02. The deterministic optimizer build was not rerun.

## Final disposition

The contracts are **not ready for funded gauge use**. Keep the Program Vault at
zero and do not open an epoch until JV-01 and JV-02 are corrected, reviewed,
tested, rebuilt reproducibly, and deployed as a fresh v2 composition. Public bounty use should
also wait for a documented decision on JV-03 and JV-04 because both can create
permanent recovery failures. JV-05 should be fixed in the same registry
state-machine update.
