# Release evidence

## Current mainnet application release

The operational checklist for the current public mainnet application is
[`docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md`](../docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md).
It records the production URL, deployed identities and checksums, dynamic web
commit and funding checkpoints, bounded user trial, explicit approval boundary,
pending/unknown transaction and RPC recovery, stop criteria, rollback, support
triage, and final evidence packet.

The Program Vault must be treated as unfunded unless a fresh authoritative
`juno-1` query proves otherwise; the 2026-08-12 read-only observation was
`0 ujuno`. Issue #37 funding and epoch rehearsal are not complete. Agent funds
must not be used. Proposal preparation, proposal submission, deposit, signing,
broadcast, and every follow-up transaction require separate approvals. Release
documentation and read-only evidence do not authorize any of those actions.

## Historical testnet evidence tooling

The remainder of this document describes the earlier exact-artifact `uni-7`
evidence packet and remains as historical tooling documentation. It does not
describe the current product deployment and does not establish current mainnet
funding, availability, or epoch rehearsal.

`REQUIREMENTS_TRACEABILITY.md` maps each goal workstream and hard work bound to
its direct test or external completion gate. `READINESS_AUDIT.md` is the concise
point-in-time status summary.

`release_manifest.py` is the final fail-closed evidence gate. It does not create
or accept placeholder attestations. A valid packet must bind the deterministic
build, verified deployment, accepted upstream commit, independent audit, all ten
exact-artifact `uni-7` scenarios, snapshot behavior/retention, seven configured
maximum gas cases, six operational runbooks, two canary epochs, and multi-role
sign-off. Signed upstream and security attestations bind the accepted review,
both audited commits, report hash, reviewers, finding set, timestamps, and
signature records. Snapshot evidence includes full successful native staking
transactions whose signed amount reconciles to the later voter-power change,
six hash-bound historical voter/total power queries, and a successful query
after the required retention window. Gas evidence binds each
case to the verified contract, exact maximum-sized request, full response, and
observed maximum collection or cleanup event. Its closed gas report binds the
canonical seven-record array, source commits, configuration, safety margin,
methodology, distinct measurer/reviewer identities, and both traceability
declarations to one recomputed payload hash. These declarations are not
cryptographically authenticated and cannot authorize release. Canary evidence binds full
transaction responses, stable distribution events, post-execution epoch state,
and the exact native transfer total. Canary governance and final release
decisions are structured signed records that bind scope, source, transactions,
evidence hashes, and signers. The final decision additionally commits to a
canonical hash of the complete reviewed packet except its own file reference;
each maintainer, security reviewer, and operations reviewer declaration names the
same recomputed decision payload hash. Those declarations are unauthenticated;
release authority comes only from the separately verified SSHSIG authorization
record. Required runbook sections and six distinct
operator rehearsals—with full raw transaction coverage and required
success/rejection profiles—are checked before the operations reviewer may sign
off.

The gate recomputes artifact, schema, build-evidence, transcript, and report
hashes from repository bytes. Deployment verification must contain the complete
expected check profile and the exact validated contract/query observations.
RPC responses and transaction/event captures are observations supplied by the
configured endpoint, not independently authenticated chain proofs. Scenario
assertions must use the required named evidence profiles and resolve to
captured query, balance, transaction, message, or event data; self-reported
actual values are rejected.

## Capture release-only records

`capture_release_evidence.py` is a read-only companion to the ten-scenario
harness. It retrieves indexed transactions and exact-height smart queries and
normalizes them into release packet fragments. It does not broadcast, access a
keyring, choose assertions, or approve evidence. Each output must be a new file
outside the checkout, and the final release validator independently rechecks
the raw response, hashes, configured addresses, native denomination, event
semantics, and cross-record chronology.

Capture a native staking change and a named historical-power observation:

```sh
python3 release/capture_release_evidence.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/delegate.json \
  staking-change --tx-hash "$TX_HASH" --kind delegate --voter "$VOTER"

python3 release/capture_release_evidence.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/first-total-after.json \
  smart-query --contract voting_module --query-file /secure-work/query.json \
  --height 123456 --name first_total_after_change
```

The staking command accepts only one successful native
delegate/undelegate/redelegate message for the declared voter. The optional
smart-query name makes its output directly usable in the snapshot historical
query list; the release gate still enforces the six exact required names and
their before/after ordering.

Capture one completed canary epoch and the complete transaction set for a
rehearsal case:

```sh
python3 release/capture_release_evidence.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/canary-7.json \
  canary-epoch --tx-hash "$TX_HASH" --gauge-id 0 --epoch-id 7 \
  --snapshot-height 123400 --distributed-value 1000 --query-height 123460

python3 release/capture_release_evidence.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/adapter-failure-transactions.json \
  rehearsal-transactions --case adapter_failure \
  --transaction "${SUCCESS_TX}:0" --transaction "${REJECTED_TX}:5"
```

Canary capture combines the successful execution with the post-execution epoch
query. Rehearsal capture checks the case's required successful/rejected action
profile. Operators add these fragments to the reviewed reports and evidence
packet; capture alone does not establish that a canary or rehearsal passed.

## Finalize the gas report

Keep the seven measurements in an external JSON object containing exactly
`safety_margin_bps` and `measurements`. After the target-chain observations are
complete, prepare the immutable payload that the measurer and independent
reviewer will declare they reviewed:

