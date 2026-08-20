import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 15_000 });
import { ProjectDetailRoute, ProjectManageRoute, Registry } from "./ProjectRegistry";
import { digestMetadataFile } from "./metadataDigest";
import type { Project, RegistryDataSource } from "./registry";
import type { RegistryTransactionFlow } from "./registryActions";
import { clearRegistrySubmission, saveRegistrySubmission } from "./registrySubmissionState";
import { config } from "./test/bountyFixtures";
import type { TransactionReview } from "./transactions";

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const data = {
  config: { native_denom: "ujuno", registration_bond: "100000000", max_active_projects: 99,
    max_metadata_uri_bytes: 512, max_page_limit: 100, max_reason_bytes: 2048,
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
  contract: config.registryContract, executeMessage: { register_project: { metadata_uri: "ipfs://alpha",
    metadata_digest: `sha256:${"a".repeat(64)}`, payout_address: sender } }, funds: [{ denom: "ujuno", amount: "100000000" }],
  fee: { gas: "180000", amount: [{ denom: "ujuno", amount: "4500" }] }, consequences: ["Register"],
  canonicalState: { fingerprint: "registry", height: 100 }, walletRevision: 1 };
const flow = (): RegistryTransactionFlow => ({ connect: vi.fn(async () => ({ address: sender })),
  prepare: vi.fn(async () => review), submit: vi.fn(async () => ({ status: "pending" as const, txHash: "KNOWN",
    explorerUrl: "https://www.mintscan.io/juno/tx/KNOWN" })) });
const wrap = (ui: ReactElement) => (
  <MemoryRouter initialEntries={["/projects"]}>
    <Routes>
      <Route path="/projects" element={ui}>
        <Route path="manage" element={<ProjectManageRoute />} />
        <Route path=":projectId" element={<ProjectDetailRoute />} />
      </Route>
    </Routes>
  </MemoryRouter>
);
async function openProjectWorkbench() {
  await screen.findByText("Eligible projects");
  const launcher = screen.queryByRole("link", { name: "Open project actions" });
  if (launcher && !screen.queryByRole("dialog", { name: "Choose a project action" })) await userEvent.click(launcher);
  await screen.findByRole("dialog", { name: "Choose a project action" });
}
async function prepareAndSubmit(port: RegistryTransactionFlow) {
  await screen.findByText("Eligible projects");
  await openProjectWorkbench();
  await userEvent.type(screen.getByLabelText("Metadata URI"), "ipfs://alpha");
  await userEvent.type(screen.getByLabelText("SHA-256 metadata digest"), `sha256:${"a".repeat(64)}`);
  await userEvent.type(screen.getByLabelText("Payout address"), sender);
  await userEvent.click(screen.getByRole("button", { name: "Review project action" }));
  expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ contract: config.registryContract,
    funds: [{ denom: "ujuno", amount: "100000000" }], expectedStateFingerprint: "registry" }));
  const reviewBox = screen.getByText("Review before signing").parentElement!;
  expect(reviewBox).toHaveTextContent("$JUNO 100");
  expect(reviewBox).toHaveTextContent("$JUNO 0.0045");
  expect(reviewBox).not.toHaveTextContent("ujuno");
  await userEvent.click(await screen.findByRole("button", { name: "Confirm and open wallet" }));
}

