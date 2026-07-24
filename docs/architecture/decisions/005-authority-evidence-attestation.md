# ADR-005: Separate authorities and require round-scoped evidence

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

One steward controlling selection, delivery, verification, and upgrades cannot provide meaningful accountability. Evidence from abandoned assignments must not satisfy later shipment.

## Decision

Separate chain admin, governor, steward, verifier, and current-round builder. The steward assigns work; the builder adds delivery evidence and requests review; a distinct verifier adds verification evidence and attests or rejects it. Governor manages durable configuration and operational roles through typed logs; chain admin migration power remains externally disclosed custody.

Work round starts at 1 on assignment and increments on every return to `BUILDING`. Evidence is immutable, digest-bearing, classed as delivery or verification, and tied to a round. `SHIPPED` requires current-builder delivery evidence plus a different current-verifier verification item, both explicitly referenced by a bounded verifier attestation to immutable inline acceptance criteria.

## Consequences

There is no self-verification or stale-evidence shipment. The contract records provenance and attestation but does not fetch artifacts or prove correctness. Production admin/governor custody must be disclosed; migration policy remains a launch concern and does not gate MVP coding.
