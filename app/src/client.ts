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
  RefundReason,
  Terms,
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
  contributions: (bountyId: number) => ({ contributions: { bounty_id: bountyId, start_after: null, limit: PAGE_LIMIT } }),
  claims: (bountyId: number) => ({ claims: { bounty_id: bountyId, start_after: null, limit: PAGE_LIMIT } }),
  history: (bountyId: number) => ({ history: { bounty_id: bountyId, start_after: null, limit: PAGE_LIMIT } }),
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
      project_id: str(z.project_id, "project candidate"),
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
        return {
          config,
          pause: pause(pr),
          health: health(hr),
          bounties: await pages(query, br),
          observationHeight: int(height, "height"),
          chainTimeNanos,
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
        const [detailRaw, contributionsRaw, claimsRaw, historyRaw, height, chainTimeNanos] = await Promise.all([
          query(queries.bounty(bountyId)), query(queries.contributions(bountyId)), query(queries.claims(bountyId)),
          query(queries.history(bountyId)), c.getHeight(), c.getChainTimeNanos(),
        ]);
        const detail = rec(detailRaw, "bounty detail"), contributions = rec(contributionsRaw, "contributions").contributions,
          claims = rec(claimsRaw, "claims").claims, history = rec(historyRaw, "history").entries;
        if (!Array.isArray(contributions) || !Array.isArray(claims) || !Array.isArray(history)) bad("bounty detail");
        const contributionItems = contributions as unknown[], claimItems = claims as unknown[], historyItems = history as unknown[];
        const bounty = mapBounty(detail.bounty);
        const mappedContributions = contributionItems.map((item) => { const x = rec(item, "contribution"); return {
          bounty_id: int(x.bounty_id, "contribution"), contributor: str(x.contributor, "contribution"),
          contributor_index: int(x.contributor_index, "contribution"), current_amount: uint(x.current_amount, "contribution"),
          weight_at_round: nullable(x.weight_at_round, (y) => uint(y, "contribution")), }; });
        const mappedClaims = claimItems.map((item) => { const x = rec(item, "claim"); return { bounty_id: int(x.bounty_id, "claim"),
          contributor: str(x.contributor, "claim"), amount: uint(x.amount, "claim"), claimed_at: uint(x.claimed_at, "claim", 18446744073709551615n) }; });
        const mappedHistory = historyItems.map((item) => { const x = rec(item, "history"), action = x.action;
          if (typeof action !== "string" && (typeof action !== "object" || action === null || Array.isArray(action))) bad("history");
          return { bounty_id: int(x.bounty_id, "history"), sequence: int(x.sequence, "history"), actor: str(x.actor, "history"),
            at: uint(x.at, "history", 18446744073709551615n), action: action as string | Record<string, unknown> }; });
        const fingerprint = JSON.stringify({ bounty, chainTimeNanos, height });
        return { bounty, activeRound: nullable(detail.active_round, (x) => rec(x, "active round")),
          moderation: nullable(detail.moderation, (x) => rec(x, "moderation")), graduation: nullable(detail.graduation, (x) => rec(x, "graduation")),
          contributions: mappedContributions, claims: mappedClaims, history: mappedHistory,
          observationHeight: int(height, "height"), chainTimeNanos, fingerprint };
      } finally { c.disconnect(); }
    },
  };
}
