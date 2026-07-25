use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

use crate::state::{
    BondTotals, Config, Evidence, EvidenceKind, ProtocolActionRecord, Request, RequestActionRecord,
    RequestLimits, ShipmentAttestation, StatusHistoryRecord, VoteReceipt,
};

#[cw_serde]
pub struct InstantiateMsg {
    pub governor: String,
    pub steward: String,
    pub verifier: String,
    pub native_denom: String,
    pub submission_bond: Uint128,
    pub voting_period_blocks: u64,
    pub quorum_bps: u16,
    pub support_bps: u16,
    pub work_inactivity_blocks: u64,
    pub request_limits: RequestLimits,
    pub max_reason_bytes: u16,
    pub default_query_limit: u8,
    pub max_query_limit: u8,
    pub evidence_policy_version: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    SubmitRequest {
        title: String,
        summary: String,
        acceptance_criteria: String,
        category: String,
        detail_uri: Option<String>,
        detail_digest: Option<String>,
    },
    CastVote {
        request_id: u64,
        choice: crate::state::VoteChoice,
    },
    CloseRequest {
        request_id: u64,
    },
    MarkSpam {
        request_id: u64,
        reason: String,
    },
    MarkDuplicate {
        request_id: u64,
        canonical_request_id: u64,
        reason: String,
    },
    ArchiveRequest {
        request_id: u64,
        reason: String,
    },
    StartBuilding {
        request_id: u64,
        builder: String,
        reason: String,
    },
    BlockBuilding {
        request_id: u64,
        reason: String,
    },
    ResumeBuilding {
        request_id: u64,
        builder: String,
        reason: String,
    },
    RejectReview {
        request_id: u64,
        reason: String,
    },
    BlockReview {
        request_id: u64,
        reason: String,
    },
    AddEvidence {
        request_id: u64,
        kind: EvidenceKind,
        uri: String,
        digest: String,
        note: String,
    },
    RequestReview {
        request_id: u64,
        reason: String,
        evidence_ids: Vec<u64>,
    },
    AttestShipment {
        request_id: u64,
        rationale: String,
        evidence_ids: Vec<u64>,
    },
    WithdrawRefund {
        request_id: u64,
    },
    ProposeGovernor {
        address: String,
        reason: String,
    },
    CancelGovernorTransfer {
        reason: String,
    },
    AcceptGovernor {
        reason: String,
    },
}

/// Canonical direct-RPC queries. List pages are bounded and weakly consistent while
/// mutable state changes; clients should refresh page one for a current view.
#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(BondTotalsResponse)]
    BondTotals {},
    #[returns(RequestResponse)]
    Request { id: u64 },
    #[returns(ShipmentAttestationResponse)]
    ShipmentAttestation { request_id: u64 },
    #[returns(RequestsResponse)]
    Requests {
        status: Option<u8>,
        category: Option<String>,
        author: Option<String>,
        start_after_id: Option<u64>,
        limit: Option<u8>,
    },
    #[returns(VoteResponse)]
    Vote { request_id: u64, voter: String },
    #[returns(VotesResponse)]
    Votes {
        request_id: u64,
        start_after_voter: Option<String>,
        limit: Option<u8>,
    },
    #[returns(EvidenceResponse)]
    Evidence {
        request_id: u64,
        start_after_id: Option<u64>,
        limit: Option<u8>,
    },
    #[returns(StatusHistoryResponse)]
    StatusHistory {
        request_id: u64,
        start_after_id: Option<u64>,
        limit: Option<u8>,
    },
    #[returns(RequestActionsResponse)]
    RequestActions {
        request_id: u64,
        start_after_id: Option<u64>,
        limit: Option<u8>,
    },
    #[returns(ProtocolActionsResponse)]
    ProtocolActions {
        start_after_id: Option<u64>,
        limit: Option<u8>,
    },
    #[returns(RankedRequestsResponse)]
    RankedRequests {
        status: u8,
        category: Option<String>,
        cursor: Option<String>,
        limit: Option<u8>,
    },
}

#[cw_serde]
pub struct ConfigResponse {
    pub config: Config,
}

#[cw_serde]
pub struct BondTotalsResponse {
    pub totals: BondTotals,
}

#[cw_serde]
pub struct RequestResponse {
    pub request: Request,
}

#[cw_serde]
pub struct ShipmentAttestationResponse {
    pub attestation: Option<ShipmentAttestation>,
}

/// A bounded ascending-ID page. Pagination is weakly consistent for mutable state;
/// refresh page one to obtain a current view.
#[cw_serde]
pub struct RequestsResponse {
    pub items: Vec<Request>,
    pub next_start_after: Option<u64>,
    pub query_height: u64,
}

#[cw_serde]
pub struct VoteResponse {
    pub vote: Option<VoteReceipt>,
}

/// A bounded ascending canonical-address page with weakly consistent pagination;
/// refresh page one to obtain a current view.
#[cw_serde]
pub struct VotesResponse {
    pub items: Vec<VoteReceipt>,
    pub next_start_after: Option<String>,
    pub query_height: u64,
}

/// A bounded ascending evidence-ID page. Pagination is weakly consistent while
/// evidence is appended; refresh page one to obtain a current view.
#[cw_serde]
pub struct EvidenceResponse {
    pub items: Vec<Evidence>,
    pub next_start_after: Option<u64>,
    pub query_height: u64,
}

/// A bounded ascending status-history-ID page. Pagination is weakly consistent while
/// transitions are appended; refresh page one to obtain a current view.
#[cw_serde]
pub struct StatusHistoryResponse {
    pub items: Vec<StatusHistoryRecord>,
    pub next_start_after: Option<u64>,
    pub query_height: u64,
}

/// A bounded ascending request-action-ID page. Pagination is weakly consistent while
/// actions are appended; refresh page one to obtain a current view.
#[cw_serde]
pub struct RequestActionsResponse {
    pub items: Vec<RequestActionRecord>,
    pub next_start_after: Option<u64>,
    pub query_height: u64,
}

/// A bounded ascending protocol-action-ID page. Pagination is weakly consistent while
/// actions are appended; refresh page one to obtain a current view.
#[cw_serde]
pub struct ProtocolActionsResponse {
    pub items: Vec<ProtocolActionRecord>,
    pub next_start_after: Option<u64>,
    pub query_height: u64,
}

/// A bounded canonical-rank page. It is weakly consistent while votes or statuses
/// change; refresh page one for a current view.
#[cw_serde]
pub struct RankedRequestsResponse {
    pub items: Vec<Request>,
    pub next_cursor: Option<String>,
    pub query_height: u64,
}
