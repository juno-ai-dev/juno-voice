import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { describe, expect, it, vi } from "vitest";
import {
  BroadcastDependencyError,
  TransactionSafetyError,
  TransactionReviewRegistry,
  createTransactionFlow,
  type TransactionDependencies,
  type TransactionIntent,
} from "./transactions";
import { DEFAULT_BOUNTY_CONTRACT, DEFAULT_REGISTRY_CONTRACT } from "./config";
import { WalletSession, type WalletConnector } from "./wallet";

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const otherSender = toBech32("juno", new Uint8Array(20).fill(3));
const identity = { chainId: "juno-1", address: sender } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(reviewRegistry = new TransactionReviewRegistry()) {
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
    reviewRegistry,
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
  it("binds unguessable reviews to one flow and prevents cross-flow and recreated-flow replay", async () => {
    const registry = new TransactionReviewRegistry(); const fixture = setup(registry); await fixture.wallet.connect();
    const first = createTransactionFlow(fixture.dependencies); const review = await first.prepare(intent);
    expect(review.reviewId).toMatch(/^[0-9a-f-]{36}$/); expect(review.flowBinding).toMatch(/^[0-9a-f-]{36}$/);
    const otherFlow = createTransactionFlow(fixture.dependencies);
    await expect(otherFlow.submit(review)).rejects.toMatchObject({ code: "invalid_review" });
    await first.submit(review);
    const recreated = createTransactionFlow(fixture.dependencies);
    await expect(recreated.submit(review)).rejects.toMatchObject({ code: "invalid_review" });
    expect(fixture.dependencies.signAndBroadcast).toHaveBeenCalledTimes(1);
  });
});

