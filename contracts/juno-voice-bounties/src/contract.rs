use cosmwasm_std::{
    entry_point, to_json_binary, BankMsg, Binary, Coin, Deps, DepsMut, Env, Event, MessageInfo,
    Order, Response, StdError, StdResult, Storage, Timestamp, Uint128, WasmMsg,
};
use cw2::set_contract_version;
use cw_storage_plus::Bound;

use crate::error::ContractError;
use crate::msg::{
    AuthoritiesResponse, BountiesResponse, BountyResponse, ClaimsResponse, ConfigUpdate,
    ContributionsResponse, ErrorCatalogResponse, ErrorCode, ExecuteMsg, HealthResponse,
    HistoryResponse, InstantiateMsg, Limits, ModerationOutcome, PayoutVote, QueryMsg,
    ReceiptsResponse, RegistryExecuteMsg, RoundsResponse,
};
use crate::state::{
    Accounting, Bounty, BountyStatus, ClaimRecord, Config, ContributionView, GraduationRecord,
    HistoryAction, HistoryEntry, ModerationRecord, Nomination, PauseState, RefundReason, Round,
    RoundOutcome, RoundRule, Terms, VoteReceipt, ACCOUNTING, BOUNTIES, CLAIMS, CONFIG,
    CONTRIBUTIONS, CONTRIBUTION_CHECKPOINTS, CONTRIBUTOR_INDEX, CONTRIBUTOR_POSITION, GRADUATIONS,
    HISTORY, MODERATIONS, NEXT_BOUNTY_ID, PAUSE, ROUNDS, VOTER_INDEX, VOTES,
};

const CONTRACT_NAME: &str = "crates.io:juno-voice-bounties";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const NATIVE_DENOM: &str = "ujuno";
pub const RATIFICATION_SECONDS: u64 = 259_200;

const MAX_HARD_CONTRIBUTORS: u32 = 10_000;
const MAX_HARD_ROUNDS: u32 = 100;
const MAX_HARD_PAGE_LIMIT: u32 = 100;
const MAX_HARD_TEXT_BYTES: u32 = 16_384;
const MAX_HARD_LIFETIME_SECONDS: u64 = 366 * 24 * 60 * 60;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let config = Config {
        native_denom: msg.native_denom,
        governor: deps.api.addr_validate(&msg.governor)?,
        agent: deps.api.addr_validate(&msg.agent)?,
        registry: deps.api.addr_validate(&msg.registry)?,
        ratification_seconds: RATIFICATION_SECONDS,
        min_contribution: msg.min_contribution,
        max_bounty_total: msg.max_bounty_total,
        min_lifetime_seconds: msg.min_lifetime_seconds,
        max_lifetime_seconds: msg.max_lifetime_seconds,
        max_contributors: msg.max_contributors,
        max_rounds: msg.max_rounds,
        limits: msg.limits,
        version: 1,
    };
    validate_config(&config)?;

    CONFIG.save(deps.storage, &config)?;
    PAUSE.save(
        deps.storage,
        &PauseState {
            paused: false,
            reason: None,
            actor: None,
            changed_at: Some(env.block.time),
        },
    )?;
    ACCOUNTING.save(
        deps.storage,
        &Accounting {
            active_escrow: Uint128::zero(),
            outstanding_refunds: Uint128::zero(),
            pending_payout_liabilities: Uint128::zero(),
            lifetime_received: Uint128::zero(),
            lifetime_paid: Uint128::zero(),
            lifetime_refunded: Uint128::zero(),
        },
    )?;
    NEXT_BOUNTY_ID.save(deps.storage, &1)?;

    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.instantiated")
            .add_attribute("governor", config.governor)
            .add_attribute("agent", config.agent)
            .add_attribute("registry", config.registry)
            .add_attribute("native_denom", config.native_denom)
            .add_attribute("ratification_seconds", RATIFICATION_SECONDS.to_string()),
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
        ExecuteMsg::CreateBounty {
            title,
            summary,
            acceptance_criteria,
            content_uri,
            content_digest,
            expires_at,
            project_candidate,
        } => execute_create(
            deps,
            env,
            info,
            title,
            summary,
            acceptance_criteria,
            content_uri,
            content_digest,
            expires_at,
            project_candidate,
        ),
        ExecuteMsg::Contribute { bounty_id } => execute_contribute(deps, env, info, bounty_id),
        ExecuteMsg::NominatePayout {
            bounty_id,
            recipient,
            evidence_uri,
            evidence_digest,
            rationale,
        } => execute_nominate(
            deps,
            env,
            info,
            bounty_id,
            recipient,
            evidence_uri,
            evidence_digest,
            rationale,
        ),
        ExecuteMsg::ConfirmSolePayout { bounty_id, round } => {
            execute_confirm_sole(deps, env, info, bounty_id, round)
        }
        ExecuteMsg::DeclineSolePayout {
            bounty_id,
            round,
            reason,
        } => execute_decline_sole(deps, env, info, bounty_id, round, reason),
        ExecuteMsg::VotePayout {
            bounty_id,
            round,
            vote,
            rationale,
        } => execute_vote(deps, env, info, bounty_id, round, vote, rationale),
        ExecuteMsg::FinalizePayout { bounty_id, round } => {
            execute_finalize(deps, env, info, bounty_id, round)
        }
        ExecuteMsg::CancelSoleFunded { bounty_id, reason } => {
            execute_cancel(deps, env, info, bounty_id, reason)
        }
        ExecuteMsg::Expire { bounty_id } => execute_expire(deps, env, info, bounty_id),
        ExecuteMsg::ClaimRefund { bounty_id } => execute_claim_refund(deps, env, info, bounty_id),
        ExecuteMsg::Moderate {
            bounty_id,
            outcome,
            reason,
        } => execute_moderate(deps, env, info, bounty_id, outcome, reason),
        ExecuteMsg::GraduateProject { bounty_id } => execute_graduate(deps, env, info, bounty_id),
        ExecuteMsg::PauseNewActivity { reason } => execute_pause(deps, env, info, reason),
        ExecuteMsg::UnpauseNewActivity { reason } => execute_unpause(deps, env, info, reason),
        ExecuteMsg::UpdateRoles {
            governor,
            agent,
            registry,
        } => execute_update_roles(deps, env, info, governor, agent, registry),
        ExecuteMsg::UpdateConfig { update } => execute_update_config(deps, env, info, update),
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_create(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    title: String,
    summary: String,
    acceptance_criteria: String,
    content_uri: Option<String>,
    content_digest: Option<String>,
    expires_at: Timestamp,
    project_candidate: Option<crate::msg::ProjectCandidate>,
) -> Result<Response, ContractError> {
    ensure_not_paused(deps.storage)?;
    let config = CONFIG.load(deps.storage)?;
    let amount = attached_native(&info, &config)?;
    if amount < config.min_contribution || amount > config.max_bounty_total {
        return Err(ContractError::InvalidFunds);
    }

    validate_required(&title, "title", config.limits.max_title_bytes)?;
    validate_required(&summary, "summary", config.limits.max_summary_bytes)?;
    validate_required(
        &acceptance_criteria,
        "acceptance_criteria",
        config.limits.max_acceptance_criteria_bytes,
    )?;
    validate_uri_digest_pair(
        content_uri.as_deref(),
        content_digest.as_deref(),
        config.limits.max_uri_bytes,
    )?;
    if let Some(candidate) = &project_candidate {
        validate_project_candidate(candidate, &config.limits)?;
    }
    validate_expiry(env.block.time, expires_at, &config)?;

    let id = NEXT_BOUNTY_ID.load(deps.storage)?;
    NEXT_BOUNTY_ID.save(
        deps.storage,
        &id.checked_add(1)
            .ok_or_else(|| ContractError::InvalidConfiguration("bounty id overflow".into()))?,
    )?;

    let mut bounty = Bounty {
        id,
        creator: info.sender.clone(),
        terms: Terms {
            title,
            summary,
            acceptance_criteria,
            content_uri,
            content_digest,
            config_version: config.version,
            ratification_seconds: config.ratification_seconds,
            max_bounty_total: config.max_bounty_total,
            max_contributors: config.max_contributors,
            max_rounds: config.max_rounds,
        },
        project_candidate,
        status: BountyStatus::Open,
        refund_reason: None,
        total_contribution: amount,
        contributor_count: 1,
        next_round: 1,
        active_round: None,
        paid_recipient: None,
        paid_amount: Uint128::zero(),
        refunded_amount: Uint128::zero(),
        paid_at: None,
        graduated_at: None,
        created_at: env.block.time,
        expires_at,
        history_count: 0,
    };

    CONTRIBUTIONS.save(deps.storage, (id, &info.sender), &amount)?;
    CONTRIBUTOR_INDEX.save(deps.storage, (id, 1), &info.sender)?;
    CONTRIBUTOR_POSITION.save(deps.storage, (id, &info.sender), &1)?;
    CONTRIBUTION_CHECKPOINTS.save(deps.storage, (id, &info.sender, 1), &amount)?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Created,
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, id, &bounty)?;

    ACCOUNTING.update(deps.storage, |mut accounting| -> Result<_, ContractError> {
        accounting.active_escrow = accounting.active_escrow.checked_add(amount)?;
        accounting.lifetime_received = accounting.lifetime_received.checked_add(amount)?;
        Ok(accounting)
    })?;

    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.bounty_created")
            .add_attribute("bounty_id", id.to_string())
            .add_attribute("creator", info.sender)
            .add_attribute("amount", amount)
            .add_attribute("expires_at", expires_at.nanos().to_string())
            .add_attribute(
                "project_candidate",
                bounty.project_candidate.is_some().to_string(),
            ),
    ))
}

