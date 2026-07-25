use cosmwasm_std::testing::{mock_env, MockApi};
use cosmwasm_std::{attr, coin, Addr, Timestamp, Uint128};

use crate::error::ContractError;
use crate::msg::{ExecuteMsg, RecoveryReason};
use crate::rank::rank_key;
use crate::state::{
    BondState, BondTotals, EvidenceKind, FutureRequestPolicy, ProtocolAction, ProtocolActionRecord,
    RequestAction, RequestActionRecord, RequestLimits, Status, StatusHistoryRecord, BOND_TOTALS,
    CONFIG, NEXT_PROTOCOL_ACTION_ID, NEXT_REQUEST_ACTION_ID, NEXT_STATUS_HISTORY_ID,
    PROTOCOL_ACTIONS, REQUESTS, REQUESTS_BY_STATUS, REQUEST_ACTIONS, STATUS_CATEGORY_RANK,
    STATUS_HISTORY, STATUS_RANK,
};
use crate::task8_tests::{future_policy, pause, qualify, run, setup, storage_dump, submit};

fn start_building(deps: &mut crate::task8_tests::TestDeps, steward: &Addr, builder: &Addr) {
    run(
        deps,
        steward,
        ExecuteMsg::StartBuilding {
            request_id: 1,
            builder: builder.to_string(),
            reason: "start".into(),
        },
    )
    .unwrap();
}

#[test]
fn paused_delivery_review_and_attestation_continue_on_fresh_valid_flow() {
    let (mut deps, governor, steward, verifier) = setup();
    let author = deps.api.addr_make("author");
    let builder = deps.api.addr_make("builder");
    qualify(&mut deps, &author);
    start_building(&mut deps, &steward, &builder);
    pause(&mut deps, &governor);
    run(
        &mut deps,
        &builder,
        ExecuteMsg::AddEvidence {
            request_id: 1,
            kind: EvidenceKind::Commit,
            uri: "https://delivery".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
            note: "delivered".into(),
        },
    )
    .unwrap();
    run(
        &mut deps,
        &builder,
        ExecuteMsg::RequestReview {
            request_id: 1,
            reason: "ready".into(),
            evidence_ids: vec![1],
        },
    )
    .unwrap();
    run(
        &mut deps,
        &verifier,
        ExecuteMsg::AddEvidence {
            request_id: 1,
            kind: EvidenceKind::TestReport,
            uri: "https://verification".into(),
            digest: format!("sha256:{}", "b".repeat(64)),
            note: "verified".into(),
        },
    )
    .unwrap();
    run(
        &mut deps,
        &verifier,
        ExecuteMsg::AttestShipment {
            request_id: 1,
            rationale: "criteria met".into(),
            evidence_ids: vec![1, 2],
        },
    )
    .unwrap();
    assert_eq!(
        REQUESTS.load(&deps.storage, 1).unwrap().status,
        Status::Shipped
    );
    assert!(CONFIG.load(&deps.storage).unwrap().submissions_paused);
}

#[test]
fn paused_builder_and_steward_recovery_continue_on_fresh_valid_flow() {
    let (mut deps, governor, steward, _) = setup();
    let author = deps.api.addr_make("author");
    let builder = deps.api.addr_make("builder");
    let replacement = deps.api.addr_make("replacement-builder");
    qualify(&mut deps, &author);
    start_building(&mut deps, &steward, &builder);
    pause(&mut deps, &governor);
    run(
        &mut deps,
        &builder,
        ExecuteMsg::BlockBuilding {
            request_id: 1,
            reason: "blocked".into(),
        },
    )
    .unwrap();
    run(
        &mut deps,
        &steward,
        ExecuteMsg::ResumeBuilding {
            request_id: 1,
            builder: replacement.to_string(),
            reason: "recover".into(),
        },
    )
    .unwrap();
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(request.status, Status::Building);
    assert_eq!(request.builder, Some(replacement));
    assert_eq!(request.work_round, 2);
}

