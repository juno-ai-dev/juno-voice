use cosmwasm_std::testing::{
    message_info, mock_dependencies, mock_env, MockApi, MockQuerier, MockStorage,
};
use cosmwasm_std::{coin, from_json, Addr, Empty, Env, OwnedDeps, Response, Timestamp, Uint128};
use proptest::prelude::*;

use crate::contract::{execute, instantiate, query, RATIFICATION_SECONDS};
use crate::error::ContractError;
use crate::msg::{
    ClaimsResponse, ConfigUpdate, ExecuteMsg, InstantiateMsg, Limits, ModerationOutcome,
    PayoutVote, ProjectCandidate, QueryMsg,
};
use crate::state::{
    BountyStatus, ClaimRecord, HistoryAction, RefundReason, RoundOutcome, ACCOUNTING, BOUNTIES,
    CLAIMS, CONFIG, CONTRIBUTIONS, CONTRIBUTION_CHECKPOINTS, GRADUATIONS, HISTORY, MODERATIONS,
    ROUNDS, VOTES,
};

type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier, Empty>;

const GOVERNOR: &str = "governor";
const AGENT: &str = "agent";
const REGISTRY: &str = "registry";
const CREATOR: &str = "creator";
const ALICE: &str = "alice";
const BOB: &str = "bob";
const RECIPIENT: &str = "recipient";

fn addr(label: &str) -> Addr {
    MockApi::default().addr_make(label)
}

fn address(label: &str) -> String {
    addr(label).to_string()
}

fn assert_wire_event(response: &Response, event_type: &str, attribute_keys: &[&str]) {
    assert_eq!(response.events.len(), 1, "unexpected event count");
    let event = &response.events[0];
    assert_eq!(event.ty, event_type);
    assert_eq!(
        event
            .attributes
            .iter()
            .map(|attribute| attribute.key.as_str())
            .collect::<Vec<_>>(),
        attribute_keys
    );
    assert!(
        event
            .attributes
            .iter()
            .all(|attribute| !attribute.value.is_empty()),
        "event attributes must have nonempty wire values"
    );
}

fn limits() -> Limits {
    Limits {
        max_title_bytes: 80,
        max_summary_bytes: 256,
        max_acceptance_criteria_bytes: 512,
        max_uri_bytes: 256,
        max_rationale_bytes: 256,
        max_reason_bytes: 128,
        max_page_limit: 3,
    }
}

fn instantiate_msg() -> InstantiateMsg {
    InstantiateMsg {
        native_denom: "ujuno".into(),
        governor: address(GOVERNOR),
        agent: address(AGENT),
        registry: address(REGISTRY),
        min_contribution: Uint128::new(10),
        max_bounty_total: Uint128::new(10_000),
        min_lifetime_seconds: 100,
        max_lifetime_seconds: 1_000_000,
        max_contributors: 5,
        max_rounds: 5,
        limits: limits(),
    }
}

fn init() -> (TestDeps, Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let response = instantiate(
        deps.as_mut(),
        env.clone(),
        message_info(&addr("deployer"), &[]),
        instantiate_msg(),
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.instantiated",
        &[
            "governor",
            "agent",
            "registry",
            "native_denom",
            "ratification_seconds",
        ],
    );
    (deps, env)
}

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn create_msg(expires_at: Timestamp) -> ExecuteMsg {
    ExecuteMsg::CreateBounty {
        title: "Ship a useful thing".into(),
        summary: "A bounded social bounty".into(),
        acceptance_criteria: "The specified outcome is publicly verifiable".into(),
        content_uri: Some("ipfs://bafyterms".into()),
        content_digest: Some(digest('a')),
        expires_at,
        project_candidate: None,
    }
}

fn create(deps: &mut TestDeps, env: &Env, creator: &str, amount: u128, lifetime: u64) -> u64 {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(creator), &[coin(amount, "ujuno")]),
        create_msg(env.block.time.plus_seconds(lifetime)),
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.bounty_created",
        &[
            "bounty_id",
            "creator",
            "amount",
            "expires_at",
            "project_candidate",
        ],
    );
    BOUNTIES
        .range(&deps.storage, None, None, cosmwasm_std::Order::Descending)
        .next()
        .unwrap()
        .unwrap()
        .0
}

fn contribute(deps: &mut TestDeps, env: &Env, id: u64, who: &str, amount: u128) {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(who), &[coin(amount, "ujuno")]),
        ExecuteMsg::Contribute { bounty_id: id },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.contributed",
        &[
            "bounty_id",
            "contributor",
            "amount",
            "contributor_total",
            "bounty_total",
        ],
    );
}

