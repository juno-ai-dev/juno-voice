# Juno Voice v2 UX contract interface freeze

**Freeze baseline:** deployed v2 wire surface; exact root and accepted
`deps/dao-contracts` commits remain release inputs.

**Status:** v2 is deployed and independently verified. Funded use remains
blocked pending the separate authorization and canary gates.

**Audience:** wallet, frontend, explorer, and indexer implementers

This document freezes the implemented wire surface on which the v2 UX may rely.
It does not create or authorize a deployment. JSON keys are snake_case enum
encodings produced by `cw_serde`. `Uint128`, `Timestamp`, and `Decimal` are JSON
strings; integer IDs/cursors are JSON numbers. Amounts are integer native-denom
units (v2 deployment policy is `ujuno`), never display Juno.

## 1. Scope and canonical sources

| Component | v2 UX status | Canonical schema |
|---|---|---|
| `juno-voice-bounties` | **Frozen v2 candidate product surface** | [`contracts/juno-voice-bounties/schema/juno-voice-bounties.json`](../contracts/juno-voice-bounties/schema/juno-voice-bounties.json), with per-response files in [`schema/raw/`](../contracts/juno-voice-bounties/schema/raw/) |
| `hack-juno-registry-adapter` | **Frozen v2 candidate product and gauge-adapter surface** | [`contracts/hack-juno-registry-adapter/schema/hack-juno-registry-adapter.json`](../contracts/hack-juno-registry-adapter/schema/hack-juno-registry-adapter.json), with per-response files in [`schema/raw/`](../contracts/hack-juno-registry-adapter/schema/raw/) |
| pinned epoch-snapshot gauge | **Frozen external touchpoints only** (the submodule owns the full interface) | [`deps/dao-contracts/contracts/gauges/gauge/schema/gauge-orchestrator.json`](../deps/dao-contracts/contracts/gauges/gauge/schema/gauge-orchestrator.json) |
| `juno-voice` social request contract | **Prototype/legacy, not a v2 social-bounty UX surface**. Its implemented API is frozen only so the checked-in prototype does not get conflated with v2. | [`schema/juno-voice.json`](../schema/juno-voice.json), with per-response files in [`schema/raw/`](../schema/raw/) |

“Frozen” means message names/fields, response shapes, enum encodings, pagination semantics, required funds, authority gates, boundary inclusivity, and event names/attributes documented here are integration contracts. Governance/operations messages remain real public-chain messages but are labelled **admin** and must not appear as ordinary user controls. Fresh instantiation and release address/checksum selection are **release-only**; no v1 import is supported.

Clients must still read live `config`, `pause`, and object snapshots: configured amounts, limits, authorities, IDs, and timestamps are not constants unless explicitly stated. Do not copy large response definitions from this document; generate/typeset from the canonical schemas above.

## 2. Authority and funds legend

- **public**: any sender, subject to object state/time checks.
- **creator / contributor / owner / pending address**: the address recorded on that object.
- **agent / curator**: Agent Operations DAO role configured in the relevant contract.
- **governor**: Program Vault/governance authority configured in the contract.
- **bounty contract**: cross-contract call only from the configured bounty address.
- **none** in Funds means an empty funds array is mandatory; non-empty funds fail.
- **one native coin** means exactly one positive coin of `config.native_denom`; no other denom or second coin.

## 3. Social request prototype (`contracts/juno-voice`)

This is a retained legacy backend and is no longer consumed by the production
`app/`. It uses historical Juno voting power, block-height windows, an anti-spam
submission bond, and work-request states. It has no bounty contributions, payout
nomination, contributor ratification, project registry, or gauge epochs.

### 3.1 Execute inventory

All messages except `submit_request` require **no funds**.

