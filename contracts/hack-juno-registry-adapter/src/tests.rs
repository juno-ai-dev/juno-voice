use cosmwasm_std::testing::{
    message_info, mock_dependencies, mock_env, MockApi, MockQuerier, MockStorage,
};
use cosmwasm_std::{
    coin, from_json, Addr, BankMsg, CosmosMsg, Decimal, Empty, Env, OwnedDeps, Response, Uint128,
};
use proptest::prelude::*;

use crate::contract::{execute, instantiate, query, sample_gauge_messages, DO_NOT_DISTRIBUTE};
use crate::error::ContractError;
use crate::msg::{
    AllOptionsResponse, EconomicConfigUpdate, ExecuteMsg, InstantiateMsg, OverrideStatus, QueryMsg,
    ReviewDecision, ReviewReason, ReviewReasonCode, StopScope,
};
use crate::state::{
    BondState, ProjectStatus, ACCOUNTING, ADDRESS_HISTORY, APPLICATIONS, CONFIG, OPTIONS, PROJECTS,
    SOURCE_BOUNTIES, STATUS_HISTORY,
};

type TestDeps = OwnedDeps<MockStorage, MockApi, MockQuerier, Empty>;

const GOVERNOR: &str = "governor";
const CURATOR: &str = "curator";
const BOUNTY: &str = "bounty";
const SPAM: &str = "spam-destination";
const APPLICANT: &str = "applicant";
const PAYOUT: &str = "payout";

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

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn reason(code: ReviewReasonCode) -> ReviewReason {
    ReviewReason {
        code,
        note: "Bounded typed review reason".into(),
    }
}

fn instantiate_msg() -> InstantiateMsg {
    InstantiateMsg {
        native_denom: "ujuno".into(),
        governor: address(GOVERNOR),
        curator: address(CURATOR),
        bounty_contract: address(BOUNTY),
        spam_destination: address(SPAM),
        registration_bond: Uint128::new(100),
        payout_address_delay_seconds: 1_000,
        epoch_ceiling: Uint128::new(1_000),
        min_project_share: Decimal::percent(10),
        max_project_share: Decimal::percent(40),
        max_selected_projects: 10,
        max_page_limit: 10,
        max_metadata_uri_bytes: 256,
        max_reason_bytes: 256,
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
        "hack_juno_registry.instantiated",
        &[
            "governor",
            "curator",
            "bounty_contract",
            "native_denom",
            "active_capacity",
            "reserved_option",
        ],
    );
    (deps, env)
}

fn register(deps: &mut TestDeps, env: &Env, id: &str, applicant: &str, payout: &str) {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(applicant), &[coin(100, "ujuno")]),
        ExecuteMsg::RegisterProject {
            project_id: id.into(),
            metadata_uri: format!("ipfs://{id}"),
            metadata_digest: digest('a'),
            payout_address: address(payout),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.project_registered",
        &["project_id", "applicant", "payout_address", "bond"],
    );
}

fn graduate(deps: &mut TestDeps, env: &Env, source: u64, id: &str, payout: &str) {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(BOUNTY), &[]),
        ExecuteMsg::Graduate {
            source_bounty_id: source,
            project_id: id.into(),
            metadata_uri: format!("ipfs://{id}"),
            metadata_digest: digest('b'),
            payout_address: address(payout),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.bounty_graduated",
        &[
            "project_id",
            "source_bounty_id",
            "bounty_contract",
            "payout_address",
        ],
    );
}

fn approve(deps: &mut TestDeps, env: &Env, id: &str) {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::ReviewRegistration {
            project_id: id.into(),
            decision: ReviewDecision::Approve,
            reason: reason(ReviewReasonCode::MeetsCriteria),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.registration_reviewed",
        &["project_id", "curator", "decision", "reason_code", "status"],
    );
}

