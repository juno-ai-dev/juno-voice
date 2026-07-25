use cosmwasm_std::testing::{message_info, mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{
    coin, to_json_binary, to_json_string, Addr, ContractResult, Order, OwnedDeps, Storage,
    SystemResult, Uint128,
};

use crate::bindings::{JunoQuery, VotingPowerResponse};
use crate::contract::{execute, instantiate};
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg, RecoveryReason};
use crate::rank::rank_key;
use crate::state::{
    BondState, BondTotals, FutureRequestPolicy, ProtocolAction, RequestAction, RequestLimits,
    Status, VoteChoice, BOND_TOTALS, CONFIG, NEXT_PROTOCOL_ACTION_ID, NEXT_REQUEST_ACTION_ID,
    NEXT_STATUS_HISTORY_ID, PROTOCOL_ACTIONS, REQUESTS, REQUESTS_BY_STATUS, REQUEST_ACTIONS,
    STATUS_HISTORY, STATUS_RANK,
};

pub(crate) type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>;

pub(crate) fn setup() -> (TestDeps, Addr, Addr, Addr) {
    let api = MockApi::default();
    let governor = api.addr_make("governor");
    let steward = api.addr_make("steward");
    let verifier = api.addr_make("verifier");
    let querier = MockQuerier::new(&[]).with_custom_handler(|query| match query {
        JunoQuery::TotalVotingPowerAt { .. } | JunoQuery::VotingPowerAt { .. } => {
            SystemResult::Ok(ContractResult::Ok(
                to_json_binary(&VotingPowerResponse {
                    power: "100".into(),
                })
                .unwrap(),
            ))
        }
    });
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api,
        querier,
        custom_query_type: std::marker::PhantomData,
    };
    instantiate(
        deps.as_mut(),
        mock_env(),
        message_info(&Addr::unchecked("creator"), &[]),
        InstantiateMsg {
            governor: governor.to_string(),
            steward: steward.to_string(),
            verifier: verifier.to_string(),
            native_denom: "ujuno".into(),
            submission_bond: Uint128::new(10),
            voting_period_blocks: 10,
            quorum_bps: 50,
            support_bps: 5_001,
            work_inactivity_blocks: 20,
            request_limits: RequestLimits::default(),
            max_reason_bytes: 20,
            default_query_limit: 10,
            max_query_limit: 30,
            evidence_policy_version: 1,
        },
    )
    .unwrap();
    (deps, governor, steward, verifier)
}

pub(crate) fn run(
    deps: &mut TestDeps,
    sender: &Addr,
    msg: ExecuteMsg,
) -> Result<cosmwasm_std::Response, ContractError> {
    execute(deps.as_mut(), mock_env(), message_info(sender, &[]), msg)
}

pub(crate) fn submit(deps: &mut TestDeps, sender: &Addr, amount: u128) {
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(sender, &[coin(amount, "ujuno")]),
        ExecuteMsg::SubmitRequest {
            title: "title".into(),
            summary: "summary".into(),
            acceptance_criteria: "criteria".into(),
            category: "core".into(),
            detail_uri: None,
            detail_digest: None,
        },
    )
    .unwrap();
}

pub(crate) fn pause(deps: &mut TestDeps, governor: &Addr) {
    run(
        deps,
        governor,
        ExecuteMsg::PauseSubmissions {
            reason: "history".into(),
        },
    )
    .unwrap();
}

pub(crate) fn qualify(deps: &mut TestDeps, author: &Addr) {
    let voter = deps.api.addr_make("qualifying-voter");
    submit(deps, author, 10);
    run(
        deps,
        &voter,
        ExecuteMsg::CastVote {
            request_id: 1,
            choice: VoteChoice::Support,
        },
    )
    .unwrap();
    let mut env = mock_env();
    env.block.height += 10;
    execute(
        deps.as_mut(),
        env,
        message_info(&voter, &[]),
        ExecuteMsg::CloseRequest { request_id: 1 },
    )
    .unwrap();
}

