use std::str::FromStr;

use cosmwasm_std::{DepsMut, Env, MessageInfo, QueryRequest, Response, Uint128};

use crate::bindings::{JunoQuery, VotingPowerResponse};
use crate::error::ContractError;
use crate::rank::rank_key;
use crate::state::{
    Bond, BondState, Request, RequestAction, RequestActionRecord, Status, BOND_TOTALS, CONFIG,
    NEXT_EVIDENCE_ID, NEXT_REQUEST_ACTION_ID, NEXT_REQUEST_ID, NEXT_STATUS_HISTORY_ID, REQUESTS,
    REQUESTS_BY_AUTHOR, REQUESTS_BY_CATEGORY, REQUESTS_BY_STATUS, REQUEST_ACTIONS,
    STATUS_CATEGORY_RANK, STATUS_RANK,
};

#[allow(clippy::too_many_arguments)]
pub fn execute(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    title: String,
    summary: String,
    acceptance_criteria: String,
    category: String,
    detail_uri: Option<String>,
    detail_digest: Option<String>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if config.submissions_paused {
        return Err(ContractError::SubmissionsPaused);
    }
    if info.funds.len() != 1
        || info.funds[0].denom != config.native_denom
        || info.funds[0].amount != config.submission_bond
    {
        return Err(ContractError::InvalidSubmissionFunds);
    }
    validate_text(&title, config.request_limits.max_title_bytes, "title")?;
    validate_text(&summary, config.request_limits.max_summary_bytes, "summary")?;
    validate_text(
        &acceptance_criteria,
        config.request_limits.max_acceptance_criteria_bytes,
        "acceptance_criteria",
    )?;
    if category.is_empty()
        || category.len() > usize::from(config.request_limits.max_category_bytes)
        || !category
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ContractError::InvalidCategory);
    }
    match (&detail_uri, &detail_digest) {
        (None, None) => {}
        (Some(uri), Some(digest))
            if uri.len() <= usize::from(config.request_limits.max_uri_bytes)
                && digest.len() <= usize::from(config.request_limits.max_digest_bytes)
                && valid_uri(uri)
                && valid_digest(digest) => {}
        _ => return Err(ContractError::InvalidDetail),
    }
    let snapshot_height = env
        .block
        .height
        .checked_sub(1)
        .ok_or(ContractError::InvalidSnapshotHeight)?;
    let query_height = i64::try_from(snapshot_height)
        .map_err(|_| ContractError::SnapshotHeightConversionOverflow)?;
    let response: VotingPowerResponse =
        deps.querier
            .query(&QueryRequest::Custom(JunoQuery::TotalVotingPowerAt {
                height: query_height,
            }))?;
    if response.power.is_empty() || !response.power.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ContractError::InvalidTotalVotingPower);
    }
    let total_power =
        Uint128::from_str(&response.power).map_err(|_| ContractError::InvalidTotalVotingPower)?;
    if total_power.is_zero() {
        return Err(ContractError::InvalidTotalVotingPower);
    }
    let id = NEXT_REQUEST_ID.load(deps.storage)?;
    let next_id = id.checked_add(1).ok_or(ContractError::RequestIdOverflow)?;
    let closes_height = env
        .block
        .height
        .checked_add(config.voting_period_blocks)
        .ok_or(ContractError::CloseHeightOverflow)?;
    let mut totals = BOND_TOTALS.load(deps.storage)?;
    totals.locked = totals
        .locked
        .checked_add(config.submission_bond)
        .map_err(|_| ContractError::BondTotalOverflow)?;
    let request = Request {
        id,
        author: info.sender.clone(),
        title,
        summary,
        acceptance_criteria,
        category: category.clone(),
        detail_uri,
        detail_digest,
        canonical_request_id: None,
        snapshot_height,
        total_power,
        opened_height: env.block.height,
        closes_height,
        quorum_bps: config.quorum_bps,
        support_bps: config.support_bps,
        work_inactivity_blocks: config.work_inactivity_blocks,
        limits: config.request_limits,
        evidence_policy_version: config.evidence_policy_version,
        status: Status::Open,
        support_power: Uint128::zero(),
        oppose_power: Uint128::zero(),
        voter_count: 0,
        bond: Bond {
            amount: config.submission_bond,
            state: BondState::Locked,
        },
        builder: None,
        work_round: 0,
        work_activity_height: None,
        created_at: env.block.time,
        updated_at: env.block.time,
    };
    let submitted = RequestActionRecord {
        id: 1,
        request_id: id,
        actor: info.sender.clone(),
        action: RequestAction::Submitted {
            snapshot_height,
            total_power,
        },
        reason: None,
        height: env.block.height,
        timestamp: env.block.time,
    };
    let bond_locked = RequestActionRecord {
        id: 2,
        request_id: id,
        actor: info.sender.clone(),
        action: RequestAction::BondTransition {
            from: None,
            to: BondState::Locked,
            amount: config.submission_bond,
        },
        reason: None,
        height: env.block.height,
        timestamp: env.block.time,
    };
    let rank_key = rank_key(Uint128::zero(), Uint128::zero(), id);

    REQUESTS.save(deps.storage, id, &request)?;
    NEXT_REQUEST_ID.save(deps.storage, &next_id)?;
    BOND_TOTALS.save(deps.storage, &totals)?;
    NEXT_EVIDENCE_ID.save(deps.storage, id, &1)?;
    NEXT_STATUS_HISTORY_ID.save(deps.storage, id, &1)?;
    NEXT_REQUEST_ACTION_ID.save(deps.storage, id, &3)?;
    REQUEST_ACTIONS.save(deps.storage, (id, 1), &submitted)?;
    REQUEST_ACTIONS.save(deps.storage, (id, 2), &bond_locked)?;
    REQUESTS_BY_STATUS.save(deps.storage, (Status::Open.code(), id), &())?;
    REQUESTS_BY_CATEGORY.save(deps.storage, (&category, id), &())?;
    REQUESTS_BY_AUTHOR.save(deps.storage, (&info.sender, id), &())?;
    STATUS_RANK.save(deps.storage, (Status::Open.code(), rank_key.clone()), &id)?;
    STATUS_CATEGORY_RANK.save(
        deps.storage,
        (Status::Open.code(), &category, rank_key),
        &id,
    )?;

    Ok(Response::new()
        .add_attribute("action", "submit_request")
        .add_attribute("request_id", id.to_string()))
}

fn validate_text(value: &str, max_bytes: u16, field: &'static str) -> Result<(), ContractError> {
    if value.len() > usize::from(max_bytes) || value.trim().is_empty() {
        return Err(ContractError::InvalidBrief { field });
    }
    Ok(())
}

fn valid_uri(uri: &str) -> bool {
    uri.strip_prefix("https://")
        .or_else(|| uri.strip_prefix("ipfs://"))
        .is_some_and(|locator| !locator.is_empty())
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 71
        && digest.strip_prefix("sha256:").is_some_and(|hex| {
            hex.bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}