#[test]
fn paused_withdrawal_of_independently_refundable_bond_continues() {
    let (mut deps, governor, _, _) = setup();
    let author = deps.api.addr_make("author");
    qualify(&mut deps, &author);
    pause(&mut deps, &governor);
    deps.querier
        .bank
        .update_balance(mock_env().contract.address, vec![coin(10, "ujuno")]);
    let response = run(
        &mut deps,
        &author,
        ExecuteMsg::WithdrawRefund { request_id: 1 },
    )
    .unwrap();
    assert_eq!(response.messages.len(), 1);
    assert_eq!(
        REQUESTS.load(&deps.storage, 1).unwrap().bond.state,
        BondState::Claimed
    );
}

fn config_msg(bond: u128) -> ExecuteMsg {
    ExecuteMsg::UpdateConfig {
        submission_bond: Some(Uint128::new(bond)),
        voting_period_blocks: None,
        quorum_bps: None,
        support_bps: None,
        work_inactivity_blocks: None,
        request_limits: None,
        reason: "policy".into(),
    }
}

#[test]
fn protocol_handlers_have_exact_records_attributes_and_validation() {
    let (mut deps, governor, steward, verifier) = setup();
    let outsider = deps.api.addr_make("outsider");
    let new_steward = deps.api.addr_make("new-steward");
    let new_verifier = deps.api.addr_make("new-verifier");
    for msg in [
        config_msg(11),
        ExecuteMsg::ReplaceSteward {
            address: new_steward.to_string(),
            reason: "x".into(),
        },
        ExecuteMsg::ReplaceVerifier {
            address: new_verifier.to_string(),
            reason: "x".into(),
        },
    ] {
        assert_eq!(
            run(&mut deps, &outsider, msg).unwrap_err(),
            ContractError::Unauthorized
        );
    }
    for reason in [" ", "123456789012345678901"] {
        let mut msg = config_msg(11);
        if let ExecuteMsg::UpdateConfig { reason: value, .. } = &mut msg {
            *value = reason.into();
        }
        assert_eq!(
            run(&mut deps, &governor, msg).unwrap_err(),
            ContractError::InvalidReason
        );
    }
    for msg in [
        ExecuteMsg::ReplaceSteward {
            address: steward.to_string(),
            reason: "same".into(),
        },
        ExecuteMsg::ReplaceVerifier {
            address: verifier.to_string(),
            reason: "same".into(),
        },
    ] {
        assert_eq!(
            run(&mut deps, &governor, msg).unwrap_err(),
            ContractError::RoleUnchanged
        );
    }
    for msg in [
        ExecuteMsg::ReplaceSteward {
            address: "x".into(),
            reason: "rotate".into(),
        },
        ExecuteMsg::ReplaceVerifier {
            address: "x".into(),
            reason: "rotate".into(),
        },
    ] {
        assert!(matches!(
            run(&mut deps, &governor, msg).unwrap_err(),
            ContractError::InvalidAddress { .. }
        ));
    }
    for msg in [
        ExecuteMsg::ReplaceSteward {
            address: new_steward.to_string(),
            reason: " ".into(),
        },
        ExecuteMsg::ReplaceVerifier {
            address: new_verifier.to_string(),
            reason: "123456789012345678901".into(),
        },
    ] {
        assert_eq!(
            run(&mut deps, &governor, msg).unwrap_err(),
            ContractError::InvalidReason
        );
    }

    let env = mock_env();
    let response = run(&mut deps, &governor, config_msg(11)).unwrap();
    assert_eq!(
        response.attributes,
        vec![
            attr("action", "update_config"),
            attr("protocol_action_id", "1")
        ]
    );
    assert_eq!(
        PROTOCOL_ACTIONS.load(&deps.storage, 1).unwrap(),
        ProtocolActionRecord {
            id: 1,
            actor: governor.clone(),
            action: ProtocolAction::ConfigUpdated {
                old_policy: future_policy(),
                new_policy: FutureRequestPolicy {
                    submission_bond: Uint128::new(11),
                    ..future_policy()
                },
            },
            reason: Some("policy".into()),
            height: env.block.height,
            timestamp: env.block.time,
        }
    );
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ReplaceSteward {
            address: new_steward.to_string(),
            reason: " steward rotation ".into(),
        },
    )
    .unwrap();
    assert_eq!(
        PROTOCOL_ACTIONS.load(&deps.storage, 2).unwrap(),
        ProtocolActionRecord {
            id: 2,
            actor: governor.clone(),
            action: ProtocolAction::StewardReplaced {
                previous: steward,
                steward: new_steward
            },
            reason: Some("steward rotation".into()),
            height: env.block.height,
            timestamp: env.block.time,
        }
    );
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ReplaceVerifier {
            address: new_verifier.to_string(),
            reason: "verifier rotation".into(),
        },
    )
    .unwrap();
    assert_eq!(
        PROTOCOL_ACTIONS.load(&deps.storage, 3).unwrap(),
        ProtocolActionRecord {
            id: 3,
            actor: governor,
            action: ProtocolAction::VerifierReplaced {
                previous: verifier,
                verifier: new_verifier
            },
            reason: Some("verifier rotation".into()),
            height: env.block.height,
            timestamp: env.block.time,
        }
    );
    assert_eq!(NEXT_PROTOCOL_ACTION_ID.load(&deps.storage).unwrap(), 4);
}

