import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGaugeSubmission, gaugeActionFromReview, loadGaugeSubmission, loadLatestGaugeSubmission, saveGaugeSubmission } from "./gaugeSubmissionState";
import { config } from "./test/bountyFixtures";

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const scope = { sender, chainId: config.chainId, contract: config.gaugeContract, gaugeId: 0 as const };
const evidence = { ...scope, version: 1 as const, action: "place_votes" as const, epoch: 2, status: "pending" as const,
  txHash: "GAUGE_KNOWN", explorerUrl: "https://www.mintscan.io/juno/tx/GAUGE_KNOWN" };
const evidenceKey = () => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!)
  .find((key) => sessionStorage.getItem(key)?.includes('"action"'))!;

describe("gauge uncertainty session store", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); clearGaugeSubmission(scope); });

  it("stores only exact versioned public evidence scoped to sender, chain, gauge contract, and gauge id", () => {
    expect(saveGaugeSubmission(evidence)).toBe(true);
    expect(loadGaugeSubmission(scope)).toEqual({ kind: "uncertain", evidence });
    expect(loadLatestGaugeSubmission(scope)).toEqual({ kind: "uncertain", evidence });
    expect(loadGaugeSubmission({ ...scope, sender: "juno1different" })).toBeNull();
    expect(loadGaugeSubmission({ ...scope, contract: config.registryContract })).toBeNull();
    const raw = JSON.parse(sessionStorage.getItem(evidenceKey())!);
    expect(Object.keys(raw).sort()).toEqual(["action", "chainId", "contract", "epoch", "explorerUrl", "gaugeId", "sender", "status", "txHash", "version"]);
  });

  it.each([
    "not json",
    JSON.stringify({ ...evidence, version: 2 }),
    JSON.stringify({ ...evidence, review: { signature: "secret" } }),
    JSON.stringify({ ...evidence, sender: "juno1different" }),
    JSON.stringify({ ...evidence, chainId: "other-1" }),
    JSON.stringify({ ...evidence, contract: config.registryContract }),
    JSON.stringify({ ...evidence, gaugeId: 1 }),
    JSON.stringify({ ...evidence, action: "register_project" }),
    JSON.stringify({ ...evidence, epoch: 0 }),
    JSON.stringify({ ...evidence, epoch: 2.5 }),
    JSON.stringify({ ...evidence, status: "confirmed" }),
    JSON.stringify({ ...evidence, explorerUrl: "javascript:alert(1)" }),
  ])("fails closed on malformed, mismatched, or non-uncertain stored data", (malformed) => {
    saveGaugeSubmission(evidence);
    sessionStorage.setItem(evidenceKey(), malformed);
    expect(loadGaugeSubmission(scope)).toEqual({ kind: "malformed" });
  });

  it("fails closed on storage read exceptions", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(loadGaugeSubmission(scope)).toEqual({ kind: "malformed" });
    expect(loadLatestGaugeSubmission(scope)).toEqual({ kind: "malformed" });
  });

  it("installs both fail-closed sentinels before writes and retains them if either write fails", () => {
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { writes += 1; if (writes === 2) throw new Error("pointer unavailable"); });
    expect(saveGaugeSubmission(evidence)).toBe(false);
    expect(loadGaugeSubmission(scope)).toEqual({ kind: "malformed" });
    expect(loadLatestGaugeSubmission(scope)).toEqual({ kind: "malformed" });
  });

  it("removes only matching gauge uncertainty after successful terminal reconciliation", () => {
    saveGaugeSubmission(evidence);
    expect(clearGaugeSubmission(scope)).toBe(true);
    expect(loadGaugeSubmission(scope)).toBeNull();
    expect(loadLatestGaugeSubmission(scope)).toBeNull();
  });

  it("derives only exact pinned gauge actions from reviewed messages", () => {
    expect(gaugeActionFromReview({ open_epoch: { gauge: 0 } })).toBe("open_epoch");
    expect(gaugeActionFromReview({ execute: { gauge: 0 } })).toBe("execute");
    expect(gaugeActionFromReview({ place_votes: { gauge: 0, votes: null } })).toBe("remove_votes");
    expect(gaugeActionFromReview({ place_votes: { gauge: 0, votes: [] } })).toBe("place_votes");
    for (const message of [{ open_epoch: { gauge: 1 } }, { open_epoch: { gauge: 0, secret: "x" } }, { place_votes: { gauge: 0 } }, { execute: { gauge: 0 }, extra: {} }])
      expect(gaugeActionFromReview(message)).toBeNull();
  });
});
