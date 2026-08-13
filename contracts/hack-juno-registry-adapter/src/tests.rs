use cosmwasm_std::testing::{
    message_info, mock_dependencies, mock_env, MockApi, MockQuerier, MockStorage,
};
use cosmwasm_std::{
    coin, from_json, Addr, BankMsg, CosmosMsg, Decimal, Empty, Env, Order, OwnedDeps, Response,
    Uint128,
};
use proptest::prelude::*;

use crate::contract::{
    decode_project_option, encode_project_option, execute, instantiate, query,
    sample_gauge_messages, validate_project_transition, ProjectTransition, DO_NOT_DISTRIBUTE,
};
use crate::error::ContractError;
use crate::msg::{
    EconomicConfigUpdate, ExecuteMsg, IdentityStateResponse, InstantiateMsg, OverrideStatus,
    ProjectCreatedResponse, ReviewDecision, ReviewReason, ReviewReasonCode, StopScope,
};
use crate::state::{
    AdmissionProvenance, BondState, Project, ProjectStatus, RegistrationBond, RegistryAccounting,
    ACCOUNTING, APPLICATIONS, CONFIG, NEXT_PROJECT_ID, OPTIONS, PROJECTS, SOURCE_BOUNTIES,
    SOURCE_BOUNTY_COUNT,
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

fn assert_wire_event(response: &Response, event_type: &str, keys: &[&str]) {
    let event = response
        .events
        .iter()
        .find(|event| event.ty == event_type)
        .unwrap_or_else(|| panic!("missing event {event_type}"));
    assert_eq!(
        event
            .attributes
            .iter()
            .map(|attribute| attribute.key.as_str())
            .collect::<Vec<_>>(),
        keys
    );
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
    assert_eq!(NEXT_PROJECT_ID.load(&deps.storage).unwrap(), 1);
    assert!(OPTIONS.has(&deps.storage, DO_NOT_DISTRIBUTE));
    (deps, env)
}

fn assigned(response: &Response) -> u64 {
    let data = response.data.as_ref().expect("assigned project response");
    let created: ProjectCreatedResponse = from_json(data).unwrap();
    assert_eq!(created.response_version, 1);
    created.project_id
}

fn sync_registry_balance(deps: &mut TestDeps, env: &Env) {
    let liability = ACCOUNTING.load(&deps.storage).unwrap().bond_liability;
    deps.querier.bank.update_balance(
        env.contract.address.clone(),
        vec![coin(liability.u128(), "ujuno")],
    );
}

fn assert_transition_invariants(deps: &TestDeps, env: &Env) {
    let accounting = ACCOUNTING.load(&deps.storage).unwrap();
    let actual_balance = deps
        .as_ref()
        .querier
        .query_balance(env.contract.address.clone(), "ujuno")
        .unwrap()
        .amount;
    let mut active = 0u32;
    let mut pending = 0u64;
    let mut liability = Uint128::zero();

    for item in PROJECTS.range(&deps.storage, None, None, Order::Ascending) {
        let (id, project) = item.unwrap();
        let option_present = OPTIONS.has(&deps.storage, &encode_project_option(id).unwrap());
        let application_present = APPLICATIONS.has(&deps.storage, id);
        assert_eq!(option_present, project.status == ProjectStatus::Active);
        assert_eq!(
            application_present,
            project.status == ProjectStatus::Pending
        );
        if project.status == ProjectStatus::Active {
            active += 1;
        }
        if project.status == ProjectStatus::Pending {
            pending += 1;
        }

        match (&project.provenance, project.bond.as_ref()) {
            (AdmissionProvenance::BondedRegistration { .. }, Some(bond)) => {
                if matches!(
                    project.status,
                    ProjectStatus::Active | ProjectStatus::Suspended
                ) {
                    assert_eq!(bond.state, BondState::Deposited);
                }
                if matches!(bond.state, BondState::Deposited | BondState::Claimable) {
                    liability = liability.checked_add(bond.amount).unwrap();
                } else {
                    assert!(!option_present);
                }
            }
            (AdmissionProvenance::GraduatedBounty { .. }, None) => {}
            _ => panic!("project provenance and bond shape diverged"),
        }
    }

    assert_eq!(accounting.active_projects, active);
    assert_eq!(accounting.pending_applications, pending);
    assert_eq!(accounting.bond_liability, liability);
    assert!(accounting.bond_liability <= actual_balance);
}

#[derive(Clone, Copy, Debug)]
enum ProvenanceCase {
    Bonded,
    Graduated,
}

fn transition_expected(
    provenance: ProvenanceCase,
    status: &ProjectStatus,
    bond: Option<&BondState>,
    transition: ProjectTransition,
) -> bool {
    matches!(
        (provenance, status, bond, transition),
        (
            ProvenanceCase::Bonded,
            ProjectStatus::Pending,
            Some(BondState::Deposited),
            ProjectTransition::ReviewNoChange
                | ProjectTransition::Approve
                | ProjectTransition::SoftReject
                | ProjectTransition::HardReject,
        ) | (
            ProvenanceCase::Bonded,
            ProjectStatus::Active,
            Some(BondState::Deposited),
            ProjectTransition::CuratorSuspend
                | ProjectTransition::GovernorSuspend
                | ProjectTransition::Retire
                | ProjectTransition::GovernorRetire,
        ) | (
            ProvenanceCase::Bonded,
            ProjectStatus::Suspended,
            Some(BondState::Deposited),
            ProjectTransition::GovernorResume
                | ProjectTransition::Retire
                | ProjectTransition::GovernorRetire,
        ) | (
            ProvenanceCase::Bonded,
            ProjectStatus::Retired,
            Some(BondState::Claimable),
            ProjectTransition::GovernorRestore | ProjectTransition::Claim,
        ) | (
            ProvenanceCase::Graduated,
            ProjectStatus::Active,
            None,
            ProjectTransition::CuratorSuspend
                | ProjectTransition::GovernorSuspend
                | ProjectTransition::Retire
                | ProjectTransition::GovernorRetire,
        ) | (
            ProvenanceCase::Graduated,
            ProjectStatus::Suspended,
            None,
            ProjectTransition::GovernorResume
                | ProjectTransition::Retire
                | ProjectTransition::GovernorRetire,
        ) | (
            ProvenanceCase::Graduated,
            ProjectStatus::Retired,
            None,
            ProjectTransition::GovernorRestore,
        )
    )
}

fn register(deps: &mut TestDeps, env: &Env, applicant: &str, label: &str) -> u64 {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(applicant), &[coin(100, "ujuno")]),
        ExecuteMsg::RegisterProject {
            metadata_uri: format!("ipfs://{label}"),
            metadata_digest: digest('a'),
            payout_address: address(PAYOUT),
        },
    )
    .unwrap();
    let id = assigned(&response);
    assert_wire_event(
        &response,
        "hack_juno_registry.project_registered",
        &["project_id", "applicant", "payout_address", "bond"],
    );
    sync_registry_balance(deps, env);
    id
}

