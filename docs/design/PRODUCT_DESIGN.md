# Juno Voice product behavior

**Status:** Accepted Juno Voice v2 candidate behavior. V2 is not deployed;
funded use remains blocked pending fresh deployment, review, and canary gates.

**Implementation scope:** [GOAL.md](../../GOAL.md) specifies the remediation and
release gates. The current [`app/`](../../app/) implements the v2 bounty,
registry, settlement, and gauge surfaces without production address defaults.

**Historical prototype:** the earlier `uni-7` request-prioritization interface is
retained only in repository history and legacy contract documentation.

## Product promise

Juno Voice is a public market for desired work. People describe an outcome, pool native Juno behind it, ratify delivery, and allow successful projects to graduate into recurring Hack Juno incentives.

The product should answer four questions without requiring protocol expertise:

1. What outcome is being requested and how much is committed?
2. Who may decide whether the delivery earns the bounty?
3. What was delivered and how was the decision reached?
4. Which projects may receive the current Hack Juno allocation?

The chain is the authoritative ledger. Indexers may improve discovery but must not invent balances, states, eligibility, voting power, or outcomes.

## Core objects

### Bounty

A bounty contains an immutable brief, acceptance criteria, native-denom contribution ledger, current round, delivery proposal, contributor ballot, and settlement history.

A person can create a bounty; other people can add to it until delivery is proposed. Contributions are not transferable. Each round preserves the contribution amounts and voting outcome needed to audit settlement.

### Delivery proposal

A delivery proposal identifies the submitter and content-addressed evidence. It never pays by itself.

- With exactly one contributor, that contributor explicitly confirms or rejects the proposal before a bounded deadline; after the deadline or bounty expiry, anyone may finalize it into refunds.
- With two or more contributors, proposal submission starts a fixed 72-hour ballot.
- Voting weight equals each address's contribution in the round.
- Contributors may change their vote until the deadline.
- Settlement is unavailable before the deadline.
- After the deadline, `YES > NO` pays the proposed recipient. Every other result resets the bounty for another delivery round.

Abstaining does not become an implicit yes. There is no early majority shortcut because contributors must retain the full promised review period.

### Project

A project has a stable project ID, metadata digest, payout address, admission path, status, and status history. A graduated bounty can create or link a project without a registration bond. An existing project may apply with a refundable anti-spam bond.

Only active projects appear as gauge options. Suspension removes an option from future resolution without rewriting earlier epochs. Payout-address changes use an explicit delay so stakers can see where an allocation will be sent.

### Hack Juno epoch

An epoch has a fixed budget, fixed project option set, fixed Juno-stake snapshot height, ballot window, minimum turnout rule, and terminal allocation record. Juno stakers allocate historical power among eligible projects. A reserved `do-not-distribute` option lets them intentionally leave funds unallocated.

## Primary journeys

### Request and fund work

1. A creator publishes a brief and acceptance criteria with an initial `ujuno` contribution.
2. Other accounts inspect the same terms and add contributions.
3. The ledger exposes total escrow, contributor count, and current state.
4. Until a delivery proposal locks the round, contributors may use only the withdrawal behavior explicitly allowed by the contract.

The backend must make every balance transition independently auditable. Human interfaces may render Juno decimals, but signed messages and queries retain canonical integer `ujuno`.

### Propose and ratify delivery

1. A submitter attaches a delivery/evidence digest and proposed payout address.
2. The contract freezes the round's contributor set and contribution weights.
3. The sole contributor confirms directly within the bounded confirmation window, or all contributors receive a 72-hour voting period.
4. The result is finalized permissionlessly after the deadline.
5. A successful result marks the bounty paid and emits the full-pot bank send in the same atomic transaction; there is no intermediate claimable payout state. An unsuccessful multi-contributor result clears the proposal and opens the next round or refunds an expired bounty; an unconfirmed sole-contributor result enters refunds at its deadline.

The Agent Operations DAO can hide spam from curated discovery or stop unsafe entry points, but it cannot cast contributor votes, shorten the window, choose the recipient, or force settlement.

### Graduate a project

1. A bounty pays successfully.
2. The Agent Operations DAO checks the public graduation policy and registers or links the project.
3. The registry gives the project a stable ID and records provenance from the bounty.
4. The project becomes eligible for a later gauge epoch when included in that epoch's fixed option set.

Graduation is admission to future competition, not a promise of incentives.

### Register an existing project

1. An applicant submits project metadata and the required native bond.
2. The Agent Operations DAO accepts, rejects, or requests a replacement application under bounded policy.
3. Acceptance activates a stable project record; rejection or expiry follows the configured bond disposition.
4. The registry caps active gauge options so epoch execution cannot grow without bound.

### Direct Hack Juno incentives

1. Juno governance funds a loss-bounded epoch tranche in the Program Vault.
2. The epoch records its project set and historical Juno-stake snapshot.
3. Stakers allocate snapshot voting power during the window.
4. After the window, anyone may finalize if turnout and safety rules pass.
5. The gauge emits only adapter-validated payments for the funded budget. Unallocated value remains in the Program Vault under tranche policy.

## Required product states

Backends, schemas, and eventual interfaces must use explicit states rather than infer them from timestamps or balances.

| Object | Required states |
|---|---|
| Bounty | open, sole confirmation, ratifying, reset, refunding/refunded, paid, cancelled, stopped |
| Project | pending, active, suspended, rejected, exited |
| Epoch | draft, funded, voting, finalizable, executed, stopped, failed/expired |

The exact contract enums may be more granular, but every state transition must be queryable and emit a stable event.

## Safety and trust communication

- Label contributor ratification separately from Juno governance and Juno-staker gauge voting.
- Never describe Agent Operations DAO curation as community approval.
- Never describe graduation as guaranteed gauge funding.
- Display snapshot height, voting window, option set, budget, turnout, and unallocated treatment for every epoch.
- Display contribution weight and ballot state to each contributor.
- Treat delivery evidence as an attestation and review input, not cryptographic proof of correctness.
- Make stopped and suspended states visible, including who invoked the action and which authority can resume.
- Do not present a broadcast transaction as complete until canonical state confirms it.

## Historical prototype interface direction

The historical backend goal excluded frontend release work. The current v2
candidate surface includes:

- a bounty ledger and bounty detail/ratification flow;
- a project registry with provenance and status;
- a Hack Juno epoch view with snapshot facts, allocations, and results;
- an exact transaction review for every state-changing action.

The redesigned prototype layout and Juno Design System assets can inform presentation, but its request statuses, roles, and non-binding ranking semantics are not part of v2.

## Accessibility and data integrity

- Every state and vote result must have a non-color label.
- Addresses and digests may truncate visually but retain full copyable values.
- Time displays must include an exact UTC value and derive eligibility from chain time, not the browser clock.
- Pagination and cursors must be opaque and deterministic.
- Weakly consistent multi-query views must expose their observed height or clearly disclose the limitation.
- Wallet-free reading remains a requirement.

## Historical prototype isolation

The earlier non-binding request-prioritization prototype is not silently
reinterpreted as social-bounty or Hack Juno state and creates no migration
requirement for v2. The current [`app/`](../../app/) must be bound only to the
verified fresh v2 contracts after deployment.
