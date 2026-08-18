# Juno Voice

**A public market for work the Juno community wants to fund.**

Juno Voice combines social bounties with stake-weighted Hack Juno incentives:

> `request → fund → deliver → ratify → graduate → incentivize`

Anyone can publish a bounded bounty and other accounts can contribute. Bounty
contributors control settlement. Graduated projects and registered projects can
participate in recurring gauge epochs in which Juno stakers direct a fixed
budget using historical voting power.

## Security and release status

Juno Voice v2 is deployed on Juno mainnet at the deterministic addresses below.
The deployment is **not authorized for funded use**: the Program Vault must
remain unfunded and no production epoch may be opened. An explicitly authorized,
tightly capped canary is the only funded epoch permitted after the pre-canary
gates in [GOAL.md](GOAL.md) have passed.

The v2 deployment started from fresh state. No prior state or funds were
imported; the bounty and project sets were empty, counters were initial, and no
epoch was open at deployment verification.

### Juno mainnet v2 identities

| Component / label | Code ID | Contract address | Wasm SHA-256 |
|---|---:|---|---|
| Juno Voice bounty / `juno-voice-v2-bounty` | `5155` | `juno1r4j8cpvd4e0t8p2hgyvnk5q2s2y8dpqd99ltymtkq99qq2j40waqph80dh` | `2d8265a9ce58d1057da3cea3b06c80d8dd89acf066e44073dd09008b3cd44ffa` |
| Hack Juno registry adapter / `juno-voice-v2-registry` | `5156` | `juno1f55krdtt936k9d5vel043gpe4axqyq7ysgk59j25ev0lxlzwkvxqsswx4t` | `513aa9264013e29c18007a85818ccfdbb1f3c4177d58cb4e13d9af3ae9d42a6a` |
| Program Vault / `juno-voice-v2-vault` | `5157` | `juno178famzzydmmyuqteu5g0vdhkrw53r6zatud5ap55xn7a95jeakssqjh8wt` | `3600206880f8f24ab867aac6b17b844b16a7b58712c5ca336a076bc13c98f2c0` |
| Juno-staked voting module / `juno-voice-v2-voting` | `5158` | `juno1w0spzqef0ypkv8v56jwmvewju63xarn5x6v3wy0wee49yu6r9z6s6a35sr` | `1a08d78f7364ba461253a6cf71ea00d35600906a065d49702bd87ba210adacb4` |
| Epoch-snapshot gauge / `juno-voice-v2-gauge` | `5159` | `juno1cprm2juuadkrx9rpy73arxgrugqkzx4d20uvpj5ww49cnp6sndcqyz525v` | `b38915a07a79104768d37b109bb7c21517441a21802fec2b7a49c3fde4ae813d` |

## What v2 changes

- Partial ballots spend only their actually allocated project share. They are
  never renormalized to exhaust the epoch budget.
- `do-not-distribute`, unallocated ballot power, exclusions, cap overflow, and
  rounding dust are retained in the Program Vault and reported separately.
- Epoch opening requires the full fixed budget. Every opened epoch has a bounded
  terminal path, including insufficient funds, public expiry, and reasoned
  governor abort.
- Project IDs are monotonically assigned numeric `u64` values. Canonical gauge
  options use `project:<id>`.
- Bounty graduation receives the assigned ID through an atomic reply handshake,
  and replay protection is scoped to `(source contract, bounty ID)`.
- Every project status change is checked against the shared bond invariant.

The normative sources are:

- [Security remediation goal](GOAL.md)
- [Security audit](audit/SECURITY_AUDIT.md)
- [Backend architecture](docs/architecture/ARCHITECTURE.md)
- [Security remediation ADR](docs/architecture/decisions/005-security-remediation-protocol.md)
- [UX contract interface freeze](docs/UX_CONTRACT_INTERFACE_FREEZE.md)
- [Incentives and governance](docs/design/INCENTIVES_AND_GOVERNANCE.md)

## Governance model

- **Juno Network governance (`x/gov`)** controls funding, upgrades, recovery,
  and the outer authority boundary.
