# Juno Voice v2: social bounties and Hack Juno incentives

**Status:** Accepted architecture

**Date:** 2026-08-03

**Updated:** 2026-08-12

**Scope:** Product and protocol design; not a deployment authorization

**Decision:** Add contributor-funded social bounties, use Juno `x/gov` as the program's constitutional and funding authority, use an Agent Operations DAO for bounded curation, and let Juno stakers direct a capped Hack Juno incentive tranche through epoch-snapshot gauges.

## Executive recommendation

Juno Voice should become a funding and delivery system, not only a signaling system:

```text
fund a bounty -> add to it -> deliver -> contributor ratification -> payout
                                                        |
                                                        v
                                              eligible project registry
                                                        |
                                                        v
                                      Juno-staker Hack Juno gauge incentives
```

Use five principal components:

1. **Juno `x/gov`** — the program's root authority. It approves policy, contract administration, and capped community-pool funding tranches.
2. **Hack Juno Program Vault** — a minimal DAO DAO core administered by `x/gov`. It holds only the authorized program tranche and gives the gauge a stable treasury/execution shell; it has no independent policy electorate.
3. **Agent Operations DAO** — a single reusable DAO for spam and duplicate moderation, payout-nomination fallback, delivery review, project graduation, registry curation, and one-way emergency stops. Its powers are deliberately non-custodial and replaceable by `x/gov` through the Program Vault.
4. **Juno Voice Bounties** — a purpose-built escrow contract. Contribution balances, not Juno stake, determine payout-ratification power. It enforces the full 72-hour voting period and pays atomically.
5. **Hack Juno Gauge** — an epoch-snapshot version of the DAO DAO gauge orchestrator plus a narrow project-registry adapter. Juno stakers allocate a capped epoch budget among eligible projects or explicitly choose not to distribute it.

Do **not** create a DAO core for every bounty. A bounty needs a dynamic escrow ledger and a single temporary yes/no decision. A per-bounty DAO would require a core, CW4 group, voting module, and proposal module, introduce asynchronous membership synchronization, and leave large amounts of disposable governance state. The bounty contract can implement the exact rule in a few bounded state transitions. DAO DAO remains valuable as the `x/gov`-controlled program execution shell and for agent operations, not as a second sovereign government over Juno stakers.

V2 is the deployed, security-remediated composition. The checked-in legacy
non-binding request contract is a prototype, not a migration input. The browser
client is bound to the verified fresh-deployment identities and fails closed on
any mismatch. Publishing a public artifact, funded use, and a public trial remain
separately gated.

## 1. Design goals

The design should:

- let one person state a desired outcome and credibly escrow funds for it;
- let any number of other wallets add to the same outcome without giving the creator custody of their money;
- require every multi-contributor payout candidate to remain open for exactly 72 hours of on-chain ratification;
- weight that ratification by each wallet's contribution to that bounty;
- return a rejected bounty to its open state without paying anyone;
- let successful projects become eligible for recurring Hack Juno incentives;
- admit credible existing projects without pretending that they completed a Juno Voice bounty;
- use agent governance to filter and verify high-volume operational work;
- leave payout approval with contributors and incentive allocation with Juno stakers; and
- keep every loop bounded, queryable, and recoverable without a trusted backend.

The first release should not support partial payouts, milestones inside one bounty, multiple assets, private evidence, arbitrary messages, transferable contribution shares, delegated contributor votes, or automatic subjective verification. A milestone should be a separate bounty.

## 2. Governance topology

```text
Juno x/gov
  |
  | community-pool tranche, admin, upgrades, role changes
  v
Hack Juno Program Vault (DAO core + bounded treasury)
  |
  +---- owns / executes ----> Snapshot Gauge <---- Juno staking snapshots
  |                                |
  |                                | eligible options / bounded payout msgs
  |                                v
  +----------------------> Hack Juno Registry Adapter <---- Agent Operations DAO
                                      ^                         |
                                      | project graduation      | moderate / nominate
                                      |                         v
                              Juno Voice Bounties <--------- contributors / builders
```

### 2.1 Juno `x/gov`

