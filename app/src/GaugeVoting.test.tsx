import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { GaugeVoting } from "./GaugeVoting";
import type { GaugeDataSource } from "./gauge";
import type { GaugeTransactionFlow } from "./gaugeActions";
import { config } from "./test/bountyFixtures";
import { gaugeContext, gaugeData, voter } from "./test/gaugeFixtures";

const source: GaugeDataSource = { loadGauge: vi.fn(async () => gaugeData), loadActionContext: vi.fn(async () => gaugeContext) };
const review = { reviewId: "review", flowBinding: "flow", sender: voter, chainId: "juno-1", contract: config.gaugeContract, executeMessage: { place_votes: { gauge: 0, votes: [{ option: "alpha", weight: "0.5" }] } }, funds: [], fee: { gas: "100000", amount: [{ denom: "ujuno", amount: "7500" }] }, consequences: ["Replace ballot"], canonicalState: { fingerprint: gaugeContext.fingerprint, height: 40_000_100 }, walletRevision: 1 } as const;
function flow(): GaugeTransactionFlow { return { connect: vi.fn(async () => ({ address: voter })), prepare: vi.fn(async () => review), submit: vi.fn(async () => ({ status: "confirmed" as const, confirmationStatus: "confirmed" as const, refreshStatus: "refreshed" as const, txHash: "ABC", height: 40_000_101, explorerUrl: "https://www.mintscan.io/juno/tx/ABC" })) }; }

describe("gauge voting UI", () => {
  it("renders fixed facts, historical options, retained-value semantics, and a connected ballot", async () => {
    render(<GaugeVoting source={source} config={config} sender={voter} />);
    expect(await screen.findByRole("heading", { name: "Weighted allocation" })).toBeVisible();
    expect(screen.getByText("40,000,002")).toBeVisible();
    expect(screen.getAllByText("do-not-distribute").length).toBeGreaterThan(0);
    expect(screen.getByText(/Nothing shown here implies automatic rollover/)).toBeVisible();
    expect(screen.getByDisplayValue("0.5")).toBeVisible();
  });
  it("shows exact stage-one review and invokes submission only at stage two", async () => {
    const transactionFlow = flow();
    render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await screen.findByDisplayValue("0.5");
    await userEvent.click(screen.getByRole("button", { name: "Prepare ballot revision" }));
    expect(await screen.findByRole("dialog", { name: "Exact transaction review" })).toHaveTextContent('"place_votes"');
    expect(screen.getByRole("dialog")).toHaveTextContent('"funds": []');
    expect(transactionFlow.submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Recheck state, then sign" }));
    expect(transactionFlow.submit).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Confirmed at height 40000101/)).toBeVisible();
  });
  it("prepares explicit null ballot removal", async () => {
    const transactionFlow = flow();
    render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await userEvent.click(await screen.findByRole("button", { name: "Prepare ballot removal" }));
    expect(source.loadActionContext).toHaveBeenCalledWith(voter);
    expect(transactionFlow.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { place_votes: { gauge: 0, votes: null } }, funds: [] }));
  });
  it("states the distinct gauge-stop and adapter-stop execution semantics", async () => {
    const gaugeStopped = { ...gaugeData, gauge: { ...gaugeData.gauge, isStopped: true } };
    const { unmount } = render(<GaugeVoting source={{ ...source, loadGauge: vi.fn(async () => gaugeStopped) }} config={config} sender={voter} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Opening, voting, and all epoch execution are disabled");
    unmount();
    const adapterStopped = { ...gaugeData, adapterStopped: true };
    render(<GaugeVoting source={{ ...source, loadGauge: vi.fn(async () => adapterStopped) }} config={config} sender={voter} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("distribution-producing execution");
    expect(alert).toHaveTextContent("No-turnout or no-candidate terminalization may remain available");
  });
  it("has no WCAG A/AA violations in the populated responsive structure", async () => {
    const { container } = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={flow()} />);
    await screen.findByRole("heading", { name: "Weighted allocation" });
    expect((await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })).violations).toEqual([]);
  });
});
