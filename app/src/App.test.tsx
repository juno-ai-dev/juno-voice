import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { RegistryDataSource } from "./registry";
import { config, ledger } from "./test/bountyFixtures";

const account = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const registry = {
  config: { native_denom: "ujuno", registration_bond: "100000000", max_active_projects: 99,
    max_metadata_uri_bytes: 512, max_page_limit: 100, max_reason_bytes: 2048,
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
const renderApp = (initialEntries: Array<string | { pathname: string; hash?: string }> = ["/"]) =>
  render(<MemoryRouter initialEntries={initialEntries}>
    <App config={config} source={{ loadLedger: vi.fn(async () => ledger) }} registrySource={registrySource()} />
  </MemoryRouter>);

afterEach(() => {
  delete (window as Window & { keplr?: unknown }).keplr;
  delete (window as Window & { leap?: unknown }).leap;
  window.history.replaceState(null, "", window.location.pathname);
});

describe("production transaction wiring", () => {
  it("starts on the product landing page and opens every public view", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { name: /Fund useful work/ })).toBeInTheDocument();
    expect(screen.queryByText("NEW TO JUNO VOICE?")).not.toBeInTheDocument();
    const primaryNavigation = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primaryNavigation).getAllByRole("link").map((link) => link.textContent)).toEqual(["Bounties", "Gauge", "Projects"]);
    expect(within(primaryNavigation).queryByRole("link", { name: "About" })).not.toBeInTheDocument();
    await userEvent.click(within(primaryNavigation).getByRole("link", { name: "Bounties" }));
    expect(await screen.findByRole("heading", { name: "Public bounty ledger" })).toBeInTheDocument();
    await userEvent.click(within(primaryNavigation).getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { name: "Eligible projects" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Juno VOICE" }));
    expect(await screen.findByRole("heading", { name: /Fund useful work/ })).toBeInTheDocument();
  });

  it("opens the FAQ from the footer and moves focus to the new view", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("link", { name: /^FAQ/ }));
    await screen.findByRole("heading", { name: /Questions, answered plainly/ }, { timeout: 5_000 });
    const region = screen.getByLabelText("faq view");
    await vi.waitFor(() => expect(region).toHaveFocus(), { timeout: 5_000 });
  });

  it("redirects legacy #faq deep links onto the /faq route", async () => {
    renderApp([{ pathname: "/", hash: "#faq" }]);
    expect(await screen.findByRole("heading", { name: /Questions, answered plainly/ }, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByLabelText("faq view")).toBeInTheDocument();
  });

  it("renders a not-found page for unknown routes", async () => {
    renderApp(["/no-such-page"]);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the landing page" })).toBeInTheDocument();
  });

  it("keeps registry browsing wallet-free when no supported extension is present", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { name: "Eligible projects" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
  });

  it("automatically wires an injected Keplr extension into the shared registry flow", async () => {
    const enable = vi.fn(async () => undefined);
    const getKey = vi.fn(async () => ({ bech32Address: account }));
    Object.defineProperty(window, "keplr", { configurable: true, value: {
      enable, getKey, getOfflineSigner: vi.fn(() => ({})),
    } });
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await userEvent.click(screen.getByRole("link", { name: "Projects" }));
    await userEvent.click(await screen.findByRole("link", { name: "Open project actions" }));
    expect(await screen.findByText(/Connected account/)).toBeInTheDocument();
    expect(enable).toHaveBeenCalledWith("juno-1");
    expect(getKey).toHaveBeenCalledWith("juno-1");
    expect(screen.getByRole("button", { name: "Review project action" })).toBeEnabled();
  });
});
