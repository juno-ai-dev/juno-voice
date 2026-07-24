use cosmwasm_std::{entry_point, Addr, DepsMut, Env, MessageInfo, Response, Storage};
use cw2::set_contract_version;

use crate::bindings::JunoQuery;
use crate::error::ContractError;
use crate::execute::{cast_vote, submit_request};
use crate::msg::{ExecuteMsg, InstantiateMsg};
use crate::state::{
    BondTotals, Config, ProtocolAction, ProtocolActionRecord, RequestLimits, BOND_TOTALS, CONFIG,
    NEXT_PROTOCOL_ACTION_ID, NEXT_REQUEST_ID, PROTOCOL_ACTIONS,
};

pub const CONTRACT_NAME: &str = "crates.io:juno-voice";
pub const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const EVIDENCE_POLICY_VERSION: u16 = 1;
const MAX_BPS: u16 = 10_000;

#[entry_point]
pub fn instantiate(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if !info.funds.is_empty() {
        return Err(ContractError::UnexpectedFunds);
    }

    let governor = validate_address(deps.as_ref().api, &msg.governor, "governor")?;
    let steward = validate_address(deps.as_ref().api, &msg.steward, "steward")?;
    let verifier = validate_address(deps.as_ref().api, &msg.verifier, "verifier")?;

    if !is_valid_native_denom(&msg.native_denom) {
        return Err(ContractError::InvalidNativeDenom);
    }
    if msg.submission_bond.is_zero() {
        return Err(ContractError::InvalidSubmissionBond);
    }
    if msg.voting_period_blocks == 0 {
        return Err(ContractError::InvalidVotingPeriod);
    }
    if msg.work_inactivity_blocks == 0 {
        return Err(ContractError::InvalidWorkInactivityPeriod);
    }
    validate_threshold("quorum_bps", msg.quorum_bps)?;
    validate_threshold("support_bps", msg.support_bps)?;

    if msg.evidence_policy_version != EVIDENCE_POLICY_VERSION {
        return Err(ContractError::UnsupportedEvidencePolicyVersion {
            version: msg.evidence_policy_version,
        });
    }
    validate_request_limits(&msg.request_limits, msg.max_reason_bytes)?;
    if msg.default_query_limit == 0
        || msg.max_query_limit == 0
        || msg.default_query_limit > msg.max_query_limit
    {
        return Err(ContractError::InvalidQueryLimits);
    }

    // Prove that every request opened at the instantiate height could store an
    // end-exclusive close height before any state is written.
    env.block
        .height
        .checked_add(msg.voting_period_blocks)
        .ok_or(ContractError::CloseHeightOverflow)?;

    let config = Config {
        governor,
        pending_governor: None,
        steward,
        verifier,
        native_denom: msg.native_denom,
        submission_bond: msg.submission_bond,
        voting_period_blocks: msg.voting_period_blocks,
        quorum_bps: msg.quorum_bps,
        support_bps: msg.support_bps,
        work_inactivity_blocks: msg.work_inactivity_blocks,
        request_limits: msg.request_limits,
        max_reason_bytes: msg.max_reason_bytes,
        default_query_limit: msg.default_query_limit,
        max_query_limit: msg.max_query_limit,
        evidence_policy_version: EVIDENCE_POLICY_VERSION,
        submissions_paused: false,
    };

    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    CONFIG.save(deps.storage, &config)?;
    BOND_TOTALS.save(deps.storage, &BondTotals::default())?;
    NEXT_REQUEST_ID.save(deps.storage, &1)?;
    NEXT_PROTOCOL_ACTION_ID.save(deps.storage, &1)?;

    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::SubmitRequest {
            title,
            summary,
            acceptance_criteria,
            category,
            detail_uri,
            detail_digest,
        } => submit_request::execute(
            deps,
            env,
            info,
            title,
            summary,
            acceptance_criteria,
            category,
            detail_uri,
            detail_digest,
        ),
        ExecuteMsg::CastVote { request_id, choice } => {
            if !info.funds.is_empty() {
                return Err(ContractError::UnexpectedFunds);
            }
            cast_vote::execute(deps, env, info, request_id, choice)
        }
        ExecuteMsg::ProposeGovernor { address, reason } => {
            if !info.funds.is_empty() {
                return Err(ContractError::UnexpectedFunds);
            }
            execute_propose_governor(deps, env, info, address, reason)
        }
        ExecuteMsg::CancelGovernorTransfer { reason } => {
            if !info.funds.is_empty() {
                return Err(ContractError::UnexpectedFunds);
            }
            execute_cancel_governor_transfer(deps, env, info, reason)
        }
        ExecuteMsg::AcceptGovernor { reason } => {
            if !info.funds.is_empty() {
                return Err(ContractError::UnexpectedFunds);
            }
            execute_accept_governor(deps, env, info, reason)
        }
    }
}

fn execute_propose_governor(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    address: String,
    reason: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let nominee = validate_address(deps.api, &address, "governor nominee")?;
    if nominee == config.governor || config.pending_governor.as_ref() == Some(&nominee) {
        return Err(ContractError::InvalidGovernorNominee);
    }
    let previous_nominee = config.pending_governor.clone();
    let (id, next_id) = checked_protocol_action_ids(deps.storage)?;
    let record = ProtocolActionRecord {
        id,
        actor: info.sender,
        action: ProtocolAction::GovernorProposed {
            previous_nominee,
            nominee: nominee.clone(),
        },
        reason: Some(reason),
        height: env.block.height,
        timestamp: env.block.time,
    };
    config.pending_governor = Some(nominee);
    persist_protocol_action(deps.storage, &config, &record, next_id)?;
    Ok(action_response("propose_governor", id))
}