#[test]
fn update_config_rejects_every_invalid_field_and_limit_relation() {
    let direct = [
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
        ExecuteMsg::UpdateConfig {
            submission_bond: None,
            voting_period_blocks: None,
            quorum_bps: Some(10_001),
            support_bps: None,
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "policy".into(),
        },
        ExecuteMsg::UpdateConfig {
            submission_bond: None,
            voting_period_blocks: None,
            quorum_bps: None,
            support_bps: Some(0),
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "policy".into(),
        },
        ExecuteMsg::UpdateConfig {
            submission_bond: None,
            voting_period_blocks: None,
            quorum_bps: None,
            support_bps: Some(10_001),
            work_inactivity_blocks: None,
            request_limits: None,
            reason: "policy".into(),
        },
        ExecuteMsg::UpdateConfig {
            submission_bond: None,
            voting_period_blocks: None,
            quorum_bps: None,
            support_bps: None,
            work_inactivity_blocks: Some(0),
            request_limits: None,
            reason: "policy".into(),
        },
    ];
    for msg in direct {
        let (mut deps, governor, _, _) = setup();
        let before = storage_dump(&deps.storage);
        assert!(run(&mut deps, &governor, msg).is_err());
        assert_eq!(storage_dump(&deps.storage), before);
    }
    let mut cases = Vec::new();
    for field in 0..10 {
        let mut limits = RequestLimits::default();
        match field {
            0 => limits.max_title_bytes = 0,
            1 => limits.max_summary_bytes = 0,
            2 => limits.max_acceptance_criteria_bytes = 0,
            3 => limits.max_category_bytes = 0,
            4 => limits.max_uri_bytes = 8,
            5 => limits.max_digest_bytes = 70,
            6 => limits.max_evidence_note_bytes = 0,
            7 => limits.max_evidence_items = 1,
            8 => limits.max_review_evidence_refs = 0,
            _ => limits.max_attestation_evidence_refs = 1,
        }
        cases.push(limits);
    }
    let review = RequestLimits {
        max_evidence_items: 2,
        max_review_evidence_refs: 3,
        ..RequestLimits::default()
    };
    cases.push(review);
    let attest = RequestLimits {
        max_evidence_items: 2,
        max_attestation_evidence_refs: 3,
        ..RequestLimits::default()
    };
    cases.push(attest);
    for limits in cases {
        let (mut deps, governor, _, _) = setup();
        let msg = ExecuteMsg::UpdateConfig {
            submission_bond: None,
            voting_period_blocks: None,
            quorum_bps: None,
            support_bps: None,
            work_inactivity_blocks: None,
            request_limits: Some(limits),
            reason: "policy".into(),
        };
        assert!(matches!(
            run(&mut deps, &governor, msg).unwrap_err(),
            ContractError::InvalidRequestLimits { .. }
        ));
    }
}

