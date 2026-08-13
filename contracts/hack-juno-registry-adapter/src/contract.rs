use cosmwasm_std::{
    entry_point, to_json_binary, BankMsg, Binary, Coin, CosmosMsg, Decimal, Deps, DepsMut, Env,
    Event, MessageInfo, Order, Response, StdError, StdResult, Storage, Uint128,
};
use cw2::set_contract_version;
use cw_storage_plus::Bound;

use crate::error::ContractError;
use crate::msg::{
    AllOptionsResponse, CheckOptionResponse, EconomicConfigUpdate, ExecuteMsg, HealthResponse,
    HistoryResponse, IdentityStateResponse, InstantiateMsg, OverrideStatus, ProjectCreatedResponse,
    ProjectsResponse, QueryMsg, ReviewDecision, ReviewReason, ReviewReasonCode,
    SampleGaugeMsgsResponse, StopScope,
};
use crate::state::{
    AddressAction, AddressHistoryEntry, AdmissionProvenance, BondState, Config, PauseState,
    PendingPayoutAddress, Project, ProjectStatus, RegistrationBond, RegistryAccounting,
    StatusAction, StatusHistoryEntry, ACCOUNTING, ADDRESS_HISTORY, APPLICATIONS, CONFIG,
    NEXT_PROJECT_ID, OPTIONS, PAUSE, PROJECTS, SOURCE_BOUNTIES, SOURCE_BOUNTY_COUNT,
    STATUS_HISTORY,
};

const CONTRACT_NAME: &str = "crates.io:hack-juno-registry-adapter";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const NATIVE_DENOM: &str = "ujuno";
pub const DO_NOT_DISTRIBUTE: &str = "do-not-distribute";
pub const MAX_ACTIVE_PROJECTS: u32 = 99;
const MAX_HARD_PAGE_LIMIT: u32 = 100;
const MAX_HARD_SELECTED: u32 = 99;
const MAX_HARD_URI_BYTES: u32 = 2_048;
const MAX_HARD_REASON_BYTES: u32 = 2_048;
const MAX_HARD_ADDRESS_DELAY_SECONDS: u64 = 90 * 24 * 60 * 60;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    let config = Config {
        native_denom: msg.native_denom,
        governor: deps.api.addr_validate(&msg.governor)?,
        curator: deps.api.addr_validate(&msg.curator)?,
        bounty_contract: deps.api.addr_validate(&msg.bounty_contract)?,
        spam_destination: deps.api.addr_validate(&msg.spam_destination)?,
        registration_bond: msg.registration_bond,
        payout_address_delay_seconds: msg.payout_address_delay_seconds,
        epoch_ceiling: msg.epoch_ceiling,
        min_project_share: msg.min_project_share,
        max_project_share: msg.max_project_share,
        max_selected_projects: msg.max_selected_projects,
        max_active_projects: MAX_ACTIVE_PROJECTS,
        max_page_limit: msg.max_page_limit,
        max_metadata_uri_bytes: msg.max_metadata_uri_bytes,
        max_reason_bytes: msg.max_reason_bytes,
        version: 1,
    };
    validate_config(&config)?;
    CONFIG.save(deps.storage, &config)?;
    PAUSE.save(
        deps.storage,
        &PauseState {
            admissions_stopped: false,
            adapter_stopped: false,
            reason: None,
            actor: None,
            changed_at: Some(env.block.time),
        },
    )?;
    ACCOUNTING.save(
        deps.storage,
        &RegistryAccounting {
            active_projects: 0,
            pending_applications: 0,
            bond_liability: Uint128::zero(),
            lifetime_bonds_received: Uint128::zero(),
            lifetime_bonds_refunded: Uint128::zero(),
            lifetime_bonds_forfeited: Uint128::zero(),
        },
    )?;
    NEXT_PROJECT_ID.save(deps.storage, &1)?;
    SOURCE_BOUNTY_COUNT.save(deps.storage, &0)?;
    OPTIONS.save(deps.storage, DO_NOT_DISTRIBUTE, &())?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.instantiated")
            .add_attribute("governor", config.governor)
            .add_attribute("curator", config.curator)
            .add_attribute("bounty_contract", config.bounty_contract)
            .add_attribute("native_denom", config.native_denom)
            .add_attribute("active_capacity", MAX_ACTIVE_PROJECTS.to_string())
            .add_attribute("reserved_option", DO_NOT_DISTRIBUTE),
    ))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::RegisterProject {
            metadata_uri,
            metadata_digest,
            payout_address,
        } => execute_register(
            deps,
            env,
            info,
            metadata_uri,
            metadata_digest,
            payout_address,
        ),
        ExecuteMsg::Graduate {
            source_bounty_id,
            metadata_uri,
            metadata_digest,
            payout_address,
        } => execute_graduate(
            deps,
            env,
            info,
            source_bounty_id,
            metadata_uri,
            metadata_digest,
            payout_address,
        ),
        ExecuteMsg::UpdatePendingMetadata {
            project_id,
            metadata_uri,
            metadata_digest,
        } => execute_update_pending_metadata(
            deps,
            env,
            info,
            project_id,
            metadata_uri,
            metadata_digest,
        ),
        ExecuteMsg::ReviewRegistration {
            project_id,
            decision,
            reason,
        } => execute_review(deps, env, info, project_id, decision, reason),
        ExecuteMsg::Suspend { project_id, reason } => {
            execute_suspend(deps, env, info, project_id, reason)
        }
        ExecuteMsg::Retire { project_id, reason } => {
            execute_retire(deps, env, info, project_id, reason)
        }
        ExecuteMsg::OverrideProjectStatus {
            project_id,
            status,
            reason,
        } => execute_override(deps, env, info, project_id, status, reason),
        ExecuteMsg::ProposePayoutAddress {
            project_id,
            address,
        } => execute_propose_address(deps, env, info, project_id, address),
        ExecuteMsg::CancelPayoutAddressChange { project_id } => {
            execute_cancel_address(deps, env, info, project_id)
        }
        ExecuteMsg::AcceptPayoutAddress { project_id } => {
            execute_accept_address(deps, env, info, project_id)
        }
        ExecuteMsg::ClaimRegistrationBond { project_id } => {
            execute_claim_bond(deps, env, info, project_id)
        }
        ExecuteMsg::Stop { scope, reason } => execute_stop(deps, env, info, scope, reason),
        ExecuteMsg::Resume { scope, reason } => execute_resume(deps, env, info, scope, reason),
        ExecuteMsg::UpdateCurator { curator } => execute_update_curator(deps, env, info, curator),
        ExecuteMsg::UpdateBountyContract { bounty_contract } => {
            execute_update_bounty(deps, env, info, bounty_contract)
        }
        ExecuteMsg::UpdateEconomicConfig { update } => {
            execute_update_economic(deps, env, info, update)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_register(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    metadata_uri: String,
    metadata_digest: String,
    payout_address: String,
) -> Result<Response, ContractError> {
    ensure_admissions_open(deps.storage)?;
    let config = CONFIG.load(deps.storage)?;
    exact_bond(&info, &config)?;
    validate_metadata(&metadata_uri, &metadata_digest, &config)?;
    let payout_address = deps.api.addr_validate(&payout_address)?;
    let project_id = allocate_project_id(deps.storage)?;

    let mut project = Project {
        id: project_id,
        owner: info.sender.clone(),
        metadata_uri,
        metadata_digest,
        payout_address,
        pending_payout_address: None,
        provenance: AdmissionProvenance::BondedRegistration {
            applicant: info.sender.clone(),
        },
        status: ProjectStatus::Pending,
        bond: Some(RegistrationBond {
            depositor: info.sender.clone(),
            amount: config.registration_bond,
            state: BondState::Deposited,
        }),
        latest_review: None,
        created_at: env.block.time,
        updated_at: env.block.time,
        status_history_count: 0,
        address_history_count: 0,
    };
    append_status_history(
        deps.storage,
        &mut project,
        None,
        ProjectStatus::Pending,
        StatusAction::Registered,
        None,
        &info.sender,
        env.block.time,
    )?;
    PROJECTS.save(deps.storage, project_id, &project)?;
    APPLICATIONS.save(deps.storage, project_id, &())?;
    ACCOUNTING.update(deps.storage, |mut accounting| -> Result<_, ContractError> {
        accounting.pending_applications = accounting
            .pending_applications
            .checked_add(1)
            .ok_or_else(|| {
                ContractError::InvalidConfiguration("application count overflow".into())
            })?;
        accounting.bond_liability = accounting
            .bond_liability
            .checked_add(config.registration_bond)?;
        accounting.lifetime_bonds_received = accounting
            .lifetime_bonds_received
            .checked_add(config.registration_bond)?;
        Ok(accounting)
    })?;
    Ok(Response::new()
        .set_data(to_json_binary(&ProjectCreatedResponse {
            response_version: 1,
            project_id,
        })?)
        .add_event(
            Event::new("hack_juno_registry.project_registered")
                .add_attribute("project_id", project_id.to_string())
                .add_attribute("applicant", info.sender)
                .add_attribute("payout_address", project.payout_address)
                .add_attribute("bond", config.registration_bond),
        ))
}

#[allow(clippy::too_many_arguments)]
fn execute_graduate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    source_bounty_id: u64,
    metadata_uri: String,
    metadata_digest: String,
    payout_address: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    ensure_admissions_open(deps.storage)?;
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.bounty_contract {
        return Err(ContractError::Unauthorized);
    }
    validate_metadata(&metadata_uri, &metadata_digest, &config)?;
    if SOURCE_BOUNTIES.has(deps.storage, (&info.sender, source_bounty_id)) {
        return Err(ContractError::DuplicateSourceBounty);
    }
    ensure_active_capacity(deps.storage)?;
    let payout_address = deps.api.addr_validate(&payout_address)?;
    let project_id = allocate_project_id(deps.storage)?;
    let mut project = Project {
        id: project_id,
        owner: payout_address.clone(),
        metadata_uri,
        metadata_digest,
        payout_address,
        pending_payout_address: None,
        provenance: AdmissionProvenance::GraduatedBounty {
            source_bounty_contract: info.sender.clone(),
            source_bounty_id,
        },
        status: ProjectStatus::Active,
        bond: None,
        latest_review: None,
        created_at: env.block.time,
        updated_at: env.block.time,
        status_history_count: 0,
        address_history_count: 0,
    };
    append_status_history(
        deps.storage,
        &mut project,
        None,
        ProjectStatus::Active,
        StatusAction::Graduated,
        None,
        &info.sender,
        env.block.time,
    )?;
    SOURCE_BOUNTIES.save(deps.storage, (&info.sender, source_bounty_id), &project_id)?;
    SOURCE_BOUNTY_COUNT.update(deps.storage, |count| {
        count.checked_add(1).ok_or(ContractError::InvalidState)
    })?;
    PROJECTS.save(deps.storage, project_id, &project)?;
    add_active_option(deps.storage, project_id)?;
    Ok(Response::new()
        .set_data(to_json_binary(&ProjectCreatedResponse {
            response_version: 1,
            project_id,
        })?)
        .add_event(
            Event::new("hack_juno_registry.bounty_graduated")
                .add_attribute("project_id", project_id.to_string())
                .add_attribute("source_bounty_id", source_bounty_id.to_string())
                .add_attribute("source_bounty_contract", info.sender)
                .add_attribute("payout_address", project.payout_address),
        ))
}

