use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use cosmwasm_std::testing::{message_info, mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{
    coin, from_json, to_json_binary, Addr, ContractResult, Env, OwnedDeps, SystemResult, Timestamp,
    Uint128,
};

use crate::bindings::{JunoQuery, VotingPowerResponse};
use crate::contract::{execute, instantiate};
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg};
use crate::rank::rank_key as production_rank_key;
use crate::state::{
    Bond, BondState, Config, Request, RequestLimits, Status, VoteChoice, CONFIG, REQUESTS,
    STATUS_CATEGORY_RANK, STATUS_RANK, VOTES,
};

type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>;

#[derive(Clone)]
struct QueryAnswers {
    total: Result<String, String>,
    voters: BTreeMap<String, Result<String, String>>,
}

fn valid_instantiate_msg(api: &MockApi) -> InstantiateMsg {
    InstantiateMsg {
        governor: api.addr_make("governor").into_string(),
        steward: api.addr_make("steward").into_string(),
        verifier: api.addr_make("verifier").into_string(),
        native_denom: "ujuno".into(),
        submission_bond: Uint128::new(10_000_000),
        voting_period_blocks: 100,
        quorum_bps: 50,
        support_bps: 5_001,
        work_inactivity_blocks: 200,
        request_limits: RequestLimits::default(),
        max_reason_bytes: 1_024,
        default_query_limit: 30,
        max_query_limit: 100,
        evidence_policy_version: 1,
    }
}

fn setup(
    total: Result<&str, &str>,
    voter_answers: Vec<(Addr, Result<&str, &str>)>,
) -> (TestDeps, Arc<Mutex<Vec<JunoQuery>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_query = Arc::clone(&seen);
    let answers = QueryAnswers {
        total: total.map(str::to_owned).map_err(str::to_owned),
        voters: voter_answers
            .into_iter()
            .map(|(address, answer)| {
                (
                    address.into_string(),
                    answer.map(str::to_owned).map_err(str::to_owned),
                )
            })
            .collect(),
    };
    let querier = MockQuerier::<JunoQuery>::new(&[]).with_custom_handler(move |query| {
        seen_query.lock().unwrap().push(query.clone());
        let answer = match query {
            JunoQuery::TotalVotingPowerAt { .. } => answers.total.clone(),
            JunoQuery::VotingPowerAt { address, .. } => answers
                .voters
                .get(address)
                .cloned()
                .unwrap_or_else(|| Err("unexpected voter address".into())),
        };
        match answer {
            Ok(power) => SystemResult::Ok(ContractResult::Ok(
                to_json_binary(&VotingPowerResponse { power }).unwrap(),
            )),
            Err(error) => SystemResult::Ok(ContractResult::Err(error)),
        }
    });
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier,
        custom_query_type: std::marker::PhantomData,
    };
    let instantiate_msg = valid_instantiate_msg(&deps.api);
    instantiate(
        deps.as_mut(),
        mock_env(),
        message_info(&Addr::unchecked("creator"), &[]),
        instantiate_msg,
    )
    .unwrap();
    (deps, seen)
}

fn voting_env() -> Env {
    let mut env = mock_env();
    env.block.height = 150;
    env.block.time = Timestamp::from_seconds(12_345);
    env
}

fn request(total_power: u128) -> Request {
    Request {
        id: 7,
        author: Addr::unchecked("author"),
        title: "Title".into(),
        summary: "Summary".into(),
        acceptance_criteria: "Done".into(),
        category: "core-dev".into(),
        detail_uri: None,
        detail_digest: None,
        canonical_request_id: None,
        snapshot_height: 99,
        total_power: Uint128::new(total_power),
        opened_height: 100,
        closes_height: 200,
        quorum_bps: 50,
        support_bps: 5_001,
        work_inactivity_blocks: 200,
        limits: RequestLimits::default(),
        evidence_policy_version: 1,
        status: Status::Open,
        support_power: Uint128::zero(),
        oppose_power: Uint128::zero(),
        voter_count: 0,
        bond: Bond {
            amount: Uint128::new(10_000_000),
            state: BondState::Locked,
        },
        builder: None,
        work_round: 0,
        work_activity_height: None,
        created_at: Timestamp::from_seconds(1_000),
        updated_at: Timestamp::from_seconds(1_000),
    }
}

