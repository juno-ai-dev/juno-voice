import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { BountyDetailRoute, CreateBountyRoute, Ledger } from "./Ledger";
import type { VoiceDataSource } from "./client";
import { config, ledger } from "./test/bountyFixtures";

const source = (value = ledger) => ({
  loadLedger: () => Promise.resolve(value),
});
const renderLedger = (dataSource: VoiceDataSource, initialEntries: string[] = ["/bounties"]) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/bounties" element={<Ledger config={config} source={dataSource} />}>
          <Route path="create" element={<CreateBountyRoute />} />
          <Route path=":bountyId" element={<BountyDetailRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
const checkA11y = async (container: HTMLElement) => {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
  });
  expect(result.violations).toEqual([]);
};

describe("accessibility", () => {
  it("has no WCAG A/AA violations in loading state", async () => {
    const { container } = renderLedger({ loadLedger: () => new Promise(() => {}) });
    await checkA11y(container);
  });

  it("has no WCAG A/AA violations in error state", async () => {
    const { container } = renderLedger({ loadLedger: () => Promise.reject(new Error("RPC offline")) });
    await screen.findByText("RPC offline");
    await checkA11y(container);
  });

  it("has no WCAG A/AA violations in populated and empty states", async () => {
    const populated = renderLedger(source());
    await screen.findByText("Fund community tooling");
    await checkA11y(populated.container);
    populated.unmount();

    const empty = renderLedger(source({ ...ledger, bounties: [] }));
    await screen.findByText("No on-chain bounties yet");
    await checkA11y(empty.container);
  });

  it("has no WCAG A/AA violations in paused, degraded, and filtered states", async () => {
    const { container } = renderLedger(source({
      ...ledger,
      pause: {
        paused: true,
        reason: "maintenance",
        actor: "juno1agent",
        changed_at: "1",
      },
      health: { ...ledger.health, fully_backed: false },
    }));
    await screen.findByText(/New activity is paused/);
    await checkA11y(container);
    await userEvent.type(screen.getByRole("searchbox"), "missing");
    await screen.findByText("No matching bounties");
    await checkA11y(container);
  });

  it("has no WCAG A/AA violations in the route-addressed create modal", async () => {
    const { container } = renderLedger(source(), ["/bounties/create"]);
    await screen.findByRole("dialog", { name: "Create a bounty" });
    await checkA11y(container);
  });

  it("has no WCAG A/AA violations in canonical settlement detail and controls", async () => {
    const detail = { bounty: ledger.bounties[0], config: ledger.config, pause: ledger.pause, activeRound: null,
      rounds: [], receipts: [], moderation: null, graduation: null,
      contributions: [{ bounty_id: 1, contributor: ledger.bounties[0].creator, contributor_index: 1,
        current_amount: "2500000", weight_at_round: null }], claims: [], history: [],
      observationHeight: ledger.observationHeight, chainTimeNanos: ledger.chainTimeNanos, fingerprint: "detail" };
    const { container } = renderLedger({ loadLedger: async () => ledger, loadBountyDetail: async () => detail });
    await userEvent.click(await screen.findByRole("link", { name: "Fund community tooling" }));
    await screen.findByRole("heading", { name: "Contributor-controlled settlement" });
    await checkA11y(container);
  });

  it("meets AA contrast for the static production palette", () => {
    // axe-core cannot calculate CSS color contrast in JSDOM because layout and
    // canvas pixel data are unavailable, so verify the shipped solid-color
    // foreground/background pairs directly using the WCAG relative-luminance formula.
    const ratio = (foreground: string, background: string) => {
      const luminance = (hex: string) => {
        const channels = [0, 2, 4].map(
          (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255,
        );
        const linear = channels.map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const first = luminance(foreground);
      const second = luminance(background);
      return (
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
      );
    };

    expect(ratio("ffebd2", "270b0d")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("d7bda1", "270b0d")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("ff9a9b", "270b0d")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("21090b", "ff9a9b")).toBeGreaterThanOrEqual(4.5);
  });
});
