# Juno Voice security audit package

Point-in-time review: **2026-08-12 UTC**

This directory contains a read-only security review of the Juno Voice v1 smart
contract system:

- `juno-voice-bounties`;
- `hack-juno-registry-adapter`;
- the pinned `dao-contracts` snapshot-gauge paths used by Juno Voice; and
- cross-contract deployment and authority assumptions.

The older `contracts/juno-voice` package was inspected as historical context,
but it is explicitly excluded from the v1 deployment and is not treated as a
production migration source.

## Result

**Do not fund or open Hack Juno epochs until JV-01 and JV-02 are fixed and a
separately reviewed v2 composition is freshly deployed.**

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 1 |

The full report is in [SECURITY_AUDIT.md](SECURITY_AUDIT.md). The implementation
team's explicit, non-authoritative candidate dispositions are in
[REMEDIATION_DISPOSITION.md](REMEDIATION_DISPOSITION.md). The live-chain queries
used to establish the current blast radius are summarized in
[LIVE_STATE.md](LIVE_STATE.md).

At the observation height, the deployed system had no user or program funds:
the bounty contract had zero liabilities and no bounties, the registry had no
projects or bond liabilities, the Program Vault held zero `ujuno`, and the
gauge had no open epoch. The High-severity issue is therefore latent rather
than evidence of an already-realized loss.

## Required release disposition

1. Keep the Program Vault unfunded and do not open an epoch.
2. Fix the snapshot gauge for JV-01 and JV-02 and deploy the complete v2
   composition at new addresses without importing v1 state.
3. Fix or explicitly disposition JV-03 and JV-04 before public project use.
4. Resolve JV-05 as part of the registry state-machine patch.
5. Add the regression tests listed in the report and rerun the complete release
   and exact-artifact verification gates.

This is an engineering security review, not a signed independent audit
attestation and not an authorization to release or fund the contracts.