Juno `x/gov` is the root authority for the incentive program. It avoids creating a second government with overlapping Juno-staker membership but different quorum, delegation, and proposal semantics. It also has the native authority to approve community-pool funding.

`x/gov` controls:

- the total size, denomination, term, and renewal of each Hack Juno funding tranche;
- Program Vault, gauge, registry, and bounty code administration and migrations;
- economic configuration and per-epoch spending ceilings;
- appointment or replacement of the Agent Operations DAO;
- recovery, gauge resumption, and appeals against project-registry decisions; and
- any future change to the program's constitutional authority.

`x/gov` should make infrequent, high-impact decisions. It should not vote on individual bounty payouts, registrations, moderation actions, or weekly gauge allocations. Bounty contributors control their own escrow, the Agent Operations DAO handles bounded operational judgment, and the gauge applies the allocation policy already authorized by `x/gov`.

### 2.2 Hack Juno Program Vault

The Program Vault is a minimal [`dao-dao-core`](../../deps/dao-contracts/contracts/dao-dao-core/README.md) deployment with its external `admin` set to the Juno `x/gov` module account. It is an execution and custody shell, not an independently governed Hack Juno DAO.

The vault:

- receives a fixed, loss-bounded community-pool tranche approved by `x/gov`;
- instantiates [`dao-voting-juno-staked`](../../deps/dao-contracts/contracts/voting/dao-voting-juno-staked/README.md) as the gauge's historical voting-power source;
- installs the snapshot gauge as its recurring execution module;
- acts as the application-level `governor` address for the bounty and registry contracts;
- executes `x/gov`-authorized configuration and recovery messages through DAO core's external-admin path; and
- holds unallocated epoch funds until another authorized epoch or the program's unused-funds recovery path.

It has no separate policy proposal module, configurable staker quorum, or independent mandate. The gauge may execute only the narrow messages produced by the reviewed registry adapter. The vault cannot spend beyond its actual tranche balance, and the adapter enforces an additional per-epoch ceiling.

The CosmWasm migration admin and application governor are distinct concepts. Code administration should remain explicitly under `x/gov`; normal application calls use the stable Program Vault core address so every downstream contract has one inspectable governor.

### 2.3 Agent Operations DAO

Reuse the Juno Agents DAO initially if its live code, membership, threshold, and response time are reviewed and disclosed. Otherwise instantiate one CW4-based subDAO with a narrow public charter. Registering an address in DAO DAO's subDAO list is descriptive; authority still comes from explicit roles in the bounty and registry contracts.

The Agent Operations DAO may:

- mark an open bounty as spam or duplicate, causing contributor refunds rather than confiscation;
- nominate a payout candidate when the bounty creator is unavailable;
- publish delivery-review attestations and project-graduation decisions;
- approve, reject, suspend, or retire project registrations; and
- maintain bounded display metadata; and
- pause new bounty activity, suspend a project, or stop the gauge as one-way safety actions.

It may not:

- release a multi-contributor bounty without the contributor vote;
- redirect bounty principal or contributor refunds;
- change contribution weights or votes;
- set the Hack Juno epoch budget;
- allocate gauge rewards;
- return a failed project's allocation to itself; or
- upgrade contracts, resume the gauge, or unpause the system on its own.

All agent actions should execute from the Agent Operations DAO core after an on-chain proposal, not from an individual agent wallet. One-way safety powers compensate for the slower root-governance process without allowing the agent DAO to restart spending. Juno `x/gov`, acting through the Program Vault, can replace the curator, resume the gauge, unpause the system, or override a registry status.

An agent pause must not trap existing funds: active payout voting, finalization, expiry, and refunds continue. It blocks only new bounty creation, new contributions, and new nominations until the Program Vault unpauses the system.

### 2.4 Why contributors are not a subDAO

A DAO DAO core has one voting module, while every bounty has a different membership set and weights. Representing contributors with standard modules would require at least one weighted CW4 group and one DAO/proposal stack per bounty. Contributions made after creation would also need safe membership-hook synchronization.

The bounty contract already has the canonical data needed for this one decision:

```text
voting_power(bounty, address, round) = contributed_ujuno(bounty, address)
```

Keeping this rule inside escrow eliminates cross-contract synchronization risk and makes payout and state transition atomic. Contributors are still performing on-chain governance; they simply do so through a purpose-built assembly rather than a permanent DAO core.

