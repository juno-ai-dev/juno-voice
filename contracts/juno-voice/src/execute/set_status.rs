use cosmwasm_std::{Addr, DepsMut, Env, MessageInfo, Order, Response, Storage};

use crate::bindings::JunoQuery;
use crate::error::ContractError;
use crate::lifecycle::{allowed, Controller, Transition};
use crate::rank::rank_key;
use crate::state::{
    BondState, BondTotals, Request, RequestAction, RequestActionRecord, ShipmentAttestation,
    Status, StatusHistoryRecord, BOND_TOTALS, CONFIG, DUPLICATE_REFERENCES, NEXT_REQUEST_ACTION_ID,
    NEXT_STATUS_HISTORY_ID, REQUESTS, REQUESTS_BY_STATUS, REQUEST_ACTIONS, SHIPMENT_ATTESTATIONS,
    STATUS_CATEGORY_RANK, STATUS_HISTORY, STATUS_RANK,
};

pub fn mark_spam(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    require_steward(&info, &config.steward)?;
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    require_transition(
        Transition::MarkSpam,
        &request.status,
        &Status::Spam,
        Controller::Steward,
    )?;
    ensure_not_referenced(deps.storage, request_id)?;
    if request.bond.state != BondState::Locked || request.bond.amount.is_zero() {
        return Err(ContractError::BondInvariant);
    }
    let mut totals = BOND_TOTALS.load(deps.storage)?;
    totals.locked = totals
        .locked
        .checked_sub(request.bond.amount)
        .map_err(|_| ContractError::BondInvariant)?;
    totals.forfeited = totals
        .forfeited
        .checked_add(request.bond.amount)
        .map_err(|_| ContractError::BondTotalOverflow)?;
    let amount = request.bond.amount;
    let from = request.status.clone();
    request.status = Status::Spam;
    request.bond.state = BondState::Forfeited;
    request.updated_at = env.block.time;
    transition(
        deps,
        env,
        info,
        request,
        from.clone(),
        Some(reason),
        vec![
            RequestAction::StatusTransition {
                from,
                to: Status::Spam,
            },
            RequestAction::BondTransition {
                from: Some(BondState::Locked),
                to: BondState::Forfeited,
                amount,
            },
        ],
        Some(totals),
        None,
        "mark_spam",
    )
}

pub fn mark_duplicate(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    canonical_request_id: u64,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    require_steward(&info, &config.steward)?;
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    require_transition(
        Transition::MarkDuplicate,
        &request.status,
        &Status::Duplicate,
        Controller::Steward,
    )?;
    if request.canonical_request_id.is_some() {
        return Err(ContractError::InvalidDuplicateTarget);
    }
    ensure_not_referenced(deps.storage, request_id)?;
    if canonical_request_id >= request_id {
        return Err(ContractError::InvalidDuplicateTarget);
    }
    let target = REQUESTS
        .may_load(deps.storage, canonical_request_id)?
        .ok_or(ContractError::InvalidDuplicateTarget)?;
    if matches!(target.status, Status::Duplicate | Status::Spam) {
        return Err(ContractError::InvalidDuplicateTarget);
    }

    let (totals, bond_action) = make_refundable(deps.storage, &mut request, true)?;
    let from = request.status.clone();
    request.status = Status::Duplicate;
    request.canonical_request_id = Some(canonical_request_id);
    request.updated_at = env.block.time;
    let mut actions = vec![
        RequestAction::DuplicateLinked {
            canonical_request_id,
        },
        RequestAction::StatusTransition {
            from: from.clone(),
            to: Status::Duplicate,
        },
    ];
    if let Some(action) = bond_action {
        actions.push(action);
    }
    transition(
        deps,
        env,
        info,
        request,
        from,
        Some(reason),
        actions,
        totals,
        Some((canonical_request_id, request_id)),
        "mark_duplicate",
    )
}

