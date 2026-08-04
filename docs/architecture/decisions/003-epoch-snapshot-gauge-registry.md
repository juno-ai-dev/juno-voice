# ADR-003: Epoch-snapshot gauge with a bounded project registry

**Status:** Accepted

**Date:** 2026-08-04

## Context

`dao-voting-juno-staked` obtains historical power from Juno `x/voting-snapshot` and intentionally emits no delegation-change hooks. The existing gauge orchestrator queries power at ballot time and expects later hooks to keep tallies current. Connecting them unchanged would leave stale tallies after stake changes.

The generic gauge adapter can also return arbitrary messages, while Hack Juno needs only capped native payments to approved projects.

## Decision

Add an upstream `EpochSnapshot` power mode to the gauge orchestrator and pair it with a purpose-built registry adapter.

- One epoch fixes its snapshot height, total power, option set, budget, window, and policy.
- Every voter and the denominator use that same historical height; no power hooks are accepted.
- Track full `participating_power` separately from power allocated across options.
- Require configurable minimum turnout; failure distributes nothing and does not enlarge the next epoch.
- Give Agent Operations a stop-only guardian role.
- Identify projects by stable IDs, with graduated and bonded-existing-project admission paths.
- Cap active projects at 99 plus `do-not-distribute` for the current 100-option gauge limit.
- Resolve only active projects into bounded native bank sends at execution time.
- Never store or forward arbitrary user-supplied execution messages.

## Consequences

Stake changes during an epoch cannot change or stale its electorate. Each epoch requires historical snapshot availability and bounded old-epoch cleanup. Suspension can invalidate a selected project before execution; its amount remains in the Program Vault. Raising option or message limits requires new gas evidence and governance approval.