fn execute_update_pending_metadata(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
    metadata_uri: String,
    metadata_digest: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    ensure_admissions_open(deps.storage)?;
    let config = CONFIG.load(deps.storage)?;
    validate_metadata(&metadata_uri, &metadata_digest, &config)?;
    let mut project = load_project(deps.storage, project_id)?;
    if project.status != ProjectStatus::Pending || info.sender != project.owner {
        return Err(ContractError::Unauthorized);
    }
    project.metadata_uri = metadata_uri;
    project.metadata_digest = metadata_digest;
    project.updated_at = env.block.time;
    PROJECTS.save(deps.storage, project_id, &project)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.pending_metadata_updated")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("applicant", info.sender),
    ))
}

fn execute_review(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
    decision: ReviewDecision,
    reason: ReviewReason,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let transition = match decision {
        ReviewDecision::Approve => ProjectTransition::Approve,
        ReviewDecision::RequestChanges => ProjectTransition::ReviewNoChange,
        ReviewDecision::SoftReject => ProjectTransition::SoftReject,
        ReviewDecision::HardReject => ProjectTransition::HardReject,
    };
    let result =
        apply_project_transition(deps, &env, &info, project_id, transition, Some(&reason))?;
    let mut response = Response::new();
    if let Some(message) = result.transfer {
        response = response.add_message(message);
    }
    Ok(response.add_event(
        Event::new("hack_juno_registry.registration_reviewed")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("curator", info.sender)
            .add_attribute("decision", decision_name(&decision))
            .add_attribute("reason_code", reason_name(&reason.code))
            .add_attribute("status", status_name(&result.project.status)),
    ))
}

