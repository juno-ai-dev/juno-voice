# Release runbook

## Current public application

For the deployed `juno-1` product, use the
[mainnet user-trial and release runbook](../../docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md).
Its per-release record is authoritative for the exact production URL and web
commit, deployed contracts/checksums, live funding checkpoint, limitations,
approval gates, support recovery, stop conditions, and web rollback. The
Program Vault remains unfunded unless a fresh authoritative query proves
otherwise; no issue #37 funding or epoch rehearsal is claimed complete.

## Historical candidate construction

The candidate/evidence process below documents the earlier testnet release
pipeline. References to `uni-7`, canaries, and prototype exclusion are retained
as history, not as claims about the current mainnet application.

### Candidate construction

From a clean checkout with a clean, accepted submodule pin, run
`scripts/build-release.sh`. It clones the repository recursively twice, checks
schema regeneration, builds the two owned contracts with Rust 1.85.1 and the
three upstream components with Rust 1.81.0 in the digest-pinned optimizer,
compares every byte, and validates every Wasm. The v1 manifest never includes
the prototype `juno_voice.wasm`.

Review `build-tools.txt`, `build-provenance.txt`, sizes, checksums, and
`build-manifest.json`. Any byte difference, schema diff, floating dependency,
dirty source, gitlink mismatch, unexpected export/capability, or validator
failure rejects the candidate.

### Evidence gates

A testnet release candidate requires all of the following bound to the exact
build and deployment config:

- accepted upstream review and clean gitlink;
- independent security review of bounty, registry, and changed gauge paths,
  with no unresolved critical/high finding;
- verified `uni-7` code IDs, addresses, admins, roles, and module relationships;
- all ten end-to-end scenarios with final balances/states/events;
- historical staking changes across EndBlock and two distinct fixed epochs;
- observed snapshot activation, retention, and liquid-staking power basis;
- maximum-bound gas/response evidence for contributors, projects, options,
  messages, pagination/history, and cleanup, plus the finalized gas report
  with unauthenticated declarations over one canonical payload hash by a
  distinct measurer and reviewer;
- monitoring and recovery rehearsal; and
- two low-value canary epochs followed by an explicit governance decision.

Evidence documents are content-hashed. A prose placeholder, local multitest,
mock adapter/DAO, unindexed transaction, or transaction against different code
does not satisfy a gate.

Prepare and finalize the gas report with `release/gas_report.py` as documented
in `release/README.md`. The tool never signs: both external declarations
must bind the prepared `signed_payload_sha256`, and final release validation
recomputes that hash and the hash of the seven measurement records.

Once every other record is immutable, prepare and finalize the release decision
with `release/release_decision.py`. All release reviewers make unauthenticated
declarations over the same payload hash; a separately trusted release authority
authorizes it with SSHSIG. Its canonical reviewed-evidence hash covers the packet
except the decision's own file reference, avoiding a hash cycle without leaving
scenario, snapshot, canary, rehearsal, or runbook evidence unbound. Preparation
first runs the complete semantic gate with only the not-yet-created decision
omitted, so an invalid candidate never reaches the declaration/authorization step.

### Authorization boundary

The resulting packet authorizes, at most, the reviewed public-testnet/canary
scope stated in its decision record. Mainnet upload, live admin assignment,
community-pool transfer, recurring tranche, migration, or prototype-state use
requires separate explicit authorization. Retain rejected artifacts and partial
deployments as historical records; do not overwrite their manifests.
