use crate::evidence_refunds_tests::{add, digest, setup, TestDeps};
use crate::state::{
    BondState, BondTotals, Evidence, EvidenceKind, RequestAction, RequestActionRecord,
    ShipmentAttestation, Status, StatusHistoryRecord, BOND_TOTALS, EVIDENCE, NEXT_EVIDENCE_ID,
    NEXT_REQUEST_ACTION_ID, NEXT_STATUS_HISTORY_ID, REQUESTS, REQUESTS_BY_AUTHOR,
    REQUESTS_BY_CATEGORY, REQUESTS_BY_STATUS, REQUEST_ACTIONS, SHIPMENT_ATTESTATIONS,
    STATUS_CATEGORY_RANK, STATUS_HISTORY, STATUS_RANK,
};
use crate::{contract::execute, error::ContractError, msg::ExecuteMsg, rank::rank_key};
use cosmwasm_std::testing::{message_info, mock_env, MockStorage};
use cosmwasm_std::{coin, Addr, BankMsg, CosmosMsg, Order, Storage, Timestamp, Uint128};

fn snapshot(storage: &MockStorage) -> Vec<(Vec<u8>, Vec<u8>)> {
    storage.range(None, None, Order::Ascending).collect()
}

fn unchanged(deps: &mut TestDeps, sender: &Addr, msg: ExecuteMsg, expected: ContractError) {
    let before = snapshot(&deps.storage);
    assert_eq!(
        execute(deps.as_mut(), mock_env(), message_info(sender, &[]), msg).unwrap_err(),
        expected
    );
    assert_eq!(snapshot(&deps.storage), before);
}

fn item(id: u64, request_id: u64, who: Addr, kind: EvidenceKind, round: u32) -> Evidence {
    Evidence {
        id,
        request_id,
        submitter: who,
        kind,
        uri: "ipfs://artifact".into(),
        digest: digest(),
        note: "proof".into(),
        work_round: round,
        submitted_at: Timestamp::from_seconds(11),
        submitted_height: 11,
    }
}

fn seed_pair(deps: &mut TestDeps, builder: &Addr, verifier: &Addr) {
    EVIDENCE
        .save(
            &mut deps.storage,
            (1, 1),
            &item(1, 1, builder.clone(), EvidenceKind::Commit, 1),
        )
        .unwrap();
    EVIDENCE
        .save(
            &mut deps.storage,
            (1, 2),
            &item(2, 1, verifier.clone(), EvidenceKind::TestReport, 1),
        )
        .unwrap();
}

fn review(reason: &str, evidence_ids: Vec<u64>) -> ExecuteMsg {
    ExecuteMsg::RequestReview {
        request_id: 1,
        reason: reason.into(),
        evidence_ids,
    }
}

fn attest(rationale: &str, evidence_ids: Vec<u64>) -> ExecuteMsg {
    ExecuteMsg::AttestShipment {
        request_id: 1,
        rationale: rationale.into(),
        evidence_ids,
    }
}

#[test]
fn funds_first_each_uses_a_fresh_fixture_and_is_atomic() {
    for (message, author_sender) in [
        (add(EvidenceKind::Commit), false),
        (review("r", vec![1]), false),
        (attest("r", vec![1, 2]), false),
        (ExecuteMsg::WithdrawRefund { request_id: 1 }, true),
    ] {
        let (mut deps, author, builder, _) = setup(Status::Building);
        let sender = if author_sender { author } else { builder };
        let before = snapshot(&deps.storage);
        assert_eq!(
            execute(
                deps.as_mut(),
                mock_env(),
                message_info(&sender, &[coin(1, "ujuno")]),
                message,
            )
            .unwrap_err(),
            ContractError::UnexpectedFunds
        );
        assert_eq!(snapshot(&deps.storage), before);
    }
}

#[test]
fn evidence_uri_scheme_and_empty_locator_matrix() {
    for uri in [
        "",
        "https://",
        "ipfs://",
        "http://x",
        "ftp://x",
        "HTTPS://x",
        " https://x",
        "httpsx://x",
    ] {
        let (mut deps, _, builder, _) = setup(Status::Building);
        let ExecuteMsg::AddEvidence {
            request_id,
            kind,
            digest,
            note,
            ..
        } = add(EvidenceKind::Commit)
        else {
            unreachable!()
        };
        unchanged(
            &mut deps,
            &builder,
            ExecuteMsg::AddEvidence {
                request_id,
                kind,
                uri: uri.into(),
                digest,
                note,
            },
            ContractError::InvalidEvidence,
        );
    }
}

#[test]
fn evidence_digest_exact_lowercase_length_sign_and_whitespace_matrix() {
    for bad in [
        "",
        "sha256:",
        "sha256:abc",
        "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "sha256:gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
        " sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha256:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        let (mut deps, _, builder, _) = setup(Status::Building);
        unchanged(
            &mut deps,
            &builder,
            ExecuteMsg::AddEvidence {
                request_id: 1,
                kind: EvidenceKind::Commit,
                uri: "https://x".into(),
                digest: bad.into(),
                note: String::new(),
            },
            ContractError::InvalidEvidence,
        );
    }
}

