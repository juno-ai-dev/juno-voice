import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import type { AppConfig } from "./config";
import type { Project, ProjectDetail, RegistryDataSource } from "./registry";
import { buildRegistryIntent, type RegistryAction, type RegistryTransactionFlow } from "./registryActions";
import { clearRegistrySubmission, loadLatestRegistrySubmission, loadRegistrySubmission, registryActionFromReview, saveRegistrySubmission, type StoredRegistrySubmission } from "./registrySubmissionState";
import type { TransactionOutcome, TransactionReview } from "./transactions";
import { runtimeTransactionOutcome } from "./transactionOutcome";
import { useAsync } from "./useAsync";
import { formatJuno, userFacingTransactionAmounts } from "./junoAmount";
import { UriDigestFields } from "./UriDigestFields";
import { compact } from "./format";
import { Fact } from "./components/Fact";
import { State } from "./components/State";
import { MetadataPanel, VerifiedName } from "./MetadataView";
import type { MetadataClient } from "./metadataFetch";
import { Modal } from "./components/Modal";
import { PageHeader } from "./components/PageHeader";
import { PageMeta } from "./components/PageMeta";
import { SubmissionEvidenceBanner } from "./components/SubmissionEvidenceBanner";
import { NotFound } from "./routes/NotFound";
import { MODAL_CLOSE_REPLACE_STATE, useCloseModal } from "./routes/useCloseModal";
import { ProjectFields } from "./ProjectFields";
import { EMPTY_PROJECT_FIELDS, projectDocumentFrom } from "./metadataForms";
import type { DocumentPublisher } from "./metadataPublish";
import "./registry-gauge.css";

const juno = formatJuno;
const utc = (nanos: string) => new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
const statusLabel = (status: Project["status"]) => ({ pending: "Pending curator review", active: "Active", suspended: "Suspended by curator", rejected: "Rejected by curator", retired: "Retired" })[status];

const registryActionHelp: Record<RegistryAction, { title: string; detail: string }> = {
  register_project: { title: "Apply to the registry", detail: "Creates a pending application and deposits the exact registration bond shown in the live policy below. Approval and gauge funding are not guaranteed." },
  update_pending_metadata: { title: "Update an application", detail: "Replaces the metadata reference and digest for a pending application you own." },
  propose_payout_address: { title: "Start a payout-address change", detail: "Proposes a new payout address. The new address must accept after the live safety delay before it becomes canonical." },
  cancel_payout_address_change: { title: "Cancel a payout-address change", detail: "Removes a pending payout-address proposal before it is accepted." },
  accept_payout_address: { title: "Accept a payout-address change", detail: "The proposed address accepts control after the on-chain delay has elapsed." },
  retire: { title: "Retire a project", detail: "Voluntarily removes an eligible project from future gauge option snapshots. This cannot be presented as a reversible UI preference." },
  claim_registration_bond: { title: "Claim an eligible bond", detail: "Claims a registration bond only when canonical project state marks it claimable by the depositor." },
};

export interface RegistryOutletContext {
  source: RegistryDataSource;
  config: AppConfig;
  transactionFlow?: RegistryTransactionFlow;
  sender?: string;
  metadata?: MetadataClient;
  publisher?: DocumentPublisher;
}