fn nominate(deps: &mut TestDeps, env: &Env, id: u64) {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::NominatePayout {
            bounty_id: id,
            recipient: address(RECIPIENT),
            evidence_uri: "ipfs://bafyevidence".into(),
            evidence_digest: digest('b'),
            rationale: "The acceptance criteria are met".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.payout_nominated",
        &[
            "bounty_id",
            "round",
            "nominator",
            "recipient",
            "contributor_count",
            "total_weight",
            "closes_at",
        ],
    );
}

fn vote(deps: &mut TestDeps, env: &Env, id: u64, round: u32, who: &str, choice: PayoutVote) {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(who), &[]),
        ExecuteMsg::VotePayout {
            bounty_id: id,
            round,
            vote: choice,
            rationale: None,
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.payout_vote_recorded",
        &[
            "bounty_id",
            "round",
            "voter",
            "vote",
            "weight",
            "yes_weight",
            "no_weight",
            "revisions",
        ],
    );
}

fn assert_accounting_identity(deps: &TestDeps) {
    let accounting = ACCOUNTING.load(&deps.storage).unwrap();
    let liabilities = accounting
        .active_escrow
        .checked_add(accounting.outstanding_refunds)
        .unwrap()
        .checked_add(accounting.pending_payout_liabilities)
        .unwrap();
    let retained = accounting
        .lifetime_received
        .checked_sub(accounting.lifetime_paid)
        .unwrap()
        .checked_sub(accounting.lifetime_refunded)
        .unwrap();
    assert_eq!(liabilities, retained);

    let mut active = Uint128::zero();
    let mut refunds = Uint128::zero();
    let mut pending = Uint128::zero();
    for item in BOUNTIES.range(&deps.storage, None, None, cosmwasm_std::Order::Ascending) {
        let bounty = item.unwrap().1;
        match bounty.status {
            BountyStatus::Open => active += bounty.total_contribution,
            BountyStatus::SingleConfirmation | BountyStatus::Ratifying => {
                pending += bounty.total_contribution
            }
            BountyStatus::Refunding => {
                refunds += bounty.total_contribution - bounty.refunded_amount
            }
            BountyStatus::Refunded | BountyStatus::Paid => {}
        }
        assert!(bounty.paid_amount.is_zero() || bounty.refunded_amount.is_zero());
        assert!(bounty.paid_amount <= bounty.total_contribution);
        assert!(bounty.refunded_amount <= bounty.total_contribution);
    }
    assert_eq!(accounting.active_escrow, active);
    assert_eq!(accounting.outstanding_refunds, refunds);
    assert_eq!(accounting.pending_payout_liabilities, pending);
}

#[test]
fn instantiate_and_creation_enforce_denom_metadata_lifetime_and_funds() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let mut msg = instantiate_msg();
    msg.native_denom = "uatom".into();
    let err = instantiate(
        deps.as_mut(),
        env.clone(),
        message_info(&addr("deployer"), &[]),
        msg,
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidConfiguration(_)));

    let (mut deps, env) = init();
    let bad_funds = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[coin(100, "uatom")]),
        create_msg(env.block.time.plus_seconds(100)),
    )
    .unwrap_err();
    assert_eq!(bad_funds, ContractError::InvalidFunds);

    let too_soon = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[coin(100, "ujuno")]),
        create_msg(env.block.time.plus_seconds(99)),
    )
    .unwrap_err();
    assert!(matches!(too_soon, ContractError::InvalidMetadata(_)));

    let mut bad_metadata = create_msg(env.block.time.plus_seconds(100));
    if let ExecuteMsg::CreateBounty { content_digest, .. } = &mut bad_metadata {
        *content_digest = Some("sha256:ABC".into());
    }
    let err = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[coin(100, "ujuno")]),
        bad_metadata,
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::InvalidMetadata(_)));

    let id = create(&mut deps, &env, CREATOR, 100, 100);
    let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
    assert_eq!(bounty.total_contribution, Uint128::new(100));
    assert_eq!(bounty.terms.ratification_seconds, 259_200);
    assert_eq!(bounty.expires_at, env.block.time.plus_seconds(100));
    assert_accounting_identity(&deps);
}

