import { Link } from "react-router";
import { PageMeta } from "./components/PageMeta";
import "./FAQPage.css";

type FAQSection = {
  id: string;
  eyebrow: string;
  title: string;
  questions: ReadonlyArray<{ question: string; answer: string }>;
};

const sections: ReadonlyArray<FAQSection> = [
  {
    id: "basics",
    eyebrow: "START HERE",
    title: "The basics",
    questions: [
      {
        question: "What is Juno Voice?",
        answer: "Juno Voice is a community funding interface on Juno. It connects funded bounties, a registry of eligible projects, and a gauge where Juno stakers express preferences for recurring funding distribution.",
      },
      {
        question: "Do I need a wallet to use it?",
        answer: "No. Bounties, projects, gauge epochs, and transaction history are public to browse. A supported wallet is needed only when you choose to submit an on-chain action.",
      },
      {
        question: "Where does the information come from?",
        answer: "The interface queries the configured Juno mainnet contracts directly and shows the observation height and provenance. The chain remains authoritative if displayed information and canonical state ever differ.",
      },
    ],
  },
  {
    id: "bounties",
    eyebrow: "FUND WORK",
    title: "Bounties",
    questions: [
      {
        question: "How do bounties work?",
        answer: "A creator publishes a requested outcome, acceptance criteria, and deadline with initial funding. Other people can add native $JUNO to the same bounty. Confirmed funds are then controlled by the bounty contract rather than this interface.",
      },
      {
        question: "Who decides whether a delivery is accepted?",
        answer: "Contributors ratify a proposed delivery using contribution weights captured for that settlement round. An operator cannot unilaterally redirect the pooled bounty to a recipient.",
      },
      {
        question: "What is a project candidate?",
        answer: "It is optional project metadata attached to a bounty proposal so successful work can later be considered for the registry. Naming a candidate does not register, endorse, approve, or automatically graduate that project.",
      },
    ],
  },
  {
    id: "gauge",
    eyebrow: "SHAPE FUNDING",
    title: "The funding gauge",
    questions: [
      {
        question: "What does the gauge decide?",
        answer: "Each epoch starts with a fixed, pre-funded budget and a fixed snapshot of eligible project options. The gauge turns staker preferences into a transparent signal for how that bounded allocation should be distributed.",
      },
      {
        question: "Who can express preferences?",
        answer: "Juno stakers with recorded voting power at the epoch snapshot can participate. Snapshot power may differ from a wallet’s current balance because it is fixed for the epoch.",
      },
      {
        question: "How do weighted preferences work?",
        answer: "A staker can split their snapshot voting power across eligible projects using decimal weights. The combined weight cannot exceed 1.0, allowing a preference to express more nuance than a single-choice vote.",
      },
      {
        question: "What does “do-not-distribute” mean?",
        answer: "It is a reserved gauge choice that keeps its share in the Program Vault. It is not a project, does not receive a payout, and does not automatically roll value into another project.",
      },
    ],
  },
  {
    id: "projects",
    eyebrow: "BUILD HISTORY",
    title: "Projects",
    questions: [
      {
        question: "What makes a project eligible for the gauge?",
        answer: "A project must be active in the public registry when a new epoch takes its option snapshot. A registry change never rewrites the fixed options of an epoch already in progress.",
      },
      {
        question: "How does a project enter the registry?",
        answer: "An owner can submit a pending application with the exact registration bond shown by the live policy. Curation, approval, gauge eligibility, funding, and any bond refund are not guaranteed by submitting an application.",
      },
      {
        question: "What is the metadata fingerprint?",
        answer: "It is a SHA-256 fingerprint of the project metadata file. Juno Voice can calculate it locally in your browser so people can verify that the file at the published URI has not changed; the selected file is not uploaded by the app.",
      },
    ],
  },
  {
    id: "wallet-safety",
    eyebrow: "BEFORE SIGNING",
    title: "Wallet and safety",
    questions: [
      {
        question: "What does connecting a wallet allow?",
        answer: "Connecting reveals the selected public address and lets the wallet display transaction requests. It does not give Juno Voice permission to move funds on its own.",
      },
      {
        question: "Where do project names and descriptions come from?",
        answer: "The chain stores a link and a SHA-256 fingerprint for each document. Juno Voice fetches the linked file from a public IPFS gateway, checks its bytes against the on-chain fingerprint, and only shows content that matches. The gateway can observe which documents your browser requests; no wallet is involved in reading.",
      },
      {
        question: "What should I review before signing?",
        answer: "Compare the account, Juno network, contract, message, attached funds, fee, relevant deadlines, and expected consequences. Preparing a review is not the same as signing or submitting a transaction.",
      },
      {
        question: "What if submission is not confirmed?",
        answer: "Do not immediately submit again. Use the transaction evidence shown by the interface and inspect the account on Juno first; retrying an uncertain action can result in an unintended duplicate submission.",
      },
      {
        question: "Can Juno Voice undo a confirmed transaction?",
        answer: "No. A confirmed transaction is final under the contract and chain rules. Wallet rejection, network failure, or contract validation can also prevent an intended action from succeeding.",
      },
    ],
  },
];

const destinations: ReadonlyArray<{ to: string; label: string; detail: string }> = [
  { to: "/bounties", label: "Explore bounties", detail: "Find and fund requested work" },
  { to: "/gauge", label: "View the gauge", detail: "See current funding preferences" },
  { to: "/projects", label: "Browse projects", detail: "Inspect registry records" },
];

export function FAQPage() {
  return (
    <main className="faq-page">
      <PageMeta route="faq" />
      <section className="faq-hero" aria-labelledby="faq-title">
        <div>
          <p className="eyebrow">JUNO VOICE FAQ</p>
          <h1 id="faq-title">Questions,<br /><span>answered plainly.</span></h1>
          <p>Understand the funding loop, the people who make each decision, and what happens before a wallet asks you to sign.</p>
        </div>
        <nav className="faq-topic-index" aria-label="FAQ topics">
          <p>JUMP TO A TOPIC</p>
          {sections.map((section, index) => (
            <a key={section.id} href={`#faq-${section.id}`}><span>{String(index + 1).padStart(2, "0")}</span>{section.title}</a>
          ))}
        </nav>
      </section>

      <div className="faq-layout">
        <aside className="faq-rail">
          <p className="eyebrow">GUIDE TO THE PROTOCOL</p>
          <p>Answers reflect the public interface and its pinned contracts. Canonical Juno state remains authoritative.</p>
        </aside>
        <div className="faq-sections">
          {sections.map((section) => (
            <section id={`faq-${section.id}`} className="faq-section" key={section.id} aria-labelledby={`faq-${section.id}-title`}>
              <header>
                <p className="eyebrow">{section.eyebrow}</p>
                <h2 id={`faq-${section.id}-title`}>{section.title}</h2>
              </header>
              <div className="faq-questions">
                {section.questions.map((item, index) => (
                  <details key={item.question} open={section.id === "basics" && index === 0}>
                    <summary>{item.question}<span aria-hidden="true">+</span></summary>
                    <p>{item.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <section className="faq-next" aria-labelledby="faq-next-title">
        <div><p className="eyebrow">READY TO EXPLORE?</p><h2 id="faq-next-title">Follow the public record.</h2></div>
        <div className="faq-destinations">
          {destinations.map((destination) => (
            <Link key={destination.to} to={destination.to}>
              <span><strong>{destination.label}</strong><small>{destination.detail}</small></span><span aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}

export default FAQPage;