export function Registry({ source, config, transactionFlow, sender, metadata, publisher }: { source: RegistryDataSource; config: AppConfig; transactionFlow?: RegistryTransactionFlow; sender?: string; metadata?: MetadataClient; publisher?: DocumentPublisher }) {
  const load = useMemo(() => () => source.loadRegistry(), [source]);
  const [state, retry] = useAsync(load, "registry");
  const contractScope = useMemo(() => ({ chainId: config.chainId, contract: config.registryContract }), [config.chainId, config.registryContract]);
  const persistedSubmissionPresent = (sender
    ? loadRegistrySubmission({ sender, ...contractScope })
    : loadLatestRegistrySubmission(contractScope)) !== null;
  const navigate = useNavigate();
  const location = useLocation();
  const modalOpen = location.pathname !== "/projects";
  // Persisted submission evidence must surface on arrival: open the manage
  // modal once per page mount, matching the old force-open behavior. The
  // one-shot ref lets the user close the modal and stay on the page.
  const lockRedirected = useRef(false);
  useEffect(() => {
    if (lockRedirected.current || !persistedSubmissionPresent) return;
    lockRedirected.current = true;
    if (location.pathname === "/projects") void navigate("manage", { replace: true, state: MODAL_CLOSE_REPLACE_STATE });
  }, [persistedSubmissionPresent, location.pathname, navigate]);
  // Child modal routes own the document title while they are open.
  const pageMeta = modalOpen ? null : <PageMeta route="projects" />;
  if (state.kind === "loading") return <main>{pageMeta}<State title="Loading project registry…" detail="Verifying the registry deployment and querying canonical Juno state." /></main>;
  if (state.kind === "error") return <main>{pageMeta}<State title="Project registry unavailable" detail={state.message}><button className="button" onClick={retry}>Retry registry query</button></State></main>;
  const data = state.data;
  const outletContext: RegistryOutletContext = { source, config, transactionFlow, sender, metadata, publisher };
  return <main>
    {pageMeta}
    <PageHeader
      eyebrow="HACK JUNO · PROJECT REGISTRY"
      title="Eligible projects"
      titleId="registry-title"
      lede="Explore the projects that can receive gauge allocations and applications awaiting public curation. Every status, owner, and payout destination comes from the verified registry."
      actions={<Link className="button" to="manage">Open project actions</Link>}
      stats={[
        { label: "Active", value: `${data.health.accounting.active_projects} / ${data.config.max_active_projects}` },
        { label: "Applications", value: String(data.health.accounting.pending_applications) },
        { label: "Accounting", value: data.health.fully_backed ? "Fully backed" : "Degraded" },
      ]}
      statsLabel="Registry summary"
    />
    {persistedSubmissionPresent && !modalOpen && <SubmissionEvidenceBanner to="manage" />}
    {(data.pause.admissions_stopped || data.pause.adapter_stopped) && <section className="notice" role="status"><strong>Registry stop is active.</strong> {data.pause.admissions_stopped && "New admissions are stopped. "}{data.pause.adapter_stopped && "Gauge distribution is stopped. "}{data.pause.reason}</section>}
    {!data.health.fully_backed && <section className="notice danger" role="alert"><strong>Bond accounting is not fully backed.</strong> Public write preparation is disabled.</section>}
    <details className="concept-disclosure"><summary>How project eligibility and retained allocations work</summary><div><p>Active projects become options only when a new gauge epoch takes its fixed snapshot. A current registry change never rewrites an epoch already in progress.</p><p><code>do-not-distribute</code> is a reserved gauge choice that retains its allocation in the Program Vault. It is not a project and never receives a payout.</p></div></details>
    <div className="registry-columns">
      <section aria-labelledby="active-projects"><div className="toolbar"><div><p className="eyebrow">GAUGE OPTIONS</p><h2 id="active-projects">Active projects</h2></div></div><ProjectList projects={data.projects} empty="No active projects" metadata={metadata} /></section>
      <section aria-labelledby="applications"><div className="toolbar"><div><p className="eyebrow">PUBLIC APPLICATIONS</p><h2 id="applications">Pending review</h2></div></div><ProjectList projects={data.applications} empty="No pending applications" metadata={metadata} /></section>
    </div>
    <Outlet context={outletContext} />
    <section className="facts-panel policy-panel" aria-labelledby="registry-economics"><div className="toolbar"><div><p className="eyebrow">LIVE CONTRACT RULES</p><h2 id="registry-economics">Registration policy</h2></div></div><div className="network-grid"><Fact label="Exact registration bond" value={juno(data.config.registration_bond)} /><Fact label="Native token" value="$JUNO" /><Fact label="Metadata URI limit" value={`${data.config.max_metadata_uri_bytes} bytes`} /><Fact label="Payout delay" value={`${data.config.payout_address_delay_seconds}s`} /><Fact label="Bond liability" value={juno(data.health.accounting.bond_liability)} /><Fact label="Actual balance" value={juno(data.health.actual_native_balance)} /><Fact label="Curator (label only)" value={compact(data.config.curator)} /><Fact label="Governor (label only)" value={compact(data.config.governor)} /></div></section>
    <details className="network-details"><summary>Registry provenance <span>Weakly consistent direct-RPC observation</span></summary><div className="network-grid"><Fact label="Contract" value={compact(config.registryContract)} /><Fact label="Code ID" value={String(config.registryCodeId)} /><Fact label="Observation height" value={data.observationHeight.toLocaleString()} /><Fact label="Observed" value={data.refreshedAt.toISOString()} /></div><p>Pages are ordered by exclusive contract cursors and may change between queries. Every write must re-query canonical state and chain time before wallet review. Project names and descriptions are fetched from the configured public IPFS gateway, which can observe the documents this browser requests.</p></details>
  </main>;
}
export function ProjectManageRoute() {
  const { source, config, transactionFlow, sender, publisher } = useOutletContext<RegistryOutletContext>();
  const close = useCloseModal("/projects");
  return <Modal titleId="project-action-form-title" onClose={close}>
    <PageMeta route="projects/manage" />
    <ActionWorkbench config={config} source={source} transactionFlow={transactionFlow} sender={sender} publisher={publisher} />
  </Modal>;
}