#[test]
fn contributions_aggregate_count_exactly_and_nomination_freezes_terms() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 10_000);
    contribute(&mut deps, &env, id, ALICE, 30);
    contribute(&mut deps, &env, id, CREATOR, 20);
    let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
    assert_eq!(bounty.total_contribution, Uint128::new(150));
    assert_eq!(bounty.contributor_count, 2);
    assert_eq!(
        CONTRIBUTIONS
            .load(&deps.storage, (id, &addr(CREATOR)))
            .unwrap(),
        Uint128::new(120)
    );

    nominate(&mut deps, &env, id);
    let round = ROUNDS.load(&deps.storage, (id, 1)).unwrap();
    assert_eq!(round.total_weight, Uint128::new(150));
    assert_eq!(round.contributor_count, 2);
    assert_eq!(
        round.closes_at.unwrap(),
        env.block.time.plus_seconds(RATIFICATION_SECONDS)
    );
    let rejected = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(BOB), &[coin(10, "ujuno")]),
        ExecuteMsg::Contribute { bounty_id: id },
    )
    .unwrap_err();
    assert_eq!(rejected, ContractError::InvalidState);
    assert_accounting_identity(&deps);
}

#[test]
fn sole_confirmation_is_explicit_and_decline_after_expiry_refunds() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 1_000);
    nominate(&mut deps, &env, id);
    let unauthorized = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(ALICE), &[]),
        ExecuteMsg::ConfirmSolePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap_err();
    assert_eq!(unauthorized, ContractError::NotContributor);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::ConfirmSolePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap();
    assert_eq!(response.messages.len(), 1);
    assert_wire_event(
        &response,
        "juno_voice_bounties.payout_completed",
        &["bounty_id", "round", "mode", "recipient", "amount"],
    );
    let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
    assert_eq!(bounty.status, BountyStatus::Paid);
    assert_eq!(bounty.paid_recipient, Some(addr(RECIPIENT)));
    let duplicate_payout = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::ConfirmSolePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap_err();
    assert_eq!(duplicate_payout, ContractError::WrongRound);
    assert_accounting_identity(&deps);

    let id2 = create(&mut deps, &env, CREATOR, 70, 100);
    nominate(&mut deps, &env, id2);
    let mut after_expiry = env.clone();
    after_expiry.block.time = env.block.time.plus_seconds(100);
    let response = execute(
        deps.as_mut(),
        after_expiry.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::DeclineSolePayout {
            bounty_id: id2,
            round: 1,
            reason: "Delivery is incomplete".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.sole_payout_declined",
        &["bounty_id", "round", "contributor", "reason", "next_status"],
    );
    let bounty = BOUNTIES.load(&deps.storage, id2).unwrap();
    assert_eq!(bounty.status, BountyStatus::Refunding);
    assert_eq!(bounty.refund_reason, Some(RefundReason::Expired));
    assert_accounting_identity(&deps);
}

#[test]
fn weighted_vote_revisions_and_full_nanosecond_window_are_exact() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 500_000);
    contribute(&mut deps, &env, id, ALICE, 30);
    nominate(&mut deps, &env, id);

    vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::Yes);
    vote(&mut deps, &env, id, 1, ALICE, PayoutVote::No);
    let round = ROUNDS.load(&deps.storage, (id, 1)).unwrap();
    assert_eq!(round.yes_weight, Uint128::new(100));
    assert_eq!(round.no_weight, Uint128::new(30));

    vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::No);
    let round = ROUNDS.load(&deps.storage, (id, 1)).unwrap();
    assert_eq!(round.yes_weight, Uint128::zero());
    assert_eq!(round.no_weight, Uint128::new(130));

    vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::Yes);
    vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::Yes);
    let round = ROUNDS.load(&deps.storage, (id, 1)).unwrap();
    assert_eq!(round.yes_weight, Uint128::new(100));
    assert_eq!(round.no_weight, Uint128::new(30));
    let receipt = VOTES.load(&deps.storage, (id, 1, &addr(CREATOR))).unwrap();
    assert_eq!(receipt.revisions, 3);

    let closes = round.closes_at.unwrap();
    let mut one_ns_early = env.clone();
    one_ns_early.block.time = Timestamp::from_nanos(closes.nanos() - 1);
    let err = execute(
        deps.as_mut(),
        one_ns_early,
        message_info(&addr("finalizer"), &[]),
        ExecuteMsg::FinalizePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::RatificationOpen);

    let mut at_close = env.clone();
    at_close.block.time = closes;
    let response = execute(
        deps.as_mut(),
        at_close,
        message_info(&addr("finalizer"), &[]),
        ExecuteMsg::FinalizePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap();
    assert_eq!(response.messages.len(), 1);
    assert_wire_event(
        &response,
        "juno_voice_bounties.ratification_finalized",
        &[
            "bounty_id",
            "round",
            "outcome",
            "yes_weight",
            "no_weight",
            "participating_weight",
            "next_status",
        ],
    );
    assert_eq!(
        BOUNTIES.load(&deps.storage, id).unwrap().status,
        BountyStatus::Paid
    );
    assert_accounting_identity(&deps);
}

