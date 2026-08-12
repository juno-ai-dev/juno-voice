import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GaugeVoting } from "./GaugeVoting";
import type { GaugeDataSource } from "./gauge";
import type { GaugeTransactionFlow } from "./gaugeActions";
import { clearGaugeSubmission, saveGaugeSubmission } from "./gaugeSubmissionState";
import { config } from "./test/bountyFixtures";
import { gaugeContext, gaugeData, voter } from "./test/gaugeFixtures";
import type { TransactionOutcome } from "./transactions";

const source: GaugeDataSource = { loadGauge: vi.fn(async () => gaugeData), loadActionContext: vi.fn(async () => gaugeContext) };
const review = { reviewId: "review", flowBinding: "flow", sender: voter, chainId: "juno-1", contract: config.gaugeContract, executeMessage: { place_votes: { gauge: 0, votes: [{ option: "alpha", weight: "0.5" }] } }, funds: [], fee: { gas: "100000", amount: [{ denom: "ujuno", amount: "7500" }] }, consequences: ["Replace ballot"], canonicalState: { fingerprint: gaugeContext.fingerprint, height: 40_000_100 }, walletRevision: 1 } as const;
function flow(): GaugeTransactionFlow { return { connect: vi.fn(async () => ({ address: voter })), prepare: vi.fn(async () => review), submit: vi.fn(async () => ({ status: "confirmed" as const, confirmationStatus: "confirmed" as const, refreshStatus: "refreshed" as const, txHash: "ABC", height: 40_000_101, explorerUrl: "https://www.mintscan.io/juno/tx/ABC" })) }; }
const submissionScope = { sender: voter, chainId: config.chainId, contract: config.gaugeContract, gaugeId: 0 as const };
async function prepareAndSubmit(transactionFlow: GaugeTransactionFlow) {
  await userEvent.click(await screen.findByRole("button", { name: "Prepare ballot revision" }));
  await userEvent.click(await screen.findByRole("button", { name: "Recheck state, then sign" }));
  expect(transactionFlow.submit).toHaveBeenCalledTimes(1);
}