fn execute_contribute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
) -> Result<Response, ContractError> {
    ensure_not_paused(deps.storage)?;
    let config = CONFIG.load(deps.storage)?;
    let amount = attached_native(&info, &config)?;
    if amount < config.min_contribution {
        return Err(ContractError::InvalidFunds);
    }

    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    if bounty.status != BountyStatus::Open {
        return Err(ContractError::InvalidState);
    }
    if env.block.time >= bounty.expires_at {
        return Err(ContractError::Expired);
    }
    let new_total = bounty.total_contribution.checked_add(amount)?;
    if new_total > bounty.terms.max_bounty_total {
        return Err(ContractError::ContributionLimit);
    }

    let previous = CONTRIBUTIONS
        .may_load(deps.storage, (bounty_id, &info.sender))?
        .unwrap_or_default();
    let contributor_amount = previous.checked_add(amount)?;
    if previous.is_zero() {
        if bounty.contributor_count >= bounty.terms.max_contributors {
            return Err(ContractError::ContributionLimit);
        }
        bounty.contributor_count = bounty
            .contributor_count
            .checked_add(1)
            .ok_or(ContractError::ContributionLimit)?;
        CONTRIBUTOR_INDEX.save(
            deps.storage,
            (bounty_id, bounty.contributor_count),
            &info.sender,
        )?;
        CONTRIBUTOR_POSITION.save(
            deps.storage,
            (bounty_id, &info.sender),
            &bounty.contributor_count,
        )?;
    }
    bounty.total_contribution = new_total;
    CONTRIBUTIONS.save(deps.storage, (bounty_id, &info.sender), &contributor_amount)?;
    CONTRIBUTION_CHECKPOINTS.save(
        deps.storage,
        (bounty_id, &info.sender, bounty.next_round),
        &contributor_amount,
    )?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Contributed,
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;
    ACCOUNTING.update(deps.storage, |mut accounting| -> Result<_, ContractError> {
        accounting.active_escrow = accounting.active_escrow.checked_add(amount)?;
        accounting.lifetime_received = accounting.lifetime_received.checked_add(amount)?;
        Ok(accounting)
    })?;

    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.contributed")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("contributor", info.sender)
            .add_attribute("amount", amount)
            .add_attribute("contributor_total", contributor_amount)
            .add_attribute("bounty_total", new_total),
    ))
}

