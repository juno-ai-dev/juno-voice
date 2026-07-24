# ADR-001: Fixed per-request historical voting power

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Live-balance voting permits post-opening stake movement to change the electorate. Juno v30 provides at-or-before historical staking power, but its CosmWasm binding does not return the resolved height or retention parameters.

## Decision

For submission in block `H`, store `snapshot_height = H - 1`, rejecting underflow, and store nonzero total power `T`. Each wallet casts one immutable `SUPPORT` or `OPPOSE` receipt with historical power. Every vote re-queries total power and requires nonzero equality with `T`; mismatch fails without state changes.

Equality is a consistency check, not proof that exact-height history exists. Snapshot retention is an external deployment trust assumption. Deployment policy sets a positive voting duration no longer than two months, derives blocks for the target chain, and requires retention beyond it with a documented safety margin.

## Consequences

Stake movement does not change an established electorate. Operators must monitor retention, activation/exported-genesis boundaries, upgrades, and restarts. Snapshot risk uses submission-only pause and typed refundable archival. Accepting this trust boundary permits MVP implementation; stronger resolved-height bindings can improve a later version.