fn assert_protocol_preflight(
    msg: ExecuteMsg,
    prepare: impl Fn(&mut crate::task8_tests::TestDeps, &Addr),
) {
    for overflow in [true, false] {
        let (mut deps, governor, _, _) = setup();
        prepare(&mut deps, &governor);
        let id = if overflow {
            u64::MAX
        } else {
            NEXT_PROTOCOL_ACTION_ID.load(&deps.storage).unwrap()
        };
        NEXT_PROTOCOL_ACTION_ID
            .save(&mut deps.storage, &id)
            .unwrap();
        if !overflow {
            PROTOCOL_ACTIONS
                .save(
                    &mut deps.storage,
                    id,
                    &ProtocolActionRecord {
                        id,
                        actor: governor.clone(),
                        action: ProtocolAction::SubmissionsPaused,
                        reason: Some("existing".into()),
                        height: 1,
                        timestamp: Timestamp::from_seconds(1),
                    },
                )
                .unwrap();
        }
        let before = storage_dump(&deps.storage);
        let err = run(&mut deps, &governor, msg.clone()).unwrap_err();
        assert_eq!(
            err,
            if overflow {
                ContractError::ProtocolActionIdOverflow
            } else {
                ContractError::AuditInvariant
            }
        );
        assert_eq!(storage_dump(&deps.storage), before);
    }
}

#[test]
fn every_protocol_mutation_preflights_overflow_and_collision_atomically() {
    let replacement = MockApi::default().addr_make("replacement").to_string();
    assert_protocol_preflight(
        ExecuteMsg::PauseSubmissions {
            reason: "risk".into(),
        },
        |_, _| {},
    );
    assert_protocol_preflight(
        ExecuteMsg::UnpauseSubmissions {
            reason: "safe".into(),
        },
        pause,
    );
    assert_protocol_preflight(config_msg(11), |_, _| {});
    assert_protocol_preflight(
        ExecuteMsg::ReplaceSteward {
            address: replacement.clone(),
            reason: "rotate".into(),
        },
        |_, _| {},
    );
    assert_protocol_preflight(
        ExecuteMsg::ReplaceVerifier {
            address: replacement,
            reason: "rotate".into(),
        },
        |_, _| {},
    );
}

fn emergency_fixture() -> (crate::task8_tests::TestDeps, Addr, Addr) {
    let (mut deps, governor, _, _) = setup();
    let author = deps.api.addr_make("author");
    submit(&mut deps, &author, 10);
    pause(&mut deps, &governor);
    (deps, governor, author)
}

fn emergency_msg(id: u64) -> ExecuteMsg {
    ExecuteMsg::EmergencyArchiveOpen {
        request_id: id,
        reason: RecoveryReason::SnapshotHistoryRisk,
    }
}

#[test]
fn emergency_authorization_request_status_and_bond_validation_are_atomic() {
    let (mut deps, governor, _) = emergency_fixture();
    let outsider = deps.api.addr_make("outsider");
    let steward = CONFIG.load(&deps.storage).unwrap().steward;
    for sender in [outsider, steward] {
        let before = storage_dump(&deps.storage);
        assert_eq!(
            run(&mut deps, &sender, emergency_msg(1)).unwrap_err(),
            ContractError::Unauthorized
        );
        assert_eq!(storage_dump(&deps.storage), before);
    }
    assert_eq!(
        run(&mut deps, &governor, emergency_msg(99)).unwrap_err(),
        ContractError::UnknownRequest { request_id: 99 }
    );
    for mutate in [0, 1, 2] {
        let (mut deps, governor, _) = emergency_fixture();
        let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
        match mutate {
            0 => request.status = Status::Qualified,
            1 => request.bond.state = BondState::Refundable,
            _ => request.bond.amount = Uint128::zero(),
        }
        REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
        let before = storage_dump(&deps.storage);
        let err = run(&mut deps, &governor, emergency_msg(1)).unwrap_err();
        assert_eq!(
            err,
            if mutate == 0 {
                ContractError::InvalidStatusTransition
            } else {
                ContractError::BondInvariant
            }
        );
        assert_eq!(storage_dump(&deps.storage), before);
    }
}