describe("address and centrally-owned execute policy", () => {
  it.each([
    ["register_project", { project_id: "alpha", metadata_uri: "https://example.com/a", metadata_digest: `sha256:${"a".repeat(64)}`, payout_address: sender }, [{ denom: "ujuno", amount: "1000000" }]],
    ["update_pending_metadata", { project_id: "alpha", metadata_uri: "https://example.com/a", metadata_digest: `sha256:${"a".repeat(64)}` }, []],
    ["propose_payout_address", { project_id: "alpha", address: sender }, []],
    ["cancel_payout_address_change", { project_id: "alpha" }, []],
    ["accept_payout_address", { project_id: "alpha" }, []],
    ["claim_registration_bond", { project_id: "alpha" }, []],
    ["retire", { project_id: "alpha", reason: { code: "voluntary_retirement", note: "done" } }, []],
  ])("allows exact registry public action %s", async (action, body, funds) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    await expect(createTransactionFlow(dependencies).prepare({ ...intent, contract: DEFAULT_REGISTRY_CONTRACT,
      executeMessage: { [action]: body }, funds })).resolves.toMatchObject({ contract: DEFAULT_REGISTRY_CONTRACT, funds });
  });
  it("rejects privileged registry actions and non-voluntary retirement", async () => {
    const { wallet, dependencies } = setup(); await wallet.connect(); const flow = createTransactionFlow(dependencies);
    for (const action of ["review_registration", "suspend", "override_project_status", "stop", "resume", "update_curator", "update_economic_config"])
      await expect(flow.prepare({ ...intent, contract: DEFAULT_REGISTRY_CONTRACT, executeMessage: { [action]: {} }, funds: [] })).rejects.toMatchObject({ code: "message_forbidden" });
    await expect(flow.prepare({ ...intent, contract: DEFAULT_REGISTRY_CONTRACT, executeMessage: { retire: { project_id: "alpha", reason: { code: "governance_override", note: "no" } } }, funds: [] })).rejects.toMatchObject({ code: "message_forbidden" });
  });
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
    await expect(flow.prepare({ ...intent, executeMessage: { contribute: { bounty_id: -0 } } }))
      .rejects.toMatchObject({ code: "invalid_transaction" });
  });
  it("allows only the exact validated create-bounty digest and project-candidate shape", async () => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    const flow = createTransactionFlow(dependencies), digest = `sha256:${"ab".repeat(32)}`;
    const create = { ...intent, executeMessage: { create_bounty: { title: "Ship tooling", summary: "Useful tooling",
      acceptance_criteria: "Tests pass", content_uri: "ipfs://bafyterms", content_digest: digest,
      expires_at: "1800000000000000000", project_candidate: {
        project_id: "tooling-1", metadata_uri: "ipfs://bafyproject", metadata_digest: digest,
      } } } };
    await expect(flow.prepare(create)).resolves.toMatchObject({ executeMessage: create.executeMessage });
    await expect(flow.prepare({ ...create, executeMessage: { create_bounty: {
      ...create.executeMessage.create_bounty, content_digest: "ab".repeat(32),
    } } })).rejects.toMatchObject({ code: "message_forbidden" });
    await expect(flow.prepare({ ...create, executeMessage: { create_bounty: {
      ...create.executeMessage.create_bounty, project_candidate: {
        ...create.executeMessage.create_bounty.project_candidate, project_id: "INVALID_ID",
      },
    } } })).rejects.toMatchObject({ code: "message_forbidden" });
  });
  it.each([
    ["number", 1], ["null", null], ["object", {}], ["boolean", true], ["empty", ""], ["whitespace", "   "],
  ])("rejects a %s consequence with a normalized safety error", async (_, consequence) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    await expect(createTransactionFlow(dependencies).prepare({ ...intent, consequences: [consequence] as never }))
      .rejects.toMatchObject({ name: "TransactionSafetyError", code: "invalid_transaction" });
  });
  it.each([
    ["no funds", []], ["zero", [{ denom: "ujuno", amount: "0" }]],
    ["duplicate", [{ denom: "ujuno", amount: "1" }, { denom: "ujuno", amount: "2" }]],
    ["other denom", [{ denom: "uatom", amount: "1" }]],
    ["Uint128 overflow", [{ denom: "ujuno", amount: "340282366920938463463374607431768211456" }]],
  ])("rejects contribute intent with %s", async (_, funds) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    await expect(createTransactionFlow(dependencies).prepare({ ...intent, funds }))
      .rejects.toMatchObject({ code: "invalid_transaction" });
    expect(dependencies.estimateFee).not.toHaveBeenCalled();
  });
  it("accepts lossless Uint128 and gas boundaries", async () => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    vi.mocked(dependencies.estimateFee).mockResolvedValueOnce({ gas: String(Number.MAX_SAFE_INTEGER),
      amount: [{ denom: "ujuno", amount: "340282366920938463463374607431768211455" }] });
    const review = await createTransactionFlow(dependencies).prepare({ ...intent,
      funds: [{ denom: "ujuno", amount: "340282366920938463463374607431768211455" }] });
    expect(review.fee.gas).toBe("9007199254740991");
  });
  it.each([
    ["zero gas", { gas: "0", amount: [{ denom: "ujuno", amount: "1" }] }],
    ["unsafe gas", { gas: "9007199254740992", amount: [{ denom: "ujuno", amount: "1" }] }],
    ["zero coins", { gas: "1", amount: [] }],
    ["duplicate coins", { gas: "1", amount: [{ denom: "ujuno", amount: "1" }, { denom: "ujuno", amount: "1" }] }],
    ["other denom", { gas: "1", amount: [{ denom: "uatom", amount: "1" }] }],
    ["fee overflow", { gas: "1", amount: [{ denom: "ujuno", amount: "340282366920938463463374607431768211456" }] }],
  ])("rejects estimator output with %s before signer", async (_, fee) => {
    const { wallet, dependencies } = setup(); await wallet.connect(); vi.mocked(dependencies.estimateFee).mockResolvedValueOnce(fee);
    await expect(createTransactionFlow(dependencies).prepare(intent)).rejects.toMatchObject({ code: "invalid_transaction" });
    expect(dependencies.signAndBroadcast).not.toHaveBeenCalled();
  });
});

