import { BroadcastTxError, calculateFee, GasPrice, TimeoutError } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import type { BountyTransactionAccess } from "./BountyActions";
import type { VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import { BroadcastDependencyError, createTransactionFlow, type ExactExecuteRequest, type TransactionIntent } from "./transactions";
import { BrowserWalletDiscovery, WalletSession, type WalletKind } from "./wallet";
import { confirmBountyMutation } from "./bountyConfirmation";

interface SigningExtension {
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string }>;
  getOfflineSigner(chainId: string): OfflineSigner;
}
type SigningWindow = Window & { keplr?: SigningExtension; leap?: SigningExtension };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Wallet submission failed.";
}
function definiteWalletRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === 4001 || code === "ACTION_REJECTED";
}
function structuredTxHash(error: unknown): string | undefined {
  if (error instanceof TimeoutError) return error.txId;
  if (!error || typeof error !== "object") return undefined;
  const value = error as { txId?: unknown; txHash?: unknown; transactionHash?: unknown };
  return [value.txId, value.txHash, value.transactionHash]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
}

/** Production adapter for #32's exact review lifecycle. No signer is invoked by connect or prepare. */
export function createBrowserTransactionAccess(config: AppConfig, source: VoiceDataSource, kind: WalletKind): BountyTransactionAccess {
  const browser = window as SigningWindow;
  const extension = browser[kind];
  if (!extension?.getOfflineSigner) throw new Error(`${kind} signing support is unavailable.`);
  const discovery = new BrowserWalletDiscovery(browser);
  const wallet = new WalletSession(discovery.connector(kind, config.chainId), config.chainId);
  let expectedIntent: TransactionIntent | null = null;
  let priorTotal: string | undefined;
  const pending = new Map<string, { intent: TransactionIntent; priorTotal?: string }>();
  const readCanonicalState = async () => {
    if (!expectedIntent) throw new Error("No transaction is being reviewed.");
    const action = Object.keys(expectedIntent.executeMessage)[0];
    if (action === "contribute") {
      const id = (expectedIntent.executeMessage.contribute as { bounty_id: number }).bounty_id;
      if (!source.loadBountyDetail) throw new Error("Canonical bounty detail is unavailable.");
      const detail = await source.loadBountyDetail(id);
      priorTotal = detail.bounty.total_contribution;
      return { fingerprint: detail.fingerprint, height: detail.observationHeight };
    }
    const ledger = await source.loadLedger();
    return { fingerprint: ledger.fingerprint, height: ledger.observationHeight };
  };
  const client = async () => SigningCosmWasmClient.connectWithSigner(config.rpc, extension.getOfflineSigner(config.chainId));
  const flow = createTransactionFlow({
    wallet, readCanonicalState,
    estimateFee: async (request) => {
      const signing = await client();
      try {
        const gas = await signing.simulate(request.sender, [{ typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value: {
          sender: request.sender, contract: request.contract,
          msg: new TextEncoder().encode(JSON.stringify(request.executeMessage)), funds: [...request.funds],
        } }], "");
        return calculateFee(Math.ceil(gas * 1.4), GasPrice.fromString("0.075ujuno"));
      } finally { signing.disconnect(); }
    },
    signAndBroadcast: async (request: ExactExecuteRequest) => {
      const signing = await client();
      let txHash: string | undefined;
      try {
        // connectWithSigner performs RPC IO. Re-read the extension identity after
        // it completes so this is the final await before the signer is invoked.
        const authorization = await wallet.current();
        if (authorization.address !== request.sender || authorization.chainId !== request.chainId)
          throw new BroadcastDependencyError("rejected", "Wallet identity changed; review again.");
        const result = await signing.execute(request.sender, request.contract, request.executeMessage, request.fee, "", [...request.funds]);
        txHash = result.transactionHash;
        const action = Object.keys(request.executeMessage)[0] as "create_bounty" | "contribute";
        const events = result.events.map((event) => ({ type: event.type, attributes: event.attributes.map((item) => ({ key: item.key, value: item.value })) }));
        const eventType = action === "create_bounty" ? "juno_voice_bounties.bounty_created" : "juno_voice_bounties.contributed";
        const id = Number(events.find((event) => event.type === eventType || event.type === `wasm-${eventType}`)
          ?.attributes.find((item) => item.key === "bounty_id")?.value);
        if (!Number.isSafeInteger(id) || !source.loadBountyDetail) throw new Error("Canonical mutation event could not be refreshed.");
        const refreshed = await source.loadBountyDetail(id);
        confirmBountyMutation({ action, events, refreshed: refreshed.bounty, sender: request.sender,
          amount: request.funds[0].amount, ...(action === "contribute" ? { priorTotal } : {}) });
        return { status: "confirmed" as const, txHash, height: result.height };
      } catch (error) {
        if (error instanceof BroadcastDependencyError) throw error;
        const message = messageOf(error);
        if (error instanceof BroadcastTxError) return { status: "failed" as const, reason: message };
        if (definiteWalletRejection(error)) throw new BroadcastDependencyError("rejected", message);
        throw new BroadcastDependencyError("transport", message, { txHash: txHash ?? structuredTxHash(error) });
      } finally { signing.disconnect(); }
    },
    refreshCanonical: async () => { await readCanonicalState(); }, explorerBaseUrl: config.explorer,
  });
  return {
    async connect() { return wallet.connect(); },
    async prepare(intent) {
      expectedIntent = intent; priorTotal = undefined;
      const review = await flow.prepare(intent);
      pending.set(review.reviewId, { intent, ...(priorTotal === undefined ? {} : { priorTotal }) });
      return review;
    },
    async submit(review) {
      const context = pending.get(review.reviewId);
      if (!context) throw new Error("Transaction review is no longer available.");
      expectedIntent = context.intent; priorTotal = context.priorTotal;
      try { return await flow.submit(review); }
      finally { pending.delete(review.reviewId); }
    },
  };
}
