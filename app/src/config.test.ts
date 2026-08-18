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
});
