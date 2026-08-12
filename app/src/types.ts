// Wire types are derived from contracts/juno-voice-bounties/src/msg.rs and state.rs.
// client.ts validates every field consumed from their cw_serde JSON response shapes.
export type BountyStatus =
  | "open"
  | "single_confirmation"
  | "ratifying"
  | "refunding"
  | "refunded"
  | "paid";
export interface Limits {
  max_title_bytes: number;
  max_summary_bytes: number;
  max_acceptance_criteria_bytes: number;
  max_uri_bytes: number;
  max_rationale_bytes: number;
  max_reason_bytes: number;
  max_page_limit: number;
}
export interface ContractConfig {
  native_denom: string;
  governor: string;
  agent: string;
  registry: string;
  ratification_seconds: number;
  min_contribution: string;
  max_bounty_total: string;
  min_lifetime_seconds: number;
  max_lifetime_seconds: number;
  max_contributors: number;
  max_rounds: number;
  limits: Limits;
  version: number;
}
export interface PauseState {
  paused: boolean;
  reason: string | null;
  actor: string | null;
  changed_at: string | null;
}
export interface Accounting {
  active_escrow: string;
  outstanding_refunds: string;
  pending_payout_liabilities: string;
  lifetime_received: string;
  lifetime_paid: string;
  lifetime_refunded: string;
}
export interface Health {
  accounting: Accounting;
  actual_native_balance: string;
  liabilities: string;
  fully_backed: boolean;
}
export interface Terms {
  title: string;
  summary: string;
  acceptance_criteria: string;
  content_uri: string | null;
  content_digest: string | null;
  config_version: number;
  ratification_seconds: number;
  max_bounty_total: string;
  max_contributors: number;
  max_rounds: number;
  max_evidence_uri_bytes: number;
  max_rationale_bytes: number;
  max_reason_bytes: number;
}
export type RefundReason =
  | "expired"
  | "sole_confirmation_timeout"
  | "round_limit"
  | { cancelled: { reason: string } }
  | {
      moderated: {
        outcome: "spam" | "duplicate" | "policy_violation";
        reason: string;
      };
    };
export interface Bounty {
  id: number;
  creator: string;
  terms: Terms;
  project_candidate: {
    project_id: string;
    metadata_uri: string;
    metadata_digest: string;
  } | null;
  status: BountyStatus;
  refund_reason: RefundReason | null;
  total_contribution: string;
  contributor_count: number;
  next_round: number;
  active_round: number | null;
  paid_recipient: string | null;
  paid_amount: string;
  refunded_amount: string;
  paid_at: string | null;
  graduated_at: string | null;
  created_at: string;
  expires_at: string;
  history_count: number;
}
export interface LedgerData {
  config: ContractConfig;
  pause: PauseState;
  health: Health;
  bounties: Bounty[];
  observationHeight: number;
  chainTimeNanos: string;
  fingerprint: string;
  refreshedAt: Date;
  weakConsistency: true;
}
export interface Contribution { bounty_id: number; contributor: string; contributor_index: number; current_amount: string; weight_at_round: string | null }
export interface Claim { bounty_id: number; contributor: string; amount: string; claimed_at: string }
export interface HistoryEntry { bounty_id: number; sequence: number; actor: string; at: string; action: string | Record<string, unknown> }
export type PayoutVote = "yes" | "no";
export type RoundRule = "sole_confirmation" | "contribution_weighted_majority";
export type RoundOutcome = "pending" | "paid" | "declined" | "no_majority" | "tie" | "no_votes";
export interface PayoutRound {
  bounty_id: number;
  number: number;
  nomination: { nominator: string; recipient: string; evidence_uri: string; evidence_digest: string; rationale: string };
  rule: RoundRule;
  total_weight: string;
  contributor_count: number;
  opens_at: string;
  closes_at: string | null;
  yes_weight: string;
  no_weight: string;
  voter_count: number;
  outcome: RoundOutcome;
  finalized_at: string | null;
}
export interface VoteReceipt {
  bounty_id: number;
  round: number;
  voter: string;
  weight: string;
  vote: PayoutVote;
  rationale: string | null;
  cast_at: string;
  revised_at: string;
  revisions: number;
  voter_index: number;
}
export interface BountyDetail {
  bounty: Bounty;
  config: ContractConfig;
  pause: PauseState;
  activeRound: PayoutRound | null;
  rounds: PayoutRound[];
  receipts: VoteReceipt[];
  moderation: Record<string, unknown> | null;
  graduation: Record<string, unknown> | null;
  contributions: Contribution[];
  claims: Claim[];
  history: HistoryEntry[];
  observationHeight: number;
  chainTimeNanos: string;
  fingerprint: string;
}
