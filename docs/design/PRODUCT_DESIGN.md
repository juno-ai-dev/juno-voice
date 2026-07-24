# Product and interaction design

**Product:** Juno Voice  
**Design source:** [Juno Design System](https://github.com/juno-ai-dev/juno-design-system), commit `0dc0ae9`  
**Prototype:** [`../../prototype/index.html`](../../prototype/index.html)

## Product posture

Juno Voice is a public work signal, not a social feed. The interface should make three questions answerable within seconds:

1. What does the network want built?
2. Why is an item ranked here?
3. What evidence shows that work moved or shipped?

The visual voice follows the Juno system: precise, dark, diagrammatic, terse. It must not become generic SaaS cards, neon crypto dashboards, or governance theater.

## Information architecture

- **Signal** — ranked requests, filters, search, status and participation.
- **Request detail** — brief, acceptance criteria, fixed snapshot, tally, lifecycle, evidence.
- **Transmit** — submit a feature request and anti-spam bond.
- **Build log** — cross-request delivery activity and evidence.
- **Protocol** — transparent ranking, bond, lifecycle, authority, and snapshot rules.
- **Wallet** — voting power, submitted requests, votes, and bond/refund state.

## Primary flows

### Submit a request

1. Connect wallet.
2. Enter title, concise problem statement, category, and required inline acceptance criteria; optionally add a digest-pinned detail URI.
3. Review exact anti-spam bond, refund/forfeiture policy, and immutable snapshot rule.
4. Sign transaction.
5. Land on the new request detail with status `OPEN`.

The form should encourage testable needs, not implementation prescriptions. Character counts and validation are inline. No multi-page wizard for MVP.

### Prioritize

1. Scan ranked requests.
2. Open a request and inspect scope, tally, snapshot, and evidence.
3. Choose `SUPPORT` or `OPPOSE`.
4. Review the voting power that will be recorded at the fixed snapshot.
5. Sign once; receipt becomes immutable.

Never reduce voting to an unexplained percentage. Show support power, opposition power, net signal, total snapshot power, voter count, and snapshot height.

### Build and verify

1. Agent or builder queries `QUALIFIED` work directly over RPC.
2. Steward assigns one builder and moves the request directly to `BUILDING`; there is no `ACCEPTED` state.
3. The current-round builder attaches digest-bearing delivery evidence and requests `REVIEW`.
4. A distinct verifier adds current-round verification evidence and either rejects/blocks review or attests `SHIPPED` against the immutable criteria.
5. Typed action logs preserve assignment, evidence, bond, transition, and attestation history.

## Screen inventory

### 1. Signal / ranked roadmap

- Juno wordmark + `VOICE` product label.
- Primary action: `TRANSMIT REQUEST`.
- Compact protocol indicators: chain, externally operator-attested snapshot-retention status with source and as-of height/time, submission-pause state, open request count. Label retention status as external and never as contract-verified exact-height availability.
- Filter tabs: `ALL`, `OPEN`, `QUALIFIED`, `BUILDING`, `SHIPPED`.
- Category tags and search.
- Dense ranked rows rather than a card mosaic:
  - rank and request ID;
  - title and one-line summary;
  - category/status;
  - net support and participation;
  - closing/delivery state.

### 2. Request detail

- Title, author, status, category, immutable request ID.
- Acceptance criteria and problem statement.
- Two-column desktop layout:
  - main: brief, lifecycle, evidence;
  - rail: support/oppose action, power receipt preview, snapshot facts.
- Direct links to chain transaction and external evidence.
- Visible moderation and status reasons.

### 3. Transmit request

- Single focused form in a technical enclosure.
- Bond state/refund policy, snapshot trust assumption, voting duration, and accepted byte/count limits visible before signing.
- Transaction preview uses exact values; never vague “network fee may apply” copy alone.

### 4. Build log

- Chronological typed-action stream with request IDs and work rounds.
- Filters by delivery/verification evidence kind, status, builder, and verifier.
- No vanity metrics; only verifiable work events.

### 5. Protocol

- Human-readable rules beside exact machine fields.
- Explain the external snapshot-retention trust assumption, signed ranking tie-breaks, independent bond lifecycle, separate admin/governor/steward/verifier/builder roles, submission-only pause, and non-goals.
- Link contract address/code checksum after deployment.

### 6. Wallet

- Snapshot-aware voting power explanation.
- Submitted requests, immutable vote receipts, and locked/refundable/claimed bond state.
- Pull-refund action with explicit amount.

## Design-system mapping

| Product need | Juno primitive / rule |
|---|---|
| Primary actions | `Button` primary, short uppercase verbs |
| Secondary actions | `Button` secondary/ghost |
| Request enclosure | `Card`, small radius, hairline coral border |
| Status | `Badge` tones: live/warn/ok/dead |
| Categories and filters | `Tag`, `Tabs` |
| Inputs | `Input`, `Select`, `Radio`, `Checkbox` |
| Snapshot/protocol labels | `Eyebrow`, Space Mono, wide tracking |
| Rank/request numerics | `NodeMark` posture, adapted as `SignalMark` |
| Confirmation | `Dialog`; concise transaction facts |
| Feedback | `Toast`; never hide transaction links |
| Loading | `Pulse`, reduced-motion safe |
| Environment | `.juno-grid`, restrained `.juno-gate`, optional veil |

A reusable `SignalMark` or `TallyBar` should be proposed to the design-system repository if it proves useful across Juno apps.

## Visual direction

The prototype adopts **Signal Ledger**, the strongest-fit direction:

- a dense, ordered ledger rather than rounded dashboard cards;
- rank numbers and request IDs as the numeric hero language;
- coral reserved for live signal and action;
- cream for content, muted bone for metadata;
- maroon/void ground with a 32px coordinate grid;
- timeline/evidence rendered as technical transmissions.

Two future explorations can remain within the system:

1. **Console:** stronger left navigation and operational telemetry, based on the existing Console UI kit.
2. **Field notes:** more editorial request detail with a narrow reading column and marginal snapshot annotations.

They should differ in hierarchy—not merely swap colors.

## Content rules

- Use terse verbs: `TRANSMIT`, `SUPPORT`, `OPPOSE`, `ATTACH EVIDENCE`, `WITHDRAW`.
- Explain irreversible actions plainly; cryptic brand voice must never obscure funds or signatures.
- No emoji, hype, exclamation points, or “seamless community-driven innovation.”
- IDs, heights, addresses, power, and timestamps use monospace.
- Draft product copy must not imply that ranking binds Juno governance.
- Use “attested shipment” or “delivery attestation,” never “proof of correctness.”
- Label `OPEN` requests past close as derived `AWAITING_FINALIZATION`; do not present it as an on-chain status.
- A pause banner must say that only new submissions are paused and that voting, finalization, evidence, recovery, and refunds remain available.

## Responsive behavior

- Desktop: ranked ledger + facts rail; request detail two columns.
- Tablet: filters wrap; facts rail moves below title before main content.
- Mobile: one column; persistent vote action may dock at bottom but must not cover content.
- Minimum 44px touch targets.
- Tables become semantic stacked rows without dropping labels.
- Wallet addresses truncate visually but remain copyable and available to assistive tech.

## Accessibility

- WCAG 2.2 AA contrast for text and controls; validate exact alpha-on-maroon combinations.
- Do not encode support/opposition or status by color alone—always include label/glyph/value.
- Real landmarks, headings, buttons, labels, focus rings, and keyboard order.
- Vote confirmation names the choice, request, snapshot height, power, and funds.
- Announce transaction pending/success/failure through an ARIA live region.
- Respect `prefers-reduced-motion`; mechanical transitions collapse cleanly.
- Charts/tally bars include a textual equivalent.
- Dialogs require `role="dialog"`, `aria-modal`, a labelled title, initial focus, focus trap, Escape handling, and focus restoration.
- Tabs require roving tab focus, arrow-key behavior, `aria-controls`, and matching tab panels.
- Interactive request rows render as semantic links/buttons; clickable tags render as buttons with `aria-pressed`.
- Toasts use `status`/`alert` semantics and remain discoverable beyond a timed visual disappearance.
- Form errors use `aria-invalid` and `aria-describedby`; icon-only controls require contextual accessible names.

## Prototype scope

The dependency-free prototype demonstrates:

- ranked roadmap filtering;
- request selection and detail;
- support/oppose preview interaction;
- snapshot and evidence presentation;
- responsive Juno-native visual language.

It does not connect a wallet, query chain state, or sign transactions. All displayed requests are explicitly marked as sample data.
