use std::sync::{Arc, Mutex};

use cosmwasm_std::testing::{message_info, mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{
    coin, from_json, to_json_binary, Addr, ContractResult, OwnedDeps, SystemError, SystemResult,
    Uint128,
};

use crate::bindings::{JunoQuery, VotingPowerResponse};
use crate::contract::{execute, instantiate};
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg};
use crate::state::{
    BondState, RequestAction, RequestLimits, Status, BOND_TOTALS, CONFIG, NEXT_EVIDENCE_ID,
    NEXT_REQUEST_ACTION_ID, NEXT_REQUEST_ID, NEXT_STATUS_HISTORY_ID, REQUESTS, REQUESTS_BY_AUTHOR,
    REQUESTS_BY_CATEGORY, REQUESTS_BY_STATUS, REQUEST_ACTIONS, STATUS_CATEGORY_RANK, STATUS_RANK,
};

type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>;
type SparseResolutions = Arc<Mutex<Vec<(i64, i64)>>>;

fn valid_instantiate_msg() -> InstantiateMsg {
    let api = MockApi::default();
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

fn submit_msg() -> ExecuteMsg {
    ExecuteMsg::SubmitRequest {
        title: "Title".into(),
        summary: "Summary".into(),
        acceptance_criteria: "Done when shipped".into(),
        category: "core-dev".into(),
        detail_uri: Some("https://example.com/brief".into()),
        detail_digest: Some(format!("sha256:{}", "a".repeat(64))),
    }
}

fn setup_with_power(power: &str) -> (TestDeps, Arc<Mutex<Vec<i64>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_query = Arc::clone(&seen);
    let power = power.to_owned();
    let mut querier = MockQuerier::<JunoQuery>::new(&[]);
    querier = querier.with_custom_handler(move |query| match query {
        JunoQuery::TotalVotingPowerAt { height } => {
            seen_query.lock().unwrap().push(*height);
            SystemResult::Ok(ContractResult::Ok(
                to_json_binary(&VotingPowerResponse {
                    power: power.clone(),
                })
                .unwrap(),
            ))
        }
        _ => SystemResult::Err(SystemError::UnsupportedRequest {
            kind: "unexpected custom query".into(),
        }),
    });
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier,
        custom_query_type: std::marker::PhantomData,
    };
    instantiate(
        deps.as_mut(),
        mock_env(),
        message_info(&Addr::unchecked("creator"), &[]),
        valid_instantiate_msg(),
    )
    .unwrap();
    (deps, seen)
}

fn setup_query_error() -> TestDeps {
    let querier = MockQuerier::<JunoQuery>::new(&[]).with_custom_handler(|_| {
        SystemResult::Ok(ContractResult::Err("snapshot unavailable".into()))
    });
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier,
        custom_query_type: std::marker::PhantomData,
    };
    instantiate(
        deps.as_mut(),
        mock_env(),
        message_info(&Addr::unchecked("creator"), &[]),
        valid_instantiate_msg(),
    )
    .unwrap();
    deps
}

fn setup_sparse_snapshots() -> (TestDeps, SparseResolutions) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_query = Arc::clone(&seen);
    let querier =
        MockQuerier::<JunoQuery>::new(&[]).with_custom_handler(move |query| match query {
            JunoQuery::TotalVotingPowerAt { height } => {
                let resolved = [(100_i64, "111"), (480_i64, "777")]
                    .into_iter()
                    .rev()
                    .find(|(snapshot, _)| snapshot <= height);
                match resolved {
                    Some((snapshot, power)) => {
                        seen_query.lock().unwrap().push((*height, snapshot));
                        SystemResult::Ok(ContractResult::Ok(
                            to_json_binary(&VotingPowerResponse {
                                power: power.into(),
                            })
                            .unwrap(),
                        ))
                    }
                    None => SystemResult::Ok(ContractResult::Err("snapshot unavailable".into())),
                }
            }
            _ => SystemResult::Err(SystemError::UnsupportedRequest {
                kind: "unexpected custom query".into(),
            }),
        });
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier,
        custom_query_type: std::marker::PhantomData,
    };
    instantiate(
        deps.as_mut(),
        mock_env(),
        message_info(&Addr::unchecked("creator"), &[]),
        valid_instantiate_msg(),
    )
    .unwrap();
    (deps, seen)
}

