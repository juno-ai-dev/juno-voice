# Monitoring runbook

## Collection cadence

Poll at least once per block during canary execution and at least every five
minutes otherwise. Alerts must identify the chain ID, height, contract address,
code ID, config hash, and last successful observation. Treat a stale observer
as an alert rather than healthy silence.

## Balance and liability alerts

For the bounty contract, compare `Health.actual_native_balance` to
`Health.liabilities` and require `fully_backed=true`. Track active escrow,
outstanding refunds, pending payout liabilities, lifetime received, paid, and
refunded. Alert immediately on under-backing, arithmetic/query failure, an
unexpected denomination, or a bank balance change without a corresponding
contract event.

For the registry, require `Health.fully_backed=true`; compare bond liability to
its native balance; and reconcile lifetime received, refunded, and forfeited.
The Program Vault balance is distinct from both liability pools.

## Bounty liveness alerts

Alert on:

- a ratification still pending after `closes_at` plus the response SLO;
- an open bounty past expiry that has not entered refunds;
- a payout/refund transaction failure or repeated finalization failure;
- a claimable refund older than the configured notice threshold;
- maximum contributor, round, page, or metadata limits being approached; and
- new activity while the component reports paused.

Existing voting, finalization, expiry, and refunds must remain live while new
activity is paused.

## Registry and adapter alerts

Track active and pending counts, option count, the immutable
`do-not-distribute` option, status/address history, and bond disposition. Alert
at 90 active projects and again at 98; 99 is the hard project cap. Alert if a
suspended/non-active project passes `CheckOption`, if more than the configured
selected projects/messages are returned, or if any adapter message is not a
native `ujuno` bank send to the current active payout address.

## Snapshot and epoch alerts

For every epoch record snapshot height, total power, participating power,
allocated power, turnout basis points, policy, selected set, outcome, adapter
messages, and cleanup cursor. Alert on:

- failure to query total or voter power at the epoch's exact height;
- observed history retention below epoch duration plus margin;
- mixed heights, zero total, arithmetic failure, or ballot/tally mismatch;
- an open epoch beyond its execution SLO;
- failed turnout that emits a transfer or affects a later epoch budget;
- adapter failure, stopped gauge, or guardian resume attempt;
- vault balance below the epoch budget before execution; and
- cleanup that makes no progress or exceeds its bounded batch.

## Tranche alerts

Track funded amount, every epoch ceiling, cumulative distributions, retained
dust/abstention/threshold/cap amounts, and term end. Alert before the remaining
balance falls below one epoch ceiling and at 30/14/7/1 days before expiry. At
term end follow the configured unused-funds policy; never infer rollover.

Each alert links to the relevant pause/recovery procedure and preserves raw
query responses for the evidence packet.
