# Refund and expiry runbook

Refunds are pull-based and contributor-specific. Operators never batch-send or
redirect bounty principal.

## Entering refunds

An open bounty may enter refunds through expiry, sole-contributor cancellation,
round exhaustion, or typed Agent Operations moderation. A sole-confirmation
round also enters refunds when anyone finalizes it at its bounded deadline or
bounty expiry. Before acting, query the
bounty, contributions, active round, pause state, and `Health`. Record the exact
reason and actor.

For moderation, the Agent DAO proposal must use one of the contract's typed
outcomes and identify only an open bounty. Moderation cannot settle a payout.
For expiry, anyone may call the permissionless expiry path after the recorded
deadline. Failed payout rounds reset according to the on-chain state machine;
they do not create an operator-selected recipient.

## Contributor claims

Each contributor submits `ClaimRefund` for their own address and bounty. After a
claim, query the claim record, contribution, bounty totals, accounting, health,
and native balances. A repeat claim must fail. Claims from another bounty or
address must not affect the record.

If a bank send fails, CosmWasm atomicity must leave the claim and accounting
unchanged. Preserve the failed transaction and retry only after the destination
or chain condition is understood; never mark a claim paid off-chain.

## Reconciliation

At every transition require:

```text
active escrow + outstanding refunds + pending payout liabilities
<= accounted native balance <= actual native balance
```

Unsolicited native transfers are surplus, not liabilities. Do not allocate them
to a bounty or use them to hide under-backing. Alert and document their source
when possible.

Close an incident only when every contributed unit is either paid once,
refunded once, or remains an explicit live liability and the `Health` query is
fully backed.
