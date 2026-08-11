# ADR-002: Juno governance root with bounded agent operations

**Status:** Accepted

**Date:** 2026-08-04

## Context

Hack Juno needs public funding authority, a stable treasury/execution address, and fast operational curation. Creating an independent Hack Juno electorate would duplicate Juno-staker governance with different proposal rules. Giving an agent DAO broad treasury power would make spam reduction an unnecessary custody risk.

## Decision

Use Juno `x/gov` as the constitutional, funding, and code-administration root.

- Deploy a minimal `dao-dao-core` Program Vault with its external admin set to the Juno governance module account.
- Give the vault no independent public policy proposal lane.
- Use the vault as the stable application governor, bounded tranche custodian, and gauge execution shell.
- Use one replaceable Agent Operations DAO for moderation, delivery nomination, project review, graduation, suspension, and one-way pause/stop actions.
- Keep contributor payout decisions with contributors and epoch allocations with Juno stakers.
- Require Juno governance, acting through the vault, to unpause/resume, increase limits, replace the agent DAO, migrate code, or recover funds.

## Consequences

High-frequency work does not burden `x/gov`, but no operational group can both select and spend public funds or override contributor custody. Root recovery is slower, so the agent DAO receives stop-only powers. DAO/subDAO registration remains descriptive; every capability still requires an explicit contract role.