describe("registry transaction UI evidence", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearRegistrySubmission({ sender, chainId: config.chainId, contract: config.registryContract }); });

  it("publishes structured project details and reviews the pinned reference", async () => {
    const port = flow();
    const publisher = {
      publishDocument: vi.fn(async () => ({ uri: "ipfs://bafypinned", digest: `sha256:${"c".repeat(64)}`, size: 42 })),
      publishImage: vi.fn(),
    };
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} publisher={publisher} />));
    await openProjectWorkbench();
    expect(screen.queryByLabelText("Metadata URI")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Project name/), "Alpha");
    await userEvent.type(screen.getByLabelText(/^Short summary/), "A project.");
    await userEvent.type(screen.getByLabelText("Payout address"), sender);
    await userEvent.click(screen.getByRole("button", { name: "Review project action" }));
    await vi.waitFor(() => expect(port.prepare).toHaveBeenCalled());
    expect(publisher.publishDocument).toHaveBeenCalledWith("project.json",
      expect.objectContaining({ doc: "juno-voice/project", name: "Alpha", summary: "A project." }));
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { register_project: expect.objectContaining({
      metadata_uri: "ipfs://bafypinned", metadata_digest: `sha256:${"c".repeat(64)}` }) } }));
  });

  it("accepts a DAO contract as the payout address", async () => {
    const dao = "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac";
    const port = flow();
    const publisher = {
      publishDocument: vi.fn(async () => ({ uri: "ipfs://bafypinned", digest: `sha256:${"c".repeat(64)}`, size: 42 })),
      publishImage: vi.fn(),
    };
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} publisher={publisher} />));
    await openProjectWorkbench();
    await userEvent.type(screen.getByLabelText(/^Project name/), "Alpha");
    await userEvent.type(screen.getByLabelText(/^Short summary/), "A project.");
    await userEvent.type(screen.getByLabelText("Payout address"), dao);
    await userEvent.click(screen.getByRole("button", { name: "Review project action" }));
    await vi.waitFor(() => expect(port.prepare).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { register_project:
      expect.objectContaining({ payout_address: dao }) } }));
  });

  it("keeps the manual link mode reachable as an advanced escape hatch", async () => {
    const publisher = { publishDocument: vi.fn(), publishImage: vi.fn() };
    render(wrap(<Registry source={source()} config={config} transactionFlow={flow()} sender={sender} publisher={publisher} />));
    await openProjectWorkbench();
    await userEvent.click(screen.getByRole("button", { name: "Advanced: link a file you already published" }));
    expect(screen.getByLabelText("Metadata URI")).toBeInTheDocument();
    expect(screen.getByLabelText("SHA-256 metadata digest")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fill in project details instead" }));
    expect(screen.getByLabelText(/^Project name/)).toBeInTheDocument();
  });

  it("shows a plain publishing error and signs nothing when validation fails", async () => {
    const port = flow();
    const publisher = { publishDocument: vi.fn(), publishImage: vi.fn() };
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} publisher={publisher} />));
    await openProjectWorkbench();
    await userEvent.type(screen.getByLabelText(/^Short summary/), "A project.");
    await userEvent.type(screen.getByLabelText("Payout address"), sender);
    await userEvent.click(screen.getByRole("button", { name: "Review project action" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Project name is required.");
    expect(port.prepare).not.toHaveBeenCalled();
    expect(publisher.publishDocument).not.toHaveBeenCalled();
  });

  it("uses project metadata as the primary label and keeps the numeric ID secondary", async () => {
    const project: Project = {
      id: 7, owner: sender, payout_address: sender, metadata_uri: "ipfs://alpha-project",
      metadata_digest: `sha256:${"a".repeat(64)}`, status: "active", created_at: "1",
      updated_at: "1", status_history_count: 1, address_history_count: 0,
      provenance: { kind: "bonded_registration", applicant: sender },
      bond: { amount: "100000000", depositor: sender, state: "deposited" },
      pending_payout_address: null, latest_review: null,
    };
    const populated = source();
    vi.mocked(populated.loadRegistry).mockResolvedValue({ ...data, projects: [project] });
    render(wrap(<Registry source={populated} config={config} />));

    expect(await screen.findByRole("heading", { name: project.metadata_uri })).toBeInTheDocument();
    expect(screen.getByText("Project #7")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^7$/ })).not.toBeInTheDocument();
  });

  it("calculates a canonical metadata digest without uploading the selected file", async () => {
    const bytes = new Uint8Array(32); bytes[0] = 1; bytes[31] = 255;
    const digest = vi.fn(async () => bytes.buffer);
    vi.stubGlobal("crypto", { subtle: { digest } });
    const fileBytes = new Uint8Array([123, 125]).buffer;
    const file = { arrayBuffer: vi.fn(async () => fileBytes) } as unknown as File;
    expect(await digestMetadataFile(file)).toBe(`sha256:01${"00".repeat(30)}ff`);
    expect(digest).toHaveBeenCalledWith("SHA-256", fileBytes);
  });

  it("restores a known-hash pending lock and explorer evidence after unmount and remount", async () => {
    const port = flow(); const view = render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    await screen.findByText("Eligible projects");
    expect(screen.queryByLabelText("Project action")).not.toBeInTheDocument();
    await openProjectWorkbench();
    expect(screen.getByRole("heading", { name: "Choose a project action" })).toBeInTheDocument();
    expect(screen.queryByText("Prepare an exact transaction")).not.toBeInTheDocument();
    expect(await screen.findAllByRole("option")).toHaveLength(7);
    expect(screen.queryByText(/override project status|review registration|update curator/i)).not.toBeInTheDocument();
    await prepareAndSubmit(port);
    expect(await screen.findByText(/Submission is not canonically confirmed/)).toHaveTextContent(/do not submit again/i);
    const evidence = screen.getByRole("link", { name: /transaction evidence KNOWN/ });
    expect(evidence).toHaveAttribute("href", "https://www.mintscan.io/juno/tx/KNOWN");
    expect(screen.getByRole("button", { name: "Review project action" })).toBeDisabled();
    expect(sessionStorage.length).toBeGreaterThan(0);
    view.unmount();
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} />));
    await openProjectWorkbench();
    expect(await screen.findByRole("link", { name: /transaction evidence KNOWN/ })).toHaveAttribute("href", "https://www.mintscan.io/juno/tx/KNOWN");
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByRole("button", { name: "Review project action" })).toBeDisabled();
  });

  it("writes scoped unknown evidence before invoking transaction submission", async () => {
    let finish!: (value: { status: "unknown" }) => void;
    const signing = new Promise<{ status: "unknown" }>((resolve) => { finish = resolve; });
    const port = flow(); vi.mocked(port.submit).mockReturnValueOnce(signing);
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    await prepareAndSubmit(port);
    await vi.waitFor(() => expect(port.submit).toHaveBeenCalledWith(review));
    expect(Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)))
      .toContainEqual(expect.stringContaining('"action":"register_project"'));
    expect(screen.getByLabelText("Project action")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Checking latest state…" })).toBeDisabled();
    finish({ status: "unknown" });
  });

  it("refuses a prepared review whose action differs from the selected action", async () => {
    const port = flow();
    vi.mocked(port.prepare).mockResolvedValueOnce({ ...review, executeMessage: { retire: { project_id: 1 } } });
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    await screen.findByText("Eligible projects"); await openProjectWorkbench();
    await userEvent.type(screen.getByLabelText("Metadata URI"), "ipfs://alpha");
    await userEvent.type(screen.getByLabelText("SHA-256 metadata digest"), `sha256:${"a".repeat(64)}`);
    await userEvent.type(screen.getByLabelText("Payout address"), sender);
    await userEvent.click(screen.getByRole("button", { name: "Review project action" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm and open wallet" }));
    expect(port.submit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer matches.*Nothing was submitted/i);
  });

  it("restores a hashless unknown lock after unmount and remount without inventing explorer evidence", async () => {
    const port = flow(); vi.mocked(port.submit).mockResolvedValueOnce({ status: "unknown" });
    const view = render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    await prepareAndSubmit(port);
    expect(await screen.findByText(/no transaction hash is available/i)).toHaveTextContent(/Do not submit again/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review project action" })).toBeDisabled();
    expect(sessionStorage.length).toBeGreaterThan(0);
    view.unmount();
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} />));
    await openProjectWorkbench();
    expect(await screen.findByText(/no transaction hash is available/i)).toHaveTextContent(/Do not submit again/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByRole("button", { name: "Review project action" })).toBeDisabled();
  });

  it("remains fail-closed after remount when uncertainty cannot be written to session storage", async () => {
    const port = flow(); vi.mocked(port.submit).mockResolvedValueOnce({ status: "unknown" });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const view = render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    await prepareAndSubmit(port);
    expect(await screen.findByText(/Stored submission evidence is malformed or unavailable/)).toHaveTextContent(/remains locked/i);
    expect(screen.getByRole("button", { name: "Review project action" })).toBeDisabled();
    view.unmount();
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} />));
    await openProjectWorkbench();
    expect(await screen.findByText(/Stored submission evidence is malformed or unavailable/)).toHaveTextContent(/remains locked/i);
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByRole("button", { name: "Review project action" })).toBeDisabled();
    setItem.mockRestore();
  });

  it("keeps confirmed explorer evidence across a canonical-data rerender", async () => {
    const port = flow(); vi.mocked(port.submit).mockResolvedValueOnce({ status: "confirmed", txHash: "CONFIRMED", height: 101,
      confirmationStatus: "confirmed", refreshStatus: "refreshed", explorerUrl: "https://www.mintscan.io/juno/tx/CONFIRMED" });
    const view = render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    await prepareAndSubmit(port);
    const evidence = await screen.findByRole("link", { name: /confirmed transaction CONFIRMED/ });
    expect(sessionStorage).toHaveLength(0);
    view.rerender(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    expect(evidence).toBeInTheDocument();
  });

  it.each([
    { status: "failed" as const, reason: "chain rejected the execution" },
    { status: "rejected" as const, reason: "wallet rejected the request" },
  ])("does not persist a $status outcome as a stale lock", async (terminal) => {
    const port = flow(); vi.mocked(port.submit).mockResolvedValueOnce(terminal);
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} sender={sender} />));
    await prepareAndSubmit(port);
    expect(await screen.findByText(terminal.reason)).toBeInTheDocument();
    expect(sessionStorage).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Review project action" })).toBeEnabled();
  });

  it("fails closed when persisted uncertainty is malformed", async () => {
    saveRegistrySubmission({ version: 1, sender, chainId: config.chainId, contract: config.registryContract,
      action: "register_project", status: "unknown" });
    const evidenceKey = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!)
      .find((key) => sessionStorage.getItem(key)?.includes('"action"'))!;
    sessionStorage.setItem(evidenceKey, "not json");
    const port = flow();
    render(wrap(<Registry source={source()} config={config} transactionFlow={port} />));
    await openProjectWorkbench();
    expect(await screen.findByText(/Stored submission evidence is malformed or unavailable/)).toHaveTextContent(/remains locked/i);
    expect(screen.getByLabelText("Project action")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByRole("button", { name: "Review project action" })).toBeDisabled();
  });
});
