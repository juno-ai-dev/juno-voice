# Juno Voice Testnet Smoke

This document records the reproducible artifact and live `uni-7` smoke gate for the Juno Voice MVP contract.

## Frozen contract

- Source commit: `8626a8cce89b5f2c150676e3055ad75a6a6fb0b1`
- Rust/Cargo: `1.85.1`
- Lockfile SHA-256: `ed910bae40fb7d5913770373029ab967d2fac38929bfb58c84764427d12ba22b`
- Optimizer: Binaryen `wasm-opt 120`
- Optimization: `wasm-opt -Oz --strip-debug --signext-lowering`
- Reproduction: `scripts/build-release.sh`

The build script compiles twice from the pinned lockfile into independent target directories, optimizes both outputs identically, requires byte equality, writes `artifacts/juno_voice.wasm`, updates `artifacts/checksums.txt`, and runs `wasm-tools validate` plus `cosmwasm-check`.

## Testnet environment

- Chain: `uni-7`
- Required application version: Juno `v30.0.0`
- Native denom: `ujunox`
- Voting-snapshot retention at smoke time: pruning disabled (`retention_window_heights = 0`)

## Live evidence

Live transaction, code, contract, snapshot, lifecycle, pause-continuity, and refund evidence will be appended after storing and exercising the exact checked artifact.
