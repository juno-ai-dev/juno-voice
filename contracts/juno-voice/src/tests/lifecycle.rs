use cosmwasm_std::testing::{message_info, mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{coin, from_json, to_json_binary, Addr, OwnedDeps, Timestamp, Uint128};

use crate::bindings::JunoQuery;
use crate::contract::execute;
use crate::error::ContractError;
use crate::lifecycle::{allowed, Controller, Transition};
use crate::msg::ExecuteMsg;
use crate::rank::rank_key;
use crate::state::{
    Bond, BondState, BondTotals, Config, Request, RequestAction, RequestLimits, Status,
    BOND_TOTALS, CONFIG, DUPLICATE_REFERENCES, NEXT_REQUEST_ACTION_ID, NEXT_STATUS_HISTORY_ID,
    REQUESTS, REQUESTS_BY_AUTHOR, REQUESTS_BY_CATEGORY, REQUESTS_BY_STATUS, REQUEST_ACTIONS,
    STATUS_CATEGORY_RANK, STATUS_HISTORY, STATUS_RANK,
};

type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>;

#[test]
fn lifecycle_policy_is_the_exact_canonical_graph() {
    let statuses = [
        Status::Open,
        Status::Qualified,
        Status::NotPrioritized,
        Status::Duplicate,
        Status::Spam,
        Status::Building,
        Status::Review,
        Status::Blocked,
        Status::Archived,
        Status::Shipped,
    ];
    let transitions = [
        (
            Transition::CloseQualified,
            Status::Open,
            Status::Qualified,
            Controller::Public,
        ),
        (
            Transition::CloseNotPrioritized,
            Status::Open,
            Status::NotPrioritized,
            Controller::Public,
        ),
        (
            Transition::MarkSpam,
            Status::Open,
            Status::Spam,
            Controller::Steward,
        ),
        (
            Transition::MarkDuplicate,
            Status::Open,
            Status::Duplicate,
            Controller::Steward,
        ),
        (
            Transition::MarkDuplicate,
            Status::Qualified,
            Status::Duplicate,
            Controller::Steward,
        ),
        (
            Transition::StartBuilding,
            Status::Qualified,
            Status::Building,
            Controller::Steward,
        ),
        (
            Transition::Archive,
            Status::Qualified,
            Status::Archived,
            Controller::Steward,
        ),
        (
            Transition::Archive,
            Status::Blocked,
            Status::Archived,
            Controller::Steward,
        ),
        (
            Transition::RequestReview,
            Status::Building,
            Status::Review,
            Controller::Builder,
        ),
        (
            Transition::BlockBuilding,
            Status::Building,
            Status::Blocked,
            Controller::Builder,
        ),
        (
            Transition::BlockBuilding,
            Status::Building,
            Status::Blocked,
            Controller::Steward,
        ),
        (
            Transition::RejectReview,
            Status::Review,
            Status::Building,
            Controller::Verifier,
        ),
        (
            Transition::BlockReview,
            Status::Review,
            Status::Blocked,
            Controller::Verifier,
        ),
        (
            Transition::ResumeBuilding,
            Status::Blocked,
            Status::Building,
            Controller::Steward,
        ),
        (
            Transition::AttestShipment,
            Status::Review,
            Status::Shipped,
            Controller::Verifier,
        ),
    ];
    let kinds = [
        Transition::CloseQualified,
        Transition::CloseNotPrioritized,
        Transition::MarkSpam,
        Transition::MarkDuplicate,
        Transition::StartBuilding,
        Transition::Archive,
        Transition::RequestReview,
        Transition::BlockBuilding,
        Transition::RejectReview,
        Transition::BlockReview,
        Transition::ResumeBuilding,
        Transition::AttestShipment,
    ];
    let controllers = [
        Controller::Public,
        Controller::Steward,
        Controller::Builder,
        Controller::Verifier,
    ];
    for kind in kinds {
        for from in &statuses {
            for to in &statuses {
                for controller in controllers {
                    let expected =
                        transitions.contains(&(kind, from.clone(), to.clone(), controller));
                    assert_eq!(
                        allowed(kind, from, to, controller),
                        expected,
                        "{kind:?} {from:?}->{to:?} {controller:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn task_five_messages_have_exact_json_and_no_generic_status() {
    let cases = [
        (
            ExecuteMsg::CloseRequest { request_id: 1 },
            r#"{"close_request":{"request_id":1}}"#,
        ),
        (
            ExecuteMsg::MarkSpam {
                request_id: 1,
                reason: "x".into(),
            },
            r#"{"mark_spam":{"request_id":1,"reason":"x"}}"#,
        ),
        (
            ExecuteMsg::MarkDuplicate {
                request_id: 2,
                canonical_request_id: 1,
                reason: "x".into(),
            },
            r#"{"mark_duplicate":{"request_id":2,"canonical_request_id":1,"reason":"x"}}"#,
        ),
        (
            ExecuteMsg::ArchiveRequest {
                request_id: 1,
                reason: "x".into(),
            },
            r#"{"archive_request":{"request_id":1,"reason":"x"}}"#,
        ),
        (
            ExecuteMsg::StartBuilding {
                request_id: 1,
                builder: "b".into(),
                reason: "x".into(),
            },
            r#"{"start_building":{"request_id":1,"builder":"b","reason":"x"}}"#,
        ),
        (
            ExecuteMsg::BlockBuilding {
                request_id: 1,
                reason: "x".into(),
            },
            r#"{"block_building":{"request_id":1,"reason":"x"}}"#,
        ),
        (
            ExecuteMsg::ResumeBuilding {
                request_id: 1,
                builder: "b".into(),
                reason: "x".into(),
            },
            r#"{"resume_building":{"request_id":1,"builder":"b","reason":"x"}}"#,
        ),
        (
            ExecuteMsg::RejectReview {
                request_id: 1,
                reason: "x".into(),
            },
            r#"{"reject_review":{"request_id":1,"reason":"x"}}"#,
        ),
        (
            ExecuteMsg::BlockReview {
                request_id: 1,
                reason: "x".into(),
            },
            r#"{"block_review":{"request_id":1,"reason":"x"}}"#,
        ),
    ];
    for (msg, json) in cases {
        assert_eq!(
            String::from_utf8(to_json_binary(&msg).unwrap().to_vec()).unwrap(),
            json
        );
        assert_eq!(from_json::<ExecuteMsg>(json.as_bytes()).unwrap(), msg);
    }
    assert!(
        from_json::<ExecuteMsg>(br#"{"set_status":{"request_id":1,"status":"shipped"}}"#).is_err()
    );
}

#[test]
fn qualification_uses_wide_checked_boundary_math() {
    use crate::execute::close_request::qualifies;

    assert!(!qualifies(Uint128::zero(), Uint128::zero(), Uint128::MAX, 1, 1).unwrap());
    assert!(qualifies(Uint128::MAX, Uint128::zero(), Uint128::MAX, 10_000, 10_000).unwrap());
    assert!(qualifies(
        Uint128::new(51),
        Uint128::new(49),
        Uint128::new(1_000),
        1_000,
        5_001
    )
    .unwrap());
    assert!(!qualifies(
        Uint128::new(50),
        Uint128::new(50),
        Uint128::new(1_000),
        1_000,
        5_001
    )
    .unwrap());
    assert!(qualifies(
        Uint128::new(50),
        Uint128::new(50),
        Uint128::new(1_000),
        1_000,
        5_000
    )
    .unwrap());
    assert_eq!(
        qualifies(Uint128::MAX, Uint128::new(1), Uint128::MAX, 1, 1).unwrap_err(),
        ContractError::AggregateInvariant
    );
    for (total, quorum, support) in [
        (Uint128::zero(), 1, 1),
        (Uint128::new(1), 0, 1),
        (Uint128::new(1), 1, 10_001),
    ] {
        assert_eq!(
            qualifies(Uint128::zero(), Uint128::zero(), total, quorum, support).unwrap_err(),
            ContractError::AggregateInvariant
        );
    }
}

fn setup() -> (TestDeps, Addr, Addr, Addr) {
    let api = MockApi::default();
    let steward = api.addr_make("steward");
    let verifier = api.addr_make("verifier");
    let builder = api.addr_make("builder");
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api,
        querier: MockQuerier::<JunoQuery>::new(&[]),
        custom_query_type: std::marker::PhantomData,
    };
    CONFIG
        .save(
            &mut deps.storage,
            &Config {
                governor: deps.api.addr_make("governor"),
                pending_governor: None,
                steward: steward.clone(),
                verifier: verifier.clone(),
                native_denom: "ujuno".into(),
                submission_bond: Uint128::new(10),
                voting_period_blocks: 10,
                quorum_bps: 1_000,
                support_bps: 5_001,
                work_inactivity_blocks: 5,
                request_limits: RequestLimits::default(),
                max_reason_bytes: 20,
                default_query_limit: 30,
                max_query_limit: 100,
                evidence_policy_version: 1,
                submissions_paused: false,
            },
        )
        .unwrap();
    BOND_TOTALS
        .save(&mut deps.storage, &BondTotals::default())
        .unwrap();
    (deps, steward, verifier, builder)
}

fn sample_request(id: u64, status: Status, bond_state: BondState) -> Request {
    Request {
        id,
        author: Addr::unchecked(format!("author{id}")),
        title: "Title".into(),
        summary: "Summary".into(),
        acceptance_criteria: "Done".into(),
        category: "core".into(),
        detail_uri: None,
        detail_digest: None,
        canonical_request_id: None,
        snapshot_height: 1,
        total_power: Uint128::new(1_000),
        opened_height: 2,
        closes_height: 10,
        quorum_bps: 1_000,
        support_bps: 5_001,
        work_inactivity_blocks: 5,
        limits: RequestLimits::default(),
        evidence_policy_version: 1,
        status,
        support_power: Uint128::new(51),
        oppose_power: Uint128::new(49),
        voter_count: 2,
        bond: Bond {
            amount: Uint128::new(10),
            state: bond_state,
        },
        builder: None,
        work_round: 0,
        work_activity_height: None,
        created_at: Timestamp::from_seconds(1),
        updated_at: Timestamp::from_seconds(1),
    }
}

fn store_request(deps: &mut TestDeps, request: &Request) {
    REQUESTS
        .save(&mut deps.storage, request.id, request)
        .unwrap();
    NEXT_REQUEST_ACTION_ID
        .save(&mut deps.storage, request.id, &3)
        .unwrap();
    NEXT_STATUS_HISTORY_ID
        .save(&mut deps.storage, request.id, &1)
        .unwrap();
    REQUESTS_BY_STATUS
        .save(&mut deps.storage, (request.status.code(), request.id), &())
        .unwrap();
    let key = rank_key(request.support_power, request.oppose_power, request.id);
    STATUS_RANK
        .save(
            &mut deps.storage,
            (request.status.code(), key.clone()),
            &request.id,
        )
        .unwrap();
    STATUS_CATEGORY_RANK
        .save(
            &mut deps.storage,
            (request.status.code(), request.category.as_str(), key),
            &request.id,
        )
        .unwrap();
}

#[test]
fn close_is_end_inclusive_refunds_and_replaces_all_status_indexes() {
    let (mut deps, _, _, _) = setup();
    let request = sample_request(1, Status::Open, BondState::Locked);
    store_request(&mut deps, &request);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(10),
                refundable: Uint128::zero(),
                forfeited: Uint128::zero(),
            },
        )
        .unwrap();
    let mut env = mock_env();
    env.block.height = 9;
    let caller = deps.api.addr_make("caller");
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&caller, &[]),
            ExecuteMsg::CloseRequest { request_id: 1 },
        )
        .unwrap_err(),
        ContractError::RequestNotClosed
    );
    env.block.height = 10;
    execute(
        deps.as_mut(),
        env,
        message_info(&caller, &[]),
        ExecuteMsg::CloseRequest { request_id: 1 },
    )
    .unwrap();
    let closed = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(closed.status, Status::Qualified);
    assert_eq!(closed.bond.state, BondState::Refundable);
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap(),
        BondTotals {
            locked: Uint128::zero(),
            refundable: Uint128::new(10),
            forfeited: Uint128::zero(),
        }
    );
    assert!(REQUESTS_BY_STATUS
        .may_load(&deps.storage, (Status::Open.code(), 1))
        .unwrap()
        .is_none());
    assert!(REQUESTS_BY_STATUS
        .may_load(&deps.storage, (Status::Qualified.code(), 1))
        .unwrap()
        .is_some());
}