#[test]
fn evidence_raw_uri_digest_note_boundaries_and_multibyte() {
    for (field, value, ok) in [
        ("uri", format!("https://{}", "x".repeat(12)), true),
        ("uri", format!("https://{}é", "x".repeat(11)), false),
        ("digest", digest(), true),
        ("digest", format!("{} ", digest()), false),
        ("note", "é".repeat(10), true),
        ("note", format!("{}é", "x".repeat(19)), false),
        ("note", String::new(), true),
    ] {
        let (mut deps, _, builder, _) = setup(Status::Building);
        let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
        request.limits.max_uri_bytes = 20;
        request.limits.max_digest_bytes = 71;
        request.limits.max_evidence_note_bytes = 20;
        REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
        let mut uri = "https://x".to_owned();
        let mut hash = digest();
        let mut note = "n".to_owned();
        match field {
            "uri" => uri = value,
            "digest" => hash = value,
            "note" => note = value,
            _ => unreachable!(),
        }
        let before = snapshot(&deps.storage);
        let result = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&builder, &[]),
            ExecuteMsg::AddEvidence {
                request_id: 1,
                kind: EvidenceKind::Commit,
                uri,
                digest: hash,
                note,
            },
        );
        assert_eq!(result.is_ok(), ok, "{field}");
        if !ok {
            assert_eq!(result.unwrap_err(), ContractError::InvalidEvidence);
            assert_eq!(snapshot(&deps.storage), before);
        }
    }
}

#[test]
fn every_evidence_kind_runs_through_dispatch() {
    let kinds = [
        EvidenceKind::PullRequest,
        EvidenceKind::Commit,
        EvidenceKind::Release,
        EvidenceKind::Deployment,
        EvidenceKind::Document,
        EvidenceKind::TestReport,
        EvidenceKind::AuditReport,
        EvidenceKind::ReviewRecord,
    ];
    for (index, kind) in kinds.into_iter().enumerate() {
        let status = if index < 5 {
            Status::Building
        } else {
            Status::Review
        };
        let (mut deps, _, builder, verifier) = setup(status);
        let sender = if index < 5 { &builder } else { &verifier };
        let response = execute(
            deps.as_mut(),
            mock_env(),
            message_info(sender, &[]),
            add(kind.clone()),
        )
        .unwrap();
        assert!(response.messages.is_empty());
        assert_eq!(EVIDENCE.load(&deps.storage, (1, 1)).unwrap().kind, kind);
    }
}

#[test]
fn evidence_authority_status_role_round_activity_and_policy_matrix() {
    for case in 0..9 {
        let status = if matches!(case, 1 | 8) {
            Status::Review
        } else {
            Status::Building
        };
        let (mut deps, author, builder, verifier) = setup(status);
        let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
        let (sender, kind, expected) = match case {
            0 => (author, EvidenceKind::Commit, ContractError::Unauthorized),
            1 => (
                builder.clone(),
                EvidenceKind::TestReport,
                ContractError::Unauthorized,
            ),
            2 => (
                builder.clone(),
                EvidenceKind::TestReport,
                ContractError::InvalidStatusTransition,
            ),
            3 => (
                builder.clone(),
                EvidenceKind::Commit,
                ContractError::InvalidBuilder,
            ),
            4 => (
                builder.clone(),
                EvidenceKind::Commit,
                ContractError::InvalidBuilder,
            ),
            5 => (
                builder.clone(),
                EvidenceKind::Commit,
                ContractError::MissingWorkActivity,
            ),
            6 => (
                builder.clone(),
                EvidenceKind::Commit,
                ContractError::MissingWorkActivity,
            ),
            7 => (
                builder.clone(),
                EvidenceKind::Commit,
                ContractError::InvalidEvidence,
            ),
            _ => (
                builder.clone(),
                EvidenceKind::Commit,
                ContractError::InvalidStatusTransition,
            ),
        };
        match case {
            3 => request.builder = None,
            4 => request.builder = Some(verifier),
            5 => request.work_round = 0,
            6 => request.work_activity_height = None,
            7 => request.evidence_policy_version = 2,
            _ => {}
        }
        REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
        unchanged(&mut deps, &sender, add(kind), expected);
    }
}