## 3. Social bounty protocol

### 3.1 Bounty creation

A creator calls `CreateBounty` with:

- title and bounded summary;
- immutable, inline acceptance criteria;
- optional detail URI plus SHA-256 digest;
- an expiry timestamp within a configured minimum and maximum lifetime;
- an optional project-candidate flag and initial project metadata; and
- an attached amount of the one supported native denomination.

The attached amount must meet the minimum bounty amount. It is the creator's first contribution, not a separate submission bond. The specification and expiry become immutable. Material changes require a new bounty so contributors never fund a moving target.

V2 accepts only native `ujuno`. A single-denomination escrow keeps contribution weights, refunds, and voting power identical and auditable. CW20 or cross-denomination bounties can be a later protocol version.

### 3.2 Contributions

While a bounty is `OPEN` and before expiry, anyone may call `Contribute` with a positive `ujuno` amount. Repeated deposits by one wallet aggregate into one contribution and one vote weight. Splitting a contribution across addresses does not create extra voting power.

Contributions are commitments, not revocable tips. They cannot be withdrawn while the bounty remains live. This makes the displayed bounty credible to builders. Recovery is available through expiry, creator cancellation while there is still only one contributor, or agent moderation that opens pull refunds.

The contract maintains:

```rust
total_contributed: Uint128
contribution[(bounty_id, address)]: Uint128
contributor_count: u32
```

No payout, finalization, or refund transition iterates across contributors. Each contributor claims their own refund.

### 3.3 Payout nomination

The creator or Agent Operations DAO may nominate one completed delivery while the bounty is open. The nomination contains:

- payout address;
- delivery evidence URI and digest;
- a bounded rationale addressing the immutable acceptance criteria; and
- optional project metadata for later graduation.

Only one nomination may be active. Opening it freezes contributions, records the current round, contributor count, and total, and prevents cancellation or moderation from changing the electorate.

The agent DAO is a screening and fallback service, not a required payout oracle. Creator nomination keeps the bounty censorship-resistant; agent nomination allows progress if a creator disappears. Contributors remain the final authority whenever more than one wallet funded the bounty.

### 3.4 Single-contributor payout

If the snapshotted contributor count is one, no contributor ballot is required. The sole contributor must explicitly confirm the exact nomination before the earlier of bounty expiry and the 72-hour bounded confirmation deadline. Confirmation pays the full bounty to the nominated address atomically. If the contributor does not act, any account may finalize at the deadline and move the full principal into pull refunds.

The nomination transaction should not silently count as confirmation. A separate confirmation gives wallets an exact transaction review of the recipient, total, and evidence, while still allowing immediate settlement in the next transaction.

### 3.5 Multi-contributor ratification

If the snapshotted contributor count is greater than one, nomination starts a 72-hour, time-based voting period:

```text
opens_at  = current block timestamp
closes_at = opens_at + 259,200 seconds
valid     = opens_at <= block time < closes_at
```

The period is measured in seconds, not an estimated number of blocks. It can never complete early. Contributors may vote `YES` or `NO` and may change their vote until the end. The contract stores one receipt per `(bounty, round, contributor)` and updates tallies by checked differences.

For contributor `a`:

```text
weight(a) = contribution[(bounty_id, a)] at nomination
Y = sum(weight(a) for the latest YES votes)
N = sum(weight(a) for the latest NO votes)
P = Y + N
```

After the complete 72 hours, anyone may finalize:

```text
if P > 0 and Y > N:
    confirm the payout
else:
    reject the nomination and reset the bounty
```

`Y > N` is exactly “more than 50% of voting contribution weight voted yes.” `N > Y` is more than 50% no. The additional fail-safe rule resolves the otherwise unspecified tie and no-vote cases: both reset with no payment. A reset clears the nomination, increments the round, preserves all contributions, and reopens top-ups if the bounty has not expired. Old receipts remain historical but cannot count in a later round.

This interpretation intentionally uses only participating `YES + NO` weight, matching “voting contributors.” It has no turnout quorum: a small contributor can approve if every larger contributor abstains. If the intended policy is instead majority approval by **all contributed funds**, the condition must be changed before implementation to `Y * 2 > snapshotted_total`. The UI must state the selected denominator unambiguously.