#[test]
fn duplicate_reverse_reference_prevents_spam_and_refunds_only_once() {
    let (mut deps, steward, _, _) = setup();
    let target = sample_request(1, Status::Open, BondState::Locked);
    let source = sample_request(2, Status::Open, BondState::Locked);
    store_request(&mut deps, &target);
    store_request(&mut deps, &source);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(20),
                refundable: Uint128::zero(),
                forfeited: Uint128::zero(),
            },
        )
        .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&steward, &[]),
        ExecuteMsg::MarkDuplicate {
            request_id: 2,
            canonical_request_id: 1,
            reason: "same".into(),
        },
    )
    .unwrap();
    assert_eq!(
        REQUESTS
            .load(&deps.storage, 2)
            .unwrap()
            .canonical_request_id,
        Some(1)
    );
    assert!(DUPLICATE_REFERENCES
        .may_load(&deps.storage, (1, 2))
        .unwrap()
        .is_some());
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::MarkSpam {
                request_id: 1,
                reason: "spam".into(),
            },
        )
        .unwrap_err(),
        ContractError::DuplicateTargetReferenced
    );
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap().locked,
        Uint128::new(10)
    );
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap().refundable,
        Uint128::new(10)
    );
}

#[test]
fn assignment_block_and_same_builder_resume_increment_round_and_reset_activity() {
    let (mut deps, steward, _, builder) = setup();
    let request = sample_request(1, Status::Qualified, BondState::Refundable);
    store_request(&mut deps, &request);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::zero(),
                refundable: Uint128::new(10),
                forfeited: Uint128::zero(),
            },
        )
        .unwrap();
    let mut env = mock_env();
    env.block.height = 20;
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&steward, &[]),
        ExecuteMsg::StartBuilding {
            request_id: 1,
            builder: builder.to_string(),
            reason: "start".into(),
        },
    )
    .unwrap();
    let building = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(
        (building.work_round, building.work_activity_height),
        (1, Some(20))
    );
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&builder, &[]),
        ExecuteMsg::BlockBuilding {
            request_id: 1,
            reason: "blocked".into(),
        },
    )
    .unwrap();
    env.block.height = 21;
    execute(
        deps.as_mut(),
        env,
        message_info(&steward, &[]),
        ExecuteMsg::ResumeBuilding {
            request_id: 1,
            builder: builder.to_string(),
            reason: "resume".into(),
        },
    )
    .unwrap();
    let resumed = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(resumed.builder, Some(builder));
    assert_eq!(
        (resumed.work_round, resumed.work_activity_height),
        (2, Some(21))
    );
}

