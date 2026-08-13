use cosmwasm_std::testing::MockApi;
use cosmwasm_std::{
    coin, Addr, Api, BankMsg, BankQuery, Binary, BlockInfo, CustomMsg, CustomQuery, Decimal, Empty,
    Querier, Storage, Uint128,
};
use cw_multi_test::error::{bail, AnyResult};
use cw_multi_test::{
    AppBuilder, AppResponse, Bank, BankKeeper, BankSudo, Contract, ContractWrapper, CosmosRouter,
    Executor, Module,
};
use serde::de::DeserializeOwned;

use hack_juno_registry_adapter::contract::{execute, instantiate, query};
use hack_juno_registry_adapter::msg::{
    AccountingResponse, ExecuteMsg, InstantiateMsg, ProjectsResponse, QueryMsg, ReviewDecision,
    ReviewReason, ReviewReasonCode,
};
use hack_juno_registry_adapter::state::{BondState, Project, ProjectStatus};

struct RejectRecipientBank {
    inner: BankKeeper,
    rejected_recipient: Addr,
}

impl RejectRecipientBank {
    fn new(rejected_recipient: Addr) -> Self {
        Self {
            inner: BankKeeper::new(),
            rejected_recipient,
        }
    }

    fn init_balance(
        &self,
        storage: &mut dyn Storage,
        account: &Addr,
        amount: Vec<cosmwasm_std::Coin>,
    ) -> AnyResult<()> {
        self.inner.init_balance(storage, account, amount)
    }
}

impl Bank for RejectRecipientBank {}

impl Module for RejectRecipientBank {
    type ExecT = BankMsg;
    type QueryT = BankQuery;
    type SudoT = BankSudo;

    fn execute<ExecC, QueryC>(
        &self,
        api: &dyn Api,
        storage: &mut dyn Storage,
        router: &dyn CosmosRouter<ExecC = ExecC, QueryC = QueryC>,
        block: &BlockInfo,
        sender: Addr,
        msg: BankMsg,
    ) -> AnyResult<AppResponse>
    where
        ExecC: CustomMsg + DeserializeOwned + 'static,
        QueryC: CustomQuery + DeserializeOwned + 'static,
    {
        if matches!(
            &msg,
            BankMsg::Send { to_address, .. } if to_address == self.rejected_recipient.as_str()
        ) {
            bail!("recipient is blocked by the test bank module");
        }
        self.inner.execute(api, storage, router, block, sender, msg)
    }

    fn query(
        &self,
        api: &dyn Api,
        storage: &dyn Storage,
        querier: &dyn Querier,
        block: &BlockInfo,
        request: BankQuery,
    ) -> AnyResult<Binary> {
        self.inner.query(api, storage, querier, block, request)
    }

    fn sudo<ExecC, QueryC>(
        &self,
        api: &dyn Api,
        storage: &mut dyn Storage,
        router: &dyn CosmosRouter<ExecC = ExecC, QueryC = QueryC>,
        block: &BlockInfo,
        msg: BankSudo,
    ) -> AnyResult<AppResponse>
    where
        ExecC: CustomMsg + DeserializeOwned + 'static,
        QueryC: CustomQuery + DeserializeOwned + 'static,
    {
        self.inner.sudo(api, storage, router, block, msg)
    }
}

fn registry_code() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(execute, instantiate, query))
}