fn graduate_as(
    deps: &mut TestDeps,
    env: &Env,
    source_contract: &str,
    source_id: u64,
    label: &str,
) -> Result<u64, ContractError> {
    let response = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(source_contract), &[]),
        ExecuteMsg::Graduate {
            source_bounty_id: source_id,
            metadata_uri: format!("ipfs://{label}"),
            metadata_digest: digest('b'),
            payout_address: address(PAYOUT),
        },
    )?;
    Ok(assigned(&response))
}

fn graduate(deps: &mut TestDeps, env: &Env, source_id: u64, label: &str) -> u64 {
    graduate_as(deps, env, BOUNTY, source_id, label).unwrap()
}

fn review(
    deps: &mut TestDeps,
    env: &Env,
    id: u64,
    decision: ReviewDecision,
    code: ReviewReasonCode,
) -> Response {
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::ReviewRegistration {
            project_id: id,
            decision,
            reason: reason(code),
        },
    )
    .unwrap()
}

#[test]
fn registry_assigns_sequential_ids_without_caller_control_or_failed_consumption() {
    let (mut deps, env) = init();
    let first = register(&mut deps, &env, APPLICANT, "first");
    assert_eq!(first, 1);

    let error = execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr("bad-applicant"), &[coin(99, "ujuno")]),
        ExecuteMsg::RegisterProject {
            metadata_uri: "ipfs://invalid-bond".into(),
            metadata_digest: digest('a'),
            payout_address: address(PAYOUT),
        },
    )
    .unwrap_err();
    assert_eq!(error, ContractError::InvalidBond);
    assert_eq!(NEXT_PROJECT_ID.load(&deps.storage).unwrap(), 2);

    let second = graduate(&mut deps, &env, 7, "second");
    let third = register(&mut deps, &env, "another-applicant", "third");
    assert_eq!((second, third), (2, 3));
    assert_eq!(NEXT_PROJECT_ID.load(&deps.storage).unwrap(), 4);
    assert!(PROJECTS.has(&deps.storage, first));
    assert!(PROJECTS.has(&deps.storage, second));
    assert!(APPLICATIONS.has(&deps.storage, first));
    assert!(!APPLICATIONS.has(&deps.storage, second));

    // Both v1 caller-chosen ID shapes fail loudly.
    assert!(from_json::<ExecuteMsg>(
        br#"{"register_project":{"project_id":"squat","metadata_uri":"ipfs://x","metadata_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payout_address":"x"}}"#
    )
    .is_err());
    assert!(from_json::<ExecuteMsg>(
        br#"{"graduate":{"project_id":"squat","source_bounty_id":7,"metadata_uri":"ipfs://x","metadata_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payout_address":"x"}}"#
    )
    .is_err());
}

