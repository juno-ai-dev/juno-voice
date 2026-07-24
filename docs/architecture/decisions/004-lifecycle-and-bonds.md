# ADR-004: Lifecycle and bond state are independent

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Conflating delivery status with fund custody obscures invariants. An `ACCEPTED` state without an assignee also records no operational commitment.

## Decision

Use the canonical lifecycle in `ARCHITECTURE.md`: close `OPEN` deterministically to `QUALIFIED` or `NOT_PRIORITIZED`; omit `ACCEPTED`; require steward builder assignment for `QUALIFIED → BUILDING`; use round-scoped `BUILDING`, `REVIEW`, and `BLOCKED`; and terminate at `NOT_PRIORITIZED`, `DUPLICATE`, `SPAM`, `ARCHIVED`, or `SHIPPED`.

Track bonds separately as `LOCKED → REFUNDABLE → CLAIMED` or `LOCKED → FORFEITED`. Not-prioritized, qualified, duplicate, and non-spam archived requests are refundable. Only reasoned `OPEN → SPAM` forfeits a locked bond. Only the author claims to the author. Aggregate totals update atomically; forfeited funds have no MVP withdrawal path.

## Consequences

Duplicate submissions are refundable and votes never merge. Pull refunds cannot block lifecycle transitions. State/fund invariants are independently testable, and every transition has one explicit controller and guard.