#[test]
fn every_lifecycle_execute_rejects_funds_before_handler_work() {
    let (mut deps, steward, _, builder) = setup();
    let messages = vec![
        ExecuteMsg::CloseRequest { request_id: 99 },
        ExecuteMsg::MarkSpam {
            request_id: 99,
            reason: "x".into(),
        },
        ExecuteMsg::MarkDuplicate {
            request_id: 99,
            canonical_request_id: 1,
            reason: "x".into(),
        },
        ExecuteMsg::ArchiveRequest {
            request_id: 99,
            reason: "x".into(),
        },
        ExecuteMsg::StartBuilding {
            request_id: 99,
            builder: builder.to_string(),
            reason: "x".into(),
        },
        ExecuteMsg::BlockBuilding {
            request_id: 99,
            reason: "x".into(),
        },
        ExecuteMsg::ResumeBuilding {
            request_id: 99,
            builder: builder.to_string(),
            reason: "x".into(),
        },
        ExecuteMsg::RejectReview {
            request_id: 99,
            reason: "x".into(),
        },
        ExecuteMsg::BlockReview {
            request_id: 99,
            reason: "x".into(),
        },
    ];
    for msg in messages {
        assert_eq!(
            execute(
                deps.as_mut(),
                mock_env(),
                message_info(&steward, &[coin(1, "ujuno")]),
                msg
            )
            .unwrap_err(),
            ContractError::UnexpectedFunds
        );
    }
}