| Execute message (exact fields) | Actor | Funds | Stable success attributes |
|---|---|---|---|
| `submit_request { title, summary, acceptance_criteria, category, detail_uri?, detail_digest? }` | public | exactly `config.submission_bond` in one `native_denom` coin | `action=submit_request`, `request_id` |
| `cast_vote { request_id, choice: support|oppose }` | public address with nonzero historical power; one immutable vote | none | `action=cast_vote`, `request_id`, `choice` |
| `close_request { request_id }` | public | none | `action=close_request`, `request_id`, `status` |
| `mark_spam { request_id, reason }` | steward | none | `action=mark_spam`, `request_id`, `status=spam` |
| `mark_duplicate { request_id, canonical_request_id, reason }` | steward | none | `action=mark_duplicate`, `request_id`, `status=duplicate` |
| `archive_request { request_id, reason }` | steward | none | `action=archive_request`, `request_id`, `status=archived` |
| `start_building { request_id, builder, reason }` | steward | none | `action=start_building`, `request_id`, `status=building` |
| `block_building { request_id, reason }` | assigned builder, or steward only after inactivity deadline | none | `action=block_building`, `request_id`, `status=blocked` |
| `resume_building { request_id, builder, reason }` | steward | none | `action=resume_building`, `request_id`, `status=building` |
| `reject_review { request_id, reason }` | verifier | none | `action=reject_review`, `request_id`, `status=building` |
| `block_review { request_id, reason }` | verifier | none | `action=block_review`, `request_id`, `status=blocked` |
| `add_evidence { request_id, kind, uri, digest, note }` | builder for delivery kinds in `building`; verifier for verification kinds in `review` | none | `action=add_evidence`, `request_id`, `evidence_id` |
| `request_review { request_id, reason, evidence_ids }` | assigned builder | none | `action=request_review`, `request_id`, `status=review` |
| `attest_shipment { request_id, rationale, evidence_ids }` | verifier | none | `action=attest_shipment`, `request_id`, `status=shipped` |
| `withdraw_refund { request_id }` | request author when bond is `refundable` | none | `action=withdraw_refund`, `request_id` plus atomic bank send |
| `pause_submissions { reason }` | steward or governor | none | **admin:** `action=pause_submissions`, `protocol_action_id` |
| `unpause_submissions { reason }` | governor | none | **admin:** `action=unpause_submissions`, `protocol_action_id` |
| `emergency_archive_open { request_id, reason: snapshot_history_risk }` | governor; submissions must first be paused | none | **admin/recovery:** request transition attributes |
| `update_config { submission_bond?, voting_period_blocks?, quorum_bps?, support_bps?, work_inactivity_blocks?, request_limits?, reason }` | governor | none | **admin:** `action=update_config`, `protocol_action_id` |
| `propose_governor { address, reason }`; `cancel_governor_transfer { reason }` | governor | none | **admin:** matching `action`, `protocol_action_id` |
| `accept_governor { reason }` | pending governor | none | **admin:** `action=accept_governor`, `protocol_action_id` |
| `replace_steward { address, reason }`; `replace_verifier { address, reason }` | governor | none | **admin:** matching `action`, `protocol_action_id` |

Evidence kinds are `pull_request`, `commit`, `release`, `deployment`, `document`, `test_report`, `audit_report`, `review_record`. Lifecycle states/codes are `open=1`, `qualified=2`, `not_prioritized=3`, `duplicate=4`, `spam=5`, `building=6`, `review=7`, `blocked=8`, `archived=9`, `shipped=10`; bond states are `locked`, `refundable`, `claimed`, `forfeited`.

**Height boundaries:** voting is valid at `opened_height <= height < closes_height`; permissionless close is valid at `height >= closes_height`. Steward inactivity control becomes valid at `height >= work_activity_height + work_inactivity_blocks`. Request policy is copied into the request and does not follow later config updates.

### 3.2 Query inventory and ordering