fn rank_key(support: u128, oppose: u128, id: u64) -> Vec<u8> {
    let (sign, sortable_net) = if support >= oppose {
        (1, support - oppose)
    } else {
        (0, u128::MAX - (oppose - support))
    };
    let mut key = Vec::with_capacity(42);
    key.push(1);
    key.push(sign);
    key.extend_from_slice(&sortable_net.to_be_bytes());
    key.extend_from_slice(&support.to_be_bytes());
    key.extend_from_slice(&(u64::MAX - id).to_be_bytes());
    key
}

fn fixed_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = char::from(pair[0]).to_digit(16).unwrap();
            let low = char::from(pair[1]).to_digit(16).unwrap();
            u8::try_from((high << 4) | low).unwrap()
        })
        .collect()
}

#[test]
fn rank_key_has_frozen_encoding_and_descending_order_vectors() {
    let zero = production_rank_key(Uint128::zero(), Uint128::zero(), 7);
    let positive = production_rank_key(Uint128::new(5), Uint128::new(2), 7);
    let negative = production_rank_key(Uint128::new(2), Uint128::new(5), 7);

    assert_eq!(
        zero,
        fixed_hex(
            "01010000000000000000000000000000000000000000000000000000000000000000fffffffffffffff8"
        )
    );
    assert_eq!(
        positive,
        fixed_hex(
            "01010000000000000000000000000000000300000000000000000000000000000005fffffffffffffff8"
        )
    );
    assert_eq!(
        negative,
        fixed_hex(
            "0100fffffffffffffffffffffffffffffffc00000000000000000000000000000002fffffffffffffff8"
        )
    );
    assert_eq!(zero.len(), 42);
    assert!(positive > zero);
    assert!(zero > negative);

    let greater_support = production_rank_key(Uint128::new(10), Uint128::new(5), 7);
    let lesser_support = production_rank_key(Uint128::new(8), Uint128::new(3), 7);
    assert!(greater_support > lesser_support);

    let oldest = production_rank_key(Uint128::new(10), Uint128::new(5), 7);
    let newer = production_rank_key(Uint128::new(10), Uint128::new(5), 8);
    assert!(oldest > newer);
}

fn store_request(deps: &mut TestDeps, value: &Request) {
    REQUESTS.save(&mut deps.storage, value.id, value).unwrap();
    let key = rank_key(
        value.support_power.u128(),
        value.oppose_power.u128(),
        value.id,
    );
    STATUS_RANK
        .save(
            &mut deps.storage,
            (value.status.code(), key.clone()),
            &value.id,
        )
        .unwrap();
    STATUS_CATEGORY_RANK
        .save(
            &mut deps.storage,
            (value.status.code(), value.category.as_str(), key),
            &value.id,
        )
        .unwrap();
}

fn cast(request_id: u64, choice: VoteChoice) -> ExecuteMsg {
    ExecuteMsg::CastVote { request_id, choice }
}

fn assert_unchanged(deps: &TestDeps, before: &Request, voter: &Addr) {
    assert_eq!(REQUESTS.load(&deps.storage, before.id).unwrap(), *before);
    assert!(VOTES
        .may_load(&deps.storage, (before.id, voter))
        .unwrap()
        .is_none());
    let old_key = rank_key(
        before.support_power.u128(),
        before.oppose_power.u128(),
        before.id,
    );
    assert_eq!(
        STATUS_RANK
            .load(&deps.storage, (before.status.code(), old_key.clone()))
            .unwrap(),
        before.id
    );
    assert_eq!(
        STATUS_CATEGORY_RANK
            .load(
                &deps.storage,
                (before.status.code(), before.category.as_str(), old_key)
            )
            .unwrap(),
        before.id
    );
}

