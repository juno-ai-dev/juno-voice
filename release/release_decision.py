#!/usr/bin/env python3
"""Prepare and finalize the multi-role testnet release decision."""

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


class ReleaseDecisionError(ValueError):
    pass


EVIDENCE_FIELDS = (
    "schema_version",
    "build_manifest",
    "deployment_verification",
    "upstream_review",
    "security_review",
    "public_testnet",
    "gas",
    "canary",
    "runbooks",
    "operations_rehearsal",
    "release_signoff",
)


def read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseDecisionError(f"cannot read {label}: {error}") from error


def write_new_output(path: Path, root: Path, value: Any) -> None:
    deploy.require_external_mutable_path(path, root, "release decision output")
    if path.exists():
        raise ReleaseDecisionError(
            "refusing to overwrite an existing release decision output"
        )
    deploy.atomic_write_json(path, value)


def decision_signers(value: Any) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(value, dict) or set(value) != {
        "maintainers",
        "security_reviewer",
        "operations_reviewer",
    }:
        raise ReleaseDecisionError("decision signers have an unexpected shape")
    maintainers = value["maintainers"]
    if (
        not isinstance(maintainers, list)
        or len(maintainers) < 2
        or any(not isinstance(item, str) or not item for item in maintainers)
        or len(set(maintainers)) != len(maintainers)
    ):
        raise ReleaseDecisionError("decision requires at least two distinct maintainers")
    security = value["security_reviewer"]
    operations = value["operations_reviewer"]
    if not isinstance(security, str) or not security:
        raise ReleaseDecisionError("security reviewer must be nonempty")
    if not isinstance(operations, str) or not operations:
        raise ReleaseDecisionError("operations reviewer must be nonempty")
    identities = [*maintainers, security, operations]
    if len(set(identities)) != len(identities):
        raise ReleaseDecisionError("all release decision identities must be distinct")
    return value, identities


def build_payload(
    evidence: Any, config: dict[str, Any], *, decided_at: str
) -> dict[str, Any]:
    if not isinstance(evidence, dict) or set(evidence) != set(EVIDENCE_FIELDS):
        raise ReleaseDecisionError("release evidence has an unexpected top-level shape")
    if evidence["schema_version"] != release.EVIDENCE_SCHEMA:
        raise ReleaseDecisionError("release evidence schema version is invalid")
    signoff = evidence["release_signoff"]
    allowed_signoff_shapes = (
        set(release.RELEASE_SIGNOFF_REVIEW_FIELDS),
        {*release.RELEASE_SIGNOFF_REVIEW_FIELDS, "decision"},
    )
    if not isinstance(signoff, dict) or set(signoff) not in allowed_signoff_shapes:
        raise ReleaseDecisionError("release sign-off has an unexpected shape")
    if signoff["status"] != "approved_testnet_candidate":
        raise ReleaseDecisionError("release sign-off status is not approved")
    signers, _identities = decision_signers(
        {
            "maintainers": signoff["maintainers"],
            "security_reviewer": signoff["security_reviewer"],
            "operations_reviewer": signoff["operations_reviewer"],
        }
    )
    if not isinstance(decided_at, str) or not decided_at:
        raise ReleaseDecisionError("decided_at must be a nonempty string")
    try:
        bound_evidence = release.release_decision_bound_evidence(evidence)
    except (KeyError, TypeError) as error:
        raise ReleaseDecisionError(
            "release evidence is missing a required content hash"
        ) from error
    for field, value in bound_evidence.items():
        if not isinstance(value, str) or not deploy.HEX_64.fullmatch(value):
            raise ReleaseDecisionError(f"bound evidence {field} is not SHA-256")
    payload = {
        "schema_version": release.RELEASE_DECISION_SCHEMA,
        "status": "approved_testnet_candidate",
        "authorization": "testnet_release_candidate_only",
        "production_authorized": False,
        "chain_id": config["chain"]["chain_id"],
        "config_sha256": deploy.config_hash(config),
        "source": config["source"],
        "bound_evidence": bound_evidence,
        "signers": signers,
        "decided_at": decided_at,
    }
    return {
        **payload,
        "signed_payload_sha256": release.release_decision_payload_sha256(payload),
    }


