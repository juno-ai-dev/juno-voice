use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Decimal, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};

use crate::msg::{ReviewDecision, ReviewReason};

#[cw_serde]
pub struct Config {
    pub native_denom: String,
    pub governor: Addr,
    pub curator: Addr,
    pub bounty_contract: Addr,
    pub spam_destination: Addr,
    pub registration_bond: Uint128,
    pub payout_address_delay_seconds: u64,
    pub epoch_ceiling: Uint128,
    pub min_project_share: Decimal,
    pub max_project_share: Decimal,
    pub max_selected_projects: u32,
    pub max_active_projects: u32,
    pub max_page_limit: u32,
    pub max_metadata_uri_bytes: u32,
    pub max_reason_bytes: u32,
    pub version: u64,
}

#[cw_serde]
pub struct PauseState {
    pub admissions_stopped: bool,
    pub adapter_stopped: bool,
    pub reason: Option<String>,
    pub actor: Option<Addr>,
    pub changed_at: Option<Timestamp>,
}

#[cw_serde]
pub enum ProjectStatus {
    Pending,
    Active,
    Suspended,
    Rejected,
    Retired,
}

#[cw_serde]
pub enum AdmissionProvenance {
    GraduatedBounty {
        source_bounty_contract: Addr,
        source_bounty_id: u64,
    },
    BondedRegistration {
        applicant: Addr,
    },
}

#[cw_serde]
pub enum BondState {
    Deposited,
    Refunded,
    Forfeited,
    Claimable,
    Claimed,
}

#[cw_serde]
pub struct RegistrationBond {
    pub depositor: Addr,
    pub amount: Uint128,
    pub state: BondState,
}

#[cw_serde]
pub struct PendingPayoutAddress {
    pub address: Addr,
    pub proposed_by: Addr,
    pub proposed_at: Timestamp,
    pub executable_at: Timestamp,
}

#[cw_serde]
pub struct Project {
    pub id: u64,
    pub owner: Addr,
    pub metadata_uri: String,
    pub metadata_digest: String,
    pub payout_address: Addr,
    pub pending_payout_address: Option<PendingPayoutAddress>,
    pub provenance: AdmissionProvenance,
    pub status: ProjectStatus,
    pub bond: Option<RegistrationBond>,
    pub latest_review: Option<ReviewReason>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub status_history_count: u64,
    pub address_history_count: u64,
}

#[cw_serde]
pub enum StatusAction {
    Graduated,
    Registered,
    Reviewed { decision: ReviewDecision },
    Suspended,
    Retired,
    GovernorOverride,
}

#[cw_serde]
pub struct StatusHistoryEntry {
    pub project_id: u64,
    pub sequence: u64,
    pub from: Option<ProjectStatus>,
    pub to: ProjectStatus,
    pub action: StatusAction,
    pub reason: Option<ReviewReason>,
    pub actor: Addr,
    pub at: Timestamp,
}

#[cw_serde]
pub enum AddressAction {
    Proposed,
    Replaced,
    Cancelled,
    Accepted,
}

#[cw_serde]
pub struct AddressHistoryEntry {
    pub project_id: u64,
    pub sequence: u64,
    pub action: AddressAction,
    pub old_address: Addr,
    pub proposed_address: Option<Addr>,
    pub actor: Addr,
    pub at: Timestamp,
}

#[cw_serde]
pub struct RegistryAccounting {
    pub active_projects: u32,
    pub pending_applications: u64,
    pub bond_liability: Uint128,
    pub lifetime_bonds_received: Uint128,
    pub lifetime_bonds_refunded: Uint128,
    pub lifetime_bonds_forfeited: Uint128,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const PAUSE: Item<PauseState> = Item::new("pause");
pub const ACCOUNTING: Item<RegistryAccounting> = Item::new("accounting");
pub const NEXT_PROJECT_ID: Item<u64> = Item::new("next_project_id");
pub const SOURCE_BOUNTY_COUNT: Item<u64> = Item::new("source_bounty_count_v2");
pub const PROJECTS: Map<u64, Project> = Map::new("projects_v2");
pub const OPTIONS: Map<&str, ()> = Map::new("options");
pub const APPLICATIONS: Map<u64, ()> = Map::new("applications_v2");
pub const SOURCE_BOUNTIES: Map<(&Addr, u64), u64> = Map::new("source_bounties_v2");
pub const STATUS_HISTORY: Map<(u64, u64), StatusHistoryEntry> = Map::new("status_history_v2");
pub const ADDRESS_HISTORY: Map<(u64, u64), AddressHistoryEntry> = Map::new("address_history_v2");
