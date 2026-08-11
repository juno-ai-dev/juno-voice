# Juno Voice v1 requirements traceability

This is the implementation-to-evidence index for `GOAL.md` as of 2026-08-11.
It is not a release approval. `Local` means the repository contains a direct
implementation check and that check passes in the local verification snapshot.
`Gate` means completion requires accepted upstream or independently produced
evidence that this checkout cannot create by itself.

Test names below are stable Rust or Python test identifiers. The authoritative
release decision remains the fail-closed validator in `release_manifest.py`.

## Bounty escrow (A)

| Requirement group | Direct implementation evidence | Direct automated evidence | Status |
|---|---|---|---|
| Bounded typed execute/query surface and explicit bounty, contribution, round, receipt, claim, moderation, graduation, authority, pause, accounting, and history state | `contracts/juno-voice-bounties/src/msg.rs`, `state.rs`, `contract.rs`; generated `schema/juno-voice-bounties.json` | `instantiate_and_creation_enforce_denom_metadata_lifetime_and_funds`, `bounded_histories_and_indexes_preserve_insertion_order`, `claim_pagination_advances_across_unclaimed_contributor_holes` | Local |
| Exact `ujuno`, positive bounded funding, aggregate contributor identity, immutable terms, and rejected attached funds | Creation/contribution validation precedes writes; all other execute variants are nonpayable | `instantiate_and_creation_enforce_denom_metadata_lifetime_and_funds`, `contributions_aggregate_count_exactly_and_nomination_freezes_terms`, `future_config_changes_do_not_mutate_live_bounty_limits_or_duration` | Local |
| Sole-contributor confirmation/decline, full-pot payout, expiry, and rollback | Separate sole-confirm/decline handlers; payout state is written before the bank message | `sole_confirmation_is_explicit_and_decline_after_expiry_refunds`, `failed_bank_send_rolls_settlement_state_back_atomically`; the sole test also rejects a second payout | Local |
| Multi-contributor fixed snapshot, exact 259,200-second window, weighted vote revision, and late/wrong/non-contributor/zero-weight rejection | Round checkpoints freeze contributor weights; checked old/new tally updates | `weighted_vote_revisions_and_full_nanosecond_window_are_exact`, `wrong_round_late_votes_and_expiry_during_ratification_cannot_bypass_snapshot`, `low_participation_yes_majority_pays_and_noncontributors_cannot_vote` | Local |
| Majority outcomes, no-vote/tie/no-majority reset, expiry, top-up, later nomination, and old-round isolation | Typed terminal/reset outcomes and round-scoped receipts/checkpoints | `no_votes_tie_and_no_majority_reset_without_paying`, `reset_top_up_and_later_round_keep_old_receipts_and_weights_isolated`, `wrong_round_late_votes_and_expiry_during_ratification_cannot_bypass_snapshot` | Local |
| Sole cancellation, prohibited multi-contributor cancellation, typed moderation, and pull refunds | Refund state records liabilities; claim is one contributor per transaction | `cancellation_expiry_and_typed_moderation_create_pull_refunds_only`, `claim_pagination_advances_across_unclaimed_contributor_holes` | Local |
| Paid project graduation, authenticated registry destination, and replay resistance | Graduation is restricted to a paid project candidate and records one source disposition | `paid_project_candidate_graduates_once_through_configured_registry`, `paid_candidate_graduates_through_authenticated_bounty_into_active_registry` | Local |
| Stop-only agent, governor recovery, future-only role/config changes, and settlement/refund liveness while paused | Agent can pause new activity but has no unpause, payout-redirection, or migration message | `pause_is_stop_only_for_agent_and_settlement_remains_live`, `future_config_changes_do_not_mutate_live_bounty_limits_or_duration` | Local |
| Stable event contract for every public mutation outcome | All 17 bounty event types use namespaced names and explicit typed attributes | Successful paths across the bounty suite call `assert_wire_event`, which freezes each exact event name, ordered attribute-key set, and nonempty wire value | Local |
| Liability backing, unsolicited-transfer isolation, and exactly-one disposition | Accounting identity is asserted after generated successful transitions; invalid generated transitions remain atomic | `generated_contribution_and_ratification_sequences_preserve_single_disposition`, `generated_valid_and_invalid_state_machine_actions_never_duplicate_value`, `unsolicited_native_transfer_never_creates_accounted_liability` | Local |
| Configured-maximum contributor, round, history, index, and pagination behavior | Hard contributor/round/page ceilings and stable index cursors | `configured_contributor_and_round_limits_fail_without_partial_state`, `bounded_histories_and_indexes_preserve_insertion_order`, `claim_pagination_advances_across_unclaimed_contributor_holes` | Local |

