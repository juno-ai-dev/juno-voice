use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cosmwasm_std::testing::{mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{
    from_json, to_json_binary, Addr, Order, OwnedDeps, Storage, Timestamp, Uint128,
};

use crate::bindings::JunoQuery;
use crate::contract::query;
use crate::msg::{
    BondTotalsResponse, ConfigResponse, EvidenceResponse, ProtocolActionsResponse, QueryMsg,
    RankedRequestsResponse, RequestActionsResponse, RequestResponse, RequestsResponse,
    ShipmentAttestationResponse, StatusHistoryResponse, VoteResponse, VotesResponse,
};
use crate::rank::rank_key;
use crate::state::{
    Bond, BondState, BondTotals, Config, Evidence, EvidenceKind, ProtocolAction,
    ProtocolActionRecord, Request, RequestAction, RequestActionRecord, RequestLimits,
    ShipmentAttestation, Status, StatusHistoryRecord, VoteChoice, VoteReceipt, BOND_TOTALS, CONFIG,
    EVIDENCE, PROTOCOL_ACTIONS, REQUESTS, REQUESTS_BY_AUTHOR, REQUESTS_BY_CATEGORY,
    REQUESTS_BY_STATUS, REQUEST_ACTIONS, SHIPMENT_ATTESTATIONS, STATUS_CATEGORY_RANK,
    STATUS_HISTORY, STATUS_RANK, VOTES,
};

type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>;

fn setup() -> TestDeps {
    let mut deps = OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier: MockQuerier::new(&[]),
        custom_query_type: std::marker::PhantomData,
    };
    let config = Config {
        governor: deps.api.addr_make("governor"),
        pending_governor: None,
        steward: deps.api.addr_make("steward"),
        verifier: deps.api.addr_make("verifier"),
        native_denom: "ujuno".into(),
        submission_bond: Uint128::new(10),
        voting_period_blocks: 100,
        quorum_bps: 50,
        support_bps: 5_001,
        work_inactivity_blocks: 200,
        request_limits: RequestLimits::default(),
        max_reason_bytes: 100,
        default_query_limit: 2,
        max_query_limit: 3,
        evidence_policy_version: 1,
        submissions_paused: false,
    };
    CONFIG.save(&mut deps.storage, &config).unwrap();
    BOND_TOTALS
        .save(&mut deps.storage, &BondTotals::default())
        .unwrap();
    deps
}

fn sample_request(
    deps: &TestDeps,
    id: u64,
    status: Status,
    category: &str,
    author: &str,
) -> Request {
    Request {
        id,
        author: deps.api.addr_make(author),
        title: format!("Request {id}"),
        summary: "summary".into(),
        acceptance_criteria: "accepted".into(),
        category: category.into(),
        detail_uri: None,
        detail_digest: None,
        canonical_request_id: None,
        snapshot_height: 10,
        total_power: Uint128::new(100),
        opened_height: 11,
        closes_height: 111,
        quorum_bps: 50,
        support_bps: 5_001,
        work_inactivity_blocks: 200,
        limits: RequestLimits::default(),
        evidence_policy_version: 1,
        status,
        support_power: Uint128::zero(),
        oppose_power: Uint128::zero(),
        voter_count: 0,
        bond: Bond {
            amount: Uint128::new(10),
            state: BondState::Locked,
        },
        builder: None,
        work_round: 0,
        work_activity_height: None,
        created_at: mock_env().block.time,
        updated_at: mock_env().block.time,
    }
}

fn save_indexed_request(deps: &mut TestDeps, request: &Request) {
    REQUESTS
        .save(&mut deps.storage, request.id, request)
        .unwrap();
    REQUESTS_BY_STATUS
        .save(&mut deps.storage, (request.status.code(), request.id), &())
        .unwrap();
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
}

