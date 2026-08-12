import { describe, expect, it, vi } from "vitest";
import { TransactionSafetyError, createTransactionFlow, type TransactionDependencies } from "./transactions";
import { WalletSession, type WalletConnector } from "./wallet";

const identity = { chainId: "juno-1", address: "juno1sender" } as const;
const contract = "juno1contract";
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
    wallet,
    dependencies,
    changeAccount() {
      current = { ...identity, address: "juno1other" };
      listener?.();
    },
  };
}
const intent = {
  chainId: "juno-1",
  contract,
  executeMessage: { contribute: { bounty_id: 7 } },
  funds: [{ denom: "ujuno", amount: "250000" }],
  consequences: ["Send 0.25 JUNO to bounty #7 escrow."],
  expectedStateFingerprint: "bounty:7:v3",
  allowedMessages: ["contribute"],
} as const;

describe("exact pre-sign transaction review", () => {
  it("shows and signs the exact sender, chain, contract, message, funds, fee and consequences", async () => {
    const { wallet, dependencies } = setup();
    await wallet.connect();
    const flow = createTransactionFlow(dependencies);
    const review = await flow.prepare(intent);
    expect(review).toMatchObject({
      sender: identity.address,
      chainId: "juno-1",
      contract,
      executeMessage: intent.executeMessage,
      funds: intent.funds,
      fee: { gas: "180000", amount: [{ denom: "ujuno", amount: "4500" }] },
      consequences: intent.consequences,
      canonicalState: { fingerprint: "bounty:7:v3", height: 100 },
    });
    const result = await flow.submit(review);
    expect(dependencies.signAndBroadcast).toHaveBeenCalledWith({
      sender: review.sender,
      chainId: review.chainId,
      contract: review.contract,
      executeMessage: review.executeMessage,
      funds: review.funds,
      fee: review.fee,
    });
    expect(result).toEqual({
      status: "confirmed",
      txHash: "ABC123",
      height: 101,
      explorerUrl: "https://www.mintscan.io/juno/tx/ABC123",
    });
    expect(dependencies.refreshCanonical).toHaveBeenCalledOnce();
    expect(dependencies.readCanonicalState).toHaveBeenCalledTimes(2);
  });

  it("revalidates immediately before construction and signing and refuses stale state", async () => {
    const { wallet, dependencies } = setup();
    await wallet.connect();
    vi.mocked(dependencies.readCanonicalState)
      .mockResolvedValueOnce({ fingerprint: "bounty:7:v3", height: 100 })
      .mockResolvedValueOnce({ fingerprint: "bounty:7:v4", height: 101 });
    const flow = createTransactionFlow(dependencies);
    const review = await flow.prepare(intent);
    await expect(flow.submit(review)).rejects.toMatchObject({ code: "stale_state" });
    expect(dependencies.signAndBroadcast).not.toHaveBeenCalled();
  });

  it("refuses account changes and exact-review tampering", async () => {
    const { wallet, dependencies, changeAccount } = setup();
    await wallet.connect();
    const flow = createTransactionFlow(dependencies);
    const review = await flow.prepare(intent);
    changeAccount();
    await wallet.settled();
    await expect(flow.submit(review)).rejects.toMatchObject({ code: "stale_identity" });
    expect(dependencies.signAndBroadcast).not.toHaveBeenCalled();
    expect(() => {
      (review.executeMessage as { contribute: { bounty_id: number } }).contribute.bounty_id = 8;
    }).toThrow();
  });

  it("requires a caller allowlist and makes privileged messages impossible", async () => {
    const { wallet, dependencies } = setup();
    await wallet.connect();
    const flow = createTransactionFlow(dependencies);
    await expect(flow.prepare({ ...intent, executeMessage: { pause: {} }, allowedMessages: ["pause"] }))
      .rejects.toMatchObject({ code: "message_forbidden" });
    await expect(flow.prepare({ ...intent, allowedMessages: [] }))
      .rejects.toBeInstanceOf(TransactionSafetyError);
  });
});

describe("broadcast outcomes and duplicate protection", () => {
  it.each(["pending", "unknown"] as const)("preserves %s and will not retry an ambiguous broadcast", async (status) => {
    const { wallet, dependencies } = setup();
    await wallet.connect();
    vi.mocked(dependencies.signAndBroadcast).mockResolvedValueOnce(
      status === "pending" ? { status, txHash: "PEND" } : { status },
    );
    const flow = createTransactionFlow(dependencies);
    const review = await flow.prepare(intent);
    await expect(flow.submit(review)).resolves.toMatchObject({ status });
    await expect(flow.submit(review)).rejects.toMatchObject({ code: "duplicate_broadcast" });
    expect(dependencies.signAndBroadcast).toHaveBeenCalledTimes(1);
  });

  it("classifies wallet rejection and chain failure without refreshing canonical data", async () => {
    const { wallet, dependencies } = setup();
    await wallet.connect();
    vi.mocked(dependencies.signAndBroadcast).mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
    const flow = createTransactionFlow(dependencies);
    const rejected = await flow.submit(await flow.prepare(intent));
    expect(rejected).toEqual({ status: "rejected", reason: "User rejected" });
    expect(dependencies.refreshCanonical).not.toHaveBeenCalled();
  });

  it("preserves an explicit failed-chain outcome without claiming confirmation", async () => {
    const { wallet, dependencies } = setup();
    await wallet.connect();
    vi.mocked(dependencies.signAndBroadcast).mockResolvedValueOnce({
      status: "failed",
      txHash: "FAILED1",
      reason: "out of gas",
    });
    const flow = createTransactionFlow(dependencies);
    await expect(flow.submit(await flow.prepare(intent))).resolves.toEqual({
      status: "failed",
      txHash: "FAILED1",
      reason: "out of gas",
    });
    expect(dependencies.refreshCanonical).not.toHaveBeenCalled();
  });
});
