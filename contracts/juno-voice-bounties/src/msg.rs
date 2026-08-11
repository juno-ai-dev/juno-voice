use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Timestamp, Uint128};

use crate::state::{
    Accounting, Bounty, ClaimRecord, Config, ContributionView, GraduationRecord, HistoryEntry,
    ModerationRecord, PauseState, Round, VoteReceipt,
};

pub type ConfigResponse = Config;
pub type PauseResponse = PauseState;

#[cw_serde]
pub struct Limits {
    pub max_title_bytes: u32,
    pub max_summary_bytes: u32,
    pub max_acceptance_criteria_bytes: u32,
    pub max_uri_bytes: u32,
    pub max_rationale_bytes: u32,
    pub max_reason_bytes: u32,
    pub max_page_limit: u32,
}

#[cw_serde]
pub struct InstantiateMsg {
    pub native_denom: String,
    pub governor: String,
    pub agent: String,
    pub registry: String,
    pub min_contribution: Uint128,
    pub max_bounty_total: Uint128,
    pub min_lifetime_seconds: u64,
    pub max_lifetime_seconds: u64,
    pub max_contributors: u32,
    pub max_rounds: u32,
    pub limits: Limits,
}

#[cw_serde]
pub struct ProjectCandidate {
    pub project_id: String,
    pub metadata_uri: String,
    pub metadata_digest: String,
}

#[cw_serde]
pub enum PayoutVote {
    Yes,
    No,
}

#[cw_serde]
pub enum ModerationOutcome {
    Spam,
    Duplicate,
    PolicyViolation,
}

#[cw_serde]
pub struct ConfigUpdate {
    pub min_contribution: Option<Uint128>,
    pub max_bounty_total: Option<Uint128>,
    pub min_lifetime_seconds: Option<u64>,
    pub max_lifetime_seconds: Option<u64>,
    pub max_contributors: Option<u32>,
    pub max_rounds: Option<u32>,
    pub limits: Option<Limits>,
}

#[cw_serde]
pub enum ExecuteMsg {
    CreateBounty {
        title: String,
        summary: String,
        acceptance_criteria: String,
        content_uri: Option<String>,
        content_digest: Option<String>,
        expires_at: Timestamp,
        project_candidate: Option<ProjectCandidate>,
    },
    Contribute {
        bounty_id: u64,
    },
    NominatePayout {
        bounty_id: u64,
        recipient: String,
        evidence_uri: String,
        evidence_digest: String,
        rationale: String,
    },
    ConfirmSolePayout {
        bounty_id: u64,
        round: u32,
    },
    DeclineSolePayout {
        bounty_id: u64,
        round: u32,
        reason: String,
    },
    VotePayout {
        bounty_id: u64,
        round: u32,
        vote: PayoutVote,
        rationale: Option<String>,
    },
    FinalizePayout {
        bounty_id: u64,
        round: u32,
    },
    CancelSoleFunded {
        bounty_id: u64,
        reason: String,
    },
    Expire {
        bounty_id: u64,
    },
    ClaimRefund {
        bounty_id: u64,
    },
    Moderate {
        bounty_id: u64,
        outcome: ModerationOutcome,
        reason: String,
    },
    GraduateProject {
        bounty_id: u64,
    },
    PauseNewActivity {
        reason: String,
    },
    UnpauseNewActivity {
        reason: String,
    },
    UpdateRoles {
        governor: Option<String>,
        agent: Option<String>,
        registry: Option<String>,
    },
    UpdateConfig {
        update: ConfigUpdate,
    },
}

#[cw_serde]
pub struct BountyResponse {
    pub bounty: Bounty,
    pub active_round: Option<Round>,
    pub moderation: Option<ModerationRecord>,
    pub graduation: Option<GraduationRecord>,
}

#[cw_serde]
pub struct BountiesResponse {
    pub bounties: Vec<Bounty>,
}

#[cw_serde]
pub struct ContributionsResponse {
    pub contributions: Vec<ContributionView>,
}

#[cw_serde]
pub struct RoundsResponse {
    pub rounds: Vec<Round>,
}

#[cw_serde]
pub struct ReceiptsResponse {
    pub receipts: Vec<VoteReceipt>,
}

#[cw_serde]
pub struct ClaimsResponse {
    pub claims: Vec<ClaimRecord>,
    /// Last scanned contributor index when another bounded page remains.
    /// Contributors without a completed claim can create holes in a page.
    pub next_start_after: Option<u32>,
}

#[cw_serde]
pub struct HistoryResponse {
    pub entries: Vec<HistoryEntry>,
}

#[cw_serde]
pub struct AuthoritiesResponse {
    pub governor: Addr,
    pub agent: Addr,
    pub registry: Addr,
}

#[cw_serde]
pub struct HealthResponse {
    pub accounting: Accounting,
    pub actual_native_balance: Uint128,
    pub liabilities: Uint128,
    pub fully_backed: bool,
}

#[cw_serde]
pub enum ErrorCode {
    Unauthorized,
    UnexpectedFunds,
    InvalidFunds,
    InvalidConfiguration,
    InvalidMetadata,
    NotFound,
    InvalidState,
    Paused,
    Expired,
    NotExpired,
    ContributionLimit,
    RoundLimit,
    WrongRound,
    NotContributor,
    VotingClosed,
    RatificationOpen,
    AlreadyClaimed,
    NotRefundable,
    NotProjectCandidate,
    AlreadyGraduated,
    Arithmetic,
}

#[cw_serde]
pub struct ErrorCatalogResponse {
    pub codes: Vec<ErrorCode>,
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(PauseResponse)]
    Pause {},
    #[returns(AuthoritiesResponse)]
    Authorities {},
    #[returns(Accounting)]
    Accounting {},
    #[returns(HealthResponse)]
    Health {},
    #[returns(BountyResponse)]
    Bounty { bounty_id: u64 },
    #[returns(BountiesResponse)]
    Bounties {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    #[returns(ContributionView)]
    Contribution {
        bounty_id: u64,
        contributor: String,
        round: Option<u32>,
    },
    #[returns(ContributionsResponse)]
    Contributions {
        bounty_id: u64,
        start_after: Option<u32>,
        limit: Option<u32>,
    },
    #[returns(Round)]
    Round { bounty_id: u64, round: u32 },
    #[returns(RoundsResponse)]
    Rounds {
        bounty_id: u64,
        start_after: Option<u32>,
        limit: Option<u32>,
    },
    #[returns(Option<VoteReceipt>)]
    Receipt {
        bounty_id: u64,
        round: u32,
        voter: String,
    },
    #[returns(ReceiptsResponse)]
    Receipts {
        bounty_id: u64,
        round: u32,
        start_after: Option<u32>,
        limit: Option<u32>,
    },
    #[returns(Option<ClaimRecord>)]
    Claim { bounty_id: u64, contributor: String },
    #[returns(ClaimsResponse)]
    Claims {
        bounty_id: u64,
        start_after: Option<u32>,
        limit: Option<u32>,
    },
    #[returns(HistoryResponse)]
    History {
        bounty_id: u64,
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    #[returns(ErrorCatalogResponse)]
    ErrorCatalog {},
}

#[cw_serde]
pub enum RegistryExecuteMsg {
    Graduate {
        source_bounty_id: u64,
        project_id: String,
        metadata_uri: String,
        metadata_digest: String,
        payout_address: String,
    },
}