#[test]
fn bonded_registration_is_exact_and_pending_is_not_a_gauge_option() {
    let (mut deps, env) = init();
    for funds in [vec![], vec![coin(99, "ujuno")], vec![coin(100, "uatom")]] {
        let err = execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(APPLICANT), &funds),
            ExecuteMsg::RegisterProject {
                project_id: "pending-project".into(),
                metadata_uri: "ipfs://pending".into(),
                metadata_digest: digest('a'),
                payout_address: address(PAYOUT),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::InvalidBond);
    }
    register(&mut deps, &env, "pending-project", APPLICANT, PAYOUT);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(APPLICANT), &[]),
        ExecuteMsg::UpdatePendingMetadata {
            project_id: "pending-project".into(),
            metadata_uri: "ipfs://pending-updated".into(),
            metadata_digest: digest('c'),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.pending_metadata_updated",
        &["project_id", "applicant"],
    );
    let project = PROJECTS.load(&deps.storage, "pending-project").unwrap();
    assert_eq!(project.status, ProjectStatus::Pending);
    assert!(APPLICATIONS.has(&deps.storage, "pending-project"));
    assert!(!OPTIONS.has(&deps.storage, "pending-project"));
    let accounting = ACCOUNTING.load(&deps.storage).unwrap();
    assert_eq!(accounting.pending_applications, 1);
    assert_eq!(accounting.bond_liability, Uint128::new(100));
    assert_eq!(accounting.active_projects, 0);
}

#[test]
fn graduation_authenticates_bounty_and_rejects_duplicate_id_and_source() {
    let (mut deps, env) = init();
    let unauthorized = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Graduate {
            source_bounty_id: 7,
            project_id: "graduated-project".into(),
            metadata_uri: "ipfs://graduated".into(),
            metadata_digest: digest('b'),
            payout_address: address(PAYOUT),
        },
    )
    .unwrap_err();
    assert_eq!(unauthorized, ContractError::Unauthorized);
    graduate(&mut deps, &env, 7, "graduated-project", PAYOUT);
    assert!(OPTIONS.has(&deps.storage, "graduated-project"));
    assert_eq!(
        SOURCE_BOUNTIES.load(&deps.storage, 7).unwrap(),
        "graduated-project"
    );
    let duplicate_id = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(BOUNTY), &[]),
        ExecuteMsg::Graduate {
            source_bounty_id: 8,
            project_id: "graduated-project".into(),
            metadata_uri: "ipfs://duplicate".into(),
            metadata_digest: digest('b'),
            payout_address: address(PAYOUT),
        },
    )
    .unwrap_err();
    assert_eq!(duplicate_id, ContractError::DuplicateProject);
    let duplicate_source = execute(
        deps.as_mut(),
        env,
        message_info(&addr(BOUNTY), &[]),
        ExecuteMsg::Graduate {
            source_bounty_id: 7,
            project_id: "different-project".into(),
            metadata_uri: "ipfs://different".into(),
            metadata_digest: digest('b'),
            payout_address: address(PAYOUT),
        },
    )
    .unwrap_err();
    assert_eq!(duplicate_source, ContractError::DuplicateSourceBounty);
}

#[test]
fn review_paths_preserve_bond_disposition_and_retirement_claim() {
    let (mut deps, env) = init();
    register(&mut deps, &env, "approved-project", APPLICANT, PAYOUT);
    approve(&mut deps, &env, "approved-project");
    assert_eq!(
        PROJECTS
            .load(&deps.storage, "approved-project")
            .unwrap()
            .status,
        ProjectStatus::Active
    );
    assert!(OPTIONS.has(&deps.storage, "approved-project"));

    register(
        &mut deps,
        &env,
        "soft-project",
        "soft-applicant",
        "soft-payout",
    );
    let soft = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::ReviewRegistration {
            project_id: "soft-project".into(),
            decision: ReviewDecision::SoftReject,
            reason: reason(ReviewReasonCode::IncompleteApplication),
        },
    )
    .unwrap();
    assert_eq!(soft.messages.len(), 1);
    assert_eq!(
        PROJECTS
            .load(&deps.storage, "soft-project")
            .unwrap()
            .bond
            .unwrap()
            .state,
        BondState::Refunded
    );

    register(
        &mut deps,
        &env,
        "spam-project",
        "spam-applicant",
        "spam-payout",
    );
    let hard = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::ReviewRegistration {
            project_id: "spam-project".into(),
            decision: ReviewDecision::HardReject,
            reason: reason(ReviewReasonCode::Spam),
        },
    )
    .unwrap();
    assert_eq!(hard.messages.len(), 1);
    assert_eq!(
        PROJECTS
            .load(&deps.storage, "spam-project")
            .unwrap()
            .bond
            .unwrap()
            .state,
        BondState::Forfeited
    );

    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Retire {
            project_id: "approved-project".into(),
            reason: reason(ReviewReasonCode::MeetsCriteria),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.project_retired",
        &["project_id", "actor", "bond_claimable"],
    );
    assert!(!OPTIONS.has(&deps.storage, "approved-project"));
    let claim = execute(
        deps.as_mut(),
        env,
        message_info(&addr(APPLICANT), &[]),
        ExecuteMsg::ClaimRegistrationBond {
            project_id: "approved-project".into(),
        },
    )
    .unwrap();
    assert_eq!(claim.messages.len(), 1);
    assert_wire_event(
        &claim,
        "hack_juno_registry.registration_bond_claimed",
        &["project_id", "depositor", "amount"],
    );
    let accounting = ACCOUNTING.load(&deps.storage).unwrap();
    assert_eq!(accounting.bond_liability, Uint128::zero());
    assert_eq!(accounting.lifetime_bonds_received, Uint128::new(300));
    assert_eq!(accounting.lifetime_bonds_refunded, Uint128::new(200));
    assert_eq!(accounting.lifetime_bonds_forfeited, Uint128::new(100));
}