#[test]
fn query_messages_have_exact_public_json_shapes() {
    let cases = [
        (QueryMsg::Config {}, r#"{"config":{}}"#),
        (QueryMsg::BondTotals {}, r#"{"bond_totals":{}}"#),
        (QueryMsg::Request { id: 7 }, r#"{"request":{"id":7}}"#),
        (
            QueryMsg::ShipmentAttestation { request_id: 7 },
            r#"{"shipment_attestation":{"request_id":7}}"#,
        ),
        (
            QueryMsg::Requests {
                status: Some(1),
                category: Some("core".into()),
                author: Some("juno1author".into()),
                start_after_id: Some(4),
                limit: Some(10),
            },
            r#"{"requests":{"status":1,"category":"core","author":"juno1author","start_after_id":4,"limit":10}}"#,
        ),
        (
            QueryMsg::Vote {
                request_id: 7,
                voter: "juno1voter".into(),
            },
            r#"{"vote":{"request_id":7,"voter":"juno1voter"}}"#,
        ),
        (
            QueryMsg::Votes {
                request_id: 7,
                start_after_voter: Some("juno1voter".into()),
                limit: Some(2),
            },
            r#"{"votes":{"request_id":7,"start_after_voter":"juno1voter","limit":2}}"#,
        ),
        (
            QueryMsg::Evidence {
                request_id: 7,
                start_after_id: Some(1),
                limit: Some(2),
            },
            r#"{"evidence":{"request_id":7,"start_after_id":1,"limit":2}}"#,
        ),
        (
            QueryMsg::StatusHistory {
                request_id: 7,
                start_after_id: Some(1),
                limit: Some(2),
            },
            r#"{"status_history":{"request_id":7,"start_after_id":1,"limit":2}}"#,
        ),
        (
            QueryMsg::RequestActions {
                request_id: 7,
                start_after_id: Some(1),
                limit: Some(2),
            },
            r#"{"request_actions":{"request_id":7,"start_after_id":1,"limit":2}}"#,
        ),
        (
            QueryMsg::ProtocolActions {
                start_after_id: Some(1),
                limit: Some(2),
            },
            r#"{"protocol_actions":{"start_after_id":1,"limit":2}}"#,
        ),
        (
            QueryMsg::RankedRequests {
                status: 1,
                category: Some("core".into()),
                cursor: Some("opaque".into()),
                limit: Some(2),
            },
            r#"{"ranked_requests":{"status":1,"category":"core","cursor":"opaque","limit":2}}"#,
        ),
    ];

    for (msg, expected) in cases {
        assert_eq!(
            String::from_utf8(to_json_binary(&msg).unwrap().to_vec()).unwrap(),
            expected
        );
        let decoded: QueryMsg = from_json(expected.as_bytes()).unwrap();
        assert_eq!(decoded, msg);
    }
}

#[test]
fn direct_queries_have_required_and_optional_absence_semantics() {
    let mut deps = setup();
    let env = mock_env();
    let request = sample_request(&deps, 7, Status::Open, "core", "author");
    REQUESTS.save(&mut deps.storage, 7, &request).unwrap();

    let config: ConfigResponse =
        from_json(query(deps.as_ref(), env.clone(), QueryMsg::Config {}).unwrap()).unwrap();
    assert_eq!(config.config, CONFIG.load(&deps.storage).unwrap());
    let totals: BondTotalsResponse =
        from_json(query(deps.as_ref(), env.clone(), QueryMsg::BondTotals {}).unwrap()).unwrap();
    assert_eq!(totals.totals, BondTotals::default());
    let found: RequestResponse =
        from_json(query(deps.as_ref(), env.clone(), QueryMsg::Request { id: 7 }).unwrap()).unwrap();
    assert_eq!(found.request, request);
    assert!(query(deps.as_ref(), env.clone(), QueryMsg::Request { id: 999 }).is_err());

    let voter = deps.api.addr_make("voter").into_string();
    let vote: VoteResponse = from_json(
        query(
            deps.as_ref(),
            env.clone(),
            QueryMsg::Vote {
                request_id: 7,
                voter,
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(vote.vote, None);
    let attestation: ShipmentAttestationResponse = from_json(
        query(
            deps.as_ref(),
            env,
            QueryMsg::ShipmentAttestation { request_id: 7 },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(attestation.attestation, None);
}

#[test]
fn requests_pages_are_bounded_filtered_ascending_and_progress_sparse_candidates() {
    let mut deps = setup();
    for (id, status, category, author) in [
        (1, Status::Open, "core", "bob"),
        (2, Status::Open, "other", "bob"),
        (3, Status::Open, "core", "bob"),
        (4, Status::Qualified, "core", "alice"),
        (5, Status::Open, "core", "alice"),
    ] {
        let request = sample_request(&deps, id, status, category, author);
        save_indexed_request(&mut deps, &request);
    }
    let mut env = mock_env();
    env.block.height = 4242;
    let alice = deps.api.addr_make("alice").into_string();

    let page: RequestsResponse = from_json(
        query(
            deps.as_ref(),
            env.clone(),
            QueryMsg::Requests {
                status: Some(1),
                category: Some("core".into()),
                author: Some(alice.clone()),
                start_after_id: None,
                limit: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    // The configured default bounds candidate examination, not matching output.
    assert!(page.items.is_empty());
    assert_eq!(page.next_start_after, Some(2));
    assert_eq!(page.query_height, 4242);

    let page2: RequestsResponse = from_json(
        query(
            deps.as_ref(),
            env,
            QueryMsg::Requests {
                status: Some(1),
                category: Some("core".into()),
                author: Some(alice),
                start_after_id: page.next_start_after,
                limit: Some(3),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(page2.items.iter().map(|r| r.id).collect::<Vec<_>>(), [5]);
    assert_eq!(page2.next_start_after, None);

    for limit in [Some(0), Some(4)] {
        assert!(query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Requests {
                status: None,
                category: None,
                author: None,
                start_after_id: None,
                limit,
            }
        )
        .is_err());
    }
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::Requests {
            status: Some(0),
            category: None,
            author: None,
            start_after_id: None,
            limit: Some(1),
        }
    )
    .is_err());
}

#[test]
fn ranked_pages_use_literal_signed_rank_and_filter_bound_cursor_vectors() {
    let mut deps = setup();
    for (id, support, oppose, category) in [
        (7, 10_u128, 3_u128, "core"),
        (8, 4, 4, "core"),
        (9, 2, 5, "core"),
    ] {
        let mut request = sample_request(&deps, id, Status::Open, category, "author");
        request.support_power = Uint128::new(support);
        request.oppose_power = Uint128::new(oppose);
        save_indexed_request(&mut deps, &request);
        let key = rank_key(request.support_power, request.oppose_power, id);
        STATUS_RANK
            .save(&mut deps.storage, (1, key.clone()), &id)
            .unwrap();
        STATUS_CATEGORY_RANK
            .save(&mut deps.storage, (1, category, key), &id)
            .unwrap();
    }
    assert_eq!(
        rank_key(Uint128::new(10), Uint128::new(3), 7),
        vec![
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf8,
        ]
    );

    let first: RankedRequestsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: Some("core".into()),
                cursor: None,
                limit: Some(1),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(first.items[0].id, 7);
    assert_eq!(
        first.next_cursor.as_deref(),
        Some("AQABAQRjb3JlAQEAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAACv_________4")
    );
    let second: RankedRequestsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: Some("core".into()),
                cursor: first.next_cursor,
                limit: Some(2),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        second
            .items
            .iter()
            .map(|request| request.id)
            .collect::<Vec<_>>(),
        [8, 9]
    );
    assert_eq!(second.next_cursor, None);

    for (status, category, cursor) in [
        (
            2,
            Some("core".into()),
            "AQABAQRjb3JlAQEAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAACv_________4".into(),
        ),
        (
            1,
            Some("other".into()),
            "AQABAQRjb3JlAQEAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAACv_________4".into(),
        ),
        (1, Some("core".into()), "bad=".into()),
    ] {
        assert!(query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status,
                category,
                cursor: Some(cursor),
                limit: Some(1),
            }
        )
        .is_err());
    }
}

#[test]
fn votes_pages_are_exclusive_address_ordered_and_request_isolated() {
    let mut deps = setup();
    let mut voters = ["alpha", "beta", "gamma"]
        .map(|label| deps.api.addr_make(label))
        .to_vec();
    voters.sort();
    for (request_id, voter) in [
        (7, &voters[0]),
        (7, &voters[1]),
        (7, &voters[2]),
        (8, &voters[0]),
    ] {
        VOTES
            .save(
                &mut deps.storage,
                (request_id, voter),
                &VoteReceipt {
                    request_id,
                    voter: voter.clone(),
                    choice: VoteChoice::Support,
                    power: Uint128::new(1),
                    cast_height: 10,
                },
            )
            .unwrap();
    }
    let first: VotesResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Votes {
                request_id: 7,
                start_after_voter: None,
                limit: Some(1),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(first.items[0].voter, voters[0]);
    assert_eq!(first.next_start_after.as_deref(), Some(voters[0].as_str()));
    let second: VotesResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Votes {
                request_id: 7,
                start_after_voter: first.next_start_after,
                limit: Some(1),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].voter, voters[1]);
    assert_eq!(second.next_start_after.as_deref(), Some(voters[1].as_str()));
    let end: VotesResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Votes {
                request_id: 7,
                start_after_voter: second.next_start_after,
                limit: Some(3),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(end.items.len(), 1);
    assert_eq!(end.items[0].voter, voters[2]);
    assert_eq!(end.next_start_after, None);
    let empty: VotesResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Votes {
                request_id: 7,
                start_after_voter: Some(voters[2].to_string()),
                limit: Some(1),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert!(empty.items.is_empty());
    assert_eq!(empty.next_start_after, None);
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::Votes {
            request_id: 7,
            start_after_voter: Some("not-an-address".into()),
            limit: Some(1),
        }
    )
    .is_err());
}

#[test]
fn every_list_family_enforces_configured_limits_and_exact_height() {
    let deps = setup();
    let mut env = mock_env();
    env.block.height = 9_876;
    for limit in [None, Some(1), Some(3)] {
        let messages = vec![
            QueryMsg::Requests {
                status: None,
                category: None,
                author: None,
                start_after_id: None,
                limit,
            },
            QueryMsg::Votes {
                request_id: 1,
                start_after_voter: None,
                limit,
            },
            QueryMsg::Evidence {
                request_id: 1,
                start_after_id: None,
                limit,
            },
            QueryMsg::StatusHistory {
                request_id: 1,
                start_after_id: None,
                limit,
            },
            QueryMsg::RequestActions {
                request_id: 1,
                start_after_id: None,
                limit,
            },
            QueryMsg::ProtocolActions {
                start_after_id: None,
                limit,
            },
            QueryMsg::RankedRequests {
                status: 1,
                category: None,
                cursor: None,
                limit,
            },
        ];
        for msg in messages {
            let value = String::from_utf8(query(deps.as_ref(), env.clone(), msg).unwrap().to_vec())
                .unwrap();
            assert!(value.contains("\"query_height\":9876"));
        }
    }
    for limit in [Some(0), Some(4)] {
        let messages = vec![
            QueryMsg::Requests {
                status: None,
                category: None,
                author: None,
                start_after_id: None,
                limit,
            },
            QueryMsg::Votes {
                request_id: 1,
                start_after_voter: None,
                limit,
            },
            QueryMsg::Evidence {
                request_id: 1,
                start_after_id: None,
                limit,
            },
            QueryMsg::StatusHistory {
                request_id: 1,
                start_after_id: None,
                limit,
            },
            QueryMsg::RequestActions {
                request_id: 1,
                start_after_id: None,
                limit,
            },
            QueryMsg::ProtocolActions {
                start_after_id: None,
                limit,
            },
            QueryMsg::RankedRequests {
                status: 1,
                category: None,
                cursor: None,
                limit,
            },
        ];
        for msg in messages {
            assert!(query(deps.as_ref(), env.clone(), msg).is_err());
        }
    }
}

fn sample_evidence(request_id: u64, id: u64) -> Evidence {
    Evidence {
        id,
        request_id,
        submitter: Addr::unchecked("submitter"),
        kind: EvidenceKind::Commit,
        uri: "https://example.com/item".into(),
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        note: "note".into(),
        work_round: 1,
        submitted_at: Timestamp::from_seconds(1),
        submitted_height: 2,
    }
}
fn sample_history(request_id: u64, id: u64) -> StatusHistoryRecord {
    StatusHistoryRecord {
        id,
        request_id,
        actor: Addr::unchecked("actor"),
        from: Status::Open,
        to: Status::Qualified,
        reason: Some("reason".into()),
        evidence_ids: vec![],
        height: 2,
        timestamp: Timestamp::from_seconds(1),
    }
}
fn sample_request_action(request_id: u64, id: u64) -> RequestActionRecord {
    RequestActionRecord {
        id,
        request_id,
        actor: Addr::unchecked("actor"),
        action: RequestAction::Finalized { qualified: true },
        reason: None,
        height: 2,
        timestamp: Timestamp::from_seconds(1),
    }
}
fn sample_protocol_action(id: u64) -> ProtocolActionRecord {
    ProtocolActionRecord {
        id,
        actor: Addr::unchecked("actor"),
        action: ProtocolAction::SubmissionsPaused,
        reason: Some("reason".into()),
        height: 2,
        timestamp: Timestamp::from_seconds(1),
    }
}

#[test]
fn id_log_families_page_first_middle_end_empty_and_isolate_requests() {
    let mut deps = setup();
    for id in 1..=4 {
        EVIDENCE
            .save(&mut deps.storage, (7, id), &sample_evidence(7, id))
            .unwrap();
        STATUS_HISTORY
            .save(&mut deps.storage, (7, id), &sample_history(7, id))
            .unwrap();
        REQUEST_ACTIONS
            .save(&mut deps.storage, (7, id), &sample_request_action(7, id))
            .unwrap();
        PROTOCOL_ACTIONS
            .save(&mut deps.storage, id, &sample_protocol_action(id))
            .unwrap();
    }
    EVIDENCE
        .save(&mut deps.storage, (8, 1), &sample_evidence(8, 1))
        .unwrap();
    STATUS_HISTORY
        .save(&mut deps.storage, (8, 1), &sample_history(8, 1))
        .unwrap();
    REQUEST_ACTIONS
        .save(&mut deps.storage, (8, 1), &sample_request_action(8, 1))
        .unwrap();
    let first: EvidenceResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Evidence {
                request_id: 7,
                start_after_id: None,
                limit: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(first.items.iter().map(|x| x.id).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(first.next_start_after, Some(2));
    let middle: EvidenceResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Evidence {
                request_id: 7,
                start_after_id: first.next_start_after,
                limit: Some(1),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(middle.items[0].id, 3);
    assert_eq!(middle.next_start_after, Some(3));
    let end: EvidenceResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Evidence {
                request_id: 7,
                start_after_id: Some(3),
                limit: Some(3),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(end.items.iter().map(|x| x.id).collect::<Vec<_>>(), [4]);
    assert_eq!(end.next_start_after, None);
    let empty: EvidenceResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Evidence {
                request_id: 9,
                start_after_id: None,
                limit: Some(1),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert!(empty.items.is_empty());
    let history: StatusHistoryResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::StatusHistory {
                request_id: 7,
                start_after_id: Some(1),
                limit: Some(3),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        history.items.iter().map(|x| x.id).collect::<Vec<_>>(),
        [2, 3, 4]
    );
    assert!(history.items.iter().all(|x| x.request_id == 7));
    let actions: RequestActionsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RequestActions {
                request_id: 7,
                start_after_id: Some(1),
                limit: Some(3),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        actions.items.iter().map(|x| x.id).collect::<Vec<_>>(),
        [2, 3, 4]
    );
    assert!(actions.items.iter().all(|x| x.request_id == 7));
    let protocol: ProtocolActionsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::ProtocolActions {
                start_after_id: Some(1),
                limit: Some(2),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        protocol.items.iter().map(|x| x.id).collect::<Vec<_>>(),
        [2, 3]
    );
    assert_eq!(protocol.next_start_after, Some(3));
}

#[test]
fn list_record_keys_are_checked() {
    let mut deps = setup();
    let voter = deps.api.addr_make("voter");
    VOTES
        .save(
            &mut deps.storage,
            (7, &voter),
            &VoteReceipt {
                request_id: 8,
                voter: voter.clone(),
                choice: VoteChoice::Support,
                power: Uint128::new(1),
                cast_height: 1,
            },
        )
        .unwrap();
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::Votes {
            request_id: 7,
            start_after_voter: None,
            limit: Some(1)
        }
    )
    .is_err());
    EVIDENCE
        .save(&mut deps.storage, (7, 1), &sample_evidence(8, 99))
        .unwrap();
    STATUS_HISTORY
        .save(&mut deps.storage, (7, 1), &sample_history(8, 99))
        .unwrap();
    REQUEST_ACTIONS
        .save(&mut deps.storage, (7, 1), &sample_request_action(8, 99))
        .unwrap();
    PROTOCOL_ACTIONS
        .save(&mut deps.storage, 1, &sample_protocol_action(99))
        .unwrap();
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::Evidence {
            request_id: 7,
            start_after_id: None,
            limit: Some(1)
        }
    )
    .is_err());
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::StatusHistory {
            request_id: 7,
            start_after_id: None,
            limit: Some(1)
        }
    )
    .is_err());
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::RequestActions {
            request_id: 7,
            start_after_id: None,
            limit: Some(1)
        }
    )
    .is_err());
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::ProtocolActions {
            start_after_id: None,
            limit: Some(1)
        }
    )
    .is_err());
}

#[test]
fn requests_support_each_filter_and_reject_every_corrupt_index_path() {
    let mut deps = setup();
    for (id, status, category, author) in [
        (1, Status::Open, "core", "alice"),
        (2, Status::Qualified, "core", "bob"),
        (3, Status::Open, "other", "alice"),
    ] {
        let request = sample_request(&deps, id, status, category, author);
        save_indexed_request(&mut deps, &request);
    }
    let alice = deps.api.addr_make("alice").into_string();
    for (status, category, author, expected) in [
        (Some(1), None, None, vec![1, 3]),
        (None, Some("core".into()), None, vec![1, 2]),
        (None, None, Some(alice.clone()), vec![1, 3]),
        (Some(1), Some("core".into()), Some(alice), vec![1]),
    ] {
        let page: RequestsResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::Requests {
                    status,
                    category,
                    author,
                    start_after_id: None,
                    limit: Some(3),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            page.items.iter().map(|x| x.id).collect::<Vec<_>>(),
            expected
        );
    }
    for status in [0, 11, u8::MAX] {
        assert!(query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Requests {
                status: Some(status),
                category: None,
                author: None,
                start_after_id: None,
                limit: Some(1)
            }
        )
        .is_err());
    }
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::Requests {
            status: None,
            category: None,
            author: Some("bad".into()),
            start_after_id: None,
            limit: Some(1)
        }
    )
    .is_err());
    for missing in 0..3 {
        let mut corrupt = setup();
        let request = sample_request(&corrupt, 1, Status::Open, "core", "alice");
        save_indexed_request(&mut corrupt, &request);
        match missing {
            0 => REQUESTS_BY_STATUS.remove(&mut corrupt.storage, (1, 1)),
            1 => REQUESTS_BY_CATEGORY.remove(&mut corrupt.storage, ("core", 1)),
            _ => REQUESTS_BY_AUTHOR.remove(&mut corrupt.storage, (&request.author, 1)),
        }
        assert!(query(
            corrupt.as_ref(),
            mock_env(),
            QueryMsg::Requests {
                status: None,
                category: None,
                author: None,
                start_after_id: None,
                limit: Some(1)
            }
        )
        .is_err());
    }
    let mut stale = setup();
    REQUESTS_BY_STATUS
        .save(&mut stale.storage, (1, 77), &())
        .unwrap();
    assert!(query(
        stale.as_ref(),
        mock_env(),
        QueryMsg::Requests {
            status: Some(1),
            category: None,
            author: None,
            start_after_id: None,
            limit: Some(1)
        }
    )
    .is_err());
}

