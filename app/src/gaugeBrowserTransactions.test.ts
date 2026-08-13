import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTransactionAccess } from "./browserTransactions";
import type { VoiceDataSource } from "./client";
import type { GaugeDataSource } from "./gauge";
import { buildGaugeIntent } from "./gaugeActions";
import { config, ledger } from "./test/bountyFixtures";
import { gaugeContext, gaugeData, voter } from "./test/gaugeFixtures";

const cosmwasm = vi.hoisted(() => ({ connectWithSigner: vi.fn() }));
vi.mock("@cosmjs/cosmwasm-stargate", () => ({ SigningCosmWasmClient: { connectWithSigner: cosmwasm.connectWithSigner } }));
const after = { ...gaugeContext, data: { ...gaugeData, ballot: { ...gaugeData.ballot!, revisedAt: 2500, revisions: 2 } }, fingerprint: "gauge:after" };
const intent = buildGaugeIntent(config, voter, gaugeContext, "place_votes", [{ option: "project:1", weight: "0.5" }]);
const success = { transactionHash: "GAUGE_HASH", height: 40_000_101, gasWanted: 1n, gasUsed: 1n, events: [{ type: "wasm", attributes: [
  { key: "action", value: "place_snapshot_vote" }, { key: "sender", value: voter }, { key: "gauge_id", value: "0" }, { key: "epoch_id", value: "2" }, { key: "option_count", value: "1" },
  { key: "snapshot_height", value: "40000002" }, { key: "voting_power", value: "100" }, { key: "participating_power", value: "500" }, { key: "total_cast", value: "400" },
] }] };

function setup() {
  const getKey = vi.fn(async () => ({ bech32Address: voter }));
  Object.defineProperty(window, "keplr", { configurable: true, value: { enable: vi.fn(async () => undefined), getKey, getOfflineSigner: vi.fn(() => ({})) } });
  const signing = { simulate: vi.fn(async () => 100_000), execute: vi.fn(async () => success), disconnect: vi.fn() };
  cosmwasm.connectWithSigner.mockResolvedValue(signing);
  const loadActionContext = vi.fn().mockResolvedValueOnce(gaugeContext).mockResolvedValueOnce(gaugeContext).mockResolvedValueOnce(after).mockResolvedValueOnce(after);
  const gaugeSource: GaugeDataSource = { loadGauge: vi.fn(async () => gaugeData), loadActionContext };
  const bountySource: VoiceDataSource = { loadLedger: vi.fn(async () => ledger) };
  return { access: createBrowserTransactionAccess(config, bountySource, "keplr", undefined, gaugeSource), signing, getKey, loadActionContext };
}
describe("production gauge browser transaction adapter", () => {
  beforeEach(() => { cosmwasm.connectWithSigner.mockReset(); delete (window as Window & { keplr?: unknown }).keplr; });
  it("uses the central review, repeats canonical reconstruction, and confirms event plus ballot", async () => {
    const fixture = setup(); await fixture.access.connect(); const review = await fixture.access.prepare(intent);
    await expect(fixture.access.submit(review)).resolves.toEqual({ status: "confirmed", txHash: "GAUGE_HASH", height: 40_000_101, confirmationStatus: "confirmed", refreshStatus: "refreshed", explorerUrl: "https://www.mintscan.io/juno/tx/GAUGE_HASH" });
    expect(fixture.signing.execute).toHaveBeenCalledWith(voter, config.gaugeContract, intent.executeMessage, review.fee, "", []);
    expect(fixture.loadActionContext.mock.calls).toEqual([[voter], [voter], [voter], [voter]]);
    expect(fixture.getKey.mock.invocationCallOrder.at(-1)).toBeLessThan(fixture.signing.execute.mock.invocationCallOrder[0]);
  });
  it("preserves known-hash uncertainty and consumes the review when canonical confirmation fails", async () => {
    const fixture = setup(); await fixture.access.connect(); const review = await fixture.access.prepare(intent);
    fixture.loadActionContext.mockReset().mockResolvedValueOnce(gaugeContext).mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(fixture.access.submit(review)).resolves.toEqual({ status: "unknown", txHash: "GAUGE_HASH", explorerUrl: "https://www.mintscan.io/juno/tx/GAUGE_HASH" });
    await expect(fixture.access.submit(review)).rejects.toThrow("no longer available");
    expect(fixture.signing.execute).toHaveBeenCalledTimes(1);
  });
  it("preserves the known hash when refreshed same-preference ballot state is stale", async () => {
    const fixture = setup(); await fixture.access.connect(); const review = await fixture.access.prepare(intent);
    fixture.loadActionContext.mockReset().mockResolvedValue(gaugeContext);
    await expect(fixture.access.submit(review)).resolves.toEqual({ status: "unknown", txHash: "GAUGE_HASH", explorerUrl: "https://www.mintscan.io/juno/tx/GAUGE_HASH" });
    expect(fixture.signing.execute).toHaveBeenCalledTimes(1);
  });
});