describe("strict canonical JSON review", () => {
  it("rejects negative zero and prevents a reviewed zero from being replaced by negative zero", async () => {
    const fixture = setup(); await fixture.wallet.connect(); const flow = createTransactionFlow(fixture.dependencies);
    const review = await flow.prepare({ ...intent, executeMessage: { contribute: { bounty_id: 0 } } });
    const tampered = structuredClone(review) as typeof review;
    (tampered.executeMessage as { contribute: { bounty_id: number } }).contribute.bounty_id = -0;
    await expect(flow.submit(tampered)).rejects.toMatchObject({ code: "invalid_review" });
    expect(fixture.dependencies.signAndBroadcast).not.toHaveBeenCalled();
  });
  it.each([
    ["null object prototype", () => Object.assign(Object.create(null) as object, { contribute: { bounty_id: 7 } })],
    ["custom object prototype", () => Object.assign(Object.create({ inherited: true }) as object, { contribute: { bounty_id: 7 } })],
    ["null array prototype", () => { const value = ["disclose"]; Object.setPrototypeOf(value, null); return value; }],
    ["custom array prototype", () => { const value = ["disclose"]; Object.setPrototypeOf(value, Object.create(Array.prototype)); return value; }],
  ])("normalizes rejection of a %s", async (_, make) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    const value = make();
    const candidate = Array.isArray(value)
      ? { ...intent, consequences: value as string[] }
      : { ...intent, executeMessage: value as TransactionIntent["executeMessage"] };
    await expect(createTransactionFlow(dependencies).prepare(candidate))
      .rejects.toMatchObject({ name: "TransactionSafetyError", code: "invalid_transaction" });
  });
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
  it.each([
    ["array string key", () => Object.assign(["ok"], { hidden: true })],
    ["array symbol key", () => Object.assign(["ok"], { [Symbol("hidden")]: true })],
    ["array accessor", () => Object.defineProperty(["ok"], "0", { enumerable: true, configurable: true, get: () => "ok" })],
    ["array descriptor anomaly", () => Object.defineProperty(["ok"], "0", { enumerable: true, configurable: false, writable: true, value: "ok" })],
    ["object descriptor anomaly", () => Object.defineProperty({}, "contribute", { enumerable: true, configurable: false, writable: true, value: { bounty_id: 7 } })],
  ])("rejects %s", async (_, make) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    await expect(createTransactionFlow(dependencies).prepare({ ...intent, consequences: make() as string[] }))
      .rejects.toMatchObject({ code: "invalid_transaction" });
  });
  it("normalizes intent and canonical-state cycles and structuredClone failures", async () => {
    const first = setup(); await first.wallet.connect(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await expect(createTransactionFlow(first.dependencies).prepare({ ...intent, executeMessage: cyclic }))
      .rejects.toBeInstanceOf(TransactionSafetyError);
    const second = setup(); await second.wallet.connect();
    vi.mocked(second.dependencies.readCanonicalState).mockResolvedValueOnce(cyclic as never);
    await expect(createTransactionFlow(second.dependencies).prepare(intent)).rejects.toMatchObject({ code: "invalid_transaction" });
    const third = setup(); await third.wallet.connect();
    const original = globalThis.structuredClone; vi.stubGlobal("structuredClone", () => { throw new DOMException("no", "DataCloneError"); });
    await expect(createTransactionFlow(third.dependencies).prepare(intent)).rejects.toBeInstanceOf(TransactionSafetyError);
    vi.stubGlobal("structuredClone", original);
  });
});

describe("exact Coin and FeeEstimate runtime schemas", () => {
  const coinVariants = () => {
    const extra = { denom: "ujuno", amount: "1", memo: "hidden" };
    const symbol = Object.assign({ denom: "ujuno", amount: "1" }, { [Symbol("hidden")]: true });
    const accessor = Object.defineProperty({ denom: "ujuno" }, "amount", { enumerable: true, configurable: true, get: () => "1" });
    const nullPrototype = Object.assign(Object.create(null) as object, { denom: "ujuno", amount: "1" });
    const customPrototype = Object.assign(Object.create({ inherited: true }) as object, { denom: "ujuno", amount: "1" });
    return [["extra enumerable key", extra], ["symbol key", symbol], ["accessor", accessor],
      ["null prototype", nullPrototype], ["custom prototype", customPrototype]] as const;
  };

  it.each(coinVariants())("rejects an intent fund coin with %s", async (_, coin) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    await expect(createTransactionFlow(dependencies).prepare({ ...intent, funds: [coin] as never }))
      .rejects.toMatchObject({ name: "TransactionSafetyError", code: "invalid_transaction" });
    expect(dependencies.estimateFee).not.toHaveBeenCalled();
  });

  it.each([
    ["extra enumerable key", () => ({ gas: "1", amount: [{ denom: "ujuno", amount: "1" }], note: true })],
    ["symbol key", () => Object.assign({ gas: "1", amount: [{ denom: "ujuno", amount: "1" }] }, { [Symbol("hidden")]: true })],
    ["accessor", () => Object.defineProperty({ amount: [{ denom: "ujuno", amount: "1" }] }, "gas", { enumerable: true, configurable: true, get: () => "1" })],
    ["null prototype", () => Object.assign(Object.create(null) as object, { gas: "1", amount: [{ denom: "ujuno", amount: "1" }] })],
    ["custom prototype", () => Object.assign(Object.create({ inherited: true }) as object, { gas: "1", amount: [{ denom: "ujuno", amount: "1" }] })],
  ] as const)("rejects a fee object with %s", async (_, makeFee) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    vi.mocked(dependencies.estimateFee).mockResolvedValueOnce(makeFee() as never);
    await expect(createTransactionFlow(dependencies).prepare(intent))
      .rejects.toMatchObject({ name: "TransactionSafetyError", code: "invalid_transaction" });
  });

  it.each(coinVariants())("rejects a fee coin with %s", async (_, coin) => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    vi.mocked(dependencies.estimateFee).mockResolvedValueOnce({ gas: "1", amount: [coin] } as never);
    await expect(createTransactionFlow(dependencies).prepare(intent))
      .rejects.toMatchObject({ name: "TransactionSafetyError", code: "invalid_transaction" });
  });

  it("accepts ordinary JSON values and frozen structured-clone-compatible schemas", async () => {
    const { wallet, dependencies } = setup(); await wallet.connect();
    vi.mocked(dependencies.estimateFee).mockResolvedValueOnce(Object.freeze({ gas: "1",
      amount: Object.freeze([Object.freeze({ denom: "ujuno", amount: "1" })]) }));
    const frozenIntent = Object.freeze({ ...intent,
      executeMessage: Object.freeze({ contribute: Object.freeze({ bounty_id: 7 }) }),
      funds: Object.freeze([Object.freeze({ denom: "ujuno", amount: "1" })]),
      consequences: Object.freeze(["disclose"]),
    });
    await expect(createTransactionFlow(dependencies).prepare(frozenIntent)).resolves.toMatchObject({
      funds: [{ denom: "ujuno", amount: "1" }], fee: { gas: "1", amount: [{ denom: "ujuno", amount: "1" }] },
    });
  });
});

