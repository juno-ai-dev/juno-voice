import { describe, expect, it } from "vitest";
import { DEFAULT_BOUNTY_CONTRACT, loadConfig } from "./config";
describe("fail-closed production configuration", () => {
  it("pins the verified juno-1 deployment", () =>
    expect(loadConfig()).toMatchObject({
      chainId: "juno-1",
      contract: DEFAULT_BOUNTY_CONTRACT,
      codeId: 5150,
      releaseCommit: "local-uncommitted",
    }));
  it("rejects a wrong chain or contract", () => {
    expect(() => loadConfig({ VITE_CHAIN_ID: "uni-7" })).toThrow(
      "pinned to juno-1",
    );
    expect(() =>
      loadConfig({
        VITE_BOUNTY_CONTRACT_ADDRESS:
          "juno1t7ajx85pkw8e0yl8vgnlxvnlq4yf0h6a3eahuystnf6e9jfhwvvsv4jcel",
      }),
    ).toThrow("Unsupported bounty contract");
  });
  it("requires credential-free HTTPS RPC", () => {
    expect(() => loadConfig({ VITE_RPC_URL: "http://rpc.example" })).toThrow(
      "credential-free HTTPS",
    );
    expect(() =>
      loadConfig({ VITE_RPC_URL: "https://user:secret@rpc.example" }),
    ).toThrow("credential-free HTTPS");
  });
  it("rejects an unverified explorer", () =>
    expect(() =>
      loadConfig({ VITE_EXPLORER_URL: "https://evil.example" }),
    ).toThrow("Unsupported explorer"));
  it("binds production artifacts to an exact release commit", () => {
    const commit = "a".repeat(40);
    expect(loadConfig({ VITE_RELEASE_COMMIT: commit }).releaseCommit).toBe(commit);
    expect(() => loadConfig({ VITE_RELEASE_COMMIT: "main" })).toThrow(
      "Release commit",
    );
  });
});
