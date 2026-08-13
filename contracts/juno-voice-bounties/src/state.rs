use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};

use crate::msg::{Limits, ModerationOutcome, PayoutVote, ProjectCandidate};

#[cw_serde]
pub struct Config {
    pub native_denom: String,
    pub governor: Addr,
    pub agent: Addr,
    pub registry: Addr,
    pub ratification_seconds: u64,
    pub min_contribution: Uint128,
    pub max_bounty_total: Uint128,
    pub min_lifetime_seconds: u64,
    pub max_lifetime_seconds: u64,
    pub max_contributors: u32,
    pub max_rounds: u32,
    pub limits: Limits,
    pub version: u64,
}

#[cw_serde]
pub struct PauseState {
    pub paused: bool,
    pub reason: Option<String>,
    pub actor: Option<Addr>,
    pub changed_at: Option<Timestamp>,
}

#[cw_serde]
pub struct Accounting {
    pub active_escrow: Uint128,
    pub outstanding_refunds: Uint128,
    pub pending_payout_liabilities: Uint128,
    pub lifetime_received: Uint128,
    pub lifetime_paid: Uint128,
    pub lifetime_refunded: Uint128,
}

#[cw_serde]
pub struct Terms {
    pub title: String,
    pub summary: String,
    pub acceptance_criteria: String,
    pub content_uri: Option<String>,
    pub content_digest: Option<String>,
    pub config_version: u64,
    pub ratification_seconds: u64,
    pub max_bounty_total: Uint128,
    pub max_contributors: u32,
    pub max_rounds: u32,
    pub max_evidence_uri_bytes: u32,
    pub max_rationale_bytes: u32,
    pub max_reason_bytes: u32,
}

#[cw_serde]
pub enum BountyStatus {
    Open,
    SingleConfirmation,
    Ratifying,
    Refunding,
    Refunded,
    Paid,
}

#[cw_serde]
pub enum RefundReason {
    Expired,
    SoleConfirmationTimeout,
    Cancelled {
        reason: String,
    },
    Moderated {
        outcome: ModerationOutcome,
        reason: String,
    },
    RoundLimit,
}

#[cw_serde]
pub struct Bounty {
    pub id: u64,
    pub creator: Addr,
    pub terms: Terms,
    pub project_candidate: Option<ProjectCandidate>,
    pub status: BountyStatus,
    pub refund_reason: Option<RefundReason>,
    pub total_contribution: Uint128,
    pub contributor_count: u32,
    pub next_round: u32,
    pub active_round: Option<u32>,
    pub paid_recipient: Option<Addr>,
    pub paid_amount: Uint128,
    pub refunded_amount: Uint128,
    pub paid_at: Option<Timestamp>,
    pub graduated_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub history_count: u64,
}

#[cw_serde]
pub struct Nomination {
    pub nominator: Addr,
    pub recipient: Addr,
    pub evidence_uri: String,
    pub evidence_digest: String,
    pub rationale: String,
}

#[cw_serde]
pub enum RoundRule {
    SoleConfirmation,
    ContributionWeightedMajority,
}

#[cw_serde]
pub enum RoundOutcome {
    Pending,
    Paid,
    Declined,
    NoMajority,
    Tie,
    NoVotes,
}

#[cw_serde]
pub struct Round {
    pub bounty_id: u64,
    pub number: u32,
    pub nomination: Nomination,
    pub rule: RoundRule,
    pub total_weight: Uint128,
    pub contributor_count: u32,
    pub opens_at: Timestamp,
    pub closes_at: Option<Timestamp>,
    pub yes_weight: Uint128,
    pub no_weight: Uint128,
    pub voter_count: u32,
    pub outcome: RoundOutcome,
    pub finalized_at: Option<Timestamp>,
}

#[cw_serde]
pub struct ContributionView {
    pub bounty_id: u64,
    pub contributor: Addr,
    pub current_amount: Uint128,
    pub weight_at_round: Option<Uint128>,
    pub contributor_index: u32,
}

#[cw_serde]
pub struct VoteReceipt {
    pub bounty_id: u64,
    pub round: u32,
    pub voter: Addr,
    pub weight: Uint128,
    pub vote: PayoutVote,
    pub rationale: Option<String>,
    pub cast_at: Timestamp,
    pub revised_at: Timestamp,
    pub revisions: u32,
    pub voter_index: u32,
}

#[cw_serde]
pub struct ClaimRecord {
    pub bounty_id: u64,
    pub contributor: Addr,
    pub amount: Uint128,
    pub claimed_at: Timestamp,
}

#[cw_serde]
pub struct ModerationRecord {
    pub bounty_id: u64,
    pub moderator: Addr,
    pub outcome: ModerationOutcome,
    pub reason: String,
    pub moderated_at: Timestamp,
}

#[cw_serde]
pub struct GraduationRecord {
    pub bounty_id: u64,
    pub agent: Addr,
    pub registry: Addr,
    pub project_id: u64,
    pub payout_address: Addr,
    pub graduated_at: Timestamp,
}

#[cw_serde]
pub struct PendingGraduation {
    pub bounty_id: u64,
    pub agent: Addr,
    pub registry: Addr,
    pub payout_address: Addr,
    pub requested_at: Timestamp,
}

#[cw_serde]
pub enum HistoryAction {
    Created,
    Contributed,
    Nominated { round: u32 },
    SoleConfirmed { round: u32 },
    SoleDeclined { round: u32 },
    Voted { round: u32, vote: PayoutVote },
    Finalized { round: u32, outcome: RoundOutcome },
    Cancelled,
    Expired,
    Moderated { outcome: ModerationOutcome },
    Refunded,
    Graduated,
}

#[cw_serde]
pub struct HistoryEntry {
    pub bounty_id: u64,
    pub sequence: u64,
    pub actor: Addr,
    pub action: HistoryAction,
    pub at: Timestamp,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const PAUSE: Item<PauseState> = Item::new("pause");
pub const ACCOUNTING: Item<Accounting> = Item::new("accounting");
pub const NEXT_BOUNTY_ID: Item<u64> = Item::new("next_bounty_id");
pub const BOUNTIES: Map<u64, Bounty> = Map::new("bounties");
pub const CONTRIBUTIONS: Map<(u64, &Addr), Uint128> = Map::new("contributions");
pub const CONTRIBUTOR_INDEX: Map<(u64, u32), Addr> = Map::new("contributor_index");
pub const CONTRIBUTOR_POSITION: Map<(u64, &Addr), u32> = Map::new("contributor_position");
pub const CONTRIBUTION_CHECKPOINTS: Map<(u64, &Addr, u32), Uint128> =
    Map::new("contribution_checkpoints");
pub const ROUNDS: Map<(u64, u32), Round> = Map::new("rounds");
pub const VOTES: Map<(u64, u32, &Addr), VoteReceipt> = Map::new("votes");
pub const VOTER_INDEX: Map<(u64, u32, u32), Addr> = Map::new("voter_index");
pub const CLAIMS: Map<(u64, &Addr), ClaimRecord> = Map::new("claims");
pub const MODERATIONS: Map<u64, ModerationRecord> = Map::new("moderations");
pub const GRADUATIONS: Map<u64, GraduationRecord> = Map::new("graduations");
pub const PENDING_GRADUATION: Item<PendingGraduation> = Item::new("pending_graduation");
pub const HISTORY: Map<(u64, u64), HistoryEntry> = Map::new("history");