#[allow(clippy::too_many_arguments)]
fn execute_nominate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
    recipient: String,
    evidence_uri: String,
    evidence_digest: String,
    rationale: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    ensure_not_paused(deps.storage)?;
    let config = CONFIG.load(deps.storage)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    if info.sender != bounty.creator && info.sender != config.agent {
        return Err(ContractError::Unauthorized);
    }
    if bounty.status != BountyStatus::Open || bounty.active_round.is_some() {
        return Err(ContractError::InvalidState);
    }
    if env.block.time >= bounty.expires_at {
        return Err(ContractError::Expired);
    }
    if bounty.next_round > bounty.terms.max_rounds {
        return Err(ContractError::RoundLimit);
    }
    validate_required(&evidence_uri, "evidence_uri", config.limits.max_uri_bytes)?;
    validate_digest(&evidence_digest)?;
    validate_required(&rationale, "rationale", config.limits.max_rationale_bytes)?;
    let recipient = deps.api.addr_validate(&recipient)?;

    let number = bounty.next_round;
    let (rule, closes_at, status) = if bounty.contributor_count == 1 {
        (
            RoundRule::SoleConfirmation,
            None,
            BountyStatus::SingleConfirmation,
        )
    } else {
        (
            RoundRule::ContributionWeightedMajority,
            Some(
                env.block
                    .time
                    .plus_seconds(bounty.terms.ratification_seconds),
            ),
            BountyStatus::Ratifying,
        )
    };
    let round = Round {
        bounty_id,
        number,
        nomination: Nomination {
            nominator: info.sender.clone(),
            recipient: recipient.clone(),
            evidence_uri,
            evidence_digest,
            rationale,
        },
        rule,
        total_weight: bounty.total_contribution,
        contributor_count: bounty.contributor_count,
        opens_at: env.block.time,
        closes_at,
        yes_weight: Uint128::zero(),
        no_weight: Uint128::zero(),
        voter_count: 0,
        outcome: RoundOutcome::Pending,
        finalized_at: None,
    };

    bounty.status = status;
    bounty.active_round = Some(number);
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Nominated { round: number },
        env.block.time,
    )?;
    ROUNDS.save(deps.storage, (bounty_id, number), &round)?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;
    ACCOUNTING.update(deps.storage, |mut accounting| -> Result<_, ContractError> {
        accounting.active_escrow = accounting
            .active_escrow
            .checked_sub(bounty.total_contribution)?;
        accounting.pending_payout_liabilities = accounting
            .pending_payout_liabilities
            .checked_add(bounty.total_contribution)?;
        Ok(accounting)
    })?;

    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.payout_nominated")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("round", number.to_string())
            .add_attribute("nominator", info.sender)
            .add_attribute("recipient", recipient)
            .add_attribute("contributor_count", round.contributor_count.to_string())
            .add_attribute("total_weight", round.total_weight)
            .add_attribute(
                "closes_at",
                round
                    .closes_at
                    .map(|value| value.nanos().to_string())
                    .unwrap_or_else(|| "sole_confirmation".to_string()),
            ),
    ))
}

fn execute_confirm_sole(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
    number: u32,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    ensure_round(&bounty, number)?;
    if bounty.status != BountyStatus::SingleConfirmation || bounty.contributor_count != 1 {
        return Err(ContractError::InvalidState);
    }
    ensure_contributor(deps.storage, bounty_id, number, &info.sender)?;

    let mut round = ROUNDS.load(deps.storage, (bounty_id, number))?;
    round.outcome = RoundOutcome::Paid;
    round.finalized_at = Some(env.block.time);
    let recipient = round.nomination.recipient.clone();
    settle_paid(
        deps.storage,
        &mut bounty,
        &recipient,
        env.block.time,
        &config,
    )?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::SoleConfirmed { round: number },
        env.block.time,
    )?;
    ROUNDS.save(deps.storage, (bounty_id, number), &round)?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: recipient.to_string(),
            amount: vec![Coin::new(bounty.paid_amount.u128(), config.native_denom)],
        })
        .add_event(
            Event::new("juno_voice_bounties.payout_completed")
                .add_attribute("bounty_id", bounty_id.to_string())
                .add_attribute("round", number.to_string())
                .add_attribute("mode", "sole_confirmation")
                .add_attribute("recipient", recipient)
                .add_attribute("amount", bounty.paid_amount),
        ))
}

fn execute_decline_sole(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
    number: u32,
    reason: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    validate_required(&reason, "reason", config.limits.max_reason_bytes)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    ensure_round(&bounty, number)?;
    if bounty.status != BountyStatus::SingleConfirmation || bounty.contributor_count != 1 {
        return Err(ContractError::InvalidState);
    }
    ensure_contributor(deps.storage, bounty_id, number, &info.sender)?;
    let mut round = ROUNDS.load(deps.storage, (bounty_id, number))?;
    round.outcome = RoundOutcome::Declined;
    round.finalized_at = Some(env.block.time);
    reset_or_refund_state(&mut bounty, env.block.time)?;
    let mut accounting = ACCOUNTING.load(deps.storage)?;
    apply_failed_round_accounting(&bounty, &mut accounting)?;
    ACCOUNTING.save(deps.storage, &accounting)?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::SoleDeclined { round: number },
        env.block.time,
    )?;
    ROUNDS.save(deps.storage, (bounty_id, number), &round)?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;

    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.sole_payout_declined")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("round", number.to_string())
            .add_attribute("contributor", info.sender)
            .add_attribute("reason", reason)
            .add_attribute("next_status", status_name(&bounty.status)),
    ))
}

fn execute_vote(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
    number: u32,
    vote: PayoutVote,
    rationale: Option<String>,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    if let Some(value) = &rationale {
        validate_optional(value, "rationale", config.limits.max_rationale_bytes)?;
    }
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    ensure_round(&bounty, number)?;
    if bounty.status != BountyStatus::Ratifying {
        return Err(ContractError::InvalidState);
    }
    let mut round = ROUNDS.load(deps.storage, (bounty_id, number))?;
    let closes_at = round.closes_at.ok_or(ContractError::InvalidState)?;
    if env.block.time >= closes_at {
        return Err(ContractError::VotingClosed);
    }
    let weight = ensure_contributor(deps.storage, bounty_id, number, &info.sender)?;

    let existing = VOTES.may_load(deps.storage, (bounty_id, number, &info.sender))?;
    let receipt = if let Some(mut receipt) = existing {
        match receipt.vote {
            PayoutVote::Yes => round.yes_weight = round.yes_weight.checked_sub(receipt.weight)?,
            PayoutVote::No => round.no_weight = round.no_weight.checked_sub(receipt.weight)?,
        }
        match vote {
            PayoutVote::Yes => round.yes_weight = round.yes_weight.checked_add(weight)?,
            PayoutVote::No => round.no_weight = round.no_weight.checked_add(weight)?,
        }
        receipt.vote = vote.clone();
        receipt.rationale = rationale;
        receipt.revised_at = env.block.time;
        receipt.revisions = receipt
            .revisions
            .checked_add(1)
            .ok_or_else(|| ContractError::InvalidConfiguration("vote revision overflow".into()))?;
        receipt
    } else {
        round.voter_count = round
            .voter_count
            .checked_add(1)
            .ok_or_else(|| ContractError::InvalidConfiguration("voter count overflow".into()))?;
        match vote {
            PayoutVote::Yes => round.yes_weight = round.yes_weight.checked_add(weight)?,
            PayoutVote::No => round.no_weight = round.no_weight.checked_add(weight)?,
        }
        VOTER_INDEX.save(
            deps.storage,
            (bounty_id, number, round.voter_count),
            &info.sender,
        )?;
        VoteReceipt {
            bounty_id,
            round: number,
            voter: info.sender.clone(),
            weight,
            vote: vote.clone(),
            rationale,
            cast_at: env.block.time,
            revised_at: env.block.time,
            revisions: 0,
            voter_index: round.voter_count,
        }
    };

    VOTES.save(deps.storage, (bounty_id, number, &info.sender), &receipt)?;
    ROUNDS.save(deps.storage, (bounty_id, number), &round)?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Voted {
            round: number,
            vote: vote.clone(),
        },
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;

    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.payout_vote_recorded")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("round", number.to_string())
            .add_attribute("voter", info.sender)
            .add_attribute("vote", vote_name(&vote))
            .add_attribute("weight", weight)
            .add_attribute("yes_weight", round.yes_weight)
            .add_attribute("no_weight", round.no_weight)
            .add_attribute("revisions", receipt.revisions.to_string()),
    ))
}