#[test]
fn ranking_no_category_orders_net_support_oldest_and_detects_corruption() {
    let mut deps = setup();
    for (id, support, oppose, category) in [
        (1, 9, 4, "a"),
        (2, 8, 3, "b"),
        (3, 5, 5, "a"),
        (4, 2, 4, "a"),
    ] {
        let mut request = sample_request(&deps, id, Status::Open, category, "author");
        request.support_power = Uint128::new(support);
        request.oppose_power = Uint128::new(oppose);
        save_indexed_request(&mut deps, &request);
        let key = rank_key(request.support_power, request.oppose_power, id);
        STATUS_RANK
            .save(&mut deps.storage, (1, key.clone()), &id)
            .unwrap();
        STATUS_CATEGORY_RANK
            .save(&mut deps.storage, (1, category, key), &id)
            .unwrap();
    }
    let first: RankedRequestsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: None,
                cursor: None,
                limit: Some(3),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        first.items.iter().map(|x| x.id).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert!(first.next_cursor.is_some());
    let end: RankedRequestsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: None,
                cursor: first.next_cursor,
                limit: Some(3),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(end.items.iter().map(|x| x.id).collect::<Vec<_>>(), [4]);
    assert_eq!(end.next_cursor, None);
    let request = REQUESTS.load(&deps.storage, 1).unwrap();
    let key = rank_key(request.support_power, request.oppose_power, 1);
    STATUS_CATEGORY_RANK.remove(&mut deps.storage, (1, "a", key));
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::RankedRequests {
            status: 1,
            category: None,
            cursor: None,
            limit: Some(1)
        }
    )
    .is_err());
}

