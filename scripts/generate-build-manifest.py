#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
from pathlib import Path


ARTIFACTS = {
    "juno_voice_bounties.wasm": ("crates.io:juno-voice-bounties", "1.0.0", "juno-voice"),
    "hack_juno_registry_adapter.wasm": (
        "crates.io:hack-juno-registry-adapter",
        "1.0.0",
        "juno-voice",
    ),
    "dao_dao_core.wasm": ("crates.io:dao-dao-core", "2.8.0-alpha.2", "dao-contracts"),
    "dao_voting_juno_staked.wasm": (
        "crates.io:dao-voting-juno-staked",
        "2.8.0-alpha.2",
        "dao-contracts",
    ),
    "gauge_orchestrator.wasm": ("crates.io:gauge", "2.8.0-alpha.2", "dao-contracts"),
}
SCHEMAS = {
    "juno_voice_bounties": (
        "contracts/juno-voice-bounties/schema/juno-voice-bounties.json",
        "juno-voice",
    ),
    "hack_juno_registry_adapter": (
        "contracts/hack-juno-registry-adapter/schema/hack-juno-registry-adapter.json",
        "juno-voice",
    ),
    "dao_dao_core": (
        "deps/dao-contracts/contracts/dao-dao-core/schema/dao-dao-core.json",
        "dao-contracts",
    ),
    "dao_voting_juno_staked": (
        "deps/dao-contracts/contracts/voting/dao-voting-juno-staked/schema/dao-voting-juno-staked.json",
        "dao-contracts",
    ),
    "gauge_orchestrator": (
        "deps/dao-contracts/contracts/gauges/gauge/schema/gauge-orchestrator.json",
        "dao-contracts",
    ),
}
WASM_TOOLS_VERSION = "1.254.0"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def provenance(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        if "=" not in line:
            raise ValueError(f"malformed provenance line: {line!r}")
        key, value = line.split("=", 1)
        if not key or key in result:
            raise ValueError(f"invalid provenance key: {key!r}")
        result[key] = value
    return result


def validate_sizes(path: Path, entries: list[dict[str, object]]) -> None:
    lines = path.read_text().splitlines()
    if len(lines) != len(entries) + 1:
        raise ValueError("sizes.txt must contain every artifact and one total")
    total = 0
    for index, entry in enumerate(entries):
        fields = lines[index].split()
        if len(fields) != 2 or fields[1] != entry["file"]:
            raise ValueError(f"malformed sizes.txt entry for {entry['file']}")
        try:
            recorded_size = int(fields[0])
        except ValueError as error:
            raise ValueError(f"non-integer size for {entry['file']}") from error
        if recorded_size != entry["size_bytes"]:
            raise ValueError(f"sizes.txt does not match {entry['file']}")
        total += recorded_size
    total_fields = lines[-1].split()
    if total_fields != [str(total), "total"]:
        raise ValueError("sizes.txt total does not match the release artifacts")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--parent-commit", required=True)
    parser.add_argument("--dao-contracts-commit", required=True)
    parser.add_argument("--optimizer-image", required=True)
    args = parser.parse_args()
    for label, value in (
        ("parent commit", args.parent_commit),
        ("dao-contracts commit", args.dao_contracts_commit),
    ):
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            parser.error(f"{label} must be 40 lowercase hexadecimal characters")
    if not re.fullmatch(r"[^@]+@sha256:[0-9a-f]{64}", args.optimizer_image):
        parser.error("optimizer image must be pinned by a complete SHA-256 digest")
    provenance_path = args.artifacts / "build-provenance.txt"
    tools_path = args.artifacts / "build-tools.txt"
    checksums_path = args.artifacts / "checksums.txt"
    sizes_path = args.artifacts / "sizes.txt"
    for required in (provenance_path, tools_path, checksums_path, sizes_path):
        if not required.is_file():
            parser.error(f"missing build evidence {required.name}")
    try:
        recorded = provenance(provenance_path)
    except ValueError as error:
        parser.error(str(error))
    expected_provenance = {
        "parent_commit": args.parent_commit,
        "dao_contracts_commit": args.dao_contracts_commit,
        "optimizer_image": args.optimizer_image,
        "juno_voice_rust": "1.85.1",
        "dao_contracts_rust": "1.81.0",
        "juno_voice_cosmwasm_check": "3.0.4",
        "dao_contracts_cosmwasm_check": "1.5.11",
        "wasm_tools": WASM_TOOLS_VERSION,
        "recursive_clone_rebuilds": "2",
    }
    if recorded != expected_provenance:
        parser.error("build-provenance.txt does not exactly match the requested build")
    tool_lines = tools_path.read_text().splitlines()
    expected_tool_prefixes = (
        "rustc 1.85.1",
        "cargo 1.85.1",
        "rustc 1.81.0",
        "cargo 1.81.0",
        "wasm-opt ",
    )
    expected_tool_identities = (
        f"wasm-tools {WASM_TOOLS_VERSION}",
        "Contract checking 3.0.4",
        "Contract checking 1.5.11",
    )
    if (
        len(tool_lines) != len(expected_tool_prefixes) + len(expected_tool_identities)
        or any(
            not line.startswith(prefix)
            for line, prefix in zip(tool_lines, expected_tool_prefixes)
        )
        or tuple(tool_lines[len(expected_tool_prefixes) :]) != expected_tool_identities
    ):
        parser.error("build-tools.txt does not contain the exact build tool identities")
    entries = []
    for filename, (contract, version, repository) in ARTIFACTS.items():
        path = args.artifacts / filename
        if not path.is_file():
            parser.error(f"missing artifact {filename}")
        entries.append(
            {
                "name": filename.removesuffix(".wasm"),
                "file": filename,
                "sha256": digest(path),
                "size_bytes": path.stat().st_size,
                "cw2_contract": contract,
                "cw2_version": version,
                "source_repository": repository,
            }
        )
    checksum_lines = checksums_path.read_text().splitlines()
    expected_checksum_lines = [
        f"{entry['sha256']}  {entry['file']}" for entry in entries
    ]
    if checksum_lines != expected_checksum_lines:
        parser.error("checksums.txt does not exactly match the release artifacts")
    try:
        validate_sizes(sizes_path, entries)
    except ValueError as error:
        parser.error(str(error))
    schemas = []
    for name, (relative, repository) in SCHEMAS.items():
        schema_path = args.source_root / relative
        if not schema_path.is_file():
            parser.error(f"missing schema {relative}")
        schemas.append(
            {
                "name": name,
                "file": relative,
                "sha256": digest(schema_path),
                "source_repository": repository,
            }
        )
    manifest = {
        "schema_version": "juno-voice/build-manifest/v1",
        "source": {
            "parent_commit": args.parent_commit,
            "dao_contracts_commit": args.dao_contracts_commit,
        },
        "builder": {
            "optimizer_image": args.optimizer_image,
            "juno_voice_rust": "1.85.1",
            "dao_contracts_rust": "1.81.0",
            "juno_voice_cosmwasm_check": "3.0.4",
            "dao_contracts_cosmwasm_check": "1.5.11",
            "wasm_tools": WASM_TOOLS_VERSION,
            "recursive_clone_rebuilds": 2,
            "byte_for_byte_repeatable": True,
        },
        "artifacts": entries,
        "schemas": schemas,
        "build_evidence": {
            "build_provenance_sha256": digest(provenance_path),
            "build_tools_sha256": digest(tools_path),
            "checksums_sha256": digest(checksums_path),
            "sizes_sha256": digest(sizes_path),
        },
    }
    args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
