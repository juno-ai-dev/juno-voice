import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MetadataLink, MetadataPanel, VerifiedName } from "./MetadataView";
import { validateEvidenceDocument, validateProjectDocument } from "./metadataDocuments";
import type { MetadataClient, VerifiedMetadata } from "./metadataFetch";

const gateway = "https://ipfs-gateway.test/ipfs";
const uri = "ipfs://bafyalpha";
const digest = `sha256:${"a".repeat(64)}`;
const project = validateProjectDocument({ doc: "juno-voice/project", version: 1, name: "Alpha Project", summary: "A test project.", website: "https://alpha.example" });
const fakeClient = (result: VerifiedMetadata): MetadataClient => ({ load: vi.fn(async () => result) });

describe("MetadataView", () => {
  it("renders the verified project name and falls back to the URI otherwise", async () => {
    render(<h3><VerifiedName client={fakeClient({ state: "verified", doc: project })} uri={uri} digest={digest} /></h3>);
    expect(await screen.findByRole("heading", { name: "Alpha Project" })).toBeInTheDocument();
  });
  it("marks a fingerprint mismatch instead of rendering fetched content", async () => {
    render(<VerifiedName client={fakeClient({ state: "mismatch" })} uri={uri} digest={digest} />);
    const flagged = await screen.findByTitle(/does not match its on-chain fingerprint/);
    expect(flagged).toHaveTextContent(uri);
  });
  it("renders the raw URI when no metadata client is available", () => {
    render(<VerifiedName uri={uri} digest={digest} />);
    expect(screen.getByText(uri)).toBeInTheDocument();
  });
  it("shows verified documents with an explicit fingerprint confirmation", async () => {
    render(<MetadataPanel client={fakeClient({ state: "verified", doc: project })} gateway={gateway} uri={uri} digest={digest} expected="juno-voice/project" />);
    expect(await screen.findByText("Matches on-chain fingerprint")).toBeInTheDocument();
    expect(screen.getByText("A test project.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Website" })).toHaveAttribute("href", "https://alpha.example");
    expect(screen.getByRole("link", { name: "Open metadata" })).toHaveAttribute("href", `${gateway}/bafyalpha`);
  });
  it("withholds mismatching content in the panel", async () => {
    render(<MetadataPanel client={fakeClient({ state: "mismatch" })} gateway={gateway} uri={uri} digest={digest} expected="juno-voice/project" />);
    expect(await screen.findByText(/Content withheld/)).toBeInTheDocument();
  });
  it("labels evidence items by kind", async () => {
    const evidence = validateEvidenceDocument({ doc: "juno-voice/evidence", version: 1, summary: "Shipped.",
      items: [{ kind: "pull_request", url: "https://github.example/pr/1", note: "merged" }] });
    render(<MetadataPanel client={fakeClient({ state: "verified", doc: evidence })} gateway={gateway} uri={uri} digest={digest} expected="juno-voice/evidence" />);
    expect(await screen.findByRole("link", { name: "Pull request" })).toHaveAttribute("href", "https://github.example/pr/1");
    expect(screen.getByText(/merged/)).toBeInTheDocument();
  });
  it("withholds links for unsafe schemes and passes https through", () => {
    render(<div><MetadataLink uri="javascript:alert(1)" gateway={gateway} /><MetadataLink uri="https://example.com/x" gateway={gateway} label="External" /></div>);
    expect(screen.getByText("Unsafe URI withheld")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "External" })).toHaveAttribute("rel", "noopener noreferrer");
  });
});
