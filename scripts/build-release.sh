#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

expected_rust="rustc 1.85.1"
expected_wasm_opt="wasm-opt version 120"
[[ "$(rustc --version)" == "$expected_rust"* ]] || { echo "expected $expected_rust" >&2; exit 1; }
[[ "$(wasm-opt --version)" == "$expected_wasm_opt" ]] || { echo "expected $expected_wasm_opt" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

build_one() {
  local name="$1"
  local target="$work/target-$name"
  CARGO_TARGET_DIR="$target" cargo build --workspace --release --locked --target wasm32-unknown-unknown
  cp "$target/wasm32-unknown-unknown/release/juno_voice.wasm" "$work/juno_voice_raw_$name.wasm"
  wasm-opt -Oz --strip-debug --signext-lowering \
    "$work/juno_voice_raw_$name.wasm" -o "$work/juno_voice_$name.wasm"
}

build_one a
build_one b
cmp "$work/juno_voice_raw_a.wasm" "$work/juno_voice_raw_b.wasm"
cmp "$work/juno_voice_a.wasm" "$work/juno_voice_b.wasm"

mkdir -p artifacts
cp "$work/juno_voice_a.wasm" artifacts/juno_voice.wasm
sha256sum artifacts/juno_voice.wasm > artifacts/checksums.txt
wasm-tools validate artifacts/juno_voice.wasm
cosmwasm-check artifacts/juno_voice.wasm
printf 'raw_sha256=%s raw_size=%s\n' \
  "$(sha256sum "$work/juno_voice_raw_a.wasm" | cut -d' ' -f1)" \
  "$(stat -c%s "$work/juno_voice_raw_a.wasm")"
printf 'optimized_sha256=%s optimized_size=%s\n' \
  "$(sha256sum artifacts/juno_voice.wasm | cut -d' ' -f1)" \
  "$(stat -c%s artifacts/juno_voice.wasm)"
