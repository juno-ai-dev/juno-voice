import { describe, expect, it } from "vitest";
import { formatJuno, parseJuno } from "./junoAmount";

const U128_MAX = "340282366920938463463374607431768211455";

describe("precision-safe $JUNO amounts", () => {
  it.each([
    ["1", "1000000"], ["0.000001", "1"], ["1.23", "1230000"],
    ["9007199254.740993", "9007199254740993"], ["340282366920938463463374607431768.211455", U128_MAX],
  ])("parses %s to exact backend ujuno %s", (display, wire) => {
    expect(parseJuno(display)).toBe(wire);
  });

  it.each(["", "0", "0.000000", "-1", "+1", "1e6", "1,000", ".1", "1.", " 1", "1.0000001",
    "340282366920938463463374607431768.211456"])("rejects invalid, zero, over-precision, or overflow input %s", (value) => {
    expect(() => parseJuno(value)).toThrow();
  });

  it("allows zero only when explicitly requested", () => {
    expect(parseJuno("0", { positive: false })).toBe("0");
  });

  it.each([
    ["0", "$JUNO 0"], ["1", "$JUNO 0.000001"], ["1000000", "$JUNO 1"],
    ["1230000", "$JUNO 1.23"], ["9007199254740993", "$JUNO 9,007,199,254.740993"],
    [U128_MAX, "$JUNO 340,282,366,920,938,463,463,374,607,431,768.211455"],
  ])("formats exact ujuno %s as %s", (wire, display) => {
    expect(formatJuno(wire)).toBe(display);
  });

  it.each(["", "01", "-1", "1.2", "340282366920938463463374607431768211456"])("rejects malformed backend amount %s", (value) => {
    expect(() => formatJuno(value)).toThrow();
  });
});
