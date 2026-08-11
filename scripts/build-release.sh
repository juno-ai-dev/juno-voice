#!/usr/bin/env bash
set -o errexit -o nounset -o pipefail

ROOT=$(git rev-parse --show-toplevel)
OUTPUT_DIR=${1:-"$ROOT/artifacts/v1"}
OPTIMIZER_IMAGE='cosmwasm/optimizer@sha256:7e0b9229c1a4118d0c9a2af2e7f5d95a91f264c26a2ce5681c779926e74d7f85'
COSMWASM_CHECK_V3=${COSMWASM_CHECK_V3:-cosmwasm-check-v3}
COSMWASM_CHECK_V1=${COSMWASM_CHECK_V1:-cosmwasm-check-v1}
WASM_TOOLS_VERSION=1.254.0
PARENT_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
PINNED_SUBMODULE=$(git -C "$ROOT" ls-tree HEAD deps/dao-contracts | awk '{print $3}')
CHECKED_OUT_SUBMODULE=$(git -C "$ROOT/deps/dao-contracts" rev-parse HEAD)

if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]; then
  echo 'refusing release build from a dirty parent worktree' >&2
  exit 1
fi
if [ -n "$(git -C "$ROOT/deps/dao-contracts" status --porcelain --untracked-files=all)" ]; then
  echo 'refusing release build from a dirty dao-contracts submodule' >&2
  exit 1
fi
if [ "$PINNED_SUBMODULE" != "$CHECKED_OUT_SUBMODULE" ]; then
  echo 'checked-out dao-contracts commit does not match the parent gitlink' >&2
  exit 1
fi
case "$OPTIMIZER_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo 'optimizer image must be pinned by sha256 digest' >&2; exit 1 ;;
esac

WASM_TOOLS_ID=$(wasm-tools --version)
COSMWASM_CHECK_V3_ID=$("$COSMWASM_CHECK_V3" --version)
COSMWASM_CHECK_V1_ID=$("$COSMWASM_CHECK_V1" --version)
if [ "$WASM_TOOLS_ID" != "wasm-tools $WASM_TOOLS_VERSION" ]; then
  echo "wasm-tools identity mismatch: $WASM_TOOLS_ID" >&2
  exit 1
fi
if [ "$COSMWASM_CHECK_V3_ID" != 'Contract checking 3.0.4' ]; then
  echo "Juno v30 cosmwasm-check identity mismatch: $COSMWASM_CHECK_V3_ID" >&2
  exit 1
fi
if [ "$COSMWASM_CHECK_V1_ID" != 'Contract checking 1.5.11' ]; then
  echo "upstream cosmwasm-check identity mismatch: $COSMWASM_CHECK_V1_ID" >&2
  exit 1
fi