### 3.6 Payout, reset, expiry, and refunds

The complete state machine is:

```text
                         nomination (one contributor)
                        |                          v
                        |                          v
    CREATE -> OPEN -> SINGLE_CONFIRMATION ----------> PAID
                |           |
                |           +-- sole contributor declines before close --> OPEN
                |           +-- timeout/expiry finalized by anyone --> REFUNDING
            |
            +-- nomination (multiple contributors) --> RATIFYING
            |                                             |
            |                   after full 72h: YES wins --+--> PAID
            |                                             |
            |                   NO/tie/no votes -----------+--> OPEN
            |
            +-- expiry / allowed cancellation / moderation --> REFUNDING
                                                               |
                                                    pull claims v
                                                            REFUNDED
```

Rules:

- A successful finalization updates state before emitting one bank transfer. CosmWasm transaction atomicity means a failed transfer cannot leave a paid state.
- Payout is always the full escrowed bounty in v2. Partial awards and milestones use separate bounties.
- If a rejected ratification ends after the bounty expiry, it moves directly to `REFUNDING` instead of reopening.
- While `OPEN`, anyone may expire a bounty after its deadline.
- The creator may cancel only while they remain the sole contributor and no nomination is active.
- Agent moderation is allowed only while `OPEN`; it opens refunds for every contributor. Bounty principal is never slashed.
- Each contributor calls `ClaimRefund`; state is marked claimed before the bank message.
- Unsolicited transfers create no contribution or refund claim.

### 3.7 Agent moderation and evidence

Moderation should use typed outcomes: `SPAM`, `DUPLICATE { canonical_id }`, and `POLICY_VIOLATION`, each with a bounded reason. These outcomes affect discovery and open refunds; they never transfer contributor funds to the agent DAO.

Evidence is an immutable URI/digest assertion. Neither the contract nor the agent DAO can prove that an external repository, deployment, or audit is correct. Product language should say “agent-reviewed delivery” and “contributor-confirmed payout,” not “verified truth.”

## 4. Project graduation and registration

Completing a bounty and becoming eligible for recurring incentives are separate decisions. A documentation task may deserve its bounty without becoming a gauge project.

### 4.1 Graduation path

After `PAID`, the Agent Operations DAO may call `GraduateProject` if:

- the bounty was marked as a project candidate;
- the bounty candidate includes payout metadata URI and digest, while the paid
  recipient supplies the payout address; no candidate or creator supplies a
  project ID;
- the delivery evidence is sufficient for the published Hack Juno eligibility policy; and
- the project is not already registered.

The bounty contract then calls the registry from its own authenticated address. The registry records the source bounty and activates the project without a separate registration bond. The successful funded delivery is its admission evidence.

Graduation does not guarantee rewards. It only makes the project an option in future gauge epochs.

### 4.2 Existing-project path

An existing project calls `RegisterProject` directly on the registry with metadata, payout address, and a registration bond. It enters `PENDING` and is not a gauge option yet. The Agent Operations DAO may:

- approve it into `ACTIVE`;
- soft-reject it and refund the bond;
- hard-reject clear spam and send only the registration bond to the configured Program Vault or community destination; or
- request corrected metadata without changing the payout address silently.

An active project's bond remains locked while it is listed. Good-standing retirement refunds it. This is more useful than the current marketing adapter's one-way global deposit wind-down.

### 4.3 Registry states and authority

```text
existing project: PENDING -> ACTIVE -> SUSPENDED -> ACTIVE
                         \-> REJECTED             \-> RETIRED

graduated project:             ACTIVE -> SUSPENDED / RETIRED
```

Only `ACTIVE` projects pass `CheckOption`. Suspension immediately prevents selection at execution even if an old tally exists. The Agent Operations DAO curates status; Juno `x/gov`, acting through the Program Vault, can override status and replace the curator. Payout-address changes use propose/accept semantics plus a delay so voters and operators can see the destination before it becomes payable.

