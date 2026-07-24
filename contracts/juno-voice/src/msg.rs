use cosmwasm_schema::cw_serde;
use cosmwasm_std::Uint128;

use crate::state::RequestLimits;

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