fn execute_suspend(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
    reason: ReviewReason,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    apply_project_transition(
        deps,
        &env,
        &info,
        project_id,
        ProjectTransition::CuratorSuspend,
        Some(&reason),
    )?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.project_suspended")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("curator", info.sender)
            .add_attribute("reason_code", reason_name(&reason.code)),
    ))
}

fn execute_retire(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
    reason: ReviewReason,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let result = apply_project_transition(
        deps,
        &env,
        &info,
        project_id,
        ProjectTransition::Retire,
        Some(&reason),
    )?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.project_retired")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("actor", info.sender)
            .add_attribute(
                "bond_claimable",
                bond_claimable(&result.project).to_string(),
            ),
    ))
}

fn execute_override(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
    target: OverrideStatus,
    reason: ReviewReason,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let project = load_project(deps.storage, project_id)?;
    let target = override_status(target);
    if project.status == target {
        return Err(ContractError::InvalidState);
    }
    let old = project.status.clone();
    let transition = match (&old, &target) {
        (ProjectStatus::Active, ProjectStatus::Suspended) => ProjectTransition::GovernorSuspend,
        (ProjectStatus::Suspended, ProjectStatus::Active) => ProjectTransition::GovernorResume,
        (ProjectStatus::Retired, ProjectStatus::Active) => ProjectTransition::GovernorRestore,
        (ProjectStatus::Active | ProjectStatus::Suspended, ProjectStatus::Retired) => {
            ProjectTransition::GovernorRetire
        }
        _ => return Err(ContractError::InvalidState),
    };
    apply_project_transition(deps, &env, &info, project_id, transition, Some(&reason))?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.project_status_overridden")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("governor", info.sender)
            .add_attribute("status", status_name(&target))
            .add_attribute("reason_code", reason_name(&reason.code)),
    ))
}

fn execute_propose_address(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
    address: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut project = load_project(deps.storage, project_id)?;
    ensure_address_controller(&project, &info.sender)?;
    if !matches!(
        project.status,
        ProjectStatus::Active | ProjectStatus::Suspended
    ) {
        return Err(ContractError::InvalidState);
    }
    let address = deps.api.addr_validate(&address)?;
    if address == project.payout_address {
        return Err(ContractError::InvalidMetadata(
            "new payout address equals current address".into(),
        ));
    }
    let action = if project.pending_payout_address.is_some() {
        AddressAction::Replaced
    } else {
        AddressAction::Proposed
    };
    let executable_at = env
        .block
        .time
        .plus_seconds(config.payout_address_delay_seconds);
    project.pending_payout_address = Some(PendingPayoutAddress {
        address: address.clone(),
        proposed_by: info.sender.clone(),
        proposed_at: env.block.time,
        executable_at,
    });
    project.updated_at = env.block.time;
    append_address_history(
        deps.storage,
        &mut project,
        action,
        Some(address.clone()),
        &info.sender,
        env.block.time,
    )?;
    PROJECTS.save(deps.storage, project_id, &project)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.payout_address_proposed")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("actor", info.sender)
            .add_attribute("proposed_address", address)
            .add_attribute("executable_at", executable_at.nanos().to_string()),
    ))
}

fn execute_cancel_address(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut project = load_project(deps.storage, project_id)?;
    ensure_address_controller(&project, &info.sender)?;
    let pending = project
        .pending_payout_address
        .take()
        .ok_or(ContractError::NoPendingAddress)?;
    project.updated_at = env.block.time;
    append_address_history(
        deps.storage,
        &mut project,
        AddressAction::Cancelled,
        Some(pending.address.clone()),
        &info.sender,
        env.block.time,
    )?;
    PROJECTS.save(deps.storage, project_id, &project)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.payout_address_cancelled")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("actor", info.sender)
            .add_attribute("cancelled_address", pending.address),
    ))
}

fn execute_accept_address(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut project = load_project(deps.storage, project_id)?;
    let pending = project
        .pending_payout_address
        .clone()
        .ok_or(ContractError::NoPendingAddress)?;
    if info.sender != pending.address {
        return Err(ContractError::Unauthorized);
    }
    if env.block.time < pending.executable_at {
        return Err(ContractError::AddressDelayOpen);
    }
    let old = project.payout_address.clone();
    project.payout_address = pending.address.clone();
    project.pending_payout_address = None;
    project.updated_at = env.block.time;
    append_address_history_with_old(
        deps.storage,
        &mut project,
        AddressAction::Accepted,
        old.clone(),
        Some(pending.address.clone()),
        &info.sender,
        env.block.time,
    )?;
    PROJECTS.save(deps.storage, project_id, &project)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.payout_address_accepted")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("old_address", old)
            .add_attribute("new_address", pending.address),
    ))
}

fn execute_claim_bond(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    project_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let result = apply_project_transition(
        deps,
        &env,
        &info,
        project_id,
        ProjectTransition::Claim,
        None,
    )?;
    let bond = result
        .project
        .bond
        .as_ref()
        .ok_or(ContractError::BondNotClaimable)?;
    let amount = bond.amount;
    let mut response = Response::new();
    if let Some(message) = result.transfer {
        response = response.add_message(message);
    }
    Ok(response.add_event(
        Event::new("hack_juno_registry.registration_bond_claimed")
            .add_attribute("project_id", project_id.to_string())
            .add_attribute("depositor", info.sender)
            .add_attribute("amount", amount),
    ))
}

fn execute_stop(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    scope: StopScope,
    reason: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.curator && info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    validate_plain_reason(&reason, &config)?;
    let mut pause = PAUSE.load(deps.storage)?;
    apply_scope(&mut pause, &scope, true);
    pause.reason = Some(reason.clone());
    pause.actor = Some(info.sender.clone());
    pause.changed_at = Some(env.block.time);
    PAUSE.save(deps.storage, &pause)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.stopped")
            .add_attribute("actor", info.sender)
            .add_attribute("scope", scope_name(&scope))
            .add_attribute("reason", reason),
    ))
}

fn execute_resume(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    scope: StopScope,
    reason: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    validate_plain_reason(&reason, &config)?;
    let mut pause = PAUSE.load(deps.storage)?;
    apply_scope(&mut pause, &scope, false);
    pause.reason = Some(reason.clone());
    pause.actor = Some(info.sender.clone());
    pause.changed_at = Some(env.block.time);
    PAUSE.save(deps.storage, &pause)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.resumed")
            .add_attribute("governor", info.sender)
            .add_attribute("scope", scope_name(&scope))
            .add_attribute("reason", reason),
    ))
}