#[test]
fn wrong_round_late_votes_and_expiry_during_ratification_cannot_bypass_snapshot() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 100);
    contribute(&mut deps, &env, id, ALICE, 30);
    nominate(&mut deps, &env, id);

    CONTRIBUTION_CHECKPOINTS
        .save(&mut deps.storage, (id, &addr(CREATOR), 1), &Uint128::zero())
        .unwrap();
    let zero_weight = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::VotePayout {
            bounty_id: id,
            round: 1,
            vote: PayoutVote::Yes,
            rationale: None,
        },
    )
    .unwrap_err();
    assert_eq!(zero_weight, ContractError::NotContributor);
    assert!(!VOTES.has(&deps.storage, (id, 1, &addr(CREATOR))));
    CONTRIBUTION_CHECKPOINTS
        .save(
            &mut deps.storage,
            (id, &addr(CREATOR), 1),
            &Uint128::new(100),
        )
        .unwrap();

    let wrong_round = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::VotePayout {
            bounty_id: id,
            round: 2,
            vote: PayoutVote::Yes,
            rationale: None,
        },
    )
    .unwrap_err();
    assert_eq!(wrong_round, ContractError::WrongRound);

    let mut after_expiry = env.clone();
    after_expiry.block.time = env.block.time.plus_seconds(100);
    let expire_active = execute(
        deps.as_mut(),
        after_expiry.clone(),
        message_info(&addr("anyone"), &[]),
        ExecuteMsg::Expire { bounty_id: id },
    )
    .unwrap_err();
    assert_eq!(expire_active, ContractError::InvalidState);
    vote(&mut deps, &after_expiry, id, 1, CREATOR, PayoutVote::Yes);

    let closes = ROUNDS
        .load(&deps.storage, (id, 1))
        .unwrap()
        .closes_at
        .unwrap();
    let mut at_close = env.clone();
    at_close.block.time = closes;
    let late = execute(
        deps.as_mut(),
        at_close.clone(),
        message_info(&addr(ALICE), &[]),
        ExecuteMsg::VotePayout {
            bounty_id: id,
            round: 1,
            vote: PayoutVote::No,
            rationale: None,
        },
    )
    .unwrap_err();
    assert_eq!(late, ContractError::VotingClosed);
    execute(
        deps.as_mut(),
        at_close,
        message_info(&addr("finalizer"), &[]),
        ExecuteMsg::FinalizePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap();
    assert_eq!(
        BOUNTIES.load(&deps.storage, id).unwrap().status,
        BountyStatus::Paid
    );
    assert_accounting_identity(&deps);
}

#[test]
fn no_votes_tie_and_no_majority_reset_without_paying() {
    for scenario in 0..3 {
        let (mut deps, env) = init();
        let id = create(&mut deps, &env, CREATOR, 100, 500_000);
        contribute(&mut deps, &env, id, ALICE, 100);
        nominate(&mut deps, &env, id);
        if scenario == 1 {
            vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::Yes);
            vote(&mut deps, &env, id, 1, ALICE, PayoutVote::No);
        } else if scenario == 2 {
            vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::No);
        }
        let mut close = env.clone();
        close.block.time = env.block.time.plus_seconds(RATIFICATION_SECONDS);
        let response = execute(
            deps.as_mut(),
            close,
            message_info(&addr("anyone"), &[]),
            ExecuteMsg::FinalizePayout {
                bounty_id: id,
                round: 1,
            },
        )
        .unwrap();
        assert!(response.messages.is_empty());
        let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
        assert_eq!(bounty.status, BountyStatus::Open);
        assert_eq!(bounty.next_round, 2);
        let expected = match scenario {
            0 => RoundOutcome::NoVotes,
            1 => RoundOutcome::Tie,
            _ => RoundOutcome::NoMajority,
        };
        assert_eq!(
            ROUNDS.load(&deps.storage, (id, 1)).unwrap().outcome,
            expected
        );
        assert_accounting_identity(&deps);
    }
}

#[test]
fn low_participation_yes_majority_pays_and_noncontributors_cannot_vote() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 900, 500_000);
    contribute(&mut deps, &env, id, ALICE, 100);
    nominate(&mut deps, &env, id);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(BOB), &[]),
        ExecuteMsg::VotePayout {
            bounty_id: id,
            round: 1,
            vote: PayoutVote::Yes,
            rationale: None,
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::NotContributor);
    vote(&mut deps, &env, id, 1, ALICE, PayoutVote::Yes);
    let mut close = env.clone();
    close.block.time = env.block.time.plus_seconds(RATIFICATION_SECONDS);
    execute(
        deps.as_mut(),
        close,
        message_info(&addr("anyone"), &[]),
        ExecuteMsg::FinalizePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap();
    assert_eq!(
        BOUNTIES.load(&deps.storage, id).unwrap().status,
        BountyStatus::Paid
    );
    assert_accounting_identity(&deps);
}

