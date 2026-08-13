# dao-contracts submodule update runbook

Gauge changes are authored, reviewed, tested, and committed in the upstream
`dao-contracts` repository. A dirty submodule, local-only commit, or moving
branch is never a release input.

## Upstream acceptance

1. Open the upstream change from the current pinned base. Include snapshot-mode
   schemas, fresh-instantiation compatibility, hook regressions, package checks, Rust
   1.81 host/Wasm checks, size/export/capability validation, and review evidence.
2. Wait for upstream acceptance and an immutable commit reachable from the
   reviewed repository. Record the review URL and accepted commit.

## Pin advancement and verification

1. In a clean Juno Voice checkout, fetch that commit and advance only the
   `deps/dao-contracts` gitlink. Do not add its packages to the root workspace.
2. Run upstream full workspace tests and gauge package/release checks from the
   submodule. Run root tests, planner tests, schema checks, and exact-artifact
   integration against the new pin.
3. Review `git diff --submodule=log`, confirm the submodule has no local changes,
   and confirm `git submodule status --recursive` has no `+`, `-`, or `U` prefix.

## Release evidence

1. Rebuild all release artifacts twice from clean recursive clones. Update the
   build manifest, environment config, audit scope, and testnet evidence; old
   code IDs and addresses remain historical records.

Never advance the parent gitlink merely to point at an unreviewed local
implementation. Never force-push or retag an accepted dependency commit.
