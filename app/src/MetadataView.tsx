import type { ReactNode } from "react";
import { compact } from "./format";
import type { BountyContentDocument, EvidenceDocument, MetadataDocKind, MetadataDocLink, MetadataDocument, ProjectDocument } from "./metadataDocuments";
import { ipfsGatewayUrl, type MetadataClient } from "./metadataFetch";
import { useVerifiedMetadata } from "./useVerifiedMetadata";
import "./metadata-view.css";

const EVIDENCE_KIND_LABELS: Record<EvidenceDocument["items"][number]["kind"], string> = {
  pull_request: "Pull request", commit: "Commit", release: "Release", deployment: "Deployment",
  document: "Document", test_report: "Test report", other: "Other evidence",
};

const MISMATCH_COPY = "The linked content does not match its on-chain fingerprint. Content withheld.";

// The one place a metadata reference becomes a clickable link: ipfs:// through
// the configured gateway, https:// directly, anything else withheld.
export function MetadataLink({ uri, gateway, label = "Open metadata" }: { uri: string; gateway: string; label?: string }) {
  if (uri.startsWith("ipfs://")) {
    const href = ipfsGatewayUrl(gateway, uri);
    if (!href) return <code title={uri}>Unsafe URI withheld</code>;
    return <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
  }
  if (/^https:\/\/[^\s]+$/.test(uri)) return <a href={uri} target="_blank" rel="noopener noreferrer">{label}</a>;
  return <code title={uri}>Unsafe URI withheld</code>;
}

export function VerifiedName({ client, uri, digest, fallback }: {
  client?: MetadataClient; uri: string; digest: string; fallback?: ReactNode;
}) {
  const result = useVerifiedMetadata(client, uri, digest, "juno-voice/project");
  if (result.state === "verified") return <>{(result.doc as ProjectDocument).name}</>;
  const shownFallback = fallback ?? compact(uri);
  if (result.state === "mismatch") return <span className="metadata-mismatch" title={MISMATCH_COPY}>{shownFallback}</span>;
  return <>{shownFallback}</>;
}

function LinkList({ links, gateway }: { links: readonly MetadataDocLink[]; gateway: string }) {
  return <ul>{links.map((link) => <li key={`${link.label}:${link.url}`}><MetadataLink uri={link.url} gateway={gateway} label={link.label} /></li>)}</ul>;
}

function VerifiedDocument({ doc, gateway }: { doc: MetadataDocument; gateway: string }) {
  if (doc.doc === "juno-voice/project") {
    const project = doc as ProjectDocument;
    return <div className="metadata-doc">
      <p><strong>{project.name}</strong> {project.slug && <code>{project.slug}</code>}</p>
      <p>{project.summary}</p>
      {project.description && <p className="metadata-doc-text">{project.description}</p>}
      {project.tags && <ul className="metadata-tags">{project.tags.map((tag) => <li className="badge" key={tag}>{tag}</li>)}</ul>}
      <ul>
        {project.website && <li><a href={project.website} target="_blank" rel="noopener noreferrer">Website</a></li>}
        {project.repository && <li><a href={project.repository} target="_blank" rel="noopener noreferrer">Repository</a></li>}
        {project.logo && <li><MetadataLink uri={project.logo} gateway={gateway} label="Logo image" /></li>}
      </ul>
      {project.links && <LinkList links={project.links} gateway={gateway} />}
    </div>;
  }
  if (doc.doc === "juno-voice/bounty-content") {
    const content = doc as BountyContentDocument;
    return <div className="metadata-doc">
      <p className="metadata-doc-text">{content.brief}</p>
      {content.deliverables && <><strong>Deliverables</strong><ul>{content.deliverables.map((item) => <li key={item}>{item}</li>)}</ul></>}
      {content.acceptance_details && <p className="metadata-doc-text">{content.acceptance_details}</p>}
      {content.links && <LinkList links={content.links} gateway={gateway} />}
    </div>;
  }
  const evidence = doc as EvidenceDocument;
  return <div className="metadata-doc">
    <p className="metadata-doc-text">{evidence.summary}</p>
    <ul>
      {evidence.items.map((item, index) => <li key={`${index}:${item.url}`}>
        <MetadataLink uri={item.url} gateway={gateway} label={EVIDENCE_KIND_LABELS[item.kind]} />
        {item.note && <> · {item.note}</>}
      </li>)}
    </ul>
  </div>;
}

export function MetadataPanel({ client, gateway, uri, digest, expected }: {
  client?: MetadataClient; gateway: string; uri: string; digest: string; expected: MetadataDocKind;
}) {
  const result = useVerifiedMetadata(client, uri, digest, expected);
  return <div className="metadata-panel">
    {result.state === "loading" && <p className="metadata-status" role="status">Checking the linked details…</p>}
    {result.state === "verified" && <>
      <p className="metadata-status" role="status">Matches on-chain fingerprint</p>
      <VerifiedDocument doc={result.doc} gateway={gateway} />
    </>}
    {result.state === "mismatch" && <p className="notice danger metadata-mismatch" role="status">{MISMATCH_COPY}</p>}
    {result.state === "invalid" && <p className="metadata-status" role="status">The linked file matches its fingerprint but is not a recognized Juno Voice document.</p>}
    {result.state === "unfetchable" && <p className="metadata-status" role="status">The linked details could not be fetched right now.</p>}
    <p className="metadata-source"><MetadataLink uri={uri} gateway={gateway} /> <code>{digest}</code></p>
  </div>;
}