#[test]
fn project_option_encoding_is_canonical_and_the_reserved_sink_cannot_collide() {
    for id in [1, 9, 10, u64::MAX] {
        let encoded = encode_project_option(id).unwrap();
        assert_eq!(decode_project_option(&encoded).unwrap(), id);
        assert_ne!(encoded, DO_NOT_DISTRIBUTE);
    }
    assert!(encode_project_option(0).is_err());
    for malformed in [
        "",
        "1",
        "project:",
        "project:0",
        "project:01",
        "project:+1",
        "project: 1",
        "project:18446744073709551616",
        DO_NOT_DISTRIBUTE,
    ] {
        assert!(decode_project_option(malformed).is_err(), "{malformed}");
    }
}

#[test]
fn bounty_replay_is_namespaced_by_source_and_survives_rotation() {
    let (mut deps, env) = init();
    let initial: IdentityStateResponse = from_json(
        query(
            deps.as_ref(),
            env.clone(),
            crate::msg::QueryMsg::IdentityState {},
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(initial.next_project_id, 1);
    assert_eq!(initial.consumed_source_bounties, 0);
    let first = graduate(&mut deps, &env, 1, "old-source");
    assert_eq!(
        SOURCE_BOUNTIES
            .load(&deps.storage, (&addr(BOUNTY), 1))
            .unwrap(),
        first
    );
    assert_eq!(
        graduate_as(&mut deps, &env, BOUNTY, 1, "replay").unwrap_err(),
        ContractError::DuplicateSourceBounty
    );
    assert_eq!(NEXT_PROJECT_ID.load(&deps.storage).unwrap(), 2);
    assert_eq!(SOURCE_BOUNTY_COUNT.load(&deps.storage).unwrap(), 1);

    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UpdateBountyContract {
            bounty_contract: address("replacement-bounty"),
        },
    )
    .unwrap();
    assert_eq!(
        graduate_as(&mut deps, &env, BOUNTY, 2, "old-rejected").unwrap_err(),
        ContractError::Unauthorized
    );
    let second = graduate_as(&mut deps, &env, "replacement-bounty", 1, "new-source").unwrap();
    assert_eq!(second, 2);
    let project = PROJECTS.load(&deps.storage, second).unwrap();
    assert_eq!(
        project.provenance,
        AdmissionProvenance::GraduatedBounty {
            source_bounty_contract: addr("replacement-bounty"),
            source_bounty_id: 1,
        }
    );
    assert_eq!(
        SOURCE_BOUNTIES
            .load(&deps.storage, (&addr(BOUNTY), 1))
            .unwrap(),
        first
    );
    let final_state: IdentityStateResponse =
        from_json(query(deps.as_ref(), env, crate::msg::QueryMsg::IdentityState {}).unwrap())
            .unwrap();
    assert_eq!(final_state.next_project_id, 3);
    assert_eq!(final_state.consumed_source_bounties, 2);
}

#[test]
fn bonded_transition_engine_preserves_backing_and_blocks_settled_reactivation() {
    let (mut deps, env) = init();
    let id = register(&mut deps, &env, APPLICANT, "bonded");
    review(
        &mut deps,
        &env,
        id,
        ReviewDecision::Approve,
        ReviewReasonCode::MeetsCriteria,
    );
    let option = encode_project_option(id).unwrap();
    assert!(OPTIONS.has(&deps.storage, &option));
    assert_eq!(
        PROJECTS
            .load(&deps.storage, id)
            .unwrap()
            .bond
            .unwrap()
            .state,
        BondState::Deposited
    );

    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Suspend {
            project_id: id,
            reason: reason(ReviewReasonCode::PolicyViolation),
        },
    )
    .unwrap();
    assert!(!OPTIONS.has(&deps.storage, &option));
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::OverrideProjectStatus {
            project_id: id,
            status: OverrideStatus::Active,
            reason: reason(ReviewReasonCode::GovernanceOverride),
        },
    )
    .unwrap();
    assert!(OPTIONS.has(&deps.storage, &option));

    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Retire {
            project_id: id,
            reason: reason(ReviewReasonCode::PolicyViolation),
        },
    )
    .unwrap();
    assert_eq!(
        PROJECTS
            .load(&deps.storage, id)
            .unwrap()
            .bond
            .unwrap()
            .state,
        BondState::Claimable
    );
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::OverrideProjectStatus {
            project_id: id,
            status: OverrideStatus::Active,
            reason: reason(ReviewReasonCode::GovernanceOverride),
        },
    )
    .unwrap();
    assert_eq!(
        PROJECTS
            .load(&deps.storage, id)
            .unwrap()
            .bond
            .unwrap()
            .state,
        BondState::Deposited
    );

    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Retire {
            project_id: id,
            reason: reason(ReviewReasonCode::PolicyViolation),
        },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(APPLICANT), &[]),
        ExecuteMsg::ClaimRegistrationBond { project_id: id },
    )
    .unwrap();
    let claimed = PROJECTS.load(&deps.storage, id).unwrap();
    assert_eq!(claimed.status, ProjectStatus::Retired);
    assert_eq!(claimed.bond.unwrap().state, BondState::Claimed);
    assert_eq!(
        ACCOUNTING.load(&deps.storage).unwrap().bond_liability,
        Uint128::zero()
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&addr(GOVERNOR), &[]),
            ExecuteMsg::OverrideProjectStatus {
                project_id: id,
                status: OverrideStatus::Active,
                reason: reason(ReviewReasonCode::GovernanceOverride),
            },
        )
        .unwrap_err(),
        ContractError::InvalidState
    );
}