export function ProjectDetailRoute() {
  const { source, config, metadata } = useOutletContext<RegistryOutletContext>();
  const close = useCloseModal("/projects");
  const params = useParams();
  const projectId = params.projectId ?? "";
  if (!/^[1-9]\d*$/.test(projectId)) return <NotFound />;
  return <ProjectDetailLoader id={Number(projectId)} source={source} metadata={metadata} gateway={config.ipfsGateway} onClose={close} />;
}

function ProjectDetailLoader({ id, source, metadata, gateway, onClose }: { id: number; source: RegistryDataSource; metadata?: MetadataClient; gateway: string; onClose: () => void }) {
  const load = useMemo(() => () => source.loadProject(id), [source, id]); const [state, retry] = useAsync(load, `project ${id}`);
  return <Modal variant="panel" titleId="project-detail" onClose={onClose}>
    <PageMeta route="projects" titleOverride={`Project #${id} · Juno Voice`} />
    <h2 id="project-detail">Project detail · {id}</h2>
    {state.kind === "loading" ? <State title="Loading canonical detail…" detail="Querying project and complete histories." /> : state.kind === "error" ? <State title="Detail unavailable" detail={state.message}><button className="button" onClick={retry}>Retry detail</button></State> : <Detail detail={state.data} metadata={metadata} gateway={gateway} />}
  </Modal>;
}

