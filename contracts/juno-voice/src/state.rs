use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct RequestLimits {
    pub max_title_bytes: u16,
    pub max_summary_bytes: u16,
    pub max_acceptance_criteria_bytes: u16,
    pub max_category_bytes: u8,
    pub max_uri_bytes: u16,
    pub max_digest_bytes: u8,
    pub max_evidence_note_bytes: u16,
    pub max_evidence_items: u16,
    pub max_review_evidence_refs: u8,
    pub max_attestation_evidence_refs: u8,
}

impl Default for RequestLimits {
    fn default() -> Self {
        Self {
            max_title_bytes: 120,
            max_summary_bytes: 2_000,
            max_acceptance_criteria_bytes: 4_000,
            max_category_bytes: 32,
            max_uri_bytes: 512,
            max_digest_bytes: 71,
            max_evidence_note_bytes: 1_024,
            max_evidence_items: 64,
            max_review_evidence_refs: 16,
            max_attestation_evidence_refs: 16,
        }
    }
}

#[cw_serde]
pub struct Config {
    pub governor: Addr,
    pub pending_governor: Option<Addr>,
    pub steward: Addr,
    pub verifier: Addr,
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
    pub submissions_paused: bool,
}

/// Configuration copied into each newly opened request. Audit records retain
/// both snapshots so later configuration changes cannot erase prior facts.
#[cw_serde]
pub struct FutureRequestPolicy {
    pub submission_bond: Uint128,
    pub voting_period_blocks: u64,
    pub quorum_bps: u16,
    pub support_bps: u16,
    pub work_inactivity_blocks: u64,
    pub request_limits: RequestLimits,
}

#[cw_serde]
pub enum Status {
    Open,
    Qualified,
    NotPrioritized,
    Duplicate,
    Spam,
    Building,
    Review,
    Blocked,
    Archived,
    Shipped,
}

impl Status {
    pub const fn code(&self) -> u8 {
        match self {
            Self::Open => 1,
            Self::Qualified => 2,
            Self::NotPrioritized => 3,
            Self::Duplicate => 4,
            Self::Spam => 5,
            Self::Building => 6,
            Self::Review => 7,
            Self::Blocked => 8,
            Self::Archived => 9,
            Self::Shipped => 10,
        }
    }
}

#[cw_serde]
pub enum BondState {
    Locked,
    Refundable,
    Claimed,
    Forfeited,
}

#[cw_serde]
pub struct Bond {
    pub amount: Uint128,
    pub state: BondState,
}

#[cw_serde]
#[derive(Default)]
pub struct BondTotals {
    pub locked: Uint128,
    pub refundable: Uint128,
    pub forfeited: Uint128,
}