pub(crate) fn storage_dump(storage: &dyn Storage) -> Vec<(Vec<u8>, Vec<u8>)> {
    storage.range(None, None, Order::Ascending).collect()
}

pub(crate) fn future_policy() -> FutureRequestPolicy {
    FutureRequestPolicy {
        submission_bond: Uint128::new(10),
        voting_period_blocks: 10,
        quorum_bps: 50,
        support_bps: 5_001,
        work_inactivity_blocks: 20,
        request_limits: RequestLimits::default(),
    }
}

#[test]
fn task8_execute_json_is_typed_and_canonical() {
    assert_eq!(
        to_json_string(&ExecuteMsg::EmergencyArchiveOpen {
            request_id: 7,
            reason: RecoveryReason::SnapshotHistoryRisk,
        })
        .unwrap(),
        r#"{"emergency_archive_open":{"request_id":7,"reason":"snapshot_history_risk"}}"#
    );
    assert_eq!(
        to_json_string(&ExecuteMsg::UpdateConfig {
            submission_bond: Some(Uint128::new(12)),
            voting_period_blocks: None,
            quorum_bps: None,
            support_bps: None,
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "policy".into(),
        })
        .unwrap(),
        r#"{"update_config":{"submission_bond":"12","voting_period_blocks":null,"quorum_bps":null,"support_bps":null,"work_inactivity_blocks":null,"request_limits":null,"reason":"policy"}}"#
    );
}

#[test]
fn every_new_dispatch_variant_rejects_funds_before_storage_reads() {
    let api = MockApi::default();
    let sender = api.addr_make("sender");
    let replacement = api.addr_make("replacement").to_string();
    let messages = vec![
        ExecuteMsg::PauseSubmissions { reason: "x".into() },
        ExecuteMsg::UnpauseSubmissions { reason: "x".into() },
        ExecuteMsg::EmergencyArchiveOpen {
            request_id: 1,
            reason: RecoveryReason::SnapshotHistoryRisk,
        },
        ExecuteMsg::UpdateConfig {
            submission_bond: Some(Uint128::new(1)),
            voting_period_blocks: None,
            quorum_bps: None,
            support_bps: None,
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "x".into(),
        },
        ExecuteMsg::ReplaceSteward {
            address: replacement.clone(),
            reason: "x".into(),
        },
        ExecuteMsg::ReplaceVerifier {
            address: replacement,
            reason: "x".into(),
        },
    ];
    for msg in messages {
        let mut deps = OwnedDeps {
            storage: MockStorage::default(),
            api: MockApi::default(),
            querier: MockQuerier::<JunoQuery>::new(&[]),
            custom_query_type: std::marker::PhantomData,
        };
        assert_eq!(
            execute(
                deps.as_mut(),
                mock_env(),
                message_info(&sender, &[coin(1, "ujuno")]),
                msg,
            )
            .unwrap_err(),
            ContractError::UnexpectedFunds
        );
    }
}

