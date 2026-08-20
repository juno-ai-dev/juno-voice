import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type ConfigEnvironment } from "./config";
import { TEST_DEPLOYMENT_ENV } from "./test/deployment";

const deployment = (overrides: Partial<ConfigEnvironment> = {}): ConfigEnvironment => ({
  ...TEST_DEPLOYMENT_ENV,
  ...overrides,
});

describe("fail-closed production configuration", () => {
  it("requires the complete fresh v2 deployment identity", () => {
    expect(() => loadConfig()).toThrow("VITE_PROTOCOL_VERSION");
    expect(() => loadConfig(deployment({ VITE_REGISTRY_CODE_CHECKSUM: undefined }))).toThrow(
      "fresh v2 deployment identity is incomplete",
    );
    expect(loadConfig(deployment())).toMatchObject({
      protocolVersion: "v2",
      chainId: "juno-1",
      contract: TEST_DEPLOYMENT_ENV.VITE_BOUNTY_CONTRACT_ADDRESS,
      codeId: 5155,
      releaseCommit: TEST_DEPLOYMENT_ENV.VITE_RELEASE_COMMIT,
    });
  });

  it("rejects a wrong protocol, chain, malformed identity, or reused address", () => {
    expect(() => loadConfig(deployment({ VITE_PROTOCOL_VERSION: "v1" }))).toThrow(
      "fresh v2 deployment",
    );
    expect(() => loadConfig(deployment({ VITE_CHAIN_ID: "uni-7" }))).toThrow(
      "pinned to juno-1",
    );
    expect(() => loadConfig(deployment({ VITE_BOUNTY_CONTRACT_ADDRESS: "juno1invalid" }))).toThrow(
      "Invalid Juno bounty",
    );
    expect(() => loadConfig(deployment({ VITE_BOUNTY_CODE_ID: "0" }))).toThrow(
      "Invalid bounty code ID",
    );
    expect(() => loadConfig(deployment({ VITE_GAUGE_CODE_CHECKSUM: "AA".repeat(32) }))).toThrow(
      "Invalid gauge Wasm checksum",
    );
    expect(() => loadConfig(deployment({
      VITE_GAUGE_CONTRACT_ADDRESS: TEST_DEPLOYMENT_ENV.VITE_BOUNTY_CONTRACT_ADDRESS,
    }))).toThrow("must be distinct");
  });

  it("requires credential-free HTTPS RPC", () => {
    expect(() => loadConfig(deployment({ VITE_RPC_URL: "http://rpc.example" }))).toThrow(
      "credential-free HTTPS",
    );
    expect(() => loadConfig(deployment({ VITE_RPC_URL: "https://user:secret@rpc.example" }))).toThrow(
      "credential-free HTTPS",
    );
  });

  it("rejects an unverified explorer", () =>
    expect(() => loadConfig(deployment({ VITE_EXPLORER_URL: "https://evil.example" }))).toThrow(
      "Unsupported explorer",
    ));

  it("binds production artifacts to an exact release commit", () => {
    const commit = "b".repeat(40);
    expect(loadConfig(deployment({ VITE_RELEASE_COMMIT: commit })).releaseCommit).toBe(commit);
    expect(() => loadConfig(deployment({ VITE_RELEASE_COMMIT: "main" }))).toThrow(
      "Release commit",
    );
  });

  it("defaults the IPFS gateway and requires credential-free HTTPS when overridden", () => {
    expect(loadConfig(deployment({ VITE_IPFS_GATEWAY: undefined })).ipfsGateway).toBe("https://ipfs.io/ipfs");
    expect(loadConfig(deployment({ VITE_IPFS_GATEWAY: "https://gateway.example/ipfs/" })).ipfsGateway).toBe(
      "https://gateway.example/ipfs",
    );
    expect(() => loadConfig(deployment({ VITE_IPFS_GATEWAY: "http://gateway.example/ipfs" }))).toThrow(
      "IPFS gateway",
    );
    expect(() => loadConfig(deployment({ VITE_IPFS_GATEWAY: "https://user:pw@gateway.example" }))).toThrow(
      "IPFS gateway",
    );
    expect(() => loadConfig(deployment({ VITE_IPFS_GATEWAY: "not a url" }))).toThrow(
      "Invalid IPFS gateway",
    );
  });

  it("treats a same-origin gateway as the local development pin store", () => {
    expect(loadConfig(deployment()).localPinStore).toBe(false);
    const local = loadConfig(deployment({ VITE_IPFS_GATEWAY: "/api/dev-ipfs/ipfs" }));
    expect(local.ipfsGateway).toBe("/api/dev-ipfs/ipfs");
    expect(local.localPinStore).toBe(true);
    expect(() => loadConfig(deployment({ VITE_IPFS_GATEWAY: "//gateway.example/ipfs" }))).toThrow(
      "IPFS gateway",
    );
    expect(() => loadConfig(deployment({ VITE_IPFS_GATEWAY: "/api/../secrets" }))).toThrow(
      "Invalid IPFS gateway",
    );
  });

  it("treats the presign endpoint as optional and allows only HTTPS or loopback dev", () => {
    expect(loadConfig(deployment({ VITE_PRESIGN_URL: undefined })).presignUrl).toBeNull();
    expect(loadConfig(deployment({ VITE_PRESIGN_URL: "" })).presignUrl).toBeNull();
    expect(loadConfig(deployment({ VITE_PRESIGN_URL: "https://presign.example/sign" })).presignUrl).toBe(
      "https://presign.example/sign",
    );
    expect(loadConfig(deployment({ VITE_PRESIGN_URL: "http://127.0.0.1:8787/sign" })).presignUrl).toBe(
      "http://127.0.0.1:8787/sign",
    );
    expect(() => loadConfig(deployment({ VITE_PRESIGN_URL: "http://presign.example/sign" }))).toThrow(
      "Presign URL",
    );
    expect(() => loadConfig(deployment({ VITE_PRESIGN_URL: "https://user:pw@presign.example/sign" }))).toThrow(
      "Presign URL",
    );
    expect(() => loadConfig(deployment({ VITE_PRESIGN_URL: "not a url" }))).toThrow(
      "Invalid presign URL",
    );
  });

  it("ships an .env.example that is a working, publish-free configuration", () => {
    // vitest runs with the app package as its root.
    const text = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
    const example: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) example[match[1]] = match[2];
    }
    const config = loadConfig(example);
    expect(config.chainId).toBe("juno-1");
    expect(config.releaseCommit).toBe("local-uncommitted");
    // Everything optional stays commented out, so a copied file publishes
    // nothing and reads through the public gateway.
    expect(config.presignUrl).toBeNull();
    expect(config.ipfsGateway).toBe("https://ipfs.io/ipfs");
    expect(config.localPinStore).toBe(false);
    expect(example.PINATA_JWT).toBeUndefined();
  });

  it("accepts a same-origin presign path and rejects near-miss shapes", () => {
    expect(loadConfig(deployment({ VITE_PRESIGN_URL: "/api/presign/sign" })).presignUrl).toBe(
      "/api/presign/sign",
    );
    for (const value of ["//presign.example/sign", "/api/../sign", "/sign?token=1", "/sign#fragment", "/"]) {
      expect(() => loadConfig(deployment({ VITE_PRESIGN_URL: value }))).toThrow("presign URL");
    }
  });
});