#[cw_serde]
pub struct Request {
    pub id: u64,
    pub author: Addr,
    pub title: String,
    pub summary: String,
    pub acceptance_criteria: String,
    pub category: String,
    pub detail_uri: Option<String>,
    pub detail_digest: Option<String>,
    pub canonical_request_id: Option<u64>,
    pub snapshot_height: u64,
    pub total_power: Uint128,
    pub opened_height: u64,
    pub closes_height: u64,
    pub quorum_bps: u16,
    pub support_bps: u16,
    pub work_inactivity_blocks: u64,
    pub limits: RequestLimits,
    pub evidence_policy_version: u16,
    pub status: Status,
    pub support_power: Uint128,
    pub oppose_power: Uint128,
    pub voter_count: u64,
    pub bond: Bond,
    pub builder: Option<Addr>,
    pub work_round: u32,
    pub work_activity_height: Option<u64>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[cw_serde]
pub enum VoteChoice {
    Support,
    Oppose,
}

#[cw_serde]
pub struct VoteReceipt {
    pub request_id: u64,
    pub voter: Addr,
    pub choice: VoteChoice,
    pub power: Uint128,
    pub cast_height: u64,
}

#[cw_serde]
pub enum EvidenceKind {
    PullRequest,
    Commit,
    Release,
    Deployment,
    Document,
    TestReport,
    AuditReport,
    ReviewRecord,
}

#[cw_serde]
pub struct Evidence {
    pub id: u64,
    pub request_id: u64,
    pub submitter: Addr,
    pub kind: EvidenceKind,
    pub uri: String,
    pub digest: String,
    pub note: String,
    pub work_round: u32,
    pub submitted_at: Timestamp,
    pub submitted_height: u64,
}

#[cw_serde]
pub struct ShipmentAttestation {
    pub verifier: Addr,
    pub rationale: String,
    pub evidence_ids: Vec<u64>,
    pub work_round: u32,
    pub submitted_at: Timestamp,
    pub submitted_height: u64,
}

#[cw_serde]
pub struct StatusHistoryRecord {
    pub id: u64,
    pub request_id: u64,
    pub actor: Addr,
    pub from: Status,
    pub to: Status,
    pub reason: Option<String>,
    pub evidence_ids: Vec<u64>,
    pub height: u64,
    pub timestamp: Timestamp,
}

/// Typed request-level audit action. Variant payloads are the immutable facts needed
/// to reproduce each request mutation; later execute tasks populate these records.
#[cw_serde]
pub enum RequestAction {
    Submitted,
    Finalized {
        qualified: bool,
    },
    StatusTransition {
        from: Status,
        to: Status,
    },
    DuplicateLinked {
        canonical_request_id: u64,
    },
    BuilderAssigned {
        previous_builder: Option<Addr>,
        new_builder: Addr,
        previous_work_round: u32,
        new_work_round: u32,
    },
    EvidenceAdded {
        evidence_id: u64,
    },
    ReviewRequested {
        evidence_ids: Vec<u64>,
    },
    ReviewRejected,
    ShipmentAttested {
        evidence_ids: Vec<u64>,
    },
    BondTransition {
        from: BondState,
        to: BondState,
    },
    RefundWithdrawn {
        amount: Uint128,
    },
}

#[cw_serde]
pub struct RequestActionRecord {
    pub id: u64,
    pub request_id: u64,
    pub actor: Addr,
    pub action: RequestAction,
    pub reason: Option<String>,
    pub height: u64,
    pub timestamp: Timestamp,
}

#[cw_serde]
pub enum ProtocolAction {
    SubmissionsPaused,
    SubmissionsUnpaused,
    ConfigUpdated {
        old_policy: FutureRequestPolicy,
        new_policy: FutureRequestPolicy,
    },
    GovernorProposed {
        previous_nominee: Option<Addr>,
        nominee: Addr,
    },
    GovernorTransferCancelled {
        nominee: Addr,
    },
    GovernorAccepted {
        previous: Addr,
        governor: Addr,
    },
    StewardReplaced {
        previous: Addr,
        steward: Addr,
    },
    VerifierReplaced {
        previous: Addr,
        verifier: Addr,
    },
    Migrated {
        from_version: String,
        to_version: String,
    },
}

#[cw_serde]
pub struct ProtocolActionRecord {
    pub id: u64,
    pub actor: Addr,
    pub action: ProtocolAction,
    pub reason: Option<String>,
    pub height: u64,
    pub timestamp: Timestamp,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const BOND_TOTALS: Item<BondTotals> = Item::new("bond_totals");
pub const NEXT_REQUEST_ID: Item<u64> = Item::new("next_request_id");
pub const NEXT_PROTOCOL_ACTION_ID: Item<u64> = Item::new("next_protocol_action_id");

pub const REQUESTS: Map<u64, Request> = Map::new("requests");
pub const VOTES: Map<(u64, &Addr), VoteReceipt> = Map::new("votes");
pub const EVIDENCE: Map<(u64, u64), Evidence> = Map::new("evidence");
pub const SHIPMENT_ATTESTATIONS: Map<u64, ShipmentAttestation> = Map::new("shipment_attestations");
pub const STATUS_HISTORY: Map<(u64, u64), StatusHistoryRecord> = Map::new("status_history");
pub const REQUEST_ACTIONS: Map<(u64, u64), RequestActionRecord> = Map::new("request_actions");
pub const PROTOCOL_ACTIONS: Map<u64, ProtocolActionRecord> = Map::new("protocol_actions");

pub const NEXT_EVIDENCE_ID: Map<u64, u64> = Map::new("next_evidence_id");
pub const NEXT_STATUS_HISTORY_ID: Map<u64, u64> = Map::new("next_status_history_id");
pub const NEXT_REQUEST_ACTION_ID: Map<u64, u64> = Map::new("next_request_action_id");

// Lookup and canonical ordering indexes are maintained atomically by later execute tasks.
pub const REQUESTS_BY_STATUS: Map<(u8, u64), ()> = Map::new("requests_by_status");
pub const REQUESTS_BY_CATEGORY: Map<(&str, u64), ()> = Map::new("requests_by_category");
pub const REQUESTS_BY_AUTHOR: Map<(&Addr, u64), ()> = Map::new("requests_by_author");
pub const DUPLICATE_REFERENCES: Map<(u64, u64), ()> = Map::new("duplicate_references");
pub const STATUS_RANK: Map<(u8, Vec<u8>), u64> = Map::new("status_rank");
pub const STATUS_CATEGORY_RANK: Map<(u8, &str, Vec<u8>), u64> = Map::new("status_category_rank");
