use cosmwasm_std::testing::{message_info, mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{coin, Addr, Empty, OwnedDeps, Uint128};
use cw2::get_contract_version;

use crate::bindings::JunoQuery;
use crate::contract::{instantiate, CONTRACT_NAME, CONTRACT_VERSION};
use crate::error::ContractError;
use crate::msg::InstantiateMsg;
use crate::state::{
    BondTotals, RequestLimits, BOND_TOTALS, CONFIG, NEXT_PROTOCOL_ACTION_ID, NEXT_REQUEST_ID,
};

fn info(funds: &[cosmwasm_std::Coin]) -> cosmwasm_std::MessageInfo {
    message_info(&Addr::unchecked("creator"), funds)
}

fn deps() -> OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery> {
    OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier: MockQuerier::new(&[]),
        custom_query_type: std::marker::PhantomData,
    }
}

fn valid_msg() -> InstantiateMsg {
    let api = MockApi::default();
    InstantiateMsg {
        governor: api.addr_make("governor").into_string(),
        steward: api.addr_make("steward").into_string(),
        verifier: api.addr_make("verifier").into_string(),
        native_denom: "ujuno".to_owned(),
        submission_bond: Uint128::new(10_000_000),
        voting_period_blocks: 432_000,
        quorum_bps: 50,
        support_bps: 5_001,
        work_inactivity_blocks: 432_000,
        request_limits: RequestLimits::default(),
        max_reason_bytes: 1_024,
        default_query_limit: 30,
        max_query_limit: 100,
        evidence_policy_version: 1,
    }
}

fn err_for(change: impl FnOnce(&mut InstantiateMsg)) -> ContractError {
    let mut deps = deps();
    let mut msg = valid_msg();
    change(&mut msg);
    instantiate(deps.as_mut(), mock_env(), info(&[]), msg).unwrap_err()
}

#[test]
fn instantiate_stores_canonical_config_defaults_and_initial_state() {
    let mut deps = deps();
    let env = mock_env();
    let msg = valid_msg();

    let response = instantiate(deps.as_mut(), env.clone(), info(&[]), msg.clone()).unwrap();

    assert_eq!(response.attributes, vec![("action", "instantiate")]);
    let config = CONFIG.load(&deps.storage).unwrap();
    assert_eq!(config.governor, MockApi::default().addr_make("governor"));
    assert_eq!(config.pending_governor, None);
    assert_eq!(config.steward, MockApi::default().addr_make("steward"));
    assert_eq!(config.verifier, MockApi::default().addr_make("verifier"));
    assert_eq!(config.native_denom, "ujuno");
    assert_eq!(config.submission_bond, Uint128::new(10_000_000));
    assert_eq!(config.voting_period_blocks, 432_000);
    assert_eq!(config.quorum_bps, 50);
    assert_eq!(config.support_bps, 5_001);
    assert_eq!(config.work_inactivity_blocks, 432_000);
    assert_eq!(config.request_limits, RequestLimits::default());
    assert_eq!(config.max_reason_bytes, 1_024);
    assert_eq!(config.default_query_limit, 30);
    assert_eq!(config.max_query_limit, 100);
    assert_eq!(config.evidence_policy_version, 1);
    assert!(!config.submissions_paused);

    assert_eq!(RequestLimits::default().max_title_bytes, 120);
    assert_eq!(RequestLimits::default().max_summary_bytes, 2_000);
    assert_eq!(
        RequestLimits::default().max_acceptance_criteria_bytes,
        4_000
    );
    assert_eq!(RequestLimits::default().max_category_bytes, 32);
    assert_eq!(RequestLimits::default().max_uri_bytes, 512);
    assert_eq!(RequestLimits::default().max_digest_bytes, 71);
    assert_eq!(RequestLimits::default().max_evidence_note_bytes, 1_024);
    assert_eq!(RequestLimits::default().max_evidence_items, 64);
    assert_eq!(RequestLimits::default().max_review_evidence_refs, 16);
    assert_eq!(RequestLimits::default().max_attestation_evidence_refs, 16);

    assert_eq!(
        BOND_TOTALS.load(&deps.storage).unwrap(),
        BondTotals::default()
    );
    assert_eq!(NEXT_REQUEST_ID.load(&deps.storage).unwrap(), 1);
    assert_eq!(NEXT_PROTOCOL_ACTION_ID.load(&deps.storage).unwrap(), 1);
    let version = get_contract_version(&deps.storage).unwrap();
    assert_eq!(version.contract, CONTRACT_NAME);
    assert_eq!(version.version, CONTRACT_VERSION);
}

#[test]
fn instantiate_validates_each_role_but_does_not_invent_role_distinctions() {
    for invalid in ["", "x"] {
        assert!(matches!(
            err_for(|m| m.governor = invalid.to_owned()),
            ContractError::InvalidAddress { role: "governor" }
        ));
        assert!(matches!(
            err_for(|m| m.steward = invalid.to_owned()),
            ContractError::InvalidAddress { role: "steward" }
        ));
        assert!(matches!(
            err_for(|m| m.verifier = invalid.to_owned()),
            ContractError::InvalidAddress { role: "verifier" }
        ));
    }

    let mut deps = deps();
    let mut msg = valid_msg();
    let shared = MockApi::default().addr_make("shared-role").into_string();
    msg.governor = shared.clone();
    msg.steward = shared.clone();
    msg.verifier = shared;
    instantiate(deps.as_mut(), mock_env(), info(&[]), msg).unwrap();
}

