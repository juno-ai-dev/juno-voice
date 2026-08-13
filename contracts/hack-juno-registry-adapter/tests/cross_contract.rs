use cosmwasm_std::{coin, Addr, Decimal, Empty, Uint128};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor};

use hack_juno_registry_adapter::contract as registry_contract;
use hack_juno_registry_adapter::msg as registry_msg;
use hack_juno_registry_adapter::state::{AdmissionProvenance, Project, ProjectStatus};
use juno_voice_bounties::contract as bounty_contract;
use juno_voice_bounties::msg as bounty_msg;

fn registry_code() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(
        registry_contract::execute,
        registry_contract::instantiate,
        registry_contract::query,
    ))
}

fn bounty_code() -> Box<dyn Contract<Empty>> {
    Box::new(
        ContractWrapper::new(
            bounty_contract::execute,
            bounty_contract::instantiate,
            bounty_contract::query,
        )
        .with_reply(bounty_contract::reply),
    )
}

struct Suite {
    app: App,
    registry: Addr,
    bounty: Addr,
    governor: Addr,
    agent: Addr,
    creator: Addr,
    recipient: Addr,
}

fn suite() -> Suite {
    let mut app = AppBuilder::new().build(|router, api, storage| {
        router
            .bank
            .init_balance(
                storage,
                &api.addr_make("creator"),
                vec![coin(10_000, "ujuno")],
            )
            .unwrap();
    });
    let deployer = app.api().addr_make("deployer");
    let governor = app.api().addr_make("governor");
    let agent = app.api().addr_make("agent");
    let creator = app.api().addr_make("creator");
    let recipient = app.api().addr_make("recipient");
    let placeholder_bounty = app.api().addr_make("placeholder-bounty");
    let registry_id = app.store_code(registry_code());
    let bounty_id = app.store_code(bounty_code());
    let registry = app
        .instantiate_contract(
            registry_id,
            deployer.clone(),
            &registry_msg::InstantiateMsg {
                native_denom: "ujuno".into(),
                governor: governor.to_string(),
                curator: agent.to_string(),
                bounty_contract: placeholder_bounty.to_string(),
                spam_destination: app.api().addr_make("spam-destination").to_string(),
                registration_bond: Uint128::new(1_000),
                payout_address_delay_seconds: 86_400,
                epoch_ceiling: Uint128::new(1_000_000),
                min_project_share: Decimal::percent(1),
                max_project_share: Decimal::percent(40),
                max_selected_projects: 20,
                max_page_limit: 100,
                max_metadata_uri_bytes: 512,
                max_reason_bytes: 512,
            },
            &[],
            "hack-juno-registry-adapter",
            None,
        )
        .unwrap();
    let bounty = app
        .instantiate_contract(
            bounty_id,
            deployer,
            &bounty_msg::InstantiateMsg {
                native_denom: "ujuno".into(),
                governor: governor.to_string(),
                agent: agent.to_string(),
                registry: registry.to_string(),
                min_contribution: Uint128::new(10),
                max_bounty_total: Uint128::new(1_000_000),
                min_lifetime_seconds: 100,
                max_lifetime_seconds: 1_000_000,
                max_contributors: 100,
                max_rounds: 10,
                limits: bounty_msg::Limits {
                    max_title_bytes: 128,
                    max_summary_bytes: 512,
                    max_acceptance_criteria_bytes: 1_024,
                    max_uri_bytes: 512,
                    max_rationale_bytes: 512,
                    max_reason_bytes: 512,
                    max_page_limit: 100,
                },
            },
            &[],
            "juno-voice-bounties",
            None,
        )
        .unwrap();
    app.execute_contract(
        governor.clone(),
        registry.clone(),
        &registry_msg::ExecuteMsg::UpdateBountyContract {
            bounty_contract: bounty.to_string(),
        },
        &[],
    )
    .unwrap();
    Suite {
        app,
        registry,
        bounty,
        governor,
        agent,
        creator,
        recipient,
    }
}