fn execute_finalize(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
    number: u32,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    ensure_round(&bounty, number)?;
    if bounty.status != BountyStatus::Ratifying {
        return Err(ContractError::InvalidState);
    }
    let mut round = ROUNDS.load(deps.storage, (bounty_id, number))?;
    let closes_at = round.closes_at.ok_or(ContractError::InvalidState)?;
    if env.block.time < closes_at {
        return Err(ContractError::RatificationOpen);
    }
    let participating = round.yes_weight.checked_add(round.no_weight)?;
    let outcome = if participating.is_zero() {
        RoundOutcome::NoVotes
    } else if round.yes_weight == round.no_weight {
        RoundOutcome::Tie
    } else if round.yes_weight > round.no_weight {
        RoundOutcome::Paid
    } else {
        RoundOutcome::NoMajority
    };
    round.outcome = outcome.clone();
    round.finalized_at = Some(env.block.time);

    let mut response = Response::new();
    if outcome == RoundOutcome::Paid {
        let recipient = round.nomination.recipient.clone();
        settle_paid(
            deps.storage,
            &mut bounty,
            &recipient,
            env.block.time,
            &config,
        )?;
        response = response.add_message(BankMsg::Send {
            to_address: recipient.to_string(),
            amount: vec![Coin::new(
                bounty.paid_amount.u128(),
                config.native_denom.clone(),
            )],
        });
    } else {
        reset_or_refund_state(&mut bounty, env.block.time)?;
        let mut accounting = ACCOUNTING.load(deps.storage)?;
        apply_failed_round_accounting(&bounty, &mut accounting)?;
        ACCOUNTING.save(deps.storage, &accounting)?;
    }
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Finalized {
            round: number,
            outcome: outcome.clone(),
        },
        env.block.time,
    )?;
    ROUNDS.save(deps.storage, (bounty_id, number), &round)?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;

    Ok(response.add_event(
        Event::new("juno_voice_bounties.ratification_finalized")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("round", number.to_string())
            .add_attribute("outcome", outcome_name(&outcome))
            .add_attribute("yes_weight", round.yes_weight)
            .add_attribute("no_weight", round.no_weight)
            .add_attribute("participating_weight", participating)
            .add_attribute("next_status", status_name(&bounty.status)),
    ))
}

fn execute_cancel(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
    reason: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    validate_required(&reason, "reason", config.limits.max_reason_bytes)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    if info.sender != bounty.creator {
        return Err(ContractError::Unauthorized);
    }
    if bounty.status != BountyStatus::Open || bounty.contributor_count != 1 {
        return Err(ContractError::InvalidState);
    }
    enter_refunding(
        &mut bounty,
        RefundReason::Cancelled {
            reason: reason.clone(),
        },
    );
    move_active_to_refunds(deps.storage, bounty.total_contribution)?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Cancelled,
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;
    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.bounty_cancelled")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("creator", info.sender)
            .add_attribute("reason", reason)
            .add_attribute("refundable", bounty.total_contribution),
    ))
}

fn execute_expire(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    if bounty.status != BountyStatus::Open {
        return Err(ContractError::InvalidState);
    }
    if env.block.time < bounty.expires_at {
        return Err(ContractError::NotExpired);
    }
    enter_refunding(&mut bounty, RefundReason::Expired);
    move_active_to_refunds(deps.storage, bounty.total_contribution)?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Expired,
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;
    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.bounty_expired")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("actor", info.sender)
            .add_attribute("refundable", bounty.total_contribution),
    ))
}

fn execute_claim_refund(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    if CLAIMS.has(deps.storage, (bounty_id, &info.sender)) {
        return Err(ContractError::AlreadyClaimed);
    }
    if bounty.status != BountyStatus::Refunding {
        return Err(ContractError::NotRefundable);
    }
    let amount = CONTRIBUTIONS
        .may_load(deps.storage, (bounty_id, &info.sender))?
        .filter(|amount| !amount.is_zero())
        .ok_or(ContractError::NotContributor)?;
    let claim = ClaimRecord {
        bounty_id,
        contributor: info.sender.clone(),
        amount,
        claimed_at: env.block.time,
    };
    CLAIMS.save(deps.storage, (bounty_id, &info.sender), &claim)?;
    bounty.refunded_amount = bounty.refunded_amount.checked_add(amount)?;
    if bounty.refunded_amount == bounty.total_contribution {
        bounty.status = BountyStatus::Refunded;
    }
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Refunded,
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;
    ACCOUNTING.update(deps.storage, |mut accounting| -> Result<_, ContractError> {
        accounting.outstanding_refunds = accounting.outstanding_refunds.checked_sub(amount)?;
        accounting.lifetime_refunded = accounting.lifetime_refunded.checked_add(amount)?;
        Ok(accounting)
    })?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin::new(amount.u128(), config.native_denom)],
        })
        .add_event(
            Event::new("juno_voice_bounties.refund_claimed")
                .add_attribute("bounty_id", bounty_id.to_string())
                .add_attribute("contributor", info.sender)
                .add_attribute("amount", amount)
                .add_attribute(
                    "fully_refunded",
                    (bounty.status == BountyStatus::Refunded).to_string(),
                ),
        ))
}

