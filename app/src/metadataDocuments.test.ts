import { describe, expect, it } from "vitest";
import { BOUNTY_CONTENT_DOC, canonicalDocumentBytes, EVIDENCE_DOC, MetadataDocumentError, parseMetadataDocument, PROJECT_DOC,
  validateBountyContentDocument, validateEvidenceDocument, validateProjectDocument } from "./metadataDocuments";

const project = { doc: PROJECT_DOC, version: 1, name: "Juno Voice", summary: "Community bounties on Juno." };

describe("metadata document validation", () => {
  it("accepts a project document and preserves validated optional fields", () => {
    const doc = validateProjectDocument({ ...project, slug: "juno-voice", tags: ["tooling", "governance"],
      website: "https://example.com", logo: "ipfs://bafybeigdyrztexample", links: [{ label: "Docs", url: "https://example.com/docs" }] });
    expect(doc).toEqual({ ...project, slug: "juno-voice", tags: ["tooling", "governance"],
      website: "https://example.com", logo: "ipfs://bafybeigdyrztexample", links: [{ label: "Docs", url: "https://example.com/docs" }] });
  });
  it("rejects unknown fields, bad slugs, duplicate tags, and unsafe urls", () => {
    expect(() => validateProjectDocument({ ...project, extra: 1 })).toThrow("unknown field: extra");
    expect(() => validateProjectDocument({ ...project, slug: "Bad Slug" })).toThrow("hyphens");
    expect(() => validateProjectDocument({ ...project, tags: ["a", "a"] })).toThrow("unique");
    expect(() => validateProjectDocument({ ...project, website: "http://example.com" })).toThrow("HTTPS");
    expect(() => validateProjectDocument({ ...project, logo: "https://example.com/x.png" })).toThrow("IPFS");
    expect(() => validateProjectDocument({ ...project, links: [{ label: "x", url: "javascript:alert(1)" }] })).toThrow("HTTPS or IPFS");
    expect(() => validateProjectDocument({ ...project, links: [{ label: "x", url: "ipfs://" }] })).toThrow("HTTPS or IPFS");
  });
  it("rejects control characters and over-length text but keeps multiline fields multiline", () => {
    expect(() => validateProjectDocument({ ...project, name: "bad\u0007name" })).toThrow("control characters");
    expect(() => validateProjectDocument({ ...project, name: "two\nlines" })).toThrow("control characters");
    expect(() => validateProjectDocument({ ...project, summary: "x".repeat(281) })).toThrow("at most 280");
    expect(validateProjectDocument({ ...project, description: "line one\r\nline two" }).description).toBe("line one\nline two");
  });
  it("distinguishes unsupported newer versions from invalid documents", () => {
    let newerCode: string | null = null;
    try { validateProjectDocument({ ...project, version: 2 }); }
    catch (error) { newerCode = (error as MetadataDocumentError).code; }
    expect(newerCode).toBe("unsupported_version");
    let unknownCode: string | null = null;
    try { validateProjectDocument({ ...project, doc: "juno-voice/unknown" }); }
    catch (error) { unknownCode = (error as MetadataDocumentError).code; }
    expect(unknownCode).toBe("invalid");
  });
  it("validates bounty content and evidence documents", () => {
    const content = validateBountyContentDocument({ doc: BOUNTY_CONTENT_DOC, version: 1, brief: "Build the thing.\nCarefully.",
      deliverables: ["A repository"], acceptance_details: "Tests pass." });
    expect(content.deliverables).toEqual(["A repository"]);
    expect(() => validateEvidenceDocument({ doc: EVIDENCE_DOC, version: 1, summary: "Done", items: [] })).toThrow("1 to 20");
    expect(() => validateEvidenceDocument({ doc: EVIDENCE_DOC, version: 1, summary: "Done",
      items: [{ kind: "meme", url: "https://x.example/1" }] })).toThrow("kind must be one of");
    const evidence = validateEvidenceDocument({ doc: EVIDENCE_DOC, version: 1, summary: "Done",
      items: [{ kind: "pull_request", url: "https://github.example/pr/1", note: "merged" }] });
    expect(evidence.items).toEqual([{ kind: "pull_request", url: "https://github.example/pr/1", note: "merged" }]);
  });
});

describe("canonical document bytes", () => {
  it("serializes compactly with sorted keys and NFC strings, independent of construction order", () => {
    const a = validateProjectDocument({ summary: "s", name: "café", version: 1, doc: PROJECT_DOC });
    const b = validateProjectDocument({ doc: PROJECT_DOC, version: 1, name: "cafe\u0301", summary: "s" });
    const bytesA = canonicalDocumentBytes(a);
    expect(new TextDecoder().decode(bytesA)).toBe('{"doc":"juno-voice/project","name":"café","summary":"s","version":1}');
    expect(bytesA).toEqual(canonicalDocumentBytes(b));
  });
  it("enforces the 16 KiB canonical document cap", () => {
    const doc = validateBountyContentDocument({ doc: BOUNTY_CONTENT_DOC, version: 1, brief: "x".repeat(8000),
      acceptance_details: "y".repeat(4000), deliverables: Array.from({ length: 20 }, () => "z".repeat(280)) });
    expect(() => canonicalDocumentBytes(doc)).toThrow("16384");
  });
  it("round-trips through parseMetadataDocument and rejects malformed bytes", () => {
    const doc = validateProjectDocument({ ...project, slug: "juno-voice" });
    expect(parseMetadataDocument(canonicalDocumentBytes(doc), PROJECT_DOC)).toEqual(doc);
    expect(() => parseMetadataDocument(new Uint8Array([0xff, 0xfe]), PROJECT_DOC)).toThrow("not valid UTF-8 JSON");
    expect(() => parseMetadataDocument(new TextEncoder().encode("[]"), PROJECT_DOC)).toThrow("JSON object");
    expect(() => parseMetadataDocument(canonicalDocumentBytes(doc), EVIDENCE_DOC)).toThrow('"juno-voice/evidence"');
  });
});
