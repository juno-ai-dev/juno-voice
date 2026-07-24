use std::collections::BTreeSet;

use cosmwasm_std::{DepsMut, Env, MessageInfo, Response};

use crate::bindings::JunoQuery;
use crate::error::ContractError;
use crate::execute::set_status::{persist_transition, validate_reason, TransitionWrite};
use crate::lifecycle::{allowed, Controller, Transition};
use crate::state::{
    Evidence, EvidenceKind, Request, RequestAction, RequestActionRecord, ShipmentAttestation,
    Status, CONFIG, EVIDENCE, NEXT_EVIDENCE_ID, NEXT_REQUEST_ACTION_ID, REQUESTS, REQUEST_ACTIONS,
    SHIPMENT_ATTESTATIONS,
};

pub const fn is_delivery(kind: &EvidenceKind) -> bool {
    matches!(
        kind,
        EvidenceKind::PullRequest
            | EvidenceKind::Commit
            | EvidenceKind::Release
            | EvidenceKind::Deployment
            | EvidenceKind::Document
    )
}

pub const fn is_verification(kind: &EvidenceKind) -> bool {
    matches!(
        kind,
        EvidenceKind::TestReport | EvidenceKind::AuditReport | EvidenceKind::ReviewRecord
    )
}

#[allow(clippy::too_many_arguments)]
pub fn add(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    kind: EvidenceKind,
    uri: String,
    digest: String,
    note: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut request = load_request(deps.storage, request_id)?;
    validate_work(&request, &config.verifier)?;
    if request.evidence_policy_version != 1
        || uri.len() > usize::from(request.limits.max_uri_bytes)
        || digest.len() > usize::from(request.limits.max_digest_bytes)
        || note.len() > usize::from(request.limits.max_evidence_note_bytes)
        || !valid_uri(&uri)
        || !valid_digest(&digest)
    {
        return Err(ContractError::InvalidEvidence);
    }
    let builder = request
        .builder
        .as_ref()
        .ok_or(ContractError::InvalidBuilder)?;
    if is_delivery(&kind) {
        if request.status != Status::Building {
            return Err(ContractError::InvalidStatusTransition);
        }
        if info.sender != *builder {
            return Err(ContractError::Unauthorized);
        }
    } else if is_verification(&kind) {
        if request.status != Status::Review {
            return Err(ContractError::InvalidStatusTransition);
        }
        if info.sender != config.verifier {
            return Err(ContractError::Unauthorized);
        }
    } else {
        return Err(ContractError::InvalidEvidence);
    }

    let id = NEXT_EVIDENCE_ID.load(deps.storage, request_id)?;
    if id == 0 || id > u64::from(request.limits.max_evidence_items) {
        return Err(ContractError::InvalidEvidence);
    }
    let next_id = id.checked_add(1).ok_or(ContractError::EvidenceIdOverflow)?;
    if EVIDENCE.may_load(deps.storage, (request_id, id))?.is_some() {
        return Err(ContractError::AuditInvariant);
    }
    let action_id = NEXT_REQUEST_ACTION_ID.load(deps.storage, request_id)?;
    let next_action_id = action_id
        .checked_add(1)
        .ok_or(ContractError::RequestActionIdOverflow)?;
    if REQUEST_ACTIONS
        .may_load(deps.storage, (request_id, action_id))?
        .is_some()
    {
        return Err(ContractError::AuditInvariant);
    }
    let evidence = Evidence {
        id,
        request_id,
        submitter: info.sender.clone(),
        kind: kind.clone(),
        uri,
        digest,
        note,
        work_round: request.work_round,
        submitted_at: env.block.time,
        submitted_height: env.block.height,
    };
    let action = RequestActionRecord {
        id: action_id,
        request_id,
        actor: info.sender,
        action: RequestAction::EvidenceAdded { evidence_id: id },
        reason: None,
        height: env.block.height,
        timestamp: env.block.time,
    };
    if is_delivery(&kind) {
        request.work_activity_height = Some(env.block.height);
    }
    request.updated_at = env.block.time;
    REQUESTS.save(deps.storage, request_id, &request)?;
    EVIDENCE.save(deps.storage, (request_id, id), &evidence)?;
    REQUEST_ACTIONS.save(deps.storage, (request_id, action_id), &action)?;
    NEXT_EVIDENCE_ID.save(deps.storage, request_id, &next_id)?;
    NEXT_REQUEST_ACTION_ID.save(deps.storage, request_id, &next_action_id)?;
    Ok(Response::new()
        .add_attribute("action", "add_evidence")
        .add_attribute("request_id", request_id.to_string())
        .add_attribute("evidence_id", id.to_string()))
}