#[test]
fn evidence_count_ids_destination_and_action_preflight_matrix() {
    for case in 0..6 {
        let (mut deps, _, builder, _) = setup(Status::Building);
        let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
        match case {
            0 => NEXT_EVIDENCE_ID.save(&mut deps.storage, 1, &0).unwrap(),
            1 => NEXT_EVIDENCE_ID
                .save(
                    &mut deps.storage,
                    1,
                    &(u64::from(request.limits.max_evidence_items) + 1),
                )
                .unwrap(),
            2 => EVIDENCE
                .save(
                    &mut deps.storage,
                    (1, 1),
                    &item(1, 1, builder.clone(), EvidenceKind::Commit, 1),
                )
                .unwrap(),
            3 => NEXT_REQUEST_ACTION_ID
                .save(&mut deps.storage, 1, &u64::MAX)
                .unwrap(),
            4 => REQUEST_ACTIONS
                .save(
                    &mut deps.storage,
                    (1, 1),
                    &action_record(
                        1,
                        builder.clone(),
                        RequestAction::EvidenceAdded { evidence_id: 9 },
                    ),
                )
                .unwrap(),
            _ => {
                request.limits.max_evidence_items = u16::MAX;
                REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
                NEXT_EVIDENCE_ID
                    .save(&mut deps.storage, 1, &u64::MAX)
                    .unwrap();
            }
        }
        let expected = match case {
            2 | 4 => ContractError::AuditInvariant,
            3 => ContractError::RequestActionIdOverflow,
            _ => ContractError::InvalidEvidence,
        };
        unchanged(&mut deps, &builder, add(EvidenceKind::Commit), expected);
    }
    let (mut deps, _, builder, _) = setup(Status::Building);
    let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
    request.limits.max_evidence_items = u16::MAX;
    REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
    NEXT_EVIDENCE_ID
        .save(&mut deps.storage, 1, &u64::from(u16::MAX))
        .unwrap();
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&builder, &[]),
        add(EvidenceKind::Commit),
    )
    .unwrap();
    assert_eq!(
        NEXT_EVIDENCE_ID.load(&deps.storage, 1).unwrap(),
        u64::from(u16::MAX) + 1
    );
}

fn action_record(id: u64, actor: Addr, action: RequestAction) -> RequestActionRecord {
    RequestActionRecord {
        id,
        request_id: 1,
        actor,
        action,
        reason: None,
        height: 1,
        timestamp: Timestamp::from_seconds(1),
    }
}

#[test]
fn evidence_success_full_record_and_activity_reset_vs_preservation() {
    let (mut deps, _, builder, _) = setup(Status::Building);
    let mut env = mock_env();
    env.block.height = 42;
    env.block.time = Timestamp::from_seconds(99);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&builder, &[]),
        ExecuteMsg::AddEvidence {
            request_id: 1,
            kind: EvidenceKind::Deployment,
            uri: "ipfs://cid".into(),
            digest: digest(),
            note: "évidence".into(),
        },
    )
    .unwrap();
    assert!(response.messages.is_empty());
    assert_eq!(
        EVIDENCE.load(&deps.storage, (1, 1)).unwrap(),
        Evidence {
            id: 1,
            request_id: 1,
            submitter: builder.clone(),
            kind: EvidenceKind::Deployment,
            uri: "ipfs://cid".into(),
            digest: digest(),
            note: "évidence".into(),
            work_round: 1,
            submitted_at: env.block.time,
            submitted_height: 42,
        }
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (1, 1)).unwrap(),
        RequestActionRecord {
            id: 1,
            request_id: 1,
            actor: builder,
            action: RequestAction::EvidenceAdded { evidence_id: 1 },
            reason: None,
            height: 42,
            timestamp: env.block.time,
        }
    );
    assert_eq!(NEXT_EVIDENCE_ID.load(&deps.storage, 1).unwrap(), 2);
    assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap(), 2);
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(request.updated_at, env.block.time);
    assert_eq!(request.work_activity_height, Some(42));

    let (mut deps, _, _, verifier) = setup(Status::Review);
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&verifier, &[]),
        add(EvidenceKind::AuditReport),
    )
    .unwrap();
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(request.updated_at, env.block.time);
    assert_eq!(request.work_activity_height, Some(7));
}