#[test]
fn submit_request_message_has_exact_public_shape() {
    let msg = submit_msg();
    let json = String::from_utf8(to_json_binary(&msg).unwrap().to_vec()).unwrap();
    assert_eq!(
        json,
        format!(
            "{{\"submit_request\":{{\"title\":\"Title\",\"summary\":\"Summary\",\"acceptance_criteria\":\"Done when shipped\",\"category\":\"core-dev\",\"detail_uri\":\"https://example.com/brief\",\"detail_digest\":\"sha256:{}\"}}}}",
            "a".repeat(64)
        )
    );
    let decoded: ExecuteMsg = from_json(json.as_bytes()).unwrap();
    assert_eq!(decoded, msg);
}

#[test]
fn submission_stores_complete_fixed_snapshot_request() {
    let (mut deps, seen) = setup_with_power("987654321");
    let mut env = mock_env();
    env.block.height = 500;
    let author = deps.api.addr_make("author");

    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&author, &[coin(10_000_000, "ujuno")]),
        submit_msg(),
    )
    .unwrap();

    assert!(response.messages.is_empty());
    assert_eq!(*seen.lock().unwrap(), vec![499]);
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(request.id, 1);
    assert_eq!(request.author, author);
    assert_eq!(request.title, "Title");
    assert_eq!(request.summary, "Summary");
    assert_eq!(request.acceptance_criteria, "Done when shipped");
    assert_eq!(request.category, "core-dev");
    assert_eq!(
        request.detail_uri.as_deref(),
        Some("https://example.com/brief")
    );
    let expected_digest = format!("sha256:{}", "a".repeat(64));
    assert_eq!(
        request.detail_digest.as_deref(),
        Some(expected_digest.as_str())
    );
    assert_eq!(request.snapshot_height, 499);
    assert_eq!(request.total_power, Uint128::new(987_654_321));
    assert_eq!((request.opened_height, request.closes_height), (500, 600));
    assert_eq!((request.quorum_bps, request.support_bps), (50, 5_001));
    assert_eq!(request.work_inactivity_blocks, 200);
    assert_eq!(request.limits, RequestLimits::default());
    assert_eq!(request.evidence_policy_version, 1);
    assert_eq!(request.status, Status::Open);
    assert_eq!(request.support_power, Uint128::zero());
    assert_eq!(request.oppose_power, Uint128::zero());
    assert_eq!(request.voter_count, 0);
    assert_eq!(request.bond.amount, Uint128::new(10_000_000));
    assert_eq!(request.bond.state, BondState::Locked);
    assert_eq!(request.builder, None);
    assert_eq!(request.work_round, 0);
    assert_eq!(request.work_activity_height, None);
    assert_eq!(request.created_at, env.block.time);
    assert_eq!(request.updated_at, env.block.time);
    assert_eq!(NEXT_REQUEST_ID.load(&deps.storage).unwrap(), 2);
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap().locked,
        Uint128::new(10_000_000)
    );
    assert_eq!(
        CONFIG.load(&deps.storage).unwrap().submission_bond,
        Uint128::new(10_000_000)
    );
    assert_eq!(response.attributes[0], ("action", "submit_request"));
}

#[test]
fn sparse_at_or_before_result_keeps_the_requested_snapshot_height() {
    let (mut deps, seen) = setup_sparse_snapshots();
    let mut env = mock_env();
    env.block.height = 500;
    let author = deps.api.addr_make("author");
    execute(
        deps.as_mut(),
        env,
        message_info(&author, &[coin(10_000_000, "ujuno")]),
        submit_msg(),
    )
    .unwrap();

    assert_eq!(*seen.lock().unwrap(), vec![(499, 480)]);
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(request.snapshot_height, 499);
    assert_eq!(request.total_power, Uint128::new(777));
}