#[test]
fn soft_and_hard_rejection_settle_bonds_and_keep_historical_ids() {
    let (mut deps, env) = init();
    let soft = register(&mut deps, &env, APPLICANT, "soft");
    let soft_response = review(
        &mut deps,
        &env,
        soft,
        ReviewDecision::SoftReject,
        ReviewReasonCode::Duplicate,
    );
    assert!(matches!(
        soft_response.messages[0].msg,
        CosmosMsg::Bank(BankMsg::Send { .. })
    ));
    let hard = register(&mut deps, &env, "hard-applicant", "hard");
    let hard_response = review(
        &mut deps,
        &env,
        hard,
        ReviewDecision::HardReject,
        ReviewReasonCode::Spam,
    );
    assert!(matches!(
        hard_response.messages[0].msg,
        CosmosMsg::Bank(BankMsg::Send { .. })
    ));
    assert_eq!(
        PROJECTS
            .load(&deps.storage, soft)
            .unwrap()
            .bond
            .unwrap()
            .state,
        BondState::Refunded
    );
    assert_eq!(
        PROJECTS
            .load(&deps.storage, hard)
            .unwrap()
            .bond
            .unwrap()
            .state,
        BondState::Forfeited
    );
    assert!(PROJECTS.has(&deps.storage, soft));
    assert!(PROJECTS.has(&deps.storage, hard));
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&addr(GOVERNOR), &[]),
            ExecuteMsg::OverrideProjectStatus {
                project_id: soft,
                status: OverrideStatus::Active,
                reason: reason(ReviewReasonCode::GovernanceOverride),
            },
        )
        .unwrap_err(),
        ContractError::InvalidState
    );
}

#[test]
fn graduated_projects_follow_an_explicit_bond_free_transition_table() {
    let (mut deps, env) = init();
    let id = graduate(&mut deps, &env, 1, "graduated");
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Suspend {
            project_id: id,
            reason: reason(ReviewReasonCode::PolicyViolation),
        },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::OverrideProjectStatus {
            project_id: id,
            status: OverrideStatus::Active,
            reason: reason(ReviewReasonCode::GovernanceOverride),
        },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Retire {
            project_id: id,
            reason: reason(ReviewReasonCode::PolicyViolation),
        },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        env,
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::OverrideProjectStatus {
            project_id: id,
            status: OverrideStatus::Active,
            reason: reason(ReviewReasonCode::GovernanceOverride),
        },
    )
    .unwrap();
    let project = PROJECTS.load(&deps.storage, id).unwrap();
    assert_eq!(project.status, ProjectStatus::Active);
    assert!(project.bond.is_none());
}

