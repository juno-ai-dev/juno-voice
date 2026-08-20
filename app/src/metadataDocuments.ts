// Metadata document schemas for the URI+digest pairs committed on chain.
// The normative spec lives at /docs/METADATA_DOCUMENTS.md; validators here are
// its executable form. Writers must serialize through canonicalDocumentBytes so
// the on-chain digest deterministically binds the published bytes. Readers hash
// the exact fetched bytes first and only then parse — never re-serialize.

export const PROJECT_DOC = "juno-voice/project";
export const BOUNTY_CONTENT_DOC = "juno-voice/bounty-content";
export const EVIDENCE_DOC = "juno-voice/evidence";
export type MetadataDocKind = typeof PROJECT_DOC | typeof BOUNTY_CONTENT_DOC | typeof EVIDENCE_DOC;

export const EVIDENCE_ITEM_KINDS = ["pull_request", "commit", "release", "deployment", "document", "test_report", "other"] as const;
export type EvidenceItemKind = (typeof EVIDENCE_ITEM_KINDS)[number];

export interface MetadataDocLink { label: string; url: string }
export interface ProjectDocument {
  doc: typeof PROJECT_DOC; version: 1; name: string; summary: string;
  slug?: string; description?: string; website?: string; repository?: string;
  logo?: string; tags?: string[]; links?: MetadataDocLink[];
}
export interface BountyContentDocument {
  doc: typeof BOUNTY_CONTENT_DOC; version: 1; brief: string;
  deliverables?: string[]; acceptance_details?: string; links?: MetadataDocLink[];
}
export interface EvidenceItem { kind: EvidenceItemKind; url: string; note?: string }
export interface EvidenceDocument { doc: typeof EVIDENCE_DOC; version: 1; summary: string; items: EvidenceItem[] }
export type MetadataDocument = ProjectDocument | BountyContentDocument | EvidenceDocument;

export const MAX_DOCUMENT_BYTES = 16_384;
export const MAX_URL_BYTES = 512;

export class MetadataDocumentError extends Error {
  readonly code: "invalid" | "unsupported_version";
  constructor(message: string, code: "invalid" | "unsupported_version" = "invalid") { super(message); this.code = code; }
}

const utf8 = (value: string) => new TextEncoder().encode(value).length;
const fail = (message: string): never => { throw new MetadataDocumentError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Multiline text may contain tabs and newlines; single-line text may not.
const hasForbiddenControls = (value: string, multiline: boolean): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f) return true;
    if (code < 0x20 && !(multiline && (code === 0x0a || code === 0x09))) return true;
  }
  return false;
};

const text = (value: unknown, label: string, max: number, options?: { multiline?: boolean }): string => {
  if (typeof value !== "string") fail(`${label} must be text.`);
  const raw = (value as string).replace(/\r\n/g, "\n");
  if (hasForbiddenControls(raw, options?.multiline ?? false)) fail(`${label} must not contain control characters.`);
  const trimmed = raw.trim();
  if (!trimmed) fail(`${label} is required.`);
  if (trimmed.length > max) fail(`${label} must be at most ${max} characters.`);
  return trimmed;
};