#[test]
fn submission_pause_and_exact_funds_are_enforced_without_state_changes() {
    let invalid_funds = vec![
        vec![],
        vec![coin(10_000_000, "uatom")],
        vec![coin(9_999_999, "ujuno")],
        vec![coin(10_000_001, "ujuno")],
        vec![coin(10_000_000, "ujuno"), coin(1, "uatom")],
        vec![coin(10_000_000, "ujuno"), coin(1, "ujuno")],
    ];
    for funds in invalid_funds {
        let (mut deps, _) = setup_with_power("123");
        let author = deps.api.addr_make("author");
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &funds),
            submit_msg(),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::InvalidSubmissionFunds);
        assert!(REQUESTS.may_load(&deps.storage, 1).unwrap().is_none());
        assert_eq!(NEXT_REQUEST_ID.load(&deps.storage).unwrap(), 1);
        assert_eq!(
            BOND_TOTALS.load(&deps.storage).unwrap().locked,
            Uint128::zero()
        );
    }

    let (mut deps, seen) = setup_with_power("123");
    CONFIG
        .update(
            &mut deps.storage,
            |mut config| -> Result<_, ContractError> {
                config.submissions_paused = true;
                Ok(config)
            },
        )
        .unwrap();
    let author = deps.api.addr_make("author");
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&author, &[coin(10_000_000, "ujuno")]),
        submit_msg(),
    )
    .unwrap_err();
    assert_eq!(err, ContractError::SubmissionsPaused);
    assert!(seen.lock().unwrap().is_empty());
    assert!(REQUESTS.may_load(&deps.storage, 1).unwrap().is_none());

    let governor = CONFIG.load(&deps.storage).unwrap().governor;
    let nominee = deps.api.addr_make("new-governor").into_string();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&governor, &[]),
        ExecuteMsg::ProposeGovernor {
            address: nominee,
            reason: "rotation remains available".into(),
        },
    )
    .unwrap();
    assert!(CONFIG
        .load(&deps.storage)
        .unwrap()
        .pending_governor
        .is_some());
}

#[test]
fn inline_brief_and_paired_details_follow_canonical_byte_and_syntax_rules() {
    fn with_fields(
        title: String,
        summary: String,
        acceptance: String,
        category: String,
        uri: Option<String>,
        digest: Option<String>,
    ) -> ExecuteMsg {
        ExecuteMsg::SubmitRequest {
            title,
            summary,
            acceptance_criteria: acceptance,
            category,
            detail_uri: uri,
            detail_digest: digest,
        }
    }
    let digest = Some(format!("sha256:{}", "a".repeat(64)));
    let invalid = vec![
        with_fields("".into(), "s".into(), "a".into(), "cat".into(), None, None),
        with_fields(
            "   ".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            None,
            None,
        ),
        with_fields(
            "é".repeat(61),
            "s".into(),
            "a".into(),
            "cat".into(),
            None,
            None,
        ),
        with_fields("t".into(), " ".into(), "a".into(), "cat".into(), None, None),
        with_fields(
            "t".into(),
            "s".into(),
            "\n".into(),
            "cat".into(),
            None,
            None,
        ),
        with_fields(
            "t".into(),
            "s".repeat(2_001),
            "a".into(),
            "cat".into(),
            None,
            None,
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".repeat(4_001),
            "cat".into(),
            None,
            None,
        ),
        with_fields("t".into(), "s".into(), "a".into(), "".into(), None, None),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "Core".into(),
            None,
            None,
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "core_dev".into(),
            None,
            None,
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "a".repeat(33),
            None,
            None,
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            Some("https://x".into()),
            None,
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            None,
            digest.clone(),
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            Some("https://".into()),
            digest.clone(),
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            Some("http://x".into()),
            digest.clone(),
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            Some("x".repeat(513)),
            digest.clone(),
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            Some("ipfs://x".into()),
            Some(format!("sha256:{}", "A".repeat(64))),
        ),
        with_fields(
            "t".into(),
            "s".into(),
            "a".into(),
            "cat".into(),
            Some("ipfs://x".into()),
            Some(format!("sha256:{}", "a".repeat(63))),
        ),
    ];
    for msg in invalid {
        let (mut deps, seen) = setup_with_power("123");
        let author = deps.api.addr_make("author");
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &[coin(10_000_000, "ujuno")]),
            msg,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            ContractError::InvalidBrief { .. }
                | ContractError::InvalidCategory
                | ContractError::InvalidDetail
        ));
        assert!(seen.lock().unwrap().is_empty());
        assert!(REQUESTS.may_load(&deps.storage, 1).unwrap().is_none());
    }

    for uri in ["https://x", "ipfs://cid"] {
        let (mut deps, _) = setup_with_power("123");
        let author = deps.api.addr_make("author");
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &[coin(10_000_000, "ujuno")]),
            with_fields(
                " padded ".into(),
                " summary ".into(),
                " acceptance ".into(),
                "a-0".into(),
                Some(uri.into()),
                digest.clone(),
            ),
        )
        .unwrap();
        assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap().title, " padded ");
    }

    let (mut deps, _) = setup_with_power("123");
    let author = deps.api.addr_make("author-without-details");
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&author, &[coin(10_000_000, "ujuno")]),
        with_fields(
            "title".into(),
            "summary".into(),
            "acceptance".into(),
            "core".into(),
            None,
            None,
        ),
    )
    .unwrap();
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!((request.detail_uri, request.detail_digest), (None, None));
}

