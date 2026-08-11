#!/usr/bin/env python3
"""Capture standalone, validator-ready Juno Voice release evidence records."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deployment"))
sys.path.insert(0, str(ROOT / "integration"))
import juno_voice_deploy as deploy  # noqa: E402
import uni7_capture as chain  # noqa: E402
import release_manifest as release  # noqa: E402


class ReleaseCaptureError(ValueError):
    pass


def read_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseCaptureError(f"cannot read {label}: {error}") from error
    if not isinstance(value, dict) or not value:
        raise ReleaseCaptureError(f"{label} must be a nonempty JSON object")
    return value


def write_new_output(path: Path, root: Path, value: Any) -> None:
    deploy.require_external_mutable_path(path, root, "capture output")
    if path.exists():
        raise ReleaseCaptureError("refusing to overwrite an existing capture")
    deploy.atomic_write_json(path, value)


def capture_transaction(
    args: argparse.Namespace, config: dict[str, Any], expected_code: int
) -> dict[str, Any]:
    if expected_code < 0:
        raise ReleaseCaptureError("expected transaction code must be nonnegative")
    try:
        return chain.capture_transaction_record(
            args.junod,
            config,
            deploy.derive_addresses(config),
            args.tx_hash,
            expected_code,
        )
    except chain.CaptureError as error:
        raise ReleaseCaptureError(str(error)) from error


def validate_staking_message(
    record: dict[str, Any], kind: str, voter: str, config: dict[str, Any]
) -> None:
    expected_types = {
        "delegate": "/cosmos.staking.v1beta1.MsgDelegate",
        "undelegate": "/cosmos.staking.v1beta1.MsgUndelegate",
        "redelegate": "/cosmos.staking.v1beta1.MsgBeginRedelegate",
    }
    messages = record["messages"]
    if len(messages) != 1 or not isinstance(messages[0], dict):
        raise ReleaseCaptureError("staking capture must contain exactly one decoded message")
    message = messages[0]
    if message.get("@type") != expected_types[kind]:
        raise ReleaseCaptureError("staking message type does not match the declared kind")
    if message.get("delegator_address") != voter:
        raise ReleaseCaptureError("staking delegator does not match the declared voter")
    validator_fields = (
        ("validator_src_address", "validator_dst_address")
        if kind == "redelegate"
        else ("validator_address",)
    )
    validators = []
    for field in validator_fields:
        validator = message.get(field)
        try:
            deploy.decode_address(
                validator,
                f"{config['chain']['bech32_prefix']}valoper",
                f"staking message {field}",
            )
        except deploy.ValidationError as error:
            raise ReleaseCaptureError(str(error)) from error
        validators.append(validator)
    if len(validators) == 2 and validators[0] == validators[1]:
        raise ReleaseCaptureError("redelegation source and destination validators must differ")
    amount = message.get("amount")
    if not isinstance(amount, dict) or set(amount) != {"denom", "amount"}:
        raise ReleaseCaptureError("staking amount must contain denom and amount")
    if amount["denom"] != config["chain"]["native_denom"]:
        raise ReleaseCaptureError("staking amount does not use the configured native denom")
    if not isinstance(amount["amount"], str) or not re.fullmatch(
        r"[1-9][0-9]*", amount["amount"]
    ):
        raise ReleaseCaptureError("staking amount must be a positive canonical integer string")


def transaction_specs(values: list[str]) -> list[tuple[str, int]]:
    result = []
    for index, value in enumerate(values):
        parts = value.split(":")
        if len(parts) != 2:
            raise ReleaseCaptureError(
                f"transaction {index} must use UPPERCASE_HASH:EXPECTED_CODE"
            )
        transaction_hash, raw_code = parts
        try:
            code = int(raw_code)
        except ValueError as error:
            raise ReleaseCaptureError(f"transaction {index} code is not an integer") from error
        if code < 0:
            raise ReleaseCaptureError(f"transaction {index} code must be nonnegative")
        result.append((transaction_hash, code))
    return result


def command_transaction(args: argparse.Namespace, config: dict[str, Any]) -> Any:
    return capture_transaction(args, config, args.expected_code)


def command_smart_query(args: argparse.Namespace, config: dict[str, Any]) -> Any:
    addresses = chain.logical_addresses(config)
    if args.contract not in addresses:
        raise ReleaseCaptureError(f"unknown logical contract {args.contract!r}")
    query = read_object(args.query_file, "smart query")
    try:
        record = chain.capture_smart_query_record(
            args.junod,
            config,
            addresses[args.contract],
            query,
            args.height,
        )
    except chain.CaptureError as error:
        raise ReleaseCaptureError(str(error)) from error
    record["observed_at_height"] = record.pop("height")
    if args.name is not None:
        record = {"name": args.name, **record}
    return record


def command_staking_change(args: argparse.Namespace, config: dict[str, Any]) -> Any:
    try:
        deploy.decode_address(
            args.voter,
            config["chain"]["bech32_prefix"],
            "voter",
        )
    except deploy.ValidationError as error:
        raise ReleaseCaptureError(str(error)) from error
    record = capture_transaction(args, config, 0)
    validate_staking_message(record, args.kind, args.voter, config)
    return {
        "hash": record["hash"],
        "height": record["height"],
        "kind": args.kind,
        "transaction_evidence": record,
    }


def command_canary_epoch(args: argparse.Namespace, config: dict[str, Any]) -> Any:
    record = capture_transaction(args, config, 0)
    gauge = deploy.derive_addresses(config)["gauge"]
    query = {"epoch": {"gauge": args.gauge_id, "epoch": args.epoch_id}}
    try:
        query_record = chain.capture_smart_query_record(
            args.junod, config, gauge, query, args.query_height
        )
    except chain.CaptureError as error:
        raise ReleaseCaptureError(str(error)) from error
    query_record["observed_at_height"] = query_record.pop("height")
    return {
        "epoch": args.epoch_id,
        "snapshot_height": args.snapshot_height,
        "outcome": "distributed",
        "distributed_value": args.distributed_value,
        "transaction": record["hash"],
        "transaction_evidence": record,
        "epoch_query": query_record,
    }


def command_rehearsal_transactions(
    args: argparse.Namespace, config: dict[str, Any]
) -> Any:
    specs = transaction_specs(args.transaction)
    captures = []
    transactions = []
    for transaction_hash, code in specs:
        capture_args = argparse.Namespace(
            tx_hash=transaction_hash,
            junod=args.junod,
        )
        record = capture_transaction(capture_args, config, code)
        transactions.append(record["hash"])
        captures.append(record)
    successful = sum(record["code"] == 0 for record in captures)
    failed = len(captures) - successful
    profile = release.OPERATIONAL_REHEARSAL_CODE_PROFILES[args.case]
    if (
        successful < profile["minimum_successes"]
        or failed < profile["minimum_failures"]
    ):
        raise ReleaseCaptureError(
            "captured transactions do not satisfy the rehearsal success/rejection profile"
        )
    return {
        "case": args.case,
        "transactions": transactions,
        "transaction_evidence": captures,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--root", type=Path, default=ROOT)
    result.add_argument("--config", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--junod", default="junod")
    commands = result.add_subparsers(dest="command", required=True)

    transaction = commands.add_parser("transaction")
    transaction.add_argument("--tx-hash", required=True)
    transaction.add_argument("--expected-code", type=int, default=0)

    query = commands.add_parser("smart-query")
    query.add_argument("--contract", required=True)
    query.add_argument("--query-file", type=Path, required=True)
    query.add_argument("--height", type=int)
    query.add_argument("--name")

    staking = commands.add_parser("staking-change")
    staking.add_argument("--tx-hash", required=True)
    staking.add_argument(
        "--kind", choices=("delegate", "undelegate", "redelegate"), required=True
    )
    staking.add_argument("--voter", required=True)

    canary = commands.add_parser("canary-epoch")
    canary.add_argument("--tx-hash", required=True)
    canary.add_argument("--gauge-id", type=int, required=True)
    canary.add_argument("--epoch-id", type=int, required=True)
    canary.add_argument("--snapshot-height", type=int, required=True)
    canary.add_argument("--distributed-value", type=int, required=True)
    canary.add_argument("--query-height", type=int)

    rehearsal = commands.add_parser("rehearsal-transactions")
    rehearsal.add_argument(
        "--case", choices=sorted(release.REQUIRED_OPERATIONAL_REHEARSALS), required=True
    )
    rehearsal.add_argument(
        "--transaction", action="append", required=True, metavar="HASH:CODE"
    )
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        root = args.root.resolve()
        config = deploy.load_config(args.config.resolve(), root)
        output = args.output.resolve()
        if args.command == "transaction":
            value = command_transaction(args, config)
        elif args.command == "smart-query":
            value = command_smart_query(args, config)
        elif args.command == "staking-change":
            value = command_staking_change(args, config)
        elif args.command == "canary-epoch":
            for field in ("gauge_id", "epoch_id", "snapshot_height", "distributed_value"):
                if getattr(args, field) <= 0 and field != "gauge_id":
                    raise ReleaseCaptureError(f"{field.replace('_', '-')} must be positive")
                if field == "gauge_id" and getattr(args, field) < 0:
                    raise ReleaseCaptureError("gauge-id must be nonnegative")
            value = command_canary_epoch(args, config)
        else:
            value = command_rehearsal_transactions(args, config)
        write_new_output(output, root, value)
    except (ReleaseCaptureError, deploy.ValidationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
