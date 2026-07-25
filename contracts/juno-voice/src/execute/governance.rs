use cosmwasm_std::{DepsMut, Env, MessageInfo, Response, Uint128};

use crate::bindings::JunoQuery;
use crate::contract::{
    action_response, checked_protocol_action_ids, persist_protocol_action, validate_address,
    validate_reason, validate_request_limits, validate_threshold,
};
use crate::error::ContractError;
use crate::execute::set_status::{persist_transition, TransitionWrite};
use crate::msg::RecoveryReason;
use crate::state::{
    BondState, Config, FutureRequestPolicy, ProtocolAction, ProtocolActionRecord, RequestAction,
    RequestLimits, Status, BOND_TOTALS, CONFIG, REQUESTS,
};

pub fn pause(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    paused: bool,
    reason: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if if paused {
        info.sender != config.governor && info.sender != config.steward
    } else {
        info.sender != config.governor
    } {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    if config.submissions_paused == paused {
        return Err(ContractError::PauseStateUnchanged);
    }
    let (id, next_id) = checked_protocol_action_ids(deps.storage)?;
    config.submissions_paused = paused;
    let record = ProtocolActionRecord {
        id,
        actor: info.sender,
        action: if paused {
            ProtocolAction::SubmissionsPaused
        } else {
            ProtocolAction::SubmissionsUnpaused
        },
        reason: Some(reason),
        height: env.block.height,
        timestamp: env.block.time,
    };
    persist_protocol_action(deps.storage, &config, &record, next_id)?;
    Ok(action_response(
        if paused {
            "pause_submissions"
        } else {
            "unpause_submissions"
        },
        id,
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn update_config(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    submission_bond: Option<Uint128>,
    voting_period_blocks: Option<u64>,
    quorum_bps: Option<u16>,
    support_bps: Option<u16>,
    work_inactivity_blocks: Option<u64>,
    request_limits: Option<RequestLimits>,
    reason: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    if submission_bond.is_none()
        && voting_period_blocks.is_none()
        && quorum_bps.is_none()
        && support_bps.is_none()
        && work_inactivity_blocks.is_none()
        && request_limits.is_none()
    {
        return Err(ContractError::ConfigUnchanged);
    }
    let old_policy = policy(&config);
    if let Some(value) = submission_bond {
        if value.is_zero() {
            return Err(ContractError::InvalidSubmissionBond);
        }
        config.submission_bond = value;
    }
    if let Some(value) = voting_period_blocks {
        if value == 0 {
            return Err(ContractError::InvalidVotingPeriod);
        }
        config.voting_period_blocks = value;
    }
    if let Some(value) = quorum_bps {
        validate_threshold("quorum_bps", value)?;
        config.quorum_bps = value;
    }
    if let Some(value) = support_bps {
        validate_threshold("support_bps", value)?;
        config.support_bps = value;
    }
    if let Some(value) = work_inactivity_blocks {
        if value == 0 {
            return Err(ContractError::InvalidWorkInactivityPeriod);
        }
        config.work_inactivity_blocks = value;
    }
    if let Some(value) = request_limits {
        validate_request_limits(&value, config.max_reason_bytes)?;
        config.request_limits = value;
    }
    let new_policy = policy(&config);
    if old_policy == new_policy {
        return Err(ContractError::ConfigUnchanged);
    }
    env.block
        .height
        .checked_add(config.voting_period_blocks)
        .ok_or(ContractError::CloseHeightOverflow)?;
    let (id, next_id) = checked_protocol_action_ids(deps.storage)?;
    let record = ProtocolActionRecord {
        id,
        actor: info.sender,
        action: ProtocolAction::ConfigUpdated {
            old_policy,
            new_policy,
        },
        reason: Some(reason),
        height: env.block.height,
        timestamp: env.block.time,
    };
    persist_protocol_action(deps.storage, &config, &record, next_id)?;
    Ok(action_response("update_config", id))
}

pub fn replace_role(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    address: String,
    reason: String,
    steward: bool,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let role = if steward { "steward" } else { "verifier" };
    let replacement = validate_address(deps.api, &address, role)?;
    let previous = if steward {
        config.steward.clone()
    } else {
        config.verifier.clone()
    };
    if replacement == previous {
        return Err(ContractError::RoleUnchanged);
    }
    let (id, next_id) = checked_protocol_action_ids(deps.storage)?;
    let action = if steward {
        config.steward = replacement.clone();
        ProtocolAction::StewardReplaced {
            previous,
            steward: replacement,
        }
    } else {
        config.verifier = replacement.clone();
        ProtocolAction::VerifierReplaced {
            previous,
            verifier: replacement,
        }
    };
    let record = ProtocolActionRecord {
        id,
        actor: info.sender,
        action,
        reason: Some(reason),
        height: env.block.height,
        timestamp: env.block.time,
    };
    persist_protocol_action(deps.storage, &config, &record, next_id)?;
    Ok(action_response(
        if steward {
            "replace_steward"
        } else {
            "replace_verifier"
        },
        id,
    ))
}

pub fn emergency_archive(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    reason: RecoveryReason,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    if !config.submissions_paused {
        return Err(ContractError::SubmissionsNotPaused);
    }
    let mut request = REQUESTS
        .may_load(deps.storage, request_id)?
        .ok_or(ContractError::UnknownRequest { request_id })?;
    if request.status != Status::Open {
        return Err(ContractError::InvalidStatusTransition);
    }
    if request.bond.state != BondState::Locked || request.bond.amount.is_zero() {
        return Err(ContractError::BondInvariant);
    }
    let mut totals = BOND_TOTALS.load(deps.storage)?;
    totals.locked = totals
        .locked
        .checked_sub(request.bond.amount)
        .map_err(|_| ContractError::BondInvariant)?;
    totals.refundable = totals
        .refundable
        .checked_add(request.bond.amount)
        .map_err(|_| ContractError::BondTotalOverflow)?;
    let amount = request.bond.amount;
    request.status = Status::Archived;
    request.bond.state = BondState::Refundable;
    request.updated_at = env.block.time;
    persist_transition(
        deps.storage,
        &env,
        TransitionWrite {
            request,
            from: Status::Open,
            actor: info.sender,
            reason: Some("snapshot_history_risk".into()),
            actions: vec![
                RequestAction::EmergencyArchived { reason },
                RequestAction::BondTransition {
                    from: Some(BondState::Locked),
                    to: BondState::Refundable,
                    amount,
                },
            ],
            bond_totals: Some(totals),
            duplicate_reference: None,
            evidence_ids: vec![],
            shipment_attestation: None,
        },
        "emergency_archive_open",
    )
}

fn policy(config: &Config) -> FutureRequestPolicy {
    FutureRequestPolicy {
        submission_bond: config.submission_bond,
        voting_period_blocks: config.voting_period_blocks,
        quorum_bps: config.quorum_bps,
        support_bps: config.support_bps,
        work_inactivity_blocks: config.work_inactivity_blocks,
        request_limits: config.request_limits.clone(),
    }
}