pub fn request_review(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    reason: String,
    evidence_ids: Vec<u64>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let reason = validate_reason(reason, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    validate_work(&request, &config.verifier)?;
    if request.status != Status::Building
        || !allowed(
            Transition::RequestReview,
            &request.status,
            &Status::Review,
            Controller::Builder,
        )
    {
        return Err(ContractError::InvalidStatusTransition);
    }
    let builder = request
        .builder
        .clone()
        .ok_or(ContractError::InvalidBuilder)?;
    if info.sender != builder {
        return Err(ContractError::Unauthorized);
    }
    validate_refs_len(&evidence_ids, request.limits.max_review_evidence_refs)?;
    for id in &evidence_ids {
        let item = EVIDENCE
            .may_load(deps.storage, (request_id, *id))?
            .ok_or(ContractError::InvalidEvidenceReferences)?;
        if item.request_id != request_id
            || item.work_round != request.work_round
            || !is_delivery(&item.kind)
            || item.submitter != builder
        {
            return Err(ContractError::InvalidEvidenceReferences);
        }
    }
    let from = request.status.clone();
    request.status = Status::Review;
    request.updated_at = env.block.time;
    persist_transition(
        deps.storage,
        &env,
        TransitionWrite {
            request,
            from: from.clone(),
            actor: info.sender,
            reason: Some(reason),
            actions: vec![
                RequestAction::ReviewRequested {
                    evidence_ids: evidence_ids.clone(),
                },
                RequestAction::StatusTransition {
                    from,
                    to: Status::Review,
                },
            ],
            bond_totals: None,
            duplicate_reference: None,
            evidence_ids,
            shipment_attestation: None,
        },
        "request_review",
    )
}

pub fn attest(
    deps: DepsMut<JunoQuery>,
    env: Env,
    info: MessageInfo,
    request_id: u64,
    rationale: String,
    evidence_ids: Vec<u64>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.verifier {
        return Err(ContractError::Unauthorized);
    }
    let rationale = validate_reason(rationale, config.max_reason_bytes)?;
    let mut request = load_request(deps.storage, request_id)?;
    validate_work(&request, &config.verifier)?;
    if request.status != Status::Review
        || !allowed(
            Transition::AttestShipment,
            &request.status,
            &Status::Shipped,
            Controller::Verifier,
        )
    {
        return Err(ContractError::InvalidStatusTransition);
    }
    validate_refs_len(&evidence_ids, request.limits.max_attestation_evidence_refs)?;
    if SHIPMENT_ATTESTATIONS
        .may_load(deps.storage, request_id)?
        .is_some()
    {
        return Err(ContractError::AttestationExists);
    }
    let builder = request
        .builder
        .clone()
        .ok_or(ContractError::InvalidBuilder)?;
    let mut delivery = None;
    let mut verification = None;
    for id in &evidence_ids {
        let item = EVIDENCE
            .may_load(deps.storage, (request_id, *id))?
            .ok_or(ContractError::InvalidEvidenceReferences)?;
        if item.request_id != request_id || item.work_round != request.work_round {
            return Err(ContractError::InvalidEvidenceReferences);
        }
        if is_delivery(&item.kind) && item.submitter == builder {
            delivery = Some(*id);
        }
        if is_verification(&item.kind) && item.submitter == config.verifier {
            verification = Some(*id);
        }
    }
    if delivery.is_none() || verification.is_none() || delivery == verification {
        return Err(ContractError::InvalidEvidenceReferences);
    }
    let attestation = ShipmentAttestation {
        verifier: info.sender.clone(),
        rationale: rationale.clone(),
        evidence_ids: evidence_ids.clone(),
        work_round: request.work_round,
        submitted_at: env.block.time,
        submitted_height: env.block.height,
    };
    let from = request.status.clone();
    request.status = Status::Shipped;
    request.updated_at = env.block.time;
    persist_transition(
        deps.storage,
        &env,
        TransitionWrite {
            request,
            from: from.clone(),
            actor: info.sender,
            reason: Some(rationale),
            actions: vec![
                RequestAction::ShipmentAttested {
                    evidence_ids: evidence_ids.clone(),
                },
                RequestAction::StatusTransition {
                    from,
                    to: Status::Shipped,
                },
            ],
            bond_totals: None,
            duplicate_reference: None,
            evidence_ids,
            shipment_attestation: Some(attestation),
        },
        "attest_shipment",
    )
}

fn load_request(
    storage: &dyn cosmwasm_std::Storage,
    request_id: u64,
) -> Result<Request, ContractError> {
    REQUESTS
        .may_load(storage, request_id)?
        .ok_or(ContractError::UnknownRequest { request_id })
}
fn validate_work(request: &Request, verifier: &cosmwasm_std::Addr) -> Result<(), ContractError> {
    let builder = request
        .builder
        .as_ref()
        .ok_or(ContractError::InvalidBuilder)?;
    if builder == verifier {
        return Err(ContractError::InvalidBuilder);
    }
    if request.work_round == 0 || request.work_activity_height.is_none() {
        return Err(ContractError::MissingWorkActivity);
    }
    Ok(())
}
fn validate_refs_len(ids: &[u64], max: u8) -> Result<(), ContractError> {
    if ids.is_empty() || ids.len() > usize::from(max) {
        return Err(ContractError::InvalidEvidenceReferences);
    }
    let unique: BTreeSet<_> = ids.iter().collect();
    if unique.len() != ids.len() {
        return Err(ContractError::InvalidEvidenceReferences);
    }
    Ok(())
}
fn valid_uri(uri: &str) -> bool {
    uri.strip_prefix("https://").is_some_and(|x| !x.is_empty())
        || uri.strip_prefix("ipfs://").is_some_and(|x| !x.is_empty())
}
fn valid_digest(digest: &str) -> bool {
    let Some(hex) = digest.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