The registry assigns immutable, monotonically increasing numeric project IDs and encodes gauge keys as canonical `project:<id>` values. Applicants and bounty creators never supply an ID. The adapter resolves each ID to its current approved payout address only when producing messages, avoiding both address identity and caller-controlled ID squatting.

Reserve one immutable option such as `do-not-distribute`. Its selected share produces no transfer, so those funds remain in the Program Vault. Unallocated vote weight and allocations excluded by thresholds or caps also remain in the vault; they are never renormalized to winners. The `x/gov` funding proposal must define whether unused funds remain available for later epochs or return to the community pool at tranche expiry.

The current orchestrator permits at most 100 options. The initial registry must therefore cap active projects at 99 plus the reserved option, and refuse a graduation or approval that would exceed the cap. Retiring a stale project frees a slot. Raising this limit or splitting the program into multiple gauges requires new target-chain gas evidence and an explicit governance decision; it must not be achieved by silently truncating the registry.

## 5. Hack Juno gauge design

### 5.1 What can be reused

The current gauge stack already provides strong bounded vote validation, option limits, selected-set caps, adapter validation, epoch execution, health queries, stable events, and proportional budget examples. The [`gauge-budget-allocator`](../../deps/dao-contracts/contracts/gauges/budget-allocator/README.md) is a good starting point for payout generation, while the [marketing adapter](../../deps/dao-contracts/contracts/gauges/gauge-adapter/README.md) supplies useful bonded-registry patterns.

The present contracts are not production-approved merely because their local test suite passes. Their [readiness document](../../deps/dao-contracts/contracts/gauges/READINESS.md) still requires target-chain gas evidence, exact-artifact testnet scenarios, an independent audit, and a low-value canary.

### 5.2 Required Juno-staked compatibility change

The two desired components cannot safely be connected unchanged:

- `dao-voting-juno-staked` deliberately emits no staking-delta hooks. Juno snapshots settle in EndBlock, and the chain hook payloads cannot reconstruct every affected delegator's final power.
- The current gauge orchestrator queries power when a voter casts and relies on authenticated stake/member hooks to update that stored vote afterward.

If they are wired together without changes, a voter who later changes stake can leave a stale gauge tally. Supplying an arbitrary `hook_caller` does not solve that problem.

Add an explicit `EpochSnapshot` power mode to the orchestrator:

1. Opening epoch `e` stores one `snapshot_height` and queries total Juno-staked power at that height.
2. Every vote in `e` queries `VotingPowerAtHeight { height: snapshot_height }`.
3. Votes and tallies are scoped to `e`; no power-change hook is expected or accepted in this mode.
4. Voters may revise allocation during the epoch, but their power remains the fixed snapshot value.
5. Epoch execution uses only that epoch's tally, then advances to a new epoch and new snapshot.
6. Old vote/tally cleanup is bounded. A new epoch must never mix old and new snapshot power.

This is simpler and more correct than attempting to synthesize missing stake hooks. It also matches the fixed-height semantics DAO DAO proposal modules already use.

Track two denominators:

- `participating_power`: the full snapshot power of every wallet with a nonempty current-epoch vote, counted once, for turnout; and
- `allocated_power` (`total_cast` in the legacy compatibility field): the sum of power actually allocated across options, for accounting only.

Without the first value, a voter allocating only part of their power would be incorrectly treated as only partially participating.

### 5.3 Turnout and allocation policy

The current orchestrator has no turnout quorum, so one small voter can direct the entire epoch budget. A funded Hack Juno deployment should add a snapshot-total turnout check before execution:

```text
participating_power * 10,000 >= snapshot_total_power * min_turnout_bps
```

If turnout fails, emit a no-distribution epoch and leave the full budget in the Program Vault. Do not roll it automatically into a larger next epoch.

Reasonable canary settings to test—not silently hardcode—are:

| Setting | Canary starting point |
|---|---:|
| Epoch duration | 7 days |
| Minimum turnout | 1% of snapshotted Juno voting power |
| Minimum project share | 1% of participating power |
| Maximum selected projects | 10 |
| Maximum share per project | 20% |
| Explicit abstention option | `do-not-distribute` |

The Juno `x/gov` proposal that funds the canary must set the actual values after reviewing stake concentration, expected participation, transaction gas, and the epoch budget.

