# Juno Voice v1 deployment

> **Historical `uni-7` tooling:** this directory documents the backend release
> planner and testnet workflow used before the `juno-1` deployment. It is not the
> current mainnet trial entry point. See
> [`docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md`](../docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md).

`juno_voice_deploy.py` is the authority-preserving deployment planner for the
v1 backend. It validates one versioned configuration, checks every Wasm byte
against its declared SHA-256 digest, predicts every circularly-dependent
address with CosmWasm `instantiate2`, and emits or applies one restartable step
at a time.

Salts are configured as UTF-8 text, validated at 1–64 bytes, hashed as those
exact bytes, and passed to the Juno CLI as hex. `fix_msg` is explicitly false,
matching CosmWasm's stable message-independent address derivation.

The Program Vault is instantiated with the Juno `x/gov` module account as both
its external DAO admin and the CosmWasm code admin. Its historical Juno voting
module and snapshot gauge are instantiated by the core with explicit salts.
The gauge is the vault's sole proposal/execution module, so only its reviewed
adapter messages can reach `ExecuteProposalHook`. The registry and bounty
contracts are separate top-level `instantiate2` instances with the same code
admin. A reviewed Agent Operations DAO is bound by address and receives only
curator/stop roles.

The checked-in `config.schema.json` is for editors and external validation.
The Python validator is authoritative because it additionally verifies files,
bech32 checksums, CW2 identities, immutable constants, and cross-field economic
invariants.

Typical operator flow:

```sh
python3 deployment/juno_voice_deploy.py \
  --config deployment/environments/uni-7.json validate

python3 deployment/juno_voice_deploy.py \
  --config deployment/environments/uni-7.json preflight \
  --output /secure-work/juno-voice/uni-7/preflight.json

python3 deployment/juno_voice_deploy.py \
  --config deployment/environments/uni-7.json \
  plan --state /secure-work/juno-voice/uni-7/state.json \
  --output /secure-work/juno-voice/uni-7/plan.json

# Inspect and sign off the exact plan, then broadcast exactly one step.
python3 deployment/juno_voice_deploy.py \
  --config deployment/environments/uni-7.json \
  apply-next --state /secure-work/juno-voice/uni-7/state.json --yes

python3 deployment/juno_voice_deploy.py \
  --config deployment/environments/uni-7.json \
  verify --state /secure-work/juno-voice/uni-7/state.json \
  --output /secure-work/juno-voice/uni-7/verification.json
```

Keep mutable plan, state, preflight, and verification files outside the source
checkout; the command handlers reject mutable paths beneath the repository
root. Every invocation intentionally revalidates a clean parent and
submodule checkout; writing restart state into the repository would make the
next invocation fail closed. After deployment is complete, copy the finalized
verification and other public evidence into their checked-in evidence paths,
review them, and commit them before generating a release manifest.

`apply-next` requires a locally installed `junod` and a key name already
declared in the configuration. It does not accept an address, role, amount,
message, chain, endpoint, or key name from the command line. State is written
with a durable atomic rename, and a sibling advisory lock prevents concurrent
runners from broadcasting the same ready step. The journal accepts only the
ordered eight-step upload/instantiate profile and requires every code ID and
contract address to agree with its completion record. Re-running the command
continues with the first unrecorded step; a changed configuration, derived
address, corrupt journal, or unknown step invalidates the state instead of
silently forking the deployment. Plan and verification outputs cannot overwrite
their config or state inputs.
Immediately before any broadcast, the runner resolves the configured local key
name and requires its address to equal the configured deployer and
`instantiate2` creator.
Before either mutation or final verification, the same read-only preflight
confirms the RPC chain ID, rejects a catching-up node, and compares the live
staking bond denomination and actual `gov` module account with the exact
configuration. This prevents uploading bytes to a similarly named testnet on
which the required economic flows cannot run or governance authority is wrong.
Before uploading, the runner scans all paginated on-chain code identities for
the exact checksum. This closes the small broadcast-before-journal crash window:
an already-stored byte-identical artifact is reconciled to its code ID instead
of uploaded twice.
Before instantiation, it also probes the deterministic address. If an earlier
broadcast succeeded before its transaction hash was journaled, the runner
reconciles only after the code ID, admin, creator, voting-module DAO, and full
component configuration match the reviewed plan; any occupied mismatch stops
deployment. The same full reconciliation runs after every fresh or pending
instantiate transaction is indexed, before its journal entry becomes complete.
Synchronous CheckTx rejection codes are rejected before a pending hash is
recorded.

`verify` is read-only with respect to the chain. It rechecks all code hashes,
admins, creators, module links, disclosed Agent DAO membership/threshold, roles,
limits, snapshot policy, and adapter economics. Its content-bound report embeds
the exact contract-info and smart-query observations plus the complete expected
check profile, so the release gate rejects an omitted or substituted
relationship instead of trusting a generic success label.

No `uni-7.json` is checked in until the deployer, reviewed Agent Operations DAO,
current public endpoints, tranche terms, snapshot-retention observation, and
exact clean artifacts are known. A template containing placeholder authorities
would undermine the validator and is deliberately not treated as a deployable
environment.

Run the planner tests with:

```sh
python3 -m unittest discover -s deployment -p 'test_*.py'
```