#[test]
fn submission_initializes_typed_audit_counters_and_all_canonical_indexes() {
    let (mut deps, _) = setup_with_power("777");
    let mut env = mock_env();
    env.block.height = 42;
    let author = deps.api.addr_make("author");
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&author, &[coin(10_000_000, "ujuno")]),
        submit_msg(),
    )
    .unwrap();

    assert_eq!(NEXT_EVIDENCE_ID.load(&deps.storage, 1).unwrap(), 1);
    assert_eq!(NEXT_STATUS_HISTORY_ID.load(&deps.storage, 1).unwrap(), 1);
    assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap(), 3);
    let submitted = REQUEST_ACTIONS.load(&deps.storage, (1, 1)).unwrap();
    assert_eq!(submitted.actor, author);
    assert_eq!(submitted.height, 42);
    assert_eq!(submitted.timestamp, env.block.time);
    assert_eq!(submitted.reason, None);
    assert_eq!(
        submitted.action,
        RequestAction::Submitted {
            snapshot_height: 41,
            total_power: Uint128::new(777),
        }
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (1, 2)).unwrap().action,
        RequestAction::BondTransition {
            from: None,
            to: BondState::Locked,
            amount: Uint128::new(10_000_000),
        }
    );

    assert!(REQUESTS_BY_STATUS.has(&deps.storage, (Status::Open.code(), 1)));
    assert!(REQUESTS_BY_CATEGORY.has(&deps.storage, ("core-dev", 1)));
    assert!(REQUESTS_BY_AUTHOR.has(&deps.storage, (&author, 1)));
    let mut rank_key = vec![1, 1];
    rank_key.extend([0; 16]);
    rank_key.extend([0; 16]);
    rank_key.extend((u64::MAX - 1).to_be_bytes());
    assert_eq!(rank_key.len(), 42);
    assert_eq!(
        STATUS_RANK
            .load(&deps.storage, (Status::Open.code(), rank_key.clone()))
            .unwrap(),
        1
    );
    assert_eq!(
        STATUS_CATEGORY_RANK
            .load(&deps.storage, (Status::Open.code(), "core-dev", rank_key),)
            .unwrap(),
        1
    );
}