#[test]
fn ranked_cursor_rejects_malformed_versions_lengths_utf8_and_filter_mismatch() {
    let deps = setup();
    let valid = "AQABAQRjb3JlAQEAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAACv_________4";
    let raw = URL_SAFE_NO_PAD.decode(valid).unwrap();
    let mut malformed = vec![
        "!".to_string(),
        format!("{valid}="),
        valid[..valid.len() - 1].to_string(),
    ];
    let mutate = |index: usize, value: u8| {
        let mut bytes = raw.clone();
        bytes[index] = value;
        URL_SAFE_NO_PAD.encode(bytes)
    };
    malformed.push(mutate(0, 2));
    malformed.push(mutate(2, 2));
    malformed.push(mutate(3, 0));
    malformed.push(mutate(4, 250));
    let mut bad_rank = raw.clone();
    bad_rank[9] = 2;
    malformed.push(URL_SAFE_NO_PAD.encode(bad_rank));
    let mut trailing = raw.clone();
    trailing.push(0);
    malformed.push(URL_SAFE_NO_PAD.encode(trailing));
    let mut utf8 = raw.clone();
    utf8[5] = 0xff;
    malformed.push(URL_SAFE_NO_PAD.encode(utf8));
    for cursor in malformed {
        assert!(query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: Some("core".into()),
                cursor: Some(cursor),
                limit: Some(1)
            }
        )
        .is_err());
    }
    for status in [0, 11] {
        assert!(query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status,
                category: None,
                cursor: None,
                limit: Some(1)
            }
        )
        .is_err());
    }
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::RankedRequests {
            status: 1,
            category: Some(String::new()),
            cursor: None,
            limit: Some(1)
        }
    )
    .is_err());
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::RankedRequests {
            status: 1,
            category: Some("x".repeat(256)),
            cursor: None,
            limit: Some(1)
        }
    )
    .is_err());
}

