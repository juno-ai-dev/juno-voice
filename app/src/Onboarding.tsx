export type PublicView = "bounties" | "projects" | "gauge";

type Journey = {
  title: string;
  view: PublicView;
  destination: string;
  intro: string;
  steps: string[];
};

const journeys: Journey[] = [
  {
    title: "Create or fund a bounty",
    view: "bounties",
    destination: "Open bounties",
    intro: "Publish a task with acceptance criteria, or add JUNO to an open task.",
    steps: [
      "Funds attached to a transaction leave your wallet if it confirms; they are then controlled by the bounty contract, not by this app.",
      "The deadline uses Juno chain time, not your device clock. After it passes, the contract rules decide whether expiry and refunds are available.",
      "Review the exact amount, fee, contract, message, and deadline before asking your wallet to sign.",
    ],
  },
  {
    title: "Register a project",
    view: "projects",
    destination: "Open projects",
    intro: "Submit a public project record for review and future gauge eligibility.",
    steps: [
      "The exact registration bond is attached to the transaction and held by the registry contract after confirmation.",
      "A bond is not a fee guarantee: you receive a refund only when the contract’s rules allow it, and rejection or other outcomes may affect it.",
      "Registration starts an application; it does not promise approval, gauge eligibility, or funding.",
    ],
  },
  {
    title: "Settle with contributors",
    view: "bounties",
    destination: "Open bounties",
    intro: "Open a bounty to nominate work, vote, finalize a payout, or claim an eligible refund.",
    steps: [
      "When a settlement round begins, each contribution weight is captured for that settlement round. Later balance changes do not rewrite that snapshot.",
      "Round and bounty deadlines use Juno chain time. At the exact closing time, voting is closed.",
      "A payout or refund is available only when canonical contract state permits it. Check the recipient and outcome before signing.",
    ],
  },
  {
    title: "Set gauge preferences",
    view: "gauge",
    destination: "Open gauge",
    intro: "Weight eligible projects for the current fixed allocation epoch.",
    steps: [
      "For this epoch, snapshot power is your recorded voting power at the fixed snapshot height; your current wallet balance may differ.",
      "Weights express preferences, not a promised payout. Turnout, eligibility, caps, and execution rules determine the result.",
      "Unused weight and do-not-distribute keep value in the Program Vault; they do not send it to another project.",
    ],
  },
];

export default function Onboarding({ onNavigate }: { onNavigate: (view: PublicView) => void }) {
  return (
    <aside className="onboarding" aria-labelledby="onboarding-title">
      <div className="onboarding-intro">
        <p className="eyebrow">NEW TO JUNO VOICE?</p>
        <h2 id="onboarding-title">Start here</h2>
        <p>Browsing is wallet-free. Choose a public journey, then expand only what you need.</p>
      </div>
      <div className="journey-grid">
        {journeys.map((journey) => (
          <details className="journey" key={journey.title}>
            <summary>{journey.title}</summary>
            <p>{journey.intro}</p>
            <ol>{journey.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            <button className="button secondary" type="button" onClick={() => onNavigate(journey.view)}>{journey.destination}</button>
          </details>
        ))}
      </div>
      <details className="safety-guide">
        <summary>Before any wallet action</summary>
        <div className="safety-grid">
          <p><strong>Wallet permission</strong> Connecting reveals your selected public address and lets the wallet show requests. It does not give this app permission to move funds on its own.</p>
          <p><strong>Exact review</strong> Preparing is not signing. Compare the account, Juno network, contract, message, attached funds, fee, deadlines, and stated consequences in the pre-sign review.</p>
          <p><strong>Finality</strong> A confirmed transaction is final and cannot be undone by Juno Voice. Wallet rejection, network failure, or contract rules can prevent an intended outcome; no result is guaranteed.</p>
          <p><strong>Uncertain submission</strong> If confirmation is missing, do not retry. Use the shown transaction evidence and inspect your account on Juno first to avoid submitting twice.</p>
        </div>
      </details>
    </aside>
  );
}