#[test]
fn snapshot_power_and_checked_arithmetic_fail_atomically() {
    let bond = [coin(10_000_000, "ujuno")];
    for (power, expected) in [
        ("", ContractError::InvalidTotalVotingPower),
        ("-1", ContractError::InvalidTotalVotingPower),
        ("+1", ContractError::InvalidTotalVotingPower),
        (" 1", ContractError::InvalidTotalVotingPower),
        (
            "340282366920938463463374607431768211456",
            ContractError::InvalidTotalVotingPower,
        ),
        ("0", ContractError::InvalidTotalVotingPower),
    ] {
        let (mut deps, _) = setup_with_power(power);
        let author = deps.api.addr_make("author");
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &bond),
            submit_msg(),
        )
        .unwrap_err();
        assert_eq!(err, expected);
        assert!(REQUESTS.may_load(&deps.storage, 1).unwrap().is_none());
        assert_eq!(NEXT_REQUEST_ID.load(&deps.storage).unwrap(), 1);
    }

    let (mut deps, seen) = setup_with_power("1");
    let author = deps.api.addr_make("author");
    let mut env = mock_env();
    env.block.height = 0;
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&author, &bond),
            submit_msg()
        )
        .unwrap_err(),
        ContractError::InvalidSnapshotHeight
    );
    assert!(seen.lock().unwrap().is_empty());

    let (mut deps, seen) = setup_with_power("1");
    let author = deps.api.addr_make("author");
    let mut env = mock_env();
    env.block.height = (i64::MAX as u64) + 2;
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&author, &bond),
            submit_msg()
        )
        .unwrap_err(),
        ContractError::SnapshotHeightConversionOverflow
    );
    assert!(seen.lock().unwrap().is_empty());

    let (mut deps, _) = setup_with_power("1");
    NEXT_REQUEST_ID.save(&mut deps.storage, &u64::MAX).unwrap();
    let author = deps.api.addr_make("author");
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &bond),
            submit_msg()
        )
        .unwrap_err(),
        ContractError::RequestIdOverflow
    );
    assert!(REQUESTS
        .may_load(&deps.storage, u64::MAX)
        .unwrap()
        .is_none());

    let (mut deps, _) = setup_with_power("1");
    BOND_TOTALS
        .update(
            &mut deps.storage,
            |mut totals| -> Result<_, ContractError> {
                totals.locked = Uint128::MAX;
                Ok(totals)
            },
        )
        .unwrap();
    let author = deps.api.addr_make("author");
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &bond),
            submit_msg()
        )
        .unwrap_err(),
        ContractError::BondTotalOverflow
    );
    assert!(REQUESTS.may_load(&deps.storage, 1).unwrap().is_none());

    let (mut deps, _) = setup_with_power("1");
    CONFIG
        .update(
            &mut deps.storage,
            |mut config| -> Result<_, ContractError> {
                config.voting_period_blocks = u64::MAX;
                Ok(config)
            },
        )
        .unwrap();
    let author = deps.api.addr_make("author");
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &bond),
            submit_msg()
        )
        .unwrap_err(),
        ContractError::CloseHeightOverflow
    );
    assert!(REQUESTS.may_load(&deps.storage, 1).unwrap().is_none());
}

#[test]
fn successful_request_policy_and_close_are_immutable_after_config_changes() {
    let (mut deps, _) = setup_with_power("999");
    let author = deps.api.addr_make("author");
    let mut env = mock_env();
    env.block.height = 1_000;
    execute(
        deps.as_mut(),
        env,
        message_info(&author, &[coin(10_000_000, "ujuno")]),
        submit_msg(),
    )
    .unwrap();
    CONFIG
        .update(
            &mut deps.storage,
            |mut config| -> Result<_, ContractError> {
                config.submission_bond = Uint128::new(20_000_000);
                config.voting_period_blocks = 900;
                config.quorum_bps = 1_000;
                config.support_bps = 9_000;
                config.work_inactivity_blocks = 999;
                config.request_limits.max_title_bytes = 10;
                config.evidence_policy_version = 2;
                Ok(config)
            },
        )
        .unwrap();
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(request.closes_height, 1_100);
    assert_eq!((request.quorum_bps, request.support_bps), (50, 5_001));
    assert_eq!(request.work_inactivity_blocks, 200);
    assert_eq!(request.limits.max_title_bytes, 120);
    assert_eq!(request.evidence_policy_version, 1);
    assert_eq!(request.bond.amount, Uint128::new(10_000_000));
}

#[test]
fn snapshot_query_error_leaves_all_submission_state_unchanged() {
    let mut deps = setup_query_error();
    let author = deps.api.addr_make("author");
    let err = execute(
        deps.as_mut(),
        mock_env(),
        message_info(&author, &[coin(10_000_000, "ujuno")]),
        submit_msg(),
    )
    .unwrap_err();
    assert!(matches!(err, ContractError::Std(_)));
    assert!(REQUESTS.may_load(&deps.storage, 1).unwrap().is_none());
    assert_eq!(NEXT_REQUEST_ID.load(&deps.storage).unwrap(), 1);
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap().locked,
        Uint128::zero()
    );
    assert!(!REQUESTS_BY_STATUS.has(&deps.storage, (Status::Open.code(), 1)));
}