#[test]
fn review_invalid_reason_authority_status_builder_and_refs_matrix() {
    for case in 0..14 {
        let status = if case == 1 {
            Status::Review
        } else {
            Status::Building
        };
        let (mut deps, author, builder, verifier) = setup(status);
        let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
        request.limits.max_review_evidence_refs = 2;
        let evidence = match case {
            8 => item(1, 2, builder.clone(), EvidenceKind::Commit, 1),
            9 => item(1, 1, builder.clone(), EvidenceKind::Commit, 2),
            10 => item(1, 1, builder.clone(), EvidenceKind::TestReport, 1),
            11 => item(1, 1, verifier.clone(), EvidenceKind::Commit, 1),
            _ => item(1, 1, builder.clone(), EvidenceKind::Commit, 1),
        };
        if case != 7 {
            EVIDENCE.save(&mut deps.storage, (1, 1), &evidence).unwrap();
        }
        let (sender, reason, ids, expected) = match case {
            0 => (author, "r", vec![1], ContractError::Unauthorized),
            1 => (
                builder.clone(),
                "r",
                vec![1],
                ContractError::InvalidStatusTransition,
            ),
            2 => (builder.clone(), "", vec![1], ContractError::InvalidReason),
            3 => (
                builder.clone(),
                "   ",
                vec![1],
                ContractError::InvalidReason,
            ),
            4 => (
                builder.clone(),
                "ééééééééééé",
                vec![1],
                ContractError::InvalidReason,
            ),
            5 => {
                request.builder = None;
                (builder.clone(), "r", vec![1], ContractError::InvalidBuilder)
            }
            6 => {
                request.builder = Some(verifier);
                (builder.clone(), "r", vec![1], ContractError::InvalidBuilder)
            }
            7..=11 => (
                builder.clone(),
                "r",
                vec![1],
                ContractError::InvalidEvidenceReferences,
            ),
            12 => (
                builder.clone(),
                "r",
                vec![],
                ContractError::InvalidEvidenceReferences,
            ),
            13 => (
                builder.clone(),
                "r",
                vec![1, 1],
                ContractError::InvalidEvidenceReferences,
            ),
            _ => unreachable!(),
        };
        REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
        unchanged(&mut deps, &sender, review(reason, ids), expected);
    }
    let (mut deps, _, builder, _) = setup(Status::Building);
    let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
    request.limits.max_review_evidence_refs = 2;
    REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
    unchanged(
        &mut deps,
        &builder,
        review("r", vec![1, 2, 3]),
        ContractError::InvalidEvidenceReferences,
    );
}

#[test]
fn review_action_history_and_old_destination_index_preflights() {
    for case in 0..7 {
        let (mut deps, _, builder, _) = setup(Status::Building);
        EVIDENCE
            .save(
                &mut deps.storage,
                (1, 1),
                &item(1, 1, builder.clone(), EvidenceKind::Commit, 1),
            )
            .unwrap();
        let key = rank_key(Uint128::new(1), Uint128::zero(), 1);
        match case {
            0 => NEXT_REQUEST_ACTION_ID
                .save(&mut deps.storage, 1, &(u64::MAX - 1))
                .unwrap(),
            1 => NEXT_STATUS_HISTORY_ID
                .save(&mut deps.storage, 1, &u64::MAX)
                .unwrap(),
            2 => REQUEST_ACTIONS
                .save(
                    &mut deps.storage,
                    (1, 2),
                    &action_record(
                        2,
                        builder.clone(),
                        RequestAction::ReviewRequested {
                            evidence_ids: vec![1],
                        },
                    ),
                )
                .unwrap(),
            3 => STATUS_HISTORY
                .save(
                    &mut deps.storage,
                    (1, 1),
                    &history(builder.clone(), Status::Building, Status::Review),
                )
                .unwrap(),
            4 => REQUESTS_BY_STATUS.remove(&mut deps.storage, (Status::Building.code(), 1)),
            5 => STATUS_RANK.remove(&mut deps.storage, (Status::Building.code(), key)),
            _ => REQUESTS_BY_STATUS
                .save(&mut deps.storage, (Status::Review.code(), 1), &())
                .unwrap(),
        }
        let expected = match case {
            0 => ContractError::RequestActionIdOverflow,
            1 => ContractError::StatusHistoryIdOverflow,
            2 | 3 => ContractError::AuditInvariant,
            _ => ContractError::IndexInvariant,
        };
        unchanged(&mut deps, &builder, review("r", vec![1]), expected);
    }
}

fn history(actor: Addr, from: Status, to: Status) -> StatusHistoryRecord {
    StatusHistoryRecord {
        id: 1,
        request_id: 1,
        actor,
        from,
        to,
        reason: None,
        evidence_ids: vec![],
        height: 1,
        timestamp: Timestamp::from_seconds(1),
    }
}

#[test]
fn review_success_exact_order_actions_history_and_indexes() {
    let (mut deps, author, builder, _) = setup(Status::Building);
    for (id, kind) in [(2, EvidenceKind::Release), (1, EvidenceKind::Commit)] {
        EVIDENCE
            .save(
                &mut deps.storage,
                (1, id),
                &item(id, 1, builder.clone(), kind, 1),
            )
            .unwrap();
    }
    let mut env = mock_env();
    env.block.height = 22;
    env.block.time = Timestamp::from_seconds(33);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&builder, &[]),
        review(" ready ", vec![2, 1]),
    )
    .unwrap();
    assert!(response.messages.is_empty());
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(
        (
            request.status,
            request.builder,
            request.work_round,
            request.work_activity_height,
            request.updated_at
        ),
        (
            Status::Review,
            Some(builder.clone()),
            1,
            Some(7),
            env.block.time
        )
    );
    let first = REQUEST_ACTIONS.load(&deps.storage, (1, 1)).unwrap();
    assert_eq!(
        (
            first.actor,
            first.reason,
            first.height,
            first.timestamp,
            first.action
        ),
        (
            builder,
            Some("ready".into()),
            22,
            env.block.time,
            RequestAction::ReviewRequested {
                evidence_ids: vec![2, 1]
            }
        )
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (1, 2)).unwrap().action,
        RequestAction::StatusTransition {
            from: Status::Building,
            to: Status::Review
        }
    );
    let record = STATUS_HISTORY.load(&deps.storage, (1, 1)).unwrap();
    assert_eq!(
        (record.reason, record.evidence_ids, record.from, record.to),
        (
            Some("ready".into()),
            vec![2, 1],
            Status::Building,
            Status::Review
        )
    );
    assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap(), 3);
    assert_eq!(NEXT_STATUS_HISTORY_ID.load(&deps.storage, 1).unwrap(), 2);
    assert!(REQUESTS_BY_STATUS
        .may_load(&deps.storage, (Status::Building.code(), 1))
        .unwrap()
        .is_none());
    assert!(REQUESTS_BY_STATUS
        .may_load(&deps.storage, (Status::Review.code(), 1))
        .unwrap()
        .is_some());
    assert!(REQUESTS_BY_AUTHOR
        .may_load(&deps.storage, (&author, 1))
        .unwrap()
        .is_some());
    assert!(REQUESTS_BY_CATEGORY
        .may_load(&deps.storage, ("core", 1))
        .unwrap()
        .is_some());
}

