# Juno Voice v2 candidate remediation disposition

**Prepared:** 2026-08-12 UTC
**Author:** implementation team
**Authority:** engineering traceability only

This document records the implementation team's explicit candidate disposition
of the five findings in the point-in-time v1 security review. It does not amend
that review, close a finding independently, authorize deployment, or authorize
funding. A distinct security reviewer must accept or revise every disposition
against clean immutable commits and exact release artifacts.

The chosen release boundary is a fresh v2 composition. No v1 state is imported.
If the pre-cutover observation finds any bounty, project, liability, open epoch,
or Program Vault balance, deployment must stop and a separately reviewed
recovery plan is required.

## Finding dispositions

| Finding | Candidate disposition | Direct implementation and regression evidence | Remaining closure gate |
|---|---|---|---|
| JV-01 — partial ballots are renormalized | **Fixed in the source candidate; release remains blocked.** Project thresholds, caps, and payouts use full participating power. Retained-option power, unallocated power, exclusions, cap overflow, and dust remain unspent and are reported separately. | `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs`; `partial_and_retained_ballots_use_participating_power_without_renormalizing`, `retained_only_ballot_counts_turnout_and_never_consumes_a_project_slot`, `project_threshold_and_cap_boundaries_use_participating_power`, and `arbitrary_snapshot_revisions_preserve_tallies_and_participation` | Accept the upstream patch at an immutable commit; independently review the arithmetic and adapter boundary; reproduce the partial, retained-only, cap, exclusion, and dust outcomes with exact artifacts on chain. |
| JV-02 — unfunded epochs can remain live and later execute stale allocations | **Fixed in the source candidate; release remains blocked.** Opening requires the full fixed budget before any state mutation. Execution requires only actual emitted value; underfunding is terminal, public expiry is bounded, and a reasoned governor abort handles unrecoverable adapter/configuration failures. | `deps/dao-contracts/contracts/gauges/gauge/src/contract.rs`; `opening_requires_the_complete_budget_and_rejection_is_atomic`, `execution_requires_only_emitted_value_and_underfunding_is_terminal`, and `expiry_abort_and_following_epoch_schedule_are_terminal_and_idempotent` | Independently review the terminal-state and scheduling logic; run funded, underfunded, expired, aborted, adapter-failure, and later-top-up scenarios with exact artifacts on chain. |
| JV-03 — caller-chosen project IDs can squat bounty identities | **Fixed by replacing the identity model; release remains blocked.** The registry alone allocates monotonic numeric IDs after validation. Bounty candidates contain no project ID, graduation receives a typed assigned-ID reply, failed transactions do not consume IDs, and legacy caller-chosen-ID messages fail decoding. | `contracts/hack-juno-registry-adapter/src/contract.rs`, `state.rs`, and `msg.rs`; `contracts/juno-voice-bounties/src/contract.rs` and `msg.rs`; `registry_assigns_sequential_ids_without_caller_control_or_failed_consumption`, `separate_transactions_assign_ids_in_chain_transaction_order`, `legacy_candidate_project_id_fails_loudly_at_the_wire_boundary`, `paid_project_candidate_graduates_once_through_configured_registry`, `graduation_reply_rejects_unknown_failed_and_malformed_responses_without_finalizing`, and `registry_submessage_failure_rolls_back_pending_graduation_and_id_allocation` | Independently review allocation/reply atomicity and public wire compatibility; reproduce bonded registration and bounty graduation ordering on the selected chain. |
| JV-04 — bounty replay protection is not source-namespaced | **Fixed in the source candidate; release remains blocked.** Replay keys and provenance use the validated `(source_bounty_contract, source_bounty_id)` pair. After an authorized rotation, the old source loses graduation authority while an overlapping ID from the replacement source remains usable. Fresh deployment avoids ambiguous v1 backfill. | `contracts/hack-juno-registry-adapter/src/state.rs` and `contract.rs`; `bounty_replay_is_namespaced_by_source_and_survives_rotation` | Independently review role rotation and provenance queries; reproduce old-source rejection, overlapping-ID acceptance, and same-pair replay rejection on chain. |
| JV-05 — governor overrides can violate bond/status invariants | **Fixed in the source candidate; release remains blocked.** Review, suspension, retirement, claims, and every governor override pass through one transition validator. Active or suspended bonded projects require a fully backed deposited bond; disposed bonds cannot reactivate. | `contracts/hack-juno-registry-adapter/src/contract.rs`; `transition_table_covers_every_status_provenance_bond_and_transition_combination`, `every_governor_override_target_is_covered_from_every_bonded_status`, `transition_engine_enforces_caller_authority_and_typed_reason`, `generated_project_sequences_preserve_bond_and_index_invariants`, and `failed_registration_bond_refund_rolls_the_entire_transition_back` | Independently review the shared transition table and accounting deltas; exercise the complete operational table and failed-send rollback with exact artifacts. |

## Required design dispositions

| Design | Candidate disposition | Remaining independent-review question |
|---|---|---|
| Retained option | **Accept as an immutable affirmative sink for each snapshotted epoch.** It counts toward turnout and allocated power, is separately observable, never becomes a funded project, never emits a message, and is not interchangeable with implicit unallocated ballot power. | Confirm that policy validation, UI presentation, event/query accounting, and adapter defense all preserve those semantics. |
| Project top-N | **Apply top-N only after removing the retained option and evaluating project eligibility against participating power.** Excluded allocations remain retained; the sink never consumes a selected-project slot. | Confirm deterministic ordering/tie behavior, exact boundary behavior, and that no selection stage renormalizes project shares. |
| Epoch expiry and abort | **Accept a snapshotted positive execution window with permissionless expiry at deadline equality and a governor-only reasoned abort.** Underfunding terminalizes immediately; no terminal budget automatically rolls into a later epoch. | Confirm exact time boundaries, mutual exclusion/idempotence of terminal paths, schedule advancement once, and stop-only guardian limits. |

## Closure rule

The candidate dispositions become release dispositions only when the independent
security attestation binds the accepted root and upstream commits, reviewed
report, complete finding set, and retained-option/top-N/expiry decisions. The
release validator must then bind that attestation to deterministic artifacts,
fresh-deployment observations, testnet scenarios, gas evidence, operational
rehearsals, and explicit release authorization. Until then, all five findings
remain release blockers and the Program Vault remains unfunded.
