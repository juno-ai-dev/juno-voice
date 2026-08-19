import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toBech32 } from "@cosmjs/encoding";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BountyActions, type BountyTransactionAccess } from "./BountyActions";
import { config, ledger, bounty } from "./test/bountyFixtures";
import type { TransactionReview } from "./transactions";
import type { BountyDetail, PayoutRound } from "./types";
const canonical = { config: ledger.config, pause: ledger.pause, chainTimeNanos: ledger.chainTimeNanos, fingerprint: ledger.fingerprint };
const review: TransactionReview = { reviewId: "r", flowBinding: "f", sender: bounty.creator, chainId: "juno-1",
  contract: config.contract,
  executeMessage: { contribute: { bounty_id: 1 } }, funds: [{ denom: "ujuno", amount: "1000000" }],
  fee: { gas: "180000", amount: [{ denom: "ujuno", amount: "4500" }] }, consequences: ["Exact consequence"],
  canonicalState: { fingerprint: ledger.fingerprint, height: 123 }, walletRevision: 1 };
const access = (): BountyTransactionAccess => ({ connect: vi.fn(async () => ({ address: bounty.creator })),
  prepare: vi.fn(async () => review), submit: vi.fn(async () => ({ status: "confirmed" as const, txHash: "ABC", height: 124,
    confirmationStatus: "confirmed" as const, refreshStatus: "refreshed" as const, explorerUrl: "https://www.mintscan.io/juno/tx/ABC" })) });