#[test]
fn transition_engine_rejects_liability_shortfall_before_status_mutation() {
    let (mut deps, env) = init();
    let id = register(&mut deps, &env, APPLICANT, "shortfall");
    deps.querier
        .bank
        .update_balance(env.contract.address.clone(), vec![coin(99, "ujuno")]);
    assert_eq!(
        execute(
            deps.as_mut(),
            env,
            message_info(&addr(CURATOR), &[]),
            ExecuteMsg::ReviewRegistration {
                project_id: id,
                decision: ReviewDecision::Approve,
                reason: reason(ReviewReasonCode::MeetsCriteria),
            },
        )
        .unwrap_err(),
        ContractError::InvalidState
    );
    assert_eq!(
        PROJECTS.load(&deps.storage, id).unwrap().status,
        ProjectStatus::Pending
    );
    assert!(APPLICATIONS.has(&deps.storage, id));
}

#[test]
fn transition_table_covers_every_status_provenance_bond_and_transition_combination() {
    let statuses = [
        ProjectStatus::Pending,
        ProjectStatus::Active,
        ProjectStatus::Suspended,
        ProjectStatus::Rejected,
        ProjectStatus::Retired,
    ];
    let bonds = [
        None,
        Some(BondState::Deposited),
        Some(BondState::Refunded),
        Some(BondState::Forfeited),
        Some(BondState::Claimable),
        Some(BondState::Claimed),
    ];
    let transitions = [
        ProjectTransition::ReviewNoChange,
        ProjectTransition::Approve,
        ProjectTransition::SoftReject,
        ProjectTransition::HardReject,
        ProjectTransition::CuratorSuspend,
        ProjectTransition::GovernorSuspend,
        ProjectTransition::GovernorResume,
        ProjectTransition::Retire,
        ProjectTransition::GovernorRetire,
        ProjectTransition::GovernorRestore,
        ProjectTransition::Claim,
    ];

    for provenance_case in [ProvenanceCase::Bonded, ProvenanceCase::Graduated] {
        for status in &statuses {
            for bond_state in &bonds {
                for transition in transitions {
                    let (mut deps, env) = init();
                    let id = 1;
                    let bond = bond_state.clone().map(|state| RegistrationBond {
                        depositor: addr(APPLICANT),
                        amount: Uint128::new(100),
                        state,
                    });
                    let provenance = match provenance_case {
                        ProvenanceCase::Bonded => AdmissionProvenance::BondedRegistration {
                            applicant: addr(APPLICANT),
                        },
                        ProvenanceCase::Graduated => AdmissionProvenance::GraduatedBounty {
                            source_bounty_contract: addr(BOUNTY),
                            source_bounty_id: 1,
                        },
                    };
                    let project = Project {
                        id,
                        owner: addr(APPLICANT),
                        metadata_uri: "ipfs://transition-table".into(),
                        metadata_digest: digest('a'),
                        payout_address: addr(PAYOUT),
                        pending_payout_address: None,
                        provenance,
                        status: status.clone(),
                        bond,
                        latest_review: None,
                        created_at: env.block.time,
                        updated_at: env.block.time,
                        status_history_count: 0,
                        address_history_count: 0,
                    };
                    PROJECTS.save(&mut deps.storage, id, &project).unwrap();
                    if *status == ProjectStatus::Pending {
                        APPLICATIONS.save(&mut deps.storage, id, &()).unwrap();
                    }
                    if *status == ProjectStatus::Active {
                        OPTIONS
                            .save(&mut deps.storage, &encode_project_option(id).unwrap(), &())
                            .unwrap();
                    }
                    let held = bond_state.as_ref().is_some_and(|state| {
                        matches!(state, BondState::Deposited | BondState::Claimable)
                    });
                    let liability = if held {
                        Uint128::new(100)
                    } else {
                        Uint128::zero()
                    };
                    ACCOUNTING
                        .save(
                            &mut deps.storage,
                            &RegistryAccounting {
                                active_projects: u32::from(*status == ProjectStatus::Active),
                                pending_applications: u64::from(*status == ProjectStatus::Pending),
                                bond_liability: liability,
                                lifetime_bonds_received: if bond_state.is_some() {
                                    Uint128::new(100)
                                } else {
                                    Uint128::zero()
                                },
                                lifetime_bonds_refunded: Uint128::zero(),
                                lifetime_bonds_forfeited: Uint128::zero(),
                            },
                        )
                        .unwrap();
                    deps.querier.bank.update_balance(
                        env.contract.address.clone(),
                        vec![coin(liability.u128(), "ujuno")],
                    );

                    let expected = transition_expected(
                        provenance_case,
                        status,
                        bond_state.as_ref(),
                        transition,
                    );
                    let actual =
                        validate_project_transition(deps.as_ref(), &env, &project, transition);
                    assert_eq!(
                        actual.is_ok(),
                        expected,
                        "unexpected transition result: provenance={provenance_case:?}, status={status:?}, bond={bond_state:?}, transition={transition:?}, result={actual:?}",
                    );
                }
            }
        }
    }
}