#[test]
fn reset_top_up_and_later_round_keep_old_receipts_and_weights_isolated() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 900_000);
    contribute(&mut deps, &env, id, ALICE, 100);
    nominate(&mut deps, &env, id);
    vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::No);
    let mut close = env.clone();
    close.block.time = env.block.time.plus_seconds(RATIFICATION_SECONDS);
    execute(
        deps.as_mut(),
        close.clone(),
        message_info(&addr("anyone"), &[]),
        ExecuteMsg::FinalizePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap();
    contribute(&mut deps, &close, id, CREATOR, 50);
    nominate(&mut deps, &close, id);

    vote(&mut deps, &close, id, 2, CREATOR, PayoutVote::Yes);
    let old = VOTES.load(&deps.storage, (id, 1, &addr(CREATOR))).unwrap();
    let new = VOTES.load(&deps.storage, (id, 2, &addr(CREATOR))).unwrap();
    assert_eq!(old.weight, Uint128::new(100));
    assert_eq!(old.vote, PayoutVote::No);
    assert_eq!(new.weight, Uint128::new(150));
    assert_eq!(new.vote, PayoutVote::Yes);
    assert_eq!(
        ROUNDS.load(&deps.storage, (id, 1)).unwrap().total_weight,
        Uint128::new(200)
    );
    assert_eq!(
        ROUNDS.load(&deps.storage, (id, 2)).unwrap().total_weight,
        Uint128::new(250)
    );
    assert_accounting_identity(&deps);
}

#[test]
fn cancellation_expiry_and_typed_moderation_create_pull_refunds_only() {
    let (mut deps, env) = init();
    let cancelled = create(&mut deps, &env, CREATOR, 100, 500);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::CancelSoleFunded {
            bounty_id: cancelled,
            reason: "No longer requested".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.bounty_cancelled",
        &["bounty_id", "creator", "reason", "refundable"],
    );
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::ClaimRefund {
            bounty_id: cancelled,
        },
    )
    .unwrap();
    assert_eq!(response.messages.len(), 1);
    assert_wire_event(
        &response,
        "juno_voice_bounties.refund_claimed",
        &["bounty_id", "contributor", "amount", "fully_refunded"],
    );
    let duplicate = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::ClaimRefund {
            bounty_id: cancelled,
        },
    )
    .unwrap_err();
    assert_eq!(duplicate, ContractError::AlreadyClaimed);

    let expiring = create(&mut deps, &env, CREATOR, 120, 100);
    contribute(&mut deps, &env, expiring, ALICE, 30);
    let prohibited = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::CancelSoleFunded {
            bounty_id: expiring,
            reason: "try".into(),
        },
    )
    .unwrap_err();
    assert_eq!(prohibited, ContractError::InvalidState);
    let mut at_expiry = env.clone();
    at_expiry.block.time = env.block.time.plus_seconds(100);
    let response = execute(
        deps.as_mut(),
        at_expiry,
        message_info(&addr("anyone"), &[]),
        ExecuteMsg::Expire {
            bounty_id: expiring,
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.bounty_expired",
        &["bounty_id", "actor", "refundable"],
    );

    let moderated = create(&mut deps, &env, CREATOR, 80, 500);
    contribute(&mut deps, &env, moderated, ALICE, 20);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(AGENT), &[]),
        ExecuteMsg::Moderate {
            bounty_id: moderated,
            outcome: ModerationOutcome::Spam,
            reason: "Clear spam".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.bounty_moderated",
        &["bounty_id", "agent", "outcome", "reason", "refundable"],
    );
    let record = MODERATIONS.load(&deps.storage, moderated).unwrap();
    assert_eq!(record.outcome, ModerationOutcome::Spam);
    assert_eq!(
        ACCOUNTING.load(&deps.storage).unwrap().outstanding_refunds,
        Uint128::new(250)
    );
    assert_accounting_identity(&deps);
}

