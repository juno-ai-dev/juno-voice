use crate::state::{
    Bond, BondState, BondTotals, Config, EvidenceKind, Request, RequestLimits, Status, BOND_TOTALS,
    CONFIG, EVIDENCE, NEXT_EVIDENCE_ID, NEXT_REQUEST_ACTION_ID, NEXT_STATUS_HISTORY_ID, REQUESTS,
    REQUESTS_BY_AUTHOR, REQUESTS_BY_CATEGORY, REQUESTS_BY_STATUS, SHIPMENT_ATTESTATIONS,
    STATUS_CATEGORY_RANK, STATUS_HISTORY, STATUS_RANK,
};
use crate::{
    bindings::JunoQuery, contract::execute, error::ContractError, msg::ExecuteMsg, rank::rank_key,
};
use cosmwasm_std::testing::{message_info, mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{coin, to_json_binary, Addr, OwnedDeps, Timestamp, Uint128};
pub(crate) type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>;
pub(crate) fn setup(status: Status) -> (TestDeps, Addr, Addr, Addr) {
    let api = MockApi::default();
    let author = api.addr_make("author");
    let builder = api.addr_make("builder");
    let verifier = api.addr_make("verifier");
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api,
        querier: MockQuerier::new(&[]),
        custom_query_type: std::marker::PhantomData,
    };
    CONFIG
        .save(
            &mut deps.storage,
            &Config {
                governor: deps.api.addr_make("governor"),
                pending_governor: None,
                steward: deps.api.addr_make("steward"),
                verifier: verifier.clone(),
                native_denom: "ujuno".into(),
                submission_bond: Uint128::new(10),
                voting_period_blocks: 10,
                quorum_bps: 1,
                support_bps: 1,
                work_inactivity_blocks: 10,
                request_limits: RequestLimits::default(),
                max_reason_bytes: 20,
                default_query_limit: 30,
                max_query_limit: 100,
                evidence_policy_version: 1,
                submissions_paused: true,
            },
        )
        .unwrap();
    let r = Request {
        id: 1,
        author: author.clone(),
        title: "t".into(),
        summary: "s".into(),
        acceptance_criteria: "a".into(),
        category: "core".into(),
        detail_uri: None,
        detail_digest: None,
        canonical_request_id: None,
        snapshot_height: 1,
        total_power: Uint128::new(1),
        opened_height: 2,
        closes_height: 3,
        quorum_bps: 1,
        support_bps: 1,
        work_inactivity_blocks: 10,
        limits: RequestLimits::default(),
        evidence_policy_version: 1,
        status: status.clone(),
        support_power: Uint128::new(1),
        oppose_power: Uint128::zero(),
        voter_count: 1,
        bond: Bond {
            amount: Uint128::new(10),
            state: BondState::Refundable,
        },
        builder: Some(builder.clone()),
        work_round: 1,
        work_activity_height: Some(7),
        created_at: Timestamp::from_seconds(1),
        updated_at: Timestamp::from_seconds(1),
    };
    REQUESTS.save(&mut deps.storage, 1, &r).unwrap();
    REQUESTS_BY_AUTHOR
        .save(&mut deps.storage, (&author, 1), &())
        .unwrap();
    REQUESTS_BY_CATEGORY
        .save(&mut deps.storage, ("core", 1), &())
        .unwrap();
    NEXT_EVIDENCE_ID.save(&mut deps.storage, 1, &1).unwrap();
    NEXT_REQUEST_ACTION_ID
        .save(&mut deps.storage, 1, &1)
        .unwrap();
    NEXT_STATUS_HISTORY_ID
        .save(&mut deps.storage, 1, &1)
        .unwrap();
    REQUESTS_BY_STATUS
        .save(&mut deps.storage, (status.code(), 1), &())
        .unwrap();
    let k = rank_key(r.support_power, r.oppose_power, 1);
    STATUS_RANK
        .save(&mut deps.storage, (status.code(), k.clone()), &1)
        .unwrap();
    STATUS_CATEGORY_RANK
        .save(&mut deps.storage, (status.code(), "core", k), &1)
        .unwrap();
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
    (deps, author, builder, verifier)
}
pub(crate) fn digest() -> String {
    format!("sha256:{}", "a".repeat(64))
}
pub(crate) fn add(kind: EvidenceKind) -> ExecuteMsg {
    ExecuteMsg::AddEvidence {
        request_id: 1,
        kind,
        uri: "https://x".into(),
        digest: digest(),
        note: "n".into(),
    }
}
#[test]
fn evidence_classes_are_disjoint_and_exhaustive() {
    use crate::execute::add_evidence::{is_delivery, is_verification};
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
    for (index, kind) in kinds.iter().enumerate() {
        assert_eq!(is_delivery(kind), index < 5);
        assert_eq!(is_verification(kind), index >= 5);
        assert_ne!(is_delivery(kind), is_verification(kind));
    }
}