| Query (exact fields) | Response schema | Order/cursor |
|---|---|---|
| `config {}` | [`response_to_config.json`](../schema/raw/response_to_config.json) | singleton |
| `bond_totals {}` | [`response_to_bond_totals.json`](../schema/raw/response_to_bond_totals.json) | singleton |
| `request { id }` | [`response_to_request.json`](../schema/raw/response_to_request.json) | singleton; missing is an error |
| `shipment_attestation { request_id }` | [`response_to_shipment_attestation.json`](../schema/raw/response_to_shipment_attestation.json) | nullable `attestation` |
| `requests { status?, category?, author?, start_after_id?, limit? }` | [`response_to_requests.json`](../schema/raw/response_to_requests.json) | ascending request ID; feed `next_start_after` to `start_after_id` |
| `vote { request_id, voter }` | [`response_to_vote.json`](../schema/raw/response_to_vote.json) | nullable `vote` |
| `votes { request_id, start_after_voter?, limit? }` | [`response_to_votes.json`](../schema/raw/response_to_votes.json) | ascending canonical address; string cursor |
| `evidence { request_id, start_after_id?, limit? }` | [`response_to_evidence.json`](../schema/raw/response_to_evidence.json) | ascending evidence ID |
| `status_history { request_id, start_after_id?, limit? }` | [`response_to_status_history.json`](../schema/raw/response_to_status_history.json) | ascending history ID |
| `request_actions { request_id, start_after_id?, limit? }` | [`response_to_request_actions.json`](../schema/raw/response_to_request_actions.json) | ascending action ID |
| `protocol_actions { start_after_id?, limit? }` | [`response_to_protocol_actions.json`](../schema/raw/response_to_protocol_actions.json) | ascending action ID |
| `ranked_requests { status, category?, cursor?, limit? }` | [`response_to_ranked_requests.json`](../schema/raw/response_to_ranked_requests.json) | opaque canonical rank cursor; do not parse |

Every list response includes `query_height`; pages are bounded by live `default_query_limit`/`max_query_limit` and are weakly consistent while state changes. Refresh page one rather than treating a multi-page crawl as a snapshot.

## 4. Social bounties (`juno-voice-bounties`) — v2 public surface

### 4.1 Execute inventory

| Execute message (exact fields) | Actor / gate | Funds | Success event and stable attributes |
|---|---|---|---|
| `create_bounty { title, summary, acceptance_criteria, content_uri?, content_digest?, expires_at, project_candidate? }` | public; activity not paused | one native coin, `min_contribution <= amount <= max_bounty_total` | `juno_voice_bounties.bounty_created`: `bounty_id,creator,amount,expires_at,project_candidate` |
| `contribute { bounty_id }` | public; bounty `open`, before expiry | one native coin, amount >= live minimum and resulting snapshotted caps | `.contributed`: `bounty_id,contributor,amount,contributor_total,bounty_total` |
| `nominate_payout { bounty_id, recipient, evidence_uri, evidence_digest, rationale }` | creator or agent; open, before expiry | none | `.payout_nominated`: `bounty_id,round,nominator,recipient,contributor_count,total_weight,closes_at` |
| `confirm_sole_payout { bounty_id, round }` | sole snapshotted contributor; before both close and expiry | none | `.payout_completed`: `bounty_id,round,mode=sole_confirmation,recipient,amount`; atomic bank send |
| `decline_sole_payout { bounty_id, round, reason }` | sole snapshotted contributor before deadlines | none | `.sole_payout_declined`: `bounty_id,round,contributor,reason,next_status` |
| `vote_payout { bounty_id, round, vote: yes|no, rationale? }` | snapshotted contributor; ratifying; revisions allowed before close | none | `.payout_vote_recorded`: `bounty_id,round,voter,vote,weight,yes_weight,no_weight,revisions` |
| `finalize_payout { bounty_id, round }` | public after round close | none | `.ratification_finalized`: `bounty_id,round,outcome,yes_weight,no_weight,participating_weight,next_status`; successful multi-party result also sends full pot atomically |
| `cancel_sole_funded { bounty_id, reason }` | creator; open and still exactly one contributor | none | `.bounty_cancelled`: `bounty_id,creator,reason,refundable` |
| `expire { bounty_id }` | public; open at/after expiry | none | `.bounty_expired`: `bounty_id,actor,refundable` |
| `claim_refund { bounty_id }` | contributor in `refunding`; once per contributor | none | `.refund_claimed`: `bounty_id,contributor,amount,fully_refunded`; atomic bank send |
| `moderate { bounty_id, outcome, reason }` | agent | none | **admin/curation:** `.bounty_moderated`: `bounty_id,agent,outcome,reason,refundable` |
| `graduate_project { bounty_id }` | agent; paid candidate not previously graduated | none | **admin:** `.project_graduated`: `bounty_id,agent,registry,project_id,payout_address`, plus atomic registry `graduate` submessage |
| `pause_new_activity { reason }` | agent or governor | none | **admin/stop-only:** `.new_activity_paused`: `actor,reason` |
| `unpause_new_activity { reason }` | governor | none | **admin:** `.new_activity_unpaused`: `governor,reason` |
| `update_roles { governor?, agent?, registry? }` | governor | none | **admin/release:** `.roles_updated`: `actor,governor,agent,registry,config_version,changed_at` |
| `update_config { update }` | governor | none | **admin:** `.future_config_updated`: `governor,config_version,changed_at` |

