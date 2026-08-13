import { BroadcastTxError, TimeoutError } from "@cosmjs/stargate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTransactionAccess } from "./browserTransactions";
import type { VoiceDataSource } from "./client";
import { contributeIntent } from "./bountyFlows";
import { votePayoutIntent } from "./settlementFlows";
import { bounty, config, ledger } from "./test/bountyFixtures";
import type { BountyDetail } from "./types";

const cosmwasm = vi.hoisted(() => ({ connectWithSigner: vi.fn() }));
vi.mock("@cosmjs/cosmwasm-stargate", () => ({
  SigningCosmWasmClient: { connectWithSigner: cosmwasm.connectWithSigner },
}));

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const detail: BountyDetail = {
  bounty: { ...bounty, creator: sender }, config: ledger.config, pause: ledger.pause,
  activeRound: null, rounds: [], receipts: [], moderation: null, graduation: null, contributions: [], claims: [], history: [],
  observationHeight: ledger.observationHeight, chainTimeNanos: ledger.chainTimeNanos, fingerprint: "bounty:1:v1",
};
const intent = contributeIntent(detail.bounty, "1", sender, [], {
  config: detail.config, pause: detail.pause, chainTimeNanos: detail.chainTimeNanos, fingerprint: detail.fingerprint,
}, config.contract);
const successfulResult = {
  transactionHash: "KNOWN", height: 124, gasWanted: 1n, gasUsed: 1n,
  events: [{ type: "wasm-juno_voice_bounties.contributed", attributes: [
    { key: "bounty_id", value: "1" }, { key: "contributor", value: sender },
    { key: "amount", value: "1000000" }, { key: "bounty_total", value: "3500000" },
  ] }],
};

function setup() {
  const getKey = vi.fn(async () => ({ bech32Address: sender }));
  Object.defineProperty(window, "leap", { configurable: true, value: {
    enable: vi.fn(async () => undefined), getKey, getOfflineSigner: vi.fn(() => ({})),
  } });
  const signing = {
    simulate: vi.fn(async () => 100_000), execute: vi.fn(async () => successfulResult), disconnect: vi.fn(),
  };
  cosmwasm.connectWithSigner.mockResolvedValue(signing);
  const loadBountyDetail = vi.fn(async () => detail);
  const source: VoiceDataSource = { loadLedger: vi.fn(async () => ledger), loadBountyDetail };
  const access = createBrowserTransactionAccess(config, source, "leap");
  return { access, getKey, signing, loadBountyDetail };
}
async function reviewed(fixture: ReturnType<typeof setup>) {
  await fixture.access.connect();
  return fixture.access.prepare(intent);
}

