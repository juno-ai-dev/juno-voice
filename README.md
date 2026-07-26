# Juno Voice

**The on-chain roadmap for Juno.**

Juno Voice is a public feature-prioritization system where people and agents submit requests, Juno stakers signal priorities using historical voting power, and builders attach verifiable delivery evidence.

> `suggest → prioritize → build → verify → ship`

## Maintained public application

[`app/`](app/) is the maintained React/TypeScript/Vite frontend. It is explicitly labeled **TESTNET / UNI-7** and reads authoritative data directly from the deployed CosmWasm contract without requiring a wallet. It has no sample fallback. Keplr and Leap can be used for the bounded public submit and eligible bond-refund flows; privileged controls are never rendered. Voting execution is explicitly disabled because direct typed historical voter power cannot currently be verified—current balance is never presented as snapshot power. [`prototype/`](prototype/) remains unchanged as a historical visual reference; its embedded sample rows are not application data.

Every enabled write re-queries canonical state before constructing the message, presents chain, sender, contract, decoded message, funds, and implications before signing, checks transaction code zero, and requires canonical post-transaction confirmation before reporting success. Transaction success links use Mintscan. Wallet/account or chain changes disconnect the signing session while leaving direct-RPC reading available.

Pinned live facts:

- Chain ID: `uni-7`
- Contract: `juno1t7ajx85pkw8e0yl8vgnlxvnlq4yf0h6a3eahuystnf6e9jfhwvvsv4jcel`
- Code ID: `85`
- Code checksum: `fd264e53ae9af64231b8e62aff0da099e0ff21ba38d887c7a96d9c4ef755a96e`
- RPC: `https://juno-testnet-rpc.cogwheel.zone`

### Local frontend

Node.js 22 is used by CI. The lockfile is authoritative.

```sh
cd app
npm ci                 # frozen install
npm run dev            # local Vite server
npm run lint
npm run typecheck
npm test
npm run build
npm run preview        # preview the production build
```

Copy `app/.env.example` only if an override is needed. Supported Vite variables are `VITE_CHAIN_ID`, `VITE_CONTRACT_ADDRESS`, `VITE_RPC_URL`, and `VITE_EXPLORER_URL`. Validation fails closed: chain and contract must remain the verified `uni-7` deployment, RPC must be credential-free HTTPS, and startup independently verifies chain ID, contract address, Code ID, checksum, native denom, and evidence-policy version. Overrides never introduce mainnet or sample data.

The app vendors official mark/wordmark assets and canonical tokens from [Juno Design System commit `0dc0ae9`](https://github.com/juno-ai-dev/juno-design-system/commit/0dc0ae9), with upstream MIT attribution in [`app/public/assets/ATTRIBUTION.md`](app/public/assets/ATTRIBUTION.md). Canonical `--text-muted` replaces low-contrast faint text in application semantics.

The `ALL REQUESTS` ledger exhausts ID pagination without inventing a cross-status rank. Each status filter uses its contract status code and follows opaque, filter-bound ranking cursors until `null`, including empty intermediate pages. Detail evidence, history, and actions similarly exhaust ID pagination. Because these are multiple direct RPC queries rather than an atomic indexer snapshot, the UI exposes the minimum observed query height and weak-consistency disclosure.

## Contract and documentation

The CosmWasm MVP contract passed the locked 107-test debug/release suite, independent specification/security/release reviews, deterministic artifact checks, and an exact-artifact `uni-7` smoke gate.

- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Product and interaction design](docs/design/PRODUCT_DESIGN.md)
- [Decision records](docs/architecture/decisions/)
- [Implementation plan](docs/plans/2026-07-23-mvp.md)
- [Reproducible artifact and `uni-7` smoke evidence](docs/testing/TESTNET_SMOKE.md)
- [Historical interactive prototype](https://juno-ai-dev.github.io/juno-voice/)

## Product principles

1. **Public demand, visible delivery.** Priorities and build evidence share one durable record.
2. **Power is frozen per request.** Votes use a declared historical Juno snapshot, not mutable current balances.
3. **Agents are participants, not hidden administrators.** Automation uses public interfaces and leaves evidence.
4. **Signal is not binding governance.** Juno Voice ranks work; it does not spend treasury funds or execute chain governance.
5. **Small credible loop first.** The MVP supports requests, stake-weighted support, lifecycle changes, and delivery evidence.

## Repository shape

```text
app/                   maintained uni-7 read + bounded public-write application
contracts/             Rust/CosmWasm contract workspace
schema/                checked-in canonical contract schemas
docs/                  architecture, design, plans, and testnet evidence
artifacts/              reproducible checked Wasm and checksums
prototype/             unchanged historical interaction prototype
```

## License

MIT. See [LICENSE](LICENSE).
