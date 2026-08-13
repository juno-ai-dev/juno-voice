import type { AppConfig } from "./config";
import { connectRpc, type Connect, type RpcClient } from "./rpc";
import type {
  Accounting,
  Bounty,
  BountyStatus,
  ContractConfig,
  Health,
  LedgerData,
  BountyDetail,
  Limits,
  PauseState,
  PayoutRound,
  PayoutVote,
  RefundReason,
  Terms,
  VoteReceipt,
} from "./types";
export const PAGE_LIMIT = 50;
export const queries = {
  config: () => ({ config: {} }),
  pause: () => ({ pause: {} }),
  health: () => ({ health: {} }),
  bounties: (startAfter: number | null = null) => ({
    bounties: { start_after: startAfter, limit: PAGE_LIMIT },
  }),
  bounty: (bountyId: number) => ({ bounty: { bounty_id: bountyId } }),
  contributions: (bountyId: number, startAfter: number | null = null) =>
    ({ contributions: { bounty_id: bountyId, start_after: startAfter, limit: PAGE_LIMIT } }),
  contribution: (bountyId: number, contributor: string, round: number) =>
    ({ contribution: { bounty_id: bountyId, contributor, round } }),
  rounds: (bountyId: number, startAfter: number | null = null) =>
    ({ rounds: { bounty_id: bountyId, start_after: startAfter, limit: PAGE_LIMIT } }),
  receipts: (bountyId: number, round: number, startAfter: number | null = null) =>
    ({ receipts: { bounty_id: bountyId, round, start_after: startAfter, limit: PAGE_LIMIT } }),
  claims: (bountyId: number, startAfter: number | null = null) =>
    ({ claims: { bounty_id: bountyId, start_after: startAfter, limit: PAGE_LIMIT } }),
  history: (bountyId: number, startAfter: number | null = null) =>
    ({ history: { bounty_id: bountyId, start_after: startAfter, limit: PAGE_LIMIT } }),
} as const;

const bad = (c: string): never => {
  throw new Error(`Malformed ${c} response from RPC.`);
};
const rec = (v: unknown, c: string): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : bad(c);
const str = (v: unknown, c: string) => (typeof v === "string" ? v : bad(c));
const bool = (v: unknown, c: string) => (typeof v === "boolean" ? v : bad(c));
const int = (v: unknown, c: string) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(c);
const uint = (
  v: unknown,
  c: string,
  max = 340282366920938463463374607431768211455n,
) => {
  const s = str(v, c);
  if (!/^\d+$/.test(s) || BigInt(s) > max) bad(c);
  return s;
};
const nullable = <T>(v: unknown, fn: (x: unknown) => T) =>
  v === null ? null : fn(v);