#[test]
fn pause_authority_reasons_noops_records_collision_and_counter_are_atomic() {
    let (mut deps, governor, steward, verifier) = setup();
    assert_eq!(
        run(
            &mut deps,
            &verifier,
            ExecuteMsg::PauseSubmissions {
                reason: "risk".into()
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    let response = run(
        &mut deps,
        &steward,
        ExecuteMsg::PauseSubmissions {
            reason: "  history risk  ".into(),
        },
    )
    .unwrap();
    assert_eq!(response.attributes[0].value, "pause_submissions");
    assert_eq!(response.attributes[1].value, "1");
    assert!(CONFIG.load(&deps.storage).unwrap().submissions_paused);
    let record = PROTOCOL_ACTIONS.load(&deps.storage, 1).unwrap();
    assert_eq!(record.id, 1);
    assert_eq!(record.actor, steward);
    assert_eq!(record.action, ProtocolAction::SubmissionsPaused);
    assert_eq!(record.reason.as_deref(), Some("history risk"));
    assert_eq!(record.height, mock_env().block.height);
    assert_eq!(record.timestamp, mock_env().block.time);
    assert_eq!(
        run(
            &mut deps,
            &steward,
            ExecuteMsg::PauseSubmissions {
                reason: "again".into()
            }
        )
        .unwrap_err(),
        ContractError::PauseStateUnchanged
    );
    assert_eq!(
        run(
            &mut deps,
            &steward,
            ExecuteMsg::UnpauseSubmissions {
                reason: "safe".into()
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    let response = run(
        &mut deps,
        &governor,
        ExecuteMsg::UnpauseSubmissions {
            reason: " safe ".into(),
        },
    )
    .unwrap();
    assert_eq!(response.attributes[0].value, "unpause_submissions");
    assert_eq!(response.attributes[1].value, "2");
    let record = PROTOCOL_ACTIONS.load(&deps.storage, 2).unwrap();
    assert_eq!(record.id, 2);
    assert_eq!(record.actor, governor);
    assert_eq!(record.action, ProtocolAction::SubmissionsUnpaused);
    assert_eq!(record.reason.as_deref(), Some("safe"));
    assert_eq!(record.height, mock_env().block.height);
    assert_eq!(record.timestamp, mock_env().block.time);
    assert_eq!(NEXT_PROTOCOL_ACTION_ID.load(&deps.storage).unwrap(), 3);
    assert!(!CONFIG.load(&deps.storage).unwrap().submissions_paused);

    for reason in [" ", "123456789012345678901"] {
        assert_eq!(
            run(
                &mut deps,
                &governor,
                ExecuteMsg::PauseSubmissions {
                    reason: reason.into()
                }
            )
            .unwrap_err(),
            ContractError::InvalidReason
        );
    }
    NEXT_PROTOCOL_ACTION_ID.save(&mut deps.storage, &1).unwrap();
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::PauseSubmissions {
                reason: "risk".into()
            }
        )
        .unwrap_err(),
        ContractError::AuditInvariant
    );
    assert!(!CONFIG.load(&deps.storage).unwrap().submissions_paused);
}

#[test]
fn config_updates_only_future_policy_and_role_replacements_preserve_pending_governor() {
    let (mut deps, governor, _, _) = setup();
    let author = deps.api.addr_make("author");
    submit(&mut deps, &author, 10);
    let old = REQUESTS.load(&deps.storage, 1).unwrap();
    let nominee = deps.api.addr_make("nominee");
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ProposeGovernor {
            address: nominee.to_string(),
            reason: "nominee".into(),
        },
    )
    .unwrap();
    let limits = RequestLimits {
        max_title_bytes: 121,
        ..RequestLimits::default()
    };
    run(
        &mut deps,
        &governor,
        ExecuteMsg::UpdateConfig {
            submission_bond: Some(Uint128::new(12)),
            voting_period_blocks: Some(11),
            quorum_bps: Some(51),
            support_bps: Some(5_002),
            work_inactivity_blocks: Some(21),
            request_limits: Some(limits.clone()),
            reason: " future policy ".into(),
        },
    )
    .unwrap();
    assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap(), old);
    submit(&mut deps, &author, 12);
    let next = REQUESTS.load(&deps.storage, 2).unwrap();
    assert_eq!(next.bond.amount, Uint128::new(12));
    assert_eq!(next.closes_height - next.opened_height, 11);
    assert_eq!(next.quorum_bps, 51);
    assert_eq!(next.support_bps, 5_002);
    assert_eq!(next.work_inactivity_blocks, 21);
    assert_eq!(next.limits, limits);
    assert_eq!(
        CONFIG.load(&deps.storage).unwrap().pending_governor,
        Some(nominee)
    );

    let new_steward = deps.api.addr_make("new-steward");
    let new_verifier = deps.api.addr_make("new-verifier");
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ReplaceSteward {
            address: new_steward.to_string(),
            reason: "rotate".into(),
        },
    )
    .unwrap();
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ReplaceVerifier {
            address: new_verifier.to_string(),
            reason: "rotate".into(),
        },
    )
    .unwrap();
    let config = CONFIG.load(&deps.storage).unwrap();
    assert_eq!(config.steward, new_steward);
    assert_eq!(config.verifier, new_verifier);
    assert!(config.pending_governor.is_some());
}

