// Interfaces are manually derived from the checked-in canonical schemas under ../schema/raw/.
// Runtime validators in client.ts enforce every field consumed by the UI.
export type Status = 'open' | 'qualified' | 'not_prioritized' | 'duplicate' | 'spam' | 'building' | 'review' | 'blocked' | 'archived' | 'shipped';
export type BondState = 'locked' | 'refundable' | 'claimed' | 'forfeited';
export interface RequestLimits { max_title_bytes: number; max_summary_bytes: number; max_acceptance_criteria_bytes: number; max_category_bytes: number; max_uri_bytes: number; max_digest_bytes: number; max_evidence_note_bytes: number; max_evidence_items: number; max_review_evidence_refs: number; max_attestation_evidence_refs: number }
export interface Bond { amount: string; state: BondState }
export interface Request { id: number; author: string; title: string; summary: string; acceptance_criteria: string; category: string; detail_uri: string | null; detail_digest: string | null; canonical_request_id: number | null; snapshot_height: number; total_power: string; opened_height: number; closes_height: number; quorum_bps: number; support_bps: number; work_inactivity_blocks: number; limits: RequestLimits; evidence_policy_version: number; status: Status; support_power: string; oppose_power: string; voter_count: number; bond: Bond; builder: string | null; work_round: number; work_activity_height: number | null; created_at: string; updated_at: string }
export interface ContractConfig { governor: string; pending_governor: string | null; steward: string; verifier: string; native_denom: string; submission_bond: string; voting_period_blocks: number; quorum_bps: number; support_bps: number; work_inactivity_blocks: number; request_limits: RequestLimits; max_reason_bytes: number; default_query_limit: number; max_query_limit: number; evidence_policy_version: number; submissions_paused: boolean }
export interface BondTotals { locked: string; refundable: string; forfeited: string }
export interface Evidence { id: number; request_id: number; submitter: string; kind: string; uri: string; digest: string; note: string; work_round: number; submitted_at: string; submitted_height: number }
export interface StatusHistory { id: number; request_id: number; actor: string; from: Status; to: Status; reason: string | null; evidence_ids: number[]; height: number; timestamp: string }
export interface RequestAction { id: number; request_id: number; actor: string; action: Record<string, unknown> | string; reason: string | null; height: number; timestamp: string }
export interface Attestation { verifier: string; rationale: string; evidence_ids: number[]; work_round: number; submitted_at: string; submitted_height: number }
export interface Page<T> { items: T[]; next_start_after: number | null; query_height: number }
export interface RankedPage { items: Request[]; next_cursor: string | null; query_height: number }
export interface LedgerData { config: ContractConfig; bonds: BondTotals; requests: Request[]; ranked: Record<Status, Request[]>; queryHeight: number; refreshedAt: Date; weakConsistency: boolean }
export interface DetailData { request: Request; evidence: Evidence[]; history: StatusHistory[]; actions: RequestAction[]; attestation: Attestation | null; queryHeight: number; sectionErrors?: Partial<Record<'evidence' | 'history' | 'actions' | 'attestation', string>> }