#[test]
fn moderation_validates_authority_status_and_original_reason_bytes() {
    let (mut deps, steward, _, _) = setup();
    let outsider = deps.api.addr_make("outsider");
    let request = sample_request(1, Status::Open, BondState::Locked);
    store_request(&mut deps, &request);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(10),
                refundable: Uint128::zero(),
                forfeited: Uint128::zero(),
            },
        )
        .unwrap();

    let spam = |reason: String| ExecuteMsg::MarkSpam {
        request_id: 1,
        reason,
    };
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&outsider, &[]),
            spam("x".into())
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            spam("   ".into())
        )
        .unwrap_err(),
        ContractError::InvalidReason
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            spam("é".repeat(11))
        )
        .unwrap_err(),
        ContractError::InvalidReason
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::MarkSpam {
                request_id: 404,
                reason: "x".into()
            }
        )
        .unwrap_err(),
        ContractError::UnknownRequest { request_id: 404 }
    );

    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&steward, &[]),
        spam("  abuse  ".into()),
    )
    .unwrap();
    let record = REQUEST_ACTIONS.load(&deps.storage, (1, 3)).unwrap();
    assert_eq!(record.reason.as_deref(), Some("abuse"));
    assert_eq!(
        record.action,
        RequestAction::StatusTransition {
            from: Status::Open,
            to: Status::Spam
        }
    );
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap(),
        BondTotals {
            locked: Uint128::zero(),
            refundable: Uint128::zero(),
            forfeited: Uint128::new(10)
        }
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            spam("again".into())
        )
        .unwrap_err(),
        ContractError::InvalidStatusTransition
    );
}