fn pay_candidate(suite: &mut Suite) {
    let expires_at = suite.app.block_info().time.plus_seconds(10_000);
    suite
        .app
        .execute_contract(
            suite.creator.clone(),
            suite.bounty.clone(),
            &bounty_msg::ExecuteMsg::CreateBounty {
                title: "Ship the project".into(),
                summary: "A candidate that can graduate after contributor settlement".into(),
                acceptance_criteria: "The published release satisfies the bounded criteria".into(),
                content_uri: Some("ipfs://bafyterms".into()),
                content_digest: Some(format!("sha256:{}", "a".repeat(64))),
                expires_at,
                project_candidate: Some(bounty_msg::ProjectCandidate {
                    metadata_uri: "ipfs://bafyproject".into(),
                    metadata_digest: format!("sha256:{}", "b".repeat(64)),
                }),
            },
            &[coin(500, "ujuno")],
        )
        .unwrap();
    suite
        .app
        .execute_contract(
            suite.creator.clone(),
            suite.bounty.clone(),
            &bounty_msg::ExecuteMsg::NominatePayout {
                bounty_id: 1,
                recipient: suite.recipient.to_string(),
                evidence_uri: "ipfs://bafyevidence".into(),
                evidence_digest: format!("sha256:{}", "c".repeat(64)),
                rationale: "The exact acceptance criteria are met".into(),
            },
            &[],
        )
        .unwrap();
    suite
        .app
        .execute_contract(
            suite.creator.clone(),
            suite.bounty.clone(),
            &bounty_msg::ExecuteMsg::ConfirmSolePayout {
                bounty_id: 1,
                round: 1,
            },
            &[],
        )
        .unwrap();
}

#[test]
fn paid_candidate_graduates_through_authenticated_bounty_into_active_registry() {
    let mut suite = suite();
    pay_candidate(&mut suite);
    suite
        .app
        .execute_contract(
            suite.agent,
            suite.bounty.clone(),
            &bounty_msg::ExecuteMsg::GraduateProject { bounty_id: 1 },
            &[],
        )
        .unwrap();

    let project: Project = suite
        .app
        .wrap()
        .query_wasm_smart(
            suite.registry.clone(),
            &registry_msg::QueryMsg::Project { project_id: 1 },
        )
        .unwrap();
    assert_eq!(project.status, ProjectStatus::Active);
    assert_eq!(project.payout_address, suite.recipient);
    assert_eq!(
        project.provenance,
        AdmissionProvenance::GraduatedBounty {
            source_bounty_contract: suite.bounty.clone(),
            source_bounty_id: 1
        }
    );
    let checked: registry_msg::CheckOptionResponse = suite
        .app
        .wrap()
        .query_wasm_smart(
            suite.registry,
            &registry_msg::QueryMsg::CheckOption {
                option: "project:1".into(),
            },
        )
        .unwrap();
    assert!(checked.valid);
    assert_ne!(suite.governor, project.owner);
}

#[test]
fn registry_submessage_failure_rolls_back_pending_graduation_and_id_allocation() {
    let mut suite = suite();
    pay_candidate(&mut suite);
    suite
        .app
        .execute_contract(
            suite.agent.clone(),
            suite.registry.clone(),
            &registry_msg::ExecuteMsg::Stop {
                scope: registry_msg::StopScope::Admissions,
                reason: "test recovery".into(),
            },
            &[],
        )
        .unwrap();
    assert!(suite
        .app
        .execute_contract(
            suite.agent.clone(),
            suite.bounty.clone(),
            &bounty_msg::ExecuteMsg::GraduateProject { bounty_id: 1 },
            &[],
        )
        .is_err());
    let bounty: bounty_msg::BountyResponse = suite
        .app
        .wrap()
        .query_wasm_smart(
            suite.bounty.clone(),
            &bounty_msg::QueryMsg::Bounty { bounty_id: 1 },
        )
        .unwrap();
    assert!(bounty.graduation.is_none());
    let projects: registry_msg::ProjectsResponse = suite
        .app
        .wrap()
        .query_wasm_smart(
            suite.registry.clone(),
            &registry_msg::QueryMsg::Projects {
                start_after: None,
                limit: Some(10),
            },
        )
        .unwrap();
    assert!(projects.projects.is_empty());

    suite
        .app
        .execute_contract(
            suite.governor.clone(),
            suite.registry.clone(),
            &registry_msg::ExecuteMsg::Resume {
                scope: registry_msg::StopScope::Admissions,
                reason: "test recovery complete".into(),
            },
            &[],
        )
        .unwrap();
    suite
        .app
        .execute_contract(
            suite.agent,
            suite.bounty,
            &bounty_msg::ExecuteMsg::GraduateProject { bounty_id: 1 },
            &[],
        )
        .unwrap();
    let project: Project = suite
        .app
        .wrap()
        .query_wasm_smart(
            suite.registry,
            &registry_msg::QueryMsg::Project { project_id: 1 },
        )
        .unwrap();
    assert_eq!(project.id, 1);
}