describe("gauge voting UI", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); clearGaugeSubmission(submissionScope); });
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
  it("restores a pending action and epoch lock with exact explorer evidence across dynamic-key replacement and navigation", async () => {
    const transactionFlow = flow(); vi.mocked(transactionFlow.submit).mockResolvedValueOnce({ status: "pending", txHash: "GAUGE_KNOWN", explorerUrl: "https://www.mintscan.io/juno/tx/GAUGE_KNOWN" });
    const view = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await prepareAndSubmit(transactionFlow);
    expect(await screen.findByText(/Action: Place votes · Epoch 2/)).toBeVisible();
    expect(screen.getByRole("link", { name: /transaction evidence GAUGE_KNOWN/ })).toHaveAttribute("href", "https://www.mintscan.io/juno/tx/GAUGE_KNOWN");
    expect(screen.getByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Prepare ballot removal" })).toBeDisabled();

    const changed = { ...gaugeData, ballot: { ...gaugeData.ballot!, revisedAt: 2201 } };
    view.rerender(<GaugeVoting source={{ ...source, loadGauge: vi.fn(async () => changed) }} config={config} sender={voter} transactionFlow={transactionFlow} />);
    expect(await screen.findByRole("link", { name: /transaction evidence GAUGE_KNOWN/ })).toHaveAttribute("href", "https://www.mintscan.io/juno/tx/GAUGE_KNOWN");
    expect(screen.getByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();

    view.unmount();
    render(<GaugeVoting source={source} config={config} transactionFlow={transactionFlow} />);
    expect(await screen.findByText(/Action: Place votes · Epoch 2/)).toBeVisible();
    expect(screen.getByRole("link", { name: /transaction evidence GAUGE_KNOWN/ })).toHaveAttribute("href", "https://www.mintscan.io/juno/tx/GAUGE_KNOWN");
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
  });

  it("restores hashless unknown action and epoch evidence without inventing a link", async () => {
    const transactionFlow = flow(); vi.mocked(transactionFlow.submit).mockResolvedValueOnce({ status: "unknown" });
    const view = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await prepareAndSubmit(transactionFlow);
    expect(await screen.findByText(/Action: Place votes · Epoch 2/)).toBeVisible();
    expect(screen.getByText(/no transaction hash is available/i)).toHaveTextContent(/do not submit again/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();
    view.unmount();
    render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    expect(await screen.findByText(/Action: Place votes · Epoch 2/)).toBeVisible();
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
  });

  it("prewrites exact hashless evidence before an unresolved submit and restores its disconnected latest-pointer lock", async () => {
    const transactionFlow = flow();
    vi.mocked(transactionFlow.submit).mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await prepareAndSubmit(transactionFlow);

    view.unmount();
    render(<GaugeVoting source={source} config={config} transactionFlow={transactionFlow} />);
    expect(await screen.findByText(/Action: Place votes · Epoch 2/)).toBeVisible();
    expect(screen.getByText(/no transaction hash is available/i)).toHaveTextContent(/do not submit again/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Prepare ballot removal" })).toBeDisabled();
  });

  it("prevents submit when the uncertainty prewrite throws and stays fail-closed across navigation", async () => {
    const transactionFlow = flow();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const view = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await userEvent.click(await screen.findByRole("button", { name: "Prepare ballot revision" }));
    await userEvent.click(await screen.findByRole("button", { name: "Recheck state, then sign" }));
    expect(transactionFlow.submit).not.toHaveBeenCalled();
    expect(await screen.findByText(/Stored gauge submission evidence is malformed or unavailable/)).toHaveTextContent(/remains locked/i);
    view.unmount();
    render(<GaugeVoting source={source} config={config} transactionFlow={transactionFlow} />);
    expect(await screen.findByText(/Stored gauge submission evidence is malformed or unavailable/)).toHaveTextContent(/remains locked/i);
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
  });

  it.each(["synchronous", "rejected promise"])("preserves the prewritten hashless lock when submit throws via a %s exception", async (failure) => {
    const transactionFlow = flow();
    const submissionError = new Error("wallet transport failed after invocation");
    if (failure === "synchronous") vi.mocked(transactionFlow.submit).mockImplementationOnce(() => { throw submissionError; });
    else vi.mocked(transactionFlow.submit).mockRejectedValueOnce(submissionError);
    const view = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await prepareAndSubmit(transactionFlow);
    expect(await screen.findByRole("alert")).toHaveTextContent(submissionError.message);
    expect(screen.getByText(/Action: Place votes · Epoch 2/)).toBeVisible();
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();

    view.unmount();
    render(<GaugeVoting source={source} config={config} transactionFlow={transactionFlow} />);
    expect(await screen.findByText(/Action: Place votes · Epoch 2/)).toBeVisible();
    expect(screen.getByText(/no transaction hash is available/i)).toHaveTextContent(/do not submit again/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Prepare ballot removal" })).toBeDisabled();
  });

  it("retains a malformed fail-closed lock when returned hash evidence cannot replace the prewrite", async () => {
    const transactionFlow = flow();
    vi.mocked(transactionFlow.submit).mockResolvedValueOnce({ status: "pending", txHash: "GAUGE_KNOWN", explorerUrl: "https://www.mintscan.io/juno/tx/GAUGE_KNOWN" });
    const setItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, ...args) {
      writes += 1;
      if (writes === 3) throw new Error("upgrade unavailable");
      return setItem.apply(this, args);
    });
    const view = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await prepareAndSubmit(transactionFlow);
    expect(await screen.findByText(/Stored gauge submission evidence is malformed or unavailable/)).toHaveTextContent(/remains locked/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();

    view.unmount();
    render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    expect(await screen.findByText(/Stored gauge submission evidence is malformed or unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
  });

  it.each(["malformed", "read exception"])("keeps %s restored evidence fail-closed across remount", async (failure) => {
    saveGaugeSubmission({ ...submissionScope, version: 1, action: "place_votes", epoch: 2, status: "unknown" });
    if (failure === "malformed") {
      const key = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!).find((item) => sessionStorage.getItem(item)?.includes('"action"'))!;
      sessionStorage.setItem(key, "not json");
    } else vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const view = render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={flow()} />);
    expect(await screen.findByText(/Stored gauge submission evidence is malformed or unavailable/)).toHaveTextContent(/remains locked/i);
    expect(screen.getByRole("button", { name: "Prepare ballot revision" })).toBeDisabled();
    view.unmount();
    render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={flow()} />);
    expect(await screen.findByText(/Stored gauge submission evidence is malformed or unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Prepare ballot removal" })).toBeDisabled();
  });

  it("uses the latest pointer before connection but never applies another sender's record to a connected account", async () => {
    saveGaugeSubmission({ ...submissionScope, version: 1, action: "execute", epoch: 2, status: "unknown" });
    const disconnected = render(<GaugeVoting source={source} config={config} transactionFlow={flow()} />);
    expect(await screen.findByText(/Action: Execute · Epoch 2/)).toBeVisible();
    disconnected.unmount();
    const other = "juno1lk5htm0xu0t340wtp5dnyxq4q38c8n6fphcw0p";
    render(<GaugeVoting source={source} config={config} transactionFlow={flow()} sender={other} />);
    expect(await screen.findByRole("button", { name: "Prepare ballot revision" })).toBeEnabled();
    expect(screen.queryByText(/Action: Execute · Epoch 2/)).not.toBeInTheDocument();
  });

  it.each([
    { status: "confirmed", confirmationStatus: "confirmed", refreshStatus: "refreshed", txHash: "DONE", height: 40_000_101, explorerUrl: "https://www.mintscan.io/juno/tx/DONE" },
    { status: "failed", reason: "chain failed" },
    { status: "rejected", reason: "wallet rejected" },
  ] as TransactionOutcome[])("does not persist a $status outcome as a stale gauge lock", async (terminal) => {
    const transactionFlow = flow(); vi.mocked(transactionFlow.submit).mockResolvedValueOnce(terminal);
    render(<GaugeVoting source={source} config={config} sender={voter} transactionFlow={transactionFlow} />);
    await prepareAndSubmit(transactionFlow);
    expect(sessionStorage).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Prepare ballot revision" })).toBeEnabled();
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
