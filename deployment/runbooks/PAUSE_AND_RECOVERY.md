# Pause and recovery runbook

## Decision table

| Condition | Immediate actor | Allowed action | Recovery actor |
|---|---|---|---|
| bounty spam/operational risk | Agent Operations DAO | pause new activity | Program Vault only |
| registry admission risk | Agent Operations DAO | stop admissions | Program Vault only |
| adapter/payment risk | Agent Operations DAO | stop adapter or all registry activity | Program Vault only |
| gauge/snapshot risk | Agent Operations DAO guardian | stop gauge | Program Vault owner only |
| one project risk | Agent Operations DAO | suspend project | Program Vault may override |
| compromised agent DAO | Program Vault under `x/gov` | replace curator/agent roles | Program Vault |
| code vulnerability | Juno `x/gov` | no automatic migration; follow separately reviewed plan | Juno `x/gov` |

Agent Operations can reduce activity only. It cannot unpause/resume, increase a
budget or limit, change the vault, redirect bounty principal, allocate an
epoch, or migrate code.

## Pause procedure

1. Preserve the triggering transaction/query, current balances, liabilities,
   config, pause state, active rounds, open epoch, and project states.
2. Create and execute the narrow Agent DAO proposal for the affected stop call.
   Use `All` only when the narrower scope is insufficient.
3. Query the stopped state and record proposal, vote, execution, and contract
   transaction hashes.
4. Prove that new actions fail while payout voting/finalization, expiry, and
   pull refunds remain available where applicable.
5. Notify operators and contributors with exact affected scopes and heights.

## Failed epoch or adapter

Do not mutate tallies, top up an epoch beyond its configured budget, or manually
pay selected recipients. If an adapter error leaves the epoch open, diagnose the
voting-source query, current project eligibility, Vault balance, and adapter
response. A safe transient failure may be retried only through the normal public
execute path and only through `execution_deadline`. At the deadline anyone may
expire the epoch. For an unrecoverable adapter or code fault, Program Vault
governance may abort before the deadline with a recorded reason. The guardian
cannot abort.

Failed turnout is terminal. It is not an incident requiring retry: record the
no-distribution outcome and retained vault balance. Never roll it into the next
epoch.

Execution-time balance below actual `emitted_value` is also terminal and sends
nothing. A later top-up must not make that epoch executable. Record the
`required` and `available` values and reconcile the full budget as retained.

## Governor recovery

1. Root-cause and independently review the proposed recovery.
2. Re-run balance/liability and configuration verification against the exact
   current code IDs.
3. Have Juno governance authorize the Program Vault admin action where required.
4. The Program Vault executes the narrow unpause/resume/role/config message.
5. Query the resulting state and run a no-funds smoke action before reopening
   normal activity.
6. Record the decision, proposal and transaction references, reviewers, and any
   monitoring changes.

Changing immutable terms, bypassing contributor ratification, importing old
state, or replacing code requires a new specification and release review, not
an emergency shortcut.