fn execute_moderate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
    outcome: ModerationOutcome,
    reason: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.agent {
        return Err(ContractError::Unauthorized);
    }
    validate_required(&reason, "reason", config.limits.max_reason_bytes)?;
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    if bounty.status != BountyStatus::Open {
        return Err(ContractError::InvalidState);
    }
    let record = ModerationRecord {
        bounty_id,
        moderator: info.sender.clone(),
        outcome: outcome.clone(),
        reason: reason.clone(),
        moderated_at: env.block.time,
    };
    MODERATIONS.save(deps.storage, bounty_id, &record)?;
    enter_refunding(
        &mut bounty,
        RefundReason::Moderated {
            outcome: outcome.clone(),
            reason: reason.clone(),
        },
    );
    move_active_to_refunds(deps.storage, bounty.total_contribution)?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Moderated {
            outcome: outcome.clone(),
        },
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;
    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.bounty_moderated")
            .add_attribute("bounty_id", bounty_id.to_string())
            .add_attribute("agent", info.sender)
            .add_attribute("outcome", moderation_name(&outcome))
            .add_attribute("reason", reason)
            .add_attribute("refundable", bounty.total_contribution),
    ))
}

fn execute_graduate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    bounty_id: u64,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.agent {
        return Err(ContractError::Unauthorized);
    }
    let mut bounty = load_bounty(deps.storage, bounty_id)?;
    if bounty.status != BountyStatus::Paid {
        return Err(ContractError::InvalidState);
    }
    if bounty.graduated_at.is_some() {
        return Err(ContractError::AlreadyGraduated);
    }
    let candidate = bounty
        .project_candidate
        .clone()
        .ok_or(ContractError::NotProjectCandidate)?;
    let payout_address = bounty
        .paid_recipient
        .clone()
        .ok_or(ContractError::InvalidState)?;
    let record = GraduationRecord {
        bounty_id,
        agent: info.sender.clone(),
        registry: config.registry.clone(),
        project_id: candidate.project_id.clone(),
        payout_address: payout_address.clone(),
        graduated_at: env.block.time,
    };
    bounty.graduated_at = Some(env.block.time);
    GRADUATIONS.save(deps.storage, bounty_id, &record)?;
    append_history(
        deps.storage,
        &mut bounty,
        &info.sender,
        HistoryAction::Graduated,
        env.block.time,
    )?;
    BOUNTIES.save(deps.storage, bounty_id, &bounty)?;

    let msg = RegistryExecuteMsg::Graduate {
        source_bounty_id: bounty_id,
        project_id: candidate.project_id.clone(),
        metadata_uri: candidate.metadata_uri,
        metadata_digest: candidate.metadata_digest,
        payout_address: payout_address.to_string(),
    };
    Ok(Response::new()
        .add_message(WasmMsg::Execute {
            contract_addr: config.registry.to_string(),
            msg: to_json_binary(&msg)?,
            funds: vec![],
        })
        .add_event(
            Event::new("juno_voice_bounties.project_graduated")
                .add_attribute("bounty_id", bounty_id.to_string())
                .add_attribute("agent", info.sender)
                .add_attribute("registry", config.registry)
                .add_attribute("project_id", candidate.project_id)
                .add_attribute("payout_address", payout_address),
        ))
}

fn execute_pause(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    reason: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.agent && info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    validate_required(&reason, "reason", config.limits.max_reason_bytes)?;
    PAUSE.save(
        deps.storage,
        &PauseState {
            paused: true,
            reason: Some(reason.clone()),
            actor: Some(info.sender.clone()),
            changed_at: Some(env.block.time),
        },
    )?;
    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.new_activity_paused")
            .add_attribute("actor", info.sender)
            .add_attribute("reason", reason),
    ))
}

fn execute_unpause(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    reason: String,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    validate_required(&reason, "reason", config.limits.max_reason_bytes)?;
    PAUSE.save(
        deps.storage,
        &PauseState {
            paused: false,
            reason: Some(reason.clone()),
            actor: Some(info.sender.clone()),
            changed_at: Some(env.block.time),
        },
    )?;
    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.new_activity_unpaused")
            .add_attribute("governor", info.sender)
            .add_attribute("reason", reason),
    ))
}

fn execute_update_roles(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    governor: Option<String>,
    agent: Option<String>,
    registry: Option<String>,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    if governor.is_none() && agent.is_none() && registry.is_none() {
        return Err(ContractError::InvalidConfiguration(
            "at least one role update is required".into(),
        ));
    }
    if let Some(value) = governor {
        config.governor = deps.api.addr_validate(&value)?;
    }
    if let Some(value) = agent {
        config.agent = deps.api.addr_validate(&value)?;
    }
    if let Some(value) = registry {
        config.registry = deps.api.addr_validate(&value)?;
    }
    config.version = config
        .version
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidConfiguration("config version overflow".into()))?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.roles_updated")
            .add_attribute("actor", info.sender)
            .add_attribute("governor", config.governor)
            .add_attribute("agent", config.agent)
            .add_attribute("registry", config.registry)
            .add_attribute("config_version", config.version.to_string())
            .add_attribute("changed_at", env.block.time.nanos().to_string()),
    ))
}