#[test]
fn active_capacity_is_exactly_ninety_nine_and_never_truncates() {
    let (mut deps, env) = init();
    CONFIG
        .update(
            &mut deps.storage,
            |mut config| -> cosmwasm_std::StdResult<_> {
                config.max_page_limit = 100;
                Ok(config)
            },
        )
        .unwrap();
    for source in 1..=99 {
        graduate(
            &mut deps,
            &env,
            source,
            &format!("project-{source:03}"),
            &format!("payout-{source:03}"),
        );
        let active = ACCOUNTING.load(&deps.storage).unwrap().active_projects;
        assert_eq!(active, source as u32);
    }
    assert_eq!(
        OPTIONS
            .keys(&deps.storage, None, None, cosmwasm_std::Order::Ascending)
            .count(),
        100
    );
    let before = ACCOUNTING.load(&deps.storage).unwrap();
    let err = execute(
        deps.as_mut(),
        env,
        message_info(&addr(BOUNTY), &[]),
        ExecuteMsg::Graduate {
            source_bounty_id: 100,
            project_id: "project-100".into(),
            metadata_uri: "ipfs://project-100".into(),
            metadata_digest: digest('c'),
            payout_address: address("payout-100"),
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::CapacityFull);
    assert_eq!(ACCOUNTING.load(&deps.storage).unwrap(), before);
    assert!(!PROJECTS.has(&deps.storage, "project-100"));

    let options: AllOptionsResponse = from_json(
        query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::AllOptions {
                start_after: None,
                limit: Some(100),
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(options.options.len(), 100);
    assert!(options.options.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(options.options.contains(&DO_NOT_DISTRIBUTE.to_owned()));
}

#[test]
fn payout_address_change_has_delay_replacement_cancellation_and_acceptance() {
    let (mut deps, env) = init();
    graduate(&mut deps, &env, 1, "address-project", PAYOUT);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(PAYOUT), &[]),
        ExecuteMsg::ProposePayoutAddress {
            project_id: "address-project".into(),
            address: address("new-payout"),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.payout_address_proposed",
        &["project_id", "actor", "proposed_address", "executable_at"],
    );
    let early = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr("new-payout"), &[]),
        ExecuteMsg::AcceptPayoutAddress {
            project_id: "address-project".into(),
        },
    )
    .unwrap_err();
    assert_eq!(early, ContractError::AddressDelayOpen);

    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(PAYOUT), &[]),
        ExecuteMsg::ProposePayoutAddress {
            project_id: "address-project".into(),
            address: address("replacement-payout"),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.payout_address_proposed",
        &["project_id", "actor", "proposed_address", "executable_at"],
    );
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(PAYOUT), &[]),
        ExecuteMsg::CancelPayoutAddressChange {
            project_id: "address-project".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.payout_address_cancelled",
        &["project_id", "actor", "cancelled_address"],
    );
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(PAYOUT), &[]),
        ExecuteMsg::ProposePayoutAddress {
            project_id: "address-project".into(),
            address: address("final-payout"),
        },
    )
    .unwrap();
    let mut ready = env;
    ready.block.time = ready.block.time.plus_seconds(1_000);
    let response = execute(
        deps.as_mut(),
        ready,
        message_info(&addr("final-payout"), &[]),
        ExecuteMsg::AcceptPayoutAddress {
            project_id: "address-project".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.payout_address_accepted",
        &["project_id", "old_address", "new_address"],
    );
    let project = PROJECTS.load(&deps.storage, "address-project").unwrap();
    assert_eq!(project.id, "address-project");
    assert_eq!(project.payout_address, addr("final-payout"));
    assert_eq!(project.address_history_count, 5);
    assert_eq!(
        ADDRESS_HISTORY
            .prefix("address-project")
            .range(&deps.storage, None, None, cosmwasm_std::Order::Ascending)
            .count(),
        5
    );
}