fn execute_update_curator(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    curator: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut config = CONFIG.load(deps.storage)?;
    ensure_governor(&config, &info.sender)?;
    config.curator = deps.api.addr_validate(&curator)?;
    increment_config_version(&mut config)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.curator_updated")
            .add_attribute("governor", info.sender)
            .add_attribute("curator", config.curator)
            .add_attribute("changed_at", env.block.time.nanos().to_string()),
    ))
}

fn execute_update_bounty(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_contract: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut config = CONFIG.load(deps.storage)?;
    ensure_governor(&config, &info.sender)?;
    config.bounty_contract = deps.api.addr_validate(&bounty_contract)?;
    increment_config_version(&mut config)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.bounty_contract_updated")
            .add_attribute("governor", info.sender)
            .add_attribute("bounty_contract", config.bounty_contract)
            .add_attribute("changed_at", env.block.time.nanos().to_string()),
    ))
}

fn execute_update_economic(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    update: EconomicConfigUpdate,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut config = CONFIG.load(deps.storage)?;
    ensure_governor(&config, &info.sender)?;
    if let Some(value) = update.registration_bond {
        config.registration_bond = value;
    }
    if let Some(value) = update.spam_destination {
        config.spam_destination = deps.api.addr_validate(&value)?;
    }
    if let Some(value) = update.payout_address_delay_seconds {
        config.payout_address_delay_seconds = value;
    }
    if let Some(value) = update.epoch_ceiling {
        config.epoch_ceiling = value;
    }
    if let Some(value) = update.min_project_share {
        config.min_project_share = value;
    }
    if let Some(value) = update.max_project_share {
        config.max_project_share = value;
    }
    if let Some(value) = update.max_selected_projects {
        config.max_selected_projects = value;
    }
    increment_config_version(&mut config)?;
    validate_config(&config)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_event(
        Event::new("hack_juno_registry.economic_config_updated")
            .add_attribute("governor", info.sender)
            .add_attribute("config_version", config.version.to_string())
            .add_attribute("changed_at", env.block.time.nanos().to_string()),
    ))
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_inner(deps, env, msg).map_err(|err| StdError::generic_err(err.to_string()))
}

fn query_inner(deps: Deps, env: Env, msg: QueryMsg) -> Result<Binary, ContractError> {
    match msg {
        QueryMsg::Config {} => Ok(to_json_binary(&CONFIG.load(deps.storage)?)?),
        QueryMsg::Pause {} => Ok(to_json_binary(&PAUSE.load(deps.storage)?)?),
        QueryMsg::Accounting {} => Ok(to_json_binary(&ACCOUNTING.load(deps.storage)?)?),
        QueryMsg::IdentityState {} => Ok(to_json_binary(&IdentityStateResponse {
            next_project_id: NEXT_PROJECT_ID.load(deps.storage)?,
            consumed_source_bounties: SOURCE_BOUNTY_COUNT.load(deps.storage)?,
        })?),
        QueryMsg::Health {} => {
            let config = CONFIG.load(deps.storage)?;
            let accounting = ACCOUNTING.load(deps.storage)?;
            let actual = deps
                .querier
                .query_balance(env.contract.address, config.native_denom)?
                .amount;
            Ok(to_json_binary(&HealthResponse {
                fully_backed: accounting.bond_liability <= actual,
                accounting,
                actual_native_balance: actual,
            })?)
        }
        QueryMsg::Project { project_id } => {
            Ok(to_json_binary(&load_project(deps.storage, project_id)?)?)
        }
        QueryMsg::Projects { start_after, limit } => {
            let start = start_after.map(Bound::exclusive);
            let projects = PROJECTS
                .range(deps.storage, start, None, Order::Ascending)
                .take(page_limit(deps.storage, limit)?)
                .map(|item| item.map(|(_, project)| project))
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&ProjectsResponse { projects })?)
        }
        QueryMsg::Applications { start_after, limit } => {
            let start = start_after.map(Bound::exclusive);
            let projects = APPLICATIONS
                .range(deps.storage, start, None, Order::Ascending)
                .take(page_limit(deps.storage, limit)?)
                .map(|item| {
                    let (id, _) = item?;
                    PROJECTS.load(deps.storage, id)
                })
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&ProjectsResponse { projects })?)
        }
        QueryMsg::StatusHistory {
            project_id,
            start_after,
            limit,
        } => {
            load_project(deps.storage, project_id)?;
            let entries = STATUS_HISTORY
                .prefix(project_id)
                .range(
                    deps.storage,
                    start_after.map(Bound::exclusive),
                    None,
                    Order::Ascending,
                )
                .take(page_limit(deps.storage, limit)?)
                .map(|item| item.map(|(_, entry)| entry))
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&HistoryResponse { entries })?)
        }
        QueryMsg::AddressHistory {
            project_id,
            start_after,
            limit,
        } => {
            load_project(deps.storage, project_id)?;
            let entries = ADDRESS_HISTORY
                .prefix(project_id)
                .range(
                    deps.storage,
                    start_after.map(Bound::exclusive),
                    None,
                    Order::Ascending,
                )
                .take(page_limit(deps.storage, limit)?)
                .map(|item| item.map(|(_, entry)| entry))
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&HistoryResponse { entries })?)
        }
        QueryMsg::AllOptions { start_after, limit } => {
            let options = OPTIONS
                .keys(
                    deps.storage,
                    start_after.as_deref().map(Bound::exclusive),
                    None,
                    Order::Ascending,
                )
                .take(page_limit(deps.storage, limit)?)
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&AllOptionsResponse { options })?)
        }
        QueryMsg::CheckOption { option } => Ok(to_json_binary(&CheckOptionResponse {
            valid: OPTIONS.has(deps.storage, &option),
        })?),
        QueryMsg::SampleGaugeMsgs {
            selected,
            epoch_budget,
            available_balance,
            denom,
        } => Ok(to_json_binary(&sample_gauge_messages(
            deps.storage,
            selected,
            epoch_budget,
            available_balance,
            denom,
        )?)?),
    }
}