#[test]
fn close_records_exact_audit_and_preserves_direct_indexes() {
    let (mut deps, _, _, _) = setup();
    let request = sample_request(7, Status::Open, BondState::Locked);
    store_request(&mut deps, &request);
    REQUESTS_BY_CATEGORY
        .save(
            &mut deps.storage,
            (request.category.as_str(), request.id),
            &(),
        )
        .unwrap();
    REQUESTS_BY_AUTHOR
        .save(&mut deps.storage, (&request.author, request.id), &())
        .unwrap();
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(10),
                refundable: Uint128::zero(),
                forfeited: Uint128::zero(),
            },
        )
        .unwrap();
    let actor = deps.api.addr_make("closer");
    let mut env = mock_env();
    env.block.height = 11;
    env.block.time = Timestamp::from_seconds(88);
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&actor, &[]),
        ExecuteMsg::CloseRequest { request_id: 7 },
    )
    .unwrap();

    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (7, 3)).unwrap().action,
        RequestAction::Finalized { qualified: true }
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (7, 4)).unwrap().action,
        RequestAction::StatusTransition {
            from: Status::Open,
            to: Status::Qualified
        }
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (7, 5)).unwrap().action,
        RequestAction::BondTransition {
            from: Some(BondState::Locked),
            to: BondState::Refundable,
            amount: Uint128::new(10)
        }
    );
    let history = STATUS_HISTORY.load(&deps.storage, (7, 1)).unwrap();
    assert_eq!(
        (
            history.actor,
            history.from,
            history.to,
            history.reason,
            history.evidence_ids,
            history.height,
            history.timestamp
        ),
        (
            actor,
            Status::Open,
            Status::Qualified,
            None,
            vec![],
            11,
            env.block.time
        )
    );
    assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 7).unwrap(), 6);
    assert_eq!(NEXT_STATUS_HISTORY_ID.load(&deps.storage, 7).unwrap(), 2);
    assert!(REQUESTS_BY_CATEGORY.has(&deps.storage, (request.category.as_str(), 7)));
    assert!(REQUESTS_BY_AUTHOR.has(&deps.storage, (&request.author, 7)));
}

#[test]
fn close_handles_both_outcomes_and_rejects_corrupt_aggregates_and_bonds() {
    for (id, support, oppose, expected) in [
        (1, 0, 0, Status::NotPrioritized),
        (2, 50, 50, Status::NotPrioritized),
        (3, 51, 49, Status::Qualified),
    ] {
        let (mut deps, _, _, _) = setup();
        let mut request = sample_request(id, Status::Open, BondState::Locked);
        request.support_power = Uint128::new(support);
        request.oppose_power = Uint128::new(oppose);
        store_request(&mut deps, &request);
        BOND_TOTALS
            .save(
                &mut deps.storage,
                &BondTotals {
                    locked: Uint128::new(10),
                    refundable: Uint128::zero(),
                    forfeited: Uint128::zero(),
                },
            )
            .unwrap();
        let mut env = mock_env();
        env.block.height = if id == 1 { 10 } else { 12 };
        let caller = deps.api.addr_make("caller");
        execute(
            deps.as_mut(),
            env,
            message_info(&caller, &[]),
            ExecuteMsg::CloseRequest { request_id: id },
        )
        .unwrap();
        assert_eq!(REQUESTS.load(&deps.storage, id).unwrap().status, expected);
    }

    let (mut deps, _, _, _) = setup();
    let mut request = sample_request(8, Status::Open, BondState::Locked);
    request.support_power = Uint128::new(900);
    request.oppose_power = Uint128::new(200);
    store_request(&mut deps, &request);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(10),
                refundable: Uint128::zero(),
                forfeited: Uint128::zero(),
            },
        )
        .unwrap();
    let caller = deps.api.addr_make("caller");
    let before = REQUESTS.load(&deps.storage, 8).unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&caller, &[]),
            ExecuteMsg::CloseRequest { request_id: 8 }
        )
        .unwrap_err(),
        ContractError::AggregateInvariant
    );
    assert_eq!(REQUESTS.load(&deps.storage, 8).unwrap(), before);

    request.support_power = Uint128::new(51);
    request.oppose_power = Uint128::new(49);
    REQUESTS.save(&mut deps.storage, 8, &request).unwrap();
    BOND_TOTALS
        .save(&mut deps.storage, &BondTotals::default())
        .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&caller, &[]),
            ExecuteMsg::CloseRequest { request_id: 8 }
        )
        .unwrap_err(),
        ContractError::BondInvariant
    );
}

