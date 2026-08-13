# Juno Voice v2 remediation readiness audit

**Assessment date:** 2026-08-12

**Overall status:** source remediation candidate; not release-ready and not
authorized for funded use.

The implementation and local gates cover the five audit findings and the new
fresh-deployment boundary. The implementation team's explicit candidate
dispositions are recorded in `audit/REMEDIATION_DISPOSITION.md`; they do not
constitute independent closure. Completion still requires an accepted immutable
upstream commit, clean deterministic artifacts, target-chain evidence,
independent security review, authorized fresh deployment, signed manifests, and
a reconciled low-value canary.

## Definition-of-done matrix

| Requirement | Status | Current evidence / remaining gate |
|---|---|---|
| JV-01 partial-ballot denominator and retained accounting | Locally demonstrated | Gauge tests use participating power independently from allocated power, preserve retained-option and unallocated power, and reconcile emitted plus retained value. Upstream acceptance and chain evidence remain open. |
| JV-02 fully funded opening and bounded terminal liveness | Locally demonstrated | Open checks the full fixed budget; execution requires only emitted value; insufficient funds, expiry, and governor abort are terminal and tested. Live funded/underfunded/expired/aborted transcripts remain open. |
| JV-03 registry-assigned numeric identity | Locally demonstrated | Numeric monotonic IDs, canonical `project:<id>` options, chain-execution ordering, failure rollback, pagination, typed responses, and loud rejection of legacy caller-chosen IDs are covered locally. Fresh-chain registration/graduation evidence remains open. |
| JV-04 source-namespaced graduation replay | Locally demonstrated | Provenance and replay keys bind source contract plus bounty ID; source replacement behavior is tested. Live rotation evidence remains open. |
| JV-05 bond/status invariant | Locally demonstrated | Shared transition validation and regression/property coverage reject active or suspended bonded projects without deposited backing. Operational transition-table evidence and independent review remain open. |
| Atomic bounty graduation handshake | Locally demonstrated | Reply-on-success records only the typed registry-assigned ID; malformed data, submessage failure, replay, and rollback are tested. Independent review remains open. |
| Schemas, clients, monitoring, and runbooks | Candidate updated | Owned/gauge schemas, browser parsing/actions, deployment configuration, release semantics, monitoring, and recovery documentation reflect v2. All five composition schemas regenerate byte-for-byte under the declared Rust 1.85.1/1.81.0 toolchains. A final schema diff against reviewed release commits is still required. |
| Fresh deployment; no v1 import | Tooling demonstrated | Deployment configuration uses v2 salts/labels and requires retained option plus execution window. Client production builds have no v1 defaults and require five verified v2 identities. Authorized rehearsal and mainnet deployment remain open. |
| Deterministic exact artifacts | Open | All five contracts compile to Wasm with the declared Rust toolchains. A dirty-tree diagnostic optimization passes Wasm validation, both required `cosmwasm-check` versions, and the size/export allowlist. It did not use the digest-pinned optimizer image or clean recursive clones, so no release checksums or deterministic artifacts are claimed. |
| Testnet scenarios and maximum gas | Open | Validators are present. No authorized exact-artifact target-chain packet exists for the v2 candidate. |
| Independent remediation review | Open | The implementer-authored candidate disposition does not close the audit. A distinct reviewer must accept or revise JV-01 through JV-05 and retained-option/top-N and expiry decisions with no unresolved critical/high finding. |
| Mainnet verification and canary | Open | No v2 code IDs, addresses, checksums, query-back report, signed release manifest, or authorized canary exists. |

## Local verification snapshot

The current working tree has passed:

- root Rust formatting, strict clippy, and locked workspace tests: 149 tests;
- affected upstream gauge/interface/adapter crates: 150 locked tests, formatting,
  and strict no-dependency clippy;
- complete locked upstream workspace tests: 1,350 passed and 10 ignored;
- byte-for-byte schema regeneration for the two root contracts and three
  upstream composition contracts under Rust 1.85.1 and 1.81.0 respectively;
- diagnostic current-tree Wasm builds for all five composition contracts under
  those exact Rust toolchains. Binaryen 132 optimization produced artifacts of
  561,434, 481,790, 498,188, 175,910, and 676,970 bytes for bounty, registry,
  DAO core, Juno staking, and gauge respectively; all passed the exact export
  allowlist and `wasm-tools 1.254.0`, all five passed `cosmwasm-check 3.0.4`,
  and the three CosmWasm 1.x artifacts passed `cosmwasm-check 1.5.11`;
