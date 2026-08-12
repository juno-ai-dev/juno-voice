# Deployment runbook

> **Historical testnet procedure:** this runbook targets the pre-mainnet
> `uni-7` deployment workflow. Do not use it as current mainnet authorization or
> release status. See
> [`MAINNET_TRIAL_RELEASE_RUNBOOK.md`](../../docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md).

## Preconditions

Deployment is a separately authorized public-chain action. Before any
broadcast, require all of the following:

- the parent checkout and `deps/dao-contracts` are clean;
- the submodule HEAD equals the parent gitlink and the accepted upstream review
  commit;
- `artifacts/v1/build-manifest.json` records two byte-identical clean recursive
  clone builds;
- every configured Wasm path hashes to its declared checksum;
- the current `uni-7` chain ID, RPC, gRPC, `ujuno` denomination, `juno` prefix,
  and Juno `x/gov` module account were independently checked;
- the bound Agent Operations DAO review records its core, voting, proposal, and
  tagged CW4-group or CW721-roles membership code IDs/checksums, exhaustive
  current membership and power, threshold, and voting duration;
- snapshot retention covers the full epoch plus the configured operational
  margin; and
- the deployer key is funded only for upload/instantiation fees and contains no
  program tranche.

Do not deploy from a template, branch name, mutable image tag, dirty checkout,
locally substituted Wasm, or config with a missing evidence value.

## Dry run

1. Run `juno_voice_deploy.py ... validate`.
2. Generate the address table with `... addresses`. Independently reproduce the
   five predictions with `junod query wasm build-address`, passing each checksum,
   creator, and hex-encoded salt with message fixing disabled.
3. Generate `... plan --state ... --output ...` and review the canonical JSON
   messages. Before code IDs exist, only the five upload steps are ready.
4. Confirm the predicted registry and bounty addresses refer to each other and
   to the predicted Program Vault. Confirm the nested voting module and gauge
   use the vault as creator.
5. Confirm the Program Vault declares exactly one proposal/execution module:
   the snapshot gauge. Its voting module must be `dao-voting-juno-staked`.
6. Archive the config and plan hashes in the change record. Two reviewers sign
   the plan before broadcast.

Use paths under `/secure-work/juno-voice/uni-7/` for mutable state, plans,
preflight reports, and the initial verification report. Do not write them into
the checkout during deployment: the planner deliberately requires clean source
and submodule trees on every restartable invocation.

## Broadcast and restart

`apply-next --yes` broadcasts one step only. It writes a `pending` transaction
hash atomically before polling and marks the step `complete` only after the
indexed transaction has code/address evidence. A state-file lock prevents two
operators from broadcasting the same step concurrently. On restart, a pending
hash is queried again and is never rebroadcast. The ordered journal rejects
unknown steps, missing upload records, mismatched code IDs/addresses, and later
steps recorded ahead of an incomplete predecessor.

After each upload, the runner queries `code-info` and compares the chain hash to
the local Wasm. Before any instantiation, it repeats all five code checks. After
each `instantiate2`, the expected contract address must be present in the
transaction events, and the runner re-queries its code ID, admin, creator, and
full configuration (including the nested voting DAO and gauge) before marking
the step complete. Stop immediately on any mismatch; do not edit state by hand
or continue with a replacement address.

The intended order is:

1. upload bounty, registry, DAO core, Juno voting, and gauge Wasm;
2. instantiate the registry with predicted bounty/vault addresses;
3. instantiate the bounty with the predicted registry/vault addresses; and
4. instantiate the Program Vault, which instantiates its salted voting module
   and sole salted gauge module in the same transaction.

No tranche funds are attached to these messages.

## Post-deployment reconciliation

Run `... verify --state ... --output ...`. The command must pass before any
test funding. It checks code IDs/checksums, code admins, creators, external DAO
admin, sole execution module, historical voting source, guardian/owner split,
all bounty and registry roles, all economic limits, and the bound Agent DAO
disclosure. The report embeds the exact validated contract-info and smart-query
responses and a complete deterministic check profile; preserve those bytes for
release evidence.

Independently query:

- `dao-dao-core` `DumpState`, `Admin`, `VotingModule`, and active modules;
- bounty `Config`, `Authorities`, `Health`, and `Pause`;
- registry `Config`, `Accounting`, `Health`, `Pause`, and `AllOptions`;
- gauge `Config`, gauge 0, health, epochs, and hooks (which must be empty); and
- CosmWasm contract info for all five instances.

Record the indexed transaction hashes, code IDs, addresses, verification report
hash, block heights, and operator/reviewer identities. A successful deploy is
not a release approval and does not authorize a community-pool transfer.
Once all deployment steps are final, copy the publishable verification report
and evidence from secure work storage into the repository, review and commit
those exact bytes, and only then run the clean-checkout release gate.

## Rollback boundary

Uploads are inert and may remain unused. A partially instantiated composition
must never be repointed by weakening authority checks. If any predicted address,
role, or module is wrong, abandon the composition, document the code IDs and
addresses, create new unique salts in a reviewed config, and redeploy. There is
no v1 state migration or prototype import path.