#[test]
fn cast_vote_message_has_exact_public_shape_and_wire_values() {
    let support = cast(7, VoteChoice::Support);
    let oppose = cast(8, VoteChoice::Oppose);

    assert_eq!(
        String::from_utf8(to_json_binary(&support).unwrap().to_vec()).unwrap(),
        r#"{"cast_vote":{"request_id":7,"choice":"support"}}"#
    );
    assert_eq!(
        String::from_utf8(to_json_binary(&oppose).unwrap().to_vec()).unwrap(),
        r#"{"cast_vote":{"request_id":8,"choice":"oppose"}}"#
    );
    assert_eq!(
        from_json::<ExecuteMsg>(br#"{"cast_vote":{"request_id":7,"choice":"support"}}"#).unwrap(),
        support
    );
}

#[test]
fn support_and_oppose_votes_use_exact_snapshot_queries_and_store_immutable_receipts() {
    let api = MockApi::default();
    let alice = api.addr_make("alice");
    let bob = api.addr_make("bob");
    let (mut deps, seen) = setup(
        Ok("1000"),
        vec![(alice.clone(), Ok("300")), (bob.clone(), Ok("200"))],
    );
    let before = request(1_000);
    store_request(&mut deps, &before);
    CONFIG
        .update(&mut deps.storage, |mut config: Config| {
            config.submissions_paused = true;
            Ok::<_, ContractError>(config)
        })
        .unwrap();
    let env = voting_env();

    let support_response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&alice, &[]),
        cast(7, VoteChoice::Support),
    )
    .unwrap();
    let oppose_response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&bob, &[]),
        cast(7, VoteChoice::Oppose),
    )
    .unwrap();

    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            JunoQuery::TotalVotingPowerAt { height: 99 },
            JunoQuery::VotingPowerAt {
                address: alice.to_string(),
                height: 99,
            },
            JunoQuery::TotalVotingPowerAt { height: 99 },
            JunoQuery::VotingPowerAt {
                address: bob.to_string(),
                height: 99,
            },
        ]
    );
    let updated = REQUESTS.load(&deps.storage, 7).unwrap();
    assert_eq!(updated.support_power, Uint128::new(300));
    assert_eq!(updated.oppose_power, Uint128::new(200));
    assert_eq!(updated.voter_count, 2);
    assert_eq!(updated.updated_at, env.block.time);
    assert_eq!(
        VOTES.load(&deps.storage, (7, &alice)).unwrap(),
        crate::state::VoteReceipt {
            request_id: 7,
            voter: alice.clone(),
            choice: VoteChoice::Support,
            power: Uint128::new(300),
            cast_height: 150,
        }
    );
    assert_eq!(
        VOTES.load(&deps.storage, (7, &bob)).unwrap(),
        crate::state::VoteReceipt {
            request_id: 7,
            voter: bob.clone(),
            choice: VoteChoice::Oppose,
            power: Uint128::new(200),
            cast_height: 150,
        }
    );
    assert!(support_response.messages.is_empty());
    assert!(oppose_response.messages.is_empty());
    assert_eq!(
        support_response.attributes,
        vec![
            ("action", "cast_vote"),
            ("request_id", "7"),
            ("choice", "support"),
        ]
    );

    let old_key = rank_key(0, 0, 7);
    let intermediate_key = rank_key(300, 0, 7);
    let new_key = rank_key(300, 200, 7);
    assert_eq!(new_key.len(), 42);
    assert!(STATUS_RANK
        .may_load(&deps.storage, (Status::Open.code(), old_key.clone()))
        .unwrap()
        .is_none());
    assert!(STATUS_RANK
        .may_load(
            &deps.storage,
            (Status::Open.code(), intermediate_key.clone())
        )
        .unwrap()
        .is_none());
    assert_eq!(
        STATUS_RANK
            .load(&deps.storage, (Status::Open.code(), new_key.clone()))
            .unwrap(),
        7
    );
    for key in [old_key, intermediate_key] {
        assert!(STATUS_CATEGORY_RANK
            .may_load(&deps.storage, (Status::Open.code(), "core-dev", key))
            .unwrap()
            .is_none());
    }
    assert_eq!(
        STATUS_CATEGORY_RANK
            .load(&deps.storage, (Status::Open.code(), "core-dev", new_key))
            .unwrap(),
        7
    );

    let receipt = VOTES.load(&deps.storage, (7, &alice)).unwrap();
    let query_count = seen.lock().unwrap().len();
    let err = execute(
        deps.as_mut(),
        env,
        message_info(&alice, &[]),
        cast(7, VoteChoice::Oppose),
    )
    .unwrap_err();
    assert_eq!(err, ContractError::DuplicateVote);
    assert_eq!(seen.lock().unwrap().len(), query_count);
    assert_eq!(VOTES.load(&deps.storage, (7, &alice)).unwrap(), receipt);
    assert_eq!(REQUESTS.load(&deps.storage, 7).unwrap(), updated);
}