#[test]
fn every_governor_override_target_is_covered_from_every_bonded_status() {
    let statuses = [
        ProjectStatus::Pending,
        ProjectStatus::Active,
        ProjectStatus::Suspended,
        ProjectStatus::Rejected,
        ProjectStatus::Retired,
    ];
    let targets = [
        OverrideStatus::Active,
        OverrideStatus::Suspended,
        OverrideStatus::Rejected,
        OverrideStatus::Retired,
    ];

    for status in statuses {
        for target in &targets {
            let (mut deps, env) = init();
            let id = register(&mut deps, &env, APPLICANT, "override-table");
            match status {
                ProjectStatus::Pending => {}
                ProjectStatus::Active => {
                    review(
                        &mut deps,
                        &env,
                        id,
                        ReviewDecision::Approve,
                        ReviewReasonCode::MeetsCriteria,
                    );
                }
                ProjectStatus::Suspended => {
                    review(
                        &mut deps,
                        &env,
                        id,
                        ReviewDecision::Approve,
                        ReviewReasonCode::MeetsCriteria,
                    );
                    execute(
                        deps.as_mut(),
                        env.clone(),
                        message_info(&addr(CURATOR), &[]),
                        ExecuteMsg::Suspend {
                            project_id: id,
                            reason: reason(ReviewReasonCode::PolicyViolation),
                        },
                    )
                    .unwrap();
                }
                ProjectStatus::Rejected => {
                    review(
                        &mut deps,
                        &env,
                        id,
                        ReviewDecision::SoftReject,
                        ReviewReasonCode::Duplicate,
                    );
                }
                ProjectStatus::Retired => {
                    review(
                        &mut deps,
                        &env,
                        id,
                        ReviewDecision::Approve,
                        ReviewReasonCode::MeetsCriteria,
                    );
                    execute(
                        deps.as_mut(),
                        env.clone(),
                        message_info(&addr(CURATOR), &[]),
                        ExecuteMsg::Retire {
                            project_id: id,
                            reason: reason(ReviewReasonCode::PolicyViolation),
                        },
                    )
                    .unwrap();
                }
            }
            sync_registry_balance(&mut deps, &env);

            let expected = matches!(
                (&status, target),
                (ProjectStatus::Active, OverrideStatus::Suspended)
                    | (ProjectStatus::Active, OverrideStatus::Retired)
                    | (ProjectStatus::Suspended, OverrideStatus::Active)
                    | (ProjectStatus::Suspended, OverrideStatus::Retired)
                    | (ProjectStatus::Retired, OverrideStatus::Active)
            );
            let result = execute(
                deps.as_mut(),
                env.clone(),
                message_info(&addr(GOVERNOR), &[]),
                ExecuteMsg::OverrideProjectStatus {
                    project_id: id,
                    status: target.clone(),
                    reason: reason(ReviewReasonCode::GovernanceOverride),
                },
            );
            assert_eq!(
                result.is_ok(),
                expected,
                "unexpected governor override result: status={status:?}, target={target:?}, result={result:?}",
            );
            sync_registry_balance(&mut deps, &env);
            assert_transition_invariants(&deps, &env);
        }
    }
}

#[test]
fn transition_engine_enforces_caller_authority_and_typed_reason() {
    let (mut deps, env) = init();
    let id = register(&mut deps, &env, APPLICANT, "authority");
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(APPLICANT), &[]),
            ExecuteMsg::ReviewRegistration {
                project_id: id,
                decision: ReviewDecision::Approve,
                reason: reason(ReviewReasonCode::MeetsCriteria),
            },
        )
        .unwrap_err(),
        ContractError::Unauthorized,
    );
    assert!(matches!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(CURATOR), &[]),
            ExecuteMsg::ReviewRegistration {
                project_id: id,
                decision: ReviewDecision::HardReject,
                reason: reason(ReviewReasonCode::Duplicate),
            },
        )
        .unwrap_err(),
        ContractError::InvalidMetadata(_)
    ));
    review(
        &mut deps,
        &env,
        id,
        ReviewDecision::Approve,
        ReviewReasonCode::MeetsCriteria,
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(GOVERNOR), &[]),
            ExecuteMsg::Suspend {
                project_id: id,
                reason: reason(ReviewReasonCode::GovernanceOverride),
            },
        )
        .unwrap_err(),
        ContractError::Unauthorized,
    );
    assert!(matches!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(APPLICANT), &[]),
            ExecuteMsg::Retire {
                project_id: id,
                reason: reason(ReviewReasonCode::PolicyViolation),
            },
        )
        .unwrap_err(),
        ContractError::InvalidMetadata(_)
    ));
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(CURATOR), &[]),
            ExecuteMsg::OverrideProjectStatus {
                project_id: id,
                status: OverrideStatus::Suspended,
                reason: reason(ReviewReasonCode::GovernanceOverride),
            },
        )
        .unwrap_err(),
        ContractError::Unauthorized,
    );
    sync_registry_balance(&mut deps, &env);
    assert_transition_invariants(&deps, &env);
}