describe("bounty action UI", () => {
  beforeEach(() => sessionStorage.clear());
  it("keeps read-only access and explains unavailable wallet support", () => {
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} />);
    expect(screen.queryByText(/Eligibility uses canonical chain time/)).not.toBeInTheDocument();
    expect(screen.getByText(/Browsing does not require a wallet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect wallet and review bounty/ })).toBeInTheDocument();
  });
  it("constructs exact create message/funds from accessible controls and discloses review", async () => {
    const port = access(); render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} />);
    await userEvent.type(screen.getByLabelText(/^Title/), "Ship tooling");
    await userEvent.type(screen.getByLabelText(/^Summary/), "Useful tooling");
    await userEvent.type(screen.getByLabelText(/^Acceptance criteria/), "Tests pass");
    const displayedExpiry = (screen.getByLabelText(/^Expiration date and time/) as HTMLInputElement).value;
    const expiry = (BigInt(new Date(displayedExpiry).getTime()) * 1_000_000n).toString();
    await userEvent.click(screen.getByRole("button", { name: /Connect wallet and review bounty/ }));
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ funds: [{ denom: "ujuno", amount: "1000000" }],
      executeMessage: { create_bounty: expect.objectContaining({ title: "Ship tooling", expires_at: expiry }) },
      expectedStateFingerprint: ledger.fingerprint }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Exact transaction review");
    expect(screen.getByText("$JUNO 1")).toBeInTheDocument();
  });
  it("makes optional project-candidate semantics explicit and reviews the exact metadata", async () => {
    const port = access(); render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} />);
    await userEvent.type(screen.getByLabelText(/^Title/), "Ship tooling");
    await userEvent.type(screen.getByLabelText(/^Summary/), "Useful tooling");
    await userEvent.type(screen.getByLabelText(/^Acceptance criteria/), "Tests pass");
    await userEvent.click(screen.getByText("Propose a project candidate"));
    await userEvent.type(screen.getByLabelText(/^Project metadata URI/), "ipfs://bafyproject");
    await userEvent.type(screen.getByLabelText(/^Project metadata SHA-256 digest/), `sha256:${"ab".repeat(32)}`);
    await userEvent.click(screen.getByRole("button", { name: /Connect wallet and review bounty/ }));
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { create_bounty: expect.objectContaining({
      project_candidate: { metadata_uri: "ipfs://bafyproject", metadata_digest: `sha256:${"ab".repeat(32)}` },
    }) } }));
    expect(screen.getByText(/does not allocate a registry ID/)).toBeInTheDocument();
  });
  it("publishes structured content and candidate documents before preparing the intent", async () => {
    const port = access();
    const publisher = {
      publishDocument: vi.fn(async (filename: string) => filename === "project.json"
        ? { uri: "ipfs://bafycandidate", digest: `sha256:${"d".repeat(64)}`, size: 1 }
        : { uri: "ipfs://bafycontent", digest: `sha256:${"e".repeat(64)}`, size: 1 }),
      publishImage: vi.fn(),
    };
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} publisher={publisher} />);
    await userEvent.type(screen.getByLabelText(/^Title/), "Ship tooling");
    await userEvent.type(screen.getByLabelText(/^Summary/), "Useful tooling");
    await userEvent.type(screen.getByLabelText(/^Acceptance criteria/), "Tests pass");
    await userEvent.click(screen.getByText("Add supporting content"));
    expect(screen.queryByLabelText(/^Content URI/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Full brief/), "The full brief.");
    await userEvent.click(screen.getByText("Propose a project candidate"));
    await userEvent.type(screen.getByLabelText(/^Project name/), "Alpha");
    await userEvent.type(screen.getByLabelText(/^Short summary/), "A project.");
    await userEvent.click(screen.getByRole("button", { name: /Connect wallet and review bounty/ }));
    await vi.waitFor(() => expect(port.prepare).toHaveBeenCalled());
    expect(publisher.publishDocument).toHaveBeenCalledWith("bounty-content.json", expect.objectContaining({ brief: "The full brief." }));
    expect(publisher.publishDocument).toHaveBeenCalledWith("project.json", expect.objectContaining({ name: "Alpha" }));
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { create_bounty: expect.objectContaining({
      content_uri: "ipfs://bafycontent", content_digest: `sha256:${"e".repeat(64)}`,
      project_candidate: { metadata_uri: "ipfs://bafycandidate", metadata_digest: `sha256:${"d".repeat(64)}` },
    }) } }));
  });
  it("publishes a structured evidence document for a payout nomination", async () => {
    const port = access(), recipient = toBech32("juno", new Uint8Array(20).fill(4));
    const publisher = {
      publishDocument: vi.fn(async () => ({ uri: "ipfs://bafyevidence", digest: `sha256:${"f".repeat(64)}`, size: 1 })),
      publishImage: vi.fn(),
    };
    const settlement: BountyDetail = { bounty, config: ledger.config, pause: ledger.pause, activeRound: null, rounds: [], receipts: [],
      moderation: null, graduation: null, contributions: [{ bounty_id: 1, contributor: bounty.creator, contributor_index: 1,
        current_amount: "2500000", weight_at_round: null }], claims: [], history: [], observationHeight: 1,
      chainTimeNanos: ledger.chainTimeNanos, fingerprint: ledger.fingerprint };
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty}
      contributions={settlement.contributions} settlement={settlement} publisher={publisher} />);
    await userEvent.type(screen.getByLabelText("Recipient Juno address"), recipient);
    expect(screen.queryByLabelText("Evidence URI (HTTPS/IPFS)")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^What was delivered/), "Shipped the tooling.");
    await userEvent.type(screen.getByLabelText("Evidence link 1"), "https://github.example/pr/1");
    await userEvent.type(screen.getByLabelText("Nomination rationale"), "Acceptance criteria shipped");
    await userEvent.click(screen.getByRole("button", { name: "Review payout nomination" }));
    await vi.waitFor(() => expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { nominate_payout: expect.objectContaining({
      evidence_uri: "ipfs://bafyevidence", evidence_digest: `sha256:${"f".repeat(64)}`,
    }) } })));
    expect(publisher.publishDocument).toHaveBeenCalledWith("evidence.json", expect.objectContaining({
      summary: "Shipped the tooling.", items: [{ kind: "pull_request", url: "https://github.example/pr/1" }],
    }));
  });
  it("calculates a lowercase SHA-256 digest locally from a selected metadata file", async () => {
    const digestBytes = new Uint8Array(32).fill(0xab);
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => digestBytes.buffer) } });
    try {
      render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={access()} />);
      await userEvent.click(screen.getByText("Add supporting content"));
      const file = new File(["metadata"], "metadata.json", { type: "application/json" });
      Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("metadata").buffer });
      await userEvent.upload(screen.getByLabelText("Calculate content digest from file"), file);
      expect(await screen.findByRole("status")).toHaveTextContent(/calculated locally.*not uploaded/i);
      expect(screen.getByLabelText(/^Content SHA-256 digest/)).toHaveValue(`sha256:${"ab".repeat(32)}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("blocks stale preparation before wallet access", async () => {
    const port = access(); render(<BountyActions bountyContract={config.contract} canonical={canonical} stale access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(/stale/);
    expect(port.connect).not.toHaveBeenCalled(); expect(port.prepare).not.toHaveBeenCalled();
  });
  it("converts a decimal $JUNO contribution to exact ujuno only at intent construction", async () => {
    const port = access(); render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1.000001");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({
      funds: [{ denom: "ujuno", amount: "1000001" }],
      consequences: expect.arrayContaining([expect.stringContaining("$JUNO 1.000001")]),
    }));
  });
  it("submits only the reviewed object through the shared lifecycle", async () => {
    const port = access(); render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Recheck state, then sign/ }));
    expect(port.submit).toHaveBeenCalledWith(review);
    expect(await screen.findByRole("status")).toHaveTextContent(/Confirmed at height 124/);
  });
  it("writes a hashless scoped uncertainty lock before invoking the signer and restores it after remount", async () => {
    let finish!: (value: { status: "unknown" }) => void;
    const signing = new Promise<{ status: "unknown" }>((resolve) => { finish = resolve; });
    const port = access(); vi.mocked(port.submit).mockReturnValueOnce(signing);
    const view = render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Recheck state, then sign/ }));
    await vi.waitFor(() => expect(port.submit).toHaveBeenCalledWith(review));
    expect(Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)))
      .toContainEqual(expect.stringContaining('"status":"unknown"'));
    view.unmount();
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    expect(screen.getByRole("button", { name: /review contribution/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/no transaction hash is available.*Do not submit again/i);
    finish({ status: "unknown" });
  });
  it("refuses a prepared review whose sender or action differs from the requested intent", async () => {
    const port = access();
    vi.mocked(port.prepare).mockResolvedValueOnce({ ...review, sender: toBech32("juno", new Uint8Array(20).fill(9)),
      executeMessage: { expire: { bounty_id: 1 } } });
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Recheck state, then sign/ }));
    expect(port.submit).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/no longer matches.*Nothing was submitted/i);
  });
  it("keeps known-hash evidence visible while canonical state is incomplete", async () => {
    const port = access();
    vi.mocked(port.submit).mockResolvedValueOnce({ status: "unknown", txHash: "KNOWN",
      explorerUrl: "https://www.mintscan.io/juno/tx/KNOWN" });
    const view = render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Recheck state, then sign/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(/do not submit again/i);
    const evidence = screen.getByRole("link", { name: /transaction evidence KNOWN/ });
    expect(evidence).toHaveAttribute("href", "https://www.mintscan.io/juno/tx/KNOWN");
    expect(screen.getByRole("button", { name: /review contribution/ })).toBeDisabled();
    view.rerender(<BountyActions bountyContract={config.contract} canonical={{ ...canonical, chainTimeNanos: "1700000001000000000" }}
      stale={false} access={port} bounty={bounty} />);
    expect(evidence).toBeInTheDocument();
  });
  it("discloses hashless post-sign uncertainty without explorer evidence or a retry action", async () => {
    const port = access(); vi.mocked(port.submit).mockResolvedValueOnce({ status: "unknown" });
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Recheck state, then sign/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(/may have occurred.*Do not submit again/i);
    expect(screen.queryByRole("link", { name: /transaction evidence/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Recheck state, then sign/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review contribution/ })).toBeDisabled();
  });
  it("reviews the exact nonpayable nomination and irreversible settlement consequences", async () => {
    const port = access(), recipient = toBech32("juno", new Uint8Array(20).fill(4));
    vi.mocked(port.prepare).mockImplementationOnce(async (intent) => ({ ...review, executeMessage: intent.executeMessage,
      funds: intent.funds, consequences: intent.consequences }));
    const settlement: BountyDetail = { bounty, config: ledger.config, pause: ledger.pause, activeRound: null, rounds: [], receipts: [],
      moderation: null, graduation: null, contributions: [{ bounty_id: 1, contributor: bounty.creator, contributor_index: 1,
        current_amount: "2500000", weight_at_round: null }], claims: [], history: [], observationHeight: 1,
      chainTimeNanos: ledger.chainTimeNanos, fingerprint: ledger.fingerprint };
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty}
      contributions={settlement.contributions} settlement={settlement} />);
    await userEvent.type(screen.getByLabelText("Recipient Juno address"), recipient);
    await userEvent.type(screen.getByLabelText("Evidence URI (HTTPS/IPFS)"), "ipfs://evidence");
    await userEvent.type(screen.getByLabelText("Evidence digest (sha256: + 64 lowercase hex)"), `sha256:${"ab".repeat(32)}`);
    await userEvent.type(screen.getByLabelText("Nomination rationale"), "Acceptance criteria shipped");
    await userEvent.click(screen.getByRole("button", { name: "Review payout nomination" }));
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { nominate_payout: {
      bounty_id: 1, recipient, evidence_uri: "ipfs://evidence", evidence_digest: `sha256:${"ab".repeat(32)}`,
      rationale: "Acceptance criteria shipped" } }, funds: [] }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Attached fundsNone");
    expect(dialog).toHaveTextContent(/entire \$JUNO 2.5 escrow/);
  });
  it("shows canonical weighted deadlines, revisions, and only permits finalization at close equality", () => {
    const round: PayoutRound = { bounty_id: 1, number: 1, nomination: { nominator: bounty.creator, recipient: bounty.creator,
      evidence_uri: "ipfs://evidence", evidence_digest: `sha256:${"ab".repeat(32)}`, rationale: "done" },
      rule: "contribution_weighted_majority", total_weight: "2500000", contributor_count: 1, opens_at: "1",
      closes_at: "1750000000000000000", yes_weight: "0", no_weight: "0", voter_count: 0, outcome: "pending", finalized_at: null };
    const state: BountyDetail = { bounty: { ...bounty, status: "ratifying", active_round: 1 }, config: ledger.config,
      pause: ledger.pause, activeRound: round, rounds: [round], receipts: [], moderation: null, graduation: null,
      contributions: [], claims: [], history: [], observationHeight: 1, chainTimeNanos: "1749999999999999999", fingerprint: "vote" };
    const view = render(<BountyActions bountyContract={config.contract} canonical={{ ...canonical, chainTimeNanos: state.chainTimeNanos }} stale={false}
      bounty={state.bounty} settlement={state} />);
    expect(screen.getByText(/Ballots close at exactly 1750000000000000000 ns/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "YES" })).toBeInTheDocument();
    view.rerender(<BountyActions bountyContract={config.contract} canonical={{ ...canonical, chainTimeNanos: round.closes_at! }} stale={false}
      bounty={state.bounty} settlement={{ ...state, chainTimeNanos: round.closes_at! }} />);
    expect(screen.queryByRole("radio", { name: "YES" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review public finalization" })).toBeInTheDocument();
  });
  it("preserves a raw chain failure and adds defensive retry guidance", async () => {
    const port = access(); vi.mocked(port.submit).mockResolvedValueOnce({ status: "failed", reason: "Error parsing into type: WrongRound" });
    render(<BountyActions bountyContract={config.contract} canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution ($JUNO)"), "1");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Recheck state, then sign/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Raw chain error: Error parsing into type: WrongRound");
    expect(screen.getByRole("status")).toHaveTextContent(/Review the canonical bounty and account state/);
  });
});
