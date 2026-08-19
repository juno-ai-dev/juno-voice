import { Link } from "react-router";
import { PageMeta } from "./components/PageMeta";
import "./LandingPage.css";
import "./ShellLanding.css";

const steps = [
  {
    number: "01",
    title: "Request & fund",
    body: "Publish a clear outcome and acceptance criteria. Anyone can add native $JUNO to the same on-chain bounty.",
  },
  {
    number: "02",
    title: "Deliver & ratify",
    body: "A delivery is proposed with public evidence. Contributors—not an operator—decide whether pooled funds are paid.",
  },
  {
    number: "03",
    title: "Graduate",
    body: "Successful work can become a stable project record. Existing projects can also apply with an on-chain bond.",
  },
  {
    number: "04",
    title: "Express preferences",
    body: "Juno stakers use the gauge to express how a fixed funding budget should be distributed across eligible projects.",
  },
] as const;

const destinations: ReadonlyArray<{
  to: string;
  eyebrow: string;
  title: string;
  body: string;
  action: string;
}> = [
  {
    to: "/bounties",
    eyebrow: "FUND WORK",
    title: "Explore bounties",
    body: "Find requested outcomes, inspect their terms and funding, or start a new bounty.",
    action: "View bounty ledger",
  },
  {
    to: "/gauge",
    eyebrow: "SHAPE FUNDING",
    title: "Explore the gauge",
    body: "See how Juno stakers express weighted funding preferences, from each epoch snapshot through its final outcome.",
    action: "View gauge epochs",
  },
  {
    to: "/projects",
    eyebrow: "BUILD HISTORY",
    title: "Discover projects",
    body: "See active, pending, and retired project records and their public provenance.",
    action: "View projects",
  },
];

export function LandingPage() {
  return (
    <main className="landing">
        <PageMeta route="" />
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="eyebrow">COMMUNITY FUNDING, WITH A PUBLIC RECORD</p>
            <h1 id="landing-title">Fund useful work.<br /><span>Let Juno signal what comes next.</span></h1>
            <p className="landing-lede">
              Juno Voice connects accountable bounties with a transparent funding gauge.
              Back useful work, graduate proven projects, and let Juno stakers express
              how recurring Hack Juno funding should be distributed.
            </p>
            <div className="landing-actions">
              <Link className="button landing-primary" to="/gauge">Explore the funding gauge <span aria-hidden="true">↗</span></Link>
              <Link className="button secondary" to="/bounties">Browse bounties</Link>
            </div>
            <p className="wallet-free"><span aria-hidden="true">●</span> No wallet needed to explore verified mainnet data</p>
          </div>
          <aside className="protocol-loop" aria-label="Juno Voice protocol loop">
            <div className="loop-status"><span>LIVE</span><strong>JUNO-1</strong></div>
            <p className="loop-label">THE COMMUNITY FUNDING LOOP</p>
            <ol>
              <li><span>01</span><strong>Request</strong><small>Define the outcome</small></li>
              <li><span>02</span><strong>Fund</strong><small>Pool $JUNO</small></li>
              <li><span>03</span><strong>Ratify</strong><small>Verify delivery</small></li>
              <li><span>04</span><strong>Signal</strong><small>Express funding preferences</small></li>
            </ol>
          </aside>
        </section>

        <section className="landing-section" aria-labelledby="how-title">
          <div className="section-heading">
            <p className="eyebrow">HOW IT WORKS</p>
            <h2 id="how-title">From a shared need to lasting momentum.</h2>
            <p>Each stage has a distinct decision-maker and an on-chain record. No single operator controls the whole loop.</p>
          </div>
          <ol className="process-grid">
            {steps.map((step) => (
              <li key={step.number}>
                <span>{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="gauge-spotlight" aria-labelledby="gauge-spotlight-title">
          <div className="gauge-spotlight-copy">
            <p className="eyebrow">THE FUNDING GAUGE</p>
            <h2 id="gauge-spotlight-title">A visible signal for where funding should flow.</h2>
            <p>
              During each fixed epoch, Juno stakers can split their snapshot voting power
              across eligible projects. The gauge turns those weighted preferences into an
              auditable funding outcome—without turning a vote into a blank cheque.
            </p>
            <Link className="button secondary" to="/gauge">See current gauge activity <span aria-hidden="true">→</span></Link>
          </div>
          <ol className="gauge-principles" aria-label="Gauge characteristics">
            <li><span>01</span><div><strong>Snapshot power</strong><p>Voting power and project options are fixed for the epoch.</p></div></li>
            <li><span>02</span><div><strong>Weighted preferences</strong><p>Stakers can express nuance by splitting preference weight.</p></div></li>
            <li><span>03</span><div><strong>Bounded budget</strong><p>Each epoch works from a known, pre-funded allocation.</p></div></li>
            <li><span>04</span><div><strong>Auditable outcome</strong><p>Turnout, retained value, and distribution remain public.</p></div></li>
          </ol>
        </section>

        <section className="trust-section" aria-labelledby="trust-title">
          <div className="trust-intro">
            <p className="eyebrow">TRUST IS EXPLICIT</p>
            <h2 id="trust-title">Different powers.<br />Clear boundaries.</h2>
            <p>Juno Voice does not ask you to trust a black box. The chain is authoritative, roles are narrow, and every wallet action has an exact review before signing.</p>
          </div>
          <dl className="trust-list">
            <div><dt>Bounty contributors</dt><dd>Control whether their pooled bounty pays a proposed delivery.</dd></div>
            <div><dt>Juno stakers</dt><dd>Express weighted preferences over the fixed, pre-funded allocation for each gauge epoch.</dd></div>
            <div><dt>Agent Operations DAO</dt><dd>Curates and can stop unsafe entry points, but cannot redirect bounty funds or gauge votes.</dd></div>
            <div><dt>Juno governance</dt><dd>Controls program funding, administration, upgrades, and recovery at the outer boundary.</dd></div>
          </dl>
        </section>

        <section className="landing-section destinations" aria-labelledby="next-title">
          <div className="section-heading compact">
            <p className="eyebrow">EXPLORE THE PROTOCOL</p>
            <h2 id="next-title">Choose your next step.</h2>
          </div>
          <div className="destination-grid">
            {destinations.map((destination) => (
              <article key={destination.to}>
                <p className="eyebrow">{destination.eyebrow}</p>
                <h3>{destination.title}</h3>
                <p>{destination.body}</p>
                <Link to={destination.to}>{destination.action} <span aria-hidden="true">→</span></Link>
              </article>
            ))}
          </div>
        </section>
    </main>
  );
}