Moderation outcomes are `spam`, `duplicate`, `policy_violation`. The six stored bounty states are `open`, `single_confirmation`, `ratifying`, `refunding`, `refunded`, `paid`; UI-only labels such as “reset”, “cancelled”, and “stopped” are derived from `status`, `refund_reason`, round outcome, and `pause`—they are not extra enum values. Round rules are `sole_confirmation` and `contribution_weighted_majority`; outcomes are `pending`, `paid`, `declined`, `no_majority`, `tie`, `no_votes`. Refund reasons are canonical and must be shown.

**Time boundaries:** `ratification_seconds` is fixed by implementation at 259,200 seconds (72 hours) and copied into terms. Creation requires `now + min_lifetime_seconds <= expires_at <= now + max_lifetime_seconds`. Create, contribute, nominate, and sole confirm/decline are rejected at `now >= expires_at`. Multi-contributor voting is governed only by the round deadline and remains valid while `now < closes_at`, even after bounty expiry. Multi-contributor `closes_at = nomination time + 72h`; sole `closes_at = min(nomination + 72h, expires_at)`. Finalization is rejected while `now < closes_at` and valid at equality. `YES > NO` pays; tie/no/no-votes do not. There is no early finalization.

### 4.2 Query inventory and pagination

All responses are defined in [`contracts/juno-voice-bounties/schema/raw/`](../contracts/juno-voice-bounties/schema/raw/).

| Query | Response | Ordering/cursor |
|---|---|---|
| `config {}`, `pause {}`, `authorities {}`, `accounting {}`, `health {}`, `error_catalog {}` | same-named response schema | singleton; error catalog is a stable set of UX classification labels, not transaction-error wire values |
| `bounty { bounty_id }` | `BountyResponse` (`bounty`, nullable `active_round`, `moderation`, `graduation`) | singleton |
| `bounties { start_after?, limit? }` | `BountiesResponse` | ascending bounty ID; exclusive ID cursor; no returned next cursor—continue with last item ID until short/empty page |
| `contribution { bounty_id, contributor, round? }` | `ContributionView` | `round=null` gives current amount; a round gives snapshotted weight |
| `contributions { bounty_id, start_after?, limit? }` | `ContributionsResponse` | ascending stable 1-based `contributor_index`; continue from last item index |
| `round { bounty_id, round }` | `Round` | singleton |
| `rounds { bounty_id, start_after?, limit? }` | `RoundsResponse` | ascending round number; exclusive cursor |
| `receipt { bounty_id, round, voter }` | nullable `VoteReceipt` | singleton |
| `receipts { bounty_id, round, start_after?, limit? }` | `ReceiptsResponse` | ascending stable 1-based `voter_index`; exclusive cursor |
| `claim { bounty_id, contributor }` | nullable `ClaimRecord` | singleton |
| `claims { bounty_id, start_after?, limit? }` | `ClaimsResponse` | scans ascending contributor index; **use returned `next_start_after`**, because unclaimed holes can make `claims` shorter than the scan limit |
| `history { bounty_id, start_after?, limit? }` | `HistoryResponse` | ascending sequence; exclusive cursor |

Limits are capped by live `config.limits.max_page_limit`; unlike the prototype contract, these pages do not include a query height and most do not return a cursor. For mutable pages, refresh after transaction confirmation and tolerate inter-page changes.