#[test]
fn pause_is_stop_only_for_agent_and_settlement_remains_live() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 500_000);
    contribute(&mut deps, &env, id, ALICE, 20);
    nominate(&mut deps, &env, id);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(AGENT), &[]),
        ExecuteMsg::PauseNewActivity {
            reason: "Safety stop".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.new_activity_paused",
        &["actor", "reason"],
    );
    let err = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(AGENT), &[]),
        ExecuteMsg::UnpauseNewActivity {
            reason: "agent cannot resume".into(),
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::Unauthorized);
    let err = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(BOB), &[coin(10, "ujuno")]),
        ExecuteMsg::Contribute { bounty_id: id },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::Paused);

    vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::Yes);
    let mut close = env.clone();
    close.block.time = env.block.time.plus_seconds(RATIFICATION_SECONDS);
    execute(
        deps.as_mut(),
        close,
        message_info(&addr("anyone"), &[]),
        ExecuteMsg::FinalizePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap();
    let response = execute(
        deps.as_mut(),
        env,
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UnpauseNewActivity {
            reason: "Governor recovery".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.new_activity_unpaused",
        &["governor", "reason"],
    );
    assert_accounting_identity(&deps);
}

#[test]
fn future_config_changes_do_not_mutate_live_bounty_limits_or_duration() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 500_000);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UpdateConfig {
            update: ConfigUpdate {
                min_contribution: Some(Uint128::new(50)),
                max_bounty_total: Some(Uint128::new(500)),
                min_lifetime_seconds: None,
                max_lifetime_seconds: None,
                max_contributors: Some(2),
                max_rounds: Some(2),
                limits: None,
            },
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.future_config_updated",
        &["governor", "config_version", "changed_at"],
    );
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UpdateRoles {
            governor: None,
            agent: Some(address("replacement-agent")),
            registry: None,
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.roles_updated",
        &[
            "actor",
            "governor",
            "agent",
            "registry",
            "config_version",
            "changed_at",
        ],
    );
    let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
    assert_eq!(bounty.terms.max_bounty_total, Uint128::new(10_000));
    assert_eq!(bounty.terms.max_contributors, 5);
    assert_eq!(bounty.terms.max_rounds, 5);
    assert_eq!(bounty.terms.ratification_seconds, RATIFICATION_SECONDS);
    contribute(&mut deps, &env, id, ALICE, 50);
    contribute(&mut deps, &env, id, BOB, 50);
    nominate(&mut deps, &env, id);
    assert_eq!(
        ROUNDS.load(&deps.storage, (id, 1)).unwrap().closes_at,
        Some(env.block.time.plus_seconds(RATIFICATION_SECONDS))
    );
}

#[test]
fn paid_project_candidate_graduates_once_through_configured_registry() {
    let (mut deps, env) = init();
    let mut msg = create_msg(env.block.time.plus_seconds(1_000));
    if let ExecuteMsg::CreateBounty {
        project_candidate, ..
    } = &mut msg
    {
        *project_candidate = Some(ProjectCandidate {
            project_id: "stable-project-1".into(),
            metadata_uri: "ipfs://bafyproject".into(),
            metadata_digest: digest('c'),
        });
    }
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[coin(100, "ujuno")]),
        msg,
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.bounty_created",
        &[
            "bounty_id",
            "creator",
            "amount",
            "expires_at",
            "project_candidate",
        ],
    );
    nominate(&mut deps, &env, 1);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CREATOR), &[]),
        ExecuteMsg::ConfirmSolePayout {
            bounty_id: 1,
            round: 1,
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "juno_voice_bounties.payout_completed",
        &["bounty_id", "round", "mode", "recipient", "amount"],
    );
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(AGENT), &[]),
        ExecuteMsg::GraduateProject { bounty_id: 1 },
    )
    .unwrap();
    assert_eq!(response.messages.len(), 1);
    assert_wire_event(
        &response,
        "juno_voice_bounties.project_graduated",
        &[
            "bounty_id",
            "agent",
            "registry",
            "project_id",
            "payout_address",
        ],
    );
    let record = GRADUATIONS.load(&deps.storage, 1).unwrap();
    assert_eq!(record.registry, addr(REGISTRY));
    assert_eq!(record.payout_address, addr(RECIPIENT));
    let err = execute(
        deps.as_mut(),
        env,
        message_info(&addr(AGENT), &[]),
        ExecuteMsg::GraduateProject { bounty_id: 1 },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::AlreadyGraduated);
}