describe("browser transaction broadcast boundary", () => {
  beforeEach(() => { cosmwasm.connectWithSigner.mockReset(); delete (window as Window & { leap?: unknown }).leap; });

  it("preserves a successful execute hash when canonical event/state refresh fails and cannot submit twice", async () => {
    const fixture = setup(); const review = await reviewed(fixture);
    fixture.loadBountyDetail.mockResolvedValueOnce(detail).mockRejectedValueOnce(new Error("canonical RPC unavailable"));
    await expect(fixture.access.submit(review)).resolves.toEqual({ status: "unknown", txHash: "KNOWN",
      explorerUrl: "https://www.mintscan.io/juno/tx/KNOWN" });
    await expect(fixture.access.submit(review)).rejects.toThrow(/no longer available/);
    expect(fixture.signing.execute).toHaveBeenCalledTimes(1);
  });

  it("uses CosmJS TimeoutError.txId as pending evidence even with misleading text", async () => {
    const fixture = setup(); const review = await reviewed(fixture);
    fixture.signing.execute.mockRejectedValueOnce(new TimeoutError("block polling denied", "TIMEOUT_HASH"));
    await expect(fixture.access.submit(review)).resolves.toEqual({ status: "unknown", txHash: "TIMEOUT_HASH",
      explorerUrl: "https://www.mintscan.io/juno/tx/TIMEOUT_HASH" });
  });

  it.each(["block polling failed", "RPC denied the query after block polling"])(
    "keeps hashless post-sign transport uncertainty non-retryable: %s", async (message) => {
      const fixture = setup(); const review = await reviewed(fixture);
      fixture.signing.execute.mockRejectedValueOnce(new Error(message));
      await expect(fixture.access.submit(review)).resolves.toEqual({ status: "unknown" });
      await expect(fixture.access.submit(review)).rejects.toThrow(/no longer available/);
      expect(fixture.signing.execute).toHaveBeenCalledTimes(1);
    });

  it("recognizes structured wallet and CheckTx failures without substring guessing", async () => {
    const rejected = setup(); const rejectedReview = await reviewed(rejected);
    rejected.signing.execute.mockRejectedValueOnce(Object.assign(new Error("request stopped"), { code: 4001 }));
    await expect(rejected.access.submit(rejectedReview)).resolves.toEqual({ status: "rejected", reason: "request stopped" });

    const failed = setup(); const failedReview = await reviewed(failed);
    failed.signing.execute.mockRejectedValueOnce(new BroadcastTxError(5, "sdk", "insufficient funds"));
    await expect(failed.access.submit(failedReview)).resolves.toMatchObject({ status: "failed", reason: expect.stringContaining("code 5") });
  });

  it("revalidates the extension account as the final await before execute", async () => {
    const fixture = setup(); const review = await reviewed(fixture);
    fixture.loadBountyDetail.mockResolvedValueOnce(detail).mockResolvedValueOnce({ ...detail,
      bounty: { ...detail.bounty, total_contribution: "3500000" } });
    await fixture.access.submit(review);
    const lastIdentityRead = fixture.getKey.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastIdentityRead).toBeGreaterThan(cosmwasm.connectWithSigner.mock.invocationCallOrder.at(-1) ?? 0);
    expect(fixture.signing.execute.mock.invocationCallOrder[0]).toBeGreaterThan(lastIdentityRead);
  });

  it("routes a nonpayable ballot through the shared signer and confirms canonical event plus refreshed receipt", async () => {
    const fixture = setup();
    const round = { bounty_id: 1, number: 1, nomination: { nominator: sender, recipient: sender, evidence_uri: "ipfs://evidence",
      evidence_digest: `sha256:${"ab".repeat(32)}`, rationale: "done" }, rule: "contribution_weighted_majority" as const,
      total_weight: "2500000", contributor_count: 1, opens_at: "1", closes_at: "1800000000000000000",
      yes_weight: "0", no_weight: "0", voter_count: 0, outcome: "pending" as const, finalized_at: null };
    const before: BountyDetail = { ...detail, bounty: { ...detail.bounty, status: "ratifying", active_round: 1 },
      activeRound: round, rounds: [round], contributions: [{ bounty_id: 1, contributor: sender, contributor_index: 1,
        current_amount: "2500000", weight_at_round: "2500000" }], fingerprint: "vote:v1" };
    const receipt = { bounty_id: 1, round: 1, voter: sender, weight: "2500000", vote: "yes" as const, rationale: null,
      cast_at: "2", revised_at: "2", revisions: 0, voter_index: 1 };
    const updatedRound = { ...round, yes_weight: "2500000", voter_count: 1 };
    const refreshed = { ...before, activeRound: updatedRound, rounds: [updatedRound], receipts: [receipt], fingerprint: "vote:v2" };
    fixture.loadBountyDetail.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce(before)
      .mockResolvedValueOnce(refreshed).mockResolvedValueOnce(refreshed);
    fixture.signing.execute.mockResolvedValueOnce({ ...successfulResult, events: [{ type: "wasm-juno_voice_bounties.payout_vote_recorded",
      attributes: [{ key: "bounty_id", value: "1" }, { key: "round", value: "1" }, { key: "voter", value: sender },
        { key: "vote", value: "yes" }, { key: "weight", value: "2500000" }, { key: "yes_weight", value: "2500000" },
        { key: "no_weight", value: "0" }, { key: "revisions", value: "0" }] }] });
    await fixture.access.connect();
    const review = await fixture.access.prepare(votePayoutIntent(before, sender, 1, "yes", "", config.contract));
    expect(review.funds).toEqual([]);
    await expect(fixture.access.submit(review)).resolves.toMatchObject({ status: "confirmed", txHash: "KNOWN" });
    expect(fixture.signing.execute).toHaveBeenCalledWith(sender, config.contract,
      { vote_payout: { bounty_id: 1, round: 1, vote: "yes", rationale: null } }, review.fee, "", []);
  });
});
