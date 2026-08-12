import { describe, expect, it } from "vitest";
import { normalizeBase } from "./deployment";

describe("deployment base path", () => {
  it("supports local root and the repository Pages path", () => {
    expect(normalizeBase()).toBe("/");
    expect(normalizeBase("/juno-voice/")).toBe("/juno-voice/");
  });

  it("fails closed on relative, protocol-relative, or unterminated paths", () => {
    for (const value of ["juno-voice/", "//host/", "/juno-voice"])
      expect(() => normalizeBase(value)).toThrow("VITE_BASE_PATH");
  });
});
