use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cosmwasm_std::{to_json_binary, Binary, Deps, Env, Order, StdError, StdResult};
use cw_storage_plus::Bound;

use crate::bindings::JunoQuery;
use crate::msg::{
    BondTotalsResponse, ConfigResponse, EvidenceResponse, ProtocolActionsResponse, QueryMsg,
    RankedRequestsResponse, RequestActionsResponse, RequestResponse, RequestsResponse,
    ShipmentAttestationResponse, StatusHistoryResponse, VoteResponse, VotesResponse,
};
use crate::rank::{rank_key, RANK_KEY_LEN};
use crate::state::{
    BOND_TOTALS, CONFIG, EVIDENCE, PROTOCOL_ACTIONS, REQUESTS, REQUESTS_BY_AUTHOR,
    REQUESTS_BY_CATEGORY, REQUESTS_BY_STATUS, REQUEST_ACTIONS, SHIPMENT_ATTESTATIONS,
    STATUS_CATEGORY_RANK, STATUS_HISTORY, STATUS_RANK, VOTES,
};

pub const CURSOR_VERSION: u8 = 1;
pub const CURSOR_SCHEMA_VERSION: u16 = 1;
pub const MAX_CURSOR_DECODED_LEN: usize = 5 + 255 + RANK_KEY_LEN;
pub const MAX_CURSOR_ENCODED_LEN: usize = MAX_CURSOR_DECODED_LEN.div_ceil(3) * 4 - 1;
const RANK_KEY_VERSION: u8 = 1;

pub(crate) fn dispatch(deps: Deps<JunoQuery>, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&ConfigResponse {
            config: CONFIG.load(deps.storage)?,
        }),
        QueryMsg::BondTotals {} => to_json_binary(&BondTotalsResponse {
            totals: BOND_TOTALS.load(deps.storage)?,
        }),
        QueryMsg::Request { id } => {
            let request = REQUESTS.load(deps.storage, id)?;
            if request.id != id {
                return Err(StdError::generic_err(
                    "request key is inconsistent with record",
                ));
            }
            to_json_binary(&RequestResponse { request })
        }
        QueryMsg::ShipmentAttestation { request_id } => {
            to_json_binary(&ShipmentAttestationResponse {
                attestation: SHIPMENT_ATTESTATIONS.may_load(deps.storage, request_id)?,
            })
        }
        QueryMsg::Vote { request_id, voter } => {
            let voter = deps.api.addr_validate(&voter)?;
            let vote = VOTES.may_load(deps.storage, (request_id, &voter))?;
            if vote
                .as_ref()
                .is_some_and(|receipt| receipt.request_id != request_id || receipt.voter != voter)
            {
                return Err(StdError::generic_err(
                    "vote key is inconsistent with receipt",
                ));
            }
            to_json_binary(&VoteResponse { vote })
        }
        QueryMsg::Requests {
            status,
            category,
            author,
            start_after_id,
            limit,
        } => to_json_binary(&requests(
            deps,
            env.block.height,
            status,
            category,
            author,
            start_after_id,
            limit,
        )?),
        QueryMsg::RankedRequests {
            status,
            category,
            cursor,
            limit,
        } => to_json_binary(&ranked_requests(
            deps,
            env.block.height,
            status,
            category,
            cursor,
            limit,
        )?),
        QueryMsg::Votes {
            request_id,
            start_after_voter,
            limit,
        } => to_json_binary(&votes(
            deps,
            env.block.height,
            request_id,
            start_after_voter,
            limit,
        )?),
        QueryMsg::Evidence {
            request_id,
            start_after_id,
            limit,
        } => to_json_binary(&evidence(
            deps,
            env.block.height,
            request_id,
            start_after_id,
            limit,
        )?),
        QueryMsg::StatusHistory {
            request_id,
            start_after_id,
            limit,
        } => to_json_binary(&status_history(
            deps,
            env.block.height,
            request_id,
            start_after_id,
            limit,
        )?),
        QueryMsg::RequestActions {
            request_id,
            start_after_id,
            limit,
        } => to_json_binary(&request_actions(
            deps,
            env.block.height,
            request_id,
            start_after_id,
            limit,
        )?),
        QueryMsg::ProtocolActions {
            start_after_id,
            limit,
        } => to_json_binary(&protocol_actions(
            deps,
            env.block.height,
            start_after_id,
            limit,
        )?),
    }
}

