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

Juno Voice v1 is deployed and verified on Juno mainnet (`juno-1`). The bounty,
registry, Program Vault, Juno-staked voting module, and epoch-snapshot gauge are
live. The deployment carries no initial funds; Hack Juno allocations remain
inactive until the Program Vault receives an approved epoch budget.

### Juno mainnet deployment

Status as of 2026-08-11:

| Component | Code ID | Contract address | Status |
|---|---:|---|---|
| Juno Voice bounty | `5150` | `juno1jmngxh7kdelch3v5xu02ze2gup887v55csqns4qmxeskgy2ldl5qj494qw` | Deployed and verified |
| Hack Juno registry adapter | `5151` | `juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n` | Deployed and verified |
| Program Vault | `5152` | `juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg` | Deployed and verified |
| Juno-staked voting module | `5153` | `juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2` | Deployed and verified |
| Epoch-snapshot gauge | `5154` | `juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn` | Deployed and verified |

Verified deployment transactions:

- Registry: `9DE1E6FFEC4ED4FE8772B7EA765182C8F35DE43E84659F3B988A33171E736A1C`
- Bounty: `2D101495566FCBEE728B73029CE0013BE4638DC3394EFF60A0E169FA8E9EC127`
- Program Vault, voting module, and gauge: `4FE5DAFBF5CE653DAC2F32B4D119C2602249B3AEF7C47947CAE2DA6F240D6A6A`

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

`contracts/juno-voice` is preserved as clearly labeled pre-release history and
is not the v1 protocol specification or a migration input. The current `app/`
is the public mainnet interface for the verified deployment described below.
Operators and trial users must follow the
[mainnet user-trial and release runbook](docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md).

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
app/                    public verified mainnet application
contracts/              Juno Voice-owned CosmWasm contracts
deps/dao-contracts/     exact upstream DAO DAO source pin (submodule)
schema/                 preserved pre-release contract schema set
docs/architecture/      target architecture and decision records
docs/design/            governance report and product behavior
artifacts/               reproducible Juno Voice Wasm artifacts
prototype/              earlier interaction prototype
deployment/             validated deployment planning and runbooks
integration/            exact-artifact scenario capture and validation
release/                release evidence, readiness, and decision gates
contracts/*/schema/     canonical v1 owned-contract schemas
```

## Public mainnet application

The public application is <https://juno-ai-dev.github.io/juno-voice/>. `app/` is
pinned to chain `juno-1`, the five contracts and checksums above, and the exact
release commit displayed in the interface. Runtime reads go directly to the
configured HTTPS RPC. Invalid provenance blocks rendering, RPC failures remain
visible, and no sample-data fallback is included. Supported Keplr and Leap
wallets can prepare exact bounty, project-registry, settlement, and gauge
transactions; preparation does not sign, and every submission requires an
explicit final wallet approval. Pending or unknown outcomes remain locked
against duplicate submission.

The Program Vault is **unfunded unless a fresh authoritative mainnet balance
query proves otherwise**. The read-only query recorded on 2026-08-12 returned
`0 ujuno`. Agent funds must not be used. Governance proposal preparation,
submission, deposit, signing, broadcast, and every follow-up transaction require
separate approvals. Funding and the first epoch rehearsal in issue #37 are not
claimed complete. See the
[mainnet trial/release and recovery runbook](docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md)
before any public trial or transaction.

Node.js 22 and `app/package-lock.json` are authoritative. The local equivalent of the non-browser release gates is:

```sh
cd app
npm ci
npm run verify
npx playwright install chromium # once per machine
npm run test:e2e
# From the repository root, confirm generated/tracked inputs remain clean:
git diff --exit-code
```

`npm run verify` runs lint, typecheck, unit/component/accessibility and
production-policy tests, both a full dependency-tree audit and a production-only
dependency audit at the high-severity threshold, the Vite build, bundle budgets,
and signing-policy checks. Browser smoke builds the deployable `/juno-voice/`
Pages artifact with the exact checked-out 40-character commit, verifies its
critical requests, and uses deterministic intercepted RPC responses to exercise
provenance, transaction review/uncertainty behavior, freshness/staleness,
explicit error/retry, mismatch, and project-path hard refresh. Those tests do
not by themselves prove that a public RPC or the current deployment is healthy.

### GitHub Pages deployment

`.github/workflows/frontend.yml` is configured to build on pull requests and
`main`. Only a successful **push to `main`** can package and deploy a Pages
artifact. The artifact is rebuilt with base path `/juno-voice/` and embeds the
exact 40-character release commit; the interface displays that commit alongside
chain, contract, code, observation height, and freshness. Actions are pinned to
immutable commits, PR jobs have read-only permissions, and the deploy job alone
requests Pages/OIDC write permissions through the `github-pages` environment.
This describes the checked-in workflow, not current enforcement: as of
2026-08-12 GitHub reported no workflow runs, manual dispatch returned `Actions
has been disabled for this user`, and `main` had no branch protection. Issue #31
tracks restoration of hosted release automation.

The production URL is <https://juno-ai-dev.github.io/juno-voice/>. Each release
must still verify the Pages workflow result, final URL and hard-refresh behavior,
displayed release commit, five contract identities/checksums, and a fresh
direct-RPC observation. Follow the
[release checklist and stop criteria](docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md);
availability observed for an earlier release is not evidence for a later one.

## License

MIT. See [LICENSE](LICENSE).
