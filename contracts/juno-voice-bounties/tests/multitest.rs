use cosmwasm_std::{coin, Addr, BankMsg, CosmosMsg, Uint128};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor};
use juno_voice_bounties::contract::{execute, instantiate, query};
use juno_voice_bounties::msg::{
    BountyResponse, ExecuteMsg, HealthResponse, InstantiateMsg, Limits, QueryMsg,
};
use juno_voice_bounties::state::BountyStatus;

fn contract() -> Box<dyn Contract<cosmwasm_std::Empty>> {
    Box::new(ContractWrapper::new(execute, instantiate, query))
}

struct Suite {
    app: App,
    contract: Addr,
    creator: Addr,
    recipient: Addr,
    thief: Addr,
}

fn suite() -> Suite {
    let mut app = AppBuilder::new().build(|router, api, storage| {
        let creator = api.addr_make("creator");
        router
            .bank
            .init_balance(storage, &creator, vec![coin(1_000_000, "ujuno")])
            .unwrap();
    });
    let deployer = app.api().addr_make("deployer");
    let creator = app.api().addr_make("creator");
    let recipient = app.api().addr_make("recipient");
    let thief = app.api().addr_make("thief");
    let governor = app.api().addr_make("governor");
    let agent = app.api().addr_make("agent");
    let registry = app.api().addr_make("registry");
    let code_id = app.store_code(contract());
    let contract = app
        .instantiate_contract(
            code_id,
            deployer,
            &InstantiateMsg {
                native_denom: "ujuno".into(),
                governor: governor.into(),
                agent: agent.into(),
                registry: registry.into(),
                min_contribution: Uint128::new(10),
                max_bounty_total: Uint128::new(1_000_000),
                min_lifetime_seconds: 100,
                max_lifetime_seconds: 1_000_000,
                max_contributors: 100,
                max_rounds: 10,
                limits: Limits {
                    max_title_bytes: 80,
                    max_summary_bytes: 256,
                    max_acceptance_criteria_bytes: 512,
                    max_uri_bytes: 256,
                    max_rationale_bytes: 256,
                    max_reason_bytes: 128,
                    max_page_limit: 50,
                },
            },
            &[],
            "juno-voice-bounties",
            None,
        )
        .unwrap();
    Suite {
        app,
        contract,
        creator,
        recipient,
        thief,
    }
}

fn create_and_nominate(suite: &mut Suite) {
    let expires_at = suite.app.block_info().time.plus_seconds(10_000);
    suite
        .app
        .execute_contract(
            suite.creator.clone(),
            suite.contract.clone(),
            &ExecuteMsg::CreateBounty {
                title: "Atomic payout".into(),
                summary: "Transfer failure must roll all state back".into(),
                acceptance_criteria: "A recipient receives the exact full pot".into(),
                content_uri: None,
                content_digest: None,
                expires_at,
                project_candidate: None,
            },
            &[coin(100, "ujuno")],
        )
        .unwrap();
    suite
        .app
        .execute_contract(
            suite.creator.clone(),
            suite.contract.clone(),
            &ExecuteMsg::NominatePayout {
                bounty_id: 1,
                recipient: suite.recipient.to_string(),
                evidence_uri: "ipfs://bafyevidence".into(),
                evidence_digest: format!("sha256:{}", "a".repeat(64)),
                rationale: "The exact acceptance criteria are met".into(),
            },
            &[],
        )
        .unwrap();
}

#[test]
fn failed_bank_send_rolls_settlement_state_back_atomically() {
    let mut suite = suite();
    create_and_nominate(&mut suite);

    suite
        .app
        .execute(
            suite.contract.clone(),
            CosmosMsg::Bank(BankMsg::Send {
                to_address: suite.thief.to_string(),
                amount: vec![coin(100, "ujuno")],
            }),
        )
        .unwrap();
    suite
        .app
        .execute_contract(
            suite.creator.clone(),
            suite.contract.clone(),
            &ExecuteMsg::ConfirmSolePayout {
                bounty_id: 1,
                round: 1,
            },
            &[],
        )
        .unwrap_err();

    let bounty: BountyResponse = suite
        .app
        .wrap()
        .query_wasm_smart(suite.contract.clone(), &QueryMsg::Bounty { bounty_id: 1 })
        .unwrap();
    assert_eq!(bounty.bounty.status, BountyStatus::SingleConfirmation);
    assert!(bounty.bounty.paid_amount.is_zero());
    assert_eq!(bounty.active_round.unwrap().finalized_at, None);
}

#[test]
fn unsolicited_native_transfer_never_creates_accounted_liability() {
    let mut suite = suite();
    create_and_nominate(&mut suite);
    suite
        .app
        .send_tokens(
            suite.creator.clone(),
            suite.contract.clone(),
            &[coin(50, "ujuno")],
        )
        .unwrap();
    let health: HealthResponse = suite
        .app
        .wrap()
        .query_wasm_smart(suite.contract, &QueryMsg::Health {})
        .unwrap();
    assert_eq!(health.actual_native_balance, Uint128::new(150));
    assert_eq!(health.liabilities, Uint128::new(100));
    assert!(health.fully_backed);
    assert_eq!(health.accounting.lifetime_received, Uint128::new(100));
}