#[test]
fn stop_authority_and_economic_updates_remain_bounded() {
    let (mut deps, env) = init();
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(CURATOR), &[]),
        ExecuteMsg::Stop {
            scope: StopScope::Admissions,
            reason: "incident".into(),
        },
    )
    .unwrap();
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(APPLICANT), &[coin(100, "ujuno")]),
            ExecuteMsg::RegisterProject {
                metadata_uri: "ipfs://stopped".into(),
                metadata_digest: digest('a'),
                payout_address: address(PAYOUT),
            },
        )
        .unwrap_err(),
        ContractError::AdmissionsStopped
    );
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            message_info(&addr(CURATOR), &[]),
            ExecuteMsg::Resume {
                scope: StopScope::Admissions,
                reason: "attempt".into(),
            },
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    execute(
        deps.as_mut(),
        env.clone(),
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::Resume {
            scope: StopScope::Admissions,
            reason: "recovered".into(),
        },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        env,
        message_info(&addr(GOVERNOR), &[]),
        ExecuteMsg::UpdateEconomicConfig {
            update: EconomicConfigUpdate {
                registration_bond: Some(Uint128::new(200)),
                spam_destination: None,
                payout_address_delay_seconds: None,
                epoch_ceiling: None,
                min_project_share: None,
                max_project_share: None,
                max_selected_projects: None,
            },
        },
    )
    .unwrap();
    assert_eq!(
        CONFIG.load(&deps.storage).unwrap().registration_bond,
        Uint128::new(200)
    );
}

#[test]
fn adapter_retains_threshold_exclusions_caps_sink_and_dust() {
    let (mut deps, env) = init();
    let large = graduate(&mut deps, &env, 1, "large");
    let small = graduate(&mut deps, &env, 2, "small");
    let large_option = encode_project_option(large).unwrap();
    let small_option = encode_project_option(small).unwrap();
    let sampled = sample_gauge_messages(
        &deps.storage,
        vec![
            (large_option, Decimal::percent(50)),
            (small_option, Decimal::percent(5)),
            (DO_NOT_DISTRIBUTE.into(), Decimal::percent(20)),
        ],
        Uint128::new(1_000),
        Uint128::zero(),
        "ujuno".into(),
    )
    .unwrap();
    assert_eq!(sampled.emitted_value, Uint128::new(400));
    assert_eq!(sampled.retained_value, Uint128::new(600));
    assert_eq!(sampled.execute.len(), 1);

    let dust = sample_gauge_messages(
        &deps.storage,
        vec![(encode_project_option(large).unwrap(), Decimal::percent(10))],
        Uint128::new(1),
        Uint128::zero(),
        "ujuno".into(),
    )
    .unwrap();
    assert!(dust.execute.is_empty());
    assert_eq!(dust.retained_value, Uint128::new(1));
    assert!(sample_gauge_messages(
        &deps.storage,
        vec![("project:01".into(), Decimal::percent(20))],
        Uint128::new(1_000),
        Uint128::new(1_000),
        "ujuno".into(),
    )
    .is_err());
}