fn set_bond_totals(deps: &mut TestDeps, locked: u128, refundable: u128, forfeited: u128) {
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(locked),
                refundable: Uint128::new(refundable),
                forfeited: Uint128::new(forfeited),
            },
        )
        .unwrap();
}

#[test]
fn duplicate_enforces_target_graph_and_refundable_no_change_path() {
    let (mut deps, steward, _, _) = setup();
    for id in 1..=4 {
        let state = if id == 1 {
            BondState::Refundable
        } else {
            BondState::Locked
        };
        store_request(&mut deps, &sample_request(id, Status::Open, state));
    }
    let mut spam_target = sample_request(5, Status::Spam, BondState::Forfeited);
    spam_target.id = 5;
    store_request(&mut deps, &spam_target);
    set_bond_totals(&mut deps, 30, 10, 10);

    let duplicate = |source, target| ExecuteMsg::MarkDuplicate {
        request_id: source,
        canonical_request_id: target,
        reason: "same".into(),
    };
    for (source, target) in [(2, 2), (2, 3), (2, 99), (5, 1)] {
        let expected = if source == 5 {
            ContractError::InvalidStatusTransition
        } else {
            ContractError::InvalidDuplicateTarget
        };
        assert_eq!(
            execute(
                deps.as_mut(),
                mock_env(),
                message_info(&steward, &[]),
                duplicate(source, target)
            )
            .unwrap_err(),
            expected
        );
    }
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            duplicate(4, 5)
        )
        .unwrap_err(),
        ContractError::InvalidDuplicateTarget
    );

    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&steward, &[]),
        duplicate(3, 2),
    )
    .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            duplicate(2, 1)
        )
        .unwrap_err(),
        ContractError::DuplicateTargetReferenced
    );
    assert_eq!(
        REQUESTS
            .load(&deps.storage, 3)
            .unwrap()
            .canonical_request_id,
        Some(2)
    );
    assert!(DUPLICATE_REFERENCES.has(&deps.storage, (2, 3)));

    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&steward, &[]),
        duplicate(2, 1),
    )
    .unwrap_err();
    let before_counter = NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&steward, &[]),
        ExecuteMsg::MarkDuplicate {
            request_id: 1,
            canonical_request_id: 0,
            reason: "x".into(),
        },
    )
    .unwrap_err();
    assert_eq!(
        NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap(),
        before_counter
    );
}

#[test]
fn archive_is_not_an_open_escape_and_preserves_refundable_bond() {
    let (mut deps, steward, _, _) = setup();
    let open = sample_request(1, Status::Open, BondState::Locked);
    let qualified = sample_request(2, Status::Qualified, BondState::Refundable);
    store_request(&mut deps, &open);
    store_request(&mut deps, &qualified);
    set_bond_totals(&mut deps, 10, 10, 0);
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::ArchiveRequest {
                request_id: 1,
                reason: "x".into()
            }
        )
        .unwrap_err(),
        ContractError::InvalidStatusTransition
    );
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&steward, &[]),
        ExecuteMsg::ArchiveRequest {
            request_id: 2,
            reason: "done".into(),
        },
    )
    .unwrap();
    assert_eq!(
        REQUESTS.load(&deps.storage, 2).unwrap().status,
        Status::Archived
    );
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap().refundable,
        Uint128::new(10)
    );
    assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 2).unwrap(), 4);
}