fn execute_update_config(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    update: ConfigUpdate,
) -> Result<Response, ContractError> {
    nonpayable(&info)?;
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.governor {
        return Err(ContractError::Unauthorized);
    }
    if let Some(value) = update.min_contribution {
        config.min_contribution = value;
    }
    if let Some(value) = update.max_bounty_total {
        config.max_bounty_total = value;
    }
    if let Some(value) = update.min_lifetime_seconds {
        config.min_lifetime_seconds = value;
    }
    if let Some(value) = update.max_lifetime_seconds {
        config.max_lifetime_seconds = value;
    }
    if let Some(value) = update.max_contributors {
        config.max_contributors = value;
    }
    if let Some(value) = update.max_rounds {
        config.max_rounds = value;
    }
    if let Some(value) = update.limits {
        config.limits = value;
    }
    config.version = config
        .version
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidConfiguration("config version overflow".into()))?;
    validate_config(&config)?;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_event(
        Event::new("juno_voice_bounties.future_config_updated")
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
        QueryMsg::Authorities {} => {
            let config = CONFIG.load(deps.storage)?;
            Ok(to_json_binary(&AuthoritiesResponse {
                governor: config.governor,
                agent: config.agent,
                registry: config.registry,
            })?)
        }
        QueryMsg::Accounting {} => Ok(to_json_binary(&ACCOUNTING.load(deps.storage)?)?),
        QueryMsg::Health {} => {
            let config = CONFIG.load(deps.storage)?;
            let accounting = ACCOUNTING.load(deps.storage)?;
            let actual = deps
                .querier
                .query_balance(env.contract.address, config.native_denom)?
                .amount;
            let liabilities = accounting
                .active_escrow
                .checked_add(accounting.outstanding_refunds)?
                .checked_add(accounting.pending_payout_liabilities)?;
            Ok(to_json_binary(&HealthResponse {
                fully_backed: liabilities <= actual,
                accounting,
                actual_native_balance: actual,
                liabilities,
            })?)
        }
        QueryMsg::Bounty { bounty_id } => {
            let bounty = load_bounty(deps.storage, bounty_id)?;
            let active_round = bounty
                .active_round
                .map(|number| ROUNDS.load(deps.storage, (bounty_id, number)))
                .transpose()?;
            Ok(to_json_binary(&BountyResponse {
                bounty,
                active_round,
                moderation: MODERATIONS.may_load(deps.storage, bounty_id)?,
                graduation: GRADUATIONS.may_load(deps.storage, bounty_id)?,
            })?)
        }
        QueryMsg::Bounties { start_after, limit } => {
            let limit = page_limit(deps.storage, limit)?;
            let start = start_after.map(Bound::exclusive);
            let bounties = BOUNTIES
                .range(deps.storage, start, None, Order::Ascending)
                .take(limit)
                .map(|item| item.map(|(_, bounty)| bounty))
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&BountiesResponse { bounties })?)
        }
        QueryMsg::Contribution {
            bounty_id,
            contributor,
            round,
        } => {
            let contributor = deps.api.addr_validate(&contributor)?;
            Ok(to_json_binary(&contribution_view(
                deps.storage,
                bounty_id,
                &contributor,
                round,
            )?)?)
        }
        QueryMsg::Contributions {
            bounty_id,
            start_after,
            limit,
        } => {
            load_bounty(deps.storage, bounty_id)?;
            let limit = page_limit(deps.storage, limit)?;
            let start = start_after.map(Bound::exclusive);
            let contributions = CONTRIBUTOR_INDEX
                .prefix(bounty_id)
                .range(deps.storage, start, None, Order::Ascending)
                .take(limit)
                .map(|item| {
                    let (_, contributor) = item?;
                    contribution_view(deps.storage, bounty_id, &contributor, None)
                })
                .collect::<Result<Vec<_>, ContractError>>()?;
            Ok(to_json_binary(&ContributionsResponse { contributions })?)
        }
        QueryMsg::Round { bounty_id, round } => Ok(to_json_binary(
            &ROUNDS.load(deps.storage, (bounty_id, round))?,
        )?),
        QueryMsg::Rounds {
            bounty_id,
            start_after,
            limit,
        } => {
            load_bounty(deps.storage, bounty_id)?;
            let start = start_after.map(Bound::exclusive);
            let rounds = ROUNDS
                .prefix(bounty_id)
                .range(deps.storage, start, None, Order::Ascending)
                .take(page_limit(deps.storage, limit)?)
                .map(|item| item.map(|(_, round)| round))
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&RoundsResponse { rounds })?)
        }
        QueryMsg::Receipt {
            bounty_id,
            round,
            voter,
        } => {
            let voter = deps.api.addr_validate(&voter)?;
            Ok(to_json_binary(
                &VOTES.may_load(deps.storage, (bounty_id, round, &voter))?,
            )?)
        }
        QueryMsg::Receipts {
            bounty_id,
            round,
            start_after,
            limit,
        } => {
            ROUNDS.load(deps.storage, (bounty_id, round))?;
            let start = start_after.map(Bound::exclusive);
            let receipts = VOTER_INDEX
                .prefix((bounty_id, round))
                .range(deps.storage, start, None, Order::Ascending)
                .take(page_limit(deps.storage, limit)?)
                .map(|item| {
                    let (_, voter) = item?;
                    VOTES.load(deps.storage, (bounty_id, round, &voter))
                })
                .collect::<StdResult<Vec<_>>>()?;
            Ok(to_json_binary(&ReceiptsResponse { receipts })?)
        }
        QueryMsg::Claim {
            bounty_id,
            contributor,
        } => {
            let contributor = deps.api.addr_validate(&contributor)?;
            Ok(to_json_binary(
                &CLAIMS.may_load(deps.storage, (bounty_id, &contributor))?,
            )?)
        }
        QueryMsg::Claims {
            bounty_id,
            start_after,
            limit,
        } => {
            let bounty = load_bounty(deps.storage, bounty_id)?;
            let scan_limit = page_limit(deps.storage, limit)?;
            let indexed = CONTRIBUTOR_INDEX
                .prefix(bounty_id)
                .range(
                    deps.storage,
                    start_after.map(Bound::exclusive),
                    None,
                    Order::Ascending,
                )
                .take(scan_limit)
                .collect::<StdResult<Vec<_>>>()?;
            let mut claims = Vec::with_capacity(indexed.len());
            let mut last_scanned = None;
            for (contributor_index, contributor) in indexed {
                last_scanned = Some(contributor_index);
                if let Some(claim) = CLAIMS.may_load(deps.storage, (bounty_id, &contributor))? {
                    claims.push(claim);
                }
            }
            let next_start_after = last_scanned.filter(|index| *index < bounty.contributor_count);
            Ok(to_json_binary(&ClaimsResponse {
                claims,
                next_start_after,
            })?)
        }
        QueryMsg::History {
            bounty_id,
            start_after,
            limit,
        } => {
            load_bounty(deps.storage, bounty_id)?;
            let entries = HISTORY
                .prefix(bounty_id)
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
        QueryMsg::ErrorCatalog {} => Ok(to_json_binary(&ErrorCatalogResponse {
            codes: vec![
                ErrorCode::Unauthorized,
                ErrorCode::UnexpectedFunds,
                ErrorCode::InvalidFunds,
                ErrorCode::InvalidConfiguration,
                ErrorCode::InvalidMetadata,
                ErrorCode::NotFound,
                ErrorCode::InvalidState,
                ErrorCode::Paused,
                ErrorCode::Expired,
                ErrorCode::NotExpired,
                ErrorCode::ContributionLimit,
                ErrorCode::RoundLimit,
                ErrorCode::WrongRound,
                ErrorCode::NotContributor,
                ErrorCode::VotingClosed,
                ErrorCode::RatificationOpen,
                ErrorCode::AlreadyClaimed,
                ErrorCode::NotRefundable,
                ErrorCode::NotProjectCandidate,
                ErrorCode::AlreadyGraduated,
                ErrorCode::Arithmetic,
            ],
        })?),
    }
}