#[test]
fn instantiate_rejects_funds_and_invalid_immutable_values() {
    let mut deps = deps();
    let err = instantiate(
        deps.as_mut(),
        mock_env(),
        info(&[coin(1, "ujuno")]),
        valid_msg(),
    )
    .unwrap_err();
    assert_eq!(err, ContractError::UnexpectedFunds);

    for denom in ["", "1bad", "ab", &"x".repeat(129)] {
        assert!(matches!(
            err_for(|m| m.native_denom = denom.to_owned()),
            ContractError::InvalidNativeDenom
        ));
    }
    assert!(matches!(
        err_for(|m| m.max_reason_bytes = 0),
        ContractError::InvalidRequestLimits { .. }
    ));
    assert!(matches!(
        err_for(|m| m.evidence_policy_version = 2),
        ContractError::UnsupportedEvidencePolicyVersion { version: 2 }
    ));
    assert!(matches!(
        err_for(|m| m.default_query_limit = 0),
        ContractError::InvalidQueryLimits
    ));
    assert!(matches!(
        err_for(|m| m.max_query_limit = 0),
        ContractError::InvalidQueryLimits
    ));
    assert!(matches!(
        err_for(|m| {
            m.default_query_limit = 101;
            m.max_query_limit = 100;
        }),
        ContractError::InvalidQueryLimits
    ));
}

#[test]
fn instantiate_rejects_zero_policy_and_out_of_range_thresholds() {
    assert!(matches!(
        err_for(|m| m.submission_bond = Uint128::zero()),
        ContractError::InvalidSubmissionBond
    ));
    assert!(matches!(
        err_for(|m| m.voting_period_blocks = 0),
        ContractError::InvalidVotingPeriod
    ));
    assert!(matches!(
        err_for(|m| m.work_inactivity_blocks = 0),
        ContractError::InvalidWorkInactivityPeriod
    ));
    for value in [0, 10_001] {
        assert!(matches!(
            err_for(|m| m.quorum_bps = value),
            ContractError::InvalidThreshold {
                field: "quorum_bps",
                ..
            }
        ));
        assert!(matches!(
            err_for(|m| m.support_bps = value),
            ContractError::InvalidThreshold {
                field: "support_bps",
                ..
            }
        ));
    }
}

#[test]
fn instantiate_enforces_evidence_policy_one_viability() {
    type LimitsChange = Box<dyn Fn(&mut RequestLimits)>;
    let cases: Vec<LimitsChange> = vec![
        Box::new(|l| l.max_title_bytes = 0),
        Box::new(|l| l.max_summary_bytes = 0),
        Box::new(|l| l.max_acceptance_criteria_bytes = 0),
        Box::new(|l| l.max_category_bytes = 0),
        Box::new(|l| l.max_uri_bytes = 8),
        Box::new(|l| l.max_digest_bytes = 70),
        Box::new(|l| l.max_evidence_note_bytes = 0),
        Box::new(|l| l.max_evidence_items = 1),
        Box::new(|l| l.max_review_evidence_refs = 0),
        Box::new(|l| l.max_attestation_evidence_refs = 1),
        Box::new(|l| {
            l.max_evidence_items = 2;
            l.max_review_evidence_refs = 3;
        }),
        Box::new(|l| {
            l.max_evidence_items = 2;
            l.max_attestation_evidence_refs = 3;
        }),
    ];
    for change in cases {
        assert!(matches!(
            err_for(|m| change(&mut m.request_limits)),
            ContractError::InvalidRequestLimits { .. }
        ));
    }

    let mut deps = deps();
    let mut msg = valid_msg();
    msg.request_limits.max_uri_bytes = 9;
    msg.request_limits.max_digest_bytes = 71;
    msg.request_limits.max_evidence_items = 2;
    msg.request_limits.max_review_evidence_refs = 1;
    msg.request_limits.max_attestation_evidence_refs = 2;
    instantiate(deps.as_mut(), mock_env(), info(&[]), msg).unwrap();
}

#[test]
fn instantiate_checks_close_height_arithmetic_before_writing() {
    let mut deps = deps();
    let mut env = mock_env();
    env.block.height = u64::MAX;
    let err = instantiate(deps.as_mut(), env, info(&[]), valid_msg()).unwrap_err();
    assert_eq!(err, ContractError::CloseHeightOverflow);
    assert!(CONFIG.may_load(&deps.storage).unwrap().is_none());
}

#[test]
fn instantiate_message_has_no_pending_governor_or_pause_inputs() {
    let json = cosmwasm_std::to_json_string(&valid_msg()).unwrap();
    assert!(!json.contains("pending_governor"));
    assert!(!json.contains("submissions_paused"));
    let _: Empty = Empty {};
}