#[test]
fn attestation_authority_status_reason_work_existing_and_predicate_matrix() {
    for case in 0..15 {
        let status = if case == 1 {
            Status::Building
        } else {
            Status::Review
        };
        let (mut deps, author, builder, verifier) = setup(status);
        seed_pair(&mut deps, &builder, &verifier);
        let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
        request.limits.max_attestation_evidence_refs = 2;
        let old = deps.api.addr_make("old-verifier");
        let (sender, reason, ids, expected) = match case {
            0 => (author, "r", vec![1, 2], ContractError::Unauthorized),
            1 => (
                verifier.clone(),
                "r",
                vec![1, 2],
                ContractError::InvalidStatusTransition,
            ),
            2 => (
                verifier.clone(),
                "",
                vec![1, 2],
                ContractError::InvalidReason,
            ),
            3 => (
                verifier.clone(),
                "   ",
                vec![1, 2],
                ContractError::InvalidReason,
            ),
            4 => (
                verifier.clone(),
                "ééééééééééé",
                vec![1, 2],
                ContractError::InvalidReason,
            ),
            5 => {
                request.builder = None;
                (
                    verifier.clone(),
                    "r",
                    vec![1, 2],
                    ContractError::InvalidBuilder,
                )
            }
            6 => {
                request.builder = Some(verifier.clone());
                (
                    verifier.clone(),
                    "r",
                    vec![1, 2],
                    ContractError::InvalidBuilder,
                )
            }
            7 => {
                request.work_round = 0;
                (
                    verifier.clone(),
                    "r",
                    vec![1, 2],
                    ContractError::MissingWorkActivity,
                )
            }
            8 => {
                request.work_activity_height = None;
                (
                    verifier.clone(),
                    "r",
                    vec![1, 2],
                    ContractError::MissingWorkActivity,
                )
            }
            9 => (
                verifier.clone(),
                "r",
                vec![],
                ContractError::InvalidEvidenceReferences,
            ),
            10 => (
                verifier.clone(),
                "r",
                vec![1, 1],
                ContractError::InvalidEvidenceReferences,
            ),
            11 => (
                verifier.clone(),
                "r",
                vec![1],
                ContractError::InvalidEvidenceReferences,
            ),
            12 => {
                EVIDENCE
                    .save(
                        &mut deps.storage,
                        (1, 2),
                        &item(2, 1, old, EvidenceKind::TestReport, 1),
                    )
                    .unwrap();
                (
                    verifier.clone(),
                    "r",
                    vec![1, 2],
                    ContractError::InvalidEvidenceReferences,
                )
            }
            13 => {
                EVIDENCE
                    .save(
                        &mut deps.storage,
                        (1, 1),
                        &item(1, 1, verifier.clone(), EvidenceKind::Commit, 1),
                    )
                    .unwrap();
                (
                    verifier.clone(),
                    "r",
                    vec![1, 2],
                    ContractError::InvalidEvidenceReferences,
                )
            }
            _ => {
                SHIPMENT_ATTESTATIONS
                    .save(
                        &mut deps.storage,
                        1,
                        &ShipmentAttestation {
                            verifier: verifier.clone(),
                            rationale: "old".into(),
                            evidence_ids: vec![1, 2],
                            work_round: 1,
                            submitted_at: Timestamp::from_seconds(1),
                            submitted_height: 1,
                        },
                    )
                    .unwrap();
                (
                    verifier.clone(),
                    "r",
                    vec![1, 2],
                    ContractError::AttestationExists,
                )
            }
        };
        REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
        unchanged(&mut deps, &sender, attest(reason, ids), expected);
    }
    let (mut deps, _, builder, verifier) = setup(Status::Review);
    seed_pair(&mut deps, &builder, &verifier);
    let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
    request.limits.max_attestation_evidence_refs = 2;
    REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
    unchanged(
        &mut deps,
        &verifier,
        attest("r", vec![1, 2, 3]),
        ContractError::InvalidEvidenceReferences,
    );
    EVIDENCE.remove(&mut deps.storage, (1, 2));
    unchanged(
        &mut deps,
        &verifier,
        attest("r", vec![1, 2]),
        ContractError::InvalidEvidenceReferences,
    );
}

