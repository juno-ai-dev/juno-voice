import { beforeEach, describe, expect, it } from "vitest";
import { clearRegistrySubmission, loadLatestRegistrySubmission, loadRegistrySubmission, saveRegistrySubmission } from "./registrySubmissionState";
import { config } from "./test/bountyFixtures";

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const scope = { sender, chainId: config.chainId, contract: config.registryContract };
const evidence = { ...scope, version: 1 as const, action: "register_project" as const, status: "pending" as const,
  txHash: "KNOWN", explorerUrl: "https://www.mintscan.io/juno/tx/KNOWN" };

describe("registry uncertainty session store", () => {
  beforeEach(() => sessionStorage.clear());

  it("stores only versioned public identity and evidence, scoped to sender, chain, and contract", () => {
    expect(saveRegistrySubmission(evidence)).toBe(true);
    expect(loadRegistrySubmission(scope)).toEqual({ kind: "uncertain", evidence });
    expect(loadLatestRegistrySubmission(scope)).toEqual({ kind: "uncertain", evidence });
    expect(loadRegistrySubmission({ ...scope, sender: "juno1different" })).toBeNull();
    const values = Array.from({ length: sessionStorage.length }, (_, index) => JSON.parse(sessionStorage.getItem(sessionStorage.key(index)!)!));
    const raw = values.find((value) => "action" in value);
    expect(Object.keys(raw).sort()).toEqual(["action", "chainId", "contract", "explorerUrl", "sender", "status", "txHash", "version"]);
  });

  it.each([
    "not json",
    JSON.stringify({ ...evidence, version: 2 }),
    JSON.stringify({ ...evidence, review: { signature: "secret" } }),
    JSON.stringify({ ...evidence, sender: "juno1different" }),
    JSON.stringify({ ...evidence, explorerUrl: "javascript:alert(1)" }),
  ])("fails closed on malformed or mismatched stored data", (malformed) => {
    saveRegistrySubmission(evidence);
    sessionStorage.setItem(sessionStorage.key(0)!, malformed);
    expect(loadRegistrySubmission(scope)).toEqual({ kind: "malformed" });
  });

  it("removes only the matching uncertainty record", () => {
    saveRegistrySubmission(evidence);
    clearRegistrySubmission(scope);
    expect(loadRegistrySubmission(scope)).toBeNull();
    expect(loadLatestRegistrySubmission(scope)).toBeNull();
  });
});
