import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { BountyDetailRoute, CreateBountyRoute, Ledger } from "./Ledger";
import type { VoiceDataSource } from "./client";
import { config, ledger } from "./test/bountyFixtures";
const source = (value = ledger) => ({
  loadLedger: vi.fn().mockResolvedValue(value),
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
describe("read-only bounty ledger states", () => {
  it("marks a fresh observation stale while the page remains open", async () => {
    vi.useFakeTimers();
    try {
      renderLedger(source({ ...ledger, refreshedAt: new Date(Date.now()) }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.getByText("Fresh direct-RPC observation"),
      ).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(60_002));
      expect(screen.getByText(/Stale/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it("renders loading, mainnet provenance, health, economics, and a bounty", async () => {
    let done!: (v: typeof ledger) => void;
    renderLedger({
      loadLedger: () =>
        new Promise((r) => {
          done = r;
        }),
    });
    expect(
      screen.getByText("Loading mainnet bounty ledger…"),
    ).toBeInTheDocument();
    done(ledger);
    expect(
      await screen.findByText("Fund community tooling"),
    ).toBeInTheDocument();
    expect(screen.getByText("juno-1")).toBeInTheDocument();
    expect(screen.getByText("5155")).toBeInTheDocument();
    expect(screen.getByText("Fully backed")).toBeInTheDocument();
    expect(screen.getAllByText("$JUNO 1").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /connect|sign|contribute/i })).not.toBeInTheDocument();
    const bountyRecord = screen.getByRole("link", { name: "Fund community tooling" });
    const createAction = screen.getByRole("link", { name: "Create a bounty" });
    expect(createAction.compareDocumentPosition(bountyRecord) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /^Title/ })).not.toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute(
      "datetime",
      "2027-01-15T08:00:00.000Z",
    );
  });
  it("opens the route-addressed create modal from the page header", async () => {
    renderLedger(source());
    await userEvent.click(await screen.findByRole("link", { name: "Create a bounty" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a bounty" });
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByLabelText(/^Title/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Title/ })).not.toBeInTheDocument();
  });
  it("renders the create modal on a direct load of its route", async () => {
    renderLedger(source(), ["/bounties/create"]);
    expect(await screen.findByRole("dialog", { name: "Create a bounty" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/)).toBeInTheDocument();
  });
  it("opens canonical bounty detail on its own route and closes back to the ledger", async () => {
    const detail = { bounty: ledger.bounties[0], config: ledger.config, pause: ledger.pause, activeRound: null,
      rounds: [], receipts: [], moderation: null, graduation: null, contributions: [], claims: [], history: [],
      observationHeight: ledger.observationHeight, chainTimeNanos: ledger.chainTimeNanos, fingerprint: "detail" };
    const loadBountyDetail = vi.fn(async () => detail);
    renderLedger({ loadLedger: async () => ledger, loadBountyDetail });
    await userEvent.click(await screen.findByRole("link", { name: "Fund community tooling" }));
    const dialog = await screen.findByRole("dialog");
    expect(loadBountyDetail).toHaveBeenCalledWith(1);
    expect(dialog).toHaveTextContent("CANONICAL BOUNTY #1");
    await userEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("renders a not-found body for a malformed bounty id", async () => {
    renderLedger(source(), ["/bounties/not-a-number"]);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
  it("shows authoritative empty state without samples", async () => {
    renderLedger(source({ ...ledger, bounties: [] }));
    expect(
      await screen.findByText("No on-chain bounties yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No sample or demo records are shown/),
    ).toBeInTheDocument();
  });
  it("renders paused, degraded, filtered, and stale states", async () => {
    renderLedger(source({
      ...ledger,
      pause: {
        paused: true,
        reason: "maintenance",
        actor: "juno1agent",
        changed_at: "1",
      },
      health: { ...ledger.health, fully_backed: false },
      refreshedAt: new Date(0),
    }));
    expect(
      await screen.findByText(/New activity is paused/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Accounting degraded/)).toBeInTheDocument();
    expect(screen.getByText(/Stale/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "missing");
    expect(screen.getByText("No matching bounties")).toBeInTheDocument();
  });
  it("renders canonical project and refund context", async () => {
    renderLedger(source({
      ...ledger,
      bounties: [
        {
          ...ledger.bounties[0],
          status: "refunding",
          project_candidate: {
            metadata_uri: "https://example.invalid/voice-ui.json",
            metadata_digest: `sha256:${"ab".repeat(32)}`,
          },
          refund_reason: { cancelled: { reason: "scope changed" } },
        },
      ],
    }));
    expect(
      await screen.findByText("Project candidate metadata attached"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Refund: Cancelled · scope changed"),
    ).toBeInTheDocument();
  });
  it("shows errors and retries", async () => {
    const loadLedger = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC offline"))
      .mockResolvedValue(ledger);
    renderLedger({ loadLedger });
    expect(await screen.findByText("RPC offline")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry query" }));
    expect(
      await screen.findByText("Fund community tooling"),
    ).toBeInTheDocument();
    expect(loadLedger).toHaveBeenCalledTimes(2);
  });
});