#[test]
fn suspension_after_tally_suppresses_send_and_only_governor_reactivates() {
    let (mut deps, env) = init();
    graduate(&mut deps, &env, 1, "suspend-project", PAYOUT);
    let before = sample_gauge_messages(
        &deps.storage,
        vec![("suspend-project".into(), Decimal::percent(40))],
        Uint128::new(1_000),
        Uint128::new(1_000),
        "ujuno".into(),
    )
    .unwrap();
    assert_eq!(before.execute.len(), 1);
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Suspend {
            project_id: "suspend-project".into(),
            reason: reason(ReviewReasonCode::PolicyViolation),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.project_suspended",
        &["project_id", "curator", "reason_code"],
    );
    let after = sample_gauge_messages(
        &deps.storage,
        vec![("suspend-project".into(), Decimal::percent(40))],
        Uint128::new(1_000),
        Uint128::new(1_000),
        "ujuno".into(),
    )
    .unwrap();
    assert!(after.execute.is_empty());
    assert_eq!(after.retained_value, Uint128::new(1_000));
    let curator_resume = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::OverrideProjectStatus {
            project_id: "suspend-project".into(),
            status: OverrideStatus::Active,
            reason: reason(ReviewReasonCode::GovernanceOverride),
        },
    )
    .unwrap_err();
    assert_eq!(curator_resume, ContractError::Unauthorized);
    let response = execute(
        deps.as_mut(),
        env,
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::OverrideProjectStatus {
            project_id: "suspend-project".into(),
            status: OverrideStatus::Active,
            reason: reason(ReviewReasonCode::GovernanceOverride),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.project_status_overridden",
        &["project_id", "governor", "status", "reason_code"],
    );
    assert!(OPTIONS.has(&deps.storage, "suspend-project"));
}

