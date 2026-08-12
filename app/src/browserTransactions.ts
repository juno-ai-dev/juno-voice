import { BroadcastTxError, calculateFee, GasPrice, TimeoutError } from "@cosmjs/stargate";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import type { BountyTransactionAccess } from "./BountyActions";
import type { VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import type { BountyDetail } from "./types";
import type { RegistryDataSource } from "./registry";
import { buildRegistryIntent, type RegistryAction, type RegistryActionInput, type RegistryTransactionFlow } from "./registryActions";
import { confirmRegistryMutation } from "./registryConfirmation";
import { BroadcastDependencyError, createTransactionFlow, type ExactExecuteRequest, type TransactionIntent } from "./transactions";
import { BrowserWalletDiscovery, WalletSession, type WalletKind } from "./wallet";
import { confirmBountyMutation, confirmSettlementMutation, type SettlementAction } from "./bountyConfirmation";
import type { GaugeActionContext, GaugeDataSource } from "./gauge";
import { buildGaugeIntent, type GaugeAction, type GaugeTransactionFlow, type PreferenceInput } from "./gaugeActions";
import { confirmGaugeMutation } from "./gaugeConfirmation";

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

export type BrowserTransactionAccess = BountyTransactionAccess & RegistryTransactionFlow & GaugeTransactionFlow;

/** Production adapter for #32's exact review lifecycle. No signer is invoked by connect or prepare. */
export function createBrowserTransactionAccess(
  config: AppConfig,
  source: VoiceDataSource,
  kind: WalletKind,
  registrySource?: RegistryDataSource,
  gaugeSource?: GaugeDataSource,
): BrowserTransactionAccess {
  const browser = window as SigningWindow;
  const extension = browser[kind];
  if (!extension?.getOfflineSigner) throw new Error(`${kind} signing support is unavailable.`);
  const discovery = new BrowserWalletDiscovery(browser);
  const wallet = new WalletSession(discovery.connector(kind, config.chainId), config.chainId);
  let expectedIntent: TransactionIntent | null = null;
  let canonicalBefore: BountyDetail | undefined;
  let gaugeBefore: GaugeActionContext | undefined;
  const pending = new Map<string, { intent: TransactionIntent; canonicalBefore?: BountyDetail; gaugeBefore?: GaugeActionContext }>();
  const readCanonicalState = async () => {
    if (!expectedIntent) throw new Error("No transaction is being reviewed.");
    const action = Object.keys(expectedIntent.executeMessage)[0];
    if (expectedIntent.contract === config.gaugeContract) {
      if (!gaugeSource) throw new Error("Canonical gauge state is unavailable.");
      const sender = wallet.snapshot().identity?.address;
      if (!sender) throw new Error("Wallet identity is unavailable for canonical gauge authorization.");
      const context = await gaugeSource.loadActionContext(sender);
      const body = expectedIntent.executeMessage[action] as { votes?: unknown } | undefined;
      const gaugeAction: GaugeAction = action === "place_votes" ? body?.votes === null ? "remove_votes" : "place_votes" : action as GaugeAction;
      const preferences: PreferenceInput[] = Array.isArray(body?.votes) ? body.votes.map((vote) => {
        if (!vote || typeof vote !== "object" || Array.isArray(vote)) throw new Error("Reviewed gauge preferences are malformed.");
        const item = vote as { option?: unknown; weight?: unknown };
        if (typeof item.option !== "string" || typeof item.weight !== "string") throw new Error("Reviewed gauge preferences are malformed.");
        return { option: item.option, weight: item.weight };
      }) : [];
      const rebuilt = buildGaugeIntent(config, sender, context, gaugeAction, preferences);
      if (JSON.stringify([rebuilt.executeMessage, rebuilt.funds]) !== JSON.stringify([expectedIntent.executeMessage, expectedIntent.funds])) throw new Error("Canonical gauge transaction changed; review again.");
      gaugeBefore = context;
      return { fingerprint: context.fingerprint, height: context.data.observationHeight };
    }
    if (expectedIntent.contract === config.registryContract) {
      if (!registrySource) throw new Error("Canonical registry state is unavailable.");
      const body = expectedIntent.executeMessage[action];
      const projectId = body && typeof body === "object" && !Array.isArray(body)
        ? (body as { project_id?: unknown }).project_id
        : undefined;
      if (typeof projectId !== "string") throw new Error("Registry project identity is unavailable.");
      const context = await registrySource.loadActionContext(projectId, action === "register_project");
      const sender = wallet.snapshot().identity?.address;
      if (!sender) throw new Error("Wallet identity is unavailable for canonical authorization.");
      const value = body as Record<string, unknown>;
      const input: RegistryActionInput = {
        action: action as RegistryAction,
        projectId,
        metadataUri: typeof value.metadata_uri === "string" ? value.metadata_uri : "",
        metadataDigest: typeof value.metadata_digest === "string" ? value.metadata_digest : "",
        address: typeof value.payout_address === "string" ? value.payout_address : typeof value.address === "string" ? value.address : "",
        note: value.reason && typeof value.reason === "object" && !Array.isArray(value.reason) &&
          typeof (value.reason as { note?: unknown }).note === "string" ? (value.reason as { note: string }).note : "",
      };
      const rebuilt = buildRegistryIntent(config, sender, context, input);
      if (JSON.stringify([rebuilt.executeMessage, rebuilt.funds]) !== JSON.stringify([expectedIntent.executeMessage, expectedIntent.funds]))
        throw new Error("Canonical registry transaction changed; review again.");
      return { fingerprint: context.fingerprint, height: context.data.observationHeight };
    }
    if (action !== "create_bounty") {
      const body = expectedIntent.executeMessage[action] as { bounty_id?: unknown };
      const id = body.bounty_id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("Canonical bounty identifier is unavailable.");
      if (!source.loadBountyDetail) throw new Error("Canonical bounty detail is unavailable.");
      const detail = await source.loadBountyDetail(id);
      canonicalBefore = detail;
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
        const events = result.events.map((event) => ({ type: event.type, attributes: event.attributes.map((item) => ({ key: item.key, value: item.value })) }));
        const action = Object.keys(request.executeMessage)[0];
        if (request.contract === config.registryContract) {
          if (!registrySource) throw new Error("Canonical registry state is unavailable.");
          const registryAction = action as RegistryAction;
          const body = request.executeMessage[registryAction] as { project_id?: unknown } | undefined;
          if (typeof body?.project_id !== "string") throw new Error("Canonical registry project could not be refreshed.");
          const refreshed = await registrySource.loadActionContext(body.project_id, false);
          confirmRegistryMutation({ action: registryAction, events, refreshed, sender: request.sender,
           executeMessage: request.executeMessage, funds: request.funds });
          return { status: "confirmed" as const, txHash, height: result.height };
        }
        if (request.contract === config.gaugeContract) {
          if (!gaugeSource || !gaugeBefore) throw new Error("Canonical pre-transaction gauge state is unavailable.");
          const refreshed = await gaugeSource.loadActionContext(request.sender);
          const body = request.executeMessage[action] as { votes?: unknown } | undefined;
          const gaugeAction: GaugeAction = action === "place_votes" ? body?.votes === null ? "remove_votes" : "place_votes" : action as GaugeAction;
          confirmGaugeMutation({ action: gaugeAction, events, refreshed, before: gaugeBefore, sender: request.sender, executeMessage: request.executeMessage, funds: request.funds });
          return { status: "confirmed" as const, txHash, height: result.height };
        }
        const creation = action === "create_bounty";
        const eventType = creation ? "juno_voice_bounties.bounty_created" : action === "contribute" ? "juno_voice_bounties.contributed" : "";
        const body = request.executeMessage[action] as { bounty_id?: unknown };
        const id = creation ? Number(events.find((event) => event.type === eventType || event.type === `wasm-${eventType}`)
          ?.attributes.find((item) => item.key === "bounty_id")?.value) : body.bounty_id;
        if (!Number.isSafeInteger(id) || !source.loadBountyDetail) throw new Error("Canonical mutation event could not be refreshed.");
        const refreshed = await source.loadBountyDetail(id as number);
        if (action === "create_bounty" || action === "contribute") {
          confirmBountyMutation({ action, events, refreshed: refreshed.bounty, sender: request.sender,
            amount: request.funds[0].amount,
            ...(action === "contribute" && canonicalBefore ? { priorTotal: canonicalBefore.bounty.total_contribution } : {}) });
        } else {
          if (!canonicalBefore) throw new Error("Canonical pre-transaction detail is unavailable.");
          confirmSettlementMutation({ action: action as SettlementAction, events, before: canonicalBefore,
            refreshed, sender: request.sender, message: request.executeMessage as Record<string, unknown> });
        }
        return { status: "confirmed" as const, txHash, height: result.height };
      } catch (error) {
        if (error instanceof BroadcastDependencyError) throw error;
        const message = messageOf(error);
        if (error instanceof BroadcastTxError) return { status: "failed" as const, reason: message };
        if (definiteWalletRejection(error)) throw new BroadcastDependencyError("rejected", message);
        throw new BroadcastDependencyError("transport", message, { txHash: txHash ?? structuredTxHash(error) });
      } finally { signing.disconnect(); }
    },
    refreshCanonical: async () => {
      if (expectedIntent?.contract === config.registryContract) {
        if (!registrySource) throw new Error("Canonical registry state is unavailable.");
        const action = Object.keys(expectedIntent.executeMessage)[0];
        const body = expectedIntent.executeMessage[action] as { project_id?: unknown } | undefined;
        if (typeof body?.project_id !== "string") throw new Error("Registry project identity is unavailable.");
        await registrySource.loadActionContext(body.project_id, false);
      } else if (expectedIntent?.contract === config.gaugeContract) {
        if (!gaugeSource) throw new Error("Canonical gauge state is unavailable.");
        const sender = wallet.snapshot().identity?.address;
        if (!sender) throw new Error("Wallet identity is unavailable.");
        await gaugeSource.loadActionContext(sender);
      } else await readCanonicalState();
    }, explorerBaseUrl: config.explorer,
  });
  return {
    async connect() { return wallet.connect(); },
    async prepare(intent) {
      expectedIntent = intent; canonicalBefore = undefined; gaugeBefore = undefined;
      const review = await flow.prepare(intent);
      pending.set(review.reviewId, { intent, ...(canonicalBefore === undefined ? {} : { canonicalBefore }), ...(gaugeBefore === undefined ? {} : { gaugeBefore }) });
      return review;
    },
    async submit(review) {
      const context = pending.get(review.reviewId);
      if (!context) throw new Error("Transaction review is no longer available.");
      expectedIntent = context.intent; canonicalBefore = context.canonicalBefore; gaugeBefore = context.gaugeBefore;
      try { return await flow.submit(review); }
      finally { pending.delete(review.reviewId); }
    },
  };
}