#[test]
fn config_update_rejects_empty_noop_invalid_values_overflow_and_bad_roles() {
    let (mut deps, governor, steward, verifier) = setup();
    let empty = ExecuteMsg::UpdateConfig {
        submission_bond: None,
        voting_period_blocks: None,
        quorum_bps: None,
        support_bps: None,
        work_inactivity_blocks: None,
        request_limits: None,
        reason: "policy".into(),
    };
    assert_eq!(
        run(&mut deps, &governor, empty).unwrap_err(),
        ContractError::ConfigUnchanged
    );
    for msg in [
        ExecuteMsg::UpdateConfig {
            submission_bond: Some(Uint128::zero()),
            voting_period_blocks: None,
            quorum_bps: None,
            support_bps: None,
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "policy".into(),
        },
        ExecuteMsg::UpdateConfig {
            submission_bond: None,
            voting_period_blocks: Some(0),
            quorum_bps: None,
            support_bps: None,
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "policy".into(),
        },
        ExecuteMsg::UpdateConfig {
            submission_bond: None,
            voting_period_blocks: None,
            quorum_bps: Some(0),
            support_bps: None,
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "policy".into(),
        },
    ] {
        assert!(run(&mut deps, &governor, msg).is_err());
    }
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::UpdateConfig {
                submission_bond: Some(Uint128::new(10)),
                voting_period_blocks: None,
                quorum_bps: None,
                support_bps: None,
                work_inactivity_blocks: None,
                request_limits: None,
                reason: "policy".into(),
            }
        )
        .unwrap_err(),
        ContractError::ConfigUnchanged
    );
    let config_before = CONFIG.load(&deps.storage).unwrap();
    let mut env = mock_env();
    env.block.height = u64::MAX;
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&governor, &[]),
            ExecuteMsg::UpdateConfig {
                submission_bond: Some(Uint128::new(11)),
                voting_period_blocks: None,
                quorum_bps: None,
                support_bps: None,
                work_inactivity_blocks: None,
                request_limits: None,
                reason: "policy".into(),
            }
        )
        .unwrap_err(),
        ContractError::CloseHeightOverflow
    );
    assert_eq!(CONFIG.load(&deps.storage).unwrap(), config_before);
    for (address, steward_role) in [(steward.to_string(), true), (verifier.to_string(), false)] {
        let msg = if steward_role {
            ExecuteMsg::ReplaceSteward {
                address,
                reason: "rotate".into(),
            }
        } else {
            ExecuteMsg::ReplaceVerifier {
                address,
                reason: "rotate".into(),
            }
        };
        assert_eq!(
            run(&mut deps, &governor, msg).unwrap_err(),
            ContractError::RoleUnchanged
        );
    }
}

#[test]
fn emergency_archive_is_typed_indexed_refundable_and_author_can_withdraw() {
    let (mut deps, governor, _, _) = setup();
    let author = deps.api.addr_make("author");
    submit(&mut deps, &author, 10);
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::EmergencyArchiveOpen {
                request_id: 1,
                reason: RecoveryReason::SnapshotHistoryRisk,
            }
        )
        .unwrap_err(),
        ContractError::SubmissionsNotPaused
    );
    run(
        &mut deps,
        &governor,
        ExecuteMsg::PauseSubmissions {
            reason: "history".into(),
        },
    )
    .unwrap();
    let response = run(
        &mut deps,
        &governor,
        ExecuteMsg::EmergencyArchiveOpen {
            request_id: 1,
            reason: RecoveryReason::SnapshotHistoryRisk,
        },
    )
    .unwrap();
    assert!(response.messages.is_empty());
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(request.status, Status::Archived);
    assert_eq!(request.bond.state, BondState::Refundable);
    assert!(!REQUESTS_BY_STATUS.has(&deps.storage, (Status::Open.code(), 1)));
    assert!(REQUESTS_BY_STATUS.has(&deps.storage, (Status::Archived.code(), 1)));
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap(),
        BondTotals {
            locked: Uint128::zero(),
            refundable: Uint128::new(10),
            forfeited: Uint128::zero(),
        }
    );
    assert_eq!(
        STATUS_HISTORY
            .load(&deps.storage, (1, 1))
            .unwrap()
            .reason
            .as_deref(),
        Some("snapshot_history_risk")
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (1, 3)).unwrap().action,
        RequestAction::EmergencyArchived {
            reason: RecoveryReason::SnapshotHistoryRisk
        }
    );
    deps.querier
        .bank
        .update_balance(mock_env().contract.address, vec![coin(10, "ujuno")]);
    let refund = run(
        &mut deps,
        &author,
        ExecuteMsg::WithdrawRefund { request_id: 1 },
    )
    .unwrap();
    assert_eq!(refund.messages.len(), 1);
    assert_eq!(
        REQUESTS.load(&deps.storage, 1).unwrap().bond.state,
        BondState::Claimed
    );
}

