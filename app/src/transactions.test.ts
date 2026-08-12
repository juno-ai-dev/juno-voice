import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { describe, expect, it, vi } from "vitest";
import {
  BroadcastDependencyError,
  TransactionSafetyError,
  createTransactionFlow,
  type TransactionDependencies,
  type TransactionIntent,
} from "./transactions";
import { DEFAULT_BOUNTY_CONTRACT } from "./config";
import { WalletSession, type WalletConnector } from "./wallet";

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const otherSender = "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac";
const identity = { chainId: "juno-1", address: sender } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  let listener: (() => void) | undefined;
  let current: { chainId: string; address: string } = identity;
  const walletPort: WalletConnector = {
    kind: "leap",
    connect: vi.fn(async () => current),
    readIdentity: vi.fn(async () => current),
    onChange(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  const wallet = new WalletSession(walletPort, "juno-1");
  const dependencies: TransactionDependencies = {
    wallet,
    readCanonicalState: vi.fn(async () => ({ fingerprint: "bounty:7:v3", height: 100 })),
    estimateFee: vi.fn(async () => ({ gas: "180000", amount: [{ denom: "ujuno", amount: "4500" }] })),
    signAndBroadcast: vi.fn(async () => ({ status: "confirmed" as const, txHash: "ABC123", height: 101 })),
    refreshCanonical: vi.fn(async () => undefined),
    explorerBaseUrl: "https://www.mintscan.io/juno",
  };
  return {
    wallet, walletPort, dependencies,
    changeAccount() {
      current = { ...identity, address: otherSender };
      listener?.();
    },
  };
}
const intent: TransactionIntent = {
  chainId: "juno-1",
  contract: DEFAULT_BOUNTY_CONTRACT,
  executeMessage: { contribute: { bounty_id: 7 } },
  funds: [{ denom: "ujuno", amount: "250000" }],
  consequences: ["Send 0.25 JUNO to bounty #7 escrow."],
  expectedStateFingerprint: "bounty:7:v3",
};

async function prepared() {
  const fixture = setup();
  await fixture.wallet.connect();
  const flow = createTransactionFlow(fixture.dependencies);
  return { ...fixture, flow, review: await flow.prepare(intent) };
}

describe("exact pre-sign transaction review", () => {
  it("shows and signs the exact disclosed request and reports successful refresh", async () => {
    const { dependencies, flow, review } = await prepared();
    expect(review).toMatchObject({ sender, chainId: "juno-1", contract: DEFAULT_BOUNTY_CONTRACT,
      executeMessage: intent.executeMessage, funds: intent.funds,
      fee: { gas: "180000", amount: [{ denom: "ujuno", amount: "4500" }] },
      consequences: intent.consequences, canonicalState: { fingerprint: "bounty:7:v3", height: 100 } });
    await expect(flow.submit(review)).resolves.toEqual({ status: "confirmed", confirmationStatus: "confirmed",
      refreshStatus: "refreshed", txHash: "ABC123", height: 101,
      explorerUrl: "https://www.mintscan.io/juno/tx/ABC123" });
    expect(dependencies.signAndBroadcast).toHaveBeenCalledWith({ sender: review.sender, chainId: review.chainId,
      contract: review.contract, executeMessage: review.executeMessage, funds: review.funds, fee: review.fee });
    expect(dependencies.readCanonicalState).toHaveBeenCalledTimes(2);
  });

  it("revalidates canonical state and then exact identity immediately before signing", async () => {
    const fixture = setup();
    await fixture.wallet.connect();
    const gate = deferred<{ fingerprint: string; height: number }>();
    vi.mocked(fixture.dependencies.readCanonicalState)
      .mockResolvedValueOnce({ fingerprint: "bounty:7:v3", height: 100 })
      .mockReturnValueOnce(gate.promise);
    const flow = createTransactionFlow(fixture.dependencies);
    const review = await flow.prepare(intent);
    const submission = flow.submit(review);
    await vi.waitFor(() => expect(fixture.dependencies.readCanonicalState).toHaveBeenCalledTimes(2));
    fixture.changeAccount(); // synchronously revokes the reviewed authorization while canonical IO is in flight
    gate.resolve({ fingerprint: "bounty:7:v3", height: 101 });
    await expect(submission).rejects.toMatchObject({ code: "stale_identity" });
    expect(fixture.dependencies.signAndBroadcast).not.toHaveBeenCalled();
  });

  it("refuses stale canonical state and concurrent submits before broadcasting", async () => {
    const { dependencies, flow, review } = await prepared();
    vi.mocked(dependencies.readCanonicalState).mockResolvedValueOnce({ fingerprint: "changed", height: 101 });
    const one = flow.submit(review);
    await expect(flow.submit(review)).rejects.toMatchObject({ code: "duplicate_broadcast" });
    await expect(one).rejects.toMatchObject({ code: "stale_state" });
    expect(dependencies.signAndBroadcast).not.toHaveBeenCalled();
  });
});

describe("address and centrally-owned execute policy", () => {
  it.each([
    ["bad checksum", `${sender.slice(0, -1)}x`],
    ["mixed case", `J${sender.slice(1)}`],
    ["wrong prefix", toBech32("cosmos", fromBech32(sender).data)],
    ["wrong account length", toBech32("juno", new Uint8Array(21))],
  ])("rejects a %s sender", async (_, address) => {
    const fixture = setup();
    vi.mocked(fixture.walletPort.connect).mockResolvedValueOnce({ chainId: "juno-1", address });
    await expect(fixture.wallet.connect()).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it.each([
    ["bad checksum", `${DEFAULT_BOUNTY_CONTRACT.slice(0, -1)}x`],
    ["mixed case", `J${DEFAULT_BOUNTY_CONTRACT.slice(1)}`],
    ["wrong prefix", toBech32("cosmos", fromBech32(DEFAULT_BOUNTY_CONTRACT).data)],
    ["wrong contract length", toBech32("juno", new Uint8Array(20))],
  ])("rejects a %s contract", async (_, contract) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    await expect(createTransactionFlow(dependencies).prepare({ ...intent, contract }))
      .rejects.toMatchObject({ code: "invalid_transaction" });
  });

  it.each(["moderate", "graduate_project", "pause_new_activity", "unpause_new_activity", "update_roles", "update_config"])(
    "rejects privileged action %s even with an otherwise valid request", async (action) => {
      const { wallet, dependencies } = setup(); await wallet.connect();
      await expect(createTransactionFlow(dependencies).prepare({ ...intent, executeMessage: { [action]: {} } }))
        .rejects.toMatchObject({ code: "message_forbidden" });
    });
  it("rejects unknown future actions and malformed schemas from the central positive allowlist", async () => {
    const { wallet, dependencies } = setup(); await wallet.connect(); const flow = createTransactionFlow(dependencies);
    await expect(flow.prepare({ ...intent, executeMessage: { future_admin_action: {} } }))
      .rejects.toMatchObject({ code: "message_forbidden" });
    await expect(flow.prepare({ ...intent, executeMessage: { contribute: { bounty_id: "7" } } }))
      .rejects.toMatchObject({ code: "message_forbidden" });
  });
});

describe("strict canonical JSON review", () => {
  it.each([
    ["NaN", { contribute: { bounty_id: Number.NaN } }], ["Infinity", { contribute: { bounty_id: Infinity } }],
    ["BigInt", { contribute: { bounty_id: 7n } }], ["undefined", { contribute: { bounty_id: 7, x: undefined } }],
    ["symbol", { contribute: { bounty_id: 7, x: Symbol("x") } }],
    ["nonplain", { contribute: Object.assign(new Date(), { bounty_id: 7 }) }],
    ["sparse", { contribute: { bounty_id: 7, x: Array(1) } }],
    ["symbol key", Object.assign({ contribute: { bounty_id: 7 } }, { [Symbol("hidden")]: true })],
    ["getter", { contribute: Object.defineProperty({ bounty_id: 7 }, "hidden", { enumerable: true, get: () => true }) }],
  ])("rejects %s rather than permitting canonical collisions", async (_, executeMessage) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    await expect(createTransactionFlow(dependencies).prepare({ ...intent, executeMessage }))
      .rejects.toBeInstanceOf(TransactionSafetyError);
  });
  it("accepts nested finite JSON and detects detached review tampering", async () => {
    const { flow, review } = await prepared();
    const clone = structuredClone(review) as typeof review;
    (clone.executeMessage as { contribute: { bounty_id: number } }).contribute.bounty_id = 8;
    await expect(flow.submit(clone)).rejects.toMatchObject({ code: "invalid_review" });
  });
});

describe("broadcast and confirmation outcomes", () => {
  it.each(["timeout", "disconnect", "post-broadcast"])("maps typed %s transport uncertainty to unknown and preserves hash", async (kind) => {
    const { dependencies, flow, review } = await prepared();
    vi.mocked(dependencies.signAndBroadcast).mockRejectedValueOnce(
      new BroadcastDependencyError("transport", kind, { txHash: kind === "post-broadcast" ? "KNOWN" : undefined }));
    await expect(flow.submit(review)).resolves.toEqual({ status: "unknown",
      ...(kind === "post-broadcast" ? { txHash: "KNOWN" } : {}) });
  });
  it("uses typed rejection and preserves authoritative chain failure", async () => {
    const first = await prepared();
    vi.mocked(first.dependencies.signAndBroadcast).mockRejectedValueOnce(new BroadcastDependencyError("rejected", "User rejected"));
    await expect(first.flow.submit(first.review)).resolves.toEqual({ status: "rejected", reason: "User rejected" });
    const second = await prepared();
    vi.mocked(second.dependencies.signAndBroadcast).mockResolvedValueOnce({ status: "failed", txHash: "FAILED1", reason: "out of gas" });
    await expect(second.flow.submit(second.review)).resolves.toEqual({ status: "failed", txHash: "FAILED1", reason: "out of gas" });
  });
  it("never loses a confirmed transaction when canonical refresh fails", async () => {
    const { dependencies, flow, review } = await prepared();
    vi.mocked(dependencies.refreshCanonical).mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(flow.submit(review)).resolves.toEqual({ status: "confirmed", confirmationStatus: "confirmed",
      refreshStatus: "failed", txHash: "ABC123", height: 101,
      explorerUrl: "https://www.mintscan.io/juno/tx/ABC123" });
  });
});
