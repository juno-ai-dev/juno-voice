# Juno Voice `uni-7` testnet smoke

## Result

**PASS** on Juno `uni-7` / application `v30.0.0`.

- Source commit: `8626a8cce89b5f2c150676e3055ad75a6a6fb0b1`
- Release commit: `d3f57d12d3b5ca33ca7feb1b3a459672ff3d8136`
- Code ID: `85`
- Final contract: `juno1t7ajx85pkw8e0yl8vgnlxvnlq4yf0h6a3eahuystnf6e9jfhwvvsv4jcel`
- Store transaction: `2D98B58FB04EA29298C3B975ADF2C36F9236D479FB6177199D113AFFBFCFC27D`
- Instantiate transaction: `BF0863793489DA8A551EE4E6ED13D7DC8F91EFE05ADA06E6BC96CB55DCD70C00`
- Machine-readable evidence: [`uni-7-smoke-evidence.json`](uni-7-smoke-evidence.json)

The on-chain Code ID 85 checksum is exactly:

`FD264E53AE9AF64231B8E62AFF0DA099E0FF21BA38D887C7A96D9C4EF755A96E`

It matches `artifacts/juno_voice.wasm` byte for byte by SHA-256.

## Reproducible artifact

| Property | Value |
|---|---|
| Rust / Cargo | `1.85.1` |
| Lockfile SHA-256 | `ed910bae40fb7d5913770373029ab967d2fac38929bfb58c84764427d12ba22b` |
| Raw Wasm | 892,517 bytes; `45e9c7fdd22d2b86dcbac24e8e078ca2face1d5e2f28fbe60bf03cf38d612bc1` |
| Optimizer | Binaryen `wasm-opt 120` |
| Optimization | `wasm-opt -Oz --strip-debug --signext-lowering` |
| Stored Wasm | 619,791 bytes; `fd264e53ae9af64231b8e62aff0da099e0ff21ba38d887c7a96d9c4ef755a96e` |

Run `scripts/build-release.sh`. It compiles twice into independent target directories, optimizes both outputs identically, requires byte equality, updates `artifacts/checksums.txt`, and runs both `wasm-tools validate` and `cosmwasm-check`.

## Snapshot proof

Request 1 opened at height `16141378` and froze snapshot height `16141377`, exactly `opened_height - 1`.

Historical native SDK queries at height `16141377` matched the values consumed and stored by the contract:

| Value | Contract | Native state | Match |
|---|---:|---:|---|
| Total voting power / bonded tokens | 226,105,793,108 | 226,105,793,108 | yes |
| Voter power / bonded delegation | 27,000,000 | 27,000,000 | yes |

The voting-snapshot LST allowlist was empty, so bonded staking state is the exact denominator/numerator basis. Public providers returned gRPC code 12 / HTTP 501 for the module's dedicated `VotingPowerAt` endpoint; the gate therefore used historical native staking queries at the exact snapshot height and recorded that limitation rather than inventing a result.

## Lifecycle and pause-continuity transactions

All listed successful transactions returned code `0`. The intentionally rejected paused submission returned code `5`.

| Gate | Transaction |
|---|---|
| Submit request 1 | `7B30A0B3CB712A51A38F8DFD3073A8A3EF1A65128C5869DE5731BD19A108A6CB` |
| Support vote | `6C32DA6FF990BE4216D1E4727AED0421D24F58403902E4406FE76D4E0AA33E7A` |
| Qualified close while paused | `0E14F007B402DD9F31558451DE1BF54C8DCA2A1995AE9E4589B08BA8202B075F` |
| Builder assignment while paused | `4B76C5ED1F63455EDC5C98CBED0045B249673A9DE2FA3B5FCA99D32B2CD15A51` |
| Delivery evidence by distinct builder | `FBDDB5B6C85B71150AF9C8A68A4ED1B24A70B3E6BA5F18A9F8482CCFB9E9DA84` |
| Review request | `00A2228F1A7F457BEECEF265745CA0642EE71AA211A0D2971765E8E73C7AD8D9` |
| Verification evidence | `6A82759875A8F1F561DEF6E7C87CE0566A89FFA0B4F2DCE0F21D44A33874222B` |
| Shipment attestation | `7CC658724951BEEBFFA1FBEDC563C4045E4EA09781F6932BB7C3718BF7ECCD1F` |
| Oppose vote | `4D7DC6D3EEF477C403A7E5973700D5A985D669276703076972D02AB56E3332F9` |
| Not-prioritized close | `2AD915E92FD964A6B370407B48B6F11D9978F673546E79054CD3C5183E7CFFB8` |
| Mark duplicate | `1787E133A6BAC8530AC31FB540C2CB1357C9E4544E31936EF77022F3179C514C` |
| Pause submissions | `54CFCD63742255156ED149D9BDA4CB824DB1656807DC84392C283B259406D19B` |
| Submission rejected while paused | `B47A17CC6E4D78D0291FE6A732189D65D10FBAE45E67615ACD485FE7F560A707` (code 5) |
| Vote continued while paused | `FD4F3A7D3ADAAD6E431F850936D1789E6587EF90ECA63415A23941C318AC0696` |
| Typed `SnapshotHistoryRisk` archive | `D4D4C8934A929A7EBCFA96A2A8FF9DAB5225B242DFED609B26DEBB106DD10328` |
| Duplicate refund while paused | `EB80E6549C3D3BE971275281489BA0F608FE029931FB9A0B116399E50BF8CF7A` |
| Emergency archive refund while paused | `B21CFA13971CD00551CE03CE98A0DA0613AECD0107DFDA2A7BF59F3566179BE6` |
| Not-prioritized refund while paused | `0AEEA7F1BBDAC04972172599827BA90F3FE7EB5FBDFC3B7BD2CA04751C2C44A9` |
| Unpause | `1A6BE29F3E38C4413D7CB4A7D88E03468B8F2A10A0B11DF1F7FEE6DED01689FB` |

Final canonical request states were:

| Request | Purpose | Status | Bond |
|---:|---|---|---|
| 1 | Support and shipment | `shipped` | `refundable` |
| 2 | Duplicate path | `duplicate` | `claimed` |
| 3 | Voting during pause | `qualified` | `refundable` |
| 4 | Snapshot-history recovery | `archived` | `claimed` |
| 5 | Oppose path | `not_prioritized` | `claimed` |

Final bond totals were `locked = 0`, `refundable = 2,000,000`, and `forfeited = 0`, exactly matching requests 1 and 3 whose authors intentionally had not yet pulled refunds. Request 1 has two evidence records in distinct delivery/verification classes and a present shipment attestation.

## Snapshot-mismatch negative gate

A healthy immutable snapshot cannot be intentionally made inconsistent on a live chain without corrupting consensus state. The exact mismatch failure was therefore verified in the locked 107-test contract suite, including atomic no-write assertions; it was not falsely claimed as a live transaction. The live smoke separately proved the positive exact-height equality above.

## Calibration record

Two preliminary contracts exposed smoke-parameter issues only:

1. A five-block voting period expired while five setup requests were being submitted.
2. The agent's original 2,000,000 testnet voting power was below the minimum one-basis-point quorum.

The code and stored artifact were unchanged. The final gate used a 20-block voting period after increasing the agent's testnet bonded delegation to 27,000,000. This is preserved here so the smoke evidence does not hide failed attempts or imply they were contract defects.