#[test]
fn funds_unknown_status_and_end_exclusive_time_guards_run_before_queries_or_writes() {
    let api = MockApi::default();
    let voter = api.addr_make("voter");

    let (mut deps, seen) = setup(Ok("1000"), vec![(voter.clone(), Ok("50"))]);
    let err = execute(
        deps.as_mut(),
        voting_env(),
        message_info(&voter, &[coin(1, "ujuno")]),
        cast(7, VoteChoice::Support),
    )
    .unwrap_err();
    assert_eq!(err, ContractError::UnexpectedFunds);
    assert!(seen.lock().unwrap().is_empty());

    let err = execute(
        deps.as_mut(),
        voting_env(),
        message_info(&voter, &[]),
        cast(404, VoteChoice::Support),
    )
    .unwrap_err();
    assert_eq!(err, ContractError::UnknownRequest { request_id: 404 });
    assert!(seen.lock().unwrap().is_empty());

    for (status, height) in [
        (Status::Qualified, 150),
        (Status::Open, 99),
        (Status::Open, 200),
        (Status::Open, 201),
    ] {
        let (mut deps, seen) = setup(Ok("1000"), vec![(voter.clone(), Ok("50"))]);
        let mut before = request(1_000);
        before.status = status;
        store_request(&mut deps, &before);
        let mut env = voting_env();
        env.block.height = height;
        let err = execute(
            deps.as_mut(),
            env,
            message_info(&voter, &[]),
            cast(7, VoteChoice::Support),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::VotingNotOpen);
        assert!(seen.lock().unwrap().is_empty());
        assert_unchanged(&deps, &before, &voter);
    }
}

#[test]
fn invalid_total_power_and_integrity_mismatch_are_atomic_and_skip_voter_query() {
    let invalid = [
        ("", ContractError::InvalidTotalVotingPower),
        ("-1", ContractError::InvalidTotalVotingPower),
        ("+1", ContractError::InvalidTotalVotingPower),
        (" 1", ContractError::InvalidTotalVotingPower),
        ("1 ", ContractError::InvalidTotalVotingPower),
        (
            "340282366920938463463374607431768211456",
            ContractError::InvalidTotalVotingPower,
        ),
        ("0", ContractError::InvalidTotalVotingPower),
        ("999", ContractError::SnapshotIntegrityMismatch),
    ];
    let api = MockApi::default();
    let voter = api.addr_make("voter");
    for (power, expected) in invalid {
        let (mut deps, seen) = setup(Ok(power), vec![(voter.clone(), Ok("50"))]);
        let before = request(1_000);
        store_request(&mut deps, &before);
        let err = execute(
            deps.as_mut(),
            voting_env(),
            message_info(&voter, &[]),
            cast(7, VoteChoice::Support),
        )
        .unwrap_err();
        assert_eq!(err, expected, "power={power:?}");
        assert_eq!(
            *seen.lock().unwrap(),
            vec![JunoQuery::TotalVotingPowerAt { height: 99 }]
        );
        assert_unchanged(&deps, &before, &voter);
    }
}