pub fn archive_request(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    require_steward(&info, &config.steward)?;
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    require_transition(
        Transition::Archive,
        &request.status,
        &Status::Archived,
        Controller::Steward,
    )?;
    let (totals, bond_action) = make_refundable(deps.storage, &mut request, true)?;
    let from = request.status.clone();
    request.status = Status::Archived;
    request.updated_at = env.block.time;
    let mut actions = vec![RequestAction::StatusTransition {
        from: from.clone(),
        to: Status::Archived,
    }];
    if let Some(action) = bond_action {
        actions.push(action);
    }
    transition(
        deps,
        env,
        info,
        request,
        from,
        Some(reason),
        actions,
        totals,
        None,
        "archive_request",
    )
}

pub fn start_building(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    builder: String,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    require_steward(&info, &config.steward)?;
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let builder = deps
        .api
        .addr_validate(&builder)
        .map_err(|_| ContractError::InvalidAddress { role: "builder" })?;
    if builder == config.verifier {
        return Err(ContractError::InvalidBuilder);
    }
    let mut request = load_request(deps.storage, request_id)?;
    require_transition(
        Transition::StartBuilding,
        &request.status,
        &Status::Building,
        Controller::Steward,
    )?;
    if request.builder.is_some()
        || request.work_round != 0
        || request.work_activity_height.is_some()
    {
        return Err(ContractError::InvalidBuilder);
    }
    let new_round = request
        .work_round
        .checked_add(1)
        .ok_or(ContractError::WorkRoundOverflow)?;
    let from = request.status.clone();
    request.status = Status::Building;
    request.builder = Some(builder.clone());
    request.work_round = new_round;
    request.work_activity_height = Some(env.block.height);
    request.updated_at = env.block.time;
    transition(
        deps,
        env,
        info,
        request,
        from.clone(),
        Some(reason),
        vec![
            RequestAction::BuilderAssigned {
                previous_builder: None,
                new_builder: builder,
                previous_work_round: 0,
                new_work_round: new_round,
            },
            RequestAction::StatusTransition {
                from,
                to: Status::Building,
            },
        ],
        None,
        None,
        "start_building",
    )
}

pub fn block_building(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    if request.status != Status::Building {
        return Err(ContractError::InvalidStatusTransition);
    }
    let builder = request
        .builder
        .as_ref()
        .ok_or(ContractError::InvalidBuilder)?;
    let controller = if info.sender == *builder {
        Controller::Builder
    } else if info.sender == config.steward {
        let activity = request
            .work_activity_height
            .ok_or(ContractError::MissingWorkActivity)?;
        let elapsed = activity
            .checked_add(request.work_inactivity_blocks)
            .is_some_and(|deadline| env.block.height >= deadline);
        if !elapsed {
            return Err(ContractError::WorkInactivityNotElapsed);
        }
        Controller::Steward
    } else {
        return Err(ContractError::Unauthorized);
    };
    require_transition(
        Transition::BlockBuilding,
        &request.status,
        &Status::Blocked,
        controller,
    )?;
    let from = request.status.clone();
    request.status = Status::Blocked;
    request.updated_at = env.block.time;
    transition(
        deps,
        env,
        info,
        request,
        from.clone(),
        Some(reason),
        vec![RequestAction::StatusTransition {
            from,
            to: Status::Blocked,
        }],
        None,
        None,
        "block_building",
    )
}

pub fn resume_building(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    builder: String,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    require_steward(&info, &config.steward)?;
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let builder = deps
        .api
        .addr_validate(&builder)
        .map_err(|_| ContractError::InvalidAddress { role: "builder" })?;
    if builder == config.verifier {
        return Err(ContractError::InvalidBuilder);
    }
    let mut request = load_request(deps.storage, request_id)?;
    require_transition(
        Transition::ResumeBuilding,
        &request.status,
        &Status::Building,
        Controller::Steward,
    )?;
    let previous_builder = request
        .builder
        .clone()
        .ok_or(ContractError::InvalidBuilder)?;
    if request.work_round == 0 || request.work_activity_height.is_none() {
        return Err(ContractError::MissingWorkActivity);
    }
    let previous_round = request.work_round;
    let new_round = previous_round
        .checked_add(1)
        .ok_or(ContractError::WorkRoundOverflow)?;
    let from = request.status.clone();
    request.status = Status::Building;
    request.builder = Some(builder.clone());
    request.work_round = new_round;
    request.work_activity_height = Some(env.block.height);
    request.updated_at = env.block.time;
    transition(
        deps,
        env,
        info,
        request,
        from.clone(),
        Some(reason),
        vec![
            RequestAction::BuilderAssigned {
                previous_builder: Some(previous_builder),
                new_builder: builder,
                previous_work_round: previous_round,
                new_work_round: new_round,
            },
            RequestAction::StatusTransition {
                from,
                to: Status::Building,
            },
        ],
        None,
        None,
        "resume_building",
    )
}

