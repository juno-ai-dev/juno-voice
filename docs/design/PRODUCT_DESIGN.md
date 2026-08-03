# Juno Voice product design

**Status:** Current application design
**Applies to:** [`app/`](../../app/)
**Design source:** [Juno Design System](https://github.com/juno-ai-dev/juno-design-system), commit `0dc0ae9`

## Product posture

Juno Voice is a public work signal, not a social feed or a governance console. The interface should answer three questions quickly:

1. What does Juno want built?
2. Why does a request have this signal and status?
3. What evidence shows that the work moved or shipped?

The application reads canonical testnet data directly from the contract. It must identify the `uni-7` environment, avoid implying production demand, and describe prioritization as non-binding.

## Simplification principle

Each screen has one primary reading task. Information needed for that task is visible; protocol diagnostics and immutable provenance use progressive disclosure.

| Layer | Visible by default | Available on demand |
|---|---|---|
| Roadmap | purpose, request count, submission state, bond, filters, ranked rows | contract, code ID, RPC height, refresh time, aggregate bonds |
| Request | title, status, summary, acceptance criteria, activity, tally, evidence | author/provenance, exact snapshot facts, bond state, typed action log |
| Transaction | human-readable action and amount | exact chain, sender, contract, message, and canonical funds |

This is information prioritization, not information removal. Exact chain facts remain inspectable.

## Information architecture

The maintained MVP has two product screens:

- **Signal ledger** — browse, search, and filter requests; start a submission.
- **Request detail** — understand the immutable brief, signal, lifecycle, evidence, and eligible public actions.

The global header contains only the product identity, environment, and wallet connection. The wordmark returns to the ledger, so a second “Signal” navigation link is unnecessary.

Separate Build log, Protocol, and Wallet areas are not current MVP surfaces. Their underlying information is present in request activity, network details, and contextual wallet actions. A separate area should be added only when it supports a real cross-request workflow.

## Screen hierarchy

### Signal ledger

1. A short product statement and explicit testnet note.
2. Three useful summary facts: request count, submission state, and request bond.
3. A compact request-submission entry point.
4. The ledger with one status select and one search field.
5. Collapsed network and RPC details.

Rows remain dense rather than becoming a card mosaic. Each row includes request ID, title, one-line summary, status/category, net signal, support, and voter count.

All statuses remain filterable. A select is used because eleven equal-weight tabs create visual noise and poor small-screen behavior.

### Request detail

1. Request ID, category, title, status, and summary.
2. Acceptance criteria.
3. Human-readable status activity.
4. Signal totals and evidence.
5. Contextual wallet actions.

Author, heights, contract, detail digest, snapshot mechanics, bond state, and typed action records remain accessible in disclosures. Evidence and shipment attestation stay visible because they are central to the product promise.

## Primary flows

### Browse

1. Scan the current ledger.
2. Narrow by status or search.
3. Open a request.
4. Read acceptance criteria before protocol metadata.
5. Inspect signal, activity, and evidence.

The application must not invent a cross-status rank. “All statuses” presents contract request order; status-filtered results use the contract’s status-bound ranking.

### Submit

1. Connect Keplr or Leap from the header.
2. Open the compact submission form.
3. Enter title, category, summary, and required acceptance criteria.
4. Optionally disclose the supporting-reference fields.
5. Review the readable bond and exact transaction.
6. Confirm in the wallet and wait for canonical confirmation.

The form is one page. Optional digest-pinned references do not compete with the required brief.

### Review delivery

1. Read the immutable acceptance criteria.
2. Follow lifecycle activity.
3. Inspect delivery evidence and any shipment attestation.
4. Open protocol details only when provenance or exact mechanics matter.

Use “attested shipment” or “delivery attestation,” never “proof of correctness.”

### Claim a refund

The refund control appears only in request context. It is available only when the connected account is the author and the canonical bond state is refundable. The exact amount and transaction payload are shown before signing.

## Safety and transaction rules

- Reading never requires a wallet.
- Current wallet balance is never substituted for historical snapshot power.
- Voting controls remain safety-gated until typed historical voter power can be verified.
- Every enabled write re-queries canonical state before constructing the message.
- Pre-sign review names chain, sender, contract, decoded action, exact funds, and implications.
- Pending or unknown broadcasts disable repeat confirmation and direct the user to verify on chain.
- Privileged governor, steward, verifier, and builder controls are not exposed by the public application.

## Visual language

The visual direction is a restrained signal ledger:

- dark maroon/void ground and a subtle 32px coordinate grid;
- cream content and muted bone metadata;
- coral reserved for links, primary action, focus, and positive signal;
- Space Mono for IDs, statuses, heights, addresses, and transaction facts;
- hairline enclosures and small radii;
- whitespace and section order establish hierarchy before additional containers do.

Avoid dashboard mosaics, decorative charts, neon effects, large telemetry panels, and duplicated environment labels.

## Content rules

- Prefer plain labels such as “Submit a request,” “Signal,” “Evidence,” and “Network details.”
- Explain irreversible actions and funds directly.
- Do not use hype, emoji, or language implying a community mandate.
- Format canonical `ujunox` values as lossless six-decimal `JUNOX` amounts for people; retain the integer payload in exact transaction review.
- Label stale and weakly consistent RPC data without presenting it as contract failure.
- Keep testnet status explicit but do not repeat it in every section.

## Responsive behavior

- At desktop widths, the ledger uses dense columns and request detail uses a main reading column plus a rail.
- On tablet, request detail becomes one column and the rail becomes a two-panel row.
- On mobile, all content is one column, filters stack, and secondary row values receive their own lines.
- Controls have at least 44px touch targets.
- No sticky action may cover content.

## Accessibility

- Meet WCAG 2.2 AA contrast and preserve visible focus.
- Use landmarks, ordered headings, labels, buttons, and native `details`/`summary`, `select`, and search controls.
- Do not encode state or support/opposition by color alone.
- Request rows expose a complete accessible name.
- Transaction and RPC states use `status` or `alert` semantics as appropriate.
- Addresses may truncate visually but retain the full value as available text or title.
- Respect `prefers-reduced-motion`.

## Historical prototype

[`prototype/`](../../prototype/) is an unchanged visual reference with sample data. It is not the maintained information architecture, a product specification, or an application data source.