pub(crate) fn sample_gauge_messages(
    storage: &dyn Storage,
    selected: Vec<(String, Decimal)>,
    epoch_budget: Uint128,
    _available_balance: Uint128,
    denom: String,
) -> Result<SampleGaugeMsgsResponse, ContractError> {
    let config = CONFIG.load(storage)?;
    if PAUSE.load(storage)?.adapter_stopped {
        return Err(ContractError::AdapterStopped);
    }
    if denom != config.native_denom {
        return Err(ContractError::WrongDenom);
    }
    if epoch_budget > config.epoch_ceiling {
        return Err(ContractError::EpochCeilingExceeded);
    }
    if selected.len() > config.max_selected_projects as usize + 1 {
        return Err(ContractError::InvalidAllocation(
            "too many selected options".into(),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut total_share = Decimal::zero();
    let mut selected_projects = 0usize;
    for (option, share) in &selected {
        if option.is_empty() || share.is_zero() {
            return Err(ContractError::InvalidAllocation(
                "selected options and shares must be nonzero".into(),
            ));
        }
        if !seen.insert(option.as_str()) {
            return Err(ContractError::InvalidAllocation(format!(
                "duplicate selected option: {option}"
            )));
        }
        if option != DO_NOT_DISTRIBUTE {
            selected_projects += 1;
            if selected_projects > config.max_selected_projects as usize {
                return Err(ContractError::InvalidAllocation(
                    "too many selected projects".into(),
                ));
            }
        }
        total_share = total_share.checked_add(*share)?;
        if total_share > Decimal::one() {
            return Err(ContractError::InvalidAllocation(
                "selected shares exceed one".into(),
            ));
        }
    }

    let mut execute = Vec::with_capacity(selected.len());
    let mut emitted_value = Uint128::zero();
    for (option, share) in selected {
        if option == DO_NOT_DISTRIBUTE {
            continue;
        }
        let project_id = decode_project_option(&option)?;
        let project = PROJECTS
            .may_load(storage, project_id)?
            .ok_or_else(|| ContractError::InvalidAllocation(format!("unknown option: {option}")))?;
        if project.status != ProjectStatus::Active {
            continue;
        }
        if share < config.min_project_share {
            continue;
        }
        let applied_share = share.min(config.max_project_share);
        let amount = epoch_budget.checked_multiply_ratio(
            applied_share.atomics().u128(),
            Decimal::one().atomics().u128(),
        )?;
        if amount.is_zero() {
            continue;
        }
        emitted_value = emitted_value.checked_add(amount)?;
        execute.push(CosmosMsg::Bank(BankMsg::Send {
            to_address: project.payout_address.to_string(),
            amount: vec![Coin::new(amount.u128(), config.native_denom.clone())],
        }));
    }
    if execute.len() > config.max_selected_projects as usize || emitted_value > epoch_budget {
        return Err(ContractError::InvalidAllocation(
            "message or emitted-value bound exceeded".into(),
        ));
    }
    Ok(SampleGaugeMsgsResponse {
        execute,
        emitted_value,
        retained_value: epoch_budget.checked_sub(emitted_value)?,
    })
}

fn validate_config(config: &Config) -> Result<(), ContractError> {
    if config.native_denom != NATIVE_DENOM
        || config.registration_bond.is_zero()
        || config.payout_address_delay_seconds == 0
        || config.payout_address_delay_seconds > MAX_HARD_ADDRESS_DELAY_SECONDS
        || config.epoch_ceiling.is_zero()
        || config.min_project_share > config.max_project_share
        || config.max_project_share > Decimal::one()
        || config.max_selected_projects == 0
        || config.max_selected_projects > MAX_HARD_SELECTED
        || config.max_active_projects != MAX_ACTIVE_PROJECTS
        || config.max_page_limit == 0
        || config.max_page_limit > MAX_HARD_PAGE_LIMIT
        || config.max_metadata_uri_bytes == 0
        || config.max_metadata_uri_bytes > MAX_HARD_URI_BYTES
        || config.max_reason_bytes == 0
        || config.max_reason_bytes > MAX_HARD_REASON_BYTES
    {
        return Err(ContractError::InvalidConfiguration(
            "denomination, economic policy, or hard bound is invalid".into(),
        ));
    }
    Ok(())
}

fn allocate_project_id(storage: &mut dyn Storage) -> Result<u64, ContractError> {
    let project_id = NEXT_PROJECT_ID.load(storage)?;
    if project_id == 0 {
        return Err(ContractError::InvalidConfiguration(
            "next project id must be positive".into(),
        ));
    }
    let next = project_id
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidConfiguration("project id space exhausted".into()))?;
    NEXT_PROJECT_ID.save(storage, &next)?;
    Ok(project_id)
}

pub fn encode_project_option(id: u64) -> Result<String, ContractError> {
    if id == 0 {
        return Err(ContractError::InvalidMetadata(
            "project id must be positive".into(),
        ));
    }
    Ok(format!("project:{id}"))
}

pub fn decode_project_option(option: &str) -> Result<u64, ContractError> {
    let raw = option
        .strip_prefix("project:")
        .ok_or_else(|| ContractError::InvalidAllocation("malformed project option".into()))?;
    if raw.is_empty()
        || (raw.len() > 1 && raw.starts_with('0'))
        || !raw.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ContractError::InvalidAllocation(
            "malformed project option".into(),
        ));
    }
    let id = raw
        .parse::<u64>()
        .map_err(|_| ContractError::InvalidAllocation("malformed project option".into()))?;
    if encode_project_option(id)? != option {
        return Err(ContractError::InvalidAllocation(
            "malformed project option".into(),
        ));
    }
    Ok(id)
}

fn validate_metadata(uri: &str, digest: &str, config: &Config) -> Result<(), ContractError> {
    if uri.trim().is_empty() || uri.len() > config.max_metadata_uri_bytes as usize {
        return Err(ContractError::InvalidMetadata(
            "metadata URI is empty or exceeds its byte bound".into(),
        ));
    }
    validate_digest(digest)
}

fn validate_digest(value: &str) -> Result<(), ContractError> {
    let hex = value.strip_prefix("sha256:").ok_or_else(|| {
        ContractError::InvalidMetadata("digest must use sha256:<lowercase-hex>".into())
    })?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ContractError::InvalidMetadata(
            "digest must contain exactly 64 lowercase hex characters".into(),
        ));
    }
    Ok(())
}

fn validate_reason(reason: &ReviewReason, config: &Config) -> Result<(), ContractError> {
    validate_plain_reason(&reason.note, config)
}

fn validate_plain_reason(value: &str, config: &Config) -> Result<(), ContractError> {
    if value.trim().is_empty() || value.len() > config.max_reason_bytes as usize {
        return Err(ContractError::InvalidMetadata(
            "reason is empty or exceeds its byte bound".into(),
        ));
    }
    Ok(())
}

fn nonpayable(info: &MessageInfo) -> Result<(), ContractError> {
    if !info.funds.is_empty() {
        return Err(ContractError::UnexpectedFunds);
    }
    Ok(())
}