- **Program Vault** is the treasury and execution shell administered by Juno
  governance. It does not create a second policy electorate.
- **Agent Operations DAO** performs bounded curation, project admission,
  nomination, suspension, and stop-only safety actions. It cannot release a
  multi-contributor bounty, increase a budget, resume a stopped system, or
  upgrade contracts.
- **Bounty contributors** decide whether pooled bounty escrow is paid.
- **Juno stakers** direct only the fixed Hack Juno allocation for an epoch.

## Backend composition

```text
Juno x/gov
  └─ externally administers Program Vault
       ├─ funds bounded Hack Juno epochs
       └─ authorizes upgrades, aborts, and emergency recovery

Juno Voice bounty contract
  └─ escrows contributions and atomically graduates candidates

Agent Operations DAO
  ├─ curates bounties and project applications
  ├─ graduates delivered projects
  └─ can stop or suspend, but cannot pay or resume

Project registry adapter
  └─ assigns numeric IDs and exposes bounded gauge options/payout messages

dao-voting-juno-staked + epoch-snapshot gauge
  └─ snapshots Juno stake and allocates a fully funded fixed epoch budget
```

The protocol accepts only native `ujuno`. It avoids arbitrary execution
messages, per-bounty DAOs, transferable bounty shares, and unbounded option
sets.

## Repository shape

```text
app/                    v2 browser client; production identity injected at build
contracts/              Juno Voice-owned CosmWasm contracts
deps/dao-contracts/     exact upstream DAO DAO source pin (submodule)
schema/                 preserved prototype/legacy schemas
docs/                   architecture, decisions, design, and runbooks
deployment/             guarded fresh-v2 planning and verification
integration/            exact-artifact scenario capture and validation
release/                release evidence, readiness, and decision gates
scripts/                deterministic build and Wasm validation
```

[`deps/dao-contracts`](deps/dao-contracts) is an independent Git submodule and
is intentionally not a member of the root Cargo workspace. The repositories use
different CosmWasm dependency generations and produce independent artifacts.
Gauge changes must be accepted upstream before the root gitlink advances to the
reviewed commit.

Clone with dependencies:

```sh
git clone --recurse-submodules https://github.com/juno-ai-dev/juno-voice.git
git submodule update --init --recursive
```

## Browser client and cutover

The checked-in app implements only the v2 wire surface. Startup and production
builds fail closed unless all five v2
address/code-ID/checksum triples, `VITE_PROTOCOL_VERSION=v2`, and an exact
release commit are supplied. Transaction construction and the central signing
allowlist use the same injected bounty, registry, and gauge addresses.

The manually dispatched Pages packaging job reads the public deployment identities from repository
variables named `V2_<COMPONENT>_CONTRACT_ADDRESS`, `V2_<COMPONENT>_CODE_ID`, and
`V2_<COMPONENT>_CODE_CHECKSUM`, where component is `BOUNTY`, `REGISTRY`, `VAULT`,
`VOTING`, or `GAUGE`. Missing, malformed, duplicate, or non-v2 configuration
stops the build before an artifact is uploaded. There is no automatic push-to-
main deployment during remediation. Pull-request gates build the same v2
identity set and never publish that test artifact.

The GitHub Pages artifact is produced only by the manually dispatched v2
packaging job. The deployed contracts must remain unfunded unless the separate
funding authorization gates have passed.

## Local verification

Use Node.js 22 and the frozen lockfile:

```sh
cd app
npm ci
npm run lint
npm run typecheck
npm test
npm run audit:all
npm run audit:production
npm run test:e2e
```

`npm run build` and `npm run verify` additionally require a complete v2 build
environment. Use the identities above or identities exported from a reviewed
deployment verification. Browser
smoke tests use deterministic intercepted RPC responses and a test-only identity
fixture, so they do not prove that a live RPC or deployment is healthy.

The Rust and release gates are described in [release/README.md](release/README.md)
and [deployment/README.md](deployment/README.md). Deterministic v2 artifacts are
written below `artifacts/v2/` and validated by `scripts/validate-v2-wasm.sh`.

## License

MIT. See [LICENSE](LICENSE).