function ProjectList({ projects, empty, metadata }: { projects: Project[]; empty: string; metadata?: MetadataClient }) {
  return <div className="project-list">{projects.length === 0 ? <State title={empty} detail="The verified contract returned an empty page." /> : projects.map((project) => <article className="project-card" key={project.id}><div><span className="badge">{statusLabel(project.status)}</span><h3 className="break"><VerifiedName client={metadata} uri={project.metadata_uri} digest={project.metadata_digest} fallback={project.metadata_uri} /></h3><small>Project #{project.id}</small><p>Owner {compact(project.owner)}</p><small>Payout {compact(project.payout_address)}</small></div><Link className="button secondary" to={String(project.id)}>View canonical detail</Link></article>)}</div>;
}
function Detail({ detail: { project: p, statusHistory, addressHistory }, metadata, gateway }: { detail: ProjectDetail; metadata?: MetadataClient; gateway: string }) {
  return <div className="detail-grid"><div><h3>Canonical record</h3><dl><dt>Status</dt><dd>{statusLabel(p.status)}</dd><dt>Owner</dt><dd className="break">{p.owner}</dd><dt>Payout</dt><dd className="break">{p.payout_address}</dd><dt>Metadata</dt><dd className="break"><MetadataPanel client={metadata} gateway={gateway} uri={p.metadata_uri} digest={p.metadata_digest} expected="juno-voice/project" /></dd><dt>Admission</dt><dd>{p.provenance.kind === "bonded_registration" ? "Bonded public registration" : `Graduated bounty #${p.provenance.source_bounty_id}`}</dd>{p.bond && <><dt>Registration bond</dt><dd>{juno(p.bond.amount)} · {p.bond.state}</dd></>}{p.latest_review && <><dt>Latest curator review</dt><dd>{p.latest_review.code.replaceAll("_", " ")} · {p.latest_review.note}</dd></>}</dl>{p.pending_payout_address && <div className="notice"><strong>Pending payout address</strong><p className="break">{p.pending_payout_address.address}</p><p>Acceptable by the proposed address at or after <time dateTime={utc(p.pending_payout_address.executable_at)}>{utc(p.pending_payout_address.executable_at)}</time>, subject to canonical chain time.</p></div>}</div><div><History title="Status history" entries={statusHistory.map((h) => ({ key: h.sequence, title: `${h.from ?? "new"} → ${h.to}`, detail: `${h.action} · ${utc(h.at)} · ${compact(h.actor)}` }))} /><History title="Payout address history" entries={addressHistory.map((h) => ({ key: h.sequence, title: h.action, detail: `${h.proposed_address ? compact(h.proposed_address) : "No proposed address"} · ${utc(h.at)}` }))} /></div></div>;
}
function History({ title, entries }: { title: string; entries: { key: number; title: string; detail: string }[] }) { return <section className="history"><h3>{title}</h3>{entries.length ? <ol>{entries.map((e) => <li key={e.key}><strong>{e.title}</strong><small>{e.detail}</small></li>)}</ol> : <p>No history entries.</p>}</section>; }
function ActionWorkbench({ config, source, transactionFlow, sender, publisher }: { config: AppConfig; source: RegistryDataSource; transactionFlow?: RegistryTransactionFlow; sender?: string; publisher?: DocumentPublisher }) {
  const [action, setAction] = useState<RegistryAction>("register_project"), [projectId, setProjectId] = useState(""), [metadataUri, setMetadataUri] = useState(""), [digest, setDigest] = useState(""), [address, setAddress] = useState(""), [note, setNote] = useState("");
  const [connectedSender, setConnectedSender] = useState<string | null>(sender ?? null), [review, setReview] = useState<TransactionReview | null>(null), [outcome, setOutcome] = useState<TransactionOutcome | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [digestBusy, setDigestBusy] = useState(false);
  const [fields, setFields] = useState(EMPTY_PROJECT_FIELDS);
  const [manualMode, setManualMode] = useState(!publisher);
  const [publishing, setPublishing] = useState(false);
  const activeSender = sender ?? connectedSender;
  const contractScope = useMemo(() => ({ chainId: config.chainId, contract: config.registryContract }), [config.chainId, config.registryContract]);
  const scope = useMemo(() => activeSender ? { sender: activeSender, ...contractScope } : null, [activeSender, contractScope]);
  const [receipt, setReceipt] = useState<{ hash: string; url: string; confirmed: boolean } | null>(null);
  const preparedAction = useRef<RegistryAction | null>(null);
  const [storedSubmission, setStoredSubmission] = useState<StoredRegistrySubmission | null>(() => scope ? loadRegistrySubmission(scope) : loadLatestRegistrySubmission(contractScope));
  useEffect(() => setStoredSubmission(scope ? loadRegistrySubmission(scope) : loadLatestRegistrySubmission(contractScope)), [scope, contractScope]);
  const submissionLocked = storedSubmission !== null;
  const persistedReceipt = storedSubmission?.kind === "uncertain" && storedSubmission.evidence.txHash && storedSubmission.evidence.explorerUrl
    ? { hash: storedSubmission.evidence.txHash, url: storedSubmission.evidence.explorerUrl, confirmed: false } : null;
  const visibleReceipt = receipt ?? persistedReceipt;
  const connect = async () => { if (!transactionFlow?.connect) return; setBusy(true); setError(null); try { const identity = await transactionFlow.connect(); setConnectedSender(identity.address); } catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet connection failed."); } finally { setBusy(false); } };
  const prepare = async () => {
    if (!transactionFlow || !activeSender || submissionLocked) return;
    setBusy(true); setError(null); setReview(null); setOutcome(null);
    try {
      let uri = metadataUri, metadataDigest = digest;
      if (usesMetadata && !manualMode) {
        if (!publisher) throw new Error("Publishing from this app is not configured. Link a file you published yourself instead.");
        setPublishing(true);
        try {
          const logo = fields.logo ? await publisher.publishImage(fields.logo) : null;
          const pinned = await publisher.publishDocument("project.json", projectDocumentFrom(fields, logo?.uri));
          uri = pinned.uri; metadataDigest = pinned.digest;
        } finally { setPublishing(false); }
      }
      const numericProjectId = action === "register_project" ? null : Number(projectId);
      const context = await source.loadActionContext(numericProjectId);
      const intent = buildRegistryIntent(config, activeSender, context, { action, projectId: numericProjectId, metadataUri: uri, metadataDigest, address, note });
      const prepared = await transactionFlow.prepare(intent);
      preparedAction.current = action; setReview(prepared);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Transaction preparation failed."); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!transactionFlow || !review || !scope) return;
    setBusy(true); setError(null);
    const submittedReview = review;
    const submittedAction = registryActionFromReview(submittedReview.executeMessage);
    if (submittedReview.sender !== scope.sender || submittedReview.chainId !== scope.chainId ||
      submittedReview.contract !== scope.contract || !submittedAction || submittedAction !== preparedAction.current) {
      setError("Prepared transaction no longer matches the requested account, contract, and action. Nothing was submitted.");
      setReview(null); setBusy(false); return;
    }
    const preSubmissionEvidence = { version: 1 as const, ...scope, action: submittedAction, status: "unknown" as const };
    if (!saveRegistrySubmission(preSubmissionEvidence)) {
      setStoredSubmission({ kind: "malformed" }); setReview(null); setBusy(false); return;
    }
    setStoredSubmission({ kind: "uncertain", evidence: preSubmissionEvidence });
    try {
      const runtimeResult: unknown = await transactionFlow.submit(submittedReview);
      const result = runtimeTransactionOutcome(runtimeResult);
      if (!result) { setOutcome(null); setStoredSubmission({ kind: "malformed" }); setReview(null); return; }
      const status = result.status;
      setOutcome(result);
      if ("txHash" in result && result.txHash && result.explorerUrl)
        setReceipt({ hash: result.txHash, url: result.explorerUrl, confirmed: status === "confirmed" });
      if (status === "pending" || status === "unknown") {
        const uncertain = result as Extract<TransactionOutcome, { status: "pending" | "unknown" }>;
        const evidence = { ...preSubmissionEvidence, status, ...(uncertain.txHash ? { txHash: uncertain.txHash } : {}),
          ...(uncertain.explorerUrl ? { explorerUrl: uncertain.explorerUrl } : {}) };
        if (saveRegistrySubmission(evidence)) setStoredSubmission({ kind: "uncertain", evidence });
        else { setStoredSubmission({ kind: "malformed" }); setOutcome(null); }
      } else {
        clearRegistrySubmission(scope);
        if (loadRegistrySubmission(scope) === null) setStoredSubmission(null);
        else { setStoredSubmission({ kind: "malformed" }); setOutcome(null); }
      }
      setReview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transaction submission failed; signing may have begun. Do not submit again.");
      setReview(null);
    } finally { setBusy(false); }
  };
  const restoredNotice = !outcome && storedSubmission ? <p className="notice" role="status">{storedSubmission.kind === "malformed" ? "Stored submission evidence is malformed or unavailable. Preparation remains locked; inspect this account on Juno and do not submit again." : storedSubmission.evidence.txHash ? "Submission is not canonically confirmed. Use the transaction evidence below and do not submit again." : "Signing began and submission may have occurred, but no transaction hash is available. Do not submit again until you inspect this account on Juno."}</p> : null;
  const guidance = registryActionHelp[action];
  const usesMetadata = action === "register_project" || action === "update_pending_metadata";
  return <section id="registry-workbench" className="workbench protocol-workbench" aria-labelledby="project-action-form-title">
    <div className="workbench-heading">
      <div><p className="eyebrow">PROJECT DETAILS</p><h2 id="project-action-form-title">Choose a project action</h2></div>
      <span className="step-marker">01 · DETAILS</span>
    </div>
    <p>Choose what you want to do and enter the project details. We will check the latest registry state before showing a wallet review.</p>
    <div className="action-guidance" role="note"><strong>{guidance.title}</strong><p>{guidance.detail}</p></div>
    <div className="form-grid">
      <label>Action<select aria-label="Project action" value={action} disabled={submissionLocked} onChange={(e) => { setAction(e.target.value as RegistryAction); setReview(null); }}><option value="register_project">Register project</option><option value="update_pending_metadata">Update pending metadata</option><option value="propose_payout_address">Propose payout address</option><option value="cancel_payout_address_change">Cancel payout change</option><option value="accept_payout_address">Accept delayed payout</option><option value="retire">Voluntary retirement</option><option value="claim_registration_bond">Claim registration bond</option></select><small className="form-help">Select the project change you want to make.</small></label>
      {action !== "register_project" && <label>Project ID<input aria-label="Project ID" value={projectId} inputMode="numeric" pattern="[1-9][0-9]*" disabled={submissionLocked} placeholder="1" onChange={(e) => setProjectId(e.target.value)} /><small className="form-help">Positive numeric ID assigned by the registry.</small></label>}
      {usesMetadata && manualMode && <>
        <UriDigestFields uriLabel="Metadata URI" uriAriaLabel="Metadata URI"
          uriHint="A public, durable link to the project metadata." uriValue={metadataUri}
          onUriChange={(value) => { setMetadataUri(value); setReview(null); }}
          digestLabel="Metadata fingerprint" digestAriaLabel="SHA-256 metadata digest"
          digestHint="A SHA-256 fingerprint proves the linked file has not changed." digestValue={digest}
          onDigestChange={(value) => { setDigest(value); setReview(null); }}
          fileLabel="Calculate fingerprint from file" fileAriaLabel="Calculate digest from metadata file"
          fileHint="Choose the same file you publish at the metadata URI. It stays in your browser."
          disabled={submissionLocked} onHashingChange={setDigestBusy} />
        {publisher
          ? <button type="button" className="button secondary" onClick={() => setManualMode(false)}>Fill in project details instead</button>
          : <small className="form-help">Publishing from this app is not configured. Link a file you published yourself.</small>}
      </>}
      {usesMetadata && !manualMode && <>
        <ProjectFields value={fields} onChange={(next) => { setFields(next); setReview(null); }} disabled={submissionLocked || publishing} />
        <small className="form-help">Juno Voice publishes these details to IPFS and commits their exact fingerprint on chain when you continue.</small>
        <button type="button" className="button secondary" onClick={() => setManualMode(true)}>Advanced: link a file you already published</button>
      </>}
      {["register_project", "propose_payout_address"].includes(action) && <label>Payout address<input aria-label="Payout address" value={address} disabled={submissionLocked} placeholder="juno1…" onChange={(e) => setAddress(e.target.value)} /><small className="form-help">Where future project funding goes. A personal account or a contract, such as a DAO or a multisig.</small></label>}
      {action === "retire" && <label>Retirement note<input aria-label="Retirement note" value={note} disabled={submissionLocked} onChange={(e) => setNote(e.target.value)} /><small className="form-help">A short public explanation for retiring the project.</small></label>}
    </div>
    <details className="workbench-help"><summary>Before you continue</summary><p>Juno Voice will show the selected account, registry contract, funds, fee, and expected result. The latest project state and wallet account are checked again before your wallet asks you to sign.</p></details>
    {!transactionFlow ? <p className="notice" role="status">Supported Keplr or Leap wallet transaction support is unavailable in this browser. Registry browsing never requires a wallet.</p> : !activeSender ? <button className="button" disabled={busy || !transactionFlow.connect} onClick={connect}>{busy ? "Connecting wallet…" : "Connect wallet"}</button> : <><p className="notice" role="status">Connected account: {compact(activeSender)}</p><button className="button" disabled={busy || submissionLocked || digestBusy} onClick={prepare}>{busy ? (publishing ? "Publishing project details…" : "Checking project status…") : "Review project action"}</button></>}
    {error && <p className="notice danger" role="alert">{error}</p>}
    {review && <Modal titleId="registry-review-title" onClose={() => setReview(null)} closeDisabled={busy} closeLabel="Cancel review">
      <div className="review-box"><strong id="registry-review-title">Review before signing</strong><pre>{JSON.stringify({ sender: review.sender, chainId: review.chainId, contract: review.contract, msg: review.executeMessage, ...userFacingTransactionAmounts(review), consequences: review.consequences, canonicalState: review.canonicalState }, null, 2)}</pre><button className="button" disabled={busy} onClick={submit}>{busy ? "Checking latest state…" : "Confirm and open wallet"}</button></div>
    </Modal>}
    {outcome && <p className="notice" role="status">{outcome.status === "confirmed" ? `Confirmed at height ${outcome.height}. Canonical state ${outcome.refreshStatus}.` : outcome.status === "failed" || outcome.status === "rejected" ? outcome.reason : outcome.txHash ? "Submission is not canonically confirmed. Use the transaction evidence below and do not submit again." : "Signing began and submission may have occurred, but no transaction hash is available. Do not submit again until you inspect this account on Juno."}</p>}
    {restoredNotice}
    {visibleReceipt && <p><a href={visibleReceipt.url} target="_blank" rel="noopener noreferrer">View {visibleReceipt.confirmed ? "confirmed transaction" : "transaction evidence"} {visibleReceipt.hash}</a></p>}
  </section>;
}
export default Registry;
