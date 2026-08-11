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

Juno Voice v1 is being deployed to Juno mainnet (`juno-1`) in separately
approved stages. The Wasm uploads, registry, and bounty contract are live and
verified. The Program Vault, voting module, and gauge are **not yet deployed**;
the system is therefore not operational or funded.

### Juno mainnet deployment

Status as of 2026-08-11:

| Component | Code ID | Contract address | Status |
|---|---:|---|---|
| Juno Voice bounty | `5150` | `juno1jmngxh7kdelch3v5xu02ze2gup887v55csqns4qmxeskgy2ldl5qj494qw` | Deployed and verified |
| Hack Juno registry adapter | `5151` | `juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n` | Deployed and verified |
| Program Vault | `5152` | `juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg` | Planned deterministic address; not deployed |
| Juno-staked voting module | `5153` | `juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2` | Planned deterministic address; not deployed |
| Epoch-snapshot gauge | `5154` | `juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn` | Planned deterministic address; not deployed |

Verified deployment transactions:

- Registry: `9DE1E6FFEC4ED4FE8772B7EA765182C8F35DE43E84659F3B988A33171E736A1C`
- Bounty: `2D101495566FCBEE728B73029CE0013BE4638DC3394EFF60A0E169FA8E9EC127`

The deployed contracts use the Juno governance module account
`juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730` as administrator and bind
bounded operations to the Juno Agents DAO at
`juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac`.
No funds were attached during instantiation.

The release is source-bound to Juno Voice commit
`e606d6071ff4febb2dbe4ca65165223bdfa23e54` and `dao-contracts` commit
`8f26e510dc89e56576e2dbbd35c96edb45d4b778`. Uploaded code checksums are:

| Code ID | Artifact | SHA-256 |
|---:|---|---|
| `5150` | `juno_voice_bounties.wasm` | `f05e9eaf3f90c7a5273bea3e8db8ff570b4f9192a4032472865cd4293b49bce1` |
| `5151` | `hack_juno_registry_adapter.wasm` | `1edaf206f87958e3be62225c2cdb71345b39ca07f16b74005c463bbf7c1debbf` |
| `5152` | `dao_dao_core.wasm` | `bc8b049a03496d3383376a469ccb581996238003532083895f68d4a02990a2da` |
| `5153` | `dao_voting_juno_staked.wasm` | `2f336e39f9c05ad57c972eb3a51ce58ba0afaeb5944ff337d68e67644f1dad64` |
| `5154` | `gauge_orchestrator.wasm` | `524d5728994950bccb471ed586d2726f3594157fafccd484aa3c0c3012e8794f` |

[GOAL.md](GOAL.md) defines the backend-only scope. The detailed protocol is
specified in:

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