fn load_bounty(storage: &dyn Storage, bounty_id: u64) -> Result<Bounty, ContractError> {
    BOUNTIES
        .may_load(storage, bounty_id)?
        .ok_or(ContractError::NotFound)
}

fn ensure_round(bounty: &Bounty, number: u32) -> Result<(), ContractError> {
    if bounty.active_round != Some(number) {
        return Err(ContractError::WrongRound);
    }
    Ok(())
}

fn ensure_not_paused(storage: &dyn Storage) -> Result<(), ContractError> {
    if PAUSE.load(storage)?.paused {
        return Err(ContractError::Paused);
    }
    Ok(())
}

fn nonpayable(info: &MessageInfo) -> Result<(), ContractError> {
    if !info.funds.is_empty() {
        return Err(ContractError::UnexpectedFunds);
    }
    Ok(())
}

fn attached_native(info: &MessageInfo, config: &Config) -> Result<Uint128, ContractError> {
    match info.funds.as_slice() {
        [coin] if coin.denom == config.native_denom && !coin.amount.is_zero() => Ok(coin.amount),
        _ => Err(ContractError::InvalidFunds),
    }
}

fn validate_config(config: &Config) -> Result<(), ContractError> {
    if config.native_denom != NATIVE_DENOM {
        return Err(ContractError::InvalidConfiguration(
            "v1 native denomination must be ujuno".into(),
        ));
    }
    if config.min_contribution.is_zero()
        || config.max_bounty_total < config.min_contribution
        || config.min_lifetime_seconds == 0
        || config.max_lifetime_seconds < config.min_lifetime_seconds
        || config.max_lifetime_seconds > MAX_HARD_LIFETIME_SECONDS
        || config.max_contributors == 0
        || config.max_contributors > MAX_HARD_CONTRIBUTORS
        || config.max_rounds == 0
        || config.max_rounds > MAX_HARD_ROUNDS
    {
        return Err(ContractError::InvalidConfiguration(
            "economic or state-space bound is invalid".into(),
        ));
    }
    let limits = &config.limits;
    let text_limits = [
        limits.max_title_bytes,
        limits.max_summary_bytes,
        limits.max_acceptance_criteria_bytes,
        limits.max_uri_bytes,
        limits.max_rationale_bytes,
        limits.max_reason_bytes,
    ];
    if text_limits
        .iter()
        .any(|value| *value == 0 || *value > MAX_HARD_TEXT_BYTES)
        || limits.max_page_limit == 0
        || limits.max_page_limit > MAX_HARD_PAGE_LIMIT
    {
        return Err(ContractError::InvalidConfiguration(
            "text or pagination bound is invalid".into(),
        ));
    }
    if config.ratification_seconds != RATIFICATION_SECONDS {
        return Err(ContractError::InvalidConfiguration(
            "ratification duration is immutable".into(),
        ));
    }
    Ok(())
}

fn validate_expiry(
    now: Timestamp,
    expires_at: Timestamp,
    config: &Config,
) -> Result<(), ContractError> {
    let lifetime_nanos = expires_at
        .nanos()
        .checked_sub(now.nanos())
        .ok_or_else(|| ContractError::InvalidMetadata("expiry must be in the future".into()))?;
    let min = config
        .min_lifetime_seconds
        .checked_mul(1_000_000_000)
        .ok_or_else(|| ContractError::InvalidConfiguration("lifetime overflow".into()))?;
    let max = config
        .max_lifetime_seconds
        .checked_mul(1_000_000_000)
        .ok_or_else(|| ContractError::InvalidConfiguration("lifetime overflow".into()))?;
    if lifetime_nanos < min || lifetime_nanos > max {
        return Err(ContractError::InvalidMetadata(
            "expiry is outside configured lifetime bounds".into(),
        ));
    }
    Ok(())
}

fn validate_required(value: &str, label: &str, max: u32) -> Result<(), ContractError> {
    if value.trim().is_empty() || value.len() > max as usize {
        return Err(ContractError::InvalidMetadata(format!(
            "{label} must be nonempty and at most {max} bytes"
        )));
    }
    Ok(())
}

fn validate_optional(value: &str, label: &str, max: u32) -> Result<(), ContractError> {
    if value.len() > max as usize {
        return Err(ContractError::InvalidMetadata(format!(
            "{label} must be at most {max} bytes"
        )));
    }
    Ok(())
}

fn validate_uri_digest_pair(
    uri: Option<&str>,
    digest: Option<&str>,
    max_uri: u32,
) -> Result<(), ContractError> {
    match (uri, digest) {
        (None, None) => Ok(()),
        (Some(uri), Some(digest)) => {
            validate_required(uri, "content_uri", max_uri)?;
            validate_digest(digest)
        }
        _ => Err(ContractError::InvalidMetadata(
            "URI and SHA-256 digest must be supplied together".into(),
        )),
    }
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
            "digest must use sha256:<64 lowercase hex characters>".into(),
        ));
    }
    Ok(())
}

fn validate_project_candidate(
    candidate: &crate::msg::ProjectCandidate,
    limits: &Limits,
) -> Result<(), ContractError> {
    if candidate.project_id.len() < 3
        || candidate.project_id.len() > 64
        || !candidate
            .project_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ContractError::InvalidMetadata(
            "project_id must be 3-64 lowercase ASCII letters, digits, or hyphens".into(),
        ));
    }
    validate_required(
        &candidate.metadata_uri,
        "metadata_uri",
        limits.max_uri_bytes,
    )?;
    validate_digest(&candidate.metadata_digest)
}