The error catalog labels are `unauthorized`, `unexpected_funds`, `invalid_funds`, `invalid_configuration`, `invalid_metadata`, `not_found`, `invalid_state`, `paused`, `expired`, `not_expired`, `contribution_limit`, `round_limit`, `wrong_round`, `not_contributor`, `voting_closed`, `ratification_open`, `already_claimed`, `not_refundable`, `not_project_candidate`, `already_graduated`, `arithmetic`. They classify UX recovery cases but are **not** emitted as structured transaction-error codes. Runtime failures arrive through the chain as display strings. Clients may classify recognized strings defensively for guidance, but must preserve the raw chain error and must not assume a stable machine-readable code is present.

## 5. Project registry and gauge adapter — v2 public surface

### 5.1 Execute inventory

| Execute message | Actor / gate | Funds | Success event and stable attributes |
|---|---|---|---|
| `register_project { metadata_uri, metadata_digest, payout_address }` | public; admissions open; registry assigns the next numeric ID | exactly `config.registration_bond` in one native coin | typed response `{ response_version: 1, project_id }`; `hack_juno_registry.project_registered`: `project_id,applicant,payout_address,bond` |
| `graduate { source_bounty_id, metadata_uri, metadata_digest, payout_address }` | configured bounty contract only; replay key is `(sender, source_bounty_id)` | none | typed response `{ response_version: 1, project_id }`; `.bounty_graduated`: `project_id,source_bounty_id,source_bounty_contract,payout_address` |
| `update_pending_metadata { project_id, metadata_uri, metadata_digest }` | pending project owner | none | `.pending_metadata_updated`: `project_id,applicant` |
| `review_registration { project_id, decision, reason }` | curator | none | **admin:** `.registration_reviewed`: `project_id,curator,decision,reason_code,status` |
| `suspend { project_id, reason }` | curator | none | **admin/stop:** `.project_suspended`: `project_id,curator,reason_code` |
| `retire { project_id, reason }` | curator, or owner with `voluntary_retirement` | none | `.project_retired`: `project_id,actor,bond_claimable` |
| `override_project_status { project_id, status, reason }` | governor | none | **admin/recovery:** `.project_status_overridden`: `project_id,governor,status,reason_code` |
| `propose_payout_address { project_id, address }` | project owner or current payout address | none | `.payout_address_proposed`: `project_id,actor,proposed_address,executable_at` |
| `cancel_payout_address_change { project_id }` | project owner or current payout address | none | `.payout_address_cancelled`: `project_id,actor,cancelled_address` |
| `accept_payout_address { project_id }` | proposed new address, at/after delay | none | `.payout_address_accepted`: `project_id,old_address,new_address` |
| `claim_registration_bond { project_id }` | recorded depositor when bond `claimable` | none | `.registration_bond_claimed`: `project_id,depositor,amount`; atomic bank send |
| `stop { scope, reason }` | curator or governor | none | **admin/stop-only:** `.stopped`: `actor,scope,reason` |
| `resume { scope, reason }` | governor | none | **admin:** `.resumed`: `governor,scope,reason` |
| `update_curator { curator }` | governor | none | **admin/release:** `.curator_updated`: `governor,curator,changed_at` |
| `update_bounty_contract { bounty_contract }` | governor | none | **admin/release:** `.bounty_contract_updated`: `governor,bounty_contract,changed_at` |
| `update_economic_config { update: { registration_bond?, spam_destination?, payout_address_delay_seconds?, epoch_ceiling?, min_project_share?, max_project_share?, max_selected_projects? } }` | governor | none | **admin:** `.economic_config_updated`: `governor,config_version,changed_at` |

Project states are `pending`, `active`, `suspended`, `rejected`, `retired`; bond states are `deposited`, `refunded`, `forfeited`, `claimable`, `claimed`. Review decisions are `approve`, `request_changes`, `soft_reject`, `hard_reject`; override targets are `active`, `suspended`, `rejected`, `retired`; stop scopes are `admissions`, `adapter`, `all`. Project IDs are registry-assigned, monotonically increasing `u64` values and are never reused. Only `active` projects encoded as canonical `project:<base-10-id>` options plus reserved `do-not-distribute` are gauge options.

