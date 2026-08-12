import { toBech32 } from "@cosmjs/encoding";
import { describe, expect, it, vi } from "vitest";
import { BrowserWalletDiscovery, WalletSafetyError, WalletSession, type WalletConnector, type WalletIdentity } from "./wallet";

const alice = { chainId: "juno-1", address: "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730" } as const;
const bob = { chainId: "juno-1", address: toBech32("juno", new Uint8Array(20).fill(2)) } as const;
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
  it("supersedes concurrent connects and never commits the older reversed result", async () => {
    const port = connector(alice); const wallet = new WalletSession(port, "juno-1");
    const older = deferred<WalletIdentity>(); const newer = deferred<WalletIdentity>();
    vi.mocked(port.connect).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = wallet.connect(); const second = wallet.connect();
    newer.resolve(bob); await expect(second).resolves.toMatchObject(bob);
    older.resolve(alice); await expect(first).rejects.toMatchObject({ code: "stale_identity" });
    expect(wallet.snapshot()).toMatchObject({ status: "connected", identity: bob });
  });
  it("never commits a connect invalidated by change or disposal", async () => {
    const changedPort = connector(alice); const changed = new WalletSession(changedPort, "juno-1");
    const first = deferred<WalletIdentity>(); vi.mocked(changedPort.connect).mockReturnValueOnce(first.promise);
    const connecting = changed.connect(); changedPort.change(bob); first.resolve(alice);
    await expect(connecting).rejects.toMatchObject({ code: "stale_identity" }); await changed.settled();
    expect(changed.snapshot()).not.toMatchObject({ identity: alice });

    const disposedPort = connector(alice); const disposed = new WalletSession(disposedPort, "juno-1");
    const second = deferred<WalletIdentity>(); vi.mocked(disposedPort.connect).mockReturnValueOnce(second.promise);
    const pending = disposed.connect(); disposed.dispose(); second.resolve(alice);
    await expect(pending).rejects.toMatchObject({ code: "stale_identity" });
    expect(disposed.snapshot()).toMatchObject({ status: "disconnected", identity: null });
  });
  it("disposal terminally revokes identity and revision and all authorization paths fail closed", async () => {
    const port = connector(alice); const wallet = new WalletSession(port, "juno-1"); const authorization = await wallet.connect();
    wallet.dispose();
    expect(wallet.snapshot()).toMatchObject({ status: "disconnected", identity: null, revision: authorization.revision + 1 });
    expect(() => wallet.assertRevision(authorization)).toThrowError(WalletSafetyError);
    await expect(wallet.current()).rejects.toMatchObject({ code: "stale_identity" });
    await expect(wallet.connect()).rejects.toMatchObject({ code: "stale_identity" });
  });
  it("rejects 32-byte Juno addresses as wallet accounts", async () => {
    const wallet = new WalletSession(connector({ chainId: "juno-1", address: toBech32("juno", new Uint8Array(32)) }), "juno-1");
    await expect(wallet.connect()).rejects.toMatchObject({ code: "invalid_identity" });
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
