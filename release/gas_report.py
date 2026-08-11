#!/usr/bin/env python3
"""Prepare and finalize the signed configured-maximum gas report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deployment"))
import juno_voice_deploy as deploy  # noqa: E402
import release_manifest as release  # noqa: E402


class GasReportError(ValueError):
    pass


def read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise GasReportError(f"cannot read {label}: {error}") from error


def write_new_output(path: Path, root: Path, value: Any) -> None:
    deploy.require_external_mutable_path(path, root, "gas report output")
    if path.exists():
        raise GasReportError("refusing to overwrite an existing gas report output")
    deploy.atomic_write_json(path, value)


def validated_gas_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "safety_margin_bps",
        "measurements",
    }:
        raise GasReportError(
            "gas input must contain exactly safety_margin_bps and measurements"
        )
    margin = value["safety_margin_bps"]
    if (
        isinstance(margin, bool)
        or not isinstance(margin, int)
        or not 1000 <= margin <= 10_000
    ):
        raise GasReportError(
            "safety_margin_bps must be an integer between 1000 and 10000"
        )
    measurements = value["measurements"]
    if not isinstance(measurements, list) or len(measurements) != len(
        release.REQUIRED_GAS_CASES
    ):
        raise GasReportError("measurements must contain exactly seven records")
    cases = []
    for index, measurement in enumerate(measurements):
        if not isinstance(measurement, dict):
            raise GasReportError(f"measurement {index} must be an object")
        case = measurement.get("case")
        if not isinstance(case, str):
            raise GasReportError(f"measurement {index} case must be a string")
        cases.append(case)
    if len(set(cases)) != len(cases) or set(cases) != release.REQUIRED_GAS_CASES:
        raise GasReportError(
            "measurements must contain every required gas case exactly once"
        )
    return value


def build_payload(
    gas: dict[str, Any],
    config: dict[str, Any],
    *,
    measured_by: str,
    reviewed_by: str,
    measured_at: str,
    reviewed_at: str,
    methodology: str,
) -> dict[str, Any]:
    gas = validated_gas_input(gas)
    for label, value in (
        ("measured_by", measured_by),
        ("reviewed_by", reviewed_by),
        ("measured_at", measured_at),
        ("reviewed_at", reviewed_at),
        ("methodology", methodology),
    ):
        if not isinstance(value, str) or not value:
            raise GasReportError(f"{label} must be a nonempty string")
    if measured_by == reviewed_by:
        raise GasReportError("measurer and reviewer must be distinct")
    payload = {
        "schema_version": release.GAS_REPORT_SCHEMA,
        "status": "passed",
        "chain_id": config["chain"]["chain_id"],
        "config_sha256": deploy.config_hash(config),
        "source": config["source"],
        "safety_margin_bps": gas["safety_margin_bps"],
        "measurements_sha256": deploy.sha256_bytes(
            deploy.canonical_json(gas["measurements"])
        ),
        "measurement_cases": sorted(release.REQUIRED_GAS_CASES),
        "measured_by": measured_by,
        "reviewed_by": reviewed_by,
        "measured_at": measured_at,
        "reviewed_at": reviewed_at,
        "methodology": methodology,
    }
    return {
        **payload,
        "signed_payload_sha256": release.gas_report_payload_sha256(payload),
    }


def validate_prepared_payload(value: Any, config: dict[str, Any]) -> dict[str, Any]:
    expected_fields = {*release.GAS_REPORT_PAYLOAD_FIELDS, "signed_payload_sha256"}
    if not isinstance(value, dict) or set(value) != expected_fields:
        raise GasReportError("prepared payload has an unexpected shape")
    if (
        value["schema_version"] != release.GAS_REPORT_SCHEMA
        or value["status"] != "passed"
    ):
        raise GasReportError("prepared payload has an invalid schema or status")
    if value["chain_id"] != config["chain"]["chain_id"]:
        raise GasReportError("prepared payload chain_id does not match config")
    if (
        value["config_sha256"] != deploy.config_hash(config)
        or value["source"] != config["source"]
    ):
        raise GasReportError("prepared payload source does not match config")
    margin = value["safety_margin_bps"]
    if (
        isinstance(margin, bool)
        or not isinstance(margin, int)
        or not 1000 <= margin <= 10_000
    ):
        raise GasReportError("prepared payload safety margin is invalid")
    if not isinstance(value["measurements_sha256"], str) or not deploy.HEX_64.fullmatch(
        value["measurements_sha256"]
    ):
        raise GasReportError("prepared payload measurements hash is invalid")
    if value["measurement_cases"] != sorted(release.REQUIRED_GAS_CASES):
        raise GasReportError("prepared payload does not list every required gas case")
    if value["measured_by"] == value["reviewed_by"]:
        raise GasReportError("measurer and reviewer must be distinct")
    for field in (
        "measured_by",
        "reviewed_by",
        "measured_at",
        "reviewed_at",
        "methodology",
    ):
        if not isinstance(value[field], str) or not value[field]:
            raise GasReportError(f"prepared payload {field} must be nonempty")
    payload = {field: value[field] for field in release.GAS_REPORT_PAYLOAD_FIELDS}
    expected_hash = release.gas_report_payload_sha256(payload)
    if (
        not isinstance(value["signed_payload_sha256"], str)
        or not deploy.HEX_64.fullmatch(value["signed_payload_sha256"])
        or value["signed_payload_sha256"] != expected_hash
    ):
        raise GasReportError("prepared payload hash does not match its contents")
    return value


def finalize_report(
    prepared: Any, signatures: list[Any], config: dict[str, Any]
) -> dict[str, Any]:
    prepared = validate_prepared_payload(prepared, config)
    if len(signatures) != 2:
        raise GasReportError("exactly two signature records are required")
    expected_identities = {prepared["measured_by"], prepared["reviewed_by"]}
    observed_identities = set()
    normalized = []
    for index, signature in enumerate(signatures):
        if not isinstance(signature, dict) or set(signature) != {
            "identity",
            "payload_sha256",
            "method",
            "value",
        }:
            raise GasReportError(f"signature {index} has an unexpected shape")
        identity = signature["identity"]
        if not isinstance(identity, str) or not identity:
            raise GasReportError(f"signature {index} identity must be nonempty")
        if signature["payload_sha256"] != prepared["signed_payload_sha256"]:
            raise GasReportError(f"signature {index} does not bind the prepared payload")
        for field in ("method", "value"):
            if not isinstance(signature[field], str) or not signature[field]:
                raise GasReportError(f"signature {index} {field} must be nonempty")
        if identity in observed_identities:
            raise GasReportError("signature identities must be distinct")
        observed_identities.add(identity)
        normalized.append(signature)
    if observed_identities != expected_identities:
        raise GasReportError("signatures must be from the declared measurer and reviewer")
    return {**prepared, "signatures": normalized}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--root", type=Path, default=ROOT)
    result.add_argument("--config", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    commands = result.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare")
    prepare.add_argument("--gas-input", type=Path, required=True)
    prepare.add_argument("--measured-by", required=True)
    prepare.add_argument("--reviewed-by", required=True)
    prepare.add_argument("--measured-at", required=True)
    prepare.add_argument("--reviewed-at", required=True)
    prepare.add_argument("--methodology", required=True)

    finalize = commands.add_parser("finalize")
    finalize.add_argument(
        "--signature", type=Path, action="append", required=True, metavar="FILE"
    )
    finalize.add_argument("--payload", type=Path, required=True)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        root = args.root.resolve()
        config = deploy.load_config(args.config.resolve(), root)
        if args.command == "prepare":
            value = build_payload(
                read_json(args.gas_input, "gas input"),
                config,
                measured_by=args.measured_by,
                reviewed_by=args.reviewed_by,
                measured_at=args.measured_at,
                reviewed_at=args.reviewed_at,
                methodology=args.methodology,
            )
        else:
            value = finalize_report(
                read_json(args.payload, "prepared gas payload"),
                [
                    read_json(path, f"signature {index}")
                    for index, path in enumerate(args.signature)
                ],
                config,
            )
        write_new_output(args.output.resolve(), root, value)
    except (GasReportError, deploy.ValidationError, release.EvidenceError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