- browser lint and typecheck, 370 Vitest tests, 5 Node policy tests, 9 packaged
  Chromium smoke tests, and both dependency audits with zero vulnerabilities;
- deployment validation: 22 tests;
- root integration discovery: 26 tests;
- release evidence/decision validation: 74 tests; and
- deterministic build-script unit tests: 3 tests.

The complete upstream workspace test command passed locally with the current
stable toolchain. The local aarch64 environment required a temporary libclang
18.1.1 wheel, explicit GCC/system header search paths for bindgen, and
`CARGO_BUILD_JOBS=1` to keep the test-tube build within available memory. Those
process-only accommodations did not modify repository dependencies or toolchain
pins. This does not waive the clean pinned upstream workspace CI gate.

The Wasm results are deliberately diagnostic. Binaryen 132 was run from a
temporary package rather than the digest-pinned optimizer image, and the dirty
working trees were not reconstructed twice from clean recursive clones. Their
hashes are therefore not release identities. The clean deterministic build,
byte comparison, and final checksum manifest remain open.

These results are working-tree evidence, not immutable release evidence. The
root contains uncommitted remediation changes and the submodule contains an
unaccepted dirty upstream patch. Final verification must run from clean,
reviewed commits.

## Fresh-deployment boundary

The v2 release intentionally has no migration or import entrypoint. Deployment
must use new salts, code identities, and addresses; query the historical v1
system immediately before cutover; and stop if any unexpected bounty, project,
epoch, liability, or balance exists. It must then prove the v2 system starts
empty with initial counters and no open epoch.

The browser client is also cutover-gated. Production startup/build requires:

- `VITE_PROTOCOL_VERSION=v2`;
- address, Code ID, and Wasm checksum for bounty, registry, Program Vault,
  voting module, and gauge;
- distinct valid Juno contract addresses; and
- an exact release commit.

Transaction intents and the central signer allowlist use those injected
identities. The historical v1 values survive only in captured test fixtures and
cannot become production defaults accidentally. The manually dispatched Pages
packaging job reads the eventual v2 identities from protected repository
variables and fails before upload when any value is absent or malformed. Pushes
to `main` cannot deploy during remediation.

## Target-chain evidence blocker

No exact-artifact v2 testnet deployment is authorized. The historical `uni-7`
configuration is not automatically reusable: the Cosmos chain registry records
`ujunox`, while the current contracts and deployment policy require `ujuno`.
The scope owner must select a Juno-compatible network with the required native
denomination or explicitly approve a denomination-policy change. Do not weaken
the validator or relabel `ujunox` as `ujuno`.

The selected target must capture at least:

- funded, partial, retained-only, underfunded, expired, and aborted epochs;
- emitted/retained reconciliation and unchanged balances for no-send outcomes;
- numeric ID assignment through bonded registration and bounty graduation;
- bounty-source rotation with namespaced replay behavior;
- the complete operational bond transition table;
- fresh deployment emptiness and old/new address separation; and
- configured-maximum gas for ballots, options, selection, instantiation,
  execution, cleanup, and queries.

## External completion sequence

1. Land the gauge patch in its upstream repository, obtain independent review,
   and advance the submodule to the accepted immutable commit.
2. Commit and review the root changes; run both full locked workspaces and all
   schema-diff gates in a clean recursive clone.
3. Produce reproducible optimized `artifacts/v2` bytes, Wasm validation, and a
   signed build manifest bound to exact source commits.
4. Select and authorize a compatible testnet; run the required scenarios, gas
   cases, operational rehearsals, and deployment/cutover rehearsal.
5. Complete independent remediation review and resolve every critical/high
   finding.
6. Obtain separate deployment authority, perform the fresh mainnet deployment,
   query back every identity/config/empty-state invariant, and publish the signed
   v2 release manifest.
7. Configure the client from that verified manifest, perform the explicit
   frontend cutover, and reverify the public artifact.
8. Only after all pre-canary gates pass, obtain separate authorization for one
   tightly capped canary and reconcile it before any larger funding decision.

No item in this audit authorizes uploading code, changing governance state,
funding a Vault, opening an epoch, or deploying the frontend.