### 5.4 Narrow adapter authority

The generic orchestrator forwards arbitrary messages returned by an adapter. An attached adapter therefore has recurring DAO execution authority. The Hack Juno adapter must be narrower than a generic arbitrary-message source:

- immutable native denomination;
- per-epoch amount bounded by an `x/gov`-authorized maximum;
- only bank sends to payout addresses of currently `ACTIVE` registry records;
- at most one send per selected project;
- integer flooring leaves dust in the DAO;
- no message for `do-not-distribute` or unallocated shares;
- economic configuration controlled only by the Program Vault under `x/gov` administration;
- eligibility curation controlled only by the replaceable Agent Operations DAO; and
- no user-supplied `CosmosMsg` bytes in registry state.

Splitting `governor` and `curator` roles prevents the faster agent process from increasing or redirecting the overall budget. The Program Vault core is the application governor, `x/gov` is its external admin, and the Agent Operations DAO is the replaceable curator and one-way safety guardian.

## 6. Contract boundaries

### 6.1 Reuse unchanged

| Component | Use |
|---|---|
| Juno `x/gov` | Root policy, community-pool funding, code administration, recovery, and role replacement |
| `dao-dao-core` | `x/gov`-administered Program Vault and Agent Operations DAO core |
| `dao-voting-juno-staked` | Program Vault voting module and historical power source for epoch gauges; not a second policy electorate |
| `dao-proposal-single` | Agent Operations DAO proposals only |
| CW4 voting stack | Agent Operations DAO membership, if a new DAO is needed |

### 6.2 Extend or add

| Component | Change |
|---|---|
| `juno-voice-bounties` | New bounded native escrow, contribution voting, refunds, evidence, and graduation calls |
| `gauge-orchestrator` | Add epoch-snapshot power mode, separate turnout accounting, minimum turnout, and a guardian that may stop but not resume |
| `hack-juno-registry-adapter` | New project lifecycle, two admission paths, split governor/curator roles, bounded native payouts |
| Juno Voice application | Add bounty funding, ratification, refunds, project registry, and gauge epoch views |

Do not use the existing marketing adapter unchanged. It makes a submission immediately discoverable as an option, keys identity by payout address, combines registry and reward configuration under one owner, and provides a global one-way bond refund process. Those semantics do not express pending approval, graduation provenance, continuing active bonds, or split economic/curation authority.

### 6.3 Suggested bounty execute surface

```rust
CreateBounty { brief, expires_at, project_candidate }
Contribute { bounty_id }
NominatePayout { bounty_id, recipient, evidence, rationale, project }
ConfirmSolePayout { bounty_id }
DeclineSolePayout { bounty_id, reason }
VotePayout { bounty_id, vote: Yes | No, rationale }
FinalizePayout { bounty_id }
CancelSoleFunded { bounty_id, reason }
Expire { bounty_id }
ClaimRefund { bounty_id }
Moderate { bounty_id, outcome, reason }
GraduateProject { bounty_id }
UpdateConfig { future_bounty_fields, curator }
PauseNewActivity { reason }
UnpauseNewActivity { reason }
```

`UpdateConfig`, pause recovery, and curator replacement are governor-only, where `governor` is the Program Vault core administered by `x/gov`. `Moderate` and `GraduateProject` are curator-only. The Agent Operations DAO may invoke only explicitly defined one-way pause/stop messages. Finalization, expiry, and refund claims are permissionless or claimant-bound as appropriate. Every execute except creation/contribution rejects attached funds.

## 7. Core invariants

Implementation and review should treat these as protocol requirements:

1. `sum(active contributions) + sum(unclaimed refunds)` is fully backed by the contract's accounted native balance.
2. Bounty principal is paid at most once and refunded at most once per contribution.
3. Agent moderation never confiscates bounty principal.
4. A multi-contributor payout cannot execute before `closes_at`, even if every contributor has voted.
5. A ratification round's contribution weights, total, contributor count, nomination, duration, and rule are immutable.
6. Votes from one round cannot affect another round.
7. A failed, tied, or empty vote never pays.
8. No lifecycle transition requires iterating across all contributors or voters.
9. A project cannot be paid by a gauge unless it is active both when selected and when the adapter is queried for execution.
10. One gauge epoch uses one historical Juno snapshot for every voter and the total.
11. Failure to meet gauge turnout produces no distribution and no automatic budget rollover.
12. Agent authority, staker authority, contributor authority, and contract migration authority are separately queryable and logged.

