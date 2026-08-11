#!/usr/bin/env python3
"""Capture exact-chain Juno Voice scenario evidence from a junod endpoint."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "deployment"))
sys.path.insert(0, str(REPOSITORY_ROOT / "release"))
import juno_voice_deploy as deploy  # noqa: E402
import release_manifest as release  # noqa: E402

SCENARIOS = set(release.REQUIRED_SCENARIOS)
TX_HASH = re.compile(r"^[0-9A-F]{64}$")


class CaptureError(ValueError):
    pass


def command_json(binary: str, args: list[str]) -> Any:
    completed = subprocess.run([binary, *args], check=False, capture_output=True, text=True)
    if completed.returncode:
        raise CaptureError(f"junod failed: {completed.stderr.strip()}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise CaptureError("junod returned non-JSON output") from error


def load_transcript(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise CaptureError(f"cannot read transcript {path}: {error}") from error
    if value.get("schema_version") != "juno-voice/uni7-scenario-transcript/v1":
        raise CaptureError("transcript schema is invalid")
    if value.get("passed") is True:
        raise CaptureError("finalized transcript is immutable")
    return value


def chain_args(config: dict[str, Any]) -> list[str]:
    return ["--node", config["chain"]["rpc"], "--chain-id", config["chain"]["chain_id"]]


def logical_addresses(config: dict[str, Any]) -> dict[str, str]:
    values = deploy.derive_addresses(config)
    agent = config["agent_operations"]
    values.update(
        {
            "agent_voting_module": agent["voting_module_address"],
            "agent_proposal_module": agent["proposal_module_address"],
            "agent_membership_contract": (
                agent["membership"]["group_address"]
                if agent["membership"]["kind"] == "cw4"
                else agent["membership"]["nft_address"]
            ),
        }
    )
    return values


def tx_response(value: dict[str, Any]) -> dict[str, Any]:
    return value.get("tx_response", value)


def transaction_messages(response: dict[str, Any], tx: dict[str, Any]) -> list[Any]:
    for candidate in (tx, response, response.get("tx_response", {})):
        messages = candidate.get("tx", {}).get("body", {}).get("messages")
        if isinstance(messages, list):
            return messages
    raise CaptureError("transaction response did not contain decoded messages")


def parse_positive(value: Any, field: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise CaptureError(f"{field} is not an integer") from error
    if result <= 0:
        raise CaptureError(f"{field} must be positive")
    return result


def parse_nonnegative(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise CaptureError(f"{field} is not an integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise CaptureError(f"{field} is not an integer") from error
    if result < 0:
        raise CaptureError(f"{field} must be nonnegative")
    return result


def read_json(path: Path, field: str) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise CaptureError(f"cannot read {field} JSON: {error}") from error


def transaction_evidence(transcript: dict[str, Any], transaction_hash: str) -> dict[str, Any]:
    if not isinstance(transaction_hash, str) or not TX_HASH.fullmatch(transaction_hash):
        raise CaptureError("assertion transaction hash must be 64 uppercase hexadecimal characters")
    matches = [
        item
        for item in transcript["transaction_evidence"]
        if item.get("hash") == transaction_hash
    ]
    if len(matches) != 1:
        raise CaptureError("assertion must reference exactly one captured transaction")
    return matches[0]


def event_has_attributes(event: Any, expected: dict[str, str]) -> bool:
    if not isinstance(event, dict) or not isinstance(event.get("attributes"), list):
        return False
    observed = {
        (item.get("key"), item.get("value"))
        for item in event["attributes"]
        if isinstance(item, dict)
    }
    return all((key, value) in observed for key, value in expected.items())


def assertion_source(
    source: Any, expected_keys: set[str], predicate: str
) -> dict[str, Any]:
    if not isinstance(source, dict) or set(source) != expected_keys:
        raise CaptureError(f"assertion source has invalid fields for {predicate}")
    return source


def assertion_index(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CaptureError(f"{field} must be a nonnegative integer")
    return value


def resolve_assertion_actual(
    transcript: dict[str, Any], predicate: str, source: dict[str, Any]
) -> Any:
    try:
        if predicate == "query_response_equals":
            source = assertion_source(source, {"query_index"}, predicate)
            index = assertion_index(source["query_index"], "query_index")
            return transcript["queries"][index]["response"]
        if predicate == "balance_delta_equals":
            source = assertion_source(source, {"before_index", "after_index"}, predicate)
            before_index = assertion_index(source["before_index"], "before_index")
            after_index = assertion_index(source["after_index"], "after_index")
            before = transcript["balances"][before_index]
            after = transcript["balances"][after_index]
            if before["address"] != after["address"] or before["denom"] != after["denom"]:
                raise CaptureError("balance assertion observations use different address or denom")
            if before["height"] >= after["height"]:
                raise CaptureError("balance assertion after height must be later than before")
            transaction_heights = [
                item["height"] for item in transcript["transaction_evidence"]
            ]
            if before["height"] >= min(transaction_heights) or after["height"] < max(
                transaction_heights
            ):
                raise CaptureError("balance observations must bracket all scenario transactions")
            return str(int(after["amount"]) - int(before["amount"]))
        if predicate in ("transaction_event_equals", "transaction_message_equals"):
            index_field = (
                "event_index" if predicate == "transaction_event_equals" else "message_index"
            )
            source = assertion_source(
                source, {"transaction_hash", index_field}, predicate
            )
            transaction = transaction_evidence(transcript, source["transaction_hash"])
            field = "events" if predicate == "transaction_event_equals" else "messages"
            index = assertion_index(source[index_field], index_field)
            return transaction[field][index]
        if predicate == "matching_events_equal":
            source = assertion_source(
                source,
                {"transaction_hashes", "event_type", "attributes"},
                predicate,
            )
            hashes = source["transaction_hashes"]
            if not isinstance(hashes, list) or not hashes or len(set(hashes)) != len(hashes):
                raise CaptureError("matching-event transaction hashes must be nonempty and distinct")
            if not isinstance(source["event_type"], str) or not source["event_type"]:
                raise CaptureError("matching-event type must be nonempty")
            attributes = source["attributes"]
            if (
                not isinstance(attributes, dict)
                or not attributes
                or any(
                    not isinstance(key, str) or not isinstance(value, str)
                    for key, value in attributes.items()
                )
            ):
                raise CaptureError("matching-event attributes must be a nonempty string map")
            matches = []
            for transaction_hash in hashes:
                transaction = transaction_evidence(transcript, transaction_hash)
                for event_index, event in enumerate(transaction["events"]):
                    if (
                        isinstance(event, dict)
                        and event.get("type") == source["event_type"]
                        and event_has_attributes(event, attributes)
                    ):
                        matches.append(
                            {
                                "transaction_hash": transaction_hash,
                                "event_index": event_index,
                                "event": event,
                            }
                        )
            return matches
        if predicate == "transaction_code_equals":
            source = assertion_source(source, {"transaction_hash"}, predicate)
            return transaction_evidence(transcript, source["transaction_hash"])["code"]
    except (IndexError, KeyError, TypeError, ValueError) as error:
        raise CaptureError(f"assertion source is invalid for {predicate}: {error}") from error
    raise CaptureError(f"unsupported linked assertion predicate {predicate!r}")


def append_assertion(
    args: argparse.Namespace,
    transcript: dict[str, Any],
    predicate: str,
    source: dict[str, Any],
    expected: Any,
) -> None:
    if any(item.get("name") == args.name for item in transcript["assertions"]):
        raise CaptureError("assertion name is duplicated")
    source_identity = (predicate, deploy.canonical_json(source))
    if any(
        (item.get("predicate"), deploy.canonical_json(item.get("source")))
        == source_identity
        for item in transcript["assertions"]
    ):
        raise CaptureError("assertion source is already used")
    actual = resolve_assertion_actual(transcript, predicate, source)
    transcript["assertions"].append(
        {
            "name": args.name,
            "predicate": predicate,
            "source": source,
            "expected": expected,
            "actual": actual,
            "passed": deploy.canonical_json(expected) == deploy.canonical_json(actual),
        }
    )
    deploy.atomic_write_json(args.transcript, transcript)


def latest_height(binary: str, config: dict[str, Any]) -> int:
    status = command_json(binary, ["status", "--node", config["chain"]["rpc"]])
    sync = status.get("sync_info") or status.get("SyncInfo") or status.get("result", {}).get("sync_info", {})
    return parse_positive(sync.get("latest_block_height"), "latest block height")


def command_init(args: argparse.Namespace, config: dict[str, Any], state: dict[str, Any]) -> None:
    if args.scenario not in SCENARIOS:
        raise CaptureError("unknown required scenario")
    if args.transcript.exists():
        raise CaptureError("refusing to overwrite an existing transcript")
    if set(state["code_ids"]) != set(deploy.REQUIRED_ARTIFACTS):
        raise CaptureError("deployment state does not contain all five code IDs")
    verification = state.get("verified", {})
    if not isinstance(verification, dict) or "sha256" not in verification:
        raise CaptureError("deployment state is not chain-verified")
    transcript = {
        "schema_version": "juno-voice/uni7-scenario-transcript/v1",
        "scenario_id": args.scenario,
        "chain_id": config["chain"]["chain_id"],
        "config_sha256": deploy.config_hash(config),
        "code_checksums": {
            name: item["sha256"] for name, item in config["artifacts"].items()
        },
        "code_ids": state["code_ids"],
        "addresses": deploy.derive_addresses(config),
        "mock_components": [],
        "transactions": [],
        "transaction_evidence": [],
        "queries": [],
        "balances": [],
        "assertions": [],
        "passed": False,
    }
    deploy.atomic_write_json(args.transcript, transcript)


def capture_transaction_record(
    binary: str,
    config: dict[str, Any],
    addresses: dict[str, str],
    transaction_hash: str,
    expected_code: int,
) -> dict[str, Any]:
    tx_hash = transaction_hash.upper()
    if not TX_HASH.fullmatch(tx_hash):
        raise CaptureError("transaction hash must be 64 hexadecimal characters")
    response = command_json(
        binary,
        ["query", "tx", tx_hash, "--node", config["chain"]["rpc"], "--output", "json"],
    )
    if not isinstance(response, dict):
        raise CaptureError("transaction query returned a non-object response")
    tx = tx_response(response)
    if not isinstance(tx, dict):
        raise CaptureError("transaction query returned a malformed tx_response")
    code = parse_nonnegative(tx.get("code", 0), "transaction code")
    if code != expected_code:
        raise CaptureError(
            f"transaction code {code} does not match expected code {expected_code}"
        )
    reported_hash = str(tx.get("txhash", tx_hash)).upper()
    if reported_hash != tx_hash:
        raise CaptureError("query returned a different transaction hash")
    events = tx.get("events")
    if not isinstance(events, list) or not events:
        raise CaptureError("transaction response did not contain emitted events")
    try:
        for index, event in enumerate(events):
            release.validate_transaction_event(event, f"transaction.events[{index}]")
    except release.EvidenceError as error:
        raise CaptureError(str(error)) from error
    messages = transaction_messages(response, tx)
    if not messages:
        raise CaptureError("transaction response did not contain any messages")
    try:
        allowed_contracts = release.allowed_scenario_contracts(
            config, addresses
        )
        for index, message in enumerate(messages):
            release.validate_transaction_message(
                message, allowed_contracts, f"transaction.messages[{index}]"
            )
    except release.EvidenceError as error:
        raise CaptureError(str(error)) from error
    return {
        "hash": tx_hash,
        "height": parse_positive(tx.get("height"), "transaction height"),
        "code": code,
        "gas_wanted": parse_positive(tx.get("gas_wanted"), "gas_wanted"),
        "gas_used": parse_positive(tx.get("gas_used"), "gas_used"),
        "response_sha256": deploy.sha256_bytes(deploy.canonical_json(response)),
        "response": response,
        "messages": messages,
        "events": events,
    }


def command_capture_tx(args: argparse.Namespace, config: dict[str, Any], transcript: dict[str, Any]) -> None:
    tx_hash = args.tx_hash.upper()
    if tx_hash in transcript["transactions"]:
        raise CaptureError("transaction is already captured")
    record = capture_transaction_record(
        args.junod,
        config,
        transcript["addresses"],
        tx_hash,
        args.expected_code,
    )
    transcript["transactions"].append(tx_hash)
    transcript["transaction_evidence"].append(record)
    deploy.atomic_write_json(args.transcript, transcript)


def capture_smart_query_record(
    binary: str,
    config: dict[str, Any],
    contract: str,
    query: dict[str, Any],
    height: int | None,
) -> dict[str, Any]:
    if not isinstance(query, dict) or not query:
        raise CaptureError("smart query must be a nonempty JSON object")
    observed_height = (
        latest_height(binary, config)
        if height is None
        else parse_positive(height, "query height")
    )
    response = command_json(
        binary,
        [
            "query",
            "wasm",
            "contract-state",
            "smart",
            contract,
            deploy.canonical_json(query).decode(),
            "--height",
            str(observed_height),
            "--node",
            config["chain"]["rpc"],
            "--output",
            "json",
        ],
    )
    if not isinstance(response, dict):
        raise CaptureError("smart query returned a non-object response")
    data = response.get("data", response)
    return {
        "height": observed_height,
        "contract": contract,
        "query": query,
        "response": data,
        "response_sha256": deploy.sha256_bytes(deploy.canonical_json(data)),
    }


def command_capture_query(args: argparse.Namespace, config: dict[str, Any], transcript: dict[str, Any]) -> None:
    addresses = logical_addresses(config)
    if args.contract not in addresses:
        raise CaptureError(f"unknown logical contract {args.contract!r}")
    try:
        query = json.loads(args.query_file.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise CaptureError(f"cannot read smart query: {error}") from error
    record = capture_smart_query_record(
        args.junod,
        config,
        addresses[args.contract],
        query,
        args.height,
    )
    transcript["queries"].append(record)
    deploy.atomic_write_json(args.transcript, transcript)


def command_capture_balance(args: argparse.Namespace, config: dict[str, Any], transcript: dict[str, Any]) -> None:
    deploy.decode_address(args.address, config["chain"]["bech32_prefix"], "address")
    height = (
        latest_height(args.junod, config)
        if args.height is None
        else parse_positive(args.height, "balance height")
    )
    response = command_json(
        args.junod,
        [
            "query",
            "bank",
            "balances",
            args.address,
            "--height",
            str(height),
            "--node",
            config["chain"]["rpc"],
            "--output",
            "json",
        ],
    )
    if not isinstance(response, dict):
        raise CaptureError("bank query returned a non-object response")
    amount = "0"
    for coin in response.get("balances", []):
        if coin.get("denom") == deploy.DENOM:
            amount = str(coin.get("amount"))
    if not re.fullmatch(r"0|[1-9][0-9]*", amount):
        raise CaptureError("bank response contained a noncanonical ujuno amount")
    transcript["balances"].append(
        {
            "label": args.label,
            "height": height,
            "address": args.address,
            "denom": deploy.DENOM,
            "amount": amount,
        }
    )
    deploy.atomic_write_json(args.transcript, transcript)


def command_assert_query(args: argparse.Namespace, transcript: dict[str, Any]) -> None:
    append_assertion(
        args,
        transcript,
        "query_response_equals",
        {"query_index": args.query_index},
        read_json(args.expected, "expected query response"),
    )


def command_assert_balance_delta(args: argparse.Namespace, transcript: dict[str, Any]) -> None:
    if not re.fullmatch(r"-?(0|[1-9][0-9]*)", args.expected_delta) or args.expected_delta == "-0":
        raise CaptureError("expected balance delta must be a canonical integer string")
    append_assertion(
        args,
        transcript,
        "balance_delta_equals",
        {"before_index": args.before_index, "after_index": args.after_index},
        args.expected_delta,
    )


def command_assert_transaction_item(
    args: argparse.Namespace, transcript: dict[str, Any], item: str
) -> None:
    predicate = "transaction_event_equals" if item == "event" else "transaction_message_equals"
    source = {
        "transaction_hash": args.tx_hash.upper(),
        f"{item}_index": getattr(args, f"{item}_index"),
    }
    append_assertion(
        args,
        transcript,
        predicate,
        source,
        read_json(args.expected, f"expected transaction {item}"),
    )


def command_assert_matching_events(args: argparse.Namespace, transcript: dict[str, Any]) -> None:
    transaction_hashes = [value.upper() for value in args.tx_hash]
    if len(set(transaction_hashes)) != len(transaction_hashes):
        raise CaptureError("matching-event transaction hashes must be distinct")
    attributes = read_json(args.attributes, "event attributes")
    if (
        not isinstance(attributes, dict)
        or not attributes
        or any(not isinstance(key, str) or not isinstance(value, str) for key, value in attributes.items())
    ):
        raise CaptureError("event attributes must be a nonempty string map")
    append_assertion(
        args,
        transcript,
        "matching_events_equal",
        {
            "transaction_hashes": transaction_hashes,
            "event_type": args.event_type,
            "attributes": attributes,
        },
        read_json(args.expected, "expected matching events"),
    )


def command_assert_tx_code(args: argparse.Namespace, transcript: dict[str, Any]) -> None:
    append_assertion(
        args,
        transcript,
        "transaction_code_equals",
        {"transaction_hash": args.tx_hash.upper()},
        args.expected_code,
    )


def command_finalize(args: argparse.Namespace, transcript: dict[str, Any]) -> None:
    if not any(item.get("code") == 0 for item in transcript["transaction_evidence"]):
        raise CaptureError("at least one successful transaction is required")
    if not transcript["queries"]:
        raise CaptureError("at least one exact-height smart query is required")
    for index, transaction in enumerate(transcript["transaction_evidence"]):
        if not transaction.get("messages") or not transaction.get("events"):
            raise CaptureError(
                f"transaction evidence {index} must contain decoded messages and emitted events"
            )
    if len(transcript["balances"]) < 2:
        raise CaptureError("at least two balance observations are required")
    if not transcript["assertions"]:
        raise CaptureError("at least one linked machine assertion is required")
    observed_profile = {
        item.get("name"): item.get("predicate") for item in transcript["assertions"]
    }
    expected_profile = release.REQUIRED_SCENARIO_ASSERTIONS.get(transcript["scenario_id"])
    if observed_profile != expected_profile or len(observed_profile) != len(
        transcript["assertions"]
    ):
        raise CaptureError("assertions do not match the required scenario proof profile")
    source_identities: set[tuple[str, bytes]] = set()
    for index, assertion in enumerate(transcript["assertions"]):
        source_identity = (
            assertion.get("predicate"),
            deploy.canonical_json(assertion.get("source")),
        )
        if source_identity in source_identities:
            raise CaptureError(f"assertion {index} reuses another assertion source")
        source_identities.add(source_identity)
        actual = resolve_assertion_actual(
            transcript, assertion.get("predicate"), assertion.get("source")
        )
        try:
            release.validate_named_event_proof(
                transcript,
                assertion.get("name"),
                assertion.get("predicate"),
                assertion.get("source"),
                actual,
                f"assertion {index}",
            )
            release.validate_named_query_proof(
                transcript,
                assertion.get("name"),
                assertion.get("predicate"),
                assertion.get("source"),
                actual,
                f"assertion {index}",
            )
        except release.EvidenceError as error:
            raise CaptureError(str(error)) from error
        if deploy.canonical_json(assertion.get("actual")) != deploy.canonical_json(actual):
            raise CaptureError(f"assertion {index} actual does not match linked evidence")
        passed = deploy.canonical_json(assertion.get("expected")) == deploy.canonical_json(actual)
        if assertion.get("passed") is not passed or not passed:
            raise CaptureError(f"assertion {index} does not pass linked evidence comparison")
        name = assertion.get("name")
        if name in release.POSITIVE_BALANCE_ASSERTIONS and int(actual) <= 0:
            raise CaptureError(f"assertion {index} does not prove a positive balance delta")
        if name in release.ZERO_BALANCE_ASSERTIONS and actual != "0":
            raise CaptureError(f"assertion {index} does not prove an unchanged balance")
        if name in release.EMPTY_EVENT_ASSERTIONS and actual != []:
            raise CaptureError(f"assertion {index} found prohibited matching events")
        if name == "refund_events" and not actual:
            raise CaptureError(f"assertion {index} does not prove a refund event")
        if name == "agent_resume_rejected" and actual == 0:
            raise CaptureError(f"assertion {index} does not prove a failed transaction")
        if assertion.get("predicate") == "matching_events_equal" and set(
            assertion["source"]["transaction_hashes"]
        ) != set(transcript["transactions"]):
            raise CaptureError(
                f"assertion {index} does not scan every scenario transaction"
            )
    try:
        release.validate_scenario_query_relationships(
            transcript,
            transcript["scenario_id"],
            "scenario assertions",
        )
    except release.EvidenceError as error:
        raise CaptureError(str(error)) from error
    transcript["passed"] = True
    deploy.atomic_write_json(args.transcript, transcript)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    result.add_argument("--config", type=Path, required=True)
    result.add_argument("--state", type=Path, required=True)
    result.add_argument("--transcript", type=Path, required=True)
    result.add_argument("--junod", default="junod")
    subcommands = result.add_subparsers(dest="command", required=True)
    init = subcommands.add_parser("init")
    init.add_argument("--scenario", required=True)
    init.set_defaults(action="init")
    capture_tx = subcommands.add_parser("capture-tx")
    capture_tx.add_argument("--tx-hash", required=True)
    capture_tx.add_argument("--expected-code", type=int, default=0)
    capture_tx.set_defaults(action="capture_tx")
    capture_query = subcommands.add_parser("capture-query")
    capture_query.add_argument("--contract", required=True)
    capture_query.add_argument("--query-file", type=Path, required=True)
    capture_query.add_argument("--height", type=int)
    capture_query.set_defaults(action="capture_query")
    capture_balance = subcommands.add_parser("capture-balance")
    capture_balance.add_argument("--label", required=True)
    capture_balance.add_argument("--address", required=True)
    capture_balance.add_argument("--height", type=int)
    capture_balance.set_defaults(action="capture_balance")
    assert_query = subcommands.add_parser("assert-query")
    assert_query.add_argument("--name", required=True)
    assert_query.add_argument("--query-index", type=int, required=True)
    assert_query.add_argument("--expected", type=Path, required=True)
    assert_query.set_defaults(action="assert_query")
    assert_balance = subcommands.add_parser("assert-balance-delta")
    assert_balance.add_argument("--name", required=True)
    assert_balance.add_argument("--before-index", type=int, required=True)
    assert_balance.add_argument("--after-index", type=int, required=True)
    assert_balance.add_argument("--expected-delta", required=True)
    assert_balance.set_defaults(action="assert_balance_delta")
    assert_event = subcommands.add_parser("assert-event")
    assert_event.add_argument("--name", required=True)
    assert_event.add_argument("--tx-hash", required=True)
    assert_event.add_argument("--event-index", type=int, required=True)
    assert_event.add_argument("--expected", type=Path, required=True)
    assert_event.set_defaults(action="assert_event")
    assert_message = subcommands.add_parser("assert-message")
    assert_message.add_argument("--name", required=True)
    assert_message.add_argument("--tx-hash", required=True)
    assert_message.add_argument("--message-index", type=int, required=True)
    assert_message.add_argument("--expected", type=Path, required=True)
    assert_message.set_defaults(action="assert_message")
    assert_matching = subcommands.add_parser("assert-matching-events")
    assert_matching.add_argument("--name", required=True)
    assert_matching.add_argument("--tx-hash", action="append", required=True)
    assert_matching.add_argument("--event-type", required=True)
    assert_matching.add_argument("--attributes", type=Path, required=True)
    assert_matching.add_argument("--expected", type=Path, required=True)
    assert_matching.set_defaults(action="assert_matching_events")
    assert_code = subcommands.add_parser("assert-tx-code")
    assert_code.add_argument("--name", required=True)
    assert_code.add_argument("--tx-hash", required=True)
    assert_code.add_argument("--expected-code", type=int, required=True)
    assert_code.set_defaults(action="assert_tx_code")
    finalize = subcommands.add_parser("finalize")
    finalize.set_defaults(action="finalize")
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        root = args.root.resolve()
        config = deploy.load_config(args.config.resolve(), root)
        state = deploy.load_state(args.state.resolve(), config)
        args.transcript = args.transcript.resolve()
        if args.action == "init":
            command_init(args, config, state)
            return 0
        transcript = load_transcript(args.transcript)
        if transcript.get("config_sha256") != deploy.config_hash(config):
            raise CaptureError("transcript belongs to a different deployment config")
        if args.action == "capture_tx":
            if args.expected_code < 0:
                raise CaptureError("expected transaction code must be nonnegative")
            command_capture_tx(args, config, transcript)
        elif args.action == "capture_query":
            command_capture_query(args, config, transcript)
        elif args.action == "capture_balance":
            command_capture_balance(args, config, transcript)
        elif args.action == "assert_query":
            command_assert_query(args, transcript)
        elif args.action == "assert_balance_delta":
            command_assert_balance_delta(args, transcript)
        elif args.action == "assert_event":
            command_assert_transaction_item(args, transcript, "event")
        elif args.action == "assert_message":
            command_assert_transaction_item(args, transcript, "message")
        elif args.action == "assert_matching_events":
            command_assert_matching_events(args, transcript)
        elif args.action == "assert_tx_code":
            if args.expected_code < 0:
                raise CaptureError("expected transaction code must be nonnegative")
            command_assert_tx_code(args, transcript)
        else:
            command_finalize(args, transcript)
    except (CaptureError, deploy.ValidationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
