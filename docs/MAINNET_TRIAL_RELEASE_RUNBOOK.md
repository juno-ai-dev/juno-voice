---
name: juno-voice-mainnet-trial-release
summary: Safely release, exercise, support, stop, and evidence the public Juno Voice mainnet application.
---

# Juno Voice mainnet user-trial and release runbook

Use this runbook for a bounded public trial on Juno mainnet and for first-line
support. It is an operational checklist, not transaction authorization. Reading,
connecting a wallet, and preparing a review do not sign. **Every click on
“Recheck state, then sign” is a separate signing/broadcast gate and requires the
approval recorded beside that step.** Never retry a pending or unknown action.

## 1. Fixed release identity and dynamic release record

These identities are source-bound deployment facts. Stop if the application,
wallet review, explorer, or an independent chain query differs.

| Item | Required value |
|---|---|
| Chain / native denomination | `juno-1` / `ujuno` |
| Production URL | <https://juno-ai-dev.github.io/juno-voice/> |
| Bounty, Code ID, SHA-256 | `juno1jmngxh7kdelch3v5xu02ze2gup887v55csqns4qmxeskgy2ldl5qj494qw`, `5150`, `f05e9eaf3f90c7a5273bea3e8db8ff570b4f9192a4032472865cd4293b49bce1` |
| Registry, Code ID, SHA-256 | `juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n`, `5151`, `1edaf206f87958e3be62225c2cdb71345b39ca07f16b74005c463bbf7c1debbf` |
| Program Vault, Code ID, SHA-256 | `juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg`, `5152`, `bc8b049a03496d3383376a469ccb581996238003532083895f68d4a02990a2da` |
| Voting module, Code ID, SHA-256 | `juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2`, `5153`, `2f336e39f9c05ad57c972eb3a51ce58ba0afaeb5944ff337d68e67644f1dad64` |
| Gauge, Code ID, SHA-256 | `juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn`, `5154`, `524d5728994950bccb471ed586d2726f3594157fafccd484aa3c0c3012e8794f` |
| Deployment source commit | `e606d6071ff4febb2dbe4ca65165223bdfa23e54` |
| `dao-contracts` source commit | `8f26e510dc89e56576e2dbbd35c96edb45d4b778` |

The exact web commit is dynamic: read the 40-character **Release commit** shown
by the application and compare it with the intended merged `main` commit. On
2026-08-12, a read-only fetch of the production asset showed
`b462350313879e0a998500930d02a0574ae5995b`; this is an observation, not a
promise that the same commit is currently served. A release operator must fill
and retain this record for each release:

```text
release observed at (UTC):  [REQUIRED AT RELEASE]
production URL:             https://juno-ai-dev.github.io/juno-voice/
HTTP status / final URL:    [REQUIRED AT RELEASE]
expected merged main SHA:   [REQUIRED AT RELEASE]
commit displayed by app:    [REQUIRED AT RELEASE]
deploy workflow URL/result: [REQUIRED AT RELEASE]
RPC URL observed by app:    [REQUIRED AT RELEASE]
RPC chain / height / time:  [REQUIRED AT RELEASE]
Vault ujuno balance/height: [REQUIRED AT RELEASE]
trial approval record:      [REQUIRED BEFORE ANY SIGNATURE]
incident/support contact:   [REQUIRED BEFORE PUBLIC TRIAL]
```

### Funding status and issue #37 boundary

The Program Vault is **unfunded** unless a fresh authoritative `juno-1` bank
balance query proves otherwise. A read-only Cosmos bank REST query on 2026-08-12
returned no balances (`0 ujuno`) for the Vault. That observation does **not**
complete funding or an epoch rehearsal.

The prepared #37 target is 1,000 JUNO, but it is not approved or transferred by
this runbook. Agent funds must not be used. Governance proposal preparation,
proposal submission, deposit sourcing/deposit, signing, broadcast, and every
follow-up transaction are separate approval gates. This runbook authorizes none
of them. Do not open or execute an epoch while the Vault is unfunded, and do not
claim #37 complete until its independent evidence and approvals exist.

## 2. Prerequisites and release gates

Before inviting a trial user, the release operator records PASS and evidence for
each item:

- [ ] Intended commit is merged to `main`; production deploy completed from that
      exact commit, and the app displays the same 40-character SHA.
- [ ] Hard-refreshing the exact production URL returns the app with no redirect
      to an unexpected host and no console error.
- [ ] App provenance reports `juno-1`, the fixed contracts/code IDs above, a
      recent height, and a non-stale direct-RPC observation.
- [ ] Independent contract-info/code queries match every address, Code ID, and
      checksum above. Preserve raw responses and endpoint names.
- [ ] Bounty and registry health are fully backed; pause/stop state and any open
      gauge epoch are recorded. Vault balance is recorded, even when zero.
- [ ] Supported Keplr or Leap is installed, unlocked, set to the intended trial
      account and `juno-1`; its address and pre-trial `ujuno` balance are saved.
- [ ] Trial account is user-controlled and holds only the approved trial amount
      plus bounded fees. It is not an Agent Operations account.
- [ ] The operator and user agree to a **maximum 1 JUNO total bounty principal**
      for this run, plus a separately stated fee cap for each transaction.
- [ ] Incident contact, evidence directory, UTC clock, screen capture policy,
      browser/version, wallet/version, RPC endpoint, and stop authority are set.
- [ ] No earlier action for this account is pending/unknown in the app, wallet,
      explorer, account sequence, or incident log.

A wallet connection is permission to disclose the selected public address to
the page and to request chain access. It is not transaction approval. Reject any
wallet request to change chain, reveal a seed/private key, grant arbitrary
permissions, or sign opaque bytes.

## 3. Exact approval gates

For **every** transaction below, capture the app’s exact review before approval:

```text
approval ID / approver / UTC:
sender / account sequence:
chain ID: juno-1
contract (must match table):
message JSON:
attached funds (denom + integer ujuno):
estimated fee (ujuno) / approved fee cap:
canonical observation height / fingerprint:
consequences and relevant deadline:
```

Approve only one review, once. The approver must compare sender, chain, contract,
message, attached funds, and fee. Attached funds must be empty except for
`create_bounty`, `contribute`, or `register_project`. The wallet’s final prompt
must match the recorded review. Any re-prepare, changed fee above cap, changed
fingerprint/state, changed account sequence, or changed wallet identity requires
a new approval. A rejected wallet prompt is terminal for that approval; do not
silently resubmit.

## 4. Bounded end-to-end mainnet scenario

Use the public app only; a user trial requires no repository knowledge or CLI.
Choose unique, truthful trial metadata and do not put secrets or personal data
on chain. Capture a screenshot/text export before and after every step.

### A. Read-only baseline (no approval needed)

1. Open the production URL and record the release/provenance panel, observation
   height/time, health/accounting, pause state, and empty/current lists.
2. Open Projects and Gauge. Record registry policy/health/options, Vault balance,
   gauge stopped/open state, snapshot height if present, and connected account’s
   historical voting power if shown.
3. If the Vault is zero, label gauge distribution **inactive/unfunded**. Do not
   open or execute an epoch. Reading gauge state or preparing preferences is not
   evidence of a funded epoch rehearsal.

### B. Sole-funded bounty lifecycle (maximum principal: 1 JUNO)

1. Connect the trial wallet. Prepare **Create bounty** with an expiry comfortably
   after the expected trial, exact acceptance criteria, and `1 JUNO`
   (`1000000 ujuno`) attached. Record **Approval B1** and its fee cap. Only then
   click the signing gate once. Save hash, explorer URL, height, new bounty ID,
   event, and post-state.
2. Do not add a second contributor in the bounded default scenario. A second
   contributor changes settlement to weighted 72-hour ratification and requires
   a separately designed trial and approval.
3. The submitter prepares **Nominate payout** to the pre-approved trial recipient
   with durable evidence URI/digest and rationale. Funds must be empty. Record
   **Approval B2**, sign once, then save hash/height/event, round, recipient, and
   confirmation deadline.
4. The sole contributor verifies the canonical nomination and prepares
   **Confirm sole payout**. Funds must be empty. Record **Approval B3**, sign
   once, and preserve the paid state, recipient balance change, contract health,
   liabilities, hash, height, and event.