#[test]
fn bounded_histories_and_indexes_preserve_insertion_order() {
    let (mut deps, env) = init();
    for who in [CREATOR, ALICE, BOB] {
        create(&mut deps, &env, who, 100, 1_000);
    }
    let ids: Vec<u64> = BOUNTIES
        .range(&deps.storage, None, None, cosmwasm_std::Order::Ascending)
        .map(|item| item.unwrap().0)
        .collect();
    assert_eq!(ids, vec![1, 2, 3]);

    contribute(&mut deps, &env, 1, ALICE, 10);
    contribute(&mut deps, &env, 1, BOB, 10);
    let actions: Vec<HistoryAction> = HISTORY
        .prefix(1)
        .range(&deps.storage, None, None, cosmwasm_std::Order::Ascending)
        .map(|item| item.unwrap().1.action)
        .collect();
    assert_eq!(
        actions,
        vec![
            HistoryAction::Created,
            HistoryAction::Contributed,
            HistoryAction::Contributed
        ]
    );
}

#[test]
fn claim_pagination_advances_across_unclaimed_contributor_holes() {
    let (mut deps, env) = init();
    let id = create(&mut deps, &env, CREATOR, 100, 1_000);
    contribute(&mut deps, &env, id, ALICE, 10);
    contribute(&mut deps, &env, id, BOB, 10);
    for (contributor, amount) in [(CREATOR, 100), (BOB, 10)] {
        CLAIMS
            .save(
                &mut deps.storage,
                (id, &addr(contributor)),
                &ClaimRecord {
                    bounty_id: id,
                    contributor: addr(contributor),
                    amount: Uint128::new(amount),
                    claimed_at: env.block.time,
                },
            )
            .unwrap();
    }

    let first: ClaimsResponse = from_json(
        query(
            deps.as_ref(),
            env.clone(),
            QueryMsg::Claims {
                bounty_id: id,
                start_after: None,
                limit: Some(2),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(first.claims.len(), 1);
    assert_eq!(first.claims[0].contributor, addr(CREATOR));
    assert_eq!(first.next_start_after, Some(2));

    let second: ClaimsResponse = from_json(
        query(
            deps.as_ref(),
            env,
            QueryMsg::Claims {
                bounty_id: id,
                start_after: first.next_start_after,
                limit: Some(2),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(second.claims.len(), 1);
    assert_eq!(second.claims[0].contributor, addr(BOB));
    assert_eq!(second.next_start_after, None);
}

#[test]
fn configured_contributor_and_round_limits_fail_without_partial_state() {
    let (mut deps, env) = init();
    CONFIG
        .update(
            &mut deps.storage,
            |mut config| -> Result<_, ContractError> {
                config.max_contributors = 2;
                config.max_rounds = 1;
                Ok(config)
            },
        )
        .unwrap();
    let id = create(&mut deps, &env, CREATOR, 100, 500_000);
    contribute(&mut deps, &env, id, ALICE, 100);
    let before = ACCOUNTING.load(&deps.storage).unwrap();
    let err = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(BOB), &[coin(10, "ujuno")]),
        ExecuteMsg::Contribute { bounty_id: id },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::ContributionLimit);
    assert_eq!(ACCOUNTING.load(&deps.storage).unwrap(), before);
    assert!(!CONTRIBUTIONS.has(&deps.storage, (id, &addr(BOB))));

    nominate(&mut deps, &env, id);
    vote(&mut deps, &env, id, 1, CREATOR, PayoutVote::No);
    let mut close = env.clone();
    close.block.time = env.block.time.plus_seconds(RATIFICATION_SECONDS);
    execute(
        deps.as_mut(),
        close,
        message_info(&addr("finalizer"), &[]),
        ExecuteMsg::FinalizePayout {
            bounty_id: id,
            round: 1,
        },
    )
    .unwrap();
    let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
    assert_eq!(bounty.status, BountyStatus::Refunding);
    assert_eq!(bounty.refund_reason, Some(RefundReason::RoundLimit));
    assert_accounting_identity(&deps);
}

proptest! {
    #[test]
    fn generated_contribution_and_ratification_sequences_preserve_single_disposition(
        creator_amount in 10u128..500,
        alice_amount in 10u128..500,
        creator_yes in any::<bool>(),
        alice_votes in prop::option::of(any::<bool>()),
        revise_creator in prop::option::of(any::<bool>()),
    ) {
        let (mut deps, env) = init();
        let id = create(&mut deps, &env, CREATOR, creator_amount, 500_000);
        assert_accounting_identity(&deps);
        contribute(&mut deps, &env, id, ALICE, alice_amount);
        assert_accounting_identity(&deps);
        nominate(&mut deps, &env, id);
        assert_accounting_identity(&deps);

        vote(
            &mut deps,
            &env,
            id,
            1,
            CREATOR,
            if creator_yes { PayoutVote::Yes } else { PayoutVote::No },
        );
        assert_accounting_identity(&deps);
        if let Some(alice_yes) = alice_votes {
            vote(
                &mut deps,
                &env,
                id,
                1,
                ALICE,
                if alice_yes { PayoutVote::Yes } else { PayoutVote::No },
            );
            assert_accounting_identity(&deps);
        }
        if let Some(revised_yes) = revise_creator {
            vote(
                &mut deps,
                &env,
                id,
                1,
                CREATOR,
                if revised_yes { PayoutVote::Yes } else { PayoutVote::No },
            );
            assert_accounting_identity(&deps);
        }

        let mut close = env.clone();
        close.block.time = env.block.time.plus_seconds(RATIFICATION_SECONDS);
        execute(
            deps.as_mut(),
            close,
            message_info(&addr("finalizer"), &[]),
            ExecuteMsg::FinalizePayout { bounty_id: id, round: 1 },
        ).unwrap();
        assert_accounting_identity(&deps);

        let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
        prop_assert!(
            (bounty.paid_amount == bounty.total_contribution && bounty.refunded_amount.is_zero())
            || (bounty.paid_amount.is_zero() && bounty.refunded_amount.is_zero())
        );
    }

    #[test]
    fn generated_valid_and_invalid_state_machine_actions_never_duplicate_value(
        actions in prop::collection::vec(0u8..12, 1..80)
    ) {
        let (mut deps, mut env) = init();
        let id = create(&mut deps, &env, CREATOR, 100, 900_000);
        contribute(&mut deps, &env, id, ALICE, 100);
        assert_accounting_identity(&deps);

        for action in actions {
            let accounting_before = ACCOUNTING.load(&deps.storage).unwrap();
            let bounty_before = BOUNTIES.load(&deps.storage, id).unwrap();
            let result = match action {
                0 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr(CREATOR), &[coin(10, "ujuno")]),
                    ExecuteMsg::Contribute { bounty_id: id },
                ),
                1 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr(CREATOR), &[]),
                    ExecuteMsg::NominatePayout {
                        bounty_id: id,
                        recipient: address(RECIPIENT),
                        evidence_uri: "ipfs://generated-evidence".into(),
                        evidence_digest: digest('d'),
                        rationale: "Generated nomination".into(),
                    },
                ),
                2 | 3 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr(CREATOR), &[]),
                    ExecuteMsg::VotePayout {
                        bounty_id: id,
                        round: bounty_before.active_round.unwrap_or(99),
                        vote: if action == 2 { PayoutVote::Yes } else { PayoutVote::No },
                        rationale: None,
                    },
                ),
                4 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr(ALICE), &[]),
                    ExecuteMsg::VotePayout {
                        bounty_id: id,
                        round: bounty_before.active_round.unwrap_or(99),
                        vote: PayoutVote::Yes,
                        rationale: None,
                    },
                ),
                5 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr("finalizer"), &[]),
                    ExecuteMsg::FinalizePayout {
                        bounty_id: id,
                        round: bounty_before.active_round.unwrap_or(99),
                    },
                ),
                6 => {
                    env.block.time = env.block.time.plus_seconds(RATIFICATION_SECONDS);
                    Ok(cosmwasm_std::Response::new())
                },
                7 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr("anyone"), &[]),
                    ExecuteMsg::Expire { bounty_id: id },
                ),
                8 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr(CREATOR), &[]),
                    ExecuteMsg::ClaimRefund { bounty_id: id },
                ),
                9 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr(ALICE), &[]),
                    ExecuteMsg::ClaimRefund { bounty_id: id },
                ),
                10 => execute(
                    deps.as_mut(), env.clone(), message_info(&addr(BOB), &[]),
                    ExecuteMsg::VotePayout {
                        bounty_id: id,
                        round: bounty_before.active_round.unwrap_or(99),
                        vote: PayoutVote::Yes,
                        rationale: None,
                    },
                ),
                _ => execute(
                    deps.as_mut(), env.clone(), message_info(&addr("finalizer"), &[coin(1, "ujuno")]),
                    ExecuteMsg::FinalizePayout {
                        bounty_id: id,
                        round: bounty_before.active_round.unwrap_or(99),
                    },
                ),
            };
            if result.is_err() {
                prop_assert_eq!(ACCOUNTING.load(&deps.storage).unwrap(), accounting_before);
                prop_assert_eq!(BOUNTIES.load(&deps.storage, id).unwrap(), bounty_before);
            }
            assert_accounting_identity(&deps);
        }

        let bounty = BOUNTIES.load(&deps.storage, id).unwrap();
        prop_assert!(bounty.paid_amount.is_zero() || bounty.refunded_amount.is_zero());
        prop_assert!(bounty.paid_amount + bounty.refunded_amount <= bounty.total_contribution);
    }
}
