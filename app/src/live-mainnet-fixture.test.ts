import { describe, expect, it, vi } from "vitest";
import { createDataSource, queries } from "./client";
import { config } from "./test/bountyFixtures";
import fixture from "./test/live-mainnet-empty.json";

describe("live mainnet fixture contract", () => {
  it("binds complete captured query and response shapes to verified provenance", async () => {
    expect(fixture.provenance).toMatchObject({
      chain_id: config.chainId,
      contract_address: config.contract,
      code_id: config.codeId,
      checksum: config.codeChecksum,
    });
    expect(fixture.provenance.observation_height).toBeGreaterThan(0);
    expect(fixture.queries).toEqual({
      config: queries.config(),
      pause: queries.pause(),
      health: queries.health(),
      bounties: queries.bounties(),
    });

    const rpc = {
      queryContractSmart: vi.fn((_address: string, query: object) => {
        if ("config" in query) return Promise.resolve(fixture.responses.config);
        if ("pause" in query) return Promise.resolve(fixture.responses.pause);
        if ("health" in query) return Promise.resolve(fixture.responses.health);
        return Promise.resolve(fixture.responses.bounties);
      }),
      getChainId: vi.fn().mockResolvedValue(fixture.provenance.chain_id),
      getHeight: vi
        .fn()
        .mockResolvedValue(fixture.provenance.observation_height),
      getChainTimeNanos: vi.fn().mockResolvedValue("1700000000000000000"),
      getContract: vi.fn().mockResolvedValue({
        address: fixture.provenance.contract_address,
        codeId: fixture.provenance.code_id,
      }),
      getCodeDetails: vi
        .fn()
        .mockResolvedValue({ checksum: fixture.provenance.checksum }),
      disconnect: vi.fn(),
    };

    const result = await createDataSource(
      config,
      vi.fn().mockResolvedValue(rpc),
    ).loadLedger();
    expect(result.bounties).toEqual([]);
    expect(result.config.native_denom).toBe("ujuno");
    expect(result.health.fully_backed).toBe(true);
    expect(rpc.disconnect).toHaveBeenCalledOnce();
  });
});