#[test]
fn separate_transactions_assign_ids_in_chain_transaction_order() {
    let mut app = AppBuilder::new().build(|router, api, storage| {
        for applicant in ["first-submitter", "second-submitter"] {
            router
                .bank
                .init_balance(
                    storage,
                    &api.addr_make(applicant),
                    vec![coin(1_000, "ujuno")],
                )
                .unwrap();
        }
    });
    let payout = app.api().addr_make("payout");
    let code_id = app.store_code(registry_code());
    let registry = app
        .instantiate_contract(
            code_id,
            app.api().addr_make("deployer"),
            &InstantiateMsg {
                native_denom: "ujuno".into(),
                governor: app.api().addr_make("governor").to_string(),
                curator: app.api().addr_make("curator").to_string(),
                bounty_contract: app.api().addr_make("bounty").to_string(),
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

    // cw-multi-test executes separate transactions serially, matching the
    // consensus order that resolves otherwise concurrent submissions.
    app.execute_contract(
        app.api().addr_make("first-submitter"),
        registry.clone(),
        &ExecuteMsg::RegisterProject {
            metadata_uri: "ipfs://first-in-chain".into(),
            metadata_digest: format!("sha256:{}", "a".repeat(64)),
            payout_address: payout.to_string(),
        },
        &[coin(1_000, "ujuno")],
    )
    .unwrap();
    app.execute_contract(
        app.api().addr_make("second-submitter"),
        registry.clone(),
        &ExecuteMsg::RegisterProject {
            metadata_uri: "ipfs://second-in-chain".into(),
            metadata_digest: format!("sha256:{}", "b".repeat(64)),
            payout_address: payout.to_string(),
        },
        &[coin(1_000, "ujuno")],
    )
    .unwrap();

    let first: Project = app
        .wrap()
        .query_wasm_smart(registry.clone(), &QueryMsg::Project { project_id: 1 })
        .unwrap();
    let second: Project = app
        .wrap()
        .query_wasm_smart(registry, &QueryMsg::Project { project_id: 2 })
        .unwrap();
    assert_eq!(first.metadata_uri, "ipfs://first-in-chain");
    assert_eq!(second.metadata_uri, "ipfs://second-in-chain");
}

#[test]
fn failed_registration_bond_refund_rolls_the_entire_transition_back() {
    let applicant = MockApi::default().addr_make("applicant");
    let bank = RejectRecipientBank::new(applicant.clone());
    let mut app = AppBuilder::new()
        .with_bank(bank)
        .build(|router, api, storage| {
            router
                .bank
                .init_balance(
                    storage,
                    &api.addr_make("applicant"),
                    vec![coin(10_000, "ujuno")],
                )
                .unwrap();
        });
    let deployer = app.api().addr_make("deployer");
    let governor = app.api().addr_make("governor");
    let curator = app.api().addr_make("curator");
    let payout = app.api().addr_make("payout");
    let code_id = app.store_code(registry_code());
    let registry = app
        .instantiate_contract(
            code_id,
            deployer,
            &InstantiateMsg {
                native_denom: "ujuno".into(),
                governor: governor.to_string(),
                curator: curator.to_string(),
                bounty_contract: app.api().addr_make("bounty").to_string(),
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
    app.execute_contract(
        applicant.clone(),
        registry.clone(),
        &ExecuteMsg::RegisterProject {
            metadata_uri: "ipfs://atomic-refund".into(),
            metadata_digest: format!("sha256:{}", "a".repeat(64)),
            payout_address: payout.to_string(),
        },
        &[coin(1_000, "ujuno")],
    )
    .unwrap();

    app.execute_contract(
        curator,
        registry.clone(),
        &ExecuteMsg::ReviewRegistration {
            project_id: 1,
            decision: ReviewDecision::SoftReject,
            reason: ReviewReason {
                code: ReviewReasonCode::Duplicate,
                note: "A typed soft rejection whose refund is forced to fail".into(),
            },
        },
        &[],
    )
    .unwrap_err();

    let project: Project = app
        .wrap()
        .query_wasm_smart(registry.clone(), &QueryMsg::Project { project_id: 1 })
        .unwrap();
    assert_eq!(project.status, ProjectStatus::Pending);
    assert_eq!(project.status_history_count, 1);
    assert_eq!(project.latest_review, None);
    assert_eq!(project.bond.unwrap().state, BondState::Deposited);
    let accounting: AccountingResponse = app
        .wrap()
        .query_wasm_smart(registry.clone(), &QueryMsg::Accounting {})
        .unwrap();
    assert_eq!(accounting.pending_applications, 1);
    assert_eq!(accounting.active_projects, 0);
    assert_eq!(accounting.bond_liability, Uint128::new(1_000));
    assert_eq!(accounting.lifetime_bonds_refunded, Uint128::zero());
    let applications: ProjectsResponse = app
        .wrap()
        .query_wasm_smart(
            registry.clone(),
            &QueryMsg::Applications {
                start_after: None,
                limit: Some(10),
            },
        )
        .unwrap();
    assert_eq!(applications.projects.len(), 1);
    assert_eq!(
        app.wrap().query_balance(registry, "ujuno").unwrap().amount,
        Uint128::new(1_000),
    );
    assert_eq!(
        app.wrap().query_balance(applicant, "ujuno").unwrap().amount,
        Uint128::new(9_000),
    );
}