pub fn reject_review(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.verifier {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    require_transition(
        Transition::RejectReview,
        &request.status,
        &Status::Building,
        Controller::Verifier,
    )?;
    let builder = request
        .builder
        .clone()
        .ok_or(ContractError::InvalidBuilder)?;
    if builder == config.verifier
        || request.work_round == 0
        || request.work_activity_height.is_none()
    {
        return Err(ContractError::InvalidBuilder);
    }
    let previous_round = request.work_round;
    let new_round = previous_round
        .checked_add(1)
        .ok_or(ContractError::WorkRoundOverflow)?;
    let from = request.status.clone();
    request.status = Status::Building;
    request.work_round = new_round;
    request.work_activity_height = Some(env.block.height);
    request.updated_at = env.block.time;
    transition(
        deps,
        env,
        info,
        request,
        from.clone(),
        Some(reason),
        vec![
            RequestAction::ReviewRejected,
            RequestAction::BuilderAssigned {
                previous_builder: Some(builder.clone()),
                new_builder: builder,
                previous_work_round: previous_round,
                new_work_round: new_round,
            },
            RequestAction::StatusTransition {
                from,
                to: Status::Building,
            },
        ],
        None,
        None,
        "reject_review",
    )
}

pub fn block_review(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    reason: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.verifier {
        return Err(ContractError::Unauthorized);
    }
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    require_transition(
        Transition::BlockReview,
        &request.status,
        &Status::Blocked,
        Controller::Verifier,
    )?;
    if request.builder.is_none()
        || request.work_round == 0
        || request.work_activity_height.is_none()
    {
        return Err(ContractError::InvalidBuilder);
    }
    let from = request.status.clone();
    request.status = Status::Blocked;
    request.updated_at = env.block.time;
    transition(
        deps,
        env,
        info,
        request,
        from.clone(),
        Some(reason),
        vec![RequestAction::StatusTransition {
            from,
            to: Status::Blocked,
        }],
        None,
        None,
        "block_review",
    )
}

// Keeping complete transition facts at each call site makes audit writes explicit.
#[allow(clippy::too_many_arguments)]
fn transition(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request: Request,
    from: Status,
    reason: Option<String>,
    actions: Vec<RequestAction>,
    bond_totals: Option<BondTotals>,
    duplicate_reference: Option<(u64, u64)>,
    response_action: &str,
) -> Result<Response, ContractError> {
    persist_transition(
        deps.storage,
        &env,
        TransitionWrite {
            request,
            from,
            actor: info.sender,
            reason,
            actions,
            bond_totals,
            duplicate_reference,
            evidence_ids: vec![],
            shipment_attestation: None,
        },
        response_action,
    )
}

fn require_transition(
    kind: Transition,
    from: &Status,
    to: &Status,
    controller: Controller,
) -> Result<(), ContractError> {
    if !allowed(kind, from, to, controller) {
        return Err(ContractError::InvalidStatusTransition);
    }
    Ok(())
}

fn require_steward(info: &MessageInfo, steward: &cosmwasm_std::Addr) -> Result<(), ContractError> {
    if info.sender != *steward {
        return Err(ContractError::Unauthorized);
    }
    Ok(())
}

fn load_request(storage: &dyn cosmwasm_std::Storage, id: u64) -> Result<Request, ContractError> {
    REQUESTS
        .may_load(storage, id)?
        .ok_or(ContractError::UnknownRequest { request_id: id })
}

fn ensure_not_referenced(
    storage: &dyn cosmwasm_std::Storage,
    request_id: u64,
) -> Result<(), ContractError> {
    if DUPLICATE_REFERENCES
        .prefix(request_id)
        .range(storage, None, None, Order::Ascending)
        .next()
        .transpose()?
        .is_some()
    {
        return Err(ContractError::DuplicateTargetReferenced);
    }
    Ok(())
}

fn make_refundable(
    storage: &dyn cosmwasm_std::Storage,
    request: &mut Request,
    allow_already_refundable: bool,
) -> Result<(Option<BondTotals>, Option<RequestAction>), ContractError> {
    match request.bond.state {
        BondState::Locked => {
            if request.bond.amount.is_zero() {
                return Err(ContractError::BondInvariant);
            }
            let mut totals = BOND_TOTALS.load(storage)?;
            totals.locked = totals
                .locked
                .checked_sub(request.bond.amount)
                .map_err(|_| ContractError::BondInvariant)?;
            totals.refundable = totals
                .refundable
                .checked_add(request.bond.amount)
                .map_err(|_| ContractError::BondTotalOverflow)?;
            request.bond.state = BondState::Refundable;
            Ok((
                Some(totals),
                Some(RequestAction::BondTransition {
                    from: Some(BondState::Locked),
                    to: BondState::Refundable,
                    amount: request.bond.amount,
                }),
            ))
        }
        BondState::Refundable if allow_already_refundable => {
            if request.bond.amount.is_zero()
                || BOND_TOTALS.load(storage)?.refundable < request.bond.amount
            {
                return Err(ContractError::BondInvariant);
            }
            Ok((None, None))
        }
        _ => Err(ContractError::BondInvariant),
    }
}

pub(crate) struct TransitionWrite {
    pub request: Request,
    pub from: Status,
    pub actor: Addr,
    pub reason: Option<String>,
    pub actions: Vec<RequestAction>,
    pub bond_totals: Option<BondTotals>,
    pub duplicate_reference: Option<(u64, u64)>,
    pub evidence_ids: Vec<u64>,
    pub shipment_attestation: Option<ShipmentAttestation>,
}

pub(crate) fn persist_transition(
    storage: &mut dyn Storage,
    env: &Env,
    write: TransitionWrite,
    response_action: &str,
) -> Result<Response, ContractError> {
    let request_id = write.request.id;
    let action_id = NEXT_REQUEST_ACTION_ID.load(storage, request_id)?;
    let action_count =
        u64::try_from(write.actions.len()).map_err(|_| ContractError::RequestActionIdOverflow)?;
    let next_action_id = action_id
        .checked_add(action_count)
        .ok_or(ContractError::RequestActionIdOverflow)?;
    let history_id = NEXT_STATUS_HISTORY_ID.load(storage, request_id)?;
    let next_history_id = history_id
        .checked_add(1)
        .ok_or(ContractError::StatusHistoryIdOverflow)?;
    for offset in 0..action_count {
        let id = action_id
            .checked_add(offset)
            .ok_or(ContractError::RequestActionIdOverflow)?;
        if REQUEST_ACTIONS
            .may_load(storage, (request_id, id))?
            .is_some()
        {
            return Err(ContractError::AuditInvariant);
        }
    }
    if STATUS_HISTORY
        .may_load(storage, (request_id, history_id))?
        .is_some()
    {
        return Err(ContractError::AuditInvariant);
    }
    if let Some(reference) = write.duplicate_reference {
        if DUPLICATE_REFERENCES.may_load(storage, reference)?.is_some() {
            return Err(ContractError::AuditInvariant);
        }
    }
    if write.shipment_attestation.is_some()
        && SHIPMENT_ATTESTATIONS
            .may_load(storage, request_id)?
            .is_some()
    {
        return Err(ContractError::AttestationExists);
    }

    let key = rank_key(
        write.request.support_power,
        write.request.oppose_power,
        request_id,
    );
    if REQUESTS_BY_STATUS
        .may_load(storage, (write.from.code(), request_id))?
        .is_none()
        || STATUS_RANK.may_load(storage, (write.from.code(), key.clone()))? != Some(request_id)
        || STATUS_CATEGORY_RANK.may_load(
            storage,
            (
                write.from.code(),
                write.request.category.as_str(),
                key.clone(),
            ),
        )? != Some(request_id)
    {
        return Err(ContractError::IndexInvariant);
    }
    let destination_status = write.request.status.code();
    if REQUESTS_BY_STATUS
        .may_load(storage, (destination_status, request_id))?
        .is_some()
        || STATUS_RANK
            .may_load(storage, (destination_status, key.clone()))?
            .is_some()
        || STATUS_CATEGORY_RANK
            .may_load(
                storage,
                (
                    destination_status,
                    write.request.category.as_str(),
                    key.clone(),
                ),
            )?
            .is_some()
    {
        return Err(ContractError::IndexInvariant);
    }

    let history = StatusHistoryRecord {
        id: history_id,
        request_id,
        actor: write.actor.clone(),
        from: write.from.clone(),
        to: write.request.status.clone(),
        reason: write.reason.clone(),
        evidence_ids: write.evidence_ids.clone(),
        height: env.block.height,
        timestamp: env.block.time,
    };
    let mut records = Vec::with_capacity(write.actions.len());
    for (offset, action) in write.actions.into_iter().enumerate() {
        let offset = u64::try_from(offset).map_err(|_| ContractError::RequestActionIdOverflow)?;
        let id = action_id
            .checked_add(offset)
            .ok_or(ContractError::RequestActionIdOverflow)?;
        records.push(RequestActionRecord {
            id,
            request_id,
            actor: write.actor.clone(),
            action,
            reason: write.reason.clone(),
            height: env.block.height,
            timestamp: env.block.time,
        });
    }

    REQUESTS_BY_STATUS.remove(storage, (write.from.code(), request_id));
    STATUS_RANK.remove(storage, (write.from.code(), key.clone()));
    STATUS_CATEGORY_RANK.remove(
        storage,
        (
            write.from.code(),
            write.request.category.as_str(),
            key.clone(),
        ),
    );
    REQUESTS_BY_STATUS.save(storage, (write.request.status.code(), request_id), &())?;
    STATUS_RANK.save(
        storage,
        (write.request.status.code(), key.clone()),
        &request_id,
    )?;
    STATUS_CATEGORY_RANK.save(
        storage,
        (
            write.request.status.code(),
            write.request.category.as_str(),
            key,
        ),
        &request_id,
    )?;
    REQUESTS.save(storage, request_id, &write.request)?;
    if let Some(totals) = write.bond_totals {
        BOND_TOTALS.save(storage, &totals)?;
    }
    if let Some(reference) = write.duplicate_reference {
        DUPLICATE_REFERENCES.save(storage, reference, &())?;
    }
    for record in records {
        REQUEST_ACTIONS.save(storage, (request_id, record.id), &record)?;
    }
    STATUS_HISTORY.save(storage, (request_id, history_id), &history)?;
    if let Some(attestation) = write.shipment_attestation {
        SHIPMENT_ATTESTATIONS.save(storage, request_id, &attestation)?;
    }
    NEXT_REQUEST_ACTION_ID.save(storage, request_id, &next_action_id)?;
    NEXT_STATUS_HISTORY_ID.save(storage, request_id, &next_history_id)?;

    Ok(Response::new()
        .add_attribute("action", response_action)
        .add_attribute("request_id", request_id.to_string())
        .add_attribute("status", status_name(&write.request.status)))
}

pub(crate) fn validate_reason(
    reason: String,
    max_reason_bytes: u16,
) -> Result<String, ContractError> {
    if reason.len() > usize::from(max_reason_bytes) {
        return Err(ContractError::InvalidReason);
    }
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        return Err(ContractError::InvalidReason);
    }
    Ok(trimmed.to_owned())
}

fn status_name(status: &Status) -> &'static str {
    match status {
        Status::Open => "open",
        Status::Qualified => "qualified",
        Status::NotPrioritized => "not_prioritized",
        Status::Duplicate => "duplicate",
        Status::Spam => "spam",
        Status::Building => "building",
        Status::Review => "review",
        Status::Blocked => "blocked",
        Status::Archived => "archived",
        Status::Shipped => "shipped",
    }
}
