# ADR-004: Pin dao-contracts as a Git submodule

**Status:** Accepted

**Date:** 2026-08-04

## Context

Juno Voice deployment consumes exact DAO DAO core, Juno-staked voting, gauge, interface, and release-tooling source. It also requires gauge changes that should be reviewed and maintained upstream. Relying on a sibling checkout, a mutable branch, or an alpha package registry version would weaken reproducibility and make the deployment source set implicit.

The Juno Voice and `dao-contracts` workspaces currently use different CosmWasm dependency generations. Combining their package graphs would create avoidable coupling and does not help deployment.

## Decision

Include `dao-contracts` at `deps/dao-contracts` as a Git submodule using its public HTTPS remote and an exact reviewed commit.

- Do not add submodule crates to the Juno Voice root Cargo workspace.
- Build and test each workspace independently.
- Develop gauge changes upstream, then advance the parent repository's gitlink.
- Never deploy from a dirty submodule or resolve a branch at release time.
- Make CI initialize submodules explicitly.
- Bind parent commit, submodule commit, Wasm checksums, code IDs, addresses, and configuration in the deployment manifest.

## Consequences

One recursive clone contains the complete auditable deployment source and upstream tooling. Contributors must initialize and deliberately update the submodule. Cross-repository integration tests operate at schemas/artifacts or a chain harness rather than assuming a single Cargo dependency graph.