fn exact_bond(info: &MessageInfo, config: &Config) -> Result<(), ContractError> {
    match info.funds.as_slice() {
        [coin] if coin.denom == config.native_denom && coin.amount == config.registration_bond => {
            Ok(())
        }
        _ => Err(ContractError::InvalidBond),
    }
}

fn ensure_admissions_open(storage: &dyn Storage) -> Result<(), ContractError> {
    if PAUSE.load(storage)?.admissions_stopped {
        return Err(ContractError::AdmissionsStopped);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ProjectTransition {
    ReviewNoChange,
    Approve,
    SoftReject,
    HardReject,
    CuratorSuspend,
    GovernorSuspend,
    GovernorResume,
    Retire,
    GovernorRetire,
    GovernorRestore,
    Claim,
}

struct ProjectTransitionResult {
    project: Project,
    transfer: Option<BankMsg>,
}

/// The only mutation path for an existing project's status, bond, option
/// membership, pending/active counts, and bond liability. It validates caller
/// authority and the typed reason before checking the complete stored-state
/// invariant and applying the requested transition atomically.
fn apply_project_transition(
    deps: DepsMut,
    env: &Env,
    info: &MessageInfo,
    project_id: u64,
    transition: ProjectTransition,
    reason: Option<&ReviewReason>,
) -> Result<ProjectTransitionResult, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut project = load_project(deps.storage, project_id)?;

    match transition {
        ProjectTransition::ReviewNoChange
        | ProjectTransition::Approve
        | ProjectTransition::SoftReject
        | ProjectTransition::HardReject
        | ProjectTransition::CuratorSuspend => {
            if info.sender != config.curator {
                return Err(ContractError::Unauthorized);
            }
        }
        ProjectTransition::Retire => {
            if info.sender != config.curator && info.sender != project.owner {
                return Err(ContractError::Unauthorized);
            }
        }
        ProjectTransition::GovernorSuspend
        | ProjectTransition::GovernorResume
        | ProjectTransition::GovernorRetire
        | ProjectTransition::GovernorRestore => {
            if info.sender != config.governor {
                return Err(ContractError::Unauthorized);
            }
        }
        ProjectTransition::Claim => {
            let bond = project
                .bond
                .as_ref()
                .ok_or(ContractError::BondNotClaimable)?;
            if info.sender != bond.depositor {
                return Err(ContractError::Unauthorized);
            }
            if bond.state != BondState::Claimable {
                return Err(ContractError::BondNotClaimable);
            }
        }
    }

    if transition == ProjectTransition::Claim {
        if reason.is_some() {
            return Err(ContractError::InvalidState);
        }
    } else {
        let reason = reason.ok_or(ContractError::InvalidState)?;
        validate_reason(reason, &config)?;
        if transition == ProjectTransition::HardReject
            && !matches!(
                reason.code,
                ReviewReasonCode::Spam | ReviewReasonCode::PolicyViolation
            )
        {
            return Err(ContractError::InvalidMetadata(
                "hard rejection requires spam or policy_violation reason".into(),
            ));
        }
        if transition == ProjectTransition::Retire
            && info.sender == project.owner
            && reason.code != ReviewReasonCode::VoluntaryRetirement
        {
            return Err(ContractError::InvalidMetadata(
                "owner retirement requires voluntary_retirement reason".into(),
            ));
        }
    }

    validate_project_transition(deps.as_ref(), env, &project, transition)?;

    let old_status = project.status.clone();
    let mut transfer = None;
    let history_action = match transition {
        ProjectTransition::ReviewNoChange => Some(StatusAction::Reviewed {
            decision: ReviewDecision::RequestChanges,
        }),
        ProjectTransition::Approve => {
            APPLICATIONS.remove(deps.storage, project_id);
            decrement_pending_application(deps.storage)?;
            add_active_option(deps.storage, project_id)?;
            project.status = ProjectStatus::Active;
            Some(StatusAction::Reviewed {
                decision: ReviewDecision::Approve,
            })
        }
        ProjectTransition::SoftReject => {
            APPLICATIONS.remove(deps.storage, project_id);
            let (depositor, amount) =
                dispose_bond(&mut project, BondState::Refunded, deps.storage, false)?;
            decrement_pending_application(deps.storage)?;
            project.status = ProjectStatus::Rejected;
            transfer = Some(BankMsg::Send {
                to_address: depositor.to_string(),
                amount: vec![Coin::new(amount.u128(), config.native_denom.clone())],
            });
            Some(StatusAction::Reviewed {
                decision: ReviewDecision::SoftReject,
            })
        }
        ProjectTransition::HardReject => {
            APPLICATIONS.remove(deps.storage, project_id);
            let (_, amount) = dispose_bond(&mut project, BondState::Forfeited, deps.storage, true)?;
            decrement_pending_application(deps.storage)?;
            project.status = ProjectStatus::Rejected;
            transfer = Some(BankMsg::Send {
                to_address: config.spam_destination.to_string(),
                amount: vec![Coin::new(amount.u128(), config.native_denom.clone())],
            });
            Some(StatusAction::Reviewed {
                decision: ReviewDecision::HardReject,
            })
        }
        ProjectTransition::CuratorSuspend | ProjectTransition::GovernorSuspend => {
            remove_active_option(deps.storage, project_id)?;
            project.status = ProjectStatus::Suspended;
            Some(if transition == ProjectTransition::CuratorSuspend {
                StatusAction::Suspended
            } else {
                StatusAction::GovernorOverride
            })
        }
        ProjectTransition::GovernorResume => {
            add_active_option(deps.storage, project_id)?;
            project.status = ProjectStatus::Active;
            Some(StatusAction::GovernorOverride)
        }
        ProjectTransition::Retire | ProjectTransition::GovernorRetire => {
            if project.status == ProjectStatus::Active {
                remove_active_option(deps.storage, project_id)?;
            }
            make_bond_claimable(&mut project)?;
            project.status = ProjectStatus::Retired;
            Some(if transition == ProjectTransition::Retire {
                StatusAction::Retired
            } else {
                StatusAction::GovernorOverride
            })
        }
        ProjectTransition::GovernorRestore => {
            if let Some(bond) = project.bond.as_mut() {
                bond.state = BondState::Deposited;
            }
            add_active_option(deps.storage, project_id)?;
            project.status = ProjectStatus::Active;
            Some(StatusAction::GovernorOverride)
        }
        ProjectTransition::Claim => {
            let bond = project
                .bond
                .as_mut()
                .ok_or(ContractError::BondNotClaimable)?;
            let amount = bond.amount;
            bond.state = BondState::Claimed;
            ACCOUNTING.update(deps.storage, |mut accounting| -> Result<_, ContractError> {
                accounting.bond_liability = accounting.bond_liability.checked_sub(amount)?;
                accounting.lifetime_bonds_refunded =
                    accounting.lifetime_bonds_refunded.checked_add(amount)?;
                Ok(accounting)
            })?;
            transfer = Some(BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin::new(amount.u128(), config.native_denom)],
            });
            None
        }
    };

    project.updated_at = env.block.time;
    if let Some(action) = history_action {
        let reason = reason.cloned().ok_or(ContractError::InvalidState)?;
        project.latest_review = Some(reason.clone());
        let new_status = project.status.clone();
        append_status_history(
            deps.storage,
            &mut project,
            Some(old_status),
            new_status,
            action,
            Some(reason),
            &info.sender,
            env.block.time,
        )?;
    }
    PROJECTS.save(deps.storage, project_id, &project)?;

    Ok(ProjectTransitionResult { project, transfer })
}

