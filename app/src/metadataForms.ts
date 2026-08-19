import { BOUNTY_CONTENT_DOC, EVIDENCE_DOC, PROJECT_DOC, validateBountyContentDocument, validateEvidenceDocument,
  validateProjectDocument, type BountyContentDocument, type EvidenceDocument, type EvidenceItemKind, type ProjectDocument } from "./metadataDocuments";

// Bridges between form state and validated metadata documents. Validators
// throw plain-sentence errors that forms surface directly.

export const EVIDENCE_KIND_LABELS: Record<EvidenceItemKind, string> = {
  pull_request: "Pull request", commit: "Commit", release: "Release", deployment: "Deployment",
  document: "Document", test_report: "Test report", other: "Other evidence",
};

export interface ProjectFieldsValue {
  name: string; summary: string; description: string; website: string; repository: string; tags: string; logo: File | null;
}
export const EMPTY_PROJECT_FIELDS: ProjectFieldsValue = { name: "", summary: "", description: "", website: "", repository: "", tags: "", logo: null };

export const projectFieldsFilled = (value: ProjectFieldsValue) =>
  Boolean(value.name.trim() || value.summary.trim() || value.description.trim() || value.website.trim() || value.repository.trim() || value.tags.trim() || value.logo);

export function projectDocumentFrom(value: ProjectFieldsValue, logoUri?: string): ProjectDocument {
  const tags = value.tags.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean);
  return validateProjectDocument({
    doc: PROJECT_DOC, version: 1, name: value.name, summary: value.summary,
    ...(value.description.trim() ? { description: value.description } : {}),
    ...(value.website.trim() ? { website: value.website.trim() } : {}),
    ...(value.repository.trim() ? { repository: value.repository.trim() } : {}),
    ...(tags.length ? { tags } : {}),
    ...(logoUri ? { logo: logoUri } : {}),
  });
}

export interface BountyContentFieldsValue { brief: string; deliverables: string; acceptanceDetails: string }
export const EMPTY_BOUNTY_CONTENT_FIELDS: BountyContentFieldsValue = { brief: "", deliverables: "", acceptanceDetails: "" };
export const bountyContentFieldsFilled = (value: BountyContentFieldsValue) =>
  Boolean(value.brief.trim() || value.deliverables.trim() || value.acceptanceDetails.trim());

export function bountyContentDocumentFrom(value: BountyContentFieldsValue): BountyContentDocument {
  const deliverables = value.deliverables.split("\n").map((line) => line.trim()).filter(Boolean);
  return validateBountyContentDocument({
    doc: BOUNTY_CONTENT_DOC, version: 1, brief: value.brief,
    ...(deliverables.length ? { deliverables } : {}),
    ...(value.acceptanceDetails.trim() ? { acceptance_details: value.acceptanceDetails } : {}),
  });
}

export interface EvidenceItemValue { kind: EvidenceItemKind; url: string; note: string }
export function evidenceDocumentFrom(summary: string, items: readonly EvidenceItemValue[]): EvidenceDocument {
  return validateEvidenceDocument({
    doc: EVIDENCE_DOC, version: 1, summary,
    items: items.filter((item) => item.url.trim() || item.note.trim())
      .map((item) => ({ kind: item.kind, url: item.url, ...(item.note.trim() ? { note: item.note } : {}) })),
  });
}
