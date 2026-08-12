import { describe, expect, it, vi } from "vitest";
import {
  BrowserWalletDiscovery,
  WalletSafetyError,
  WalletSession,
  type WalletConnector,
  type WalletIdentity,
} from "./wallet";

function connector(identity: WalletIdentity): WalletConnector & { change(next?: WalletIdentity): void } {
  let current = identity;
  let listener: (() => void) | undefined;
  return {
    kind: "keplr",
    connect: vi.fn(async () => current),
    readIdentity: vi.fn(async () => current),
    onChange(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    change(next) {
      if (next) current = next;
      listener?.();
    },
  };
}

const alice = { chainId: "juno-1", address: "juno1alice" } as const;

describe("wallet safety session", () => {
  it("fails closed for wrong chain and never reports a connected identity", async () => {
    const wallet = new WalletSession(connector({ ...alice, chainId: "uni-7" }), "juno-1");
    await expect(wallet.connect()).rejects.toMatchObject({ code: "wrong_chain" });
    expect(wallet.snapshot()).toMatchObject({ status: "disconnected", identity: null });
  });

  it("invalidates authorization and reviews when the account changes", async () => {
    const port = connector(alice);
    const wallet = new WalletSession(port, "juno-1");
    const first = await wallet.connect();
    port.change({ ...alice, address: "juno1bob" });
    await wallet.settled();
    expect(wallet.snapshot()).toMatchObject({
      status: "connected",
      identity: { address: "juno1bob" },
      revision: first.revision + 1,
    });
    expect(() => wallet.assertRevision(first)).toThrowError(WalletSafetyError);
  });

  it.each([
    ["missing", new WalletSafetyError("missing_wallet", "not installed")],
    ["locked", new WalletSafetyError("wallet_locked", "locked")],
    ["rejected", Object.assign(new Error("Request rejected"), { code: 4001 })],
  ])("keeps the read-only app independent when wallet is %s", async (_, error) => {
    const port = connector(alice);
    vi.mocked(port.connect).mockRejectedValueOnce(error);
    const wallet = new WalletSession(port, "juno-1");
    await expect(wallet.connect()).rejects.toBeTruthy();
    expect(wallet.snapshot().status).toBe("disconnected");
  });
});

describe("browser wallet discovery", () => {
  it("supports explicit Keplr and Leap selection without a signing SDK", () => {
    const events: string[] = [];
    const browser = {
      keplr: { enable: vi.fn(), getKey: vi.fn() },
      leap: { enable: vi.fn(), getKey: vi.fn() },
      addEventListener: (name: string) => events.push(name),
      removeEventListener: vi.fn(),
    };
    const discovery = new BrowserWalletDiscovery(browser);
    expect(discovery.available()).toEqual(["keplr", "leap"]);
    discovery.connector("keplr").onChange(() => undefined);
    discovery.connector("leap").onChange(() => undefined);
    expect(events).toEqual(["keplr_keystorechange", "leap_keystorechange"]);
  });
});