enum Corruption {
    OldStatusAbsent,
    OldRankAbsent,
    OldRankWrong,
    OldCategoryAbsent,
    OldCategoryWrong,
    DestinationStatus,
    DestinationRank,
    DestinationCategory,
    LockedUnderflow,
    RefundOverflow,
    ActionOverflow,
    ActionCollision,
    HistoryOverflow,
    HistoryCollision,
}

#[test]
fn emergency_transition_failure_matrix_is_completely_atomic() {
    use Corruption::*;
    let cases = [
        OldStatusAbsent,
        OldRankAbsent,
        OldRankWrong,
        OldCategoryAbsent,
        OldCategoryWrong,
        DestinationStatus,
        DestinationRank,
        DestinationCategory,
        LockedUnderflow,
        RefundOverflow,
        ActionOverflow,
        ActionCollision,
        HistoryOverflow,
        HistoryCollision,
    ];
    for case in cases {
        let (mut deps, governor, _) = emergency_fixture();
        let request = REQUESTS.load(&deps.storage, 1).unwrap();
        let key = rank_key(request.support_power, request.oppose_power, 1);
        let expected = match case {
            OldStatusAbsent => {
                REQUESTS_BY_STATUS.remove(&mut deps.storage, (Status::Open.code(), 1));
                ContractError::IndexInvariant
            }
            OldRankAbsent => {
                STATUS_RANK.remove(&mut deps.storage, (Status::Open.code(), key.clone()));
                ContractError::IndexInvariant
            }
            OldRankWrong => {
                STATUS_RANK
                    .save(&mut deps.storage, (Status::Open.code(), key.clone()), &2)
                    .unwrap();
                ContractError::IndexInvariant
            }
            OldCategoryAbsent => {
                STATUS_CATEGORY_RANK.remove(
                    &mut deps.storage,
                    (Status::Open.code(), "core", key.clone()),
                );
                ContractError::IndexInvariant
            }
            OldCategoryWrong => {
                STATUS_CATEGORY_RANK
                    .save(
                        &mut deps.storage,
                        (Status::Open.code(), "core", key.clone()),
                        &2,
                    )
                    .unwrap();
                ContractError::IndexInvariant
            }
            DestinationStatus => {
                REQUESTS_BY_STATUS
                    .save(&mut deps.storage, (Status::Archived.code(), 1), &())
                    .unwrap();
                ContractError::IndexInvariant
            }
            DestinationRank => {
                STATUS_RANK
                    .save(
                        &mut deps.storage,
                        (Status::Archived.code(), key.clone()),
                        &1,
                    )
                    .unwrap();
                ContractError::IndexInvariant
            }
            DestinationCategory => {
                STATUS_CATEGORY_RANK
                    .save(
                        &mut deps.storage,
                        (Status::Archived.code(), "core", key.clone()),
                        &1,
                    )
                    .unwrap();
                ContractError::IndexInvariant
            }
            LockedUnderflow => {
                let mut totals = BOND_TOTALS.load(&deps.storage).unwrap();
                totals.locked = Uint128::new(9);
                BOND_TOTALS.save(&mut deps.storage, &totals).unwrap();
                ContractError::BondInvariant
            }
            RefundOverflow => {
                BOND_TOTALS
                    .save(
                        &mut deps.storage,
                        &BondTotals {
                            locked: Uint128::new(10),
                            refundable: Uint128::MAX,
                            forfeited: Uint128::zero(),
                        },
                    )
                    .unwrap();
                ContractError::BondTotalOverflow
            }
            ActionOverflow => {
                NEXT_REQUEST_ACTION_ID
                    .save(&mut deps.storage, 1, &(u64::MAX - 1))
                    .unwrap();
                ContractError::RequestActionIdOverflow
            }
            ActionCollision => {
                let mut record = REQUEST_ACTIONS.load(&deps.storage, (1, 1)).unwrap();
                record.id = 3;
                REQUEST_ACTIONS
                    .save(&mut deps.storage, (1, 3), &record)
                    .unwrap();
                ContractError::AuditInvariant
            }
            HistoryOverflow => {
                NEXT_STATUS_HISTORY_ID
                    .save(&mut deps.storage, 1, &u64::MAX)
                    .unwrap();
                ContractError::StatusHistoryIdOverflow
            }
            HistoryCollision => {
                STATUS_HISTORY
                    .save(
                        &mut deps.storage,
                        (1, 1),
                        &StatusHistoryRecord {
                            id: 1,
                            request_id: 1,
                            actor: governor.clone(),
                            from: Status::Open,
                            to: Status::Archived,
                            reason: None,
                            evidence_ids: vec![],
                            height: 1,
                            timestamp: Timestamp::from_seconds(1),
                        },
                    )
                    .unwrap();
                ContractError::AuditInvariant
            }
        };
        let before = storage_dump(&deps.storage);
        assert_eq!(
            run(&mut deps, &governor, emergency_msg(1)).unwrap_err(),
            expected
        );
        assert_eq!(storage_dump(&deps.storage), before);
    }
}