5. If the delivery should not be accepted, do not use step 4. Prepare the exact
   decline/cancel/expiry/refund path exposed by current canonical state, record a
   new approval for each transaction, and prove the final refund and health. Do
   not manufacture a successful payout merely to finish the script.

**Trial bound:** principal attached by the default scenario is exactly 1 JUNO;
all other B steps attach zero funds. Fees are additional and individually
capped. Stop rather than increasing either bound.

### C. Project registration (optional and separately funded)

Query and record the exact live registration bond. Continue only if there is a
pre-approved, non-agent source, the bond is within the separately recorded cap,
and the operator accepts that funds may remain bonded pending curator action.
Prepare the exact registration, verify project ID/metadata digest/payout address,
record **Approval R1** with exact bond and fee, then sign once. Curator admission,
address changes, retirement, and bond claims are distinct transactions with
separate approvals. Skip this section if any authority, timing, or refund path is
unclear; a pending application is not an active gauge option.

### D. Gauge preference exercise (conditional, zero attached funds)

This section is permitted only when a current epoch already exists through an
independently approved process and the connected account has snapshot voting
power. It does not authorize opening or executing an epoch. Record epoch ID,
snapshot height/power, close time, Vault balance, option set, turnout policy, and
funding provenance. Prepare bounded preferences for at most two known options
(total weight at most 1), verify empty funds, record **Approval G1**, then sign
once. Save ballot/revision, hash, height, and current option state. Removing or
revising preferences is another separately approved transaction. Distribution
and retained-value outcomes are observed only; they are not #37 completion
without the full approved rehearsal evidence.

## 5. Query and evidence capture

For every signed action preserve, without editing:

- exact review and approval record; wallet account and version; browser/version;
- production URL and displayed release commit;
- pre/post UTC time, RPC endpoint, chain ID, heights, app fingerprints and raw
  canonical query responses;
- transaction hash, explorer response, code/result, gas/fee, message, attached
  funds, events, and account sequence;
- pre/post sender, recipient, contract, liability, and Vault balances as relevant;
- bounty/project/epoch identifiers, deadlines, pause state, and expected versus
  observed outcome; and
- screenshots plus a support note for any mismatch, retry, endpoint switch, or
  stale observation.

Hash the final evidence files and review them independently. An explorer page or
RPC response is an observation, not independently authenticated proof; retain
which endpoint produced it. Never capture seed phrases, private keys, wallet
passwords, auth tokens, or unrelated account data.

## 6. Pending or unknown transaction recovery

“Pending” means a hash exists but canonical success/failure is not established.
“Unknown” means signing/broadcast may have begun, with or without a hash.

1. **Freeze the action. Do not prepare, sign, or broadcast it again.** Preserve
   the tab and app’s session evidence; record UTC, sender, chain, intended
   contract/message/funds/fee, account sequence, and any hash/error.
2. If a hash exists, check it on the configured explorer and at least two healthy
   `juno-1` endpoints. Match the hash’s sender, sequence, contract, message, and
   funds—not merely its presence. Record raw results and heights.
3. Query the canonical target state and balances from at least two endpoints:
   bounty/round/contribution, project/history/bond, or epoch/ballot as applicable.
   Query sender account number/sequence and compare it with the pre-review value.
4. Classify only when evidence agrees:
   - **confirmed success:** code `0`, expected event and canonical post-state;
   - **confirmed failure:** indexed non-zero code and no expected mutation;
   - **still unknown:** absent/unindexed hash, conflicting endpoints, advanced
     sequence without identified transaction, or state/event mismatch.
5. On confirmed success, save evidence and refresh the app. On confirmed failure,
   root-cause it; a new attempt requires a freshly prepared review and approval.
   On unknown, keep the app lock in place and escalate with the complete packet.
6. With no hash, search the sender’s transactions/account sequence through a
   trusted indexed service. Do not infer failure from “not found,” timeout, a
   stale sequence, unchanged balance, or one RPC. Do not clear browser storage to
   bypass the lock. Support may document a resolution but must not ask the user
   to retry until the original outcome is proved terminal.

## 7. RPC inconsistency recovery

The app performs weakly consistent direct-RPC reads; sequential/paginated queries
can span blocks. Stale, malformed, mismatched, or conflicting results are a stop,
not permission to transact.