#[test]
fn attestation_stale_cross_request_wrong_class_and_preflight_matrix() {
    for case in 0..10 {
        let (mut deps, _, builder, verifier) = setup(Status::Review);
        seed_pair(&mut deps, &builder, &verifier);
        let key = rank_key(Uint128::new(1), Uint128::zero(), 1);
        match case {
            0 => EVIDENCE
                .save(
                    &mut deps.storage,
                    (1, 1),
                    &item(1, 2, builder.clone(), EvidenceKind::Commit, 1),
                )
                .unwrap(),
            1 => EVIDENCE
                .save(
                    &mut deps.storage,
                    (1, 2),
                    &item(2, 1, verifier.clone(), EvidenceKind::TestReport, 2),
                )
                .unwrap(),
            2 => EVIDENCE
                .save(
                    &mut deps.storage,
                    (1, 2),
                    &item(2, 1, verifier.clone(), EvidenceKind::Commit, 1),
                )
                .unwrap(),
            3 => NEXT_REQUEST_ACTION_ID
                .save(&mut deps.storage, 1, &(u64::MAX - 1))
                .unwrap(),
            4 => NEXT_STATUS_HISTORY_ID
                .save(&mut deps.storage, 1, &u64::MAX)
                .unwrap(),
            5 => REQUEST_ACTIONS
                .save(
                    &mut deps.storage,
                    (1, 1),
                    &action_record(
                        1,
                        verifier.clone(),
                        RequestAction::ShipmentAttested {
                            evidence_ids: vec![1, 2],
                        },
                    ),
                )
                .unwrap(),
            6 => STATUS_HISTORY
                .save(
                    &mut deps.storage,
                    (1, 1),
                    &history(verifier.clone(), Status::Review, Status::Shipped),
                )
                .unwrap(),
            7 => REQUESTS_BY_STATUS.remove(&mut deps.storage, (Status::Review.code(), 1)),
            8 => {
                STATUS_CATEGORY_RANK.remove(&mut deps.storage, (Status::Review.code(), "core", key))
            }
            _ => REQUESTS_BY_STATUS
                .save(&mut deps.storage, (Status::Shipped.code(), 1), &())
                .unwrap(),
        }
        let expected = match case {
            0..=2 => ContractError::InvalidEvidenceReferences,
            3 => ContractError::RequestActionIdOverflow,
            4 => ContractError::StatusHistoryIdOverflow,
            5 | 6 => ContractError::AuditInvariant,
            _ => ContractError::IndexInvariant,
        };
        unchanged(&mut deps, &verifier, attest("r", vec![1, 2]), expected);
        assert!(SHIPMENT_ATTESTATIONS
            .may_load(&deps.storage, 1)
            .unwrap()
            .is_none());
    }
}

#[test]
fn attestation_success_is_complete_atomic_and_terminal() {
    let (mut deps, author, builder, verifier) = setup(Status::Review);
    seed_pair(&mut deps, &builder, &verifier);
    let mut env = mock_env();
    env.block.height = 88;
    env.block.time = Timestamp::from_seconds(99);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&verifier, &[]),
        attest(" criteria met ", vec![2, 1]),
    )
    .unwrap();
    assert!(response.messages.is_empty());
    assert_eq!(
        SHIPMENT_ATTESTATIONS.load(&deps.storage, 1).unwrap(),
        ShipmentAttestation {
            verifier: verifier.clone(),
            rationale: "criteria met".into(),
            evidence_ids: vec![2, 1],
            work_round: 1,
            submitted_at: env.block.time,
            submitted_height: 88
        }
    );
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(
        (
            request.status,
            request.builder,
            request.work_round,
            request.work_activity_height,
            request.updated_at
        ),
        (Status::Shipped, Some(builder), 1, Some(7), env.block.time)
    );
    let first = REQUEST_ACTIONS.load(&deps.storage, (1, 1)).unwrap();
    assert_eq!(
        (first.actor, first.reason, first.action),
        (
            verifier.clone(),
            Some("criteria met".into()),
            RequestAction::ShipmentAttested {
                evidence_ids: vec![2, 1]
            }
        )
    );
    assert_eq!(
        REQUEST_ACTIONS.load(&deps.storage, (1, 2)).unwrap().action,
        RequestAction::StatusTransition {
            from: Status::Review,
            to: Status::Shipped
        }
    );
    let h = STATUS_HISTORY.load(&deps.storage, (1, 1)).unwrap();
    assert_eq!(
        (h.reason, h.evidence_ids, h.from, h.to),
        (
            Some("criteria met".into()),
            vec![2, 1],
            Status::Review,
            Status::Shipped
        )
    );
    assert!(REQUESTS_BY_STATUS
        .may_load(&deps.storage, (Status::Review.code(), 1))
        .unwrap()
        .is_none());
    assert!(REQUESTS_BY_STATUS
        .may_load(&deps.storage, (Status::Shipped.code(), 1))
        .unwrap()
        .is_some());
    assert!(REQUESTS_BY_AUTHOR
        .may_load(&deps.storage, (&author, 1))
        .unwrap()
        .is_some());
    let before = snapshot(&deps.storage);
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&verifier, &[]),
            attest("again", vec![1, 2])
        )
        .unwrap_err(),
        ContractError::InvalidStatusTransition
    );
    assert_eq!(snapshot(&deps.storage), before);
}