fn votes(
    deps: Deps<JunoQuery>,
    query_height: u64,
    request_id: u64,
    start_after_voter: Option<String>,
    requested_limit: Option<u8>,
) -> StdResult<VotesResponse> {
    let start = start_after_voter
        .as_deref()
        .map(|voter| deps.api.addr_validate(voter))
        .transpose()?;
    let limit = page_limit(deps, requested_limit)?;
    let mut entries = VOTES
        .prefix(request_id)
        .range(
            deps.storage,
            start.as_ref().map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit + 1)
        .collect::<StdResult<Vec<_>>>()?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    for (voter, receipt) in &entries {
        if receipt.request_id != request_id || receipt.voter != voter {
            return Err(StdError::generic_err(
                "vote key is inconsistent with receipt",
            ));
        }
    }
    let next_start_after = has_more
        .then(|| entries.last().map(|(voter, _)| voter.to_string()))
        .flatten();
    Ok(VotesResponse {
        items: entries.into_iter().map(|(_, receipt)| receipt).collect(),
        next_start_after,
        query_height,
    })
}

fn evidence(
    deps: Deps<JunoQuery>,
    query_height: u64,
    request_id: u64,
    start_after_id: Option<u64>,
    requested_limit: Option<u8>,
) -> StdResult<EvidenceResponse> {
    let limit = page_limit(deps, requested_limit)?;
    let mut entries = EVIDENCE
        .prefix(request_id)
        .range(
            deps.storage,
            start_after_id.map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit + 1)
        .collect::<StdResult<Vec<_>>>()?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    for (id, item) in &entries {
        if item.id != *id || item.request_id != request_id {
            return Err(StdError::generic_err(
                "evidence key is inconsistent with record",
            ));
        }
    }
    Ok(EvidenceResponse {
        next_start_after: next_id(&entries, has_more),
        items: entries.into_iter().map(|(_, item)| item).collect(),
        query_height,
    })
}

fn status_history(
    deps: Deps<JunoQuery>,
    query_height: u64,
    request_id: u64,
    start_after_id: Option<u64>,
    requested_limit: Option<u8>,
) -> StdResult<StatusHistoryResponse> {
    let limit = page_limit(deps, requested_limit)?;
    let mut entries = STATUS_HISTORY
        .prefix(request_id)
        .range(
            deps.storage,
            start_after_id.map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit + 1)
        .collect::<StdResult<Vec<_>>>()?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    for (id, item) in &entries {
        if item.id != *id || item.request_id != request_id {
            return Err(StdError::generic_err(
                "status-history key is inconsistent with record",
            ));
        }
    }
    Ok(StatusHistoryResponse {
        next_start_after: next_id(&entries, has_more),
        items: entries.into_iter().map(|(_, item)| item).collect(),
        query_height,
    })
}

fn request_actions(
    deps: Deps<JunoQuery>,
    query_height: u64,
    request_id: u64,
    start_after_id: Option<u64>,
    requested_limit: Option<u8>,
) -> StdResult<RequestActionsResponse> {
    let limit = page_limit(deps, requested_limit)?;
    let mut entries = REQUEST_ACTIONS
        .prefix(request_id)
        .range(
            deps.storage,
            start_after_id.map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit + 1)
        .collect::<StdResult<Vec<_>>>()?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    for (id, item) in &entries {
        if item.id != *id || item.request_id != request_id {
            return Err(StdError::generic_err(
                "request-action key is inconsistent with record",
            ));
        }
    }
    Ok(RequestActionsResponse {
        next_start_after: next_id(&entries, has_more),
        items: entries.into_iter().map(|(_, item)| item).collect(),
        query_height,
    })
}

