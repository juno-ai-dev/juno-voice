import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "./Registry";
import type { RegistryDataSource } from "./registry";
import type { RegistryTransactionFlow } from "./registryActions";
import { config } from "./test/bountyFixtures";
import type { TransactionReview } from "./transactions";

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const data = {
  config: { native_denom: "ujuno", registration_bond: "1000000", max_active_projects: 99,
    max_metadata_uri_bytes: 512, max_page_limit: 50, max_reason_bytes: 500,
    payout_address_delay_seconds: 86400, curator: sender, governor: sender, version: 1 },
  pause: { admissions_stopped: false, adapter_stopped: false, reason: null, actor: null, changed_at: null },
  health: { accounting: { active_projects: 0, pending_applications: 0, bond_liability: "0",
    lifetime_bonds_received: "0", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" },
    actual_native_balance: "0", fully_backed: true }, projects: [], applications: [], options: ["do-not-distribute"],
  observationHeight: 100, refreshedAt: new Date(0), weakConsistency: true as const,
};
const source = (): RegistryDataSource => ({
  loadRegistry: vi.fn(async () => data), loadProject: vi.fn(),
  loadActionContext: vi.fn(async () => ({ data, project: null, chainTimeNanos: "10", fingerprint: "registry" })),
});
const review: TransactionReview = { reviewId: "r", flowBinding: "f", sender, chainId: "juno-1",
  contract: config.registryContract, executeMessage: { register_project: { project_id: "alpha", metadata_uri: "ipfs://alpha",
    metadata_digest: `sha256:${"a".repeat(64)}`, payout_address: sender } }, funds: [{ denom: "ujuno", amount: "1000000" }],
  fee: { gas: "180000", amount: [{ denom: "ujuno", amount: "4500" }] }, consequences: ["Register"],
  canonicalState: { fingerprint: "registry", height: 100 }, walletRevision: 1 };
const flow = (): RegistryTransactionFlow => ({ connect: vi.fn(async () => ({ address: sender })),
  prepare: vi.fn(async () => review), submit: vi.fn(async () => ({ status: "unknown" as const, txHash: "KNOWN",
    explorerUrl: "https://www.mintscan.io/juno/tx/KNOWN" })) });
async function prepareAndSubmit(port: RegistryTransactionFlow) {
  await screen.findByText("Eligible projects");
  await userEvent.type(screen.getByLabelText("Project ID"), "alpha");
  await userEvent.type(screen.getByLabelText("Metadata URI"), "ipfs://alpha");
  await userEvent.type(screen.getByLabelText("SHA-256 metadata digest"), `sha256:${"a".repeat(64)}`);
  await userEvent.type(screen.getByLabelText("Payout address"), sender);
  await userEvent.click(screen.getByRole("button", { name: "Prepare wallet review" }));
  expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ contract: config.registryContract,
    funds: [{ denom: "ujuno", amount: "1000000" }], expectedStateFingerprint: "registry" }));
  await userEvent.click(await screen.findByRole("button", { name: "Recheck state, then sign" }));
}

describe("registry transaction UI evidence", () => {
  it("keeps known-hash explorer evidence visible and disables duplicate submission", async () => {
    const port = flow(); const view = render(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />);
    expect(await screen.findAllByRole("option")).toHaveLength(7);
    expect(screen.queryByText(/override project status|review registration|update curator/i)).not.toBeInTheDocument();
    await prepareAndSubmit(port);
    expect(await screen.findByText(/Submission is not canonically confirmed/)).toHaveTextContent(/do not submit again/i);
    const evidence = screen.getByRole("link", { name: /transaction evidence KNOWN/ });
    expect(evidence).toHaveAttribute("href", "https://www.mintscan.io/juno/tx/KNOWN");
    expect(screen.getByRole("button", { name: "Prepare wallet review" })).toBeDisabled();
    view.rerender(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />);
    expect(evidence).toBeInTheDocument();
  });

  it("locks a hashless uncertain action without inventing explorer evidence", async () => {
    const port = flow(); vi.mocked(port.submit).mockResolvedValueOnce({ status: "unknown" });
    render(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />);
    await prepareAndSubmit(port);
    expect(await screen.findByText(/no transaction hash is available/i)).toHaveTextContent(/Do not submit again/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare wallet review" })).toBeDisabled();
  });

  it("keeps confirmed explorer evidence across a canonical-data rerender", async () => {
    const port = flow(); vi.mocked(port.submit).mockResolvedValueOnce({ status: "confirmed", txHash: "CONFIRMED", height: 101,
      confirmationStatus: "confirmed", refreshStatus: "refreshed", explorerUrl: "https://www.mintscan.io/juno/tx/CONFIRMED" });
    const view = render(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />);
    await prepareAndSubmit(port);
    const evidence = await screen.findByRole("link", { name: /confirmed transaction CONFIRMED/ });
    view.rerender(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />);
    expect(evidence).toBeInTheDocument();
  });
});