#[test]
fn adapter_enforces_budget_floor_cap_threshold_dust_abstention_and_errors() {
    let (mut deps, env) = init();
    graduate(&mut deps, &env, 1, "large-share", "large-payout");
    graduate(&mut deps, &env, 2, "small-share", "small-payout");
    let sampled = sample_gauge_messages(
        &deps.storage,
        vec![
            ("large-share".into(), Decimal::percent(50)),
            ("small-share".into(), Decimal::percent(5)),
            (DO_NOT_DISTRIBUTE.into(), Decimal::percent(20)),
        ],
        Uint128::new(1_000),
        Uint128::new(1_000),
        "ujuno".into(),
    )
    .unwrap();
    assert_eq!(sampled.emitted_value, Uint128::new(400));
    assert_eq!(sampled.retained_value, Uint128::new(600));
    assert_eq!(sampled.execute.len(), 1);
    assert_bank_send(
        &sampled.execute[0],
        &addr("large-payout"),
        Uint128::new(400),
    );

    let floor = sample_gauge_messages(
        &deps.storage,
        vec![("large-share".into(), Decimal::from_ratio(1u128, 3u128))],
        Uint128::new(100),
        Uint128::new(100),
        "ujuno".into(),
    )
    .unwrap();
    assert_eq!(floor.emitted_value, Uint128::new(33));
    let dust = sample_gauge_messages(
        &deps.storage,
        vec![("large-share".into(), Decimal::percent(10))],
        Uint128::new(1),
        Uint128::new(1),
        "ujuno".into(),
    )
    .unwrap();
    assert!(dust.execute.is_empty());

    for (result, expected) in [
        (
            sample_gauge_messages(
                &deps.storage,
                vec![("large-share".into(), Decimal::percent(20))],
                Uint128::new(1_000),
                Uint128::new(1_000),
                "uatom".into(),
            ),
            ContractError::WrongDenom,
        ),
        (
            sample_gauge_messages(
                &deps.storage,
                vec![("large-share".into(), Decimal::percent(20))],
                Uint128::new(1_001),
                Uint128::new(1_001),
                "ujuno".into(),
            ),
            ContractError::EpochCeilingExceeded,
        ),
        (
            sample_gauge_messages(
                &deps.storage,
                vec![("large-share".into(), Decimal::percent(20))],
                Uint128::new(1_000),
                Uint128::new(999),
                "ujuno".into(),
            ),
            ContractError::InsufficientAvailableBalance,
        ),
    ] {
        assert_eq!(result.unwrap_err(), expected);
    }
    assert!(matches!(
        sample_gauge_messages(
            &deps.storage,
            vec![
                ("large-share".into(), Decimal::percent(20)),
                ("large-share".into(), Decimal::percent(20)),
            ],
            Uint128::new(1_000),
            Uint128::new(1_000),
            "ujuno".into(),
        ),
        Err(ContractError::InvalidAllocation(_))
    ));
    assert!(matches!(
        sample_gauge_messages(
            &deps.storage,
            vec![("unknown-project".into(), Decimal::percent(20))],
            Uint128::new(1_000),
            Uint128::new(1_000),
            "ujuno".into(),
        ),
        Err(ContractError::InvalidAllocation(_))
    ));

    CONFIG
        .update(
            &mut deps.storage,
            |mut config| -> Result<_, ContractError> {
                config.max_selected_projects = 1;
                Ok(config)
            },
        )
        .unwrap();
    for selected in [
        vec![
            ("large-share".into(), Decimal::percent(20)),
            ("small-share".into(), Decimal::percent(20)),
        ],
        vec![
            ("large-share".into(), Decimal::percent(20)),
            ("small-share".into(), Decimal::percent(20)),
            (DO_NOT_DISTRIBUTE.into(), Decimal::percent(20)),
        ],
    ] {
        assert!(matches!(
            sample_gauge_messages(
                &deps.storage,
                selected,
                Uint128::new(1_000),
                Uint128::new(1_000),
                "ujuno".into(),
            ),
            Err(ContractError::InvalidAllocation(_))
        ));
    }

    execute(
        deps.as_mut(),
        env,
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Stop {
            scope: StopScope::Adapter,
            reason: "Emergency stop".into(),
        },
    )
    .unwrap();
    assert_eq!(
        sample_gauge_messages(
            &deps.storage,
            vec![],
            Uint128::new(1_000),
            Uint128::new(1_000),
            "ujuno".into(),
        )
        .unwrap_err(),
        ContractError::AdapterStopped
    );
}

#[test]
fn curator_stop_is_one_way_and_governor_controls_economic_recovery() {
    let (mut deps, env) = init();
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Stop {
            scope: StopScope::All,
            reason: "Bounded safety stop".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.stopped",
        &["actor", "scope", "reason"],
    );
    let register_error = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(APPLICANT), &[coin(100, "ujuno")]),
        ExecuteMsg::RegisterProject {
            project_id: "stopped-project".into(),
            metadata_uri: "ipfs://stopped".into(),
            metadata_digest: digest('a'),
            payout_address: address(PAYOUT),
        },
    )
    .unwrap_err();
    assert_eq!(register_error, ContractError::AdmissionsStopped);
    let resume_error = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Resume {
            scope: StopScope::All,
            reason: "curator cannot resume".into(),
        },
    )
    .unwrap_err();
    assert_eq!(resume_error, ContractError::Unauthorized);
    let response = execute(
        deps.as_mut(),
        env,
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::Resume {
            scope: StopScope::All,
            reason: "Governor recovery".into(),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.resumed",
        &["governor", "scope", "reason"],
    );
}