fn protocol_actions(
    deps: Deps<JunoQuery>,
    query_height: u64,
    start_after_id: Option<u64>,
    requested_limit: Option<u8>,
) -> StdResult<ProtocolActionsResponse> {
    let limit = page_limit(deps, requested_limit)?;
    let mut entries = PROTOCOL_ACTIONS
        .range(
            deps.storage,
            start_after_id.map(Bound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit + 1)
        .collect::<StdResult<Vec<_>>>()?;
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    for (id, item) in &entries {
        if item.id != *id {
            return Err(StdError::generic_err(
                "protocol-action key is inconsistent with record",
            ));
        }
    }
    Ok(ProtocolActionsResponse {
        next_start_after: next_id(&entries, has_more),
        items: entries.into_iter().map(|(_, item)| item).collect(),
        query_height,
    })
}

fn next_id<T>(entries: &[(u64, T)], has_more: bool) -> Option<u64> {
    has_more
        .then(|| entries.last().map(|(id, _)| *id))
        .flatten()
}

#[derive(Clone, Copy)]
enum RequestSource {
    Primary,
    Status,
    Category,
    Author,
}

fn page_limit(deps: Deps<JunoQuery>, requested: Option<u8>) -> StdResult<usize> {
    let config = CONFIG.load(deps.storage)?;
    let limit = requested.unwrap_or(config.default_query_limit);
    if limit == 0 || limit > config.max_query_limit {
        return Err(StdError::generic_err(format!(
            "limit must be between 1 and {}",
            config.max_query_limit
        )));
    }
    Ok(usize::from(limit))
}

fn validate_status(status: u8) -> StdResult<()> {
    if (1..=10).contains(&status) {
        Ok(())
    } else {
        Err(StdError::generic_err("status must be between 1 and 10"))
    }
}

#[allow(clippy::too_many_arguments)]
fn requests(
    deps: Deps<JunoQuery>,
    query_height: u64,
    status: Option<u8>,
    category: Option<String>,
    author: Option<String>,
    start_after_id: Option<u64>,
    requested_limit: Option<u8>,
) -> StdResult<RequestsResponse> {
    if let Some(status) = status {
        validate_status(status)?;
    }
    let author = author
        .as_deref()
        .map(|value| deps.api.addr_validate(value))
        .transpose()?;
    let limit = page_limit(deps, requested_limit)?;
    let start = start_after_id.map(Bound::exclusive);
    let take = limit + 1;

    let (source, mut candidates): (RequestSource, Vec<u64>) = if let Some(status) = status {
        (
            RequestSource::Status,
            REQUESTS_BY_STATUS
                .prefix(status)
                .range(deps.storage, start, None, Order::Ascending)
                .take(take)
                .map(|entry| entry.map(|(id, ())| id))
                .collect::<StdResult<_>>()?,
        )
    } else if let Some(category) = category.as_deref() {
        (
            RequestSource::Category,
            REQUESTS_BY_CATEGORY
                .prefix(category)
                .range(deps.storage, start, None, Order::Ascending)
                .take(take)
                .map(|entry| entry.map(|(id, ())| id))
                .collect::<StdResult<_>>()?,
        )
    } else if let Some(author) = author.as_ref() {
        (
            RequestSource::Author,
            REQUESTS_BY_AUTHOR
                .prefix(author)
                .range(deps.storage, start, None, Order::Ascending)
                .take(take)
                .map(|entry| entry.map(|(id, ())| id))
                .collect::<StdResult<_>>()?,
        )
    } else {
        (
            RequestSource::Primary,
            REQUESTS
                .range(deps.storage, start, None, Order::Ascending)
                .take(take)
                .map(|entry| entry.map(|(id, _)| id))
                .collect::<StdResult<_>>()?,
        )
    };

    let has_more = candidates.len() > limit;
    candidates.truncate(limit);
    let last_examined = candidates.last().copied();
    let mut items = Vec::with_capacity(candidates.len());
    for id in candidates {
        let request = REQUESTS.may_load(deps.storage, id)?.ok_or_else(|| {
            StdError::generic_err(format!("request index points to missing request {id}"))
        })?;
        let source_consistent = match source {
            RequestSource::Primary => request.id == id,
            RequestSource::Status => status == Some(request.status.code()),
            RequestSource::Category => category.as_deref() == Some(request.category.as_str()),
            RequestSource::Author => author.as_ref() == Some(&request.author),
        };
        if !source_consistent || request.id != id {
            return Err(StdError::generic_err(format!(
                "request index is inconsistent for request {id}"
            )));
        }
        validate_request_indexes(deps, &request)?;
        if status.is_none_or(|value| value == request.status.code())
            && category
                .as_deref()
                .is_none_or(|value| value == request.category)
            && author.as_ref().is_none_or(|value| value == request.author)
        {
            items.push(request);
        }
    }

    Ok(RequestsResponse {
        items,
        next_start_after: has_more.then_some(last_examined).flatten(),
        query_height,
    })
}

fn validate_request_indexes(
    deps: Deps<JunoQuery>,
    request: &crate::state::Request,
) -> StdResult<()> {
    let status = REQUESTS_BY_STATUS.may_load(deps.storage, (request.status.code(), request.id))?;
    let category =
        REQUESTS_BY_CATEGORY.may_load(deps.storage, (request.category.as_str(), request.id))?;
    let author = REQUESTS_BY_AUTHOR.may_load(deps.storage, (&request.author, request.id))?;
    if status.is_none() || category.is_none() || author.is_none() {
        return Err(StdError::generic_err(format!(
            "request indexes are incomplete for request {}",
            request.id
        )));
    }
    Ok(())
}

fn encode_cursor(status: u8, category: Option<&str>, rank_key: &[u8]) -> StdResult<String> {
    validate_status(status)?;
    if rank_key.len() != RANK_KEY_LEN || rank_key.first() != Some(&RANK_KEY_VERSION) {
        return Err(StdError::generic_err("invalid rank key"));
    }
    let category = category.unwrap_or_default().as_bytes();
    let category_len = u8::try_from(category.len())
        .map_err(|_| StdError::generic_err("cursor category is longer than 255 bytes"))?;
    let mut bytes = Vec::with_capacity(5 + category.len() + RANK_KEY_LEN);
    bytes.push(CURSOR_VERSION);
    bytes.extend_from_slice(&CURSOR_SCHEMA_VERSION.to_be_bytes());
    bytes.push(status);
    bytes.push(category_len);
    bytes.extend_from_slice(category);
    bytes.extend_from_slice(rank_key);
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_cursor(cursor: &str, status: u8, category: Option<&str>) -> StdResult<Vec<u8>> {
    if cursor.len() > MAX_CURSOR_ENCODED_LEN {
        return Err(StdError::generic_err("cursor exceeds 403 bytes"));
    }
    if cursor.contains('=') {
        return Err(StdError::generic_err("cursor padding is not accepted"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| StdError::generic_err("malformed cursor base64"))?;
    if bytes.len() < 5 + RANK_KEY_LEN {
        return Err(StdError::generic_err("malformed cursor length"));
    }
    if bytes[0] != CURSOR_VERSION {
        return Err(StdError::generic_err("unsupported cursor version"));
    }
    if u16::from_be_bytes([bytes[1], bytes[2]]) != CURSOR_SCHEMA_VERSION {
        return Err(StdError::generic_err("unsupported cursor schema version"));
    }
    validate_status(bytes[3])?;
    let category_len = usize::from(bytes[4]);
    let expected_len = 5 + category_len + RANK_KEY_LEN;
    if bytes.len() != expected_len {
        return Err(StdError::generic_err("malformed cursor length"));
    }
    let cursor_category = std::str::from_utf8(&bytes[5..5 + category_len])
        .map_err(|_| StdError::generic_err("cursor category is not valid UTF-8"))?;
    let cursor_category = if category_len == 0 {
        None
    } else {
        Some(cursor_category)
    };
    if bytes[3] != status || cursor_category != category {
        return Err(StdError::generic_err(
            "cursor does not match status/category filters",
        ));
    }
    let key = bytes[5 + category_len..].to_vec();
    if key.len() != RANK_KEY_LEN || key.first() != Some(&RANK_KEY_VERSION) {
        return Err(StdError::generic_err("invalid cursor rank key"));
    }
    Ok(key)
}

fn ranked_requests(
    deps: Deps<JunoQuery>,
    query_height: u64,
    status: u8,
    category: Option<String>,
    cursor: Option<String>,
    requested_limit: Option<u8>,
) -> StdResult<RankedRequestsResponse> {
    validate_status(status)?;
    if category.as_deref() == Some("") {
        return Err(StdError::generic_err("ranked category must not be empty"));
    }
    if category.as_ref().is_some_and(|value| value.len() > 255) {
        return Err(StdError::generic_err(
            "ranked category is longer than 255 bytes",
        ));
    }
    let limit = page_limit(deps, requested_limit)?;
    let cursor_key = cursor
        .as_deref()
        .map(|value| decode_cursor(value, status, category.as_deref()))
        .transpose()?;
    let max = cursor_key.map(Bound::exclusive);
    let take = limit + 1;
    let mut entries: Vec<(Vec<u8>, u64)> = if let Some(category) = category.as_deref() {
        STATUS_CATEGORY_RANK
            .prefix((status, category))
            .range(deps.storage, None, max, Order::Descending)
            .take(take)
            .collect::<StdResult<_>>()?
    } else {
        STATUS_RANK
            .prefix(status)
            .range(deps.storage, None, max, Order::Descending)
            .take(take)
            .collect::<StdResult<_>>()?
    };
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let last_key = entries.last().map(|(key, _)| key.clone());
    let mut items = Vec::with_capacity(entries.len());
    for (key, id) in entries {
        let request = REQUESTS.may_load(deps.storage, id)?.ok_or_else(|| {
            StdError::generic_err(format!("rank index points to missing request {id}"))
        })?;
        if request.id != id
            || request.status.code() != status
            || category
                .as_deref()
                .is_some_and(|value| value != request.category)
            || rank_key(request.support_power, request.oppose_power, request.id) != key
        {
            return Err(StdError::generic_err(format!(
                "rank index is inconsistent for request {id}"
            )));
        }
        validate_request_indexes(deps, &request)?;
        let status_rank = STATUS_RANK.may_load(deps.storage, (status, key.clone()))?;
        let category_rank = STATUS_CATEGORY_RANK.may_load(
            deps.storage,
            (status, request.category.as_str(), key.clone()),
        )?;
        if status_rank != Some(id) || category_rank != Some(id) {
            return Err(StdError::generic_err(format!(
                "rank indexes are incomplete for request {id}"
            )));
        }
        items.push(request);
    }
    let next_cursor = if has_more {
        last_key
            .as_deref()
            .map(|key| encode_cursor(status, category.as_deref(), key))
            .transpose()?
    } else {
        None
    };
    Ok(RankedRequestsResponse {
        items,
        next_cursor,
        query_height,
    })
}