```sh
python3 release/gas_report.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/gas-report-payload.json \
  prepare --gas-input /secure-work/juno-voice/uni-7/gas-input.json \
  --measured-by testnet-gas-operator \
  --reviewed-by independent-gas-reviewer \
  --measured-at 2026-08-05T00:00:00Z \
  --reviewed-at 2026-08-05T01:00:00Z \
  --methodology "target-chain configured-maximum instrumentation"
```

The tool creates no signature and holds no signing key. Each party supplies an
explicitly unauthenticated traceability declaration for the payload's
`signed_payload_sha256`, as a JSON record with
exactly `identity`, `payload_sha256`, `method`, and `value`. Finalize into a
different new external file:

```sh
python3 release/gas_report.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/gas-report.json \
  finalize \
  --payload /secure-work/juno-voice/uni-7/gas-report-payload.json \
  --declaration /secure-work/juno-voice/uni-7/measurer-declaration.json \
  --declaration /secure-work/juno-voice/uni-7/reviewer-declaration.json
```

Copy only the finalized report into the reviewed evidence packet and bind its
file hash. `gas-report.schema.json` closes the on-disk shape. The release gate
recomputes both the measurement-array hash and reviewed payload hash, requires
the configured source and margin, and requires distinct declared parties. A
declaration provides traceability only. It is neither authenticated nor an
authorization record.

## Finalize the release decision

After every other evidence file and file hash is fixed, prepare the four-party
decision payload. The candidate evidence JSON may omit only
`release_signoff.decision` during this preparation step because that
self-reference is deliberately excluded from the canonical review hash. Before
writing a payload, the command runs the authoritative evidence validator over
every other section and refuses an invalid build, deployment, scenario,
snapshot, gas record/report, canary, runbook, or rehearsal:

```sh
python3 release/release_decision.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/release-decision-payload.json \
  prepare --evidence /secure-work/juno-voice/uni-7/evidence-candidate.json \
  --decided-at 2026-08-05T02:00:00Z
```

Every declared maintainer, security reviewer, and operations reviewer supplies
an unauthenticated declaration for the resulting `signed_payload_sha256`. Each
declaration file contains exactly `identity`, `payload_sha256`, `method`, and
`value`. Separately, the release authority signs the hash plus a trailing newline
using `ssh-keygen -Y sign` and namespace `juno-voice-release-v1`. Put that armored
SSHSIG in an authorization JSON object containing exactly `identity`,
`payload_sha256`, `method` (`sshsig`), `namespace`
(`juno-voice-release-v1`), and `signature`. Finalize with one `--declaration`
argument per reviewer, the authorization record, and an explicit trusted
OpenSSH allowed-signers file. Independently supply the exact principal expected
to authorize this release; it must match the record identity and is passed to
`ssh-keygen -Y verify`:

```sh
python3 release/release_decision.py \
  --config deployment/environments/uni-7.json \
  --output /secure-work/juno-voice/uni-7/release-decision.json \
  finalize \
  --payload /secure-work/juno-voice/uni-7/release-decision-payload.json \
  --declaration /secure-work/juno-voice/uni-7/maintainer-one.json \
  --declaration /secure-work/juno-voice/uni-7/maintainer-two.json \
  --declaration /secure-work/juno-voice/uni-7/security-reviewer.json \
  --declaration /secure-work/juno-voice/uni-7/operations-reviewer.json \
  --authorization /secure-work/juno-voice/uni-7/release-authorization.json \
  --allowed-signers /secure-work/juno-voice/release-trusted-signers \
  --authorization-principal release-authority
```

Copy the finalized decision into the packet, add its final file reference to
`release_signoff.decision`, and run the complete validator. The closed
`release-decision.schema.json` documents the final shape. Changing the order or
contents of any reviewed evidence after preparation invalidates the decision,
even if every individual record still passes its semantic checks. The assembler
does not hold signing keys. It fails closed unless `ssh-keygen -Y verify`
authenticates the authorization identity against the explicitly supplied trust
root; arbitrary declaration values cannot authorize a release.

Validate a checked-in evidence packet:

```sh
python3 release/release_manifest.py validate-evidence \
  --config deployment/environments/uni-7.json \
  --evidence release/evidence/uni-7-v1.json \
  --allowed-signers /secure-work/juno-voice/release-trusted-signers \
  --authorization-principal release-authority
```

Generate the immutable testnet-candidate manifest only after deployment
verification and every external gate are complete:

```sh
python3 release/release_manifest.py generate \
  --config deployment/environments/uni-7.json \
  --state /secure-work/juno-voice/uni-7/state.json \
  --verification deployment/evidence/uni-7-verification.json \
  --build artifacts/v1/build-manifest.json \
  --evidence release/evidence/uni-7-v1.json \
  --allowed-signers /secure-work/juno-voice/release-trusted-signers \
  --authorization-principal release-authority \
  --output artifacts/v1/release-manifest.json
```

Generation requires a clean checkout, a clean accepted submodule pin, exact
local artifact bytes, a complete deployment state, and a verification report
whose hash is already recorded in that state. The output explicitly sets
`production_authorized` to false. Mainnet upload, live administrators, or a
community-pool tranche remain separate governance actions.
