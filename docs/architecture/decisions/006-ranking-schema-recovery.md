# ADR-006: Signed ranking, bounded schema, pause, and recovery

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Signed net signal needs storage-safe ordering. Mutable ranking requires filter-bound cursors. Emergency controls must not freeze votes or refunds, and events alone are insufficient audit state.

## Decision

Rank by signed `SUPPORT - OPPOSE`, support, then oldest ID using fixed-width signed-safe keys. Maintain status and status/category indexes. Opaque full-key cursors include cursor/schema versions and query filters; mismatches are rejected. Responses identify query height and document weak consistency.

Adopt the field/count limits in canonical architecture as schema defaults. Keep bounded paginated typed request/protocol logs. Pause affects submissions only: voting, finalization, evidence, recovery, and refunds remain live. Governor or steward pauses; only governor unpauses. While paused, governor may emergency-archive an open request with refund and typed `SnapshotHistoryRisk` reason.

## Consequences

Direct RPC can serve MVP ranking and histories without scans. Category cursors cannot be replayed under different filters. Recovery is explicit and auditable without pretending to prove exact-height retention.
