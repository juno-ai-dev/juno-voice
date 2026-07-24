# ADR-002: Prioritization is non-binding

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Roadmap signal and binding governance have different security requirements. Treasury execution or arbitrary messages would enlarge the initial trust surface.

## Decision

Juno Voice records immutable requests, stake-weighted `SUPPORT`/`OPPOSE` signal, selection/assignment, delivery evidence, and verifier shipment attestations. It cannot execute arbitrary messages, spend treasury funds, bind Juno governance, or prove external software correct.

The steward's selection and verifier's attestation are transparent accountable judgments, not community mandates. Funding and binding governance require separate processes.

## Consequences

The MVP supports the complete accountable loop without governance theater: suggest, prioritize, select, build, review, and attest shipment. Product copy must retain the non-binding qualification and say “attested shipment,” not proof of correctness.
