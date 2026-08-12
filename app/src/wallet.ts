import { fromBech32 } from "@cosmjs/encoding";

export type WalletKind = "keplr" | "leap";
export interface WalletIdentity {
  chainId: string;
  address: string;
}
export interface WalletAuthorization extends WalletIdentity {
  wallet: WalletKind;
  revision: number;
}
export interface WalletConnector {
  readonly kind: WalletKind;
  connect(): Promise<WalletIdentity>;
  readIdentity(): Promise<WalletIdentity>;
  onChange(listener: () => void): () => void;
}
export type WalletErrorCode =
  | "missing_wallet"
  | "wallet_locked"
  | "wallet_rejected"
  | "wrong_chain"
  | "stale_identity"
  | "invalid_identity";
export class WalletSafetyError extends Error {
  constructor(
    public readonly code: WalletErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WalletSafetyError";
  }
}
export interface WalletSnapshot {
  status: "disconnected" | "connecting" | "connected";
  identity: WalletIdentity | null;
  kind: WalletKind;
  revision: number;
  error: WalletSafetyError | null;
}

function normalizedError(error: unknown): WalletSafetyError {
  if (error instanceof WalletSafetyError) return error;
  const value = error as { code?: unknown; message?: unknown };
  const message = typeof value?.message === "string" ? value.message : "Wallet access failed.";
  if (value?.code === 4001 || /reject|denied/i.test(message))
    return new WalletSafetyError("wallet_rejected", message, { cause: error });
  if (/lock/i.test(message))
    return new WalletSafetyError("wallet_locked", message, { cause: error });
  return new WalletSafetyError("missing_wallet", message, { cause: error });
}

export class WalletSession {
  private state: WalletSnapshot;
  private lifecycleTask: Promise<void> = Promise.resolve();
  private readonly removeListener: () => void;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly connectorPort: WalletConnector,
    private readonly targetChainId: string,
  ) {
    this.state = {
      status: "disconnected",
      identity: null,
      kind: connectorPort.kind,
      revision: 0,
      error: null,
    };
    this.removeListener = connectorPort.onChange(() => this.handleChange());
  }

  snapshot(): Readonly<WalletSnapshot> {
    return { ...this.state, identity: this.state.identity && { ...this.state.identity } };
  }

  async connect(): Promise<WalletAuthorization> {
    this.state = { ...this.state, status: "connecting", identity: null, error: null };
    try {
      const identity = await this.connectorPort.connect();
      this.validate(identity);
      this.state = {
        status: "connected",
        identity: { ...identity },
        kind: this.connectorPort.kind,
        revision: this.state.revision + 1,
        error: null,
      };
      return this.authorization();
    } catch (error) {
      const safe = normalizedError(error);
      this.state = { ...this.state, status: "disconnected", identity: null, error: safe };
      throw safe;
    }
  }

  async current(): Promise<WalletAuthorization> {
    if (this.state.status !== "connected")
      throw new WalletSafetyError("stale_identity", "Wallet is not connected.");
    let identity: WalletIdentity;
    try {
      identity = await this.connectorPort.readIdentity();
      this.validate(identity);
    } catch (error) {
      const safe = error instanceof WalletSafetyError ? error : normalizedError(error);
      this.invalidate(safe.message);
      throw safe;
    }
    if (
      identity.address !== this.state.identity?.address ||
      identity.chainId !== this.state.identity.chainId
    ) {
      this.invalidate("Wallet identity changed.");
      throw new WalletSafetyError("stale_identity", "Wallet identity changed.");
    }
    return this.authorization();
  }

  assertRevision(authorization: WalletAuthorization): void {
    if (
      this.state.status !== "connected" ||
      authorization.revision !== this.state.revision ||
      authorization.address !== this.state.identity?.address ||
      authorization.chainId !== this.targetChainId
    )
      throw new WalletSafetyError(
        "stale_identity",
        "Wallet authorization is stale; review the transaction again.",
      );
  }

  settled(): Promise<void> {
    return this.lifecycleTask;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.removeListener();
  }

  private authorization(): WalletAuthorization {
    if (!this.state.identity) throw new WalletSafetyError("stale_identity", "Wallet is not connected.");
    return {
      ...this.state.identity,
      wallet: this.connectorPort.kind,
      revision: this.state.revision,
    };
  }

  private validate(identity: WalletIdentity): void {
    if (identity.chainId !== this.targetChainId)
      throw new WalletSafetyError(
        "wrong_chain",
        `Wrong chain: expected ${this.targetChainId}, wallet reported ${identity.chainId}.`,
      );
    try {
      if (identity.address !== identity.address.toLowerCase()) throw new Error();
      const decoded = fromBech32(identity.address);
      if (decoded.prefix !== "juno" || ![20, 32].includes(decoded.data.length)) throw new Error();
    } catch {
      throw new WalletSafetyError("invalid_identity", "Wallet returned an invalid Juno account.");
    }
  }

  private invalidate(message: string): void {
    this.state = {
      ...this.state,
      status: "disconnected",
      identity: null,
      revision: this.state.revision + 1,
      error: new WalletSafetyError("stale_identity", message),
    };
  }

  private handleChange(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.invalidate("Wallet identity may have changed; validating again.");
    this.lifecycleTask = this.lifecycleTask.then(() => this.refreshAfterChange(generation));
  }

  private async refreshAfterChange(generation: number): Promise<void> {
    const revision = this.state.revision;
    try {
      const identity = await this.connectorPort.readIdentity();
      this.validate(identity);
      if (this.disposed || generation !== this.generation) return;
      this.state = {
        status: "connected",
        identity: { ...identity },
        kind: this.connectorPort.kind,
        revision,
        error: null,
      };
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.state = {
        ...this.state,
        status: "disconnected",
        identity: null,
        revision,
        error: normalizedError(error),
      };
    }
  }
}

interface BrowserWalletExtension {
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string }>;
}
interface WalletBrowser {
  keplr?: BrowserWalletExtension;
  leap?: BrowserWalletExtension;
  addEventListener(name: string, listener: () => void): void;
  removeEventListener(name: string, listener: () => void): void;
}

export class BrowserWalletDiscovery {
  constructor(private readonly browser: WalletBrowser) {}

  available(): WalletKind[] {
    return (["keplr", "leap"] as const).filter((kind) => Boolean(this.browser[kind]));
  }

  connector(kind: WalletKind, chainId = "juno-1"): WalletConnector {
    const extension = this.browser[kind];
    if (!extension)
      throw new WalletSafetyError("missing_wallet", `${kind} wallet is not installed.`);
    const readIdentity = async (): Promise<WalletIdentity> => ({
      chainId,
      address: (await extension.getKey(chainId)).bech32Address,
    });
    const eventName = `${kind}_keystorechange`;
    return {
      kind,
      async connect() {
        await extension.enable(chainId);
        return readIdentity();
      },
      readIdentity,
      onChange: (listener) => {
        this.browser.addEventListener(eventName, listener);
        return () => this.browser.removeEventListener(eventName, listener);
      },
    };
  }
}
