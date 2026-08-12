import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Ledger } from "./Ledger";
import { config, ledger } from "./test/bountyFixtures";
const source = (value = ledger) => ({
  loadLedger: vi.fn().mockResolvedValue(value),
});
describe("read-only bounty ledger states", () => {
  it("marks a fresh observation stale while the page remains open", async () => {
    vi.useFakeTimers();
    try {
      render(
        <Ledger
          config={config}
          source={source({ ...ledger, refreshedAt: new Date(Date.now()) })}
        />,
      );
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
    render(
      <Ledger
        config={config}
        source={{
          loadLedger: () =>
            new Promise((r) => {
              done = r;
            }),
        }}
      />,
    );
    expect(
      screen.getByText("Loading mainnet bounty ledger…"),
    ).toBeInTheDocument();
    done(ledger);
    expect(
      await screen.findByText("Fund public goods tooling"),
    ).toBeInTheDocument();
    expect(screen.getByText("juno-1")).toBeInTheDocument();
    expect(screen.getByText("5150")).toBeInTheDocument();
    expect(screen.getByText("Fully backed")).toBeInTheDocument();
    expect(screen.getAllByText("$JUNO 1").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /connect|sign|contribute/i })).not.toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute(
      "datetime",
      "2027-01-15T08:00:00.000Z",
    );
  });
  it("shows authoritative empty state without samples", async () => {
    render(
      <Ledger config={config} source={source({ ...ledger, bounties: [] })} />,
    );
    expect(
      await screen.findByText("No on-chain bounties yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No sample or demo records are shown/),
    ).toBeInTheDocument();
  });
  it("renders paused, degraded, filtered, and stale states", async () => {
    render(
      <Ledger
        config={config}
        source={source({
          ...ledger,
          pause: {
            paused: true,
            reason: "maintenance",
            actor: "juno1agent",
            changed_at: "1",
          },
          health: { ...ledger.health, fully_backed: false },
          refreshedAt: new Date(0),
        })}
      />,
    );
    expect(
      await screen.findByText(/New activity is paused/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Accounting degraded/)).toBeInTheDocument();
    expect(screen.getByText(/Stale/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "missing");
    expect(screen.getByText("No matching bounties")).toBeInTheDocument();
  });
  it("renders canonical project and refund context", async () => {
    render(
      <Ledger
        config={config}
        source={source({
          ...ledger,
          bounties: [
            {
              ...ledger.bounties[0],
              status: "refunding",
              project_candidate: {
                project_id: "voice-ui",
                metadata_uri: "https://example.invalid/voice-ui.json",
                metadata_digest: `sha256:${"ab".repeat(32)}`,
              },
              refund_reason: { cancelled: { reason: "scope changed" } },
            },
          ],
        })}
      />,
    );
    expect(
      await screen.findByText("Project candidate · voice-ui"),
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
    render(<Ledger config={config} source={{ loadLedger }} />);
    expect(await screen.findByText("RPC offline")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry query" }));
    expect(
      await screen.findByText("Fund public goods tooling"),
    ).toBeInTheDocument();
    expect(loadLedger).toHaveBeenCalledTimes(2);
  });
});