fn execute_cancel_governor_transfer(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    reason: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let nominee = config
        .pending_governor
        .clone()
        .ok_or(ContractError::NoPendingGovernor)?;
    let (id, next_id) = checked_protocol_action_ids(deps.storage)?;
    let record = ProtocolActionRecord {
        id,
        actor: info.sender,
        action: ProtocolAction::GovernorTransferCancelled { nominee },
        reason: Some(reason),
        height: env.block.height,
        timestamp: env.block.time,
    };
    config.pending_governor = None;
    persist_protocol_action(deps.storage, &config, &record, next_id)?;
    Ok(action_response("cancel_governor_transfer", id))
}

fn execute_accept_governor(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    reason: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if config.pending_governor.as_ref() != Some(&info.sender) {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let previous = config.governor.clone();
    let governor = info.sender.clone();
    let (id, next_id) = checked_protocol_action_ids(deps.storage)?;
    let record = ProtocolActionRecord {
        id,
        actor: info.sender,
        action: ProtocolAction::GovernorAccepted {
            previous,
            governor: governor.clone(),
        },
        reason: Some(reason),
        height: env.block.height,
        timestamp: env.block.time,
    };
    config.governor = governor;
    config.pending_governor = None;
    persist_protocol_action(deps.storage, &config, &record, next_id)?;
    Ok(action_response("accept_governor", id))
}

fn validate_reason(reason: String, max_reason_bytes: u16) -> Result<String, ContractError> {
    if reason.len() > usize::from(max_reason_bytes) {
        return Err(ContractError::InvalidReason);
    }
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        return Err(ContractError::InvalidReason);
    }
    Ok(trimmed.to_owned())
}

fn checked_protocol_action_ids(storage: &dyn Storage) -> Result<(u64, u64), ContractError> {
    let id = NEXT_PROTOCOL_ACTION_ID.load(storage)?;
    let next_id = id
        .checked_add(1)
        .ok_or(ContractError::ProtocolActionIdOverflow)?;
    Ok((id, next_id))
}

fn persist_protocol_action(
    storage: &mut dyn Storage,
    config: &Config,
    record: &ProtocolActionRecord,
    next_id: u64,
) -> Result<(), ContractError> {
    CONFIG.save(storage, config)?;
    PROTOCOL_ACTIONS.save(storage, record.id, record)?;
    NEXT_PROTOCOL_ACTION_ID.save(storage, &next_id)?;
    Ok(())
}

fn action_response(action: &str, id: u64) -> Response {
    Response::new()
        .add_attribute("action", action)
        .add_attribute("protocol_action_id", id.to_string())
}

fn validate_address(
    api: &dyn cosmwasm_std::Api,
    address: &str,
    role: &'static str,
) -> Result<Addr, ContractError> {
    api.addr_validate(address)
        .map_err(|_| ContractError::InvalidAddress { role })
}

fn validate_threshold(field: &'static str, value: u16) -> Result<(), ContractError> {
    if !(1..=MAX_BPS).contains(&value) {
        return Err(ContractError::InvalidThreshold { field, value });
    }
    Ok(())
}

pub(crate) fn validate_request_limits(
    limits: &RequestLimits,
    max_reason_bytes: u16,
) -> Result<(), ContractError> {
    if limits.max_title_bytes == 0
        || limits.max_summary_bytes == 0
        || limits.max_acceptance_criteria_bytes == 0
        || limits.max_category_bytes == 0
        || limits.max_evidence_note_bytes == 0
        || max_reason_bytes == 0
    {
        return Err(ContractError::InvalidRequestLimits {
            reason: "all general byte limits must be nonzero",
        });
    }
    if limits.max_uri_bytes < 9 {
        return Err(ContractError::InvalidRequestLimits {
            reason: "max_uri_bytes must be at least 9",
        });
    }
    if limits.max_digest_bytes < 71 {
        return Err(ContractError::InvalidRequestLimits {
            reason: "max_digest_bytes must be at least 71",
        });
    }
    if limits.max_evidence_items < 2 {
        return Err(ContractError::InvalidRequestLimits {
            reason: "max_evidence_items must be at least 2",
        });
    }
    if limits.max_review_evidence_refs < 1 {
        return Err(ContractError::InvalidRequestLimits {
            reason: "max_review_evidence_refs must be at least 1",
        });
    }
    if limits.max_attestation_evidence_refs < 2 {
        return Err(ContractError::InvalidRequestLimits {
            reason: "max_attestation_evidence_refs must be at least 2",
        });
    }
    if u16::from(limits.max_review_evidence_refs) > limits.max_evidence_items {
        return Err(ContractError::InvalidRequestLimits {
            reason: "review reference maximum exceeds evidence item maximum",
        });
    }
    if u16::from(limits.max_attestation_evidence_refs) > limits.max_evidence_items {
        return Err(ContractError::InvalidRequestLimits {
            reason: "attestation reference maximum exceeds evidence item maximum",
        });
    }
    Ok(())
}

/// Cosmos SDK native-denom syntax: 3-128 ASCII characters, beginning with a
/// letter and followed by letters, digits, '/', ':', '.', '_', or '-'.
fn is_valid_native_denom(denom: &str) -> bool {
    let bytes = denom.as_bytes();
    (3..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'.' | b'_' | b'-')
        })
}