#[test]
fn task_six_wire_and_funds_first() {
    assert_eq!(
        String::from_utf8(
            to_json_binary(&add(EvidenceKind::PullRequest))
                .unwrap()
                .to_vec()
        )
        .unwrap(),
        format!(
            r#"{{"add_evidence":{{"request_id":1,"kind":"pull_request","uri":"https://x","digest":"{}","note":"n"}}}}"#,
            digest()
        )
    );
    let review = ExecuteMsg::RequestReview {
        request_id: 1,
        reason: "r".into(),
        evidence_ids: vec![2, 1],
    };
    let attest = ExecuteMsg::AttestShipment {
        request_id: 1,
        rationale: "r".into(),
        evidence_ids: vec![1, 2],
    };
    let refund = ExecuteMsg::WithdrawRefund { request_id: 1 };
    assert_eq!(
        String::from_utf8(to_json_binary(&review).unwrap().to_vec()).unwrap(),
        r#"{"request_review":{"request_id":1,"reason":"r","evidence_ids":[2,1]}}"#
    );
    assert_eq!(
        String::from_utf8(to_json_binary(&attest).unwrap().to_vec()).unwrap(),
        r#"{"attest_shipment":{"request_id":1,"rationale":"r","evidence_ids":[1,2]}}"#
    );
    assert_eq!(
        String::from_utf8(to_json_binary(&refund).unwrap().to_vec()).unwrap(),
        r#"{"withdraw_refund":{"request_id":1}}"#
    );
    let (mut d, _, b, _) = setup(Status::Building);
    for message in [add(EvidenceKind::Commit), review, attest, refund] {
        assert_eq!(
            execute(
                d.as_mut(),
                mock_env(),
                message_info(&b, &[coin(1, "ujuno")]),
                message
            )
            .unwrap_err(),
            ContractError::UnexpectedFunds
        );
    }
}
#[test]
fn evidence_review_attestation_vertical_slice() {
    let (mut d, _, b, v) = setup(Status::Building);
    let mut e = mock_env();
    e.block.height = 20;
    e.block.time = Timestamp::from_seconds(20);
    execute(
        d.as_mut(),
        e.clone(),
        message_info(&b, &[]),
        add(EvidenceKind::Commit),
    )
    .unwrap();
    assert_eq!(EVIDENCE.load(&d.storage, (1, 1)).unwrap().work_round, 1);
    assert_eq!(
        REQUESTS.load(&d.storage, 1).unwrap().work_activity_height,
        Some(20)
    );
    execute(
        d.as_mut(),
        e.clone(),
        message_info(&b, &[]),
        ExecuteMsg::RequestReview {
            request_id: 1,
            reason: " ready ".into(),
            evidence_ids: vec![1],
        },
    )
    .unwrap();
    assert_eq!(
        STATUS_HISTORY
            .load(&d.storage, (1, 1))
            .unwrap()
            .evidence_ids,
        vec![1]
    );
    execute(
        d.as_mut(),
        e.clone(),
        message_info(&v, &[]),
        add(EvidenceKind::TestReport),
    )
    .unwrap();
    execute(
        d.as_mut(),
        e,
        message_info(&v, &[]),
        ExecuteMsg::AttestShipment {
            request_id: 1,
            rationale: " criteria met ".into(),
            evidence_ids: vec![1, 2],
        },
    )
    .unwrap();
    assert_eq!(
        REQUESTS.load(&d.storage, 1).unwrap().status,
        Status::Shipped
    );
    assert_eq!(
        SHIPMENT_ATTESTATIONS
            .load(&d.storage, 1)
            .unwrap()
            .evidence_ids,
        vec![1, 2]
    );
}
#[test]
fn evidence_rejects_bad_digest() {
    let (mut d, _, b, _) = setup(Status::Building);
    assert_eq!(
        execute(
            d.as_mut(),
            mock_env(),
            message_info(&b, &[]),
            ExecuteMsg::AddEvidence {
                request_id: 1,
                kind: EvidenceKind::Commit,
                uri: "https://x".into(),
                digest: "sha256:ABC".into(),
                note: "".into()
            }
        )
        .unwrap_err(),
        ContractError::InvalidEvidence
    );
}
#[test]
fn refund_rejects_wrong_author_and_insolvency_without_mutation() {
    let (mut deps, author, _, _) = setup(Status::Qualified);
    let outsider = deps.api.addr_make("outsider");
    let before = REQUESTS.load(&deps.storage, 1).unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&outsider, &[]),
            ExecuteMsg::WithdrawRefund { request_id: 1 },
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&author, &[]),
            ExecuteMsg::WithdrawRefund { request_id: 1 },
        )
        .unwrap_err(),
        ContractError::Insolvent
    );
    assert_eq!(REQUESTS.load(&deps.storage, 1).unwrap(), before);
    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap().refundable,
        Uint128::new(10)
    );
}

#[test]
fn refund_exact_pull() {
    let (mut d, a, _, _) = setup(Status::Duplicate);
    d.querier
        .bank
        .update_balance(mock_env().contract.address, vec![coin(10, "ujuno")]);
    let r = execute(
        d.as_mut(),
        mock_env(),
        message_info(&a, &[]),
        ExecuteMsg::WithdrawRefund { request_id: 1 },
    )
    .unwrap();
    assert_eq!(r.messages.len(), 1);
    assert_eq!(
        REQUESTS.load(&d.storage, 1).unwrap().bond.state,
        BondState::Claimed
    );
    assert_eq!(
        BOND_TOTALS.load(&d.storage).unwrap().refundable,
        Uint128::zero()
    );
    assert_eq!(
        execute(
            d.as_mut(),
            mock_env(),
            message_info(&a, &[]),
            ExecuteMsg::WithdrawRefund { request_id: 1 }
        )
        .unwrap_err(),
        ContractError::BondInvariant
    );
}