/// Stored-state invariant gate used only by `apply_project_transition`.
pub(crate) fn validate_project_transition(
    deps: Deps,
    env: &Env,
    project: &Project,
    transition: ProjectTransition,
) -> Result<(), ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let accounting = ACCOUNTING.load(deps.storage)?;
    let actual_balance = deps
        .querier
        .query_balance(env.contract.address.clone(), config.native_denom)?
        .amount;
    if accounting.bond_liability > actual_balance {
        return Err(ContractError::InvalidState);
    }

    let bonded_state = match (&project.provenance, &project.bond) {
        (AdmissionProvenance::BondedRegistration { .. }, Some(bond)) => Some(&bond.state),
        (AdmissionProvenance::GraduatedBounty { .. }, None) => None,
        _ => return Err(ContractError::InvalidState),
    };
    let option = encode_project_option(project.id)?;
    let option_present = OPTIONS.has(deps.storage, &option);
    let application_present = APPLICATIONS.has(deps.storage, project.id);
    if option_present != (project.status == ProjectStatus::Active)
        || application_present != (project.status == ProjectStatus::Pending)
    {
        return Err(ContractError::InvalidState);
    }
    if matches!(
        project.status,
        ProjectStatus::Active | ProjectStatus::Suspended
    ) && bonded_state.is_some_and(|state| *state != BondState::Deposited)
    {
        return Err(ContractError::InvalidState);
    }

    let valid = matches!(
        (transition, &project.status, bonded_state),
        (
            ProjectTransition::ReviewNoChange,
            ProjectStatus::Pending,
            Some(BondState::Deposited)
        ) | (
            ProjectTransition::Approve,
            ProjectStatus::Pending,
            Some(BondState::Deposited)
        ) | (
            ProjectTransition::SoftReject,
            ProjectStatus::Pending,
            Some(BondState::Deposited)
        ) | (
            ProjectTransition::HardReject,
            ProjectStatus::Pending,
            Some(BondState::Deposited)
        ) | (
            ProjectTransition::CuratorSuspend | ProjectTransition::GovernorSuspend,
            ProjectStatus::Active,
            Some(BondState::Deposited)
        ) | (
            ProjectTransition::CuratorSuspend | ProjectTransition::GovernorSuspend,
            ProjectStatus::Active,
            None
        ) | (
            ProjectTransition::GovernorResume,
            ProjectStatus::Suspended,
            Some(BondState::Deposited)
        ) | (
            ProjectTransition::GovernorResume,
            ProjectStatus::Suspended,
            None
        ) | (
            ProjectTransition::Retire | ProjectTransition::GovernorRetire,
            ProjectStatus::Active | ProjectStatus::Suspended,
            Some(BondState::Deposited),
        ) | (
            ProjectTransition::Retire | ProjectTransition::GovernorRetire,
            ProjectStatus::Active | ProjectStatus::Suspended,
            None
        ) | (
            ProjectTransition::GovernorRestore,
            ProjectStatus::Retired,
            Some(BondState::Claimable)
        ) | (
            ProjectTransition::GovernorRestore,
            ProjectStatus::Retired,
            None
        ) | (
            ProjectTransition::Claim,
            ProjectStatus::Retired,
            Some(BondState::Claimable)
        )
    );
    if !valid {
        return Err(ContractError::InvalidState);
    }
    if matches!(
        transition,
        ProjectTransition::Approve
            | ProjectTransition::GovernorResume
            | ProjectTransition::GovernorRestore
    ) {
        ensure_active_capacity(deps.storage)?;
    }
    Ok(())
}

fn ensure_active_capacity(storage: &dyn Storage) -> Result<(), ContractError> {
    let accounting = ACCOUNTING.load(storage)?;
    if accounting.active_projects >= MAX_ACTIVE_PROJECTS {
        return Err(ContractError::CapacityFull);
    }
    Ok(())
}

fn add_active_option(storage: &mut dyn Storage, id: u64) -> Result<(), ContractError> {
    ensure_active_capacity(storage)?;
    let option = encode_project_option(id)?;
    OPTIONS.save(storage, &option, &())?;
    ACCOUNTING.update(storage, |mut accounting| -> Result<_, ContractError> {
        accounting.active_projects = accounting
            .active_projects
            .checked_add(1)
            .ok_or(ContractError::CapacityFull)?;
        Ok(accounting)
    })?;
    Ok(())
}

fn remove_active_option(storage: &mut dyn Storage, id: u64) -> Result<(), ContractError> {
    let option = encode_project_option(id)?;
    OPTIONS.remove(storage, &option);
    ACCOUNTING.update(storage, |mut accounting| -> Result<_, ContractError> {
        accounting.active_projects = accounting
            .active_projects
            .checked_sub(1)
            .ok_or_else(|| ContractError::InvalidConfiguration("active count underflow".into()))?;
        Ok(accounting)
    })?;
    Ok(())
}

fn load_project(storage: &dyn Storage, id: u64) -> Result<Project, ContractError> {
    PROJECTS
        .may_load(storage, id)?
        .ok_or(ContractError::NotFound)
}

fn decrement_pending_application(storage: &mut dyn Storage) -> Result<(), ContractError> {
    ACCOUNTING.update(storage, |mut accounting| -> Result<_, ContractError> {
        accounting.pending_applications = accounting
            .pending_applications
            .checked_sub(1)
            .ok_or_else(|| ContractError::InvalidConfiguration("application underflow".into()))?;
        Ok(accounting)
    })?;
    Ok(())
}