**Address boundary:** `executable_at = proposed_at + payout_address_delay_seconds`; acceptance fails while `now < executable_at` and succeeds at equality. Always display the pending address and exact UTC executable time. Admission and active-option capacity are bounded by config/implementation.

### 5.2 Query inventory and ordering

All owned response schemas are in [`contracts/hack-juno-registry-adapter/schema/raw/`](../contracts/hack-juno-registry-adapter/schema/raw/).

| Query | Response | Ordering/cursor |
|---|---|---|
| `config {}`, `pause {}`, `accounting {}`, `health {}` | same-named response | singleton |
| `project { project_id }` | `Project` | singleton; missing errors |
| `projects { start_after?, limit? }` | `ProjectsResponse` | ascending numeric project ID; exclusive `u64` cursor; continue from last ID |
| `applications { start_after?, limit? }` | `ProjectsResponse` | ascending pending numeric project ID; exclusive `u64` cursor |
| `status_history { project_id, start_after?, limit? }` | `HistoryResponse<StatusHistoryEntry>` | ascending sequence |
| `address_history { project_id, start_after?, limit? }` | `HistoryResponse<AddressHistoryEntry>` | ascending sequence |
| `all_options { start_after?, limit? }` | `AllOptionsResponse` | ascending option string; exclusive cursor |
| `check_option { option }` | `{ valid }` | singleton |
| `sample_gauge_msgs { selected, epoch_budget, available_balance, denom }` | `{ execute, emitted_value, retained_value }` | gauge protocol/internal; no funds; validates stop, denom, ceiling, balance, caps and shares |

Pages are capped by `max_page_limit`, return no next cursor, and do not carry query height.

## 6. Pinned gauge UX touchpoints

The v2 UX integrates the epoch-snapshot mode of the pinned gauge; it must not expose hook-mode stake/member messages. Full wire definitions and responses are in the pinned [gauge schema](../deps/dao-contracts/contracts/gauges/gauge/schema/gauge-orchestrator.json).

### Frozen user/public touchpoints

| Action/query | Authority/funds | UX contract |
|---|---|---|
| `open_epoch { gauge }` | public, no funds | requires the Vault's full epoch budget and creates the next epoch only when schedule/policy permit; success also binds `execution_deadline,policy_version,retained_option` |
| `place_votes { gauge, votes? }` | public staker, no funds | in snapshot mode applies to current open epoch using historical power; `votes=null` abstains/removes active ballot; positive Decimal weights sum <= 1; success reports `participating_power,allocated_power,total_cast,retained_option_power,unallocated_power` |
| `execute { gauge }` | public, no funds | at/after close and through the execution deadline; requires only actual emitted value and reports raw allocation plus `selected_project_power,emitted_value,retained_value,policy_version,execution_deadline,outcome,message_count` |
| `expire_epoch { gauge }` | public, no funds | at/after `execution_deadline`; terminal no-distribution outcome, schedule advances exactly once |
| `abort_epoch { gauge, reason }` | owner/Program Vault only, no funds | reasoned terminal no-distribution recovery for an unrecoverable open epoch; guardian cannot call it |
| `cleanup_epoch { gauge, epoch, limit }` | public, no funds | internal maintenance, not a primary button; success includes `gauge_id,epoch_id,processed,phase,complete` |
| `gauge { id }`, `epoch { gauge, epoch }`, `epoch_ballot { gauge, epoch, voter }`, `epoch_allocations { ... }`, `list_epochs { ... }`, `list_epoch_ballots { ... }` | query | primary epoch/detail/user-result data |
| registry `all_options` / gauge `list_options` and `selected_set` | query | option discovery/current ranking; epoch detail must use the epoch’s fixed facts, not silently substitute current registry status |

Epoch outcomes are `open`, `distributed { message_count }`, `no_distribution_turnout`, `no_distribution_zero_participation`, `no_eligible_options`, `insufficient_funds { required, available }`, `expired`, and `aborted { reason }`. Every terminal response satisfies `emitted_value + retained_value == epoch_budget`. Ballot list pagination is ascending stable `receipt_index` and must use returned `next_start_after` because removed ballots create holes. Allocations are option-string ordered with exclusive `start_after`; epochs are ID ordered with exclusive `start_after`. List responses other than ballots do not return next cursors, so continue from the last item until short/empty.