def validate_prepared_payload(value: Any, config: dict[str, Any]) -> dict[str, Any]:
    expected_fields = {
        *release.RELEASE_DECISION_PAYLOAD_FIELDS,
        "signed_payload_sha256",
    }
    if not isinstance(value, dict) or set(value) != expected_fields:
        raise ReleaseDecisionError("prepared decision has an unexpected shape")
    for field, expected in (
        ("schema_version", release.RELEASE_DECISION_SCHEMA),
        ("status", "approved_testnet_candidate"),
        ("authorization", "testnet_release_candidate_only"),
        ("production_authorized", False),
        ("chain_id", config["chain"]["chain_id"]),
        ("config_sha256", deploy.config_hash(config)),
        ("source", config["source"]),
    ):
        if value[field] != expected:
            raise ReleaseDecisionError(f"prepared decision {field} is invalid")
    if not isinstance(value["bound_evidence"], dict) or set(
        value["bound_evidence"]
    ) != set(release.RELEASE_DECISION_EVIDENCE_FIELDS):
        raise ReleaseDecisionError("prepared decision evidence binding is incomplete")
    for field, checksum in value["bound_evidence"].items():
        if not isinstance(checksum, str) or not deploy.HEX_64.fullmatch(checksum):
            raise ReleaseDecisionError(f"prepared decision {field} is not SHA-256")
    decision_signers(value["signers"])
    if not isinstance(value["decided_at"], str) or not value["decided_at"]:
        raise ReleaseDecisionError("prepared decision decided_at must be nonempty")
    expected_hash = release.release_decision_payload_sha256(value)
    if value["signed_payload_sha256"] != expected_hash:
        raise ReleaseDecisionError("prepared decision hash does not match its contents")
    return value


def finalize_decision(
    prepared: Any, signatures: list[Any], config: dict[str, Any]
) -> dict[str, Any]:
    prepared = validate_prepared_payload(prepared, config)
    _signers, expected_identities = decision_signers(prepared["signers"])
    if len(signatures) != len(expected_identities):
        raise ReleaseDecisionError("one signature per release signer is required")
    observed_identities = set()
    normalized = []
    for index, signature in enumerate(signatures):
        if not isinstance(signature, dict) or set(signature) != {
            "identity",
            "payload_sha256",
            "method",
            "value",
        }:
            raise ReleaseDecisionError(f"signature {index} has an unexpected shape")
        identity = signature["identity"]
        if not isinstance(identity, str) or not identity:
            raise ReleaseDecisionError(f"signature {index} identity must be nonempty")
        if identity in observed_identities:
            raise ReleaseDecisionError("signature identities must be distinct")
        observed_identities.add(identity)
        if signature["payload_sha256"] != prepared["signed_payload_sha256"]:
            raise ReleaseDecisionError(f"signature {index} does not bind the decision")
        for field in ("method", "value"):
            if not isinstance(signature[field], str) or not signature[field]:
                raise ReleaseDecisionError(f"signature {index} {field} must be nonempty")
        normalized.append(signature)
    if observed_identities != set(expected_identities):
        raise ReleaseDecisionError("signatures do not cover every release signer")
    return {**prepared, "signatures": normalized}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--root", type=Path, default=ROOT)
    result.add_argument("--config", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    commands = result.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare")
    prepare.add_argument("--evidence", type=Path, required=True)
    prepare.add_argument("--decided-at", required=True)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--payload", type=Path, required=True)
    finalize.add_argument(
        "--signature", type=Path, action="append", required=True, metavar="FILE"
    )
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        root = args.root.resolve()
        config = deploy.load_config(args.config.resolve(), root)
        if args.command == "prepare":
            evidence = read_json(args.evidence, "release evidence")
            release.validate_evidence(
                evidence,
                root,
                config,
                require_release_decision=False,
            )
            value = build_payload(
                evidence,
                config,
                decided_at=args.decided_at,
            )
        else:
            value = finalize_decision(
                read_json(args.payload, "prepared release decision"),
                [
                    read_json(path, f"signature {index}")
                    for index, path in enumerate(args.signature)
                ],
                config,
            )
        write_new_output(args.output.resolve(), root, value)
    except (ReleaseDecisionError, deploy.ValidationError, release.EvidenceError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
