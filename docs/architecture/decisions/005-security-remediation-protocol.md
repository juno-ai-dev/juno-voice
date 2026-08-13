# ADR-005: Juno Voice v2 security-remediation protocol

**Status:** Accepted

**Date:** 2026-08-12

**Supersedes:** The conflicting identity, allocation, and epoch-lifecycle parts
of ADR-003 and the v1 public interface

## Context

The v1 security review found that partial snapshot ballots were normalized by
their allocated weight, an unfunded epoch could remain executable forever,
project identity was caller-controlled, bounty replay protection did not
include the source contract, and administrative status overrides could detach
an active project from its registration bond. These issues cross the generic
gauge, the Juno Voice registry adapter, the bounty contract, and all clients.
They therefore require one frozen protocol rather than independent local
fixes.

This decision defines the interfaces and state invariants used by the fresh v2
contracts and deployment. V1 state is not migrated. Terms in this decision are
normative.

## Decision

### 1. Snapshot allocation accounting

For each epoch the gauge stores:

- `snapshot_total_power`, the voting module's total at the epoch snapshot;
- `participating_power`, the full snapshotted power of each voter whose current
  ballot is non-empty, counted once;
- `allocated_power`, the sum of the per-option integer allocations, including
  the retained option; and
- `retained_option_power`, the raw allocation to the configured retained
  option, or zero when no retained option is configured.

The gauge enforces:

```text
allocated_power <= participating_power <= snapshot_total_power
```

An empty ballot is abstention and removes the voter from
`participating_power`. A non-empty ballot participates with the voter's full
snapshot power even when its weights sum to less than one. The remainder is
`participating_power - allocated_power`; the gauge does not synthesize an
option for it.

Turnout and every project threshold, cap, and adapter share use
`participating_power` as their denominator. For project `p`:

```text
raw_share[p] = option_power[p] / participating_power
payable_share[p] = min(raw_share[p], max_project_share)
```

The minimum-project-share comparison uses `raw_share[p]`. Division by zero is
a terminal no-distribution outcome. Project payouts are individually floored;
their sum may not exceed the epoch budget or the Vault's execution-time
balance. Threshold exclusions, invalid projects, cap overflow, unallocated
power, retained-option power, and rounding dust are never redistributed.

Stable epoch queries and terminal events report at least raw allocated power,
retained-option power, unallocated power, selected project power, emitted
value, and retained value. Paginated option-allocation and ballot queries
remain bounded.

### 2. Retained option

`EpochSnapshotPolicy.retained_option` is an optional typed configuration.
`None` preserves legacy gauge semantics. `Some(option)` identifies a sink and
is copied into the opened epoch together with the policy version.

Opening validates that the configured option is non-empty, canonical, and in
the epoch's snapshotted option set. At execution the retained option is
reported but is excluded before project validity checks, project minimum and
maximum shares, sorting/top-N selection, selected-project counts, and adapter
messages. The generic gauge does not know the Juno Voice literal. The Juno
Voice deployment configures `do-not-distribute`.

### 3. Epoch policy and terminal lifecycle

Every snapshot policy has a monotonically increasing stored version and a
positive `execution_window_seconds`. Opening copies the complete policy and
version into the epoch, fixes:

```text
closes_at = opens_at + gauge_epoch_seconds
execution_deadline = closes_at + execution_window_seconds
```

and atomically requires the Program Vault (`dao_core`) to hold at least the
full configured budget in the configured denomination. All external queries
and validation precede the first write. A rejected open creates no epoch,
receipt, snapshot record, counter increment, or schedule mutation.

After voting closes and no later than the deadline, `Execute` derives
non-renormalized project shares and queries the adapter. In snapshot mode the
adapter response includes `emitted_value` and `retained_value`. The gauge
checks message and value bounds, requires the two values to sum to the epoch
budget, and requires only `emitted_value` to be available. If the current
balance is too small, the epoch terminalizes as `INSUFFICIENT_FUNDS` and emits
no messages. Otherwise all adapter messages are submitted through the Vault
atomically and the outcome is `DISTRIBUTED` (or an explicit zero-distribution
outcome).

At or after `execution_deadline`, anyone may terminalize an open epoch as
`EXPIRED` with no messages. The governor may terminalize an open epoch as
`ABORTED { reason }`; the reason is non-empty and bounded. The guardian remains
stop-only. Execution, expiry, and abort are mutually exclusive and never
retry a terminal ballot.

Each terminal transition advances the gauge schedule exactly once. The next
epoch may open immediately after terminalization, but retains the configured
fixed interval after it opens. Terminal outcomes do not roll budgets forward.

