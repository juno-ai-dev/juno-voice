import { describe, expect, it, vi } from "vitest";
import { BrowserWalletDiscovery, WalletSafetyError, WalletSession, type WalletConnector, type WalletIdentity } from "./wallet";

const alice = { chainId: "juno-1", address: "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730" } as const;
const bob = { chainId: "juno-1", address: "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac" } as const;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function connector(identity: WalletIdentity): WalletConnector & { change(next?: WalletIdentity): void } {
  let current = identity; let listener: (() => void) | undefined;
  return { kind: "keplr", connect: vi.fn(async () => current), readIdentity: vi.fn(async () => current),
    onChange(next) { listener = next; return () => { listener = undefined; }; },
    change(next) { if (next) current = next; listener?.(); } };
}

describe("wallet safety session", () => {
  it("fails closed for wrong chain and malformed identities", async () => {
    const wallet = new WalletSession(connector({ ...alice, chainId: "uni-7" }), "juno-1");
    await expect(wallet.connect()).rejects.toMatchObject({ code: "wrong_chain" });
    expect(wallet.snapshot()).toMatchObject({ status: "disconnected", identity: null });
  });
  it("synchronously invalidates authorization on change before asynchronous identity refresh", async () => {
    const port = connector(alice); const wallet = new WalletSession(port, "juno-1"); const first = await wallet.connect();
    const gate = deferred<WalletIdentity>(); vi.mocked(port.readIdentity).mockReturnValueOnce(gate.promise);
    port.change(bob);
    expect(wallet.snapshot()).toMatchObject({ status: "disconnected", identity: null, revision: first.revision + 1 });
    expect(() => wallet.assertRevision(first)).toThrowError(WalletSafetyError);
    gate.resolve(bob); await wallet.settled();
    expect(wallet.snapshot()).toMatchObject({ status: "connected", identity: bob, revision: first.revision + 1 });
  });
  it("serializes multiple changes, settled covers the complete queue, and newest identity wins", async () => {
    const port = connector(alice); const wallet = new WalletSession(port, "juno-1"); await wallet.connect();
    const first = deferred<WalletIdentity>(); const second = deferred<WalletIdentity>();
    vi.mocked(port.readIdentity).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    port.change(bob); await vi.waitFor(() => expect(port.readIdentity).toHaveBeenCalledTimes(1)); port.change(alice);
    first.resolve(bob); await vi.waitFor(() => expect(port.readIdentity).toHaveBeenCalledTimes(2));
    let settled = false; void wallet.settled().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    second.resolve(alice); await wallet.settled(); expect(wallet.snapshot()).toMatchObject({ status: "connected", identity: alice });
  });
  it("invalidates when a fresh current-identity validation fails", async () => {
    const port = connector(alice); const wallet = new WalletSession(port, "juno-1"); await wallet.connect();
    vi.mocked(port.readIdentity).mockResolvedValueOnce({ ...alice, chainId: "uni-7" });
    await expect(wallet.current()).rejects.toMatchObject({ code: "wrong_chain" });
    expect(wallet.snapshot()).toMatchObject({ status: "disconnected", identity: null });
  });
  it("remains invalidated when change-event validation fails", async () => {
    const port = connector(alice); const wallet = new WalletSession(port, "juno-1"); await wallet.connect();
    vi.mocked(port.readIdentity).mockResolvedValueOnce({ ...alice, chainId: "uni-7" }); port.change(); await wallet.settled();
    expect(wallet.snapshot()).toMatchObject({ status: "disconnected", identity: null });
  });
  it("dispose removes the listener and ignores an in-flight refresh", async () => {
    const port = connector(alice); const wallet = new WalletSession(port, "juno-1"); await wallet.connect();
    const gate = deferred<WalletIdentity>(); vi.mocked(port.readIdentity).mockReturnValueOnce(gate.promise); port.change(bob); wallet.dispose();
    gate.resolve(bob); await wallet.settled(); expect(wallet.snapshot()).toMatchObject({ status: "disconnected", identity: null });
    port.change(alice); expect(port.readIdentity).toHaveBeenCalledTimes(1);
  });
  it.each([["missing", new WalletSafetyError("missing_wallet", "not installed")], ["locked", new WalletSafetyError("wallet_locked", "locked")],
    ["rejected", Object.assign(new Error("Request rejected"), { code: 4001 })]])("keeps read-only operation independent when wallet is %s", async (_, error) => {
    const port = connector(alice); vi.mocked(port.connect).mockRejectedValueOnce(error); const wallet = new WalletSession(port, "juno-1");
    await expect(wallet.connect()).rejects.toBeTruthy(); expect(wallet.snapshot().status).toBe("disconnected");
  });
});

describe("browser wallet discovery", () => {
  it("supports explicit Keplr and Leap selection without a signing SDK", () => {
    const events: string[] = []; const browser = { keplr: { enable: vi.fn(), getKey: vi.fn() }, leap: { enable: vi.fn(), getKey: vi.fn() },
      addEventListener: (name: string) => events.push(name), removeEventListener: vi.fn() };
    const discovery = new BrowserWalletDiscovery(browser); expect(discovery.available()).toEqual(["keplr", "leap"]);
    discovery.connector("keplr").onChange(() => undefined); discovery.connector("leap").onChange(() => undefined);
    expect(events).toEqual(["keplr_keystorechange", "leap_keystorechange"]);
  });
});
