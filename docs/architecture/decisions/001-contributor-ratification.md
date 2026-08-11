# ADR-001: Purpose-built contributor ratification

**Status:** Accepted

**Date:** 2026-08-04

## Context

Every bounty has a different, dynamically funded contributor set and needs one temporary delivery decision. A DAO DAO core supports one voting module; modeling each bounty with its own core, weighted group, and proposal module would create disposable governance stacks and a membership-synchronization boundary between escrow and voting.

The required rule is simpler: contributors fund one native-denom escrow and, when there is more than one contributor, vote for 72 hours with weight equal to their contribution.

## Decision

Implement bounties and payout ratification in one purpose-built escrow contract.

- The first release accepts native `ujuno` only.
- Contributions are committed, non-transferable weights.
- A sole contributor separately confirms or declines a nomination.
- Multiple contributors receive exactly `259_200` seconds to vote `YES` or `NO` and may revise votes until close.
- No payout may finalize early.
- After close, positive participation and `YES > NO` pays the full escrow. `NO > YES`, a tie, or no votes resets without payment.
- The majority denominator is participating contribution weight, matching “voting contributors”; there is no bounty turnout quorum.
- Payout and refunds are atomic or pull-based and never require iterating over contributors.
- Agent moderation can open refunds but cannot confiscate or release principal.

## Consequences

Escrow and settlement share one canonical state machine, eliminating cross-contract weight synchronization. The contract must implement voting receipts and bounded history itself. Low-participation approval remains possible by design and must be stated clearly in clients. Milestones and partial payouts require separate bounties in v1.