#[test]
fn building_guards_deadlines_rounds_and_review_reentry() {
    let (mut deps, steward, verifier, builder) = setup();
    let outsider = deps.api.addr_make("outsider");
    let mut request = sample_request(1, Status::Qualified, BondState::Refundable);
    store_request(&mut deps, &request);
    set_bond_totals(&mut deps, 0, 10, 0);
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&outsider, &[]),
            ExecuteMsg::StartBuilding {
                request_id: 1,
                builder: builder.to_string(),
                reason: "x".into()
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::StartBuilding {
                request_id: 1,
                builder: verifier.to_string(),
                reason: "x".into()
            }
        )
        .unwrap_err(),
        ContractError::InvalidBuilder
    );

    let mut env = mock_env();
    env.block.height = 20;
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&steward, &[]),
        ExecuteMsg::StartBuilding {
            request_id: 1,
            builder: builder.to_string(),
            reason: "go".into(),
        },
    )
    .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&outsider, &[]),
            ExecuteMsg::BlockBuilding {
                request_id: 1,
                reason: "x".into()
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    env.block.height = 24;
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&steward, &[]),
            ExecuteMsg::BlockBuilding {
                request_id: 1,
                reason: "stale".into()
            }
        )
        .unwrap_err(),
        ContractError::WorkInactivityNotElapsed
    );
    env.block.height = 25;
    execute(
        deps.as_mut(),
        env,
        message_info(&steward, &[]),
        ExecuteMsg::BlockBuilding {
            request_id: 1,
            reason: "stale".into(),
        },
    )
    .unwrap();

    request = REQUESTS.load(&deps.storage, 1).unwrap();
    request.status = Status::Review;
    REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
    REQUESTS_BY_STATUS.remove(&mut deps.storage, (Status::Blocked.code(), 1));
    REQUESTS_BY_STATUS
        .save(&mut deps.storage, (Status::Review.code(), 1), &())
        .unwrap();
    let key = rank_key(request.support_power, request.oppose_power, 1);
    STATUS_RANK.remove(&mut deps.storage, (Status::Blocked.code(), key.clone()));
    STATUS_CATEGORY_RANK.remove(
        &mut deps.storage,
        (
            Status::Blocked.code(),
            request.category.as_str(),
            key.clone(),
        ),
    );
    STATUS_RANK
        .save(&mut deps.storage, (Status::Review.code(), key.clone()), &1)
        .unwrap();
    STATUS_CATEGORY_RANK
        .save(
            &mut deps.storage,
            (Status::Review.code(), request.category.as_str(), key),
            &1,
        )
        .unwrap();
    let mut review_env = mock_env();
    review_env.block.height = 40;
    assert_eq!(
        execute(
            deps.as_mut(),
            review_env.clone(),
            message_info(&builder, &[]),
            ExecuteMsg::RejectReview {
                request_id: 1,
                reason: "fix".into()
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    execute(
        deps.as_mut(),
        review_env,
        message_info(&verifier, &[]),
        ExecuteMsg::RejectReview {
            request_id: 1,
            reason: "fix".into(),
        },
    )
    .unwrap();
    let rejected = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(
        (
            rejected.status,
            rejected.builder,
            rejected.work_round,
            rejected.work_activity_height
        ),
        (Status::Building, Some(builder), 2, Some(40))
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (1, 6)).unwrap().action,
        RequestAction::ReviewRejected
    );
}

#[test]
fn audit_counter_overflow_and_index_collision_fail_before_writes() {
    let (mut deps, _, _, _) = setup();
    let request = sample_request(1, Status::Open, BondState::Locked);
    store_request(&mut deps, &request);
    set_bond_totals(&mut deps, 10, 0, 0);
    let caller = deps.api.addr_make("caller");
    let mut env = mock_env();
    env.block.height = 10;

    NEXT_REQUEST_ACTION_ID
        .save(&mut deps.storage, 1, &u64::MAX)
        .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&caller, &[]),
            ExecuteMsg::CloseRequest { request_id: 1 }
        )
        .unwrap_err(),
        ContractError::RequestActionIdOverflow
    );
    assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap(), request);
    NEXT_REQUEST_ACTION_ID
        .save(&mut deps.storage, 1, &3)
        .unwrap();
    NEXT_STATUS_HISTORY_ID
        .save(&mut deps.storage, 1, &u64::MAX)
        .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&caller, &[]),
            ExecuteMsg::CloseRequest { request_id: 1 }
        )
        .unwrap_err(),
        ContractError::StatusHistoryIdOverflow
    );
    NEXT_STATUS_HISTORY_ID
        .save(&mut deps.storage, 1, &1)
        .unwrap();
    REQUESTS_BY_STATUS
        .save(&mut deps.storage, (Status::Qualified.code(), 1), &())
        .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&caller, &[]),
            ExecuteMsg::CloseRequest { request_id: 1 }
        )
        .unwrap_err(),
        ContractError::IndexInvariant
    );
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap().locked,
        Uint128::new(10)
    );
}