#[test]
fn ranked_cursor_rejects_encoded_input_over_frozen_bound_before_decode() {
    let deps = setup();
    for cursor in ["!".repeat(404), "A".repeat(1_000_000)] {
        let error = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: None,
                cursor: Some(cursor),
                limit: Some(1),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("cursor exceeds 403 bytes"));
    }

    let error = query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::RankedRequests {
            status: 1,
            category: None,
            cursor: Some("!".repeat(403)),
            limit: Some(1),
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("malformed cursor base64"));
}

#[test]
fn direct_optional_queries_return_present_records_and_reject_corrupt_direct_keys() {
    let mut deps = setup();
    let voter = deps.api.addr_make("voter");
    let receipt = VoteReceipt {
        request_id: 7,
        voter: voter.clone(),
        choice: VoteChoice::Support,
        power: Uint128::new(12),
        cast_height: 44,
    };
    VOTES
        .save(&mut deps.storage, (7, &voter), &receipt)
        .unwrap();
    let attestation = ShipmentAttestation {
        verifier: deps.api.addr_make("verifier"),
        rationale: "verified".into(),
        evidence_ids: vec![2, 3],
        work_round: 1,
        submitted_at: Timestamp::from_seconds(5),
        submitted_height: 55,
    };
    SHIPMENT_ATTESTATIONS
        .save(&mut deps.storage, 7, &attestation)
        .unwrap();

    let vote: VoteResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Vote {
                request_id: 7,
                voter: voter.to_string(),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(vote.vote, Some(receipt));
    let shipment: ShipmentAttestationResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::ShipmentAttestation { request_id: 7 },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(shipment.attestation, Some(attestation));
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::Vote {
            request_id: 7,
            voter: "invalid-address".into(),
        },
    )
    .is_err());

    let corrupt_request = sample_request(&deps, 8, Status::Open, "core", "author");
    REQUESTS
        .save(&mut deps.storage, 7, &corrupt_request)
        .unwrap();
    assert!(
        query(deps.as_ref(), mock_env(), QueryMsg::Request { id: 7 })
            .unwrap_err()
            .to_string()
            .contains("request key is inconsistent")
    );
    let corrupt_vote = VoteReceipt {
        request_id: 8,
        voter: deps.api.addr_make("other-voter"),
        choice: VoteChoice::Oppose,
        power: Uint128::new(1),
        cast_height: 45,
    };
    VOTES
        .save(&mut deps.storage, (7, &voter), &corrupt_vote)
        .unwrap();
    assert!(query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::Vote {
            request_id: 7,
            voter: voter.to_string(),
        },
    )
    .unwrap_err()
    .to_string()
    .contains("vote key is inconsistent"));
}