### 4. Project identity and gauge encoding

The registry owns `NEXT_PROJECT_ID`, initialized to one. It allocates an
immutable, monotonically increasing `u64` only after all request validation and
authentication succeeds. CosmWasm transaction rollback ensures a failed
write, reply, or submessage does not consume the number. Retired and rejected
records remain and IDs are never reused.

Applicants and bounty creators do not submit a project ID. Human-readable
names, slugs, payout addresses, metadata digests, and URIs are non-unique
metadata. Project queries and pagination use numeric order.

The only project gauge encoding is:

```text
project:<base-10-u64>
```

The decimal part is non-empty, has no leading zero, is within `u64`, and
round-trips to the identical string. The retained option is outside this
namespace. Malformed encodings are rejected rather than normalized.

### 5. Bounty graduation handshake and provenance

A new-project bounty candidate contains project presentation metadata but no
project ID. Graduation sends a reply-on-success submessage to the registry.
The registry allocates the ID and returns a versioned typed response containing
that ID. The bounty contract accepts only its pending reply, decodes and
validates the response, and then records graduation. Any submessage error,
malformed response, mismatched pending reply, registry error, or finalization
error rolls the complete transaction back.

Registry replay protection is permanently keyed by:

```text
(validated source_bounty_contract address, source_bounty_id)
```

Both fields are stored in project provenance and exposed by query and event.
Only the currently configured bounty contract may create a graduation, but
rotating that authority does not delete old replay keys. Linking a bounty to a
pre-existing project is not supported.

### 6. Project and bond transition engine

Every status change calls one transition engine with admission provenance,
current project and bond state, requested transition, caller authority, typed
reason, actual liability backing, and all count/index deltas. No governor-only
write bypasses it.

The bonded table is:

| From | To | Bond change |
| --- | --- | --- |
| `PENDING` | `ACTIVE` | `DEPOSITED -> DEPOSITED` |
| `PENDING` | `REJECTED` (soft) | `DEPOSITED -> REFUNDED` |
| `PENDING` | `REJECTED` (hard) | `DEPOSITED -> FORFEITED` |
| `ACTIVE` | `SUSPENDED` | `DEPOSITED -> DEPOSITED` |
| `SUSPENDED` | `ACTIVE` | `DEPOSITED -> DEPOSITED` |
| `ACTIVE` or `SUSPENDED` | `RETIRED` | `DEPOSITED -> CLAIMABLE` |
| `RETIRED` | `RETIRED` (claim) | `CLAIMABLE -> CLAIMED` |
| `RETIRED` | `ACTIVE` (governor restore) | `CLAIMABLE -> DEPOSITED` |

The restore is valid only while the claimable liability is fully backed.
`REFUNDED`, `FORFEITED`, and `CLAIMED` never back `ACTIVE` or `SUSPENDED`.
Bond claims require `RETIRED + CLAIMABLE`. Graduated, bond-free provenance has
its own explicit status table and never gains a synthetic bond.

Option membership and active/pending counts change with the status in the same
transaction. At every successful transition:

```text
bond_liability <= actual registry native balance
ACTIVE or SUSPENDED bonded project => bond == DEPOSITED
settled bonded project => not an active gauge option
```

### 7. Versioning and deployment

All affected execute/query messages are a breaking v2 interface. Old
caller-chosen-ID messages are removed and fail decoding. Schemas, clients,
deployment messages, fixtures, monitors, and event parsers advance together.

V2 is freshly instantiated at new deterministic addresses from exact reviewed
checksums and v2 salts. No v1 state or address is preserved. Immediately before
cutover, operators independently prove the old composition has no projects,
bounties, liabilities, pending graduation replies, open epochs, or Vault funds.
If any predicate fails, cutover stops for a separately reviewed recovery and
disposition plan; old state is never silently imported into v2. Deployment
verification binds the new addresses, authorities, empty counters/indexes,
retained option, policy version, and absence of an open epoch.

## Consequences

Partial participation can intentionally leave most of a budget in the Vault;
this is correct and observable. A configured retained option cannot reduce the
number of funded project slots. Economic policy changes affect only future
epochs. Epoch adapter failures remain retryable only until a governor abort or
the bounded deadline, while insufficient execution funds are immediately
terminal to prevent later top-up activation.

Numeric IDs require client metadata resolution and coordinated breaking schema
updates. The fresh-deployment boundary avoids an unaudited state transformation
but requires an explicit old/new client and operator cutover. Funding remains prohibited
until the release, chain-evidence, independent-review, and canary gates in
`GOAL.md` are separately satisfied.
