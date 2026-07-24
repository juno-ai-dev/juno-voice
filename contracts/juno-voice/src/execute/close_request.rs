use cosmwasm_std::{DepsMut, Env, MessageInfo, Response, Uint256};

use crate::bindings::JunoQuery;
use crate::error::ContractError;
use crate::execute::set_status::{persist_transition, TransitionWrite};
use crate::lifecycle::{allowed, Controller, Transition};
use crate::state::{BondState, RequestAction, Status, BOND_TOTALS, REQUESTS};

pub fn execute(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
) -> Result<Response, ContractError> {
    let mut request = REQUESTS
        .may_load(deps.storage, request_id)?
        .ok_or(ContractError::UnknownRequest { request_id })?;
    if request.status != Status::Open {
        return Err(ContractError::InvalidStatusTransition);
    }
    if env.block.height < request.closes_height {
        return Err(ContractError::RequestNotClosed);
    }

    let qualified = qualifies(
        request.support_power,
        request.oppose_power,
        request.total_power,
        request.quorum_bps,
        request.support_bps,
    )?;
    let to = if qualified {
        Status::Qualified
    } else {
        Status::NotPrioritized
    };
    let kind = if qualified {
        Transition::CloseQualified
    } else {
        Transition::CloseNotPrioritized
    };
    if !allowed(kind, &request.status, &to, Controller::Public) {
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

    let from = request.status.clone();
    request.status = to.clone();
    request.bond.state = BondState::Refundable;
    request.updated_at = env.block.time;
    let amount = request.bond.amount;
    persist_transition(
        deps.storage,
        &env,
        TransitionWrite {
            request,
            from: from.clone(),
            actor: info.sender,
            reason: None,
            actions: vec![
                RequestAction::Finalized { qualified },
                RequestAction::StatusTransition { from, to },
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
        "close_request",
    )
}

pub fn qualifies(
    support: cosmwasm_std::Uint128,
    oppose: cosmwasm_std::Uint128,
    total: cosmwasm_std::Uint128,
    quorum_bps: u16,
    support_bps: u16,
) -> Result<bool, ContractError> {
    if total.is_zero()
        || !(1..=10_000).contains(&quorum_bps)
        || !(1..=10_000).contains(&support_bps)
    {
        return Err(ContractError::AggregateInvariant);
    }
    let support = Uint256::from(support);
    let participation = support + Uint256::from(oppose);
    let total = Uint256::from(total);
    if participation > total {
        return Err(ContractError::AggregateInvariant);
    }
    if participation.is_zero() {
        return Ok(false);
    }
    let scale = Uint256::from(10_000u16);
    Ok(participation * scale >= total * Uint256::from(quorum_bps)
        && support * scale >= participation * Uint256::from(support_bps))
}