**Time boundary:** `opens_at`, `closes_at`, and `execution_deadline` are Unix seconds (gauge response integers, unlike CosmWasm `Timestamp` strings in owned contracts). Voting is before close; execute is at/after close and no later than the deadline; expiry is valid at deadline equality. UX eligibility must be confirmed against chain state/time, not browser time.

Gauge owner operations (`create_gauge`, `update_gauge`, `resume_gauge`, `update_snapshot_policy`, option removal, hooks) are **admin/release-only**. `stop_gauge` is owner or configured guardian stop-only; `resume_gauge` is owner-only. Fresh instantiation and selecting the production `gauge_id` are **release-only**.

## 7. Cross-contract flows

1. **Bounty settlement:** user funds `create_bounty`/`contribute` → creator or agent nominates → sole contributor confirms, or contributors vote for the full 72 hours → anyone finalizes → bank send is atomic with `paid`, or state resets/refunds. Never show a separate recipient claim.
2. **Graduation:** after a candidate bounty is `paid`, agent calls `graduate_project` on bounties → bounties uses reply-on-success to call registry `graduate` with no caller-supplied ID → registry authenticates the source, allocates an ID, and returns a typed response → bounties records that ID only in the reply → both records commit atomically. UX success requires the bounty and registry events plus canonical registry state to agree.
3. **Bonded registration:** applicant sends exact registry bond → curator review activates, requests changes, or rejects → contract records bond disposition → depositor claims only if state is `claimable`.
4. **Gauge epoch:** public `open_epoch` snapshots historical Juno power and adapter options → stakers place/revise allocations → public `execute` queries registry `sample_gauge_msgs` with epoch budget, available balance, and denom → registry emits native bank-send messages only for active selected projects; `do-not-distribute`, caps, thresholds, and rounding remain retained value. Graduation is eligibility, not guaranteed payment.
5. **Stops:** agent/curator can stop bounded new activity/admissions/adapter; gauge guardian can stop; only governor/owner can resume. Existing refunds and the explicitly implemented safety exits remain governed by their message gates—do not infer a global pause from one contract.

## 8. Compact UX integration matrix

| Screen/action | Query before/render | Execute + funds | Confirm success by | Principal error/empty states |
|---|---|---|---|---|
| Bounty ledger | `config,pause,bounties` | — | query result | RPC/malformed, empty page, paused banner, mutable-page refresh |
| Create bounty | `config,pause` | `create_bounty`; one native contribution | created event + `bounty(id)` | paused, invalid metadata/expiry/funds, caps |
| Bounty detail/fund | `bounty,contributions,history,accounting` | `contribute`; one native contribution | contributed event + refreshed bounty/contribution | expired, non-open, min/total/contributor cap |
| Nominate delivery | `bounty` | `nominate_payout`; none | nominated event + active round | wrong actor/state, expired, round limit |
| Sole review | `bounty,contribution` | confirm/decline; none | payout/decline event + canonical state/bank send | wrong round/contributor, deadline closed |
| Contributor ballot | `bounty,contribution,receipt,receipts` | `vote_payout`; none | vote event + refreshed receipt/round | not contributor, wrong round, voting closed |
| Finalize/refund | `bounty,round,claim` | finalize or claim; none | finalization/refund event + canonical state/bank send | ratification open, not refundable/already claimed |
| Projects/applications | `projects/applications,config,pause` | `register_project` without an ID; exact native bond | assigned-ID event + project | stopped/capacity, invalid bond/metadata |
| Project detail/address | `project,status_history,address_history` | propose/cancel/accept; none | address event + refreshed project | wrong controller/address, delay open, no pending change |
| Registration bond claim | `project` | `claim_registration_bond`; none | claim event + bank send | wrong depositor/not claimable |
| Epoch list/detail | `gauge,list_epochs,epoch,epoch_allocations`; registry project lookup | `open_epoch`/`execute`/`expire_epoch`; none | terminal event + refreshed epoch | stopped, funding, schedule/window, turnout/no eligible options, insufficient funds, adapter validation |
| My epoch ballot | `epoch,epoch_ballot` | `place_votes`; none | snapshot-vote event + refreshed ballot | no historical power, closed/stopped, invalid option/weights |
| Admin operations | live config/pause/object/history | role-specific messages; none | exact admin event + state | unauthorized, invalid transition/config; never render as public authority |