#[test]
fn emergency_archive_preflight_failures_leave_request_and_totals_unchanged() {
    let (mut deps, governor, _, _) = setup();
    let author = deps.api.addr_make("author");
    submit(&mut deps, &author, 10);
    run(
        &mut deps,
        &governor,
        ExecuteMsg::PauseSubmissions {
            reason: "history".into(),
        },
    )
    .unwrap();
    let before = REQUESTS.load(&deps.storage, 1).unwrap();
    let totals = BOND_TOTALS.load(&deps.storage).unwrap();
    let key = rank_key(Uint128::zero(), Uint128::zero(), 1);
    STATUS_RANK.remove(&mut deps.storage, (Status::Open.code(), key));
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::EmergencyArchiveOpen {
                request_id: 1,
                reason: RecoveryReason::SnapshotHistoryRisk,
            }
        )
        .unwrap_err(),
        ContractError::IndexInvariant
    );
    assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap(), before);
    assert_eq!(BOND_TOTALS.load(&deps.storage).unwrap(), totals);
    assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap(), 3);
    assert_eq!(NEXT_STATUS_HISTORY_ID.load(&deps.storage, 1).unwrap(), 1);
}

#[test]
fn pause_blocks_submission_only_and_snapshot_mismatch_remains_atomic() {
    let (mut deps, governor, _, _) = setup();
    let author = deps.api.addr_make("author");
    let voter = deps.api.addr_make("voter");
    submit(&mut deps, &author, 10);
    run(
        &mut deps,
        &governor,
        ExecuteMsg::PauseSubmissions {
            reason: "history".into(),
        },
    )
    .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &[coin(10, "ujuno")]),
            ExecuteMsg::SubmitRequest {
                title: "title".into(),
                summary: "summary".into(),
                acceptance_criteria: "criteria".into(),
                category: "core".into(),
                detail_uri: None,
                detail_digest: None,
            },
        )
        .unwrap_err(),
        ContractError::SubmissionsPaused
    );

    let before = REQUESTS.load(&deps.storage, 1).unwrap();
    let mut corrupt = before.clone();
    corrupt.total_power = Uint128::new(99);
    REQUESTS.save(&mut deps.storage, 1, &corrupt).unwrap();
    assert_eq!(
        run(
            &mut deps,
            &voter,
            ExecuteMsg::CastVote {
                request_id: 1,
                choice: VoteChoice::Support,
            },
        )
        .unwrap_err(),
        ContractError::SnapshotIntegrityMismatch
    );
    assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap(), corrupt);

    REQUESTS.save(&mut deps.storage, 1, &before).unwrap();
    run(
        &mut deps,
        &voter,
        ExecuteMsg::CastVote {
            request_id: 1,
            choice: VoteChoice::Support,
        },
    )
    .unwrap();
    let mut close_env = mock_env();
    close_env.block.height += 10;
    execute(
        deps.as_mut(),
        close_env,
        message_info(&voter, &[]),
        ExecuteMsg::CloseRequest { request_id: 1 },
    )
    .unwrap();
    assert_ne!(
        REQUESTS.load(&deps.storage, 1).unwrap().status,
        Status::Open
    );
}
