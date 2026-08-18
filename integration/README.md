# Exact-artifact compatible-target integration evidence

`uni7_capture.py` is a chain-capable evidence harness for the 18 required
cross-generation scenarios. Transactions may be broadcast by the reviewed
Agent DAO, contributors, applicants, or Juno governance using their normal
paths; the harness independently retrieves each indexed transaction, gas use,
exact-height smart query, and native balance. It never substitutes a mock DAO,
gauge, adapter, or voting source.

No deployable target configuration is checked in. Select an authorized
Juno-compatible target whose staking and funding denomination is exactly
`ujuno`, keep its reviewed configuration and mutable state outside the checkout,
and generalize the transcript/release schemas that currently require chain ID
`uni-7` before attempting capture. The commands below describe the target-neutral
operator interface after that release-tooling gate is closed:

```sh
export TARGET_CONFIG=/secure-work/juno-voice/target.json
export TARGET_STATE_DIR=/secure-work/juno-voice/target
```

Initialize one transcript only after the deployment verifier has bound all code
IDs and addresses:

```sh
python3 integration/uni7_capture.py \
  --config "$TARGET_CONFIG" \
  --state "$TARGET_STATE_DIR/state.json" \
  --transcript "$TARGET_STATE_DIR/multi-fund.json" \
  init --scenario multi_fund_ratify_pay
```

Capture every scenario transaction, then record queries and balances at explicit
heights. A transaction expected to fail is captured with its exact nonzero code;
an unexpected success or a different failure code aborts capture:

```sh
python3 integration/uni7_capture.py \
  --config "$TARGET_CONFIG" \
  --state "$TARGET_STATE_DIR/state.json" \
  --transcript "$TARGET_STATE_DIR/guardian.json" \
  capture-tx --tx-hash "$TX_HASH" --expected-code 5
```

Assertions are linked to captured evidence instead of accepting a caller-owned
"actual" file. For example, these commands compare a reviewed expected response
to captured query 0 and compute a balance delta from captured observations 0
and 1:

```sh
python3 integration/uni7_capture.py \
  --config "$TARGET_CONFIG" \
  --state "$TARGET_STATE_DIR/state.json" \
  --transcript "$TARGET_STATE_DIR/multi-fund.json" \
  assert-query --name bounty_paid_state --query-index 0 \
  --expected /secure-work/expected-paid-state.json

python3 integration/uni7_capture.py \
  --config "$TARGET_CONFIG" \
  --state "$TARGET_STATE_DIR/state.json" \
  --transcript "$TARGET_STATE_DIR/multi-fund.json" \
  assert-balance-delta --name recipient_balance_delta \
  --before-index 0 --after-index 1 --expected-delta 1000000
```

`assert-event`, `assert-message`, `assert-matching-events`, and `assert-tx-code`
provide the other linked proof types. `assert-matching-events` accepts repeated
`--tx-hash` arguments and checks all listed transactions for the event type and
attribute map supplied by `--attributes`. Its `--expected` file is the complete
expected match array; use `[]` to prove absence.

Proof names are semantic contracts, not labels. `finalize` binds each state
proof to the verified bounty, registry, or gauge address; the exact query
variant; minimum terminal-state fields; and required cross-proof identities.
It binds positive events to their exact contract event type and stable
attribute set. A negative transfer scan must use `transfer` plus the sender or
recipient address from its paired unchanged-balance proof, so an impossible
caller-chosen filter cannot satisfy an absence claim.

`finalize` recomputes every assertion and requires at least one successful
transaction, an exact-height query, pre/post balances, and only passing linked
assertions. Copy a finalized transcript into the repository evidence packet.
The release validator independently rechecks the config, artifact checksums,
code IDs, addresses, complete transaction responses, hashes, balances, linked
assertions, scenario-specific proof names, decoded message destinations, and
empty mock list. Every CosmWasm execute destination must be one of the verified
Juno Voice contracts or reviewed Agent Operations modules. The validator also
requires positive payout/refund deltas, zero deltas for no-distribution cases,
a nonzero Agent resume rejection code, and full transaction coverage for
event-absence claims.

Capture work should remain outside the repository so the deployment tool's
clean-checkout protection stays effective. Raw keys are never written to a
transcript. `junod` key management and transaction authorization remain outside
this read-only evidence tool.

The transaction and smart-query normalizers are also reused by
`release/capture_release_evidence.py` for snapshot, canary, and operational
rehearsal fragments. This keeps raw response hashing, decoded message checks,
contract allowlisting, event validation, and exact-height query behavior
identical between scenario transcripts and release-only evidence.

The required scenario identifiers are:

1. `multi_fund_ratify_pay`
2. `reset_renominate_pay`
3. `moderate_expire_pull_refunds`
4. `paid_bounty_graduation`
5. `bonded_registration_approval`
6. `snapshot_turnout_distribution`
7. `failed_turnout_no_distribution`
8. `suspension_before_execution`
9. `guardian_stop_governor_recovery`
10. `consecutive_epoch_isolation`
11. `partial_ballot_retention`
12. `retained_only_no_distribution`
13. `underfunded_terminal_epoch`
14. `expired_terminal_epoch`
15. `aborted_terminal_epoch`
16. `numeric_identity_assignment`
17. `bounty_source_rotation`
18. `bond_transition_table`

Each transcript must contain exactly the release proof profile for its scenario:

| Scenario | Required assertion names | Required smart-query surfaces |
|---|---|---|
| `multi_fund_ratify_pay` | `bounty_paid_state`, `contributor_receipts_state`, `recipient_balance_delta`, `payout_event` | bounty `Bounty`, bounty `Receipts` |
| `reset_renominate_pay` | `first_round_reset_state`, `later_round_paid_state`, `old_receipt_isolation`, `recipient_balance_delta` | bounty `Round` for the failed and paid rounds, bounty `Receipt` for the older round |
| `moderate_expire_pull_refunds` | `refunding_state`, `first_refund_balance_delta`, `second_refund_balance_delta`, `refund_events` | bounty `Bounty` while a pull refund remains pending |
| `paid_bounty_graduation` | `paid_bounty_state`, `active_graduated_project_state`, `graduation_event` | bounty `Bounty`, registry `Project` with matching source-bounty provenance |
| `bonded_registration_approval` | `pending_bonded_project_state`, `active_approved_project_state`, `bond_disposition_state`, `approval_event` | registry `Project` before/after review, registry `Accounting` |
| `snapshot_turnout_distribution` | `epoch_snapshot_state`, `historical_ballot_state`, `project_balance_delta`, `distribution_event` | gauge `Epoch`, gauge `EpochBallot` for that epoch |
| `failed_turnout_no_distribution` | `failed_turnout_state`, `vault_balance_unchanged`, `no_transfer_events` | gauge `Epoch` with turnout below its threshold |
| `suspension_before_execution` | `suspended_project_state`, `terminal_epoch_state`, `project_balance_unchanged`, `no_project_transfer_events` | registry `Project`, gauge `Epoch` with no eligible options |
| `guardian_stop_governor_recovery` | `guardian_stopped_state`, `agent_resume_rejected`, `governor_resumed_state`, `authority_state` | gauge `Gauge` before/after recovery, gauge `Config` authorities |
| `consecutive_epoch_isolation` | `first_epoch_state`, `second_epoch_state`, `first_ballot_state`, `second_ballot_state`, `snapshot_isolation_state` | two gauge `Epoch` queries, their `EpochBallot` queries, and one paged `ListEpochs` response containing both |
| `partial_ballot_retention` | `partial_epoch_state`, `partial_ballot_state`, `project_balance_delta`, `distribution_event` | gauge `Epoch`, gauge `EpochBallot` |
| `retained_only_no_distribution` | `retained_only_epoch_state`, `retained_only_ballot_state`, `vault_balance_unchanged`, `retained_only_terminal_event`, `no_transfer_events` | gauge `Epoch`, gauge `EpochBallot` |
| `underfunded_terminal_epoch` | `underfunded_epoch_state`, `vault_balance_unchanged`, `underfunded_terminal_event`, `no_transfer_events` | gauge `Epoch` with terminal underfunding |
| `expired_terminal_epoch` | `expired_epoch_state`, `vault_balance_unchanged`, `expired_terminal_event`, `no_transfer_events` | gauge `Epoch` after public expiry |
| `aborted_terminal_epoch` | `aborted_epoch_state`, `vault_balance_unchanged`, `aborted_terminal_event`, `no_transfer_events` | gauge `Epoch` after governor abort |
| `numeric_identity_assignment` | `assigned_bonded_project_state`, `assigned_graduated_project_state`, `registration_assignment_event` | registry `Project` for assigned bonded and graduated IDs |
| `bounty_source_rotation` | `old_source_project_state`, `replacement_source_project_state`, `old_source_replay_rejected` | registry `Project` for both source-namespaced graduations |
| `bond_transition_table` | `bond_pending_state`, `bond_active_state`, `bond_suspended_state`, `bond_rejected_refunded_state`, `bond_rejected_forfeited_state`, `bond_retired_claimable_state`, `bond_retired_claimed_state`, `graduated_bond_free_state` | registry `Project` across every required bond/status disposition |

The CLI rejects duplicate evidence sources and `finalize` enforces the proof
names, predicate types, contract/query/response semantics, cross-proof IDs,
payout/refund/no-transfer semantics, balance bracketing, and full transaction
coverage used again by the release validator.

The scenario operator must inspect final contract states, events, authorities,
code IDs, and exact message destinations—not just transaction success. The
72-hour ratification is observed in chain time; it is not shortened for tests.
Juno staking changes must cross EndBlock and both epoch transcripts must retain
their distinct snapshot heights and powers.