#[test]
fn corrupted_activity_deadline_and_round_overflow_are_atomic() {
    let (mut deps, steward, _, builder) = setup();
    let mut building = sample_request(1, Status::Building, BondState::Refundable);
    building.builder = Some(builder.clone());
    building.work_round = 1;
    building.work_activity_height = None;
    store_request(&mut deps, &building);
    set_bond_totals(&mut deps, 0, 10, 0);
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::BlockBuilding {
                request_id: 1,
                reason: "stale".into()
            },
        )
        .unwrap_err(),
        ContractError::MissingWorkActivity
    );
    building.work_activity_height = Some(u64::MAX - 2);
    REQUESTS.save(&mut deps.storage, 1, &building).unwrap();
    let mut env = mock_env();
    env.block.height = u64::MAX;
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&steward, &[]),
            ExecuteMsg::BlockBuilding {
                request_id: 1,
                reason: "stale".into()
            },
        )
        .unwrap_err(),
        ContractError::WorkInactivityNotElapsed
    );
    assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap(), building);

    let mut blocked = sample_request(2, Status::Blocked, BondState::Refundable);
    blocked.builder = Some(builder.clone());
    blocked.work_round = u32::MAX;
    blocked.work_activity_height = Some(5);
    store_request(&mut deps, &blocked);
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::ResumeBuilding {
                request_id: 2,
                builder: builder.to_string(),
                reason: "resume".into(),
            },
        )
        .unwrap_err(),
        ContractError::WorkRoundOverflow
    );
    assert_eq!(REQUESTS.load(&deps.storage, 2).unwrap(), blocked);
}

#[test]
fn block_review_preserves_assignment_round_and_activity() {
    let (mut deps, _, verifier, builder) = setup();
    let mut request = sample_request(1, Status::Review, BondState::Refundable);
    request.builder = Some(builder.clone());
    request.work_round = 9;
    request.work_activity_height = Some(77);
    store_request(&mut deps, &request);
    set_bond_totals(&mut deps, 0, 10, 0);
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&verifier, &[]),
        ExecuteMsg::BlockReview {
            request_id: 1,
            reason: "cannot verify".into(),
        },
    )
    .unwrap();
    let blocked = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(
        (
            blocked.status,
            blocked.builder,
            blocked.work_round,
            blocked.work_activity_height
        ),
        (Status::Blocked, Some(builder), 9, Some(77))
    );
    assert_eq!(
        STATUS_HISTORY
            .load(&deps.storage, (1, 1))
            .unwrap()
            .reason
            .as_deref(),
        Some("cannot verify")
    );
}

#[test]
fn refundable_and_forfeited_total_overflow_reject_without_changes() {
    let (mut deps, steward, _, _) = setup();
    let source = sample_request(2, Status::Open, BondState::Locked);
    let target = sample_request(1, Status::Open, BondState::Locked);
    store_request(&mut deps, &target);
    store_request(&mut deps, &source);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(20),
                refundable: Uint128::MAX,
                forfeited: Uint128::zero(),
            },
        )
        .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::MarkDuplicate {
                request_id: 2,
                canonical_request_id: 1,
                reason: "x".into()
            }
        )
        .unwrap_err(),
        ContractError::BondTotalOverflow
    );
    assert_eq!(REQUESTS.load(&deps.storage, 2).unwrap(), source);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(20),
                refundable: Uint128::zero(),
                forfeited: Uint128::MAX,
            },
        )
        .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&steward, &[]),
            ExecuteMsg::MarkSpam {
                request_id: 1,
                reason: "x".into()
            }
        )
        .unwrap_err(),
        ContractError::BondTotalOverflow
    );
    assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap(), target);
}
