# ADR-003: Chain state is canonical; indexing is derived

- **Status:** Proposed
- **Date:** 2026-07-23

## Context

Text search, rich filtering, notifications, and analytics are expensive or awkward in a smart contract. Making a centralized API canonical would weaken the product's core promise.

## Decision

Requests, snapshot heights, vote receipts/tallies, status history, deposits, and evidence references are canonical contract state. An optional indexer may provide search and cached views, but every result is reproducible from chain queries/events and identifies its indexed height.

## Consequences

- The UI can remain fast without trusting an API for governance signal.
- Direct RPC fallback remains possible for request detail.
- Indexer schema/versioning becomes an implementation concern, not a consensus dependency.