#[test]
fn refund_unknown_wrong_author_bond_states_zero_and_spam_are_atomic() {
    for case in 0..7 {
        let status = if case == 6 {
            Status::Spam
        } else {
            Status::Qualified
        };
        let (mut deps, author, _, _) = setup(status);
        let outsider = deps.api.addr_make("outsider");
        let mut request = REQUESTS.load(&deps.storage, 1).unwrap();
        let (sender, id, expected) = match case {
            0 => (
                author.clone(),
                99,
                ContractError::UnknownRequest { request_id: 99 },
            ),
            1 => (outsider, 1, ContractError::Unauthorized),
            2 => {
                request.bond.state = BondState::Locked;
                (author.clone(), 1, ContractError::BondInvariant)
            }
            3 => {
                request.bond.state = BondState::Forfeited;
                (author.clone(), 1, ContractError::BondInvariant)
            }
            4 => {
                request.bond.state = BondState::Claimed;
                (author.clone(), 1, ContractError::BondInvariant)
            }
            5 => {
                request.bond.amount = Uint128::zero();
                (author.clone(), 1, ContractError::BondInvariant)
            }
            _ => {
                request.bond.state = BondState::Forfeited;
                (author.clone(), 1, ContractError::BondInvariant)
            }
        };
        REQUESTS.save(&mut deps.storage, 1, &request).unwrap();
        unchanged(
            &mut deps,
            &sender,
            ExecuteMsg::WithdrawRefund { request_id: id },
            expected,
        );
    }
}