All amounts use checked arithmetic. Strings, evidence counts, project counts, selected options, messages, and query pages have hard limits. Configuration affecting an active bounty or epoch is copied into that object so governance cannot rewrite a vote already in progress.

## 8. Failure and abuse analysis

| Risk | Design response |
|---|---|
| Bounty or claim spam | A real minimum contribution is required; nomination is creator/agent-gated; agent moderation opens refunds without touching principal. |
| Agent censorship | The creator can nominate directly; contributors decide payout; `x/gov` can replace the agent DAO through the Program Vault. |
| Agent theft | The agent DAO cannot pay a multi-contributor bounty, redirect refunds, or set the gauge budget. |
| Contributor Sybils | Weight follows contributed amount, so splitting addresses creates no additional weight. |
| Low-turnout bounty capture | This follows the requested “voting contributors” rule and is disclosed; switch to total-contribution majority if this is not intended. |
| Creator repeatedly nominates bad work | Each attempt consumes a full 72-hour round, the bounty has a fixed expiry, and expired rejection moves to refunds. |
| Builder self-approves | A builder may also be a contributor, but controls only their contributed share. Graduation still requires agent review and incentives still require Juno-staker allocation. |
| Gauge low-turnout capture | Epoch snapshot total plus explicit minimum turnout; failed turnout distributes nothing. |
| Stale gauge voting power | Epoch-fixed historical power; no unsupported dependency on Juno staking hooks. |
| Malicious adapter | Purpose-built message restrictions, split roles, `x/gov`-controlled code administration, exact-artifact audit and canary. |
| Project changes payout address | Delayed propose/accept update, agent approval, visible events, and `x/gov` override through the Program Vault. |
| Agent swarm or common operator | Public DAO proposals, narrow non-custodial powers, contributor ratification, staker allocation, and replaceability create independent checks. |
| Slow root-governance response | The Agent Operations DAO may stop, pause, or suspend but cannot resume spending; `x/gov` controls recovery. |
| Program-vault compromise | Community funding is tranche-bounded, adapter spending is epoch-capped, and renewal requires a new `x/gov` decision. |
| Snapshot pruning or restart | Enforce activation boundary and monitor live retention beyond the longest proposal/epoch plus margin. |
| Keeper failure | Finalize, expire, refund, gauge execute, and bounded cleanup are public; alert on overdue rounds and epochs. |
| Upgrade capture | Juno `x/gov` is the disclosed code administrator. V2 is freshly instantiated at new addresses with no v1 import; any future migration requires its own version-gated specification, populated-state tests, and proposal. |

## 9. Product behavior

The primary Juno Voice object becomes the bounty. Each page should show:

- exact escrowed amount and denomination;
- immutable acceptance criteria and evidence digest;
- creator, contributor count, and the connected wallet's contribution;
- expiry and current state;
- nominated recipient and evidence;
- ratification opening/closing timestamps;
- raw yes/no contribution weight, participating weight, and the stated denominator;
- whether a payout is contributor-confirmed, agent-reviewed, and/or graduated; and
- refund availability and exact claimant amount.

The project page should keep three concepts visually separate:

- **graduated or registered** — eligible to appear in a gauge;
- **selected in the current/last epoch** — received staker preference; and
- **paid** — an on-chain epoch transfer actually executed.

The gauge UI must display snapshot height, total snapshot power, participating power, turnout threshold, total allocated power, caps, unallocated share, `do-not-distribute` share, selected-project power, emitted and retained value, policy version, execution deadline, epoch budget, and terminal outcome. It must not present participating-voter percentages as percentages of all Juno stake.

## 10. Deployment plan

### Phase 1 — social bounties