1. Record endpoint, chain ID, latest height/time, catching-up status, response,
   browser error, and app observation height. Disconnect the wallet if a review
   is open; discard that review.
2. Compare at least two independent HTTPS `juno-1` endpoints at stated heights.
   Verify chain ID, increasing recent heights, `catching_up=false`, contract
   Code ID/checksum, target smart query, and relevant bank/account query.
3. Allow normal height lag only after the older endpoint catches up and the same
   canonical state is returned. For historical evidence, query the exact height.
   Never merge fields from different endpoint heights into one claimed snapshot.
4. If disagreement persists, quarantine the endpoint, keep writes stopped, and
   escalate raw responses to an operator. Resume only after two healthy sources
   agree and a newly prepared app review reflects current canonical state.

## 8. Stop, rollback, and support triage

### Immediate stop conditions

Stop the trial and do not sign when any of these occurs: production/displayed
commit mismatch; wrong chain/address/Code ID/checksum; stale or catching-up RPC;
under-backed health; unexpected pause/open epoch/Vault balance; attached funds or
fee above approval; changed sender/sequence/fingerprint; unexpected wallet
permissions; unknown/pending prior action; missing event/post-state; console or
provenance error; security/accessibility blocker; or any #37 recipient, amount,
deposit, authority, funding-source, or approval mismatch.

### Rollback

A web release rollback is a reviewed revert of `main` to the last known good
commit followed by the configured Pages workflow. Do not rely on that path until
Actions and repository protections have been verified live; as of 2026-08-12,
Actions dispatch was disabled for this user and `main` was unprotected. Record
old/new commits, workflow URL, reason, and post-deploy provenance checks.
**Frontend rollback does
not revert chain state.** Never compensate, migrate, resubmit, redirect, top up,
or manually pay as a “rollback.” Preserve on-chain state and use the narrow stop
procedure in [Pause and recovery](../deployment/runbooks/PAUSE_AND_RECOVERY.md).
Only Program Vault/Juno governance may perform its documented recovery actions;
Agent Operations is stop-only.

### Triage packet and severity

- **P0:** suspected key compromise, wrong-chain/wrong-contract signature,
  under-backed liabilities, or unauthorized funds movement. Stop all trials,
  advise wallet-level containment without requesting secrets, and page security
  and protocol operators.
- **P1:** pending/unknown transaction, conflicting RPC, bad provenance, repeated
  failure, or unexpected canonical mutation. Freeze affected action and page the
  release/operator contact.
- **P2:** display, accessibility, or non-mutating usability issue with canonical
  data intact. Preserve reproduction details; do not encourage unsafe workarounds.

The support ticket must include release commit, UTC, browser/wallet versions,
public sender, chain, endpoint/heights, action and approval ID, contract/message/
funds/fee, hash or explicit “no hash,” screenshots/errors, canonical pre/post
state, account sequence, and steps already taken. Redact secrets and unrelated
balances/history.

## 9. Final release evidence checklist

- [ ] Dynamic release record complete; exact production URL and displayed commit
      equal the deployed `main` commit.
- [ ] All five contract addresses, Code IDs, and checksums independently match.
- [ ] Funding status is a fresh query with endpoint/height/time. #37 remains open
      unless its separately approved funding and epoch evidence is complete.
- [ ] Known limitations published: direct-RPC weak consistency; no indexer or
      notification service; transaction finality depends on chain/indexing;
      browser wallet availability; immutable on-chain writes; curator/governance
      delays; unfunded gauge cannot distribute; no frontend rollback of chain state.
- [ ] Every signed action has its own approval, exact review, fee cap, hash,
      height, event, canonical post-state, and balance/liability reconciliation.
- [ ] Pending/unknown and RPC disagreement logs are resolved or explicitly block
      release; no duplicate attempt occurred.
- [ ] Bounded amount observed (default bounty principal exactly 1 JUNO); Agent
      funds were not used.
- [ ] Stop/rollback owner, support contact, known-good web commit, and incident
      channel recorded and tested without a chain write. Actions execution and
      branch/environment protections are verified live rather than inferred from
      checked-in workflow configuration.
- [ ] Required product, security, transaction-safety, accessibility, and
      operations reviews linked. Any unresolved gate is labeled **NOT RELEASED**.
