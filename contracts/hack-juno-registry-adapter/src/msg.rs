use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{CosmosMsg, Decimal, Uint128};

use crate::state::{
    AddressHistoryEntry, Config, PauseState, Project, RegistryAccounting, StatusHistoryEntry,
};

pub type ConfigResponse = Config;
pub type PauseResponse = PauseState;
pub type AccountingResponse = RegistryAccounting;
pub type StatusHistoryResponse = HistoryResponse<StatusHistoryEntry>;
pub type AddressHistoryResponse = HistoryResponse<AddressHistoryEntry>;

#[cw_serde]
pub struct InstantiateMsg {
    pub native_denom: String,
    pub governor: String,
    pub curator: String,
    pub bounty_contract: String,
    pub spam_destination: String,
    pub registration_bond: Uint128,
    pub payout_address_delay_seconds: u64,
    pub epoch_ceiling: Uint128,
    pub min_project_share: Decimal,
    pub max_project_share: Decimal,
    pub max_selected_projects: u32,
    pub max_page_limit: u32,
    pub max_metadata_uri_bytes: u32,
    pub max_reason_bytes: u32,
}

#[cw_serde]
pub enum ReviewReasonCode {
    MeetsCriteria,
    IncompleteApplication,
    Duplicate,
    Spam,
    PolicyViolation,
    GovernanceOverride,
    VoluntaryRetirement,
}

#[cw_serde]
pub struct ReviewReason {
    pub code: ReviewReasonCode,
    pub note: String,
}

#[cw_serde]
pub enum ReviewDecision {
    Approve,
    RequestChanges,
    SoftReject,
    HardReject,
}

#[cw_serde]
pub enum OverrideStatus {
    Active,
    Suspended,
    Rejected,
    Retired,
}

#[cw_serde]
pub enum StopScope {
    Admissions,
    Adapter,
    All,
}

#[cw_serde]
pub struct EconomicConfigUpdate {
    pub registration_bond: Option<Uint128>,
    pub spam_destination: Option<String>,
    pub payout_address_delay_seconds: Option<u64>,
    pub epoch_ceiling: Option<Uint128>,
    pub min_project_share: Option<Decimal>,
    pub max_project_share: Option<Decimal>,
    pub max_selected_projects: Option<u32>,
}

#[cw_serde]
pub enum ExecuteMsg {
    RegisterProject {
        project_id: String,
        metadata_uri: String,
        metadata_digest: String,
        payout_address: String,
    },
    Graduate {
        source_bounty_id: u64,
        project_id: String,
        metadata_uri: String,
        metadata_digest: String,
        payout_address: String,
    },
    UpdatePendingMetadata {
        project_id: String,
        metadata_uri: String,
        metadata_digest: String,
    },
    ReviewRegistration {
        project_id: String,
        decision: ReviewDecision,
        reason: ReviewReason,
    },
    Suspend {
        project_id: String,
        reason: ReviewReason,
    },
    Retire {
        project_id: String,
        reason: ReviewReason,
    },
    OverrideProjectStatus {
        project_id: String,
        status: OverrideStatus,
        reason: ReviewReason,
    },
    ProposePayoutAddress {
        project_id: String,
        address: String,
    },
    CancelPayoutAddressChange {
        project_id: String,
    },
    AcceptPayoutAddress {
        project_id: String,
    },
    ClaimRegistrationBond {
        project_id: String,
    },
    Stop {
        scope: StopScope,
        reason: String,
    },
    Resume {
        scope: StopScope,
        reason: String,
    },
    UpdateCurator {
        curator: String,
    },
    UpdateBountyContract {
        bounty_contract: String,
    },
    UpdateEconomicConfig {
        update: EconomicConfigUpdate,
    },
}

#[cw_serde]
pub struct ProjectsResponse {
    pub projects: Vec<Project>,
}

#[cw_serde]
pub struct HistoryResponse<T> {
    pub entries: Vec<T>,
}

#[cw_serde]
pub struct AllOptionsResponse {
    pub options: Vec<String>,
}

#[cw_serde]
pub struct CheckOptionResponse {
    pub valid: bool,
}

#[cw_serde]
pub struct SampleGaugeMsgsResponse {
    pub execute: Vec<CosmosMsg>,
    pub emitted_value: Uint128,
    pub retained_value: Uint128,
}

#[cw_serde]
pub struct HealthResponse {
    pub accounting: RegistryAccounting,
    pub actual_native_balance: Uint128,
    pub fully_backed: bool,
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(PauseResponse)]
    Pause {},
    #[returns(AccountingResponse)]
    Accounting {},
    #[returns(HealthResponse)]
    Health {},
    #[returns(Project)]
    Project { project_id: String },
    #[returns(ProjectsResponse)]
    Projects {
        start_after: Option<String>,
        limit: Option<u32>,
    },
    #[returns(ProjectsResponse)]
    Applications {
        start_after: Option<String>,
        limit: Option<u32>,
    },
    #[returns(StatusHistoryResponse)]
    StatusHistory {
        project_id: String,
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    #[returns(AddressHistoryResponse)]
    AddressHistory {
        project_id: String,
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    #[returns(AllOptionsResponse)]
    AllOptions {
        start_after: Option<String>,
        limit: Option<u32>,
    },
    #[returns(CheckOptionResponse)]
    CheckOption { option: String },
    #[returns(SampleGaugeMsgsResponse)]
    SampleGaugeMsgs {
        selected: Vec<(String, Decimal)>,
        epoch_budget: Uint128,
        available_balance: Uint128,
        denom: String,
    },
}