#[test]
fn emergency_success_has_exact_indexes_records_order_attributes_and_pull_refund() {
    let (mut deps, governor, author) = emergency_fixture();
    let env = mock_env();
    let response = run(&mut deps, &governor, emergency_msg(1)).unwrap();
    assert!(response.messages.is_empty());
    assert_eq!(
        response.attributes,
        vec![
            attr("action", "emergency_archive_open"),
            attr("request_id", "1"),
            attr("status", "archived")
        ]
    );
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    let key = rank_key(request.support_power, request.oppose_power, 1);
    assert!(!REQUESTS_BY_STATUS.has(&deps.storage, (Status::Open.code(), 1)));
    assert!(REQUESTS_BY_STATUS.has(&deps.storage, (Status::Archived.code(), 1)));
    assert_eq!(
        STATUS_RANK
            .load(&deps.storage, (Status::Archived.code(), key.clone()))
            .unwrap(),
        1
    );
    assert_eq!(
        STATUS_CATEGORY_RANK
            .load(&deps.storage, (Status::Archived.code(), "core", key))
            .unwrap(),
        1
    );
    let expected_actions = [
        RequestAction::EmergencyArchived {
            reason: RecoveryReason::SnapshotHistoryRisk,
        },
        RequestAction::BondTransition {
            from: Some(BondState::Locked),
            to: BondState::Refundable,
            amount: Uint128::new(10),
        },
    ];
    for (offset, action) in expected_actions.into_iter().enumerate() {
        assert_eq!(
            REQUEST_ACTIONS
                .load(&deps.storage, (1, 3 + offset as u64))
                .unwrap(),
            RequestActionRecord {
                id: 3 + offset as u64,
                request_id: 1,
                actor: governor.clone(),
                action,
                reason: Some("snapshot_history_risk".into()),
                height: env.block.height,
                timestamp: env.block.time,
            }
        );
    }
    assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap(), 5);
    assert_eq!(
        STATUS_HISTORY.load(&deps.storage, (1, 1)).unwrap(),
        StatusHistoryRecord {
            id: 1,
            request_id: 1,
            actor: governor,
            from: Status::Open,
            to: Status::Archived,
            reason: Some("snapshot_history_risk".into()),
            evidence_ids: vec![],
            height: env.block.height,
            timestamp: env.block.time,
        }
    );
    assert_eq!(NEXT_STATUS_HISTORY_ID.load(&deps.storage, 1).unwrap(), 2);
    deps.querier
        .bank
        .update_balance(mock_env().contract.address, vec![coin(10, "ujuno")]);
    assert_eq!(
        run(
            &mut deps,
            &author,
            ExecuteMsg::WithdrawRefund { request_id: 1 }
        )
        .unwrap()
        .messages
        .len(),
        1
    );
}
