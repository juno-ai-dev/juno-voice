# ADR-003: Chain state is canonical; direct RPC is primary

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Text search and analytics are awkward on-chain, but making a centralized API canonical would weaken auditability.

## Decision

Requests, snapshot values, receipts/tallies, bonds, lifecycle, assignments, evidence, attestations, role/config/pause state, and typed logs are canonical contract state. Direct RPC is the primary MVP path for bounded status/category ranking, request detail, and histories.

An optional indexer may add search, activity, and caches. It identifies chain/contract/schema, indexed and current heights, lag state, and a direct-chain verification path. It never becomes authoritative.

## Consequences

The MVP does not depend on indexer availability. Contract pagination and ranking indexes must be bounded and useful directly. Mutable-list results expose query height and weak-consistency behavior.
