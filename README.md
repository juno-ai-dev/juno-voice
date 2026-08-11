# Juno Voice

**A public market for work the Juno community wants to fund.**

Juno Voice v1 combines social bounties with stake-weighted Hack Juno incentives:

> `request → fund → deliver → ratify → graduate → incentivize`

The target system lets anyone publish a bounded bounty and lets other accounts add to it. A sole contributor confirms a payout directly within a bounded confirmation window; after that deadline or bounty expiry, anyone can finalize the nomination into refunds. When a bounty has multiple contributors, the proposed delivery enters a fixed 72-hour on-chain ratification period in which each contributor's vote is weighted by the amount they contributed. A strict majority decides: `YES > NO` pays atomically, while `NO > YES`, a tie, or no votes resets the bounty without paying the submitter.

Graduated projects and registered existing projects can participate in recurring Hack Juno gauge epochs. Juno stakers direct the epoch allocation using historical voting power from `x/voting-snapshot` through `dao-voting-juno-staked`.

## Governance model

The design deliberately separates constitutional authority, bounded operations, and individual economic rights:

- **Juno Network governance (`x/gov`)** controls program funding, upgrades, and the outer authority boundary.
- **Program Vault** is a minimal DAO DAO treasury and execution shell whose external administrator is the Juno governance module account. It does not create a second policy electorate.
- **Agent Operations DAO** performs bounded curation, project admission, nomination, suspension, and stop-only safety actions. It cannot release a multi-contributor bounty, increase a budget, resume a stopped system, or upgrade contracts.
- **Bounty contributors** exclusively decide whether their pooled bounty is paid.
- **Juno stakers** direct only the funded Hack Juno allocation for a given epoch.

This keeps routine work fast while preserving contributor custody and Juno-wide control of public funds.

## Release status

The v1 backend is **implemented locally but not yet release-approved or
deployed**. [GOAL.md](GOAL.md) defines the backend-only scope and remaining
completion gates. The detailed protocol is specified in:

- [Backend architecture](docs/architecture/ARCHITECTURE.md)
- [UX contract interface freeze](docs/UX_CONTRACT_INTERFACE_FREEZE.md)
- [Incentives and governance report](docs/design/INCENTIVES_AND_GOVERNANCE.md)
- [Product behavior](docs/design/PRODUCT_DESIGN.md)
- [Architecture decisions](docs/architecture/decisions/)

The checked-in web application and `contracts/juno-voice` are pre-release prototypes. They are not the v1 protocol specification and are not migration inputs.

## Backend composition

The v1 backend uses small contracts with narrow authority:

```text
Juno x/gov
  └─ externally administers Program Vault
       ├─ funds bounded Hack Juno epochs
       └─ authorizes upgrades and emergency recovery

Juno Voice bounty contract
  └─ escrows contributions and enforces contributor ratification

Agent Operations DAO
  ├─ curates bounties and project applications
  ├─ graduates delivered projects
  └─ can stop or suspend, but cannot pay or resume

Project registry adapter
  └─ exposes a capacity-bounded gauge option set and payout messages

dao-voting-juno-staked + epoch-snapshot gauge
  └─ snapshots Juno stake and allocates a pre-funded epoch budget
```

The first release accepts only native `ujuno`. It avoids arbitrary execution messages, per-bounty DAOs, transferable bounty shares, and unbounded option sets.

## `dao-contracts` dependency

[`deps/dao-contracts`](deps/dao-contracts) is an independent Git submodule pinned to an exact upstream commit. It supplies the reviewed DAO DAO core, Juno-staked voting module, gauge contracts, interfaces, and release tooling used by the deployment.

It is intentionally **not** a member of the root Cargo workspace. The repositories currently use different CosmWasm dependency generations and must produce independent artifacts. Gauge changes are developed upstream in `dao-contracts`; Juno Voice advances the gitlink only after accepting a specific commit. A release manifest must bind that commit to every Wasm checksum, code ID, and instantiated address.

Clone with dependencies:

```sh
git clone --recurse-submodules https://github.com/juno-ai-dev/juno-voice.git

# Existing clone
git submodule update --init --recursive
```

## Repository shape

```text
app/                    pre-release interface prototype
contracts/              Juno Voice-owned CosmWasm contracts
deps/dao-contracts/     exact upstream DAO DAO source pin (submodule)
schema/                 canonical v1 prototype-contract schema set
docs/architecture/      target architecture and decision records
docs/design/            governance report and product behavior
artifacts/               reproducible Juno Voice Wasm artifacts
prototype/              earlier interaction prototype
deployment/             validated deployment planning and runbooks
integration/            exact-artifact scenario capture and validation
release/                release evidence, readiness, and decision gates
contracts/*/schema/     canonical v1 owned-contract schemas
```

## Prototype application

The current `app/` reads a pre-release `uni-7` prototype contract directly and has no sample-data fallback. It is retained as implementation reference while the v1 backend is built. Node.js 22 and the lockfile are authoritative.

```sh
cd app
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Pinned prototype deployment:

- Chain ID: `uni-7`
- Contract: `juno1t7ajx85pkw8e0yl8vgnlxvnlq4yf0h6a3eahuystnf6e9jfhwvvsv4jcel`
- Code ID: `85`
- Code checksum: `fd264e53ae9af64231b8e62aff0da099e0ff21ba38d887c7a96d9c4ef755a96e`

## License

MIT. See [LICENSE](LICENSE).
