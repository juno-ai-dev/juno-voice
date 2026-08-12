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

const singletonResponse = (query: object) =>
  "config" in query
    ? ledger.config
    : "pause" in query
      ? ledger.pause
      : "health" in query
        ? ledger.health
        : { bounties: [bounty] };

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

  it("validates uint strings, statuses, refund reasons, projects, and timestamp bounds", () => {
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
    expect(() =>
      mapBounty({ ...bounty, project_candidate: { project_id: 7 } }),
    ).toThrow("Malformed project candidate");
    expect(() =>
      mapBounty({ ...bounty, expires_at: "18446744073709551616" }),
    ).toThrow("Malformed bounty");
  });

  it("starts singleton, first-page, and height reads concurrently after provenance", async () => {
    const rpc = base();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rpc.getHeight.mockImplementation(async () => {
      await gate;
      return 900;
    });
    rpc.queryContractSmart.mockImplementation(
      async (_address: string, query: object) => {
        await gate;
        return singletonResponse(query);
      },
    );

    const resultPromise = createDataSource(
      config,
      vi.fn().mockResolvedValue(rpc),
    ).loadLedger();
    await vi.waitFor(() => {
      expect(rpc.queryContractSmart).toHaveBeenCalledTimes(4);
      expect(rpc.getHeight).toHaveBeenCalledOnce();
    });
    release();
    const result = await resultPromise;

    expect(result.bounties).toEqual([bounty]);
    expect(result.observationHeight).toBe(900);
    expect(rpc.disconnect).toHaveBeenCalledOnce();
  });

  it("makes an extra query after a full page", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation(
      (_address: string, query: Record<string, unknown>) => {
        if ("config" in query) return Promise.resolve(ledger.config);
        if ("pause" in query) return Promise.resolve(ledger.pause);
        if ("health" in query) return Promise.resolve(ledger.health);
        const cursor = (query.bounties as { start_after: number | null })
          .start_after;
        return Promise.resolve({
          bounties:
            cursor === null
              ? Array.from({ length: 50 }, (_, index) => ({
                  ...bounty,
                  id: index + 1,
                }))
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

  it("fails repeated/non-increasing IDs and disconnects", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation(
      (_address: string, query: object) =>
        Promise.resolve(
          "config" in query
            ? ledger.config
            : "pause" in query
              ? ledger.pause
              : "health" in query
                ? ledger.health
                : { bounties: [bounty, { ...bounty, id: 1 }] },
        ),
    );
    await expect(
      createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger(),
    ).rejects.toThrow("Non-increasing bounty IDs");
    expect(rpc.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "chain",
      (rpc: ReturnType<typeof base>) =>
        rpc.getChainId.mockResolvedValue("uni-7"),
    ],
    [
      "address",
      (rpc: ReturnType<typeof base>) =>
        rpc.getContract.mockResolvedValue({
          address: "juno1wrong",
          codeId: 5150,
        }),
    ],
    [
      "code ID",
      (rpc: ReturnType<typeof base>) =>
        rpc.getContract.mockResolvedValue({
          address: config.contract,
          codeId: 5149,
        }),
    ],
    [
      "checksum",
      (rpc: ReturnType<typeof base>) =>
        rpc.getCodeDetails.mockResolvedValue({ checksum: "00".repeat(32) }),
    ],
  ])(
    "fails closed before smart queries on %s mismatch",
    async (_name, mutate) => {
      const rpc = base();
      mutate(rpc);
      await expect(
        createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger(),
      ).rejects.toThrow("Deployment mismatch");
      expect(rpc.queryContractSmart).not.toHaveBeenCalled();
      expect(rpc.disconnect).toHaveBeenCalledOnce();
    },
  );

  it("disconnects when singleton response validation fails", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation(
      (_address: string, query: object) =>
        Promise.resolve(
          "config" in query
            ? { ...ledger.config, min_contribution: 42 }
            : "pause" in query
              ? ledger.pause
              : "health" in query
                ? ledger.health
                : { bounties: [] },
        ),
    );
    await expect(
      createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger(),
    ).rejects.toThrow("Malformed config");
    expect(rpc.disconnect).toHaveBeenCalledOnce();
  });
});
