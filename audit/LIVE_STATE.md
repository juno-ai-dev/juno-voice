# Point-in-time Juno mainnet state

This is a read-only observation used to bound the impact of the audit findings.
It is not a promise about current state after the observation time.

## Observation

- Endpoint: `https://juno-rpc.publicnode.com:443`
- Chain: `juno-1`
- Height: `40,709,002`
- Block time: `2026-08-12T20:08:24.332839675Z`

## Funds and application state

| Component | Observation |
|---|---|
| Program Vault | `0 ujuno` |
| Bounty contract | zero balance; zero active/refund/payout liabilities; zero bounties; fully backed |
| Registry | zero balance; zero bond liability; zero active/pending projects; fully backed |
| Registry options | only `do-not-distribute` |
| Gauge | not stopped; no current epoch |

The empty state means no observed user funds were exposed at the time of this
review. It does not make JV-01 safe once the Vault is funded.

## Observed gauge policy

| Field | Value |
|---|---:|
| Epoch duration | 604,800 seconds |
| Minimum turnout | 100 bps (1%) |
| Epoch budget | 1,000,000,000 `ujuno` |
| Minimum project share | 1% |
| Maximum project share | 20% |
| Maximum selected projects | 20 |

## Observed registry policy

| Field | Value |
|---|---:|
| Registration bond | 100,000,000 `ujuno` |
| Payout-address delay | 86,400 seconds |
| Epoch ceiling | 1,000,000,000 `ujuno` |
| Active-project capacity | 99 |

## Deployed identity verification

All five contract code IDs, SHA-256 code checksums, creators, and administrators
were queried directly. Checksums matched `README.md` and
`docs/MAINNET_TRIAL_RELEASE_RUNBOOK.md`. Every contract administrator was the
documented Juno governance module account
`juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730`.

| Component | Code ID | SHA-256 |
|---|---:|---|
| Bounty | 5150 | `f05e9eaf3f90c7a5273bea3e8db8ff570b4f9192a4032472865cd4293b49bce1` |
| Registry | 5151 | `1edaf206f87958e3be62225c2cdb71345b39ca07f16b74005c463bbf7c1debbf` |
| Program Vault | 5152 | `bc8b049a03496d3383376a469ccb581996238003532083895f68d4a02990a2da` |
| Voting module | 5153 | `2f336e39f9c05ad57c972eb3a51ce58ba0afaeb5944ff337d68e67644f1dad64` |
| Gauge | 5154 | `524d5728994950bccb471ed586d2726f3594157fafccd484aa3c0c3012e8794f` |

## Immediate operational constraint

Keep the Vault unfunded and do not open an epoch. Re-query the Vault balance,
current epoch, gauge stop state, registry options, code identities, and admins
immediately before any recovery or migration transaction.
