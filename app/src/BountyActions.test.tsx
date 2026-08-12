import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BountyActions, type BountyTransactionAccess } from "./BountyActions";
import { ledger, bounty } from "./test/bountyFixtures";
import type { TransactionReview } from "./transactions";
const canonical = { config: ledger.config, pause: ledger.pause, chainTimeNanos: ledger.chainTimeNanos, fingerprint: ledger.fingerprint };
const review: TransactionReview = { reviewId: "r", flowBinding: "f", sender: bounty.creator, chainId: "juno-1",
  contract: "juno1jmngxh7kdelch3v5xu02ze2gup887v55csqns4qmxeskgy2ldl5qj494qw",
  executeMessage: { contribute: { bounty_id: 1 } }, funds: [{ denom: "ujuno", amount: "1000000" }],
  fee: { gas: "180000", amount: [{ denom: "ujuno", amount: "4500" }] }, consequences: ["Exact consequence"],
  canonicalState: { fingerprint: ledger.fingerprint, height: 123 }, walletRevision: 1 };
const access = (): BountyTransactionAccess => ({ connect: vi.fn(async () => ({ address: bounty.creator })),
  prepare: vi.fn(async () => review), submit: vi.fn(async () => ({ status: "confirmed" as const, txHash: "ABC", height: 124,
    confirmationStatus: "confirmed" as const, refreshStatus: "refreshed" as const, explorerUrl: "https://example/tx/ABC" })) });
describe("bounty action UI", () => {
  it("keeps read-only access and explains unavailable wallet support", async () => {
    render(<BountyActions canonical={canonical} stale={false} />);
    expect(screen.getByText(/Browsing does not require a wallet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Prepare bounty review/ })).toBeInTheDocument();
  });
  it("constructs exact create message/funds from accessible controls and discloses review", async () => {
    const port = access(); render(<BountyActions canonical={canonical} stale={false} access={port} />);
    await userEvent.type(screen.getByLabelText("Title"), "Ship tooling");
    await userEvent.type(screen.getByLabelText("Summary"), "Useful tooling");
    await userEvent.type(screen.getByLabelText("Acceptance criteria"), "Tests pass");
    await userEvent.click(screen.getByRole("button", { name: /Prepare bounty review/ }));
    const expiry = (screen.getByLabelText("Expiration (exact Unix nanoseconds)") as HTMLInputElement).value;
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ funds: [{ denom: "ujuno", amount: "1000000" }],
      executeMessage: { create_bounty: expect.objectContaining({ title: "Ship tooling", expires_at: expiry }) },
      expectedStateFingerprint: ledger.fingerprint }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Exact transaction review");
    expect(screen.getByText("1000000 ujuno")).toBeInTheDocument();
  });
  it("makes optional project-candidate semantics explicit and reviews the exact metadata", async () => {
    const port = access(); render(<BountyActions canonical={canonical} stale={false} access={port} />);
    await userEvent.type(screen.getByLabelText("Title"), "Ship tooling");
    await userEvent.type(screen.getByLabelText("Summary"), "Useful tooling");
    await userEvent.type(screen.getByLabelText("Acceptance criteria"), "Tests pass");
    await userEvent.type(screen.getByLabelText("Project ID"), "tooling-1");
    await userEvent.type(screen.getByLabelText("Metadata URI (HTTPS/IPFS)"), "ipfs://bafyproject");
    await userEvent.type(screen.getByLabelText("Metadata digest (sha256: + 64 lowercase hex)"), `sha256:${"ab".repeat(32)}`);
    await userEvent.click(screen.getByRole("button", { name: /Prepare bounty review/ }));
    expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ executeMessage: { create_bounty: expect.objectContaining({
      project_candidate: { project_id: "tooling-1", metadata_uri: "ipfs://bafyproject", metadata_digest: `sha256:${"ab".repeat(32)}` },
    }) } }));
    expect(screen.getByText(/does not register or graduate/)).toBeInTheDocument();
  });
  it("blocks stale preparation before wallet access", async () => {
    const port = access(); render(<BountyActions canonical={canonical} stale access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution (exact ujuno)"), "1000000");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(/stale/);
    expect(port.connect).not.toHaveBeenCalled(); expect(port.prepare).not.toHaveBeenCalled();
  });
  it("submits only the reviewed object through the shared lifecycle", async () => {
    const port = access(); render(<BountyActions canonical={canonical} stale={false} access={port} bounty={bounty} />);
    await userEvent.type(screen.getByLabelText("Contribution (exact ujuno)"), "1000000");
    await userEvent.click(screen.getByRole("button", { name: /review contribution/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Recheck state, then sign/ }));
    expect(port.submit).toHaveBeenCalledWith(review);
    expect(await screen.findByRole("status")).toHaveTextContent(/Confirmed at height 124/);
  });
});
