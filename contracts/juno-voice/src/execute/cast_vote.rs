use std::str::FromStr;

use cosmwasm_std::{DepsMut, Env, MessageInfo, QueryRequest, Response, Uint128};

use crate::bindings::{JunoQuery, VotingPowerResponse};
use crate::error::ContractError;
use crate::rank::rank_key;
use crate::state::{
    Status, VoteChoice, VoteReceipt, REQUESTS, STATUS_CATEGORY_RANK, STATUS_RANK, VOTES,
};

pub fn execute(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    choice: VoteChoice,
) -> Result<Response, ContractError> {
    let mut request = REQUESTS
        .may_load(deps.storage, request_id)?
        .ok_or(ContractError::UnknownRequest { request_id })?;
    if request.status != Status::Open
        || env.block.height < request.opened_height
        || env.block.height >= request.closes_height
    {
        return Err(ContractError::VotingNotOpen);
    }

    // MessageInfo is runtime-validated by CosmWasm. Validate again so the exact
    // canonical string sent to Juno is explicit and never derived from payload data.
    let voter = deps
        .api
        .addr_validate(info.sender.as_str())
        .map_err(|_| ContractError::InvalidAddress { role: "voter" })?;
    if VOTES
        .may_load(deps.storage, (request_id, &voter))?
        .is_some()
    {
        return Err(ContractError::DuplicateVote);
    }

    let query_height = i64::try_from(request.snapshot_height)
        .map_err(|_| ContractError::SnapshotHeightConversionOverflow)?;
    let total_response: VotingPowerResponse =
        deps.querier
            .query(&QueryRequest::Custom(JunoQuery::TotalVotingPowerAt {
                height: query_height,
            }))?;
    let total_power = parse_power(&total_response.power, PowerKind::Total)?;
    if total_power != request.total_power {
        return Err(ContractError::SnapshotIntegrityMismatch);
    }

    let voter_response: VotingPowerResponse =
        deps.querier
            .query(&QueryRequest::Custom(JunoQuery::VotingPowerAt {
                address: voter.to_string(),
                height: query_height,
            }))?;
    let voter_power = parse_power(&voter_response.power, PowerKind::Voter)?;
    if voter_power > total_power {
        return Err(ContractError::VotingPowerExceedsTotal);
    }

    let old_rank_key = rank_key(request.support_power, request.oppose_power, request.id);
    match choice {
        VoteChoice::Support => {
            request.support_power = request
                .support_power
                .checked_add(voter_power)
                .map_err(|_| ContractError::VoteTallyOverflow)?;
        }
        VoteChoice::Oppose => {
            request.oppose_power = request
                .oppose_power
                .checked_add(voter_power)
                .map_err(|_| ContractError::VoteTallyOverflow)?;
        }
    }
    request.voter_count = request
        .voter_count
        .checked_add(1)
        .ok_or(ContractError::VoterCountOverflow)?;
    request.updated_at = env.block.time;

    let receipt = VoteReceipt {
        request_id,
        voter: voter.clone(),
        choice: choice.clone(),
        power: voter_power,
        cast_height: env.block.height,
    };
    let new_rank_key = rank_key(request.support_power, request.oppose_power, request.id);
    let status_code = request.status.code();

    STATUS_RANK.remove(deps.storage, (status_code, old_rank_key.clone()));
    STATUS_CATEGORY_RANK.remove(
        deps.storage,
        (status_code, request.category.as_str(), old_rank_key),
    );
    STATUS_RANK.save(
        deps.storage,
        (status_code, new_rank_key.clone()),
        &request.id,
    )?;
    STATUS_CATEGORY_RANK.save(
        deps.storage,
        (status_code, request.category.as_str(), new_rank_key),
        &request.id,
    )?;
    VOTES.save(deps.storage, (request_id, &voter), &receipt)?;
    REQUESTS.save(deps.storage, request_id, &request)?;

    let choice_attribute = match choice {
        VoteChoice::Support => "support",
        VoteChoice::Oppose => "oppose",
    };
    Ok(Response::new()
        .add_attribute("action", "cast_vote")
        .add_attribute("request_id", request_id.to_string())
        .add_attribute("choice", choice_attribute))
}

#[derive(Clone, Copy)]
enum PowerKind {
    Total,
    Voter,
}

fn parse_power(value: &str, kind: PowerKind) -> Result<Uint128, ContractError> {
    let invalid = || match kind {
        PowerKind::Total => ContractError::InvalidTotalVotingPower,
        PowerKind::Voter => ContractError::InvalidVotingPower,
    };
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let power = Uint128::from_str(value).map_err(|_| invalid())?;
    if power.is_zero() {
        return Err(invalid());
    }
    Ok(power)
}
