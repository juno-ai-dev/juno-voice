use cosmwasm_std::{BankMsg, Coin, DepsMut, Env, MessageInfo, Response};

use crate::bindings::JunoQuery;
use crate::error::ContractError;
use crate::state::{
    BondState, RequestAction, RequestActionRecord, BOND_TOTALS, CONFIG, NEXT_REQUEST_ACTION_ID,
    REQUESTS, REQUEST_ACTIONS,
};

pub fn execute(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut request = REQUESTS
        .may_load(deps.storage, request_id)?
        .ok_or(ContractError::UnknownRequest { request_id })?;
    if info.sender != request.author {
        return Err(ContractError::Unauthorized);
    }
    if request.bond.state != BondState::Refundable || request.bond.amount.is_zero() {
        return Err(ContractError::BondInvariant);
    }
    let mut totals = BOND_TOTALS.load(deps.storage)?;
    let aggregate = totals
        .locked
        .checked_add(totals.refundable)
        .and_then(|value| value.checked_add(totals.forfeited))
        .map_err(|_| ContractError::AggregateInvariant)?;
    if totals.refundable < request.bond.amount {
        return Err(ContractError::BondInvariant);
    }
    let balance = deps
        .querier
        .query_balance(env.contract.address, config.native_denom.clone())?;
    if balance.amount < aggregate {
        return Err(ContractError::Insolvent);
    }
    totals.refundable = totals
        .refundable
        .checked_sub(request.bond.amount)
        .map_err(|_| ContractError::BondInvariant)?;
    let first_id = NEXT_REQUEST_ACTION_ID.load(deps.storage, request_id)?;
    let second_id = first_id
        .checked_add(1)
        .ok_or(ContractError::RequestActionIdOverflow)?;
    let next_id = first_id
        .checked_add(2)
        .ok_or(ContractError::RequestActionIdOverflow)?;
    for id in [first_id, second_id] {
        if REQUEST_ACTIONS
            .may_load(deps.storage, (request_id, id))?
            .is_some()
        {
            return Err(ContractError::AuditInvariant);
        }
    }
    let amount = request.bond.amount;
    request.bond.state = BondState::Claimed;
    request.updated_at = env.block.time;
    let records = [
        RequestActionRecord {
            id: first_id,
            request_id,
            actor: info.sender.clone(),
            action: RequestAction::BondTransition {
                from: Some(BondState::Refundable),
                to: BondState::Claimed,
                amount,
            },
            reason: None,
            height: env.block.height,
            timestamp: env.block.time,
        },
        RequestActionRecord {
            id: second_id,
            request_id,
            actor: info.sender,
            action: RequestAction::RefundWithdrawn { amount },
            reason: None,
            height: env.block.height,
            timestamp: env.block.time,
        },
    ];
    REQUESTS.save(deps.storage, request_id, &request)?;
    BOND_TOTALS.save(deps.storage, &totals)?;
    for record in records {
        REQUEST_ACTIONS.save(deps.storage, (request_id, record.id), &record)?;
    }
    NEXT_REQUEST_ACTION_ID.save(deps.storage, request_id, &next_id)?;

    Ok(Response::new()
        .add_attribute("action", "withdraw_refund")
        .add_attribute("request_id", request_id.to_string())
        .add_message(BankMsg::Send {
            to_address: request.author.into_string(),
            amount: vec![Coin {
                denom: config.native_denom,
                amount,
            }],
        }))
}
