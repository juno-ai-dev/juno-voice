# Juno Voice v1 readiness audit

Point-in-time audit: 2026-08-11. This document is not a release approval. It
separates locally demonstrated implementation properties from evidence that
requires upstream maintainers, an independent reviewer, or authorized public
chain operations.

## Definition-of-done matrix

| Requirement | Status | Current evidence or missing gate |
|---|---|---|
| Bounty and registry state machines and authority split | Locally demonstrated | Owned-contract unit, property, multitest, and cross-contract tests pass. |
| Direct test/model coverage for protocol invariants | Locally demonstrated; audit pending | `REQUIREMENTS_TRACEABILITY.md` maps each accepted workstream requirement to named tests. State-machine and allocation property tests cover accounting and single disposition; an independent review is still required to challenge completeness. |
| No unbounded contributor, voter, project, history, message, or cleanup loop | Locally demonstrated | Execute loops have hard configuration/contract bounds. List queries cap work and expose stable cursors where sparse indexes can create holes. Cleanup is capped at 100. |
| `ujuno` liability reconciliation | Locally demonstrated | Accounting identity, unsolicited-transfer isolation, failure rollback, and single-disposition tests pass. |
| Complete 72-hour multi-contributor window | Locally demonstrated | The immutable duration is 259,200 seconds and nanosecond-boundary tests pass. |
| One-height epoch voting, turnout, and epoch isolation | Locally demonstrated | Snapshot, revision, turnout boundary, failure, cleanup, and consecutive-epoch tests pass under the pinned upstream toolchain. |
| Adapter emits only capped native sends to active projects | Locally demonstrated | Typed bank-send assertions and arbitrary-allocation property tests pass; execution rechecks active status. |
| Agent Operations cannot pay, allocate, raise limits, resume, or migrate | Locally demonstrated; chain binding pending | Contract APIs and guardian tests enforce the negative authority. Deployment verification binds the reviewed Agent DAO, but no live deployment record exists. |
| Program Vault and Juno `x/gov` relationships query-confirmed | Tooling complete; chain evidence pending | Preflight verifies the actual `gov` module account. Final verification checks admins, mandatory creators, the voting module's DAO, modules, roles, and economics; its hash-bound report embeds the validated raw observations and exact check profile. No authorized deployment has produced the report. |
| Gauge changes accepted upstream and cleanly pinned | Accepted and pinned | The epoch-snapshot gauge changes were merged into `juno-ai-dev/dao-contracts:v3` by [dao-contracts#5](https://github.com/juno-ai-dev/dao-contracts/pull/5). The parent gitlink pins merge commit `6b5e4a7aa4252a0bc59b32c2c58032ed5b0a913f`; release approval still requires the signed upstream acceptance attestation. |
| Schemas and stable events cover the public API | Locally demonstrated | Owned and deployed-upstream schemas are regenerated. Successful response tests lock all 17 bounty and all 17 registry event types, plus the five new snapshot-gauge mutation actions, their exact ordered attribute keys, and nonempty wire values. Snapshot query tests cover policy/current epoch, epoch state/outcome, present and absent ballots, paged allocations, paged epochs, and sparse ballot cursors. Deployment, ten-scenario transcript, and release-evidence JSON Schemas close every required section and profile, including snapshot queries, gas observations, canary transactions, and operations rehearsals. |
| CI independently checks both workspaces and integration | Workflow complete; clean run pending | Root and upstream pinned-toolchain jobs run independently. A separate integration job depends on both, and the release-candidate job depends on all three. Authorized exact-chain scenarios have not run. |
| Deterministic clean-clone Wasm and complete release manifest | Tooling complete; evidence pending | The builder performs two recursive-clone builds and exact byte comparison. Manifest validation recomputes artifact sizes/hashes, canonical schema hashes, provenance/tool evidence, checksum listings, size listings, and exact `wasm-tools`/dual-`cosmwasm-check` identities from the referenced bytes. The container build has not run in this environment. |
| Exact-artifact `uni-7` flows and maximum gas evidence | Blocked by normative mismatch and authorization | Public `uni-7` uses `ujunox`, while both v1 contracts and deployment validation require exact `ujuno`. No authorized deployment/gas packet exists. |
| Independent review with no unresolved critical/high findings | Blocked externally | Audit report, attestation, and finding dispositions are release-gate inputs and do not exist. |
| Deployment, monitoring, pause, recovery, and submodule runbooks | Locally demonstrated; rehearsal pending | Six content-bound runbooks exist and the release gate requires each operational section. Mutable deployment state is explicitly kept outside the clean source checkout. Six public-testnet operational rehearsals and independent operations review remain external evidence gates. |
| No out-of-scope frontend/mainnet/funding/migration work | Satisfied | No frontend, mainnet deployment, funding transfer, or prototype migration was performed. |

## Local verification snapshot

- Root workspace: 138 Rust tests pass; formatting and clippy with warnings
  denied pass under Rust 1.85.1.
- Upstream gauge package: 90 tests pass; affected gauge-package clippy with
  warnings denied passes under Rust 1.81.0.
- A fresh full-upstream-workspace attempt reached `osmosis-test-tube` and could
  not build because this container has no `libclang`. The checked-in CI job
  installs `libclang-dev`; the affected gauge suite above completed locally.
  The deterministic release-candidate job separately installs the same native
  dependency because GitHub jobs do not share runner packages.
- Deployment, integration, and release Python discovery commands pass. Their
  displayed counts are 17, 21, and 59 respectively; integration and release
  include imported deployment fixtures, so the counts are not summed as unique
  tests.
- Build-manifest generator discovery runs 3 direct tests covering artifact,
  schema, exact validator-identity, and immutable source-commit binding.
- The deployment JSON Schema now closes and fully specifies every authority,
  limit, artifact, composition, economics, and tranche section instead of
  accepting six opaque objects. A structural parity test binds its required
  keys and immutable limits to the authoritative deployment fixture.
- Transcript and release schemas now close exact artifact/address maps, all ten
  scenario IDs, seven gas cases, the signed gas report, the payload-bound final
  decision, six runbooks and rehearsals, snapshot evidence, audit findings,
  canaries, and sign-off. Their parity tests bind those sets to the authoritative
  validator constants.
- Owned-contract response regressions execute every one of the 34 distinct
  bounty and registry mutation event types. They freeze each exact event name
  and ordered attribute-key set and reject empty wire values; the exercise also
  covers role, metadata, curator, bounty-contract, and economic updates.
- Snapshot-gauge response regressions freeze the complete ordered attributes
  for policy update, epoch open, ballot placement/removal, each terminal
  execution outcome, and every cleanup phase. Public-query regressions exercise
  current policy/epoch, epoch state, present/absent ballots, allocation pages,
  terminal outcome, and epoch pages without reading storage directly.
- Two isolated native builds from the current source bytes produced identical
  copies of all five required Wasm artifacts. `wasm-tools`, both compatible
  `cosmwasm-check` generations, and the repository size/export validator pass.
  This is compilation/repeatability preflight evidence, not the still-required
  clean recursive-clone build in the digest-pinned optimizer image. A Docker
  client is present, but the current environment is denied access to
  `/var/run/docker.sock`, so it cannot run that build.
- Deployment restart state is durably journaled, sequence-validated, and locked
  against concurrent broadcasters. Every fresh, pending, or crash-recovered
  instantiation is fully query-reconciled before completion.
- Scenario transcripts use exact named proof profiles linked to captured query,
  balance, transaction, message, and event data. The validator enforces positive
  payout/refund deltas, unchanged no-distribution balances, nonzero rejected
  resume codes, proof-specific verified contract/query/response semantics and
  cross-proof IDs, exact contract/event/action attribute sets for positive
  event proofs, transfer scans bound to the same addresses as
  unchanged-balance proofs, full absence-scan transaction coverage, and
  cross-packet transaction uniqueness. CosmWasm execute destinations must be
  verified deployment or Agent Operations addresses. Captured message, event,
  and attribute objects have required typed structure.
- Snapshot evidence now carries six hash-bound historical power queries against
  the verified voting module plus full native staking transaction captures. It
  proves the first epoch's voter and total power are identical before and after
  the recorded intervening changes, reconciles their signed native amounts to
  the later voter-power delta, and proves a historical query succeeds after the
  required retention interval.
- A read-only release capture companion reuses the scenario harness's raw
  transaction and exact-height query normalization for snapshot changes,
  historical queries, canaries, and rehearsal transaction sets. It refuses
  in-checkout or existing outputs, performs initial denom/message/code-profile
  checks, and its generated fragments round-trip through the complete release
  validator in tests.
- Every gas record now binds the verified contract, exact maximum-sized request,
  full hash-checked response and byte count, and either the maximum returned
  collection or the maximum cleanup event. The gas report is no longer an
  opaque file: it binds the canonical seven-record hash, exact source/config,
  safety margin, methodology, distinct measurer/reviewer roles, and two
  payload-bound signatures. Canary records bind full successful
  transaction captures, exact gauge distribution events, post-execution epoch
  queries, and Program Vault native transfers summing to the declared value.
- Operational readiness cannot pass on runbook filenames alone: required
  sections are checked, all six recovery/response rehearsals need complete raw
  transaction captures with case-specific success/rejection profiles, and the
  release operations signer must be the separate rehearsal reviewer.
- The security gate parses the signed attestation itself and requires it to bind
  the independent reviewer, both audited commits, report hash, zero critical/high
  counts, the exact lower-finding set, timestamp, and signature record.
- Upstream acceptance likewise requires a signed attestation binding the
  repository, immutable commit, review URL, acceptor, and timestamp. The canary
  and final release decisions are parsed signed records; the latter binds a
  canonical hash covering the entire reviewed packet except its own file
  reference, every named report hash, exact testnet-only authority, and every
  required signer. Each signature binds the same decision payload hash while
  production remains explicitly unauthorized. Decision preparation first runs
  the complete semantic evidence gate with only the pending decision omitted.
- Regenerated public schemas include the snapshot-gauge API and explicit sparse
  pagination cursors.
- `REQUIREMENTS_TRACEABILITY.md` records the direct named test for each local
  acceptance group and the exact hard bound for every collection traversal.
- Parent and submodule `git diff --check` pass.

These checks do not substitute for the clean recursive-clone container build,
upstream acceptance, independent security review, or public-chain evidence.

## Blocking denomination decision

The Cosmos chain registry's current live `uni-7` entry lists `ujunox` for both
staking and fees, and no usable native `ujuno` supply has been identified. The
current contracts reject any instantiate denomination other than `ujuno`, and
deployment preflight correctly rejects the chain before upload. Therefore the
exact current artifact cannot execute the required economic scenarios on that
network. The registry record is
`testnets/junotestnet/chain.json` in `cosmos/chain-registry`.

One normative condition must change before exact-artifact testnet work:

1. Recommended: make the native denomination immutable per instance, deploy the
   same Wasm with `ujunox` on `uni-7`, and retain `ujuno` for mainnet.
2. Use another Juno v30-compatible public testnet whose actual native
   denomination is `ujuno` and change the named testnet requirement.
3. Remove or replace the exact public-`uni-7` evidence requirement.

No denomination behavior has been changed without scope-owner approval.

## External completion sequence

1. Resolve the denomination decision.
2. Push the pinned gauge commit, obtain upstream acceptance, and record the
   immutable accepted commit and review attestation.
3. Run the pinned two-clone deterministic build and publish exact artifacts.
4. Complete independent security review and disposition findings.
5. Obtain deployment authority, bind a reviewed Agent Operations DAO, and run
   preflight, plan review, deployment, and final verification.
6. Run all ten exact-artifact scenarios, snapshot/staking-change checks, and
   seven configured-maximum gas cases.
7. Complete six operational rehearsals, two positive low-value distribution
   canary epochs, and multi-role sign-off, then generate the testnet-only
   release manifest.