#[test]
fn requests_pages_prove_first_middle_end_empty_and_exclusive_tokens() {
    let mut deps = setup();
    for id in 1..=4 {
        let request = sample_request(&deps, id, Status::Open, "core", "author");
        save_indexed_request(&mut deps, &request);
    }
    let page = |start_after_id, limit| -> RequestsResponse {
        from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::Requests {
                    status: None,
                    category: None,
                    author: None,
                    start_after_id,
                    limit: Some(limit),
                },
            )
            .unwrap(),
        )
        .unwrap()
    };
    let first = page(None, 2);
    assert_eq!(
        first.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(first.next_start_after, Some(2));
    let middle = page(first.next_start_after, 1);
    assert_eq!(
        middle.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        [3]
    );
    assert_eq!(middle.next_start_after, Some(3));
    let end = page(middle.next_start_after, 3);
    assert_eq!(
        end.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        [4]
    );
    assert_eq!(end.next_start_after, None);
    let empty = page(Some(4), 1);
    assert!(empty.items.is_empty());
    assert_eq!(empty.next_start_after, None);
}

#[test]
fn every_id_log_handler_independently_proves_full_exclusive_pagination() {
    let mut deps = setup();
    for id in 1..=4 {
        EVIDENCE
            .save(&mut deps.storage, (7, id), &sample_evidence(7, id))
            .unwrap();
        STATUS_HISTORY
            .save(&mut deps.storage, (7, id), &sample_history(7, id))
            .unwrap();
        REQUEST_ACTIONS
            .save(&mut deps.storage, (7, id), &sample_request_action(7, id))
            .unwrap();
        PROTOCOL_ACTIONS
            .save(&mut deps.storage, id, &sample_protocol_action(id))
            .unwrap();
    }
    EVIDENCE
        .save(&mut deps.storage, (8, 99), &sample_evidence(8, 99))
        .unwrap();
    STATUS_HISTORY
        .save(&mut deps.storage, (8, 99), &sample_history(8, 99))
        .unwrap();
    REQUEST_ACTIONS
        .save(&mut deps.storage, (8, 99), &sample_request_action(8, 99))
        .unwrap();

    macro_rules! assert_local_pages {
        ($response:ty, $variant:ident) => {{
            let page = |start_after_id, limit| -> $response {
                from_json(
                    query(
                        deps.as_ref(),
                        mock_env(),
                        QueryMsg::$variant {
                            request_id: 7,
                            start_after_id,
                            limit: Some(limit),
                        },
                    )
                    .unwrap(),
                )
                .unwrap()
            };
            let first = page(None, 2);
            assert_eq!(
                first.items.iter().map(|item| item.id).collect::<Vec<_>>(),
                [1, 2]
            );
            assert_eq!(first.next_start_after, Some(2));
            let middle = page(first.next_start_after, 1);
            assert_eq!(
                middle.items.iter().map(|item| item.id).collect::<Vec<_>>(),
                [3]
            );
            assert_eq!(middle.next_start_after, Some(3));
            let end = page(middle.next_start_after, 3);
            assert_eq!(
                end.items.iter().map(|item| item.id).collect::<Vec<_>>(),
                [4]
            );
            assert_eq!(end.next_start_after, None);
            let empty = page(Some(4), 1);
            assert!(empty.items.is_empty());
            assert_eq!(empty.next_start_after, None);
        }};
    }
    assert_local_pages!(EvidenceResponse, Evidence);
    assert_local_pages!(StatusHistoryResponse, StatusHistory);
    assert_local_pages!(RequestActionsResponse, RequestActions);

    let page = |start_after_id, limit| -> ProtocolActionsResponse {
        from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ProtocolActions {
                    start_after_id,
                    limit: Some(limit),
                },
            )
            .unwrap(),
        )
        .unwrap()
    };
    let first = page(None, 2);
    assert_eq!(
        first.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(first.next_start_after, Some(2));
    let middle = page(first.next_start_after, 1);
    assert_eq!(
        middle.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        [3]
    );
    assert_eq!(middle.next_start_after, Some(3));
    let end = page(middle.next_start_after, 3);
    assert_eq!(
        end.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        [4]
    );
    assert_eq!(end.next_start_after, None);
    let empty = page(Some(4), 1);
    assert!(empty.items.is_empty());
    assert_eq!(empty.next_start_after, None);
}

