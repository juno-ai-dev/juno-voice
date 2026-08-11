import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { Ledger } from "./Ledger";
import { config, ledger } from "./test/bountyFixtures";
describe("accessibility", () => {
  it("has no WCAG A/AA violations including contrast", async () => {
    const { container } = render(
      <Ledger
        config={config}
        source={{ loadLedger: () => Promise.resolve(ledger) }}
      />,
    );
    await screen.findByRole("heading", { name: "Bounties" });
    const result = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    expect(result.violations).toEqual([]);
  });
});