## Registry and adapter (B)

| Requirement group | Direct implementation evidence | Direct automated evidence | Status |
|---|---|---|---|
| Stable project IDs, typed lifecycle/provenance/history, bonded and bounty-graduation admissions | `contracts/hack-juno-registry-adapter/src/msg.rs`, `state.rs`, `contract.rs`; generated schema | `bonded_registration_is_exact_and_pending_is_not_a_gauge_option`, `graduation_authenticates_bounty_and_rejects_duplicate_id_and_source`, `typed_histories_are_scoped_and_stably_sequenced` | Local |
| Soft/hard rejection disposition, approval, suspension, reactivation, retirement, and bond claim | Typed review reasons/status changes and explicit bond accounting | `review_paths_preserve_bond_disposition_and_retirement_claim`, `suspension_after_tally_suppresses_send_and_only_governor_reactivates` | Local |
| Active capacity 99 plus immutable reserved option 100, without silent truncation | Exact capacity check and `do-not-distribute` insertion | `active_capacity_is_exactly_ninety_nine_and_never_truncates` | Local |
| Stable identity and delayed propose/cancel/replace/accept payout-address changes | Project ID is independent of current/pending payout address | `payout_address_change_has_delay_replacement_cancellation_and_acceptance` | Local |
| Fixed denom, ceiling, supplied balance, threshold, cap, integer flooring, dust, abstention, and unallocated treatment | Adapter accepts typed allocations and emits only `BankMsg::Send` | `adapter_enforces_budget_floor_cap_threshold_dust_abstention_and_errors` | Local |
| Invalid/duplicate/over-limit selections, wrong denom, overflow, and insufficient balance fail atomically | Selection count is checked both against project and total-option bounds before message construction | `adapter_enforces_budget_floor_cap_threshold_dust_abstention_and_errors` | Local |
| Every output targets the current active payout address and total value never exceeds both budgets | Status/address are pull-resolved at execution; no arbitrary `CosmosMsg` is stored or accepted | `suspension_after_tally_suppresses_send_and_only_governor_reactivates`, `arbitrary_valid_allocations_never_exceed_budget_or_leave_native_send_boundary` | Local |
| Curator/agent one-way stop and review powers; governor-only economics, overrides, curator replacement, and resume | Typed authority checks in every administrative handler | `curator_stop_is_one_way_and_governor_controls_economic_recovery`, `governance_configuration_events_have_stable_wire_contracts` | Local |
| Stable event contract for every public mutation outcome | All 17 registry event types use namespaced names and explicit typed attributes | Successful paths across the registry suite call `assert_wire_event`, which freezes each exact event name, ordered attribute-key set, and nonempty wire value | Local |

## Epoch-snapshot gauge (C)