#[test]
fn category_none_cursor_has_literal_zero_length_vector_and_oldest_id_breaks_exact_tie() {
    let mut deps = setup();
    for id in [7, 8] {
        let mut request = sample_request(&deps, id, Status::Open, "core", "author");
        request.support_power = Uint128::new(10);
        request.oppose_power = Uint128::new(3);
        save_indexed_request(&mut deps, &request);
        let key = rank_key(request.support_power, request.oppose_power, id);
        STATUS_RANK
            .save(&mut deps.storage, (1, key.clone()), &id)
            .unwrap();
        STATUS_CATEGORY_RANK
            .save(&mut deps.storage, (1, "core", key), &id)
            .unwrap();
    }
    let first: RankedRequestsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: None,
                cursor: None,
                limit: Some(1),
            },
        )
        .unwrap(),
    )
    .unwrap();
    let literal = "AQABAQABAQAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAK__________g";
    assert_eq!(first.items[0].id, 7);
    assert_eq!(first.next_cursor.as_deref(), Some(literal));
    assert_eq!(
        &URL_SAFE_NO_PAD.decode(literal).unwrap()[..5],
        &[1, 0, 1, 1, 0]
    );
    let end: RankedRequestsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::RankedRequests {
                status: 1,
                category: None,
                cursor: Some(literal.into()),
                limit: Some(2),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        end.items.iter().map(|item| item.id).collect::<Vec<_>>(),
        [8]
    );
    assert_eq!(end.next_cursor, None);
}