WORK=$(mktemp -d)
cleanup() {
  docker rm --force "juno-voice-release-a-$$" >/dev/null 2>&1 || true
  docker rm --force "juno-voice-release-b-$$" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

clone_release_source() {
  local destination=$1
  git -c protocol.file.allow=always clone --quiet --no-local --recurse-submodules "$ROOT" "$destination"
  test "$(git -C "$destination" rev-parse HEAD)" = "$PARENT_COMMIT"
  test "$(git -C "$destination/deps/dao-contracts" rev-parse HEAD)" = "$PINNED_SUBMODULE"
  test -z "$(git -C "$destination" status --porcelain --untracked-files=all)"
  test -z "$(git -C "$destination/deps/dao-contracts" status --porcelain --untracked-files=all)"
}

clone_release_source "$WORK/source-a"
clone_release_source "$WORK/source-b"

check_schemas() {
  local source=$1
  (
    cd "$source/contracts/juno-voice-bounties"
    cargo +1.85.1 run --locked -p juno-voice-bounties --example juno-voice-bounties-schema
  )
  (
    cd "$source/contracts/hack-juno-registry-adapter"
    cargo +1.85.1 run --locked -p hack-juno-registry-adapter --example hack-juno-registry-adapter-schema
  )
  (
    cd "$source"
    git diff --exit-code -- \
      contracts/juno-voice-bounties/schema \
      contracts/hack-juno-registry-adapter/schema
  )
  (
    cd "$source/deps/dao-contracts/contracts/dao-dao-core"
    cargo +1.81.0 run --locked -p dao-dao-core@2.8.0-alpha.2 --example schema
    rm -rf schema/raw
  )
  (
    cd "$source/deps/dao-contracts/contracts/voting/dao-voting-juno-staked"
    cargo +1.81.0 run --locked -p dao-voting-juno-staked@2.8.0-alpha.2 --example schema
    rm -rf schema/raw
  )
  (
    cd "$source/deps/dao-contracts/contracts/gauges/gauge"
    cargo +1.81.0 run --locked -p gauge-orchestrator@2.8.0-alpha.2 --example gauge-orchestrator-schema
    rm -rf schema/raw
  )
  (
    cd "$source/deps/dao-contracts"
    git diff --exit-code -- \
      contracts/dao-dao-core/schema \
      contracts/voting/dao-voting-juno-staked/schema \
      contracts/gauges/gauge/schema
  )
}

check_schemas "$WORK/source-a"

build_clone() {
  local source=$1
  local output=$2
  local suffix=$3
  local container="juno-voice-release-$suffix-$$"
  mkdir -p "$output"
  docker create \
    --name "$container" \
    --entrypoint sh \
    "$OPTIMIZER_IMAGE" \
    -lc '
      set -o errexit -o nounset -o pipefail
      export PATH="/usr/local/cargo/bin:$PATH"
      rustup toolchain install 1.85.1 --profile minimal --target wasm32-unknown-unknown
      rustup toolchain install 1.81.0 --profile minimal --target wasm32-unknown-unknown
      mkdir -p /out /target-juno-voice /target-dao-contracts
      rustc +1.85.1 --version > /out/build-tools.txt
      cargo +1.85.1 --version >> /out/build-tools.txt
      rustc +1.81.0 --version >> /out/build-tools.txt
      cargo +1.81.0 --version >> /out/build-tools.txt
      wasm-opt --version >> /out/build-tools.txt

      cd /code
      export CARGO_TARGET_DIR=/target-juno-voice
      export RUSTFLAGS="-C link-arg=-s"
      cargo +1.85.1 build --locked --release --lib --target wasm32-unknown-unknown \
        -p juno-voice-bounties \
        -p hack-juno-registry-adapter

      cd /code/deps/dao-contracts
      export CARGO_TARGET_DIR=/target-dao-contracts
      export RUSTFLAGS="-C link-arg=-s -C link-arg=--allow-undefined"
      cargo +1.81.0 build --locked --release --lib --target wasm32-unknown-unknown \
        -p dao-dao-core@2.8.0-alpha.2 \
        -p dao-voting-juno-staked@2.8.0-alpha.2 \
        -p gauge-orchestrator@2.8.0-alpha.2

      wasm-opt -Oz /target-juno-voice/wasm32-unknown-unknown/release/juno_voice_bounties.wasm \
        -o /out/juno_voice_bounties.wasm
      wasm-opt -Oz /target-juno-voice/wasm32-unknown-unknown/release/hack_juno_registry_adapter.wasm \
        -o /out/hack_juno_registry_adapter.wasm
      wasm-opt -Os /target-dao-contracts/wasm32-unknown-unknown/release/dao_dao_core.wasm \
        -o /out/dao_dao_core.wasm
      wasm-opt -Os /target-dao-contracts/wasm32-unknown-unknown/release/dao_voting_juno_staked.wasm \
        -o /out/dao_voting_juno_staked.wasm
      wasm-opt -Os /target-dao-contracts/wasm32-unknown-unknown/release/gauge_orchestrator.wasm \
        -o /out/gauge_orchestrator.wasm
    ' >/dev/null
  docker cp "$source/." "$container:/code"
  docker start --attach "$container"
  docker cp "$container:/out/." "$output"
  docker rm --force "$container" >/dev/null
}

build_clone "$WORK/source-a" "$WORK/out-a" a
build_clone "$WORK/source-b" "$WORK/out-b" b

ARTIFACTS=(
  juno_voice_bounties.wasm
  hack_juno_registry_adapter.wasm
  dao_dao_core.wasm
  dao_voting_juno_staked.wasm
  gauge_orchestrator.wasm
)
for artifact in "${ARTIFACTS[@]}"; do
  cmp "$WORK/out-a/$artifact" "$WORK/out-b/$artifact"
  wasm-tools validate "$WORK/out-a/$artifact"
  "$COSMWASM_CHECK_V3" "$WORK/out-a/$artifact"
done
for artifact in dao_dao_core.wasm dao_voting_juno_staked.wasm gauge_orchestrator.wasm; do
  "$COSMWASM_CHECK_V1" "$WORK/out-a/$artifact"
done
"$ROOT/scripts/validate-v1-wasm.sh" "$WORK/out-a"
cmp "$WORK/out-a/build-tools.txt" "$WORK/out-b/build-tools.txt"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)
for artifact in "${ARTIFACTS[@]}"; do
  cp "$WORK/out-a/$artifact" "$OUTPUT_DIR/$artifact"
done
cp "$WORK/out-a/build-tools.txt" "$OUTPUT_DIR/build-tools.txt"
{
  echo "$WASM_TOOLS_ID"
  echo "$COSMWASM_CHECK_V3_ID"
  echo "$COSMWASM_CHECK_V1_ID"
} >> "$OUTPUT_DIR/build-tools.txt"
(
  cd "$OUTPUT_DIR"
  sha256sum "${ARTIFACTS[@]}" > checksums.txt
  wc -c "${ARTIFACTS[@]}" > sizes.txt
)

{
  echo "parent_commit=$PARENT_COMMIT"
  echo "dao_contracts_commit=$PINNED_SUBMODULE"
  echo "optimizer_image=$OPTIMIZER_IMAGE"
  echo 'juno_voice_rust=1.85.1'
  echo 'dao_contracts_rust=1.81.0'
  echo 'juno_voice_cosmwasm_check=3.0.4'
  echo 'dao_contracts_cosmwasm_check=1.5.11'
  echo "wasm_tools=$WASM_TOOLS_VERSION"
  echo 'recursive_clone_rebuilds=2'
} > "$OUTPUT_DIR/build-provenance.txt"

python3 "$ROOT/scripts/generate-build-manifest.py" \
  --artifacts "$OUTPUT_DIR" \
  --source-root "$ROOT" \
  --output "$OUTPUT_DIR/build-manifest.json" \
  --parent-commit "$PARENT_COMMIT" \
  --dao-contracts-commit "$PINNED_SUBMODULE" \
  --optimizer-image "$OPTIMIZER_IMAGE"

echo "wrote deterministic Juno Voice v1 artifacts to $OUTPUT_DIR"
