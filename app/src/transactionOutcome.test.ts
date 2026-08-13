import { describe, expect, it } from "vitest";
import { runtimeTransactionOutcome } from "./transactionOutcome";

describe("runtime transaction outcome boundary", () => {
  it("accepts exact canonical explorer evidence", () => {
    expect(runtimeTransactionOutcome({ status: "pending", txHash: "ABC", explorerUrl: "https://www.mintscan.io/juno/tx/ABC" }))
      .toEqual({ status: "pending", txHash: "ABC", explorerUrl: "https://www.mintscan.io/juno/tx/ABC" });
  });
  it.each([
    Object.assign(Object.create({ inherited: true }), { status: "unknown" }),
    Object.assign({ status: "unknown" }, { [Symbol("hidden")]: true }),
    { status: "pending", txHash: "ABC", explorerUrl: "https://evil.example/tx/ABC" },
    { status: "unknown", extra: true },
  ])("rejects malformed, hidden, or untrusted runtime evidence", (value) => {
    expect(runtimeTransactionOutcome(value)).toBeNull();
  });
});