# ADR-002: Prioritization is non-binding

- **Status:** Proposed
- **Date:** 2026-07-23

## Context

A roadmap signal and binding governance have different security requirements. Combining feature feedback with treasury execution or arbitrary messages would enlarge the initial trust and audit surface.

## Decision

Juno Voice records requests, stake-weighted signal, lifecycle attestations, and delivery evidence. It cannot execute arbitrary Cosmos messages, spend treasury funds, or bind Juno governance.

A steward can moderate and advance lifecycle states through a constrained transition graph. Steward actions are public and can later be assigned to a DAO.

## Consequences

- The MVP is smaller and safer.
- Ranking guides Juno AI/builders without claiming community mandate.
- Funding and binding governance require separate, explicit proposals.
