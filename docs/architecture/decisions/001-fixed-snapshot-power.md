# ADR-001: Fixed per-request historical voting power

- **Status:** Proposed
- **Date:** 2026-07-23

## Context

A live-balance tally allows stake moved after a request opens to change the electorate and risks counting the same stake through multiple addresses. Juno v30 provides historical staking power through `x/voting-snapshot`.

## Decision

When a request is created in block `H`, store `snapshot_height = H - 1`. Every vote queries both voter and total power at that immutable height. Store the resulting voter power in an immutable receipt and update aggregate tallies atomically.

Request creation fails if total power at the selected snapshot is zero.

## Consequences

- Stake changes after opening do not affect that request.
- Votes are simple to audit and reproduce.
- Requests depend on retained snapshot history.
- Exported-genesis restart boundaries and module activation require explicit handling.
- Mutable votes are excluded from MVP.