proptest! {
    #[test]
    fn generated_project_sequences_preserve_bond_and_index_invariants(
        actions in prop::collection::vec(0u8..16, 1..80),
    ) {
        let (mut deps, env) = init();
        let bonded = register(&mut deps, &env, APPLICANT, "state-machine-bonded");
        let graduated = graduate(&mut deps, &env, 77, "state-machine-graduated");

        for action in actions {
            let (sender, message) = match action {
                0 => (CURATOR, ExecuteMsg::ReviewRegistration {
                    project_id: bonded,
                    decision: ReviewDecision::Approve,
                    reason: reason(ReviewReasonCode::MeetsCriteria),
                }),
                1 => (CURATOR, ExecuteMsg::ReviewRegistration {
                    project_id: bonded,
                    decision: ReviewDecision::RequestChanges,
                    reason: reason(ReviewReasonCode::IncompleteApplication),
                }),
                2 => (CURATOR, ExecuteMsg::ReviewRegistration {
                    project_id: bonded,
                    decision: ReviewDecision::SoftReject,
                    reason: reason(ReviewReasonCode::Duplicate),
                }),
                3 => (CURATOR, ExecuteMsg::ReviewRegistration {
                    project_id: bonded,
                    decision: ReviewDecision::HardReject,
                    reason: reason(ReviewReasonCode::Spam),
                }),
                4 => (CURATOR, ExecuteMsg::Suspend {
                    project_id: bonded,
                    reason: reason(ReviewReasonCode::PolicyViolation),
                }),
                5 => (GOVERNOR, ExecuteMsg::OverrideProjectStatus {
                    project_id: bonded,
                    status: OverrideStatus::Active,
                    reason: reason(ReviewReasonCode::GovernanceOverride),
                }),
                6 => (CURATOR, ExecuteMsg::Retire {
                    project_id: bonded,
                    reason: reason(ReviewReasonCode::PolicyViolation),
                }),
                7 => (APPLICANT, ExecuteMsg::ClaimRegistrationBond {
                    project_id: bonded,
                }),
                8 => (APPLICANT, ExecuteMsg::Retire {
                    project_id: bonded,
                    reason: reason(ReviewReasonCode::VoluntaryRetirement),
                }),
                9 => (CURATOR, ExecuteMsg::Suspend {
                    project_id: graduated,
                    reason: reason(ReviewReasonCode::PolicyViolation),
                }),
                10 => (GOVERNOR, ExecuteMsg::OverrideProjectStatus {
                    project_id: graduated,
                    status: OverrideStatus::Active,
                    reason: reason(ReviewReasonCode::GovernanceOverride),
                }),
                11 => (CURATOR, ExecuteMsg::Retire {
                    project_id: graduated,
                    reason: reason(ReviewReasonCode::PolicyViolation),
                }),
                12 => (GOVERNOR, ExecuteMsg::OverrideProjectStatus {
                    project_id: graduated,
                    status: OverrideStatus::Suspended,
                    reason: reason(ReviewReasonCode::GovernanceOverride),
                }),
                13 => (GOVERNOR, ExecuteMsg::OverrideProjectStatus {
                    project_id: graduated,
                    status: OverrideStatus::Retired,
                    reason: reason(ReviewReasonCode::GovernanceOverride),
                }),
                14 => (APPLICANT, ExecuteMsg::Suspend {
                    project_id: bonded,
                    reason: reason(ReviewReasonCode::PolicyViolation),
                }),
                _ => (GOVERNOR, ExecuteMsg::OverrideProjectStatus {
                    project_id: bonded,
                    status: OverrideStatus::Rejected,
                    reason: reason(ReviewReasonCode::GovernanceOverride),
                }),
            };
            let _ = execute(
                deps.as_mut(),
                env.clone(),
                message_info(&addr(sender), &[]),
                message,
            );
            sync_registry_balance(&mut deps, &env);
            assert_transition_invariants(&deps, &env);
        }
    }

    #[test]
    fn arbitrary_valid_allocations_never_exceed_budget(
        budget in 1u128..=1_000,
        first_bps in 1u64..=4_000,
        second_bps in 1u64..=4_000,
    ) {
        prop_assume!(first_bps + second_bps <= 10_000);
        let (mut deps, env) = init();
        let first = graduate(&mut deps, &env, 1, "first");
        let second = graduate(&mut deps, &env, 2, "second");
        let sampled = sample_gauge_messages(
            &deps.storage,
            vec![
                (encode_project_option(first).unwrap(), Decimal::from_ratio(first_bps, 10_000u64)),
                (encode_project_option(second).unwrap(), Decimal::from_ratio(second_bps, 10_000u64)),
            ],
            Uint128::new(budget),
            Uint128::zero(),
            "ujuno".into(),
        ).unwrap();
        prop_assert!(sampled.emitted_value <= Uint128::new(budget));
        prop_assert_eq!(
            sampled.emitted_value.checked_add(sampled.retained_value).unwrap(),
            Uint128::new(budget)
        );
        prop_assert!(sampled.execute.len() <= 2);
    }
}