describe("broadcast and confirmation outcomes", () => {
  it.each([
    ["missing confirmed hash", { status: "confirmed", height: 101 }],
    ["invalid confirmed height", { status: "confirmed", txHash: "ABC", height: 0 }],
    ["extra confirmed field", { status: "confirmed", txHash: "ABC", height: 101, extra: true }],
    ["missing pending hash", { status: "pending" }],
    ["blank pending hash", { status: "pending", txHash: "  " }],
    ["missing failed reason", { status: "failed", txHash: "ABC" }],
    ["invalid failed hash", { status: "failed", txHash: 7, reason: "failed" }],
    ["extra unknown field", { status: "unknown", reason: "not allowed" }],
    ["unknown status", { status: "success", txHash: "ABC" }],
    ["non-object", null],
  ])("fails closed on malformed adapter response: %s", async (_, response) => {
    const { dependencies, flow, review } = await prepared();
    vi.mocked(dependencies.signAndBroadcast).mockResolvedValueOnce(response as never);
    await expect(flow.submit(review)).resolves.toEqual({ status: "unknown" });
    expect(dependencies.refreshCanonical).not.toHaveBeenCalled();
  });
  it.each(["timeout", "disconnect", "post-broadcast"])("maps typed %s transport uncertainty to unknown and preserves hash", async (kind) => {
    const { dependencies, flow, review } = await prepared();
    vi.mocked(dependencies.signAndBroadcast).mockRejectedValueOnce(
      new BroadcastDependencyError("transport", kind, { txHash: kind === "post-broadcast" ? "KNOWN" : undefined }));
    await expect(flow.submit(review)).resolves.toEqual({ status: "unknown",
      ...(kind === "post-broadcast" ? { txHash: "KNOWN", explorerUrl: "https://www.mintscan.io/juno/tx/KNOWN" } : {}) });
  });
  it("uses typed rejection and preserves authoritative chain failure", async () => {
    const first = await prepared();
    vi.mocked(first.dependencies.signAndBroadcast).mockRejectedValueOnce(new BroadcastDependencyError("rejected", "User rejected"));
    await expect(first.flow.submit(first.review)).resolves.toEqual({ status: "rejected", reason: "User rejected" });
    const second = await prepared();
    vi.mocked(second.dependencies.signAndBroadcast).mockResolvedValueOnce({ status: "failed", txHash: "FAILED1", reason: "out of gas" });
    await expect(second.flow.submit(second.review)).resolves.toEqual({ status: "failed", txHash: "FAILED1", reason: "out of gas",
      explorerUrl: "https://www.mintscan.io/juno/tx/FAILED1" });
  });
  it("never loses a confirmed transaction when canonical refresh fails", async () => {
    const { dependencies, flow, review } = await prepared();
    vi.mocked(dependencies.refreshCanonical).mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(flow.submit(review)).resolves.toEqual({ status: "confirmed", confirmationStatus: "confirmed",
      refreshStatus: "failed", txHash: "ABC123", height: 101,
      explorerUrl: "https://www.mintscan.io/juno/tx/ABC123" });
  });
});
