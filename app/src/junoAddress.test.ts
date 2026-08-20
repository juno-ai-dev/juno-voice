import { toBech32 } from "@cosmjs/encoding";
import { describe, expect, it } from "vitest";
import { isJunoAccount, isJunoAddress, isJunoContract } from "./junoAddress";

const account = toBech32("juno", new Uint8Array(20).fill(5));
// A real Juno DAO. Contract addresses carry 32 bytes where accounts carry 20.
const dao = "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac";

describe("Juno address shapes", () => {
  it("accepts accounts and contracts as addresses, and tells them apart", () => {
    expect(isJunoAddress(account)).toBe(true);
    expect(isJunoAddress(dao)).toBe(true);
    expect(isJunoAccount(account)).toBe(true);
    expect(isJunoAccount(dao)).toBe(false);
    expect(isJunoContract(dao)).toBe(true);
    expect(isJunoContract(account)).toBe(false);
  });

  it("rejects malformed, foreign, mixed-case, and off-length addresses", () => {
    for (const value of [
      "",
      "juno1invalid",
      `${account.slice(0, -1)}x`,
      `J${account.slice(1)}`,
      account.toUpperCase(),
      toBech32("cosmos", new Uint8Array(20).fill(5)),
      toBech32("juno", new Uint8Array(21)),
      toBech32("juno", new Uint8Array(19)),
    ]) {
      expect(isJunoAddress(value)).toBe(false);
      expect(isJunoAccount(value)).toBe(false);
      expect(isJunoContract(value)).toBe(false);
    }
  });
});