#[test]
fn invalid_or_excess_voter_power_and_both_query_failures_are_atomic() {
    let invalid = [
        ("", ContractError::InvalidVotingPower),
        ("-1", ContractError::InvalidVotingPower),
        ("+1", ContractError::InvalidVotingPower),
        (" 1", ContractError::InvalidVotingPower),
        ("1 ", ContractError::InvalidVotingPower),
        (
            "340282366920938463463374607431768211456",
            ContractError::InvalidVotingPower,
        ),
        ("0", ContractError::InvalidVotingPower),
        ("1001", ContractError::VotingPowerExceedsTotal),
    ];
    let api = MockApi::default();
    let voter = api.addr_make("voter");
    for (power, expected) in invalid {
        let (mut deps, seen) = setup(Ok("1000"), vec![(voter.clone(), Ok(power))]);
        let before = request(1_000);
        store_request(&mut deps, &before);
        let err = execute(
            deps.as_mut(),
            voting_env(),
            message_info(&voter, &[]),
            cast(7, VoteChoice::Oppose),
        )
        .unwrap_err();
        assert_eq!(err, expected, "power={power:?}");
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert_unchanged(&deps, &before, &voter);
    }

    for (total, voter_answer, expected_queries) in [
        (Err("total unavailable"), Ok("50"), 1),
        (Ok("1000"), Err("voter unavailable"), 2),
    ] {
        let (mut deps, seen) = setup(total, vec![(voter.clone(), voter_answer)]);
        let before = request(1_000);
        store_request(&mut deps, &before);
        let err = execute(
            deps.as_mut(),
            voting_env(),
            message_info(&voter, &[]),
            cast(7, VoteChoice::Support),
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Std(_)));
        assert_eq!(seen.lock().unwrap().len(), expected_queries);
        assert_unchanged(&deps, &before, &voter);
    }
}

#[test]
fn snapshot_height_tally_and_voter_count_overflows_are_atomic() {
    let api = MockApi::default();
    let voter = api.addr_make("voter");

    let (mut deps, seen) = setup(Ok("1000"), vec![(voter.clone(), Ok("1"))]);
    let mut before = request(1_000);
    before.snapshot_height = (i64::MAX as u64) + 1;
    store_request(&mut deps, &before);
    let err = execute(
        deps.as_mut(),
        voting_env(),
        message_info(&voter, &[]),
        cast(7, VoteChoice::Support),
    )
    .unwrap_err();
    assert_eq!(err, ContractError::SnapshotHeightConversionOverflow);
    assert!(seen.lock().unwrap().is_empty());
    assert_unchanged(&deps, &before, &voter);

    for choice in [VoteChoice::Support, VoteChoice::Oppose] {
        let (mut deps, _) = setup(
            Ok("340282366920938463463374607431768211455"),
            vec![(voter.clone(), Ok("1"))],
        );
        let mut before = request(u128::MAX);
        match choice {
            VoteChoice::Support => before.support_power = Uint128::MAX,
            VoteChoice::Oppose => before.oppose_power = Uint128::MAX,
        }
        store_request(&mut deps, &before);
        let err = execute(
            deps.as_mut(),
            voting_env(),
            message_info(&voter, &[]),
            cast(7, choice),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::VoteTallyOverflow);
        assert_unchanged(&deps, &before, &voter);
    }

    let (mut deps, _) = setup(Ok("1000"), vec![(voter.clone(), Ok("1"))]);
    let mut before = request(1_000);
    before.voter_count = u64::MAX;
    store_request(&mut deps, &before);
    let err = execute(
        deps.as_mut(),
        voting_env(),
        message_info(&voter, &[]),
        cast(7, VoteChoice::Support),
    )
    .unwrap_err();
    assert_eq!(err, ContractError::VoterCountOverflow);
    assert_unchanged(&deps, &before, &voter);
}