fn weight_at_round(
    storage: &dyn Storage,
    bounty_id: u64,
    contributor: &cosmwasm_std::Addr,
    number: u32,
) -> Result<Option<Uint128>, ContractError> {
    Ok(CONTRIBUTION_CHECKPOINTS
        .prefix((bounty_id, contributor))
        .range(
            storage,
            None,
            Some(Bound::inclusive(number)),
            Order::Descending,
        )
        .next()
        .transpose()?
        .map(|(_, amount)| amount))
}

fn ensure_contributor(
    storage: &dyn Storage,
    bounty_id: u64,
    number: u32,
    contributor: &cosmwasm_std::Addr,
) -> Result<Uint128, ContractError> {
    weight_at_round(storage, bounty_id, contributor, number)?
        .filter(|weight| !weight.is_zero())
        .ok_or(ContractError::NotContributor)
}

fn contribution_view(
    storage: &dyn Storage,
    bounty_id: u64,
    contributor: &cosmwasm_std::Addr,
    number: Option<u32>,
) -> Result<ContributionView, ContractError> {
    let current_amount = CONTRIBUTIONS
        .may_load(storage, (bounty_id, contributor))?
        .ok_or(ContractError::NotContributor)?;
    let contributor_index = CONTRIBUTOR_POSITION.load(storage, (bounty_id, contributor))?;
    let weight_at_round = number
        .map(|round| weight_at_round(storage, bounty_id, contributor, round))
        .transpose()?
        .flatten();
    Ok(ContributionView {
        bounty_id,
        contributor: contributor.clone(),
        current_amount,
        weight_at_round,
        contributor_index,
    })
}

fn append_history(
    storage: &mut dyn Storage,
    bounty: &mut Bounty,
    actor: &cosmwasm_std::Addr,
    action: HistoryAction,
    at: Timestamp,
) -> Result<(), ContractError> {
    bounty.history_count = bounty
        .history_count
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidConfiguration("history sequence overflow".into()))?;
    HISTORY.save(
        storage,
        (bounty.id, bounty.history_count),
        &HistoryEntry {
            bounty_id: bounty.id,
            sequence: bounty.history_count,
            actor: actor.clone(),
            action,
            at,
        },
    )?;
    Ok(())
}

fn settle_paid(
    storage: &mut dyn Storage,
    bounty: &mut Bounty,
    recipient: &cosmwasm_std::Addr,
    at: Timestamp,
    _config: &Config,
) -> Result<(), ContractError> {
    let amount = bounty.total_contribution;
    bounty.status = BountyStatus::Paid;
    bounty.active_round = None;
    bounty.paid_recipient = Some(recipient.clone());
    bounty.paid_amount = amount;
    bounty.paid_at = Some(at);
    ACCOUNTING.update(storage, |mut accounting| -> Result<_, ContractError> {
        accounting.pending_payout_liabilities =
            accounting.pending_payout_liabilities.checked_sub(amount)?;
        accounting.lifetime_paid = accounting.lifetime_paid.checked_add(amount)?;
        Ok(accounting)
    })?;
    Ok(())
}

fn reset_or_refund_state(bounty: &mut Bounty, at: Timestamp) -> Result<(), ContractError> {
    bounty.active_round = None;
    if at >= bounty.expires_at {
        enter_refunding(bounty, RefundReason::Expired);
    } else if bounty.next_round >= bounty.terms.max_rounds {
        enter_refunding(bounty, RefundReason::RoundLimit);
    } else {
        bounty.status = BountyStatus::Open;
        bounty.next_round = bounty
            .next_round
            .checked_add(1)
            .ok_or(ContractError::RoundLimit)?;
    }
    Ok(())
}

fn apply_failed_round_accounting(
    bounty: &Bounty,
    accounting: &mut Accounting,
) -> Result<(), ContractError> {
    accounting.pending_payout_liabilities = accounting
        .pending_payout_liabilities
        .checked_sub(bounty.total_contribution)?;
    if bounty.status == BountyStatus::Refunding {
        accounting.outstanding_refunds = accounting
            .outstanding_refunds
            .checked_add(bounty.total_contribution)?;
    } else {
        accounting.active_escrow = accounting
            .active_escrow
            .checked_add(bounty.total_contribution)?;
    }
    Ok(())
}

fn enter_refunding(bounty: &mut Bounty, reason: RefundReason) {
    bounty.status = BountyStatus::Refunding;
    bounty.refund_reason = Some(reason);
    bounty.active_round = None;
}

fn move_active_to_refunds(storage: &mut dyn Storage, amount: Uint128) -> Result<(), ContractError> {
    ACCOUNTING.update(storage, |mut accounting| -> Result<_, ContractError> {
        accounting.active_escrow = accounting.active_escrow.checked_sub(amount)?;
        accounting.outstanding_refunds = accounting.outstanding_refunds.checked_add(amount)?;
        Ok(accounting)
    })?;
    Ok(())
}

fn page_limit(storage: &dyn Storage, requested: Option<u32>) -> Result<usize, ContractError> {
    let max = CONFIG.load(storage)?.limits.max_page_limit;
    let value = requested.unwrap_or(max).min(max);
    if value == 0 {
        return Err(ContractError::InvalidConfiguration(
            "query limit must be positive".into(),
        ));
    }
    Ok(value as usize)
}

fn vote_name(vote: &PayoutVote) -> &'static str {
    match vote {
        PayoutVote::Yes => "yes",
        PayoutVote::No => "no",
    }
}

fn moderation_name(outcome: &ModerationOutcome) -> &'static str {
    match outcome {
        ModerationOutcome::Spam => "spam",
        ModerationOutcome::Duplicate => "duplicate",
        ModerationOutcome::PolicyViolation => "policy_violation",
    }
}

fn outcome_name(outcome: &RoundOutcome) -> &'static str {
    match outcome {
        RoundOutcome::Pending => "pending",
        RoundOutcome::Paid => "paid",
        RoundOutcome::Declined => "declined",
        RoundOutcome::NoMajority => "no_majority",
        RoundOutcome::Tie => "tie",
        RoundOutcome::NoVotes => "no_votes",
    }
}

fn status_name(status: &BountyStatus) -> &'static str {
    match status {
        BountyStatus::Open => "open",
        BountyStatus::SingleConfirmation => "single_confirmation",
        BountyStatus::Ratifying => "ratifying",
        BountyStatus::Refunding => "refunding",
        BountyStatus::Refunded => "refunded",
        BountyStatus::Paid => "paid",
    }
}