function limits(v: unknown): Limits {
  const x = rec(v, "config limits");
  return {
    max_title_bytes: int(x.max_title_bytes, "config limits"),
    max_summary_bytes: int(x.max_summary_bytes, "config limits"),
    max_acceptance_criteria_bytes: int(
      x.max_acceptance_criteria_bytes,
      "config limits",
    ),
    max_uri_bytes: int(x.max_uri_bytes, "config limits"),
    max_rationale_bytes: int(x.max_rationale_bytes, "config limits"),
    max_reason_bytes: int(x.max_reason_bytes, "config limits"),
    max_page_limit: int(x.max_page_limit, "config limits"),
  };
}
export function mapConfig(v: unknown): ContractConfig {
  const x = rec(v, "config");
  return {
    native_denom: str(x.native_denom, "config"),
    governor: str(x.governor, "config"),
    agent: str(x.agent, "config"),
    registry: str(x.registry, "config"),
    ratification_seconds: int(x.ratification_seconds, "config"),
    min_contribution: uint(x.min_contribution, "config"),
    max_bounty_total: uint(x.max_bounty_total, "config"),
    min_lifetime_seconds: int(x.min_lifetime_seconds, "config"),
    max_lifetime_seconds: int(x.max_lifetime_seconds, "config"),
    max_contributors: int(x.max_contributors, "config"),
    max_rounds: int(x.max_rounds, "config"),
    limits: limits(x.limits),
    version: int(x.version, "config"),
  };
}
function accounting(v: unknown): Accounting {
  const x = rec(v, "accounting");
  return {
    active_escrow: uint(x.active_escrow, "accounting"),
    outstanding_refunds: uint(x.outstanding_refunds, "accounting"),
    pending_payout_liabilities: uint(
      x.pending_payout_liabilities,
      "accounting",
    ),
    lifetime_received: uint(x.lifetime_received, "accounting"),
    lifetime_paid: uint(x.lifetime_paid, "accounting"),
    lifetime_refunded: uint(x.lifetime_refunded, "accounting"),
  };
}
function pause(v: unknown): PauseState {
  const x = rec(v, "pause");
  return {
    paused: bool(x.paused, "pause"),
    reason: nullable(x.reason, (y) => str(y, "pause")),
    actor: nullable(x.actor, (y) => str(y, "pause")),
    changed_at: nullable(x.changed_at, (y) =>
      uint(y, "pause", 18446744073709551615n),
    ),
  };
}
function health(v: unknown): Health {
  const x = rec(v, "health");
  return {
    accounting: accounting(x.accounting),
    actual_native_balance: uint(x.actual_native_balance, "health"),
    liabilities: uint(x.liabilities, "health"),
    fully_backed: bool(x.fully_backed, "health"),
  };
}
const statuses = new Set<BountyStatus>([
  "open",
  "single_confirmation",
  "ratifying",
  "refunding",
  "refunded",
  "paid",
]);
function terms(v: unknown): Terms {
  const x = rec(v, "bounty terms");
  return {
    title: str(x.title, "bounty terms"),
    summary: str(x.summary, "bounty terms"),
    acceptance_criteria: str(x.acceptance_criteria, "bounty terms"),
    content_uri: nullable(x.content_uri, (y) => str(y, "bounty terms")),
    content_digest: nullable(x.content_digest, (y) => str(y, "bounty terms")),
    config_version: int(x.config_version, "bounty terms"),
    ratification_seconds: int(x.ratification_seconds, "bounty terms"),
    max_bounty_total: uint(x.max_bounty_total, "bounty terms"),
    max_contributors: int(x.max_contributors, "bounty terms"),
    max_rounds: int(x.max_rounds, "bounty terms"),
    max_evidence_uri_bytes: int(x.max_evidence_uri_bytes, "bounty terms"),
    max_rationale_bytes: int(x.max_rationale_bytes, "bounty terms"),
    max_reason_bytes: int(x.max_reason_bytes, "bounty terms"),
  };
}
function refundReason(v: unknown): RefundReason | null {
  if (v === null) return null;
  if (
    v === "expired" ||
    v === "sole_confirmation_timeout" ||
    v === "round_limit"
  )
    return v;
  const x = rec(v, "refund reason");
  if ("cancelled" in x) {
    const y = rec(x.cancelled, "refund reason");
    return { cancelled: { reason: str(y.reason, "refund reason") } };
  }
  if ("moderated" in x) {
    const y = rec(x.moderated, "refund reason"),
      outcome = str(y.outcome, "refund reason");
    if (!["spam", "duplicate", "policy_violation"].includes(outcome))
      bad("refund reason");
    return {
      moderated: {
        outcome: outcome as "spam" | "duplicate" | "policy_violation",
        reason: str(y.reason, "refund reason"),
      },
    };
  }
  return bad("refund reason");
}
export function mapBounty(v: unknown): Bounty {
  const x = rec(v, "bounty"),
    status = str(x.status, "bounty") as BountyStatus;
  if (!statuses.has(status)) bad("bounty");
  const candidate = nullable(x.project_candidate, (y) => {
    const z = rec(y, "project candidate");
    return {
      metadata_uri: str(z.metadata_uri, "project candidate"),
      metadata_digest: str(z.metadata_digest, "project candidate"),
    };
  });
  return {
    id: int(x.id, "bounty"),
    creator: str(x.creator, "bounty"),
    terms: terms(x.terms),
    project_candidate: candidate,
    status,
    refund_reason: refundReason(x.refund_reason),
    total_contribution: uint(x.total_contribution, "bounty"),
    contributor_count: int(x.contributor_count, "bounty"),
    next_round: int(x.next_round, "bounty"),
    active_round: nullable(x.active_round, (y) => int(y, "bounty")),
    paid_recipient: nullable(x.paid_recipient, (y) => str(y, "bounty")),
    paid_amount: uint(x.paid_amount, "bounty"),
    refunded_amount: uint(x.refunded_amount, "bounty"),
    paid_at: nullable(x.paid_at, (y) =>
      uint(y, "bounty", 18446744073709551615n),
    ),
    graduated_at: nullable(x.graduated_at, (y) =>
      uint(y, "bounty", 18446744073709551615n),
    ),
    created_at: uint(x.created_at, "bounty", 18446744073709551615n),
    expires_at: uint(x.expires_at, "bounty", 18446744073709551615n),
    history_count: int(x.history_count, "bounty"),
  };
}
const roundRules = new Set(["sole_confirmation", "contribution_weighted_majority"]);
const roundOutcomes = new Set(["pending", "paid", "declined", "no_majority", "tie", "no_votes"]);
function mapRound(v: unknown): PayoutRound {
  const x = rec(v, "round"), nomination = rec(x.nomination, "round nomination");
  const rule = str(x.rule, "round"), outcome = str(x.outcome, "round");
  if (!roundRules.has(rule) || !roundOutcomes.has(outcome)) bad("round");
  return {
    bounty_id: int(x.bounty_id, "round"), number: int(x.number, "round"),
    nomination: { nominator: str(nomination.nominator, "round nomination"),
      recipient: str(nomination.recipient, "round nomination"),
      evidence_uri: str(nomination.evidence_uri, "round nomination"),
      evidence_digest: str(nomination.evidence_digest, "round nomination"),
      rationale: str(nomination.rationale, "round nomination") },
    rule: rule as PayoutRound["rule"], total_weight: uint(x.total_weight, "round"),
    contributor_count: int(x.contributor_count, "round"), opens_at: uint(x.opens_at, "round", 18446744073709551615n),
    closes_at: nullable(x.closes_at, (y) => uint(y, "round", 18446744073709551615n)),
    yes_weight: uint(x.yes_weight, "round"), no_weight: uint(x.no_weight, "round"),
    voter_count: int(x.voter_count, "round"), outcome: outcome as PayoutRound["outcome"],
    finalized_at: nullable(x.finalized_at, (y) => uint(y, "round", 18446744073709551615n)),
  };
}
function mapReceipt(v: unknown): VoteReceipt {
  const x = rec(v, "vote receipt"), vote = str(x.vote, "vote receipt");
  if (vote !== "yes" && vote !== "no") bad("vote receipt");
  return { bounty_id: int(x.bounty_id, "vote receipt"), round: int(x.round, "vote receipt"),
    voter: str(x.voter, "vote receipt"), weight: uint(x.weight, "vote receipt"), vote: vote as PayoutVote,
    rationale: nullable(x.rationale, (y) => str(y, "vote receipt")),
    cast_at: uint(x.cast_at, "vote receipt", 18446744073709551615n),
    revised_at: uint(x.revised_at, "vote receipt", 18446744073709551615n),
    revisions: int(x.revisions, "vote receipt"), voter_index: int(x.voter_index, "vote receipt") };
}
async function provenance(c: RpcClient, cfg: AppConfig) {
  const [chain, contract] = await Promise.all([
    c.getChainId(),
    c.getContract(cfg.contract),
  ]);
  if (chain !== cfg.chainId)
    throw new Error(
      `Deployment mismatch: expected chain ${cfg.chainId}, observed ${chain}.`,
    );
  if (contract.address !== cfg.contract || contract.codeId !== cfg.codeId)
    throw new Error(
      `Deployment mismatch: expected contract ${cfg.contract} at Code ID ${cfg.codeId}.`,
    );
  const code = await c.getCodeDetails(cfg.codeId);
  if (code.checksum.toLowerCase() !== cfg.codeChecksum)
    throw new Error(
      "Deployment mismatch: contract code checksum is not the verified artifact.",
    );
}
async function pages(
  query: (q: object) => Promise<unknown>,
  first: unknown,
): Promise<Bounty[]> {
  const out: Bounty[] = [];
  let raw = first,
    cursor: number | null = null,
    last = 0;
  for (let n = 0; n < 1000; n++) {
    const x = rec(raw, "bounties");
    const candidate = x.bounties;
    if (!Array.isArray(candidate)) bad("bounties");
    const values = candidate as unknown[];
    const page = values.map(mapBounty);
    for (const item of page) {
      if (item.id <= last)
        throw new Error("Non-increasing bounty IDs from RPC.");
      last = item.id;
      out.push(item);
    }
    if (page.length < PAGE_LIMIT) return out;
    cursor = last;
    raw = await query(queries.bounties(cursor));
  }
  throw new Error("Too many bounty pages from RPC.");
}
export interface VoiceDataSource {
  loadLedger(): Promise<LedgerData>;
  loadBountyDetail?(bountyId: number): Promise<BountyDetail>;
}
export function createDataSource(
  cfg: AppConfig,
  connector: Connect = connectRpc,
): VoiceDataSource {
  return {
    async loadLedger() {
      const c = await connector(cfg.rpc);
      try {
        await provenance(c, cfg);
        const query = (q: object) => c.queryContractSmart(cfg.contract, q);
        const [cr, pr, hr, br, height, chainTimeNanos] = await Promise.all([
          query(queries.config()),
          query(queries.pause()),
          query(queries.health()),
          query(queries.bounties()),
          c.getHeight(),
          c.getChainTimeNanos(),
        ]);
        const config = mapConfig(cr);
        if (
          config.native_denom !== "ujuno" ||
          config.limits.max_page_limit < PAGE_LIMIT
        )
          throw new Error(
            "Deployment mismatch: unsupported contract configuration.",
          );
        const pauseState = pause(pr), bounties = await pages(query, br), observationHeight = int(height, "height");
        return {
          config,
          pause: pauseState,
          health: health(hr),
          bounties,
          observationHeight,
          chainTimeNanos,
          // Review freshness tracks state that can change create eligibility. Height
          // and the exact block time are evidence, but would make every new block
          // invalidate an otherwise unchanged review.
          fingerprint: JSON.stringify({ config, pause: pauseState }),
          refreshedAt: new Date(),
          weakConsistency: true,
        };
      } finally {
        c.disconnect();
      }
    },
    async loadBountyDetail(bountyId) {
      const c = await connector(cfg.rpc);
      try {
        await provenance(c, cfg);
        const query = (q: object) => c.queryContractSmart(cfg.contract, q);
        const [detailRaw, contributionsRaw, claimsRaw, historyRaw, roundsRaw, configRaw, pauseRaw, height, chainTimeNanos] = await Promise.all([
          query(queries.bounty(bountyId)), query(queries.contributions(bountyId)), query(queries.claims(bountyId)),
          query(queries.history(bountyId)), query(queries.rounds(bountyId)), query(queries.config()), query(queries.pause()),
          c.getHeight(), c.getChainTimeNanos(),
        ]);
        const detail = rec(detailRaw, "bounty detail");
        const bounty = mapBounty(detail.bounty);
        if (bounty.id !== bountyId) throw new Error("Canonical bounty detail identifies a different bounty.");
        const contributionItems: unknown[] = [], claimItems: unknown[] = [], historyItems: unknown[] = [], roundItems: unknown[] = [];
        let contributionPage: unknown = contributionsRaw, claimPage: unknown = claimsRaw,
          historyPage: unknown = historyRaw, roundPage: unknown = roundsRaw;
        for (let page = 0; page < 1000; page++) {
          const values = rec(contributionPage, "contributions").contributions;
          if (!Array.isArray(values)) bad("contributions");
          const items = values as unknown[];
          contributionItems.push(...items);
          if (items.length < PAGE_LIMIT) break;
          const last = rec(items.at(-1), "contribution");
          contributionPage = await query(queries.contributions(bountyId, int(last.contributor_index, "contribution")));
          if (page === 999) throw new Error("Too many contribution pages from RPC.");
        }
        for (let page = 0; page < 1000; page++) {
          const values = rec(roundPage, "rounds").rounds;
          if (!Array.isArray(values)) bad("rounds");
          const items = values as unknown[];
          roundItems.push(...items);
          if (items.length < PAGE_LIMIT) break;
          const last = rec(items.at(-1), "round");
          roundPage = await query(queries.rounds(bountyId, int(last.number, "round")));
          if (page === 999) throw new Error("Too many round pages from RPC.");
        }
        for (let page = 0; page < 1000; page++) {
          const response = rec(claimPage, "claims"), values = response.claims;
          if (!Array.isArray(values)) bad("claims");
          claimItems.push(...(values as unknown[]));
          const cursor = nullable(response.next_start_after, (value) => int(value, "claims"));
          if (cursor === null) break;
          claimPage = await query(queries.claims(bountyId, cursor));
          if (page === 999) throw new Error("Too many claim pages from RPC.");
        }
        for (let page = 0; page < 1000; page++) {
          const values = rec(historyPage, "history").entries;
          if (!Array.isArray(values)) bad("history");
          const items = values as unknown[];
          historyItems.push(...items);
          if (items.length < PAGE_LIMIT) break;
          const last = rec(items.at(-1), "history");
          historyPage = await query(queries.history(bountyId, int(last.sequence, "history")));
          if (page === 999) throw new Error("Too many history pages from RPC.");
        }
        const mapContribution = (item: unknown) => { const x = rec(item, "contribution"); return {
          bounty_id: int(x.bounty_id, "contribution"), contributor: str(x.contributor, "contribution"),
          contributor_index: int(x.contributor_index, "contribution"), current_amount: uint(x.current_amount, "contribution"),
          weight_at_round: nullable(x.weight_at_round, (y) => uint(y, "contribution")), }; };
        let mappedContributions = contributionItems.map(mapContribution);
        const mappedClaims = claimItems.map((item) => { const x = rec(item, "claim"); return { bounty_id: int(x.bounty_id, "claim"),
          contributor: str(x.contributor, "claim"), amount: uint(x.amount, "claim"), claimed_at: uint(x.claimed_at, "claim", 18446744073709551615n) }; });
        const mappedHistory = historyItems.map((item) => { const x = rec(item, "history"), action = x.action;
          if (typeof action !== "string" && (typeof action !== "object" || action === null || Array.isArray(action))) bad("history");
          return { bounty_id: int(x.bounty_id, "history"), sequence: int(x.sequence, "history"), actor: str(x.actor, "history"),
            at: uint(x.at, "history", 18446744073709551615n), action: action as string | Record<string, unknown> }; });
        if (mappedContributions.some((item, index) => item.bounty_id !== bountyId || item.contributor_index !== index + 1) ||
          mappedClaims.some((item) => item.bounty_id !== bountyId) ||
          mappedHistory.some((item, index) => item.bounty_id !== bountyId || item.sequence !== index + 1))
          throw new Error("Canonical bounty child records are inconsistent.");
        const rounds = roundItems.map(mapRound);
        for (let index = 0; index < rounds.length; index++) {
          if (rounds[index].bounty_id !== bountyId || (index > 0 && rounds[index - 1].number >= rounds[index].number))
            throw new Error("Canonical round detail is inconsistent.");
        }
        const activeRound = nullable(detail.active_round, mapRound);
        if ((activeRound === null) !== (bounty.active_round === null) ||
          (activeRound && (activeRound.number !== bounty.active_round ||
            JSON.stringify(rounds.find((item) => item.number === activeRound.number)) !== JSON.stringify(activeRound))))
          throw new Error("Canonical active round is inconsistent.");
        if (activeRound) {
          mappedContributions = await Promise.all(mappedContributions.map(async (item) => {
            const weighted = mapContribution(await query(queries.contribution(bountyId, item.contributor, activeRound.number)));
            if (weighted.bounty_id !== bountyId || weighted.contributor !== item.contributor ||
              weighted.contributor_index !== item.contributor_index || weighted.current_amount !== item.current_amount)
              throw new Error("Canonical contribution snapshot is inconsistent.");
            return weighted;
          }));
        }
        const mappedReceipts: VoteReceipt[] = [];
        for (const round of rounds) {
          let cursor: number | null = null;
          for (let page = 0; page < 1000 && mappedReceipts.filter((item) => item.round === round.number).length < round.voter_count; page++) {
            const response = rec(await query(queries.receipts(bountyId, round.number, cursor)), "receipts"), values = response.receipts;
            if (!Array.isArray(values)) bad("receipts");
            const items = (values as unknown[]).map(mapReceipt);
            const existing = mappedReceipts.filter((item) => item.round === round.number).length;
            if (items.some((item, index) => item.bounty_id !== bountyId || item.round !== round.number || item.voter_index !== existing + index + 1))
              throw new Error("Canonical vote receipts are inconsistent.");
            mappedReceipts.push(...items);
            if (items.length < PAGE_LIMIT) break;
            cursor = items.at(-1)?.voter_index ?? null;
            if (page === 999) throw new Error("Too many receipt pages from RPC.");
          }
          if (mappedReceipts.filter((item) => item.round === round.number).length !== round.voter_count)
            throw new Error("Canonical vote receipts are incomplete.");
        }
        if (mappedContributions.length !== bounty.contributor_count || mappedHistory.length !== bounty.history_count)
          throw new Error("Canonical bounty detail is incomplete.");
        const config = mapConfig(configRaw), pauseState = pause(pauseRaw);
        if (config.native_denom !== "ujuno") throw new Error("Deployment mismatch: unsupported contract configuration.");
        // Exact time remains separately displayed and validated. The expiry bit
        // changes precisely when contribution eligibility changes without
        // rejecting a review merely because another block was produced.
        const expired = BigInt(chainTimeNanos) >= BigInt(bounty.expires_at);
        const roundClosed = activeRound?.closes_at ? BigInt(chainTimeNanos) >= BigInt(activeRound.closes_at) : null;
        const fingerprint = JSON.stringify({ config, pause: pauseState, bounty, activeRound, rounds,
          contributions: mappedContributions, receipts: mappedReceipts, claims: mappedClaims, expired, roundClosed });
        return { bounty, config, pause: pauseState, activeRound, rounds, receipts: mappedReceipts,
          moderation: nullable(detail.moderation, (x) => rec(x, "moderation")), graduation: nullable(detail.graduation, (x) => rec(x, "graduation")),
          contributions: mappedContributions, claims: mappedClaims, history: mappedHistory,
          observationHeight: int(height, "height"), chainTimeNanos, fingerprint };
      } finally { c.disconnect(); }
    },
  };
}
