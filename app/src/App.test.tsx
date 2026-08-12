import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { RegistryDataSource } from "./registry";
import { config, ledger } from "./test/bountyFixtures";

const account = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const registry = {
  config: { native_denom: "ujuno", registration_bond: "1000000", max_active_projects: 99,
    max_metadata_uri_bytes: 512, max_page_limit: 50, max_reason_bytes: 500,
    payout_address_delay_seconds: 86400, curator: account, governor: account, version: 1 },
  pause: { admissions_stopped: false, adapter_stopped: false, reason: null, actor: null, changed_at: null },
  health: { accounting: { active_projects: 0, pending_applications: 0, bond_liability: "0",
    lifetime_bonds_received: "0", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" },
    actual_native_balance: "0", fully_backed: true },
  projects: [], applications: [], options: ["do-not-distribute"], observationHeight: 100,
  refreshedAt: new Date(0), weakConsistency: true as const,
};
const registrySource = (): RegistryDataSource => ({
  loadRegistry: vi.fn(async () => registry),
  loadProject: vi.fn(),
  loadActionContext: vi.fn(),
});

afterEach(() => {
  delete (window as Window & { keplr?: unknown }).keplr;
  delete (window as Window & { leap?: unknown }).leap;
  window.history.replaceState(null, "", window.location.pathname);
});

describe("production transaction wiring", () => {
  it("starts on the product landing page and opens every public view", async () => {
    render(<App config={config} source={{ loadLedger: vi.fn(async () => ledger) }} registrySource={registrySource()} />);

    expect(await screen.findByRole("heading", { name: /Fund useful work/ })).toBeInTheDocument();
    expect(screen.queryByText("NEW TO JUNO VOICE?")).not.toBeInTheDocument();
    const primaryNavigation = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primaryNavigation).getAllByRole("button").map((button) => button.textContent)).toEqual(["Bounties", "Gauge", "Projects"]);
    expect(within(primaryNavigation).queryByRole("button", { name: "About" })).not.toBeInTheDocument();
    await userEvent.click(within(primaryNavigation).getByRole("button", { name: "Bounties" }));
    expect(await screen.findByRole("heading", { name: "Public bounty ledger" })).toBeInTheDocument();
    await userEvent.click(within(primaryNavigation).getByRole("button", { name: "Projects" }));
    expect(await screen.findByRole("heading", { name: "Eligible projects" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Juno VOICE" }));
    expect(await screen.findByRole("heading", { name: /Fund useful work/ })).toBeInTheDocument();
  });

  it("opens the FAQ from the footer and moves focus to the new view", async () => {
    render(<App config={config} source={{ loadLedger: vi.fn(async () => ledger) }} registrySource={registrySource()} />);
    await userEvent.click(await screen.findByRole("link", { name: /^FAQ/ }));
    const region = screen.getByLabelText("faq view");
    await screen.findByRole("heading", { name: /Questions, answered plainly/ });
    expect(region).toHaveFocus();
    expect(window.location.hash).toBe("#faq");
  });

  it("keeps registry browsing wallet-free when no supported extension is present", async () => {
    render(<App config={config} source={{ loadLedger: vi.fn(async () => ledger) }} registrySource={registrySource()} />);
    await userEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(await screen.findByRole("heading", { name: "Eligible projects" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
  });

  it("automatically wires an injected Keplr extension into the shared registry flow", async () => {
    const enable = vi.fn(async () => undefined);
    const getKey = vi.fn(async () => ({ bech32Address: account }));
    Object.defineProperty(window, "keplr", { configurable: true, value: {
      enable, getKey, getOfflineSigner: vi.fn(() => ({})),
    } });
    render(<App config={config} source={{ loadLedger: vi.fn(async () => ledger) }} registrySource={registrySource()} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await userEvent.click(screen.getByRole("button", { name: "Projects" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open project actions" }));
    expect(await screen.findByText(/Connected account/)).toBeInTheDocument();
    expect(enable).toHaveBeenCalledWith("juno-1");
    expect(getKey).toHaveBeenCalledWith("juno-1");
    expect(screen.getByRole("button", { name: "Review project action" })).toBeEnabled();
  });
});
