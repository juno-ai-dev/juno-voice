import { describe, expect, it } from "vitest";
import { bountyContentDocumentFrom, EMPTY_BOUNTY_CONTENT_FIELDS, EMPTY_PROJECT_FIELDS, evidenceDocumentFrom, projectDocumentFrom } from "./metadataForms";

describe("metadata form document builders", () => {
  it("builds a project document, splitting tags and dropping empty optionals", () => {
    const doc = projectDocumentFrom({ ...EMPTY_PROJECT_FIELDS, name: "Alpha", summary: "A project.", tags: "tooling, governance defi" });
    expect(doc).toEqual({ doc: "juno-voice/project", version: 1, name: "Alpha", summary: "A project.", tags: ["tooling", "governance", "defi"] });
    const withLogo = projectDocumentFrom({ ...EMPTY_PROJECT_FIELDS, name: "Alpha", summary: "A project.", website: "https://alpha.example" }, "ipfs://bafylogo");
    expect(withLogo.logo).toBe("ipfs://bafylogo");
    expect(withLogo.website).toBe("https://alpha.example");
  });
  it("surfaces validation errors as plain sentences", () => {
    expect(() => projectDocumentFrom({ ...EMPTY_PROJECT_FIELDS, summary: "s" })).toThrow("Project name is required.");
    expect(() => projectDocumentFrom({ ...EMPTY_PROJECT_FIELDS, name: "Alpha", summary: "A project.", website: "http://x.example" })).toThrow("HTTPS");
  });
  it("builds a bounty content document with per-line deliverables", () => {
    const doc = bountyContentDocumentFrom({ brief: "Build it.", deliverables: "A repo\n\n  A test suite  ", acceptanceDetails: "" });
    expect(doc).toEqual({ doc: "juno-voice/bounty-content", version: 1, brief: "Build it.", deliverables: ["A repo", "A test suite"] });
    expect(() => bountyContentDocumentFrom(EMPTY_BOUNTY_CONTENT_FIELDS)).toThrow("Bounty brief is required.");
  });
  it("builds an evidence document from item rows, skipping blank rows", () => {
    const doc = evidenceDocumentFrom("Shipped the tooling.", [
      { kind: "pull_request", url: "https://github.example/pr/1", note: "merged" },
      { kind: "other", url: "", note: "" },
    ]);
    expect(doc.items).toEqual([{ kind: "pull_request", url: "https://github.example/pr/1", note: "merged" }]);
    expect(() => evidenceDocumentFrom("Shipped.", [{ kind: "other", url: "", note: "" }])).toThrow("1 to 20");
  });
});