#[test]
fn refund_aggregate_underflow_overflow_insolvency_and_action_preflights() {
    for case in 0..8 {
        let (mut deps, author, _, _) = setup(Status::Qualified);
        deps.querier
            .bank
            .update_balance(mock_env().contract.address, vec![coin(10, "ujuno")]);
        match case {
            0 => BOND_TOTALS
                .save(
                    &mut deps.storage,
                    &BondTotals {
                        locked: Uint128::zero(),
                        refundable: Uint128::new(9),
                        forfeited: Uint128::zero(),
                    },
                )
                .unwrap(),
            1 => BOND_TOTALS
                .save(
                    &mut deps.storage,
                    &BondTotals {
                        locked: Uint128::MAX,
                        refundable: Uint128::new(10),
                        forfeited: Uint128::zero(),
                    },
                )
                .unwrap(),
            2 => {
                deps.querier
                    .bank
                    .update_balance(mock_env().contract.address, vec![coin(9, "ujuno")]);
            }
            3 => {
                BOND_TOTALS
                    .save(
                        &mut deps.storage,
                        &BondTotals {
                            locked: Uint128::new(1),
                            refundable: Uint128::new(10),
                            forfeited: Uint128::new(1),
                        },
                    )
                    .unwrap();
                deps.querier
                    .bank
                    .update_balance(mock_env().contract.address, vec![coin(11, "ujuno")]);
            }
            4 => NEXT_REQUEST_ACTION_ID
                .save(&mut deps.storage, 1, &u64::MAX)
                .unwrap(),
            5 => NEXT_REQUEST_ACTION_ID
                .save(&mut deps.storage, 1, &(u64::MAX - 1))
                .unwrap(),
            6 | 7 => {
                let id = if case == 6 { 1 } else { 2 };
                REQUEST_ACTIONS
                    .save(
                        &mut deps.storage,
                        (1, id),
                        &action_record(
                            id,
                            author.clone(),
                            RequestAction::RefundWithdrawn {
                                amount: Uint128::new(10),
                            },
                        ),
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let expected = match case {
            0 => ContractError::BondInvariant,
            1 => ContractError::AggregateInvariant,
            2 | 3 => ContractError::Insolvent,
            4 | 5 => ContractError::RequestActionIdOverflow,
            _ => ContractError::AuditInvariant,
        };
        unchanged(
            &mut deps,
            &author,
            ExecuteMsg::WithdrawRefund { request_id: 1 },
            expected,
        );
    }
}

#[test]
fn refund_exact_solvent_surplus_all_refundable_statuses_and_double_claim() {
    for (index, status) in [
        Status::Qualified,
        Status::NotPrioritized,
        Status::Duplicate,
        Status::Archived,
        Status::Building,
        Status::Review,
        Status::Blocked,
        Status::Shipped,
    ]
    .into_iter()
    .enumerate()
    {
        let (mut deps, author, _, _) = setup(status.clone());
        let balance = if index % 2 == 0 { 10 } else { 99 };
        deps.querier.bank.update_balance(
            mock_env().contract.address,
            vec![coin(balance, "ujuno"), coin(500, "other")],
        );
        let before_history = STATUS_HISTORY
            .prefix(1)
            .range(&deps.storage, None, None, Order::Ascending)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let before_index = REQUESTS_BY_STATUS
            .may_load(&deps.storage, (status.code(), 1))
            .unwrap();
        let mut env = mock_env();
        env.block.height = 77;
        env.block.time = Timestamp::from_seconds(88);
        let response = execute(
            deps.as_mut(),
            env.clone(),
            message_info(&author, &[]),
            ExecuteMsg::WithdrawRefund { request_id: 1 },
        )
        .unwrap();
        assert_eq!(response.messages.len(), 1);
        assert_eq!(
            response.messages[0].msg,
            CosmosMsg::Bank(BankMsg::Send {
                to_address: author.to_string(),
                amount: vec![coin(10, "ujuno")]
            })
        );
        let request = REQUESTS.load(&deps.storage, 1).unwrap();
        assert_eq!(
            (request.status, request.bond.state, request.updated_at),
            (status.clone(), BondState::Claimed, env.block.time)
        );
        assert_eq!(
            BOND_TOTALS.load(&deps.storage).unwrap(),
            BondTotals {
                locked: Uint128::zero(),
                refundable: Uint128::zero(),
                forfeited: Uint128::zero()
            }
        );
        assert_eq!(NEXT_REQUEST_ACTION_ID.load(&deps.storage, 1).unwrap(), 3);
        assert_eq!(
            REQUEST_ACTIONS.load(&deps.storage, (1, 1)).unwrap(),
            RequestActionRecord {
                id: 1,
                request_id: 1,
                actor: author.clone(),
                action: RequestAction::BondTransition {
                    from: Some(BondState::Refundable),
                    to: BondState::Claimed,
                    amount: Uint128::new(10)
                },
                reason: None,
                height: 77,
                timestamp: env.block.time
            }
        );
        assert_eq!(
            REQUEST_ACTIONS.load(&deps.storage, (1, 2)).unwrap().action,
            RequestAction::RefundWithdrawn {
                amount: Uint128::new(10)
            }
        );
        assert_eq!(
            STATUS_HISTORY
                .prefix(1)
                .range(&deps.storage, None, None, Order::Ascending)
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
            before_history
        );
        assert_eq!(
            REQUESTS_BY_STATUS
                .may_load(&deps.storage, (status.code(), 1))
                .unwrap(),
            before_index
        );
        unchanged(
            &mut deps,
            &author,
            ExecuteMsg::WithdrawRefund { request_id: 1 },
            ContractError::BondInvariant,
        );
    }
}

#[test]
fn refund_preserves_nonrefundable_totals_and_all_indexes() {
    let (mut deps, author, _, _) = setup(Status::Duplicate);
    BOND_TOTALS
        .save(
            &mut deps.storage,
            &BondTotals {
                locked: Uint128::new(3),
                refundable: Uint128::new(10),
                forfeited: Uint128::new(4),
            },
        )
        .unwrap();
    deps.querier
        .bank
        .update_balance(mock_env().contract.address, vec![coin(17, "ujuno")]);
    let rank = rank_key(Uint128::new(1), Uint128::zero(), 1);
    execute(
        deps.as_mut(),
        mock_env(),
        message_info(&author, &[]),
        ExecuteMsg::WithdrawRefund { request_id: 1 },
    )
    .unwrap();
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap(),
        BondTotals {
            locked: Uint128::new(3),
            refundable: Uint128::zero(),
            forfeited: Uint128::new(4)
        }
    );
    assert!(REQUESTS_BY_AUTHOR
        .may_load(&deps.storage, (&author, 1))
        .unwrap()
        .is_some());
    assert!(REQUESTS_BY_CATEGORY
        .may_load(&deps.storage, ("core", 1))
        .unwrap()
        .is_some());
    assert!(REQUESTS_BY_STATUS
        .may_load(&deps.storage, (Status::Duplicate.code(), 1))
        .unwrap()
        .is_some());
    assert_eq!(
        STATUS_RANK
            .load(&deps.storage, (Status::Duplicate.code(), rank.clone()))
            .unwrap(),
        1
    );
    assert_eq!(
        STATUS_CATEGORY_RANK
            .load(&deps.storage, (Status::Duplicate.code(), "core", rank))
            .unwrap(),
        1
    );
}