#[test]
fn representative_queries_do_not_mutate_storage() {
    let mut deps = setup();
    let request = sample_request(&deps, 1, Status::Open, "core", "author");
    save_indexed_request(&mut deps, &request);
    let key = rank_key(request.support_power, request.oppose_power, request.id);
    STATUS_RANK
        .save(&mut deps.storage, (1, key.clone()), &1)
        .unwrap();
    STATUS_CATEGORY_RANK
        .save(&mut deps.storage, (1, "core", key), &1)
        .unwrap();
    let before = deps
        .storage
        .range(None, None, Order::Ascending)
        .collect::<Vec<_>>();
    for msg in [
        QueryMsg::Config {},
        QueryMsg::Requests {
            status: Some(1),
            category: Some("core".into()),
            author: None,
            start_after_id: None,
            limit: Some(1),
        },
        QueryMsg::RankedRequests {
            status: 1,
            category: None,
            cursor: None,
            limit: Some(1),
        },
        QueryMsg::Evidence {
            request_id: 1,
            start_after_id: None,
            limit: Some(1),
        },
    ] {
        query(deps.as_ref(), mock_env(), msg).unwrap();
    }
    let after = deps
        .storage
        .range(None, None, Order::Ascending)
        .collect::<Vec<_>>();
    assert_eq!(before, after);
}