#[test]
fn governance_configuration_events_have_stable_wire_contracts() {
    let (mut deps, env) = init();
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UpdateCurator {
            curator: address("replacement-curator"),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.curator_updated",
        &["governor", "curator", "changed_at"],
    );

    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UpdateBountyContract {
            bounty_contract: address("replacement-bounty"),
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.bounty_contract_updated",
        &["governor", "bounty_contract", "changed_at"],
    );

    let response = execute(
        deps.as_mut(),
        env,
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UpdateEconomicConfig {
            update: EconomicConfigUpdate {
                registration_bond: Some(Uint128::new(200)),
                spam_destination: None,
                payout_address_delay_seconds: None,
                epoch_ceiling: Some(Uint128::new(2_000)),
                min_project_share: None,
                max_project_share: None,
                max_selected_projects: None,
            },
        },
    )
    .unwrap();
    assert_wire_event(
        &response,
        "hack_juno_registry.economic_config_updated",
        &["governor", "config_version", "changed_at"],
    );
}

fn assert_bank_send(msg: &CosmosMsg, recipient: &Addr, amount: Uint128) {
    match msg {
        CosmosMsg::Bank(BankMsg::Send {
            to_address,
            amount: coins,
        }) => {
            assert_eq!(to_address, recipient.as_str());
            assert_eq!(coins.as_slice(), &[coin(amount.u128(), "ujuno")]);
        }
        other => panic!("unexpected adapter message: {other:?}"),
    }
}

proptest! {
    #[test]
    fn arbitrary_valid_allocations_never_exceed_budget_or_leave_native_send_boundary(
        raw_shares in prop::collection::vec(0u8..=100, 0..=5),
        budget in 1u128..=1_000,
    ) {
        let (mut deps, env) = init();
        for index in 0..5 {
            graduate(
                &mut deps,
                &env,
                index + 1,
                &format!("property-project-{index}"),
                &format!("property-payout-{index}"),
            );
        }
        let mut remaining = 100u8;
        let mut selected = Vec::new();
        for (index, raw) in raw_shares.into_iter().enumerate() {
            if remaining == 0 {
                break;
            }
            let percent = raw.min(remaining);
            if percent == 0 {
                continue;
            }
            remaining -= percent;
            selected.push((
                format!("property-project-{index}"),
                Decimal::percent(percent as u64),
            ));
        }
        let sampled = sample_gauge_messages(
            &deps.storage,
            selected,
            Uint128::new(budget),
            Uint128::new(budget),
            "ujuno".into(),
        ).unwrap();
        prop_assert!(sampled.emitted_value <= Uint128::new(budget));
        prop_assert_eq!(sampled.emitted_value + sampled.retained_value, Uint128::new(budget));
        prop_assert!(sampled.execute.len() <= 5);
        for message in sampled.execute {
            match message {
                CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
                    prop_assert!(to_address.starts_with("cosmwasm1"));
                    prop_assert_eq!(amount.len(), 1);
                    prop_assert_eq!(amount[0].denom.as_str(), "ujuno");
                    prop_assert!(!amount[0].amount.is_zero());
                }
                other => prop_assert!(false, "non-bank adapter output: {other:?}"),
            }
        }
    }
}

#[test]
fn typed_histories_are_scoped_and_stably_sequenced() {
    let (mut deps, env) = init();
    register(&mut deps, &env, "history-project", APPLICANT, PAYOUT);
    approve(&mut deps, &env, "history-project");
    let project = PROJECTS.load(&deps.storage, "history-project").unwrap();
    assert_eq!(project.status_history_count, 2);
    let entries: Vec<_> = STATUS_HISTORY
        .prefix("history-project")
        .range(&deps.storage, None, None, cosmwasm_std::Order::Ascending)
        .map(|entry| entry.unwrap().1)
        .collect();
    assert_eq!(entries[0].sequence, 1);
    assert_eq!(entries[1].sequence, 2);
    assert_eq!(entries[0].to, ProjectStatus::Pending);
    assert_eq!(entries[1].to, ProjectStatus::Active);
}