| Requirement group | Direct implementation evidence | Direct automated evidence | Status |
|---|---|---|---|
| Explicit snapshot mode and unchanged hook-mode behavior | `PowerSource::EpochSnapshot`; missing legacy value defaults to hook mode | `snapshot_mode_rejects_hooks_and_guardian_can_stop_but_not_resume` plus the original gauge hook suite | Local |
| One nonzero historical total-power height and identical-height voter queries | Epoch stores the returned height and every first ballot queries that exact height | `snapshot_power_is_fixed_across_partial_vote_revision_and_removal`, `zero_failed_and_mismatched_total_queries_cannot_open_an_epoch`, `consecutive_epochs_use_distinct_heights_and_isolated_power` | Local |
| Fixed voter power, checked ballot revision/removal, separate participating and allocated power | Epoch-scoped power cache, ballots, tallies, and receipt index | `snapshot_power_is_fixed_across_partial_vote_revision_and_removal`, `arbitrary_snapshot_revisions_preserve_tallies_and_participation` | Local |
| Exact turnout boundary, terminal no-distribution, and no rollover | Wide checked ratio comparison; terminal epoch outcome and unchanged budget | `turnout_boundary_is_exact_and_failed_turnout_is_terminal_without_adapter_call` | Local |
| Complete epoch isolation and bounded sparse cleanup/pagination | Epoch keys include gauge/epoch; cleanup/page calls use capped scans and explicit cursors | `consecutive_epochs_use_distinct_heights_and_isolated_power`, `adapter_failure_leaves_epoch_open_and_cleanup_makes_bounded_progress`, `ballot_pagination_advances_across_removed_ballot_holes` | Local |
| Public snapshot policy, epoch, ballot, allocation, outcome, health, and cleanup observability with stable mutation events | Gauge responses expose current policy/epoch; epoch, ballot, allocation, and list queries are bounded; five snapshot actions emit ordered typed attributes | `snapshot_public_queries_expose_policy_ballots_allocations_outcomes_and_pagination`, `gauge_health_reports_and_then_clears_index_mismatch`; response assertions in snapshot policy, vote, turnout/outcome, suspension, and cleanup tests freeze every new action and terminal outcome | Local |
| Guardian stop-only and governor resume/update | Separate authenticated stop and owner-only resume; open epoch locks selection config | `snapshot_mode_rejects_hooks_and_guardian_can_stop_but_not_resume`, `snapshot_policy_updates_are_future_only_and_selection_config_locks_while_open` | Local |
| Option, selected-set, hook, message, and arithmetic bounds | Gauge/options/messages/hook inputs use hard caps and lookahead rejection | `snapshot_open_and_execution_enforce_option_and_message_bounds_atomically`, `attachment_accepts_one_hundred_options_and_rejects_lookahead_101_atomically`, `execution_rejects_overlong_adapter_message_list_without_advancing_epoch`, `power_hooks_reject_oversized_batches_before_mutating_state`, `power_change_votes_enforces_complete_iteration_boundary` | Local |
| Adapter failure, status change between vote/execution, and atomic rollback | Adapter is queried at execution; state commits follow fallible external reads | `adapter_failure_leaves_epoch_open_and_cleanup_makes_bounded_progress`, `suspended_project_between_ballot_and_execution_receives_nothing` | Local |
| Upstream acceptance, full upstream checks, clean gitlink, and manifest commit binding | Gauge changes were accepted in [juno-ai-dev/dao-contracts#5](https://github.com/juno-ai-dev/dao-contracts/pull/5), and the parent gitlink pins merge commit `6b5e4a7aa4252a0bc59b32c2c58032ed5b0a913f`. CI defines the full pinned workspace check. Release validation requires a signed upstream attestation binding repository, immutable commit, review URL, acceptor, and acceptance time, and the final signed decision binds its hash | Upstream acceptance complete; full pinned CI and signed attestation remain Gate inputs | Gate |

## Bounded-work inventory

| Resource | Enforced bound/progress rule | Evidence |
|---|---|---|
| Bounty settlement/refunds | Settlement is constant-time; refunds are one claimant per execute and never iterate contributors | Pull-refund and model tests above |
| Bounty contributors/rounds | Config is capped at 10,000 contributors and 100 rounds; no execute traverses the contributor set | `configured_contributor_and_round_limits_fail_without_partial_state` |
| Bounty lists/history | Maximum page work is 100; sparse claim pages return the last scanned contributor cursor | Pagination/history tests above |
| Registry projects/options | 99 active projects plus one reserved option; list page work is at most 100 | `active_capacity_is_exactly_ninety_nine_and_never_truncates` |
| Adapter selections/messages | At most 99 selected projects and 100 total selected options/messages; all validation occurs before output | Adapter error/bank-send tests above |
| Gauge collection sizes | At most 100 gauges, 100 options per gauge, 100 gauge votes per voter, 10 hooks, and 100 hook members/tokens | Gauge boundary tests above |
| Gauge execution | Candidate and tally scans use a 100-option bound plus a one-record corruption lookahead; adapter messages cap at 100 | Snapshot/open/message and attachment boundary tests above |
| Gauge reset/epoch cleanup | Caller batch is nonzero and capped at 100; one lookahead determines completion and a stable cursor records progress | Reset and snapshot cleanup tests above |
| Gauge public lists | Requested limits are capped at 100; sparse ballot pages expose `next_start_after` | Query/state pagination and sparse-ballot tests above |

## Deployment, integration, and release evidence (D/E)

| Requirement group | Repository enforcement and tests | Status |
|---|---|---|
| Versioned config, exact addresses/checksums/roles/economics/tool identities, and no implicit defaults | Closed `deployment/config.schema.json`, strict Python validation, 17 deployment tests including schema-shape parity, config hard bounds, staking denom, governance account, authority/module/economic reconciliation, and exact `wasm-tools 1.254.0` | Local tooling; live config/evidence is a Gate |
| Dry-run/apply separation, restart safety, no duplicate upload/instantiate, and final query reconciliation | Eight-step plan journal, advisory lock, deterministic addresses, ready/pending reconciliation, and content-bound verification observations | Local tooling; authorized broadcast is a Gate |
| Exact ten-flow cross-generation evidence | `integration/uni7_capture.py` captures exact code IDs, addresses, tx responses, events, messages, queries, balances, and named proof profiles. Every named state proof binds its verified contract, query variant, minimum response semantics, and cross-proof IDs. Positive event proofs bind exact contract/event/action attributes; negative transfer scans bind to the same addresses as unchanged-balance proofs; CosmWasm execute destinations must be verified deployment or Agent Operations addresses. Its closed transcript schema binds typed messages/events, exact deployment maps, and all ten scenario IDs; 21 integration discovery tests pass | Local harness; exact-chain transcripts are a Gate |
| Snapshot retention and staking changes | Evidence validation requires activation/export boundary, retention observation, two full successful native staking transaction captures between the epochs, and six hash-bound voter/total queries against the verified voting module. `release/capture_release_evidence.py` captures the native staking transaction and named exact-height query shapes without broadcasting or key access. Each staking message must use the test voter and configured denom, and its signed delegate/undelegate amount must reconcile to the observed later voter-power delta. The first historical result must remain fixed before/after the change and a query must succeed beyond the required retention window | Public-chain observation is a Gate |
| Deterministic clean recursive builds | `scripts/build-release.sh` performs two clean recursive-clone builds, byte comparison, schema diffing, source cleanliness checks, and exact validator identity capture | Local tooling; published clean build output is a Gate |
| Complete immutable release manifest | `release_manifest.py` recomputes artifact/schema/evidence hashes and binds exact 40-hex commits, digest-pinned optimizer, eight exact tool identities, deployment, scenarios, audit, gas, runbooks, canaries, rehearsals, and sign-off. Signed upstream/security attestations bind their reviewed sources; gas cases bind verified contracts, exact maximum requests, full responses, and observed counts/events. The closed gas report additionally binds the canonical seven measurements, source/config, margin, methodology, distinct measurer/reviewer roles, and both signatures to a recomputed payload hash. Canaries bind raw transactions, epoch state, native transfer totals, and a signed governance decision. The read-only release capture companion normalizes snapshot, canary, and rehearsal evidence, enforces initial transaction semantics/code profiles, and is round-tripped through the complete gate in tests. The final decision binds a non-circular canonical hash of the entire reviewed packet, plus every named report hash, and requires all maintainers and independent reviewers to bind the same decision payload hash; preparation runs the full semantic gate with only that pending decision omitted. Its closed evidence schemas bind the same required sets; 59 release discovery tests and 3 generator tests pass | Local tooling; completed packet is a Gate |
| CI ordering | Root and upstream jobs test independently; the integration job depends on both; the deterministic candidate job depends on all three | Local workflow definition; a clean CI run is a Gate |
| Operational readiness | Six content-bound deployment, monitoring, pause/recovery, refund/expiry, submodule-update, and release runbooks must retain their required operational sections. The release gate separately requires passed pause, failed-epoch, adapter-failure, governor-recovery, refund/expiry, and unused-funds rehearsals, each with complete raw transaction captures, case-specific success/rejection profiles, assertion evidence, and distinct operator/reviewer identities | Local docs; operator exercise/sign-off is a Gate |

## Remaining completion gates

1. Resolve the normative denomination mismatch: reachable Juno v30 `uni-7`
   uses `ujunox`, while the current v1 artifacts require `ujuno`.
2. Run the full pinned upstream checks for the accepted merge commit and record
   the signed acceptance attestation for `juno-ai-dev/dao-contracts#5`.
3. Run the two-clean-clone deterministic build and publish its exact artifacts
   and build manifest.
4. Complete an independent security review and resolve/disposition its findings.
5. Obtain deployment authority, bind the reviewed Agent Operations DAO, and
   produce the query-confirmed deployment record.
6. Capture all ten exact-artifact public-testnet scenarios, Juno snapshot and
   retention behavior, and all seven configured-maximum gas cases.
7. Complete the six operational rehearsals, two positive low-value canary
   epochs, and the required multi-role sign-off, then generate the testnet-only
   release manifest.