- Implement and independently specify `juno-voice-bounties`.
- Instantiate the Program Vault with Juno `x/gov` as external admin and no independent policy proposal lane.
- Configure the Program Vault core as application governor and the reviewed Agent Operations DAO as curator and one-way safety guardian.
- Launch native-JUNO bounties with low value limits.
- Exercise creation, multiple contributors, yes/no/tie/no-vote finalization, reset, expiry, moderation, payout failure, and pull refunds on an authorized Juno-compatible target with exact `ujuno` staking/funding denomination.

This phase delivers incentives immediately without waiting for recurring gauge rewards.

### Phase 2 — graduation and registry

- Implement the project registry and both admission paths.
- Test sequential assigned IDs, failed-allocation rollback, inability to squat an
  ID, namespaced bounty replay, payout-address changes, suspension between tally
  and execution, bond disposition, and Program Vault governor overrides.
- Enable graduation only after at least one paid bounty has complete delivery evidence.

### Phase 3 — snapshot Hack Juno gauge

- Add and model-test epoch-snapshot mode and turnout accounting.
- Test one immutable power basis across delegation changes and EndBlock boundaries on Juno v30.
- Record the live snapshot activation boundary, retention window, and liquid-staking exclusion allowlist; require retention longer than every proposal/epoch that may query it plus an operating margin.
- Complete the gauge repository's external release gates: exact-artifact public testnet evidence, worst-case gas, independent audit, monitoring, and at least a two-epoch low-value canary.
- Fund only a fixed, loss-bounded canary tranche through Juno `x/gov`. Production funding or renewal requires a separate `x/gov` proposal reviewing the evidence.

### Prototype isolation

Do not migrate prototype or v1 requests, votes, roles, projects, or bonds into v2. Prototype code may remain in the repository as an implementation reference, but it has no standing in the v2 state model. Existing real-world projects use the bonded registration path unless they complete a qualifying v2 bounty.

## 11. Decisions to ratify before implementation

| Question | Recommended answer |
|---|---|
| Payout majority denominator | Participating contribution weight (`YES > NO`), with tie/no-vote reset, matching the stated requirement |
| Bounty asset | Native `ujuno` only in v2 |
| Multi-contributor voting period | Exactly 259,200 seconds, never early |
| Payout shape | One full-pot payout; milestones are separate bounties |
| Nomination authority | Creator or Agent Operations DAO |
| Bounty principal slashing | Never |
| Per-bounty DAO | No; use the escrow's contribution ledger |
| Durable operational DAO | One reusable Agent Operations DAO with narrow roles |
| Graduation | Explicit agent-DAO review after payout; not automatic for every task |
| Existing projects | Bonded pending registration followed by agent approval |
| Gauge voting power | One Juno staking snapshot per epoch |
| Gauge turnout | Required; no-distribution below threshold |
| Unwanted allocation | Explicit `do-not-distribute`; funds remain in the Program Vault subject to the tranche's unused-funds policy |
| Root authority | Juno `x/gov` |
| Program treasury/execution | Minimal DAO DAO Program Vault with `x/gov` as external admin and no independent policy electorate |

## 12. Source constraints informing this design

- The [Juno Voice backend architecture](../architecture/ARCHITECTURE.md) fixes contract boundaries, authority, state machines, and invariants for this design.
- Juno [`x/gov`](https://docs.cosmos.network/sdk/latest/modules/gov/README) is the canonical Juno-staker proposal authority and can execute registered messages after passage; Juno governance already defines community-spend funding as a network decision.
- [`dao-voting-juno-staked`](../../deps/dao-contracts/contracts/voting/dao-voting-juno-staked/README.md) provides proposal-compatible historical Juno staking power but intentionally exposes no staking-delta hooks.
- The [gauge threat model](../../deps/dao-contracts/contracts/gauges/ARCHITECTURE.md) documents its present hook dependency, lack of turnout quorum, arbitrary-adapter execution boundary, bounded work, and release risks.
- [DAO DAO core](../../deps/dao-contracts/packages/dao-interface/src/msg.rs) supports an external admin executing messages, which lets the Program Vault remain subordinate to `x/gov`; subDAO listing by itself does not confer application authority.

The result is deliberately asymmetric: `x/gov` authorizes public funding and constitutional changes, agents handle operational volume and judgment, contributors control their escrowed bounty, and Juno stakers express recurring allocation preferences through the snapshot gauge. No one operational group can perform all of these actions.