const url = (value: unknown, label: string, schemes: readonly string[]): string => {
  const trimmed = text(value, label, MAX_URL_BYTES);
  if (utf8(trimmed) > MAX_URL_BYTES) fail(`${label} must be at most ${MAX_URL_BYTES} UTF-8 bytes.`);
  const scheme = schemes.find((candidate) => trimmed.startsWith(candidate));
  if (!scheme || trimmed.length <= scheme.length || /\s/.test(trimmed))
    fail(`${label} must be a bounded ${schemes.map((s) => s.replace("://", "").toUpperCase()).join(" or ")} URI.`);
  return trimmed;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains an unknown field: ${key}.`);
};

const links = (value: unknown, label: string): MetadataDocLink[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail(`${label} must be a list of 1 to 8 links.`);
  return (value as unknown[]).map((item, index) => {
    if (!isRecord(item)) fail(`${label} entry ${index + 1} must be an object with label and url.`);
    const record = item as Record<string, unknown>;
    exactKeys(record, ["label", "url"], `${label} entry ${index + 1}`);
    return { label: text(record.label, `${label} entry ${index + 1} label`, 40), url: url(record.url, `${label} entry ${index + 1} url`, ["https://", "ipfs://"]) };
  });
};

const envelope = (value: unknown, doc: MetadataDocKind, label: string): Record<string, unknown> => {
  if (!isRecord(value)) fail(`${label} must be a JSON object.`);
  const record = value as Record<string, unknown>;
  if (record.doc !== doc) fail(`${label} must declare doc as exactly "${doc}".`);
  if (record.version !== 1) {
    if (typeof record.version === "number" && Number.isSafeInteger(record.version) && record.version > 1)
      throw new MetadataDocumentError("This document uses a newer version than this app understands.", "unsupported_version");
    fail(`${label} must declare version as the integer 1.`);
  }
  return record;
};

export function validateProjectDocument(value: unknown): ProjectDocument {
  const record = envelope(value, PROJECT_DOC, "The project document");
  exactKeys(record, ["doc", "version", "name", "summary", "slug", "description", "website", "repository", "logo", "tags", "links"], "The project document");
  const doc: ProjectDocument = { doc: PROJECT_DOC, version: 1,
    name: text(record.name, "Project name", 120), summary: text(record.summary, "Project summary", 280) };
  if (record.slug !== undefined) {
    const slug = text(record.slug, "Project slug", 40);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) fail("Project slug must use lowercase letters and digits separated by single hyphens.");
    doc.slug = slug;
  }
  if (record.description !== undefined) doc.description = text(record.description, "Project description", 4000, { multiline: true });
  if (record.website !== undefined) doc.website = url(record.website, "Project website", ["https://"]);
  if (record.repository !== undefined) doc.repository = url(record.repository, "Project repository", ["https://"]);
  if (record.logo !== undefined) doc.logo = url(record.logo, "Project logo", ["ipfs://"]);
  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags) || record.tags.length < 1 || record.tags.length > 8) fail("Project tags must be a list of 1 to 8 tags.");
    const tags = (record.tags as unknown[]).map((tag, index) => {
      const item = text(tag, `Project tag ${index + 1}`, 24);
      if (!/^[a-z0-9-]{1,24}$/.test(item)) fail("Project tags must use lowercase letters, digits, and hyphens.");
      return item;
    });
    if (new Set(tags).size !== tags.length) fail("Project tags must be unique.");
    doc.tags = tags;
  }
  if (record.links !== undefined) doc.links = links(record.links, "Project links");
  return doc;
}

export function validateBountyContentDocument(value: unknown): BountyContentDocument {
  const record = envelope(value, BOUNTY_CONTENT_DOC, "The bounty content document");
  exactKeys(record, ["doc", "version", "brief", "deliverables", "acceptance_details", "links"], "The bounty content document");
  const doc: BountyContentDocument = { doc: BOUNTY_CONTENT_DOC, version: 1,
    brief: text(record.brief, "Bounty brief", 8000, { multiline: true }) };
  if (record.deliverables !== undefined) {
    if (!Array.isArray(record.deliverables) || record.deliverables.length < 1 || record.deliverables.length > 20)
      fail("Deliverables must be a list of 1 to 20 entries.");
    doc.deliverables = (record.deliverables as unknown[]).map((item, index) => text(item, `Deliverable ${index + 1}`, 280));
  }
  if (record.acceptance_details !== undefined) doc.acceptance_details = text(record.acceptance_details, "Acceptance details", 4000, { multiline: true });
  if (record.links !== undefined) doc.links = links(record.links, "Bounty links");
  return doc;
}

export function validateEvidenceDocument(value: unknown): EvidenceDocument {
  const record = envelope(value, EVIDENCE_DOC, "The evidence document");
  exactKeys(record, ["doc", "version", "summary", "items"], "The evidence document");
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > 20)
    fail("Evidence items must be a list of 1 to 20 entries.");
  return { doc: EVIDENCE_DOC, version: 1,
    summary: text(record.summary, "Evidence summary", 2000, { multiline: true }),
    items: (record.items as unknown[]).map((item, index) => {
      if (!isRecord(item)) fail(`Evidence item ${index + 1} must be an object with kind and url.`);
      const entry = item as Record<string, unknown>;
      exactKeys(entry, ["kind", "url", "note"], `Evidence item ${index + 1}`);
      if (!EVIDENCE_ITEM_KINDS.includes(entry.kind as EvidenceItemKind))
        fail(`Evidence item ${index + 1} kind must be one of: ${EVIDENCE_ITEM_KINDS.join(", ")}.`);
      const result: EvidenceItem = { kind: entry.kind as EvidenceItemKind, url: url(entry.url, `Evidence item ${index + 1} url`, ["https://", "ipfs://"]) };
      if (entry.note !== undefined) result.note = text(entry.note, `Evidence item ${index + 1} note`, 280);
      return result;
    }) };
}

// Canonical writer serialization: compact UTF-8 JSON, keys sorted at every
// depth, NFC-normalized strings, safe integers only, no trailing newline.
const canonicalJson = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("Metadata documents may only contain safe integers.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return fail("Metadata documents may only contain objects, arrays, text, and safe integers.");
};

export function canonicalDocumentBytes(document: MetadataDocument): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalJson(document));
  if (bytes.length > MAX_DOCUMENT_BYTES)
    fail(`The metadata document is ${bytes.length} bytes; the limit is ${MAX_DOCUMENT_BYTES} bytes.`);
  return bytes;
}

export function parseMetadataDocument(bytes: Uint8Array, expected: MetadataDocKind): MetadataDocument {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("The metadata document is not valid UTF-8 JSON."); }
  if (expected === PROJECT_DOC) return validateProjectDocument(value);
  if (expected === BOUNTY_CONTENT_DOC) return validateBountyContentDocument(value);
  return validateEvidenceDocument(value);
}