fn dispose_bond(
    project: &mut Project,
    state: BondState,
    storage: &mut dyn Storage,
    forfeited: bool,
) -> Result<(cosmwasm_std::Addr, Uint128), ContractError> {
    let bond = project.bond.as_mut().ok_or(ContractError::InvalidState)?;
    if bond.state != BondState::Deposited {
        return Err(ContractError::InvalidState);
    }
    bond.state = state;
    let depositor = bond.depositor.clone();
    let amount = bond.amount;
    ACCOUNTING.update(storage, |mut accounting| -> Result<_, ContractError> {
        accounting.bond_liability = accounting.bond_liability.checked_sub(amount)?;
        if forfeited {
            accounting.lifetime_bonds_forfeited =
                accounting.lifetime_bonds_forfeited.checked_add(amount)?;
        } else {
            accounting.lifetime_bonds_refunded =
                accounting.lifetime_bonds_refunded.checked_add(amount)?;
        }
        Ok(accounting)
    })?;
    Ok((depositor, amount))
}

fn make_bond_claimable(project: &mut Project) -> Result<(), ContractError> {
    if let Some(bond) = project.bond.as_mut() {
        match bond.state {
            BondState::Deposited => bond.state = BondState::Claimable,
            BondState::Claimable | BondState::Claimed => {}
            BondState::Refunded | BondState::Forfeited => return Err(ContractError::InvalidState),
        }
    }
    Ok(())
}

fn bond_claimable(project: &Project) -> bool {
    project
        .bond
        .as_ref()
        .is_some_and(|bond| bond.state == BondState::Claimable)
}

#[allow(clippy::too_many_arguments)]
fn append_status_history(
    storage: &mut dyn Storage,
    project: &mut Project,
    from: Option<ProjectStatus>,
    to: ProjectStatus,
    action: StatusAction,
    reason: Option<ReviewReason>,
    actor: &cosmwasm_std::Addr,
    at: cosmwasm_std::Timestamp,
) -> Result<(), ContractError> {
    project.status_history_count = project
        .status_history_count
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidConfiguration("history overflow".into()))?;
    STATUS_HISTORY.save(
        storage,
        (project.id, project.status_history_count),
        &StatusHistoryEntry {
            project_id: project.id,
            sequence: project.status_history_count,
            from,
            to,
            action,
            reason,
            actor: actor.clone(),
            at,
        },
    )?;
    Ok(())
}

fn append_address_history(
    storage: &mut dyn Storage,
    project: &mut Project,
    action: AddressAction,
    proposed_address: Option<cosmwasm_std::Addr>,
    actor: &cosmwasm_std::Addr,
    at: cosmwasm_std::Timestamp,
) -> Result<(), ContractError> {
    append_address_history_with_old(
        storage,
        project,
        action,
        project.payout_address.clone(),
        proposed_address,
        actor,
        at,
    )
}

#[allow(clippy::too_many_arguments)]
fn append_address_history_with_old(
    storage: &mut dyn Storage,
    project: &mut Project,
    action: AddressAction,
    old_address: cosmwasm_std::Addr,
    proposed_address: Option<cosmwasm_std::Addr>,
    actor: &cosmwasm_std::Addr,
    at: cosmwasm_std::Timestamp,
) -> Result<(), ContractError> {
    project.address_history_count = project
        .address_history_count
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidConfiguration("address history overflow".into()))?;
    ADDRESS_HISTORY.save(
        storage,
        (project.id, project.address_history_count),
        &AddressHistoryEntry {
            project_id: project.id,
            sequence: project.address_history_count,
            action,
            old_address,
            proposed_address,
            actor: actor.clone(),
            at,
        },
    )?;
    Ok(())
}

fn ensure_address_controller(
    project: &Project,
    sender: &cosmwasm_std::Addr,
) -> Result<(), ContractError> {
    if sender != project.owner && sender != project.payout_address {
        return Err(ContractError::Unauthorized);
    }
    Ok(())
}

fn ensure_governor(config: &Config, sender: &cosmwasm_std::Addr) -> Result<(), ContractError> {
    if sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    Ok(())
}

fn increment_config_version(config: &mut Config) -> Result<(), ContractError> {
    config.version = config
        .version
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidConfiguration("config version overflow".into()))?;
    Ok(())
}

fn apply_scope(pause: &mut PauseState, scope: &StopScope, stopped: bool) {
    match scope {
        StopScope::Admissions => pause.admissions_stopped = stopped,
        StopScope::Adapter => pause.adapter_stopped = stopped,
        StopScope::All => {
            pause.admissions_stopped = stopped;
            pause.adapter_stopped = stopped;
        }
    }
}

fn override_status(status: OverrideStatus) -> ProjectStatus {
    match status {
        OverrideStatus::Active => ProjectStatus::Active,
        OverrideStatus::Suspended => ProjectStatus::Suspended,
        OverrideStatus::Rejected => ProjectStatus::Rejected,
        OverrideStatus::Retired => ProjectStatus::Retired,
    }
}

fn page_limit(storage: &dyn Storage, requested: Option<u32>) -> Result<usize, ContractError> {
    let max = CONFIG.load(storage)?.max_page_limit;
    let limit = requested.unwrap_or(max).min(max);
    if limit == 0 {
        return Err(ContractError::InvalidConfiguration(
            "query limit must be positive".into(),
        ));
    }
    Ok(limit as usize)
}

fn status_name(status: &ProjectStatus) -> &'static str {
    match status {
        ProjectStatus::Pending => "pending",
        ProjectStatus::Active => "active",
        ProjectStatus::Suspended => "suspended",
        ProjectStatus::Rejected => "rejected",
        ProjectStatus::Retired => "retired",
    }
}

fn decision_name(decision: &ReviewDecision) -> &'static str {
    match decision {
        ReviewDecision::Approve => "approve",
        ReviewDecision::RequestChanges => "request_changes",
        ReviewDecision::SoftReject => "soft_reject",
        ReviewDecision::HardReject => "hard_reject",
    }
}

fn reason_name(reason: &ReviewReasonCode) -> &'static str {
    match reason {
        ReviewReasonCode::MeetsCriteria => "meets_criteria",
        ReviewReasonCode::IncompleteApplication => "incomplete_application",
        ReviewReasonCode::Duplicate => "duplicate",
        ReviewReasonCode::Spam => "spam",
        ReviewReasonCode::PolicyViolation => "policy_violation",
        ReviewReasonCode::GovernanceOverride => "governance_override",
        ReviewReasonCode::VoluntaryRetirement => "voluntary_retirement",
    }
}

fn scope_name(scope: &StopScope) -> &'static str {
    match scope {
        StopScope::Admissions => "admissions",
        StopScope::Adapter => "adapter",
        StopScope::All => "all",
    }
}
