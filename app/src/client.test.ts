import { describe, expect, it, vi } from "vitest";
import { createDataSource, mapBounty, queries } from "./client";
import { bounty, config, ledger } from "./test/bountyFixtures";
const base = () => ({
  queryContractSmart: vi.fn(),
  getChainId: vi.fn().mockResolvedValue("juno-1"),
  getHeight: vi.fn().mockResolvedValue(900),
  getContract: vi
    .fn()
    .mockResolvedValue({ address: config.contract, codeId: 5150 }),
  getCodeDetails: vi.fn().mockResolvedValue({ checksum: config.codeChecksum }),
  disconnect: vi.fn(),
});
describe("mainnet bounty client", () => {
  it("constructs exact queries", () => {
    expect(queries.config()).toEqual({ config: {} });
    expect(queries.pause()).toEqual({ pause: {} });
    expect(queries.health()).toEqual({ health: {} });
    expect(queries.bounties()).toEqual({
      bounties: { start_after: null, limit: 50 },
    });
    expect(queries.bounties(50)).toEqual({
      bounties: { start_after: 50, limit: 50 },
    });
  });
  it("validates uint strings and bounty statuses", () => {
    expect(mapBounty(bounty).id).toBe(1);
    expect(() => mapBounty({ ...bounty, total_contribution: 42 })).toThrow(
      "Malformed bounty",
    );
    expect(() => mapBounty({ ...bounty, status: "invented" })).toThrow(
      "Malformed bounty",
    );
    expect(() =>
      mapBounty({
        ...bounty,
        refund_reason: { moderated: { outcome: "invented", reason: "bad" } },
      }),
    ).toThrow("Malformed refund reason");
  });
  it("checks provenance before querying and loads singleton/page/height concurrently", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation((_a: string, q: object) =>
      Promise.resolve(
        "config" in q
          ? ledger.config
          : "pause" in q
            ? ledger.pause
            : "health" in q
              ? ledger.health
              : { bounties: [bounty] },
      ),
    );
    const result = await createDataSource(
      config,
      vi.fn().mockResolvedValue(rpc),
    ).loadLedger();
    expect(result.bounties).toEqual([bounty]);
    expect(result.observationHeight).toBe(900);
    expect(rpc.queryContractSmart).toHaveBeenCalledTimes(4);
    expect(rpc.disconnect).toHaveBeenCalled();
  });
  it("makes an extra query after a full page", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation(
      (_a: string, q: Record<string, unknown>) => {
        if ("config" in q) return Promise.resolve(ledger.config);
        if ("pause" in q) return Promise.resolve(ledger.pause);
        if ("health" in q) return Promise.resolve(ledger.health);
        const cursor = (q.bounties as { start_after: number | null })
          .start_after;
        return Promise.resolve({
          bounties:
            cursor === null
              ? Array.from({ length: 50 }, (_, i) => ({ ...bounty, id: i + 1 }))
              : [],
        });
      },
    );
    const result = await createDataSource(
      config,
      vi.fn().mockResolvedValue(rpc),
    ).loadLedger();
    expect(result.bounties).toHaveLength(50);
    expect(rpc.queryContractSmart).toHaveBeenCalledWith(
      config.contract,
      queries.bounties(50),
    );
  });
  it("fails repeated/non-increasing IDs", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation((_a: string, q: object) =>
      Promise.resolve(
        "config" in q
          ? ledger.config
          : "pause" in q
            ? ledger.pause
            : "health" in q
              ? ledger.health
              : { bounties: [bounty, { ...bounty, id: 1 }] },
      ),
    );
    await expect(
      createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger(),
    ).rejects.toThrow("Non-increasing bounty IDs");
  });
  it("fails closed before smart queries on provenance mismatch", async () => {
    const rpc = base();
    rpc.getChainId.mockResolvedValue("uni-7");
    await expect(
      createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger(),
    ).rejects.toThrow("Deployment mismatch");
    expect(rpc.queryContractSmart).not.toHaveBeenCalled();
  });
});