All transaction UX must show exact message, sender, contract, and funds before signing; treat broadcast as pending until canonical query/event confirmation and avoid duplicate rebroadcast when outcome is unknown.

## 9. Prototype assumptions reconciled with backend reality

- The first `app/` release read only the deployed v1 bounty contract through the
  historical profile in section 11. The removed request ledger/ranking,
  support/oppose voting, builder/verifier evidence, and request-bond UI are
  **not** the v2 bounty UX.
- The prototype’s `Submit a request` sends `submission_bond`; v2 `create_bounty` sends an initial **contribution** governed by bounty min/max and expiry. Do not rename one payload into the other.
- Prototype status codes 1–10 and opaque rank cursors do not apply to bounty/project/epoch lists. V2 bounty state has six explicit variants; “cancelled/reset/stopped” require the canonical companion fields described above.
- Prototype voting is immutable historical-power support/oppose and is safety-disabled in the current UI. Bounty votes are revisable yes/no, weighted by snapshotted contributions. Gauge votes are revisable weighted option allocations using historical Juno power. These are three distinct ballots.
- The v2 backend has no single aggregate query and owned lists generally have no `query_height` or returned cursor. UX must compose queries, follow each contract’s cursor semantics, and refresh after writes.
- Product prose previously listed aspirational display states (`cancelled`, `stopped`, `failed/expired`) that are not wire enum variants. Render them as labels only when derived from canonical pause/refund/round/epoch fields; never send or decode them as states.
- Prototype and historical v1 addresses are not v2 production facts. The v2
  client must receive all five identities from reviewed fresh-deployment
  verification and must fail closed before that binding exists.

## 10. Genuine interface decisions still open

These do not block implementing the frozen wire messages, but require a product/indexer decision before a polished UX:

1. **No returned next cursor/query height on most owned lists.** Clients can safely continue from the last item, but cannot distinguish “exactly full final page” without one extra query and cannot claim snapshot consistency. Decide whether UX accepts this or a future contract revision adds cursors/heights (which would change schemas).
2. **Derived versus explicit product states.** Product language names reset/cancelled/stopped/failed-expired states not represented by the implemented enums. This document freezes derivation for v2 UX; decide whether that is acceptable before deployment or enums must change.
3. **Indexer stability governance.** Events are implemented and tested in places, but there is no separately versioned event schema. This freeze treats the listed names/keys as stable. Decide whether release gates should mechanically snapshot every event attribute.
4. **Gauge adapter direct-query shape is snapshot-specific.** The owned adapter requires concrete `epoch_budget`, `available_balance`, and `denom`, and returns `execute`, `emitted_value`, and `retained_value`. The snapshot gauge validates all three response fields and their exact budget reconciliation. Generic hook-mode callers are not a supported UX path; snapshot-only deployment remains mandatory.

Until any decision produces new checked-in schemas, this commit—not aspirational prose—is the UX integration baseline.

## 11. Production v2 identity profile

The production client is pinned to the five verified Juno mainnet v2
address/code-ID/checksum triples documented in the repository `README.md` and
provided through the fail-closed build environment. There is no legacy identity
fallback or runtime compatibility path.

After verifying chain ID, contract addresses, Code IDs, and wasm checksums,
clients query the bounded v2 bounty, registry, Vault, voting, and gauge surfaces.
Bounty pages are ascending by numeric `id`; a full page requires another query
with `start_after` equal to the last ID, including an extra empty query for an
exactly full final page. Repeated or non-increasing IDs are invalid. Contract
pages have no observation height and are weakly consistent. Amounts and
CosmWasm timestamps remain decimal strings and clients must parse them with
arbitrary-precision integers.
