#!/usr/bin/env python3
"""Validated, restartable deployment planner for Juno Voice v2.

The planner intentionally uses only Python's standard library.  It never takes
roles, contract addresses, economic values, or raw execute messages from CLI
arguments: those values come from one validated, hash-bound configuration.
"""

from __future__ import annotations

import argparse
import base64
import copy
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, Iterator


CONFIG_SCHEMA = "juno-voice/deployment-config/v2"
STATE_SCHEMA = "juno-voice/deployment-state/v2"
PLAN_SCHEMA = "juno-voice/deployment-plan/v2"
PREFLIGHT_SCHEMA = "juno-voice/deployment-preflight/v2"
VERIFICATION_SCHEMA = "juno-voice/deployment-verification/v2"
REQUIRED_ARTIFACTS = {
    "juno_voice_bounties": ("crates.io:juno-voice-bounties", "2.0.0"),
    "hack_juno_registry_adapter": (
        "crates.io:hack-juno-registry-adapter",
        "2.0.0",
    ),
    "dao_dao_core": ("crates.io:dao-dao-core", "2.8.0-alpha.2"),
    "dao_voting_juno_staked": (
        "crates.io:dao-voting-juno-staked",
        "2.8.0-alpha.2",
    ),
    "gauge_orchestrator": ("crates.io:gauge", "2.8.0-alpha.3"),
}
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
HEX_40 = re.compile(r"^[0-9a-f]{40}$")
SAFE_NAME = re.compile(r"^[a-zA-Z0-9._-]{1,128}$")
DENOM = "ujuno"
RATIFICATION_SECONDS = 259_200
MAX_ACTIVE_PROJECTS = 99
MAX_GAUGE_OPTIONS = 100
MAX_BOUNTY_CONTRIBUTORS = 10_000
MAX_BOUNTY_ROUNDS = 100
MAX_BOUNTY_TEXT_BYTES = 16_384
MAX_BOUNTY_LIFETIME_SECONDS = 366 * 24 * 60 * 60
MAX_PAGE_LIMIT = 100
MAX_REGISTRY_TEXT_BYTES = 2_048
MAX_PAYOUT_ADDRESS_DELAY_SECONDS = 90 * 24 * 60 * 60
MAX_AGENT_MEMBERS = 100


class ValidationError(ValueError):
    pass


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fail(path: str, message: str) -> None:
    raise ValidationError(f"{path}: {message}")


def _object(value: Any, path: str, required: Iterable[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    allowed = set(required)
    missing = sorted(allowed - set(value))
    if missing:
        _fail(path, f"missing required keys: {', '.join(missing)}")
    extra = sorted(set(value) - allowed)
    if extra:
        _fail(path, f"unexpected keys: {', '.join(extra)}")
    return value


def _string(value: Any, path: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value):
        _fail(path, "must be a nonempty string" if nonempty else "must be a string")
    return value


def _uint(value: Any, path: str, *, positive: bool = False) -> int:
    if isinstance(value, bool):
        _fail(path, "must be an unsigned integer")
    if isinstance(value, str):
        if not re.fullmatch(r"0|[1-9][0-9]*", value):
            _fail(path, "must be a canonical unsigned integer string")
        result = int(value)
    elif isinstance(value, int) and value >= 0:
        result = value
    else:
        _fail(path, "must be an unsigned integer")
    if positive and result == 0:
        _fail(path, "must be positive")
    if result >= 2**128:
        _fail(path, "must fit Uint128")
    return result


def _decimal(value: Any, path: str, *, allow_zero: bool = True) -> Decimal:
    if not isinstance(value, str):
        _fail(path, "must be a decimal string")
    if not re.fullmatch(r"(?:0(?:\.[0-9]{1,18})?|1(?:\.0{1,18})?)", value):
        _fail(path, "must be a canonical fixed-point decimal with at most 18 places")
    try:
        result = Decimal(value)
    except InvalidOperation:
        _fail(path, "is not a decimal")
    if not result.is_finite() or result < 0 or result > 1:
        _fail(path, "must be between 0 and 1")
    if not allow_zero and result == 0:
        _fail(path, "must be positive")
    if result.as_tuple().exponent < -18:
        _fail(path, "may have at most 18 fractional digits")
    return result


def _canonical_fraction(value: Any, path: str) -> str:
    """Normalize equivalent on-chain decimal encodings before comparison."""
    return format(_decimal(value, path).normalize(), "f")


# Minimal BIP-0173 implementation. Juno accepts 20-byte account/module
# addresses and 32-byte instantiate2 contract addresses.
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32_MAP = {char: index for index, char in enumerate(_BECH32_CHARSET)}


def _bech32_polymod(values: Iterable[int]) -> int:
    generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    checksum = 1
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value
        for index, generator in enumerate(generators):
            if (top >> index) & 1:
                checksum ^= generator
    return checksum


def _bech32_hrp_expand(hrp: str) -> list[int]:
    return [ord(char) >> 5 for char in hrp] + [0] + [ord(char) & 31 for char in hrp]


def _convert_bits(data: Iterable[int], from_bits: int, to_bits: int, pad: bool) -> bytes:
    accumulator = 0
    bits = 0
    result: list[int] = []
    max_value = (1 << to_bits) - 1
    for value in data:
        if value < 0 or value >> from_bits:
            raise ValidationError("invalid bech32 data")
        accumulator = (accumulator << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            result.append((accumulator >> bits) & max_value)
    if pad:
        if bits:
            result.append((accumulator << (to_bits - bits)) & max_value)
    elif bits >= from_bits or ((accumulator << (to_bits - bits)) & max_value):
        raise ValidationError("invalid bech32 padding")
    return bytes(result)


def decode_address(address: str, expected_prefix: str, path: str = "address") -> bytes:
    if not isinstance(address, str) or not address or address.lower() != address:
        _fail(path, "must be a lowercase bech32 address")
    separator = address.rfind("1")
    if separator < 1 or separator + 7 > len(address) or len(address) > 90:
        _fail(path, "is not valid bech32")
    hrp = address[:separator]
    if hrp != expected_prefix:
        _fail(path, f"must use {expected_prefix!r} prefix")
    try:
        values = [_BECH32_MAP[char] for char in address[separator + 1 :]]
    except KeyError:
        _fail(path, "contains an invalid bech32 character")
    if _bech32_polymod(_bech32_hrp_expand(hrp) + values) != 1:
        _fail(path, "has an invalid bech32 checksum")
    try:
        raw = _convert_bits(values[:-6], 5, 8, False)
    except ValidationError as error:
        _fail(path, str(error))
    if len(raw) not in (20, 32):
        _fail(path, "must encode 20 or 32 bytes")
    return raw


def encode_address(raw: bytes, prefix: str) -> str:
    values = list(_convert_bits(raw, 8, 5, True))
    polymod = _bech32_polymod(_bech32_hrp_expand(prefix) + values + [0] * 6) ^ 1
    checksum = [(polymod >> (5 * (5 - index))) & 31 for index in range(6)]
    return prefix + "1" + "".join(_BECH32_CHARSET[value] for value in values + checksum)


def instantiate2_address(checksum_hex: str, creator: str, salt: str, prefix: str) -> str:
    if not HEX_64.fullmatch(checksum_hex):
        _fail("checksum", "must be 64 lowercase hexadecimal characters")
    creator_raw = decode_address(creator, prefix, "creator")
    salt_raw = salt.encode()
    if not 1 <= len(salt_raw) <= 64:
        _fail("salt", "must encode to 1..64 bytes")
    pieces = (bytes.fromhex(checksum_hex), creator_raw, salt_raw, b"")
    key = b"wasm\0" + b"".join(len(piece).to_bytes(8, "big") + piece for piece in pieces)
    inner = hashlib.sha256(b"module").digest()
    return encode_address(hashlib.sha256(inner + key).digest(), prefix)


def _validate_artifacts(config: dict[str, Any], root: Path, check_files: bool) -> None:
    artifacts = _object(config.get("artifacts"), "artifacts", REQUIRED_ARTIFACTS)
    if set(artifacts) != set(REQUIRED_ARTIFACTS):
        extra = sorted(set(artifacts) - set(REQUIRED_ARTIFACTS))
        _fail("artifacts", f"unexpected artifact keys: {', '.join(extra)}")
    for name, (cw2_contract, cw2_version) in REQUIRED_ARTIFACTS.items():
        item = _object(
            artifacts[name],
            f"artifacts.{name}",
            ("path", "sha256", "cw2_contract", "cw2_version"),
        )
        relative = Path(_string(item["path"], f"artifacts.{name}.path"))
        if relative.is_absolute() or ".." in relative.parts or relative.suffix != ".wasm":
            _fail(f"artifacts.{name}.path", "must be a relative .wasm path without '..'")
        checksum = _string(item["sha256"], f"artifacts.{name}.sha256")
        if not HEX_64.fullmatch(checksum):
            _fail(f"artifacts.{name}.sha256", "must be 64 lowercase hex characters")
        if item["cw2_contract"] != cw2_contract or item["cw2_version"] != cw2_version:
            _fail(
                f"artifacts.{name}",
                f"cw2 identity must be {cw2_contract}@{cw2_version}",
            )
        if check_files:
            artifact_path = (root / relative).resolve()
            if not artifact_path.is_relative_to(root.resolve()) or not artifact_path.is_file():
                _fail(f"artifacts.{name}.path", "artifact does not exist under repository root")
            actual = sha256_file(artifact_path)
            if actual != checksum:
                _fail(f"artifacts.{name}.sha256", f"expected {checksum}, found {actual}")


def _validate_repository_file_ref(
    value: Any, path: str, root: Path, check_files: bool
) -> None:
    reference = _object(value, path, ("path", "sha256"))
    relative = Path(_string(reference["path"], f"{path}.path"))
    if relative.is_absolute() or ".." in relative.parts:
        _fail(f"{path}.path", "must be a relative path without '..'")
    checksum = _string(reference["sha256"], f"{path}.sha256")
    if not HEX_64.fullmatch(checksum):
        _fail(f"{path}.sha256", "must be 64 lowercase hex characters")
    if check_files:
        evidence_path = (root / relative).resolve()
        if not evidence_path.is_relative_to(root.resolve()) or not evidence_path.is_file():
            _fail(f"{path}.path", "does not identify a repository file")
        actual = sha256_file(evidence_path)
        if actual != checksum:
            _fail(f"{path}.sha256", f"expected {checksum}, found {actual}")


def validate_config(config: dict[str, Any], root: Path, *, check_files: bool = True) -> None:
    _object(
        config,
        "$",
        (
            "schema_version",
            "environment",
            "chain",
            "source",
            "builder",
            "artifacts",
            "deployment",
            "cutover",
            "agent_operations",
            "bounty",
            "registry",
            "gauge",
            "tranche",
        ),
    )
    if config["schema_version"] != CONFIG_SCHEMA:
        _fail("schema_version", f"must equal {CONFIG_SCHEMA!r}")
    _string(config["environment"], "environment")

    chain = _object(
        config["chain"],
        "chain",
        (
            "chain_id",
            "rpc",
            "grpc",
            "native_denom",
            "bech32_prefix",
            "xgov_module_account",
            "deployer_address",
            "deployer_key_name",
            "gas_prices",
            "gas_adjustment",
            "tx_timeout_seconds",
        ),
    )
    chain_id = _string(chain["chain_id"], "chain.chain_id")
    if config["environment"] == "uni-7" and chain_id != "uni-7":
        _fail("chain.chain_id", "uni-7 environment must use chain ID uni-7")
    for field in ("rpc", "grpc"):
        endpoint = _string(chain[field], f"chain.{field}")
        if not endpoint.startswith("https://"):
            _fail(f"chain.{field}", "must be an explicit https:// endpoint")
    if chain["native_denom"] != DENOM:
        _fail("chain.native_denom", f"must equal {DENOM!r}")
    prefix = _string(chain["bech32_prefix"], "chain.bech32_prefix")
    if prefix != "juno":
        _fail("chain.bech32_prefix", "must equal 'juno'")
    for field in ("xgov_module_account", "deployer_address"):
        decode_address(chain[field], prefix, f"chain.{field}")
    if not SAFE_NAME.fullmatch(_string(chain["deployer_key_name"], "chain.deployer_key_name")):
        _fail("chain.deployer_key_name", "contains unsafe characters")
    gas_prices = _string(chain["gas_prices"], "chain.gas_prices")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?ujuno", gas_prices):
        _fail("chain.gas_prices", "must be an explicit ujuno gas price")
    try:
        adjustment = Decimal(str(chain["gas_adjustment"]))
    except InvalidOperation:
        _fail("chain.gas_adjustment", "must be numeric")
    if adjustment < Decimal("1") or adjustment > Decimal("3"):
        _fail("chain.gas_adjustment", "must be between 1 and 3")
    timeout = _uint(chain["tx_timeout_seconds"], "chain.tx_timeout_seconds", positive=True)
    if timeout > 900:
        _fail("chain.tx_timeout_seconds", "must not exceed 900")

    source = _object(config["source"], "source", ("parent_commit", "dao_contracts_commit"))
    for field in ("parent_commit", "dao_contracts_commit"):
        if not HEX_40.fullmatch(_string(source[field], f"source.{field}")):
            _fail(f"source.{field}", "must be an exact 40-character lowercase commit")
    builder = _object(
        config["builder"],
        "builder",
        (
            "optimizer_image",
            "juno_voice_rust",
            "dao_contracts_rust",
            "juno_voice_cosmwasm_check",
            "dao_contracts_cosmwasm_check",
            "wasm_tools",
        ),
    )
    image = _string(builder["optimizer_image"], "builder.optimizer_image")
    if "@sha256:" not in image or not HEX_64.fullmatch(image.rsplit("@sha256:", 1)[1]):
        _fail("builder.optimizer_image", "must use an immutable sha256 image digest")
    expected_tools = {
        "juno_voice_rust": "1.85.1",
        "dao_contracts_rust": "1.81.0",
        "juno_voice_cosmwasm_check": "3.0.4",
        "dao_contracts_cosmwasm_check": "1.5.11",
        "wasm_tools": "1.254.0",
    }
    for field, expected in expected_tools.items():
        if builder[field] != expected:
            _fail(f"builder.{field}", f"must equal {expected!r}")
    _validate_artifacts(config, root, check_files)

    deployment = _object(
        config["deployment"],
        "deployment",
        (
            "code_admin",
            "program_vault_salt",
            "program_vault_label",
            "voting_module_salt",
            "voting_module_label",
            "gauge_salt",
            "gauge_label",
            "bounty_salt",
            "bounty_label",
            "registry_salt",
            "registry_label",
        ),
    )
    decode_address(deployment["code_admin"], prefix, "deployment.code_admin")
    if deployment["code_admin"] != chain["xgov_module_account"]:
        _fail("deployment.code_admin", "must equal the disclosed x/gov module account")
    salts: list[str] = []
    for field in (
        "program_vault_salt",
        "voting_module_salt",
        "gauge_salt",
        "bounty_salt",
        "registry_salt",
    ):
        salt = _string(deployment[field], f"deployment.{field}")
        if not 1 <= len(salt.encode()) <= 64:
            _fail(f"deployment.{field}", "must encode to 1..64 bytes")
        salts.append(salt)
    if len(set(salts)) != len(salts):
        _fail("deployment", "instantiate2 salts must be unique")
    for field in (
        "program_vault_label",
        "voting_module_label",
        "gauge_label",
        "bounty_label",
        "registry_label",
    ):
        if not SAFE_NAME.fullmatch(_string(deployment[field], f"deployment.{field}")):
            _fail(f"deployment.{field}", "contains unsafe characters")

    cutover = _object(config["cutover"], "cutover", ("mode", "historical_v1"))
    cutover_mode = cutover["mode"]
    if cutover_mode == "no_prior_composition":
        if cutover["historical_v1"] is not None:
            _fail("cutover.historical_v1", "must be null when no prior composition exists")
        if chain_id == "juno-1":
            _fail(
                "cutover.mode",
                "juno-1 must replace an explicitly identified historical v1 composition",
            )
    elif cutover_mode == "replace_historical_v1":
        historical = _object(
            cutover["historical_v1"],
            "cutover.historical_v1",
            ("bounty", "registry", "program_vault", "voting_module", "gauge"),
        )
        seen_historical_addresses: set[str] = set()
        seen_historical_code_ids: set[int] = set()
        seen_historical_checksums: set[str] = set()
        for component in ("bounty", "registry", "program_vault", "voting_module", "gauge"):
            identity = _object(
                historical[component],
                f"cutover.historical_v1.{component}",
                ("address", "code_id", "checksum"),
            )
            historical_address = identity["address"]
            decode_address(
                historical_address, prefix, f"cutover.historical_v1.{component}.address"
            )
            if historical_address in seen_historical_addresses:
                _fail("cutover.historical_v1", "contract addresses must be distinct")
            seen_historical_addresses.add(historical_address)
            historical_code_id = _uint(
                identity["code_id"],
                f"cutover.historical_v1.{component}.code_id",
                positive=True,
            )
            if historical_code_id in seen_historical_code_ids:
                _fail("cutover.historical_v1", "code IDs must be distinct")
            seen_historical_code_ids.add(historical_code_id)
            checksum = _string(
                identity["checksum"], f"cutover.historical_v1.{component}.checksum"
            )
            if not HEX_64.fullmatch(checksum):
                _fail(
                    f"cutover.historical_v1.{component}.checksum",
                    "must be 64 lowercase hex characters",
                )
            seen_historical_checksums.add(checksum)
        v2_checksums = {item["sha256"] for item in config["artifacts"].values()}
        if seen_historical_checksums & v2_checksums:
            _fail(
                "cutover.historical_v1",
                "historical and reviewed v2 checksums must be disjoint",
            )
        new_addresses = derive_addresses(config)
        collisions = set(new_addresses.values()) & seen_historical_addresses
        if collisions:
            _fail(
                "cutover.historical_v1",
                f"historical and v2 addresses collide: {sorted(collisions)!r}",
            )
    else:
        _fail(
            "cutover.mode",
            "must be 'no_prior_composition' or 'replace_historical_v1'",
        )

    agent = _object(
        config["agent_operations"],
        "agent_operations",
        (
            "mode",
            "core_address",
            "core_code_id",
            "core_checksum",
            "voting_module_address",
            "voting_code_id",
            "voting_checksum",
            "proposal_module_address",
            "proposal_code_id",
            "proposal_checksum",
            "membership",
            "proposal",
            "review_reference",
        ),
    )
    if agent["mode"] != "bind_reviewed":
        _fail("agent_operations.mode", "v2 supports only an explicitly reviewed bound DAO")
    for field in ("core_address", "voting_module_address", "proposal_module_address"):
        decode_address(agent[field], prefix, f"agent_operations.{field}")
    for field in ("core_code_id", "voting_code_id", "proposal_code_id"):
        _uint(agent[field], f"agent_operations.{field}", positive=True)
    for field in ("core_checksum", "voting_checksum", "proposal_checksum"):
        if not HEX_64.fullmatch(_string(agent[field], f"agent_operations.{field}")):
            _fail(f"agent_operations.{field}", "must be 64 lowercase hex characters")

    membership = agent["membership"]
    if not isinstance(membership, dict):
        _fail("agent_operations.membership", "must be an object")
    kind = membership.get("kind")
    if kind == "cw4":
        membership = _object(
            membership,
            "agent_operations.membership",
            ("kind", "group_address", "group_code_id", "group_checksum", "members", "total_power"),
        )
        address_field, code_field, checksum_field, items_field = (
            "group_address", "group_code_id", "group_checksum", "members"
        )
    elif kind == "cw721_roles":
        membership = _object(
            membership,
            "agent_operations.membership",
            ("kind", "nft_address", "nft_code_id", "nft_checksum", "minter", "tokens", "total_power"),
        )
        address_field, code_field, checksum_field, items_field = (
            "nft_address", "nft_code_id", "nft_checksum", "tokens"
        )
        decode_address(membership["minter"], prefix, "agent_operations.membership.minter")
        if membership["minter"] != agent["core_address"]:
            _fail("agent_operations.membership.minter", "must equal the reviewed DAO core")
    else:
        _fail("agent_operations.membership.kind", "must be 'cw4' or 'cw721_roles'")
    decode_address(membership[address_field], prefix, f"agent_operations.membership.{address_field}")
    _uint(membership[code_field], f"agent_operations.membership.{code_field}", positive=True)
    if not HEX_64.fullmatch(_string(membership[checksum_field], f"agent_operations.membership.{checksum_field}")):
        _fail(f"agent_operations.membership.{checksum_field}", "must be 64 lowercase hex characters")
    items = membership[items_field]
    if not isinstance(items, list) or not items:
        _fail(f"agent_operations.membership.{items_field}", "must disclose at least one item")
    if len(items) > MAX_AGENT_MEMBERS:
        _fail(
            f"agent_operations.membership.{items_field}",
            f"must not exceed the verifier's bounded maximum of {MAX_AGENT_MEMBERS}",
        )
    total_weight = 0
    seen_ids: set[Any] = set()
    for index, item in enumerate(items):
        item_path = f"agent_operations.membership.{items_field}[{index}]"
        required = ("address", "weight") if kind == "cw4" else ("token_id", "owner", "role", "weight")
        item = _object(item, item_path, required)
        identity = decode_address(item["address"], prefix, f"{item_path}.address") if kind == "cw4" else _string(item["token_id"], f"{item_path}.token_id")
        if kind == "cw721_roles" and len(identity) > 256:
            _fail(f"{item_path}.token_id", "must not exceed 256 characters")
        if identity in seen_ids:
            _fail(item_path, "has a duplicated address or token ID")
        seen_ids.add(identity)
        if kind == "cw721_roles":
            decode_address(item["owner"], prefix, f"{item_path}.owner")
            role = _string(item["role"], f"{item_path}.role")
            if len(role) > 128:
                _fail(f"{item_path}.role", "must not exceed 128 characters")
        total_weight += _uint(item["weight"], f"{item_path}.weight", positive=True)
    disclosed_total = _uint(membership["total_power"], "agent_operations.membership.total_power", positive=True)
    if disclosed_total != total_weight:
        _fail("agent_operations.membership.total_power", "must equal the exhaustive disclosed item weights")

    proposal = _object(
        agent["proposal"],
        "agent_operations.proposal",
        ("threshold", "voting_duration_seconds"),
    )
    threshold = proposal["threshold"]
    if not isinstance(threshold, dict):
        _fail("agent_operations.proposal.threshold", "must be an object")
    threshold_kind = threshold.get("kind")
    if threshold_kind == "absolute_count":
        threshold = _object(threshold, "agent_operations.proposal.threshold", ("kind", "weight"))
        threshold_weight = _uint(threshold["weight"], "agent_operations.proposal.threshold.weight", positive=True)
        if threshold_weight > total_weight:
            _fail("agent_operations.proposal.threshold.weight", "must not exceed disclosed total power")
    elif threshold_kind == "threshold_quorum":
        threshold = _object(
            threshold,
            "agent_operations.proposal.threshold",
            ("kind", "threshold", "quorum"),
        )
        if threshold["threshold"] != "majority":
            _fail("agent_operations.proposal.threshold.threshold", "must equal 'majority'")
        _decimal(threshold["quorum"], "agent_operations.proposal.threshold.quorum", allow_zero=False)
    else:
        _fail("agent_operations.proposal.threshold.kind", "must be 'absolute_count' or 'threshold_quorum'")
    if not isinstance(proposal["voting_duration_seconds"], int) or isinstance(
        proposal["voting_duration_seconds"], bool
    ):
        _fail(
            "agent_operations.proposal.voting_duration_seconds",
            "must be an integer",
        )
    duration = _uint(
        proposal["voting_duration_seconds"],
        "agent_operations.proposal.voting_duration_seconds",
        positive=True,
    )
    if duration > 30 * 24 * 60 * 60:
        _fail("agent_operations.proposal.voting_duration_seconds", "must not exceed 30 days")
    _validate_repository_file_ref(
        agent["review_reference"],
        "agent_operations.review_reference",
        root,
        check_files,
    )

    bounty = _object(
        config["bounty"],
        "bounty",
        (
            "min_contribution",
            "max_bounty_total",
            "min_lifetime_seconds",
            "max_lifetime_seconds",
            "max_contributors",
            "max_rounds",
            "ratification_seconds",
            "limits",
        ),
    )
    min_contribution = _uint(bounty["min_contribution"], "bounty.min_contribution", positive=True)
    max_total = _uint(bounty["max_bounty_total"], "bounty.max_bounty_total", positive=True)
    if min_contribution > max_total:
        _fail("bounty.min_contribution", "must not exceed max_bounty_total")
    min_lifetime = _uint(bounty["min_lifetime_seconds"], "bounty.min_lifetime_seconds", positive=True)
    max_lifetime = _uint(bounty["max_lifetime_seconds"], "bounty.max_lifetime_seconds", positive=True)
    if min_lifetime < RATIFICATION_SECONDS or min_lifetime > max_lifetime:
        _fail("bounty.min_lifetime_seconds", "must cover ratification and not exceed max lifetime")
    max_contributors = _uint(
        bounty["max_contributors"], "bounty.max_contributors", positive=True
    )
    if max_contributors > MAX_BOUNTY_CONTRIBUTORS:
        _fail(
            "bounty.max_contributors",
            f"exceeds the contract hard bound {MAX_BOUNTY_CONTRIBUTORS}",
        )
    max_rounds = _uint(bounty["max_rounds"], "bounty.max_rounds", positive=True)
    if max_rounds > MAX_BOUNTY_ROUNDS:
        _fail(
            "bounty.max_rounds",
            f"exceeds the contract hard bound {MAX_BOUNTY_ROUNDS}",
        )
    if max_lifetime > MAX_BOUNTY_LIFETIME_SECONDS:
        _fail(
            "bounty.max_lifetime_seconds",
            f"exceeds the contract hard bound {MAX_BOUNTY_LIFETIME_SECONDS}",
        )
    if bounty["ratification_seconds"] != RATIFICATION_SECONDS:
        _fail("bounty.ratification_seconds", f"must equal immutable {RATIFICATION_SECONDS}")
    limits = _object(
        bounty["limits"],
        "bounty.limits",
        (
            "max_title_bytes",
            "max_summary_bytes",
            "max_acceptance_criteria_bytes",
            "max_uri_bytes",
            "max_rationale_bytes",
            "max_reason_bytes",
            "max_page_limit",
        ),
    )
    for field, value in limits.items():
        parsed = _uint(value, f"bounty.limits.{field}", positive=True)
        maximum = MAX_PAGE_LIMIT if field == "max_page_limit" else MAX_BOUNTY_TEXT_BYTES
        if parsed > maximum:
            _fail(f"bounty.limits.{field}", f"exceeds the contract hard bound {maximum}")

    registry = _object(
        config["registry"],
        "registry",
        (
            "spam_destination",
            "registration_bond",
            "payout_address_delay_seconds",
            "epoch_ceiling",
            "min_project_share",
            "max_project_share",
            "max_selected_projects",
            "max_active_projects",
            "reserved_option",
            "max_page_limit",
            "max_metadata_uri_bytes",
            "max_reason_bytes",
        ),
    )
    decode_address(registry["spam_destination"], prefix, "registry.spam_destination")
    _uint(registry["registration_bond"], "registry.registration_bond", positive=True)
    address_delay = _uint(
        registry["payout_address_delay_seconds"],
        "registry.payout_address_delay_seconds",
        positive=True,
    )
    if address_delay > MAX_PAYOUT_ADDRESS_DELAY_SECONDS:
        _fail(
            "registry.payout_address_delay_seconds",
            f"exceeds the contract hard bound {MAX_PAYOUT_ADDRESS_DELAY_SECONDS}",
        )
    epoch_ceiling = _uint(registry["epoch_ceiling"], "registry.epoch_ceiling", positive=True)
    min_share = _decimal(registry["min_project_share"], "registry.min_project_share")
    max_share = _decimal(
        registry["max_project_share"], "registry.max_project_share", allow_zero=False
    )
    if min_share > max_share:
        _fail("registry.min_project_share", "must not exceed max_project_share")
    if min_share >= Decimal(1) or max_share >= Decimal(1):
        _fail(
            "registry.max_project_share",
            "selection shares must remain below one for the gauge contract",
        )
    max_selected = _uint(
        registry["max_selected_projects"], "registry.max_selected_projects", positive=True
    )
    if max_selected > MAX_ACTIVE_PROJECTS:
        _fail("registry.max_selected_projects", f"must not exceed {MAX_ACTIVE_PROJECTS}")
    if registry["max_active_projects"] != MAX_ACTIVE_PROJECTS:
        _fail("registry.max_active_projects", f"must equal immutable {MAX_ACTIVE_PROJECTS}")
    if registry["reserved_option"] != "do-not-distribute":
        _fail("registry.reserved_option", "must equal immutable 'do-not-distribute'")
    for field in ("max_page_limit", "max_metadata_uri_bytes", "max_reason_bytes"):
        parsed = _uint(registry[field], f"registry.{field}", positive=True)
        maximum = MAX_PAGE_LIMIT if field == "max_page_limit" else MAX_REGISTRY_TEXT_BYTES
        if parsed > maximum:
            _fail(f"registry.{field}", f"exceeds the contract hard bound {maximum}")

    gauge = _object(
        config["gauge"],
        "gauge",
        (
            "title",
            "power_source",
            "epoch_size_seconds",
            "min_turnout_bps",
            "epoch_budget",
            "retained_option",
            "execution_window_seconds",
            "min_percent_selected",
            "max_available_percentage",
            "max_options_selected",
            "option_capacity",
            "reset_epoch_seconds",
        ),
    )
    title = _string(gauge["title"], "gauge.title")
    if len(title.encode()) > 128:
        _fail("gauge.title", "exceeds the gauge contract's 128-byte hard bound")
    if gauge["power_source"] != "epoch_snapshot":
        _fail("gauge.power_source", "must equal 'epoch_snapshot'")
    epoch_seconds = _uint(gauge["epoch_size_seconds"], "gauge.epoch_size_seconds", positive=True)
    if epoch_seconds < 3600:
        _fail("gauge.epoch_size_seconds", "must be at least one hour")
    turnout = _uint(gauge["min_turnout_bps"], "gauge.min_turnout_bps")
    if turnout > 10_000:
        _fail("gauge.min_turnout_bps", "must not exceed 10000")
    epoch_budget = _uint(gauge["epoch_budget"], "gauge.epoch_budget", positive=True)
    if epoch_budget != epoch_ceiling:
        _fail("gauge.epoch_budget", "must equal registry.epoch_ceiling")
    if gauge["retained_option"] != registry["reserved_option"]:
        _fail("gauge.retained_option", "must equal registry.reserved_option")
    execution_window = _uint(
        gauge["execution_window_seconds"],
        "gauge.execution_window_seconds",
        positive=True,
    )
    if execution_window >= 2**64:
        _fail("gauge.execution_window_seconds", "must fit u64")
    if _decimal(gauge["min_percent_selected"], "gauge.min_percent_selected") != min_share:
        _fail("gauge.min_percent_selected", "must equal registry.min_project_share")
    if _decimal(
        gauge["max_available_percentage"],
        "gauge.max_available_percentage",
        allow_zero=False,
    ) != max_share:
        _fail("gauge.max_available_percentage", "must equal registry.max_project_share")
    if _uint(gauge["max_options_selected"], "gauge.max_options_selected", positive=True) != max_selected:
        _fail("gauge.max_options_selected", "must equal registry.max_selected_projects")
    if gauge["option_capacity"] != MAX_GAUGE_OPTIONS:
        _fail("gauge.option_capacity", f"must equal immutable {MAX_GAUGE_OPTIONS}")
    if gauge["reset_epoch_seconds"] is not None:
        _fail("gauge.reset_epoch_seconds", "must be null in epoch-snapshot mode")

    tranche = _object(
        config["tranche"],
        "tranche",
        (
            "maximum_amount",
            "term_start_time",
            "term_end_time",
            "unused_funds_policy",
            "snapshot_retention_blocks",
            "observed_min_block_seconds",
            "operational_margin_seconds",
        ),
    )
    tranche_max = _uint(tranche["maximum_amount"], "tranche.maximum_amount", positive=True)
    if epoch_budget > tranche_max:
        _fail("gauge.epoch_budget", "must not exceed tranche.maximum_amount")
    term_start = _uint(tranche["term_start_time"], "tranche.term_start_time", positive=True)
    term_end = _uint(tranche["term_end_time"], "tranche.term_end_time", positive=True)
    if term_end <= term_start:
        _fail("tranche.term_end_time", "must be after term_start_time")
    if tranche["unused_funds_policy"] not in ("return_to_community_pool", "retain_until_term_end"):
        _fail("tranche.unused_funds_policy", "must be an explicit supported policy")
    retention = _uint(
        tranche["snapshot_retention_blocks"],
        "tranche.snapshot_retention_blocks",
        positive=True,
    )
    block_seconds = _uint(
        tranche["observed_min_block_seconds"],
        "tranche.observed_min_block_seconds",
        positive=True,
    )
    margin = _uint(
        tranche["operational_margin_seconds"],
        "tranche.operational_margin_seconds",
        positive=True,
    )
    if retention * block_seconds < epoch_seconds + execution_window + margin:
        _fail(
            "tranche.snapshot_retention_blocks",
            "observed retention does not cover voting, execution, and operational windows",
        )


def load_config(path: Path, root: Path, *, check_files: bool = True) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"cannot read configuration {path}: {error}") from error
    validate_config(config, root, check_files=check_files)
    if check_files:
        validate_source_checkout(config, root)
    return config


def _git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode:
        raise ValidationError(
            f"git {' '.join(args)} failed in {root}: {completed.stderr.strip()}"
        )
    return completed.stdout.strip()


def validate_source_checkout(config: dict[str, Any], root: Path) -> None:
    source = config["source"]
    parent_commit = source["parent_commit"]
    submodule_commit = source["dao_contracts_commit"]
    _git(root, "cat-file", "-e", f"{parent_commit}^{{commit}}")
    head_commit = _git(root, "rev-parse", "HEAD")
    if head_commit != parent_commit:
        _fail(
            "source.parent_commit",
            "must exactly equal the deployment checkout HEAD (descendants are unreviewed)",
        )
    source_gitlink = _git(root, "ls-tree", parent_commit, "deps/dao-contracts").split()
    current_gitlink = _git(root, "ls-tree", "HEAD", "deps/dao-contracts").split()
    if len(source_gitlink) != 4 or source_gitlink[2] != submodule_commit:
        _fail("source.dao_contracts_commit", "does not match the source commit's gitlink")
    if len(current_gitlink) != 4 or current_gitlink[2] != submodule_commit:
        _fail("source.dao_contracts_commit", "does not match the deployment checkout's gitlink")
    submodule = root / "deps" / "dao-contracts"
    if _git(submodule, "rev-parse", "HEAD") != submodule_commit:
        _fail("source.dao_contracts_commit", "does not match the checked-out submodule")
    if _git(root, "status", "--porcelain", "--untracked-files=all"):
        _fail("source", "deployment requires a clean parent checkout")
    if _git(submodule, "status", "--porcelain", "--untracked-files=all"):
        _fail("source", "deployment requires a clean dao-contracts checkout")


def config_hash(config: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(config))


def derive_addresses(config: dict[str, Any]) -> dict[str, str]:
    prefix = config["chain"]["bech32_prefix"]
    deployer = config["chain"]["deployer_address"]
    artifacts = config["artifacts"]
    deployment = config["deployment"]
    vault = instantiate2_address(
        artifacts["dao_dao_core"]["sha256"],
        deployer,
        deployment["program_vault_salt"],
        prefix,
    )
    voting = instantiate2_address(
        artifacts["dao_voting_juno_staked"]["sha256"],
        vault,
        deployment["voting_module_salt"],
        prefix,
    )
    gauge = instantiate2_address(
        artifacts["gauge_orchestrator"]["sha256"],
        vault,
        deployment["gauge_salt"],
        prefix,
    )
    bounty = instantiate2_address(
        artifacts["juno_voice_bounties"]["sha256"],
        deployer,
        deployment["bounty_salt"],
        prefix,
    )
    registry = instantiate2_address(
        artifacts["hack_juno_registry_adapter"]["sha256"],
        deployer,
        deployment["registry_salt"],
        prefix,
    )
    return {
        "program_vault": vault,
        "voting_module": voting,
        "gauge": gauge,
        "bounty": bounty,
        "registry": registry,
        "agent_operations": config["agent_operations"]["core_address"],
    }


def _binary_json(value: Any) -> str:
    return base64.b64encode(canonical_json(value)).decode()


def instantiate_messages(config: dict[str, Any], code_ids: dict[str, int]) -> dict[str, Any]:
    missing = sorted(set(REQUIRED_ARTIFACTS) - set(code_ids))
    if missing:
        raise ValidationError(f"missing code IDs for: {', '.join(missing)}")
    for name, code_id in code_ids.items():
        _uint(code_id, f"code_ids.{name}", positive=True)
    addresses = derive_addresses(config)
    deployment = config["deployment"]
    chain = config["chain"]
    bounty = config["bounty"]
    registry = config["registry"]
    gauge = config["gauge"]
    admin = chain["xgov_module_account"]
    agent = addresses["agent_operations"]

    registry_msg = {
        "native_denom": DENOM,
        "governor": addresses["program_vault"],
        "curator": agent,
        "bounty_contract": addresses["bounty"],
        "spam_destination": registry["spam_destination"],
        "registration_bond": str(registry["registration_bond"]),
        "payout_address_delay_seconds": registry["payout_address_delay_seconds"],
        "epoch_ceiling": str(registry["epoch_ceiling"]),
        "min_project_share": registry["min_project_share"],
        "max_project_share": registry["max_project_share"],
        "max_selected_projects": registry["max_selected_projects"],
        "max_page_limit": registry["max_page_limit"],
        "max_metadata_uri_bytes": registry["max_metadata_uri_bytes"],
        "max_reason_bytes": registry["max_reason_bytes"],
    }
    bounty_msg = {
        "native_denom": DENOM,
        "governor": addresses["program_vault"],
        "agent": agent,
        "registry": addresses["registry"],
        "min_contribution": str(bounty["min_contribution"]),
        "max_bounty_total": str(bounty["max_bounty_total"]),
        "min_lifetime_seconds": bounty["min_lifetime_seconds"],
        "max_lifetime_seconds": bounty["max_lifetime_seconds"],
        "max_contributors": bounty["max_contributors"],
        "max_rounds": bounty["max_rounds"],
        "limits": bounty["limits"],
    }
    gauge_msg = {
        "voting_powers": addresses["voting_module"],
        "hook_caller": "",
        "epoch_snapshot": {"guardian": agent},
        "owner": addresses["program_vault"],
        "gauges": [
            {
                "title": gauge["title"],
                "adapter": addresses["registry"],
                "epoch_size": gauge["epoch_size_seconds"],
                "min_percent_selected": gauge["min_percent_selected"],
                "max_options_selected": gauge["max_options_selected"],
                "max_available_percentage": gauge["max_available_percentage"],
                "reset_epoch": None,
                "snapshot_policy": {
                    "min_turnout_bps": gauge["min_turnout_bps"],
                    "epoch_budget": str(gauge["epoch_budget"]),
                    "denom": DENOM,
                    "retained_option": gauge["retained_option"],
                    "execution_window_seconds": gauge["execution_window_seconds"],
                },
            }
        ],
    }
    module_admin = {"address": {"addr": admin}}
    vault_msg = {
        "admin": admin,
        "name": "Hack Juno Program Vault",
        "description": "x/gov-administered bounded Hack Juno treasury and gauge executor",
        "image_url": None,
        "automatically_add_cw20s": False,
        "automatically_add_cw721s": False,
        "voting_module_instantiate_info": {
            "code_id": code_ids["dao_voting_juno_staked"],
            "msg": _binary_json({}),
            "admin": module_admin,
            "funds": [],
            "label": deployment["voting_module_label"],
            "salt": base64.b64encode(deployment["voting_module_salt"].encode()).decode(),
        },
        "proposal_modules_instantiate_info": [
            {
                "code_id": code_ids["gauge_orchestrator"],
                "msg": _binary_json(gauge_msg),
                "admin": module_admin,
                "funds": [],
                "label": deployment["gauge_label"],
                "salt": base64.b64encode(deployment["gauge_salt"].encode()).decode(),
            }
        ],
        "initial_items": [
            {"key": "juno-voice-release", "value": config_hash(config)},
            {"key": "unused-funds-policy", "value": config["tranche"]["unused_funds_policy"]},
        ],
        "initial_actions": None,
        "dao_uri": None,
    }
    return {
        "registry": registry_msg,
        "bounty": bounty_msg,
        "program_vault": vault_msg,
        "gauge_inner": gauge_msg,
        "addresses": addresses,
    }


def empty_state(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": STATE_SCHEMA,
        "config_sha256": config_hash(config),
        "chain_id": config["chain"]["chain_id"],
        "code_ids": {},
        "addresses": derive_addresses(config),
        "transactions": {},
        "verified": {},
    }


def validate_state_records(state: dict[str, Any]) -> None:
    step_specs = [
        (f"store:{name}", "store", name) for name in REQUIRED_ARTIFACTS
    ] + [
        ("instantiate:registry", "instantiate", "registry"),
        ("instantiate:bounty", "instantiate", "bounty"),
        ("instantiate:program_vault", "instantiate", "program_vault"),
    ]
    allowed_steps = {step_id for step_id, _kind, _name in step_specs}
    transactions = state["transactions"]
    unknown = sorted(set(transactions) - allowed_steps)
    if unknown:
        _fail("state.transactions", f"contains unknown steps: {', '.join(unknown)}")

    gap_seen = False
    pending_seen = False
    for step_id, kind, name in step_specs:
        record = transactions.get(step_id)
        if record is None:
            gap_seen = True
            continue
        if gap_seen:
            _fail(f"state.transactions.{step_id}", "appears after an incomplete earlier step")
        if not isinstance(record, dict):
            _fail(f"state.transactions.{step_id}", "must be an object")
        status = record.get("status")
        if status == "pending":
            _object(record, f"state.transactions.{step_id}", ("status", "tx_hash"))
            tx_value = _string(record["tx_hash"], f"state.transactions.{step_id}.tx_hash")
            if not re.fullmatch(r"[0-9A-F]{64}", tx_value):
                _fail(
                    f"state.transactions.{step_id}.tx_hash",
                    "must be an uppercase transaction hash",
                )
            if pending_seen:
                _fail(f"state.transactions.{step_id}", "a prior transaction is already pending")
            pending_seen = True
            gap_seen = True
            if kind == "store" and name in state["code_ids"]:
                _fail(f"state.transactions.{step_id}", "pending upload already has a code ID")
            continue
        if status != "complete":
            _fail(f"state.transactions.{step_id}.status", "must be pending or complete")

        if kind == "store":
            if record.get("reused_exact_code") is True:
                _object(
                    record,
                    f"state.transactions.{step_id}",
                    ("status", "code_id", "reused_exact_code"),
                )
            else:
                _object(
                    record,
                    f"state.transactions.{step_id}",
                    ("status", "tx_hash", "code_id"),
                )
                tx_value = _string(
                    record["tx_hash"], f"state.transactions.{step_id}.tx_hash"
                )
                if not re.fullmatch(r"[0-9A-F]{64}", tx_value):
                    _fail(
                        f"state.transactions.{step_id}.tx_hash",
                        "must be an uppercase transaction hash",
                    )
            code_id = _uint(
                record["code_id"], f"state.transactions.{step_id}.code_id", positive=True
            )
            if state["code_ids"].get(name) != code_id:
                _fail(
                    f"state.transactions.{step_id}.code_id",
                    "does not match state.code_ids",
                )
        else:
            if set(state["code_ids"]) != set(REQUIRED_ARTIFACTS):
                _fail(f"state.transactions.{step_id}", "requires all five code IDs")
            if record.get("reconciled_existing") is True:
                _object(
                    record,
                    f"state.transactions.{step_id}",
                    ("status", "contract_address", "reconciled_existing"),
                )
            else:
                _object(
                    record,
                    f"state.transactions.{step_id}",
                    ("status", "tx_hash", "contract_address"),
                )
                tx_value = _string(
                    record["tx_hash"], f"state.transactions.{step_id}.tx_hash"
                )
                if not re.fullmatch(r"[0-9A-F]{64}", tx_value):
                    _fail(
                        f"state.transactions.{step_id}.tx_hash",
                        "must be an uppercase transaction hash",
                    )
            if record["contract_address"] != state["addresses"][name]:
                _fail(
                    f"state.transactions.{step_id}.contract_address",
                    "does not match the deterministic address",
                )

    for name in state["code_ids"]:
        record = transactions.get(f"store:{name}")
        if not isinstance(record, dict) or record.get("status") != "complete":
            _fail(f"state.code_ids.{name}", "is not backed by a complete upload record")

    verified = state["verified"]
    if not isinstance(verified, dict):
        _fail("state.verified", "must be an object")
    if verified:
        _object(verified, "state.verified", ("report", "sha256"))
        _string(verified["report"], "state.verified.report")
        if not HEX_64.fullmatch(_string(verified["sha256"], "state.verified.sha256")):
            _fail("state.verified.sha256", "must be a lowercase SHA-256 digest")
        if any(
            transactions.get(step_id, {}).get("status") != "complete"
            for step_id in allowed_steps
        ):
            _fail("state.verified", "cannot verify an incomplete deployment journal")


def load_state(path: Path, config: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return empty_state(config)
    try:
        state = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"cannot read deployment state {path}: {error}") from error
    _object(
        state,
        "state",
        ("schema_version", "config_sha256", "chain_id", "code_ids", "addresses", "transactions", "verified"),
    )
    if state["schema_version"] != STATE_SCHEMA:
        _fail("state.schema_version", f"must equal {STATE_SCHEMA!r}")
    if state["config_sha256"] != config_hash(config):
        _fail("state.config_sha256", "state belongs to a different configuration")
    if state["chain_id"] != config["chain"]["chain_id"]:
        _fail("state.chain_id", "state belongs to a different chain")
    if state["addresses"] != derive_addresses(config):
        _fail("state.addresses", "recorded addresses do not match checksum/salt derivation")
    if not isinstance(state["code_ids"], dict) or not isinstance(state["transactions"], dict):
        _fail("state", "code_ids and transactions must be objects")
    for name, code_id in state["code_ids"].items():
        if name not in REQUIRED_ARTIFACTS:
            _fail(f"state.code_ids.{name}", "is not a release artifact")
        _uint(code_id, f"state.code_ids.{name}", positive=True)
    validate_state_records(state)
    return state


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(file_descriptor, "w") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


@contextmanager
def exclusive_state_lock(path: Path) -> Iterator[None]:
    """Prevent concurrent planners from broadcasting the same ready step."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f".{path.name}.lock")
    with lock_path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f"deployment state is locked by another process: {path}") from error
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def reject_output_collision(output: Path | None, *inputs: Path) -> None:
    if output is None:
        return
    resolved = output.resolve()
    if any(resolved == path.resolve() for path in inputs):
        raise ValidationError("output path must not overwrite an input file")


def require_external_mutable_path(path: Path | None, root: Path, label: str) -> None:
    if path is not None and path.resolve().is_relative_to(root.resolve()):
        raise ValidationError(f"{label} must be outside the clean source checkout")
def build_plan(config: dict[str, Any], state: dict[str, Any], root: Path) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    transactions = state["transactions"]

    def step_status(step_id: str) -> str:
        record = transactions.get(step_id)
        if record is None:
            return "ready"
        if not isinstance(record, dict):
            raise ValidationError(f"state.transactions.{step_id}: must be an object")
        status = record.get("status")
        if status not in ("pending", "complete"):
            raise ValidationError(
                f"state.transactions.{step_id}.status: must be pending or complete"
            )
        return "reconcile" if status == "pending" else "complete"

    for name in REQUIRED_ARTIFACTS:
        if name not in state["code_ids"]:
            artifact = config["artifacts"][name]
            step_id = f"store:{name}"
            steps.append(
                {
                    "id": step_id,
                    "status": step_status(step_id),
                    "kind": "store_code",
                    "artifact": artifact["path"],
                    "sha256": artifact["sha256"],
                    "code_admin": config["chain"]["xgov_module_account"],
                }
            )
    if set(state["code_ids"]) == set(REQUIRED_ARTIFACTS):
        messages = instantiate_messages(config, state["code_ids"])
        instantiate_specs = (
            (
                "registry",
                "hack_juno_registry_adapter",
                config["deployment"]["registry_salt"],
                config["deployment"]["registry_label"],
            ),
            (
                "bounty",
                "juno_voice_bounties",
                config["deployment"]["bounty_salt"],
                config["deployment"]["bounty_label"],
            ),
            (
                "program_vault",
                "dao_dao_core",
                config["deployment"]["program_vault_salt"],
                config["deployment"]["program_vault_label"],
            ),
        )
        for component, artifact, salt, label in instantiate_specs:
            step_id = f"instantiate:{component}"
            steps.append(
                {
                    "id": step_id,
                    "status": step_status(step_id),
                    "kind": "instantiate2",
                    "code_id": state["code_ids"][artifact],
                    "artifact": artifact,
                    "expected_address": messages["addresses"][component],
                    "admin": config["chain"]["xgov_module_account"],
                    "label": label,
                    "salt_hex": salt.encode().hex(),
                    "msg": messages[component],
                    "funds": [],
                }
            )
    else:
        steps.append(
            {
                "id": "instantiate:all",
                "status": "blocked",
                "kind": "phase_gate",
                "reason": "record all five exact code IDs before compiling instantiate messages",
            }
        )
    return {
        "schema_version": PLAN_SCHEMA,
        "config_sha256": config_hash(config),
        "chain_id": config["chain"]["chain_id"],
        "source": copy.deepcopy(config["source"]),
        "addresses": derive_addresses(config),
        "steps": steps,
    }


@dataclass
class Junod:
    binary: str
    config: dict[str, Any]

    def _base(self) -> list[str]:
        chain = self.config["chain"]
        return [self.binary, "--node", chain["rpc"], "--chain-id", chain["chain_id"]]

    def run(self, args: list[str]) -> Any:
        command = [self.binary, *args]
        completed = subprocess.run(command, check=False, capture_output=True, text=True)
        if completed.returncode:
            raise RuntimeError(
                f"junod command failed ({completed.returncode}): {' '.join(command[:4])}: "
                f"{completed.stderr.strip()}"
            )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("junod returned non-JSON output") from error

    def tx(self, args: list[str]) -> dict[str, Any]:
        chain = self.config["chain"]
        return self.run(
            [
                "tx",
                "wasm",
                *args,
                "--from",
                chain["deployer_key_name"],
                "--node",
                chain["rpc"],
                "--chain-id",
                chain["chain_id"],
                "--gas",
                "auto",
                "--gas-adjustment",
                str(chain["gas_adjustment"]),
                "--gas-prices",
                chain["gas_prices"],
                "--broadcast-mode",
                "sync",
                "--yes",
                "--output",
                "json",
            ]
        )

    def wait_tx(self, tx_hash: str) -> dict[str, Any]:
        timeout = self.config["chain"]["tx_timeout_seconds"]
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = self.run(
                    [
                        "query",
                        "tx",
                        tx_hash,
                        "--node",
                        self.config["chain"]["rpc"],
                        "--output",
                        "json",
                    ]
                )
            except RuntimeError:
                time.sleep(2)
                continue
            response = result.get("tx_response", result)
            if not isinstance(response, dict):
                raise RuntimeError(f"transaction {tx_hash} response is malformed")
            reported_hash = str(response.get("txhash", "")).upper()
            if reported_hash != tx_hash.upper():
                raise RuntimeError(
                    f"transaction query returned {reported_hash!r}, expected {tx_hash!r}"
                )
            try:
                code = int(response.get("code", 0))
            except (TypeError, ValueError) as error:
                raise RuntimeError(f"transaction {tx_hash} code is malformed") from error
            if code:
                raise RuntimeError(f"transaction {tx_hash} failed with code {code}")
            return result
        raise RuntimeError(f"transaction {tx_hash} was not indexed before timeout")

    def query_wasm(self, args: list[str]) -> dict[str, Any]:
        return self.run(
            [
                "query",
                "wasm",
                *args,
                "--node",
                self.config["chain"]["rpc"],
                "--output",
                "json",
            ]
        )

    def code_info(self, code_id: int) -> dict[str, Any]:
        result = self.query_wasm(["code-info", str(code_id)])
        return result.get("code_info", result)

    def contract_info(self, address: str) -> dict[str, Any]:
        result = self.query_wasm(["contract", address])
        return result.get("contract_info", result)

    def smart(self, address: str, query: dict[str, Any]) -> Any:
        result = self.query_wasm(
            ["contract-state", "smart", address, canonical_json(query).decode()]
        )
        return result.get("data", result)

    def balance(self, address: str, denom: str) -> str:
        result = self.run(
            [
                "query",
                "bank",
                "balance",
                address,
                denom,
                "--node",
                self.config["chain"]["rpc"],
                "--output",
                "json",
            ]
        )
        amount = _nested(result, ("balance", "amount"), ("amount",))
        return str(_uint(amount, f"bank.balance.{address}.{denom}"))

    def code_ids_by_checksum(self, checksum: str) -> list[int]:
        matches: list[int] = []
        page_key: str | None = None
        seen_keys: set[str] = set()
        while True:
            arguments = ["list-code", "--limit", "100"]
            if page_key:
                arguments.extend(["--page-key", page_key])
            result = self.query_wasm(arguments)
            infos = result.get("code_infos", [])
            if not isinstance(infos, list):
                raise RuntimeError("list-code response is malformed")
            for info in infos:
                if isinstance(info, dict) and _chain_checksum(info) == checksum:
                    matches.append(_uint(info.get("code_id"), "code_info.code_id", positive=True))
            pagination = result.get("pagination") or {}
            next_key = pagination.get("next_key")
            if not next_key:
                return sorted(set(matches))
            if not isinstance(next_key, str) or next_key in seen_keys:
                raise RuntimeError("list-code pagination did not make progress")
            seen_keys.add(next_key)
            page_key = next_key

    def status(self) -> dict[str, Any]:
        return self.run(
            [
                "status",
                "--node",
                self.config["chain"]["rpc"],
                "--output",
                "json",
            ]
        )

    def staking_params(self) -> dict[str, Any]:
        return self.run(
            [
                "query",
                "staking",
                "params",
                "--node",
                self.config["chain"]["rpc"],
                "--output",
                "json",
            ]
        )

    def module_account(self, name: str) -> dict[str, Any]:
        return self.run(
            [
                "query",
                "auth",
                "module-account",
                name,
                "--node",
                self.config["chain"]["rpc"],
                "--output",
                "json",
            ]
        )

    def key_record(self) -> Any:
        return self.run(
            [
                "keys",
                "show",
                self.config["chain"]["deployer_key_name"],
                "--output",
                "json",
            ]
        )


def _tx_hash(response: dict[str, Any]) -> str:
    tx_response = response.get("tx_response", response)
    if not isinstance(tx_response, dict):
        raise RuntimeError("broadcast response is malformed")
    try:
        code = int(tx_response.get("code", 0))
    except (TypeError, ValueError) as error:
        raise RuntimeError("broadcast response code is malformed") from error
    if code != 0:
        raw_log = tx_response.get("raw_log") or tx_response.get("log") or ""
        raise RuntimeError(f"broadcast rejected with code {code}: {raw_log}")
    value = tx_response.get("txhash")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9A-Fa-f]{64}", value):
        raise RuntimeError("broadcast response did not contain a transaction hash")
    return value.upper()


def _event_values(tx: dict[str, Any], key: str) -> list[str]:
    events = tx.get("events") or tx.get("tx_response", {}).get("events") or []
    result: list[str] = []
    for event in events:
        for attribute in event.get("attributes", []):
            attribute_key = attribute.get("key")
            attribute_value = attribute.get("value", "")
            if attribute_key != key and isinstance(attribute_key, str):
                try:
                    attribute_key = base64.b64decode(attribute_key, validate=True).decode()
                    attribute_value = base64.b64decode(attribute_value, validate=True).decode()
                except (ValueError, UnicodeDecodeError):
                    pass
            if attribute_key == key:
                result.append(attribute_value)
    return result


def _chain_checksum(info: dict[str, Any]) -> str:
    for key in ("code_hash", "checksum", "data_hash"):
        value = info.get(key)
        if isinstance(value, str):
            normalized = value.removeprefix("0x").lower()
            if HEX_64.fullmatch(normalized):
                return normalized
            try:
                decoded = base64.b64decode(value, validate=True)
            except ValueError:
                decoded = b""
            if len(decoded) == 32:
                return decoded.hex()
    raise RuntimeError("code-info response did not contain a 32-byte checksum")


def _nested(value: Any, *paths: tuple[str, ...]) -> Any:
    for path in paths:
        current = value
        for key in path:
            if not isinstance(current, dict) or key not in current:
                break
            current = current[key]
        else:
            return current
    return None


def observe_cutover_state(config: dict[str, Any], junod: Junod) -> dict[str, Any]:
    cutover = config["cutover"]
    if cutover["mode"] == "no_prior_composition":
        return {"mode": "no_prior_composition", "historical_v1": None}

    historical = cutover["historical_v1"]
    contract_info: dict[str, Any] = {}
    code_checksums: dict[str, str] = {}
    for component, identity in historical.items():
        contract_info[component] = copy.deepcopy(junod.contract_info(identity["address"]))
        code_checksums[component] = _chain_checksum(
            junod.code_info(
                _uint(
                    identity["code_id"],
                    f"cutover.historical_v1.{component}.code_id",
                    positive=True,
                )
            )
        )

    addresses = {component: identity["address"] for component, identity in historical.items()}
    denom = config["chain"]["native_denom"]
    return {
        "mode": "replace_historical_v1",
        "historical_v1": {
            "contract_info": contract_info,
            "code_checksums": code_checksums,
            "balances": {
                component: junod.balance(addresses[component], denom)
                for component in ("program_vault", "bounty", "registry")
            },
            "bounty_health": copy.deepcopy(junod.smart(addresses["bounty"], {"health": {}})),
            "bounty_page": copy.deepcopy(
                junod.smart(
                    addresses["bounty"],
                    {"bounties": {"start_after": None, "limit": 1}},
                )
            ),
            "registry_health": copy.deepcopy(
                junod.smart(addresses["registry"], {"health": {}})
            ),
            "registry_projects": copy.deepcopy(
                junod.smart(
                    addresses["registry"],
                    {"projects": {"start_after": None, "limit": 1}},
                )
            ),
            "registry_applications": copy.deepcopy(
                junod.smart(
                    addresses["registry"],
                    {"applications": {"start_after": None, "limit": 1}},
                )
            ),
            "registry_options": copy.deepcopy(
                junod.smart(
                    addresses["registry"],
                    {"all_options": {"start_after": None, "limit": 2}},
                )
            ),
            "gauge_state": copy.deepcopy(
                junod.smart(addresses["gauge"], {"gauge": {"id": 0}})
            ),
            "gauge_epochs": copy.deepcopy(
                junod.smart(
                    addresses["gauge"],
                    {"list_epochs": {"gauge": 0, "start_after": None, "limit": 1}},
                )
            ),
        },
    }


def validate_cutover_observation(config: dict[str, Any], observation: Any) -> None:
    observation = _object(observation, "preflight.cutover", ("mode", "historical_v1"))
    expected_mode = config["cutover"]["mode"]
    if observation["mode"] != expected_mode:
        _fail("preflight.cutover.mode", "does not match deployment config")
    if expected_mode == "no_prior_composition":
        if observation["historical_v1"] is not None:
            _fail("preflight.cutover.historical_v1", "must be null")
        return

    observed = _object(
        observation["historical_v1"],
        "preflight.cutover.historical_v1",
        (
            "contract_info",
            "code_checksums",
            "balances",
            "bounty_health",
            "bounty_page",
            "registry_health",
            "registry_projects",
            "registry_applications",
            "registry_options",
            "gauge_state",
            "gauge_epochs",
        ),
    )
    expected = config["cutover"]["historical_v1"]
    contract_info = _object(
        observed["contract_info"],
        "preflight.cutover.historical_v1.contract_info",
        expected,
    )
    checksums = _object(
        observed["code_checksums"],
        "preflight.cutover.historical_v1.code_checksums",
        expected,
    )
    for component, identity in expected.items():
        info = contract_info[component]
        if not isinstance(info, dict):
            _fail(
                f"preflight.cutover.historical_v1.contract_info.{component}",
                "must be an object",
            )
        expected_code_id = _uint(
            identity["code_id"],
            f"cutover.historical_v1.{component}.code_id",
            positive=True,
        )
        if _contract_code_id(info) != expected_code_id:
            _fail(
                f"preflight.cutover.historical_v1.contract_info.{component}.code_id",
                "does not match the historical composition",
            )
        if info.get("admin") != config["chain"]["xgov_module_account"]:
            _fail(
                f"preflight.cutover.historical_v1.contract_info.{component}.admin",
                "does not match the disclosed x/gov module account",
            )
        if checksums[component] != identity["checksum"]:
            _fail(
                f"preflight.cutover.historical_v1.code_checksums.{component}",
                "does not match the historical composition",
            )

    balances = _object(
        observed["balances"],
        "preflight.cutover.historical_v1.balances",
        ("program_vault", "bounty", "registry"),
    )
    for component, amount in balances.items():
        if _uint(amount, f"preflight.cutover.historical_v1.balances.{component}") != 0:
            _fail(
                f"preflight.cutover.historical_v1.balances.{component}",
                "must be zero before cutover",
            )

    zero_bounty_accounting = {
        "active_escrow": "0",
        "outstanding_refunds": "0",
        "pending_payout_liabilities": "0",
        "lifetime_received": "0",
        "lifetime_paid": "0",
        "lifetime_refunded": "0",
    }
    bounty_health = observed["bounty_health"]
    if not isinstance(bounty_health, dict):
        _fail("preflight.cutover.historical_v1.bounty_health", "must be an object")
    if bounty_health != {
        "accounting": zero_bounty_accounting,
        "actual_native_balance": "0",
        "liabilities": "0",
        "fully_backed": True,
    }:
        _fail("preflight.cutover.historical_v1.bounty_health", "must be exactly empty")
    if observed["bounty_page"] != {"bounties": []}:
        _fail("preflight.cutover.historical_v1.bounty_page", "must be empty")

    zero_registry_accounting = {
        "active_projects": 0,
        "pending_applications": 0,
        "bond_liability": "0",
        "lifetime_bonds_received": "0",
        "lifetime_bonds_refunded": "0",
        "lifetime_bonds_forfeited": "0",
    }
    registry_health = observed["registry_health"]
    if registry_health != {
        "accounting": zero_registry_accounting,
        "actual_native_balance": "0",
        "fully_backed": True,
    }:
        _fail("preflight.cutover.historical_v1.registry_health", "must be exactly empty")
    for field in ("registry_projects", "registry_applications"):
        if observed[field] != {"projects": []}:
            _fail(f"preflight.cutover.historical_v1.{field}", "must be empty")
    if observed["registry_options"] != {"options": ["do-not-distribute"]}:
        _fail(
            "preflight.cutover.historical_v1.registry_options",
            "must contain only the retained option",
        )
    gauge_state = observed["gauge_state"]
    if (
        not isinstance(gauge_state, dict)
        or "current_epoch" not in gauge_state
        or gauge_state["current_epoch"] is not None
    ):
        _fail("preflight.cutover.historical_v1.gauge_state.current_epoch", "must be null")
    if observed["gauge_epochs"] != {"epochs": []}:
        _fail("preflight.cutover.historical_v1.gauge_epochs", "must be empty")


def preflight_chain(config: dict[str, Any], junod: Junod) -> dict[str, Any]:
    """Reject a wrong, unsynced, or economically incompatible target chain."""
    status = junod.status()
    observed_chain_id = _nested(
        status,
        ("NodeInfo", "network"),
        ("node_info", "network"),
        ("result", "node_info", "network"),
        ("default_node_info", "network"),
    )
    expected_chain_id = config["chain"]["chain_id"]
    if observed_chain_id != expected_chain_id:
        raise RuntimeError(
            f"chain ID mismatch: expected {expected_chain_id!r}, found {observed_chain_id!r}"
        )

    catching_up = _nested(
        status,
        ("SyncInfo", "catching_up"),
        ("sync_info", "catching_up"),
        ("result", "sync_info", "catching_up"),
    )
    if catching_up not in (False, "false"):
        raise RuntimeError(f"RPC node is not confirmed synced: catching_up={catching_up!r}")

    latest_height = _nested(
        status,
        ("SyncInfo", "latest_block_height"),
        ("sync_info", "latest_block_height"),
        ("result", "sync_info", "latest_block_height"),
    )
    height = _uint(latest_height, "status.latest_block_height", positive=True)

    staking = junod.staking_params()
    bond_denom = _nested(staking, ("params", "bond_denom"), ("bond_denom",))
    expected_denom = config["chain"]["native_denom"]
    if bond_denom != expected_denom:
        raise RuntimeError(
            "staking bond denom mismatch: "
            f"contracts require {expected_denom!r}, chain reports {bond_denom!r}"
        )

    module_response = junod.module_account("gov")
    module_account = _nested(module_response, ("account",), ())
    observed_xgov = _nested(
        module_account,
        ("base_account", "address"),
        ("base_account", "value", "address"),
        ("value", "address"),
        ("address",),
    )
    observed_name = _nested(module_account, ("name",), ("value", "name"))
    expected_xgov = config["chain"]["xgov_module_account"]
    if observed_name not in (None, "gov"):
        raise RuntimeError(f"auth query returned module {observed_name!r}, expected 'gov'")
    if observed_xgov != expected_xgov:
        raise RuntimeError(
            f"x/gov module account mismatch: expected {expected_xgov!r}, "
            f"chain reports {observed_xgov!r}"
        )

    cutover = observe_cutover_state(config, junod)
    validate_cutover_observation(config, cutover)
    return {
        "schema_version": PREFLIGHT_SCHEMA,
        "config_sha256": config_hash(config),
        "chain_id": observed_chain_id,
        "latest_block_height": height,
        "catching_up": False,
        "staking_bond_denom": bond_denom,
        "xgov_module_account": observed_xgov,
        "cutover": cutover,
        "checks": [
            "chain_id",
            "rpc_synced",
            "staking_bond_denom",
            "xgov_module_account",
            "cutover",
        ],
    }


def validate_deployer_key(config: dict[str, Any], junod: Junod) -> str:
    """Bind the local signing-key name to the configured instantiate2 creator."""
    record = junod.key_record()
    observed = record if isinstance(record, str) else _nested(record, ("address",))
    expected = config["chain"]["deployer_address"]
    if observed != expected:
        raise RuntimeError(
            "deployer key address mismatch: "
            f"configured key {config['chain']['deployer_key_name']!r} resolves to "
            f"{observed!r}, expected {expected!r}"
        )
    decode_address(observed, config["chain"]["bech32_prefix"], "deployer_key.address")
    return observed


def validate_preflight_report(config: dict[str, Any], report: dict[str, Any]) -> None:
    _object(
        report,
        "preflight",
        (
            "schema_version",
            "config_sha256",
            "chain_id",
            "latest_block_height",
            "catching_up",
            "staking_bond_denom",
            "xgov_module_account",
            "cutover",
            "checks",
        ),
    )
    if report["schema_version"] != PREFLIGHT_SCHEMA:
        _fail("preflight.schema_version", f"must equal {PREFLIGHT_SCHEMA!r}")
    if report["config_sha256"] != config_hash(config):
        _fail("preflight.config_sha256", "does not match deployment config")
    if report["chain_id"] != config["chain"]["chain_id"]:
        _fail("preflight.chain_id", "does not match deployment config")
    _uint(report["latest_block_height"], "preflight.latest_block_height", positive=True)
    if report["catching_up"] is not False:
        _fail("preflight.catching_up", "must be false")
    if report["staking_bond_denom"] != config["chain"]["native_denom"]:
        _fail("preflight.staking_bond_denom", "does not match deployment config")
    if report["xgov_module_account"] != config["chain"]["xgov_module_account"]:
        _fail("preflight.xgov_module_account", "does not match deployment config")
    validate_cutover_observation(config, report["cutover"])
    expected_checks = {
        "chain_id",
        "rpc_synced",
        "staking_bond_denom",
        "xgov_module_account",
        "cutover",
    }
    if not isinstance(report["checks"], list) or set(report["checks"]) != expected_checks:
        _fail("preflight.checks", "does not contain the complete preflight check set")


def verify_code_ids(config: dict[str, Any], code_ids: dict[str, int], junod: Junod) -> list[str]:
    checks: list[str] = []
    if set(code_ids) != set(REQUIRED_ARTIFACTS):
        raise ValidationError("all five exact code IDs are required for chain verification")
    seen: set[int] = set()
    historical_code_ids = (
        {
            _uint(identity["code_id"], f"cutover.historical_v1.{component}.code_id", positive=True)
            for component, identity in config["cutover"]["historical_v1"].items()
        }
        if config["cutover"]["mode"] == "replace_historical_v1"
        else set()
    )
    for name, expected in config["artifacts"].items():
        code_id = _uint(code_ids[name], f"state.code_ids.{name}", positive=True)
        if code_id in seen:
            raise ValidationError(f"state.code_ids.{name}: duplicate code ID {code_id}")
        seen.add(code_id)
        if code_id in historical_code_ids:
            raise ValidationError(
                f"state.code_ids.{name}: v2 code ID {code_id} reuses a historical v1 code ID"
            )
        actual = _chain_checksum(junod.code_info(code_id))
        if actual != expected["sha256"]:
            raise RuntimeError(
                f"code ID {code_id} checksum mismatch for {name}: expected "
                f"{expected['sha256']}, found {actual}"
            )
        checks.append(f"code:{name}:{code_id}:{actual}")
    return checks


def _expect_equal(checks: list[str], label: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        raise RuntimeError(f"{label} mismatch: expected {expected!r}, found {actual!r}")
    checks.append(label)


def _contract_code_id(info: dict[str, Any]) -> int:
    value = info.get("code_id")
    return _uint(value, "contract_info.code_id", positive=True)


def _agent_membership_spec(agent: dict[str, Any]) -> tuple[str, str, int, str]:
    membership = agent["membership"]
    if membership["kind"] == "cw4":
        return (
            "cw4_group",
            membership["group_address"],
            _uint(
                membership["group_code_id"],
                "agent_operations.membership.group_code_id",
                positive=True,
            ),
            membership["group_checksum"],
        )
    return (
        "nft",
        membership["nft_address"],
        _uint(
            membership["nft_code_id"],
            "agent_operations.membership.nft_code_id",
            positive=True,
        ),
        membership["nft_checksum"],
    )


def _agent_proposal_threshold(agent: dict[str, Any]) -> dict[str, Any]:
    threshold = agent["proposal"]["threshold"]
    if threshold["kind"] == "absolute_count":
        return {"absolute_count": {"threshold": str(threshold["weight"])}}
    return {
        "threshold_quorum": {
            "threshold": {"majority": {}},
            "quorum": {"percent": threshold["quorum"]},
        }
    }


def expected_verification_checks(
    config: dict[str, Any], code_ids: dict[str, int]
) -> list[str]:
    checks = [
        f"code:{name}:{code_ids[name]}:{config['artifacts'][name]['sha256']}"
        for name in config["artifacts"]
    ]
    for component in ("program_vault", "bounty", "registry", "voting_module", "gauge"):
        checks.extend(
            (
                f"contract:{component}:code_id",
                f"contract:{component}:admin",
                f"contract:{component}:creator",
            )
        )
    checks.extend(
        (
            "vault:external_admin",
            "vault:voting_module",
            "voting:dao",
            "vault:sole_execution_module",
            "vault:fresh_balance",
        )
    )
    checks.extend(
        f"bounty:{field}"
        for field in (
            "native_denom",
            "governor",
            "agent",
            "registry",
            "min_contribution",
            "max_bounty_total",
            "min_lifetime_seconds",
            "max_lifetime_seconds",
            "max_contributors",
            "max_rounds",
            "limits",
            "ratification_seconds",
        )
    )
    checks.extend(("bounty:fresh_identity", "bounty:fresh_page", "bounty:fresh_health"))
    registry_fields = list(instantiate_messages(config, code_ids)["registry"])
    checks.extend(f"registry:{field}" for field in registry_fields)
    checks.append("registry:max_active_projects")
    checks.extend(
        (
            "registry:fresh_identity",
            "registry:fresh_projects",
            "registry:fresh_applications",
            "registry:fresh_options",
            "registry:fresh_health",
        )
    )
    checks.extend(
        f"gauge:{field}"
        for field in (
            "dao_core",
            "owner",
            "voting_powers",
            "hook_caller",
            "power_source",
            "title",
            "adapter",
            "epoch_size",
            "min_percent_selected",
            "max_options_selected",
            "max_available_percentage",
            "snapshot_policy",
        )
    )
    checks.extend(("gauge:fresh_state", "gauge:fresh_epochs"))
    agent = config["agent_operations"]
    membership_kind = agent["membership"]["kind"]
    checks.extend(
        (
            "agent:voting_module",
            "agent:sole_proposal_module",
            "agent:membership_contract",
            "agent:membership_items",
            "agent:membership_exhausted",
            "agent:total_power",
            "agent:proposal_dao",
            "agent:threshold",
            "agent:voting_duration",
        )
    )
    if membership_kind == "cw721_roles":
        checks.extend(("agent:nft_minter", "agent:nft_token_count"))
        checks.extend(
            f"agent:nft_token:{item['token_id']}"
            for item in agent["membership"]["tokens"]
        )
    membership_label = _agent_membership_spec(agent)[0]
    for label in ("core", "voting", "proposal", membership_label):
        checks.extend((f"agent:{label}:code_id", f"agent:{label}:checksum"))
    return checks


def validate_verification_observations(
    config: dict[str, Any],
    code_ids: dict[str, int],
    addresses: dict[str, str],
    observations: Any,
) -> None:
    if config["cutover"]["mode"] == "replace_historical_v1":
        historical_code_ids = {
            _uint(
                identity["code_id"],
                f"cutover.historical_v1.{component}.code_id",
                positive=True,
            )
            for component, identity in config["cutover"]["historical_v1"].items()
        }
        v2_code_ids = {
            _uint(value, f"verification.code_ids.{name}", positive=True)
            for name, value in code_ids.items()
        }
        reused = v2_code_ids & historical_code_ids
        if reused:
            raise RuntimeError(
                f"verification reuses historical v1 code IDs: {sorted(reused)!r}"
            )
    observations = _object(
        observations,
        "verification.observations",
        (
            "release_code_checksums",
            "contract_info",
            "vault_state",
            "vault_balance",
            "voting_dao",
            "bounty_config",
            "bounty_identity_state",
            "bounty_page",
            "bounty_health",
            "registry_config",
            "registry_identity_state",
            "registry_projects",
            "registry_applications",
            "registry_options",
            "registry_health",
            "gauge_config",
            "gauge_state",
            "gauge_epochs",
            "agent_core_state",
            "agent_membership_contract",
            "agent_membership_page",
            "agent_membership_tail",
            "agent_total_power",
            "agent_nft_minter",
            "agent_nft_num_tokens",
            "agent_nft_token_info",
            "agent_proposal_config",
            "agent_code_checksums",
            "agent_contract_info",
        ),
    )

    def expect(label: str, actual: Any, expected: Any) -> None:
        if actual != expected:
            raise RuntimeError(
                f"verification observation {label} mismatch: "
                f"expected {expected!r}, found {actual!r}"
            )

    expect(
        "release_code_checksums",
        observations["release_code_checksums"],
        {name: config["artifacts"][name]["sha256"] for name in config["artifacts"]},
    )
    contract_infos = _object(
        observations["contract_info"],
        "verification.observations.contract_info",
        ("program_vault", "bounty", "registry", "voting_module", "gauge"),
    )
    contract_specs = {
        "program_vault": ("dao_dao_core", config["chain"]["deployer_address"]),
        "bounty": ("juno_voice_bounties", config["chain"]["deployer_address"]),
        "registry": (
            "hack_juno_registry_adapter",
            config["chain"]["deployer_address"],
        ),
        "voting_module": ("dao_voting_juno_staked", addresses["program_vault"]),
        "gauge": ("gauge_orchestrator", addresses["program_vault"]),
    }
    for component, (artifact, creator) in contract_specs.items():
        info = contract_infos[component]
        if not isinstance(info, dict):
            _fail(f"verification.observations.contract_info.{component}", "must be an object")
        expect(
            f"contract_info.{component}.code_id",
            _contract_code_id(info),
            code_ids[artifact],
        )
        expect(
            f"contract_info.{component}.admin",
            info.get("admin"),
            config["chain"]["xgov_module_account"],
        )
        expect(f"contract_info.{component}.creator", info.get("creator"), creator)

    vault = observations["vault_state"]
    if not isinstance(vault, dict):
        _fail("verification.observations.vault_state", "must be an object")
    expect(
        "vault_state.admin",
        vault.get("admin"),
        config["chain"]["xgov_module_account"],
    )
    expect(
        "vault_state.voting_module",
        vault.get("voting_module"),
        addresses["voting_module"],
    )
    modules = vault.get("proposal_modules")
    if not isinstance(modules, list):
        _fail("verification.observations.vault_state.proposal_modules", "must be an array")
    expect(
        "vault_state.enabled_modules",
        [
            item.get("address")
            for item in modules
            if isinstance(item, dict) and str(item.get("status", "")).lower() == "enabled"
        ],
        [addresses["gauge"]],
    )
    expect("voting_dao", observations["voting_dao"], addresses["program_vault"])
    expect("vault_balance", observations["vault_balance"], "0")

    messages = instantiate_messages(config, code_ids)
    bounty = observations["bounty_config"]
    if not isinstance(bounty, dict):
        _fail("verification.observations.bounty_config", "must be an object")
    for field, expected in messages["bounty"].items():
        expect(f"bounty_config.{field}", bounty.get(field), expected)
    expect(
        "bounty_config.ratification_seconds",
        bounty.get("ratification_seconds"),
        RATIFICATION_SECONDS,
    )
    expect("bounty_identity_state", observations["bounty_identity_state"], {"next_bounty_id": 1})
    expect("bounty_page", observations["bounty_page"], {"bounties": []})
    expect(
        "bounty_health",
        observations["bounty_health"],
        {
            "accounting": {
                "active_escrow": "0",
                "outstanding_refunds": "0",
                "pending_payout_liabilities": "0",
                "lifetime_received": "0",
                "lifetime_paid": "0",
                "lifetime_refunded": "0",
            },
            "actual_native_balance": "0",
            "liabilities": "0",
            "fully_backed": True,
        },
    )

    registry = observations["registry_config"]
    if not isinstance(registry, dict):
        _fail("verification.observations.registry_config", "must be an object")
    for field, expected in messages["registry"].items():
        path = f"registry_config.{field}"
        if field in ("min_project_share", "max_project_share"):
            expect(
                path,
                _canonical_fraction(registry.get(field), path),
                _canonical_fraction(expected, path),
            )
        else:
            expect(path, registry.get(field), expected)
    expect(
        "registry_config.max_active_projects",
        registry.get("max_active_projects"),
        MAX_ACTIVE_PROJECTS,
    )
    expect(
        "registry_identity_state",
        observations["registry_identity_state"],
        {"next_project_id": 1, "consumed_source_bounties": 0},
    )
    expect("registry_projects", observations["registry_projects"], {"projects": []})
    expect("registry_applications", observations["registry_applications"], {"projects": []})
    expect(
        "registry_options",
        observations["registry_options"],
        {"options": [config["registry"]["reserved_option"]]},
    )
    expect(
        "registry_health",
        observations["registry_health"],
        {
            "accounting": {
                "active_projects": 0,
                "pending_applications": 0,
                "bond_liability": "0",
                "lifetime_bonds_received": "0",
                "lifetime_bonds_refunded": "0",
                "lifetime_bonds_forfeited": "0",
            },
            "actual_native_balance": "0",
            "fully_backed": True,
        },
    )

    gauge_config = observations["gauge_config"]
    if not isinstance(gauge_config, dict):
        _fail("verification.observations.gauge_config", "must be an object")
    for field, expected in {
        "dao_core": addresses["program_vault"],
        "owner": addresses["program_vault"],
        "voting_powers": addresses["voting_module"],
        "hook_caller": addresses["gauge"],
        "power_source": {"epoch_snapshot": {"guardian": addresses["agent_operations"]}},
    }.items():
        expect(f"gauge_config.{field}", gauge_config.get(field), expected)
    gauge_state = observations["gauge_state"]
    if not isinstance(gauge_state, dict):
        _fail("verification.observations.gauge_state", "must be an object")
    expected_gauge = messages["gauge_inner"]["gauges"][0]
    for field in (
        "title",
        "adapter",
        "epoch_size",
        "min_percent_selected",
        "max_options_selected",
        "max_available_percentage",
        "snapshot_policy",
    ):
        path = f"gauge_state.{field}"
        if field in ("min_percent_selected", "max_available_percentage"):
            expect(
                path,
                _canonical_fraction(gauge_state.get(field), path),
                _canonical_fraction(expected_gauge[field], path),
            )
        else:
            expect(path, gauge_state.get(field), expected_gauge[field])
    if (
        "current_epoch" not in gauge_state
        or gauge_state["current_epoch"] is not None
        or gauge_state.get("is_stopped") is not False
    ):
        _fail(
            "verification.observations.gauge_state",
            "must have no current epoch and must start unstopped",
        )
    expect("gauge_epochs", observations["gauge_epochs"], {"epochs": []})

    agent = config["agent_operations"]
    agent_core = observations["agent_core_state"]
    if not isinstance(agent_core, dict):
        _fail("verification.observations.agent_core_state", "must be an object")
    expect(
        "agent_core_state.voting_module",
        agent_core.get("voting_module"),
        agent["voting_module_address"],
    )
    agent_modules = agent_core.get("proposal_modules")
    if not isinstance(agent_modules, list):
        _fail("verification.observations.agent_core_state.proposal_modules", "must be an array")
    expect(
        "agent_core_state.enabled_modules",
        [
            item.get("address")
            for item in agent_modules
            if isinstance(item, dict) and str(item.get("status", "")).lower() == "enabled"
        ],
        [agent["proposal_module_address"]],
    )
    membership = agent["membership"]
    membership_label, membership_address, membership_code_id, membership_checksum = _agent_membership_spec(agent)
    expect("agent_membership_contract", observations["agent_membership_contract"], membership_address)
    expect(
        "agent_total_power",
        observations["agent_total_power"],
        {"power": str(membership["total_power"])},
    )
    page = observations["agent_membership_page"]
    tail = observations["agent_membership_tail"]
    if membership["kind"] == "cw4":
        if not isinstance(page, dict) or not isinstance(page.get("members"), list):
            _fail("verification.observations.agent_membership_page", "must contain a members array")
        actual_items = sorted(
            (
                {
                    "address": item.get("addr"),
                    "weight": _uint(
                        item.get("weight"),
                        "verification.observations.agent_membership_page.members.weight",
                        positive=True,
                    ),
                }
                for item in page["members"]
                if isinstance(item, dict)
            ),
            key=lambda item: item["address"],
        )
        expected_items = [
            {
                "address": item["address"],
                "weight": _uint(
                    item["weight"],
                    "agent_operations.membership.members.weight",
                    positive=True,
                ),
            }
            for item in membership["members"]
        ]
        expect(
            "agent_membership_page",
            actual_items,
            sorted(expected_items, key=lambda item: item["address"]),
        )
        if not isinstance(tail, dict):
            _fail("verification.observations.agent_membership_tail", "must be an object")
        expect("agent_membership_tail", tail.get("members"), [])
        expect("agent_nft_minter", observations["agent_nft_minter"], None)
        expect("agent_nft_num_tokens", observations["agent_nft_num_tokens"], None)
        expect("agent_nft_token_info", observations["agent_nft_token_info"], {})
    else:
        if not isinstance(page, dict) or not isinstance(page.get("tokens"), list):
            _fail("verification.observations.agent_membership_page", "must contain a tokens array")
        expected_ids = sorted(item["token_id"] for item in membership["tokens"])
        actual_ids = page["tokens"]
        if len(actual_ids) != len(set(actual_ids)):
            raise RuntimeError("verification observation agent NFT token page contains duplicates")
        expect("agent_membership_page", actual_ids, expected_ids)
        if not isinstance(tail, dict):
            _fail("verification.observations.agent_membership_tail", "must be an object")
        expect("agent_membership_tail", tail.get("tokens"), [])
        expect("agent_nft_minter", observations["agent_nft_minter"], {"minter": membership["minter"]})
        expect("agent_nft_num_tokens", observations["agent_nft_num_tokens"], {"count": len(expected_ids)})
        token_info = observations["agent_nft_token_info"]
        if not isinstance(token_info, dict) or set(token_info) != set(expected_ids):
            raise RuntimeError("verification observation agent NFT token details are incomplete or substituted")
        expected_tokens = {item["token_id"]: item for item in membership["tokens"]}
        for token_id in expected_ids:
            observed = token_info[token_id]
            if not isinstance(observed, dict):
                _fail(f"verification.observations.agent_nft_token_info.{token_id}", "must be an object")
            expected_token = expected_tokens[token_id]
            expect(f"agent_nft_token_info.{token_id}.owner", _nested(observed, ("access", "owner")), expected_token["owner"])
            expect(f"agent_nft_token_info.{token_id}.role", _nested(observed, ("info", "extension", "role")), expected_token["role"])
            expect(
                f"agent_nft_token_info.{token_id}.weight",
                _uint(
                    _nested(observed, ("info", "extension", "weight")),
                    f"verification.observations.agent_nft_token_info.{token_id}.weight",
                    positive=True,
                ),
                _uint(
                    expected_token["weight"],
                    f"agent_operations.membership.tokens.{token_id}.weight",
                    positive=True,
                ),
            )
    proposal = observations["agent_proposal_config"]
    if not isinstance(proposal, dict):
        _fail("verification.observations.agent_proposal_config", "must be an object")
    expect("agent_proposal_config.dao", proposal.get("dao"), agent["core_address"])
    expect("agent_proposal_config.threshold", proposal.get("threshold"), _agent_proposal_threshold(agent))
    observed_period = _object(
        proposal.get("max_voting_period"),
        "verification.observations.agent_proposal_config.max_voting_period",
        ("time",),
    )
    expect(
        "agent_proposal_config.max_voting_period",
        {
            "time": _uint(
                observed_period.get("time"),
                "verification.observations.agent_proposal_config.max_voting_period.time",
                positive=True,
            )
        },
        {
            "time": _uint(
                agent["proposal"]["voting_duration_seconds"],
                "agent_operations.proposal.voting_duration_seconds",
                positive=True,
            )
        },
    )
    expected_agent_checksums = {
        "core": agent["core_checksum"],
        "voting": agent["voting_checksum"],
        "proposal": agent["proposal_checksum"],
        membership_label: membership_checksum,
    }
    expect("agent_code_checksums", observations["agent_code_checksums"], expected_agent_checksums)
    expected_agent_code_ids = {
        "core": _uint(
            agent["core_code_id"], "agent_operations.core_code_id", positive=True
        ),
        "voting": _uint(
            agent["voting_code_id"], "agent_operations.voting_code_id", positive=True
        ),
        "proposal": _uint(
            agent["proposal_code_id"], "agent_operations.proposal_code_id", positive=True
        ),
        membership_label: membership_code_id,
    }
    agent_infos = _object(
        observations["agent_contract_info"],
        "verification.observations.agent_contract_info",
        expected_agent_code_ids,
    )
    for label, expected_code_id in expected_agent_code_ids.items():
        info = agent_infos[label]
        if not isinstance(info, dict):
            _fail(f"verification.observations.agent_contract_info.{label}", "must be an object")
        expect(f"agent_contract_info.{label}.code_id", _contract_code_id(info), expected_code_id)


def verify_deployment(
    config: dict[str, Any],
    state: dict[str, Any],
    junod: Junod,
    preflight: dict[str, Any],
) -> dict[str, Any]:
    validate_preflight_report(config, preflight)
    checks = verify_code_ids(config, state["code_ids"], junod)
    addresses = derive_addresses(config)
    code_ids = state["code_ids"]
    xgov = config["chain"]["xgov_module_account"]
    deployer = config["chain"]["deployer_address"]

    contract_specs = {
        "program_vault": ("dao_dao_core", deployer),
        "bounty": ("juno_voice_bounties", deployer),
        "registry": ("hack_juno_registry_adapter", deployer),
        "voting_module": ("dao_voting_juno_staked", addresses["program_vault"]),
        "gauge": ("gauge_orchestrator", addresses["program_vault"]),
    }
    contract_infos: dict[str, Any] = {}
    for component, (artifact, creator) in contract_specs.items():
        info = junod.contract_info(addresses[component])
        contract_infos[component] = copy.deepcopy(info)
        _expect_equal(
            checks,
            f"contract:{component}:code_id",
            _contract_code_id(info),
            code_ids[artifact],
        )
        _expect_equal(checks, f"contract:{component}:admin", info.get("admin"), xgov)
        _expect_equal(checks, f"contract:{component}:creator", info.get("creator"), creator)

    vault = junod.smart(addresses["program_vault"], {"dump_state": {}})
    _expect_equal(checks, "vault:external_admin", vault.get("admin"), xgov)
    _expect_equal(checks, "vault:voting_module", vault.get("voting_module"), addresses["voting_module"])
    voting_dao = junod.smart(addresses["voting_module"], {"dao": {}})
    _expect_equal(checks, "voting:dao", voting_dao, addresses["program_vault"])
    modules = vault.get("proposal_modules")
    if not isinstance(modules, list):
        raise RuntimeError("vault proposal_modules query is malformed")
    enabled = [
        item.get("address")
        for item in modules
        if isinstance(item, dict) and str(item.get("status", "")).lower() == "enabled"
    ]
    _expect_equal(checks, "vault:sole_execution_module", enabled, [addresses["gauge"]])
    vault_balance = junod.balance(addresses["program_vault"], config["chain"]["native_denom"])
    _expect_equal(checks, "vault:fresh_balance", vault_balance, "0")

    bounty_config = junod.smart(addresses["bounty"], {"config": {}})
    expected_bounty = instantiate_messages(config, code_ids)["bounty"]
    for field in (
        "native_denom",
        "governor",
        "agent",
        "registry",
        "min_contribution",
        "max_bounty_total",
        "min_lifetime_seconds",
        "max_lifetime_seconds",
        "max_contributors",
        "max_rounds",
        "limits",
    ):
        _expect_equal(checks, f"bounty:{field}", bounty_config.get(field), expected_bounty[field])
    _expect_equal(
        checks,
        "bounty:ratification_seconds",
        bounty_config.get("ratification_seconds"),
        RATIFICATION_SECONDS,
    )
    bounty_identity_state = junod.smart(addresses["bounty"], {"identity_state": {}})
    _expect_equal(checks, "bounty:fresh_identity", bounty_identity_state, {"next_bounty_id": 1})
    bounty_page = junod.smart(
        addresses["bounty"], {"bounties": {"start_after": None, "limit": 1}}
    )
    _expect_equal(checks, "bounty:fresh_page", bounty_page, {"bounties": []})
    bounty_health = junod.smart(addresses["bounty"], {"health": {}})
    _expect_equal(
        checks,
        "bounty:fresh_health",
        bounty_health,
        {
            "accounting": {
                "active_escrow": "0",
                "outstanding_refunds": "0",
                "pending_payout_liabilities": "0",
                "lifetime_received": "0",
                "lifetime_paid": "0",
                "lifetime_refunded": "0",
            },
            "actual_native_balance": "0",
            "liabilities": "0",
            "fully_backed": True,
        },
    )

    registry_config = junod.smart(addresses["registry"], {"config": {}})
    expected_registry = instantiate_messages(config, code_ids)["registry"]
    for field, expected in expected_registry.items():
        path = f"registry:{field}"
        if field in ("min_project_share", "max_project_share"):
            _expect_equal(
                checks,
                path,
                _canonical_fraction(registry_config.get(field), path),
                _canonical_fraction(expected, path),
            )
        else:
            _expect_equal(checks, path, registry_config.get(field), expected)
    _expect_equal(
        checks,
        "registry:max_active_projects",
        registry_config.get("max_active_projects"),
        MAX_ACTIVE_PROJECTS,
    )
    registry_identity_state = junod.smart(addresses["registry"], {"identity_state": {}})
    _expect_equal(
        checks,
        "registry:fresh_identity",
        registry_identity_state,
        {"next_project_id": 1, "consumed_source_bounties": 0},
    )
    registry_projects = junod.smart(
        addresses["registry"], {"projects": {"start_after": None, "limit": 1}}
    )
    _expect_equal(checks, "registry:fresh_projects", registry_projects, {"projects": []})
    registry_applications = junod.smart(
        addresses["registry"], {"applications": {"start_after": None, "limit": 1}}
    )
    _expect_equal(
        checks, "registry:fresh_applications", registry_applications, {"projects": []}
    )
    registry_options = junod.smart(
        addresses["registry"], {"all_options": {"start_after": None, "limit": 2}}
    )
    _expect_equal(
        checks,
        "registry:fresh_options",
        registry_options,
        {"options": [config["registry"]["reserved_option"]]},
    )
    registry_health = junod.smart(addresses["registry"], {"health": {}})
    _expect_equal(
        checks,
        "registry:fresh_health",
        registry_health,
        {
            "accounting": {
                "active_projects": 0,
                "pending_applications": 0,
                "bond_liability": "0",
                "lifetime_bonds_received": "0",
                "lifetime_bonds_refunded": "0",
                "lifetime_bonds_forfeited": "0",
            },
            "actual_native_balance": "0",
            "fully_backed": True,
        },
    )

    gauge_config = junod.smart(addresses["gauge"], {"config": {}})
    _expect_equal(checks, "gauge:dao_core", gauge_config.get("dao_core"), addresses["program_vault"])
    _expect_equal(checks, "gauge:owner", gauge_config.get("owner"), addresses["program_vault"])
    _expect_equal(checks, "gauge:voting_powers", gauge_config.get("voting_powers"), addresses["voting_module"])
    _expect_equal(checks, "gauge:hook_caller", gauge_config.get("hook_caller"), addresses["gauge"])
    _expect_equal(
        checks,
        "gauge:power_source",
        gauge_config.get("power_source"),
        {"epoch_snapshot": {"guardian": addresses["agent_operations"]}},
    )
    gauge_state = junod.smart(addresses["gauge"], {"gauge": {"id": 0}})
    expected_gauge = instantiate_messages(config, code_ids)["gauge_inner"]["gauges"][0]
    gauge_fields = {
        "title": expected_gauge["title"],
        "adapter": expected_gauge["adapter"],
        "epoch_size": expected_gauge["epoch_size"],
        "min_percent_selected": expected_gauge["min_percent_selected"],
        "max_options_selected": expected_gauge["max_options_selected"],
        "max_available_percentage": expected_gauge["max_available_percentage"],
        "snapshot_policy": expected_gauge["snapshot_policy"],
    }
    for field, expected in gauge_fields.items():
        path = f"gauge:{field}"
        if field in ("min_percent_selected", "max_available_percentage"):
            _expect_equal(
                checks,
                path,
                _canonical_fraction(gauge_state.get(field), path),
                _canonical_fraction(expected, path),
            )
        else:
            _expect_equal(checks, path, gauge_state.get(field), expected)
    _expect_equal(
        checks,
        "gauge:fresh_state",
        {"current_epoch": gauge_state.get("current_epoch"), "is_stopped": gauge_state.get("is_stopped")},
        {"current_epoch": None, "is_stopped": False},
    )
    gauge_epochs = junod.smart(
        addresses["gauge"], {"list_epochs": {"gauge": 0, "start_after": None, "limit": 1}}
    )
    _expect_equal(checks, "gauge:fresh_epochs", gauge_epochs, {"epochs": []})

    agent = config["agent_operations"]
    agent_core = junod.smart(agent["core_address"], {"dump_state": {}})
    _expect_equal(
        checks,
        "agent:voting_module",
        agent_core.get("voting_module"),
        agent["voting_module_address"],
    )
    agent_modules = agent_core.get("proposal_modules")
    if not isinstance(agent_modules, list):
        raise RuntimeError("agent proposal_modules query is malformed")
    enabled_agent_modules = [
        item.get("address")
        for item in agent_modules
        if isinstance(item, dict) and str(item.get("status", "")).lower() == "enabled"
    ]
    _expect_equal(
        checks,
        "agent:sole_proposal_module",
        enabled_agent_modules,
        [agent["proposal_module_address"]],
    )
    membership = agent["membership"]
    membership_label, membership_address, membership_code_id, membership_checksum = _agent_membership_spec(agent)
    if membership["kind"] == "cw4":
        membership_contract = junod.smart(agent["voting_module_address"], {"group_contract": {}})
    else:
        voting_config = junod.smart(agent["voting_module_address"], {"config": {}})
        if not isinstance(voting_config, dict):
            raise RuntimeError("agent voting config query is malformed")
        membership_contract = voting_config.get("nft_address")
    _expect_equal(checks, "agent:membership_contract", membership_contract, membership_address)

    nft_minter: Any = None
    nft_num_tokens: Any = None
    nft_token_info: dict[str, Any] = {}
    if membership["kind"] == "cw4":
        membership_page = junod.smart(
            membership_address, {"list_members": {"start_after": None, "limit": MAX_AGENT_MEMBERS}}
        )
        raw_items = membership_page.get("members", []) if isinstance(membership_page, dict) else []
        actual_items = sorted(
            (
                {
                    "address": item.get("addr"),
                    "weight": _uint(
                        item.get("weight"),
                        "agent.membership_page.members.weight",
                        positive=True,
                    ),
                }
                for item in raw_items
                if isinstance(item, dict)
            ),
            key=lambda item: str(item["address"]),
        )
        expected_items = sorted(
            (
                {
                    "address": item["address"],
                    "weight": _uint(
                        item["weight"],
                        "agent_operations.membership.members.weight",
                        positive=True,
                    ),
                }
                for item in membership["members"]
            ),
            key=lambda item: item["address"],
        )
        _expect_equal(checks, "agent:membership_items", actual_items, expected_items)
        if not raw_items or not isinstance(raw_items[-1], dict) or not isinstance(raw_items[-1].get("addr"), str):
            raise RuntimeError("agent member page is empty or malformed")
        membership_tail = junod.smart(
            membership_address,
            {"list_members": {"start_after": raw_items[-1]["addr"], "limit": 1}},
        )
        if not isinstance(membership_tail, dict):
            raise RuntimeError("agent member tail query is malformed")
        _expect_equal(checks, "agent:membership_exhausted", membership_tail.get("members"), [])
    else:
        membership_page = junod.smart(
            membership_address, {"all_tokens": {"start_after": None, "limit": MAX_AGENT_MEMBERS}}
        )
        raw_ids = membership_page.get("tokens", []) if isinstance(membership_page, dict) else []
        if len(raw_ids) != len(set(raw_ids)):
            raise RuntimeError("agent NFT token page contains duplicate token IDs")
        expected_ids = sorted(item["token_id"] for item in membership["tokens"])
        _expect_equal(checks, "agent:membership_items", raw_ids, expected_ids)
        if not raw_ids or not isinstance(raw_ids[-1], str):
            raise RuntimeError("agent NFT token page is empty or malformed")
        membership_tail = junod.smart(
            membership_address,
            {"all_tokens": {"start_after": raw_ids[-1], "limit": 1}},
        )
        if not isinstance(membership_tail, dict):
            raise RuntimeError("agent NFT token tail query is malformed")
        _expect_equal(checks, "agent:membership_exhausted", membership_tail.get("tokens"), [])

    total_power_response = junod.smart(agent["voting_module_address"], {"total_power_at_height": {}})
    if not isinstance(total_power_response, dict):
        raise RuntimeError("agent total power query is malformed")
    total_power_observation = {"power": total_power_response.get("power")}
    _expect_equal(checks, "agent:total_power", total_power_observation["power"], str(membership["total_power"]))
    proposal_config = junod.smart(agent["proposal_module_address"], {"config": {}})
    _expect_equal(checks, "agent:proposal_dao", proposal_config.get("dao"), agent["core_address"])
    _expect_equal(checks, "agent:threshold", proposal_config.get("threshold"), _agent_proposal_threshold(agent))
    observed_period = _object(
        proposal_config.get("max_voting_period"),
        "agent.proposal.max_voting_period",
        ("time",),
    )
    _expect_equal(
        checks,
        "agent:voting_duration",
        {
            "time": _uint(
                observed_period.get("time"),
                "agent.proposal.max_voting_period.time",
                positive=True,
            )
        },
        {
            "time": _uint(
                agent["proposal"]["voting_duration_seconds"],
                "agent_operations.proposal.voting_duration_seconds",
                positive=True,
            )
        },
    )
    if membership["kind"] == "cw721_roles":
        nft_minter = junod.smart(membership_address, {"minter": {}})
        _expect_equal(checks, "agent:nft_minter", nft_minter, {"minter": membership["minter"]})
        nft_num_tokens = junod.smart(membership_address, {"num_tokens": {}})
        _expect_equal(checks, "agent:nft_token_count", nft_num_tokens, {"count": len(membership["tokens"])})
        expected_tokens = {item["token_id"]: item for item in membership["tokens"]}
        for token_id in sorted(expected_tokens):
            observed = junod.smart(
                membership_address,
                {"all_nft_info": {"token_id": token_id, "include_expired": False}},
            )
            nft_token_info[token_id] = copy.deepcopy(observed)
            expected_token = expected_tokens[token_id]
            actual = {
                "owner": _nested(observed, ("access", "owner")),
                "role": _nested(observed, ("info", "extension", "role")),
                "weight": _uint(
                    _nested(observed, ("info", "extension", "weight")),
                    f"agent.nft_token.{token_id}.weight",
                    positive=True,
                ),
            }
            _expect_equal(
                checks,
                f"agent:nft_token:{token_id}",
                actual,
                {
                    "owner": expected_token["owner"],
                    "role": expected_token["role"],
                    "weight": _uint(
                        expected_token["weight"],
                        f"agent_operations.membership.tokens.{token_id}.weight",
                        positive=True,
                    ),
                },
            )

    agent_code_specs = (
        (
            "core",
            agent["core_address"],
            _uint(agent["core_code_id"], "agent_operations.core_code_id", positive=True),
            agent["core_checksum"],
        ),
        (
            "voting",
            agent["voting_module_address"],
            _uint(agent["voting_code_id"], "agent_operations.voting_code_id", positive=True),
            agent["voting_checksum"],
        ),
        (
            "proposal",
            agent["proposal_module_address"],
            _uint(agent["proposal_code_id"], "agent_operations.proposal_code_id", positive=True),
            agent["proposal_checksum"],
        ),
        (membership_label, membership_address, membership_code_id, membership_checksum),
    )
    agent_contract_infos: dict[str, Any] = {}
    agent_code_checksums: dict[str, str] = {}
    for label, address, code_id, checksum in agent_code_specs:
        info = junod.contract_info(address)
        agent_contract_infos[label] = copy.deepcopy(info)
        _expect_equal(checks, f"agent:{label}:code_id", _contract_code_id(info), code_id)
        actual_checksum = _chain_checksum(junod.code_info(code_id))
        _expect_equal(checks, f"agent:{label}:checksum", actual_checksum, checksum)
        agent_code_checksums[label] = actual_checksum

    expected_checks = expected_verification_checks(config, code_ids)
    if checks != expected_checks:
        raise RuntimeError("internal verification check profile is incomplete or out of order")

    observations = {
        "release_code_checksums": {
            name: config["artifacts"][name]["sha256"]
            for name in config["artifacts"]
        },
        "contract_info": contract_infos,
        "vault_state": copy.deepcopy(vault),
        "vault_balance": vault_balance,
        "voting_dao": voting_dao,
        "bounty_config": copy.deepcopy(bounty_config),
        "bounty_identity_state": copy.deepcopy(bounty_identity_state),
        "bounty_page": copy.deepcopy(bounty_page),
        "bounty_health": copy.deepcopy(bounty_health),
        "registry_config": copy.deepcopy(registry_config),
        "registry_identity_state": copy.deepcopy(registry_identity_state),
        "registry_projects": copy.deepcopy(registry_projects),
        "registry_applications": copy.deepcopy(registry_applications),
        "registry_options": copy.deepcopy(registry_options),
        "registry_health": copy.deepcopy(registry_health),
        "gauge_config": copy.deepcopy(gauge_config),
        "gauge_state": copy.deepcopy(gauge_state),
        "gauge_epochs": copy.deepcopy(gauge_epochs),
        "agent_core_state": copy.deepcopy(agent_core),
        "agent_membership_contract": membership_contract,
        "agent_membership_page": copy.deepcopy(membership_page),
        "agent_membership_tail": copy.deepcopy(membership_tail),
        "agent_total_power": total_power_observation,
        "agent_nft_minter": copy.deepcopy(nft_minter),
        "agent_nft_num_tokens": copy.deepcopy(nft_num_tokens),
        "agent_nft_token_info": nft_token_info,
        "agent_proposal_config": copy.deepcopy(proposal_config),
        "agent_code_checksums": agent_code_checksums,
        "agent_contract_info": agent_contract_infos,
    }
    validate_verification_observations(config, code_ids, addresses, observations)

    return {
        "schema_version": VERIFICATION_SCHEMA,
        "config_sha256": config_hash(config),
        "chain_id": config["chain"]["chain_id"],
        "source": copy.deepcopy(config["source"]),
        "preflight": copy.deepcopy(preflight),
        "code_ids": copy.deepcopy(code_ids),
        "addresses": addresses,
        "observations": observations,
        "checks": checks,
    }


def reconcile_existing_instantiate(
    config: dict[str, Any],
    state: dict[str, Any],
    step: dict[str, Any],
    junod: Junod,
) -> bool:
    """Validate a deterministic address left by a pre-journal crash."""
    address = step["expected_address"]
    try:
        info = junod.contract_info(address)
    except RuntimeError:
        return False
    checks: list[str] = []
    _expect_equal(checks, "reconcile:code_id", _contract_code_id(info), step["code_id"])
    _expect_equal(checks, "reconcile:admin", info.get("admin"), step["admin"])
    _expect_equal(
        checks,
        "reconcile:creator",
        info.get("creator"),
        config["chain"]["deployer_address"],
    )

    component = step["id"].split(":", 1)[1]
    messages = instantiate_messages(config, state["code_ids"])
    addresses = messages["addresses"]
    if component == "bounty":
        observed = junod.smart(address, {"config": {}})
        for field, expected in messages["bounty"].items():
            _expect_equal(checks, f"reconcile:bounty:{field}", observed.get(field), expected)
        _expect_equal(
            checks,
            "reconcile:bounty:ratification_seconds",
            observed.get("ratification_seconds"),
            RATIFICATION_SECONDS,
        )
    elif component == "registry":
        observed = junod.smart(address, {"config": {}})
        for field, expected in messages["registry"].items():
            _expect_equal(checks, f"reconcile:registry:{field}", observed.get(field), expected)
        _expect_equal(
            checks,
            "reconcile:registry:max_active_projects",
            observed.get("max_active_projects"),
            MAX_ACTIVE_PROJECTS,
        )
    elif component == "program_vault":
        observed = junod.smart(address, {"dump_state": {}})
        _expect_equal(
            checks,
            "reconcile:vault:admin",
            observed.get("admin"),
            config["chain"]["xgov_module_account"],
        )
        _expect_equal(
            checks,
            "reconcile:vault:voting_module",
            observed.get("voting_module"),
            addresses["voting_module"],
        )
        modules = observed.get("proposal_modules")
        if not isinstance(modules, list):
            raise RuntimeError("reconcile:vault proposal_modules query is malformed")
        enabled = [
            item.get("address")
            for item in modules
            if isinstance(item, dict) and str(item.get("status", "")).lower() == "enabled"
        ]
        _expect_equal(
            checks,
            "reconcile:vault:sole_execution_module",
            enabled,
            [addresses["gauge"]],
        )
        for nested, artifact in (
            ("voting_module", "dao_voting_juno_staked"),
            ("gauge", "gauge_orchestrator"),
        ):
            nested_info = junod.contract_info(addresses[nested])
            _expect_equal(
                checks,
                f"reconcile:{nested}:code_id",
                _contract_code_id(nested_info),
                state["code_ids"][artifact],
            )
            _expect_equal(
                checks,
                f"reconcile:{nested}:admin",
                nested_info.get("admin"),
                config["chain"]["xgov_module_account"],
            )
            _expect_equal(
                checks,
                f"reconcile:{nested}:creator",
                nested_info.get("creator"),
                address,
            )
        voting_dao = junod.smart(addresses["voting_module"], {"dao": {}})
        _expect_equal(checks, "reconcile:voting:dao", voting_dao, address)
        gauge_config = junod.smart(addresses["gauge"], {"config": {}})
        for field, expected in {
            "dao_core": address,
            "owner": address,
            "voting_powers": addresses["voting_module"],
            "hook_caller": addresses["gauge"],
            "power_source": {
                "epoch_snapshot": {"guardian": addresses["agent_operations"]}
            },
        }.items():
            _expect_equal(
                checks,
                f"reconcile:gauge:{field}",
                gauge_config.get(field),
                expected,
            )
        gauge_state = junod.smart(addresses["gauge"], {"gauge": {"id": 0}})
        expected_gauge = messages["gauge_inner"]["gauges"][0]
        for field in (
            "title",
            "adapter",
            "epoch_size",
            "min_percent_selected",
            "max_options_selected",
            "max_available_percentage",
            "snapshot_policy",
        ):
            _expect_equal(
                checks,
                f"reconcile:gauge:{field}",
                gauge_state.get(field),
                expected_gauge[field],
            )
    else:
        raise RuntimeError(f"unsupported instantiate component {component}")
    return True


def apply_next(
    config: dict[str, Any], state: dict[str, Any], root: Path, state_path: Path, junod: Junod
) -> str:
    plan = build_plan(config, state, root)
    step = next(
        (item for item in plan["steps"] if item["status"] in ("ready", "reconcile")),
        None,
    )
    if step is None:
        if any(item["status"] == "blocked" for item in plan["steps"]):
            raise RuntimeError("deployment is blocked by incomplete prior state")
        return "deployment plan already complete"
    step_id = step["id"]
    state["verified"] = {}
    if step["status"] == "reconcile":
        record = state["transactions"][step_id]
        tx_hash = _string(record.get("tx_hash"), f"state.transactions.{step_id}.tx_hash")
        if step["kind"] == "instantiate2":
            verify_code_ids(config, state["code_ids"], junod)
    else:
        if step["kind"] == "store_code":
            existing = junod.code_ids_by_checksum(step["sha256"])
            if existing:
                code_id = existing[0]
                artifact_name = step_id.split(":", 1)[1]
                state["code_ids"][artifact_name] = code_id
                state["transactions"][step_id] = {
                    "status": "complete",
                    "code_id": code_id,
                    "reused_exact_code": True,
                }
                atomic_write_json(state_path, state)
                return f"reconciled {step_id} to existing exact code ID {code_id}"
            response = junod.tx(["store", str((root / step["artifact"]).resolve())])
        elif step["kind"] == "instantiate2":
            # Reject a stale or substituted code ID before any state-changing call.
            verify_code_ids(config, state["code_ids"], junod)
            if reconcile_existing_instantiate(config, state, step, junod):
                state["transactions"][step_id] = {
                    "status": "complete",
                    "contract_address": step["expected_address"],
                    "reconciled_existing": True,
                }
                atomic_write_json(state_path, state)
                return f"reconciled {step_id} at {step['expected_address']}"
            response = junod.tx(
                [
                    "instantiate2",
                    str(step["code_id"]),
                    canonical_json(step["msg"]).decode(),
                    step["salt_hex"],
                    "--label",
                    step["label"],
                    "--admin",
                    step["admin"],
                    "--fix-msg=false",
                ]
            )
        else:
            raise RuntimeError(f"unsupported plan step kind {step['kind']}")
        tx_hash = _tx_hash(response)
        state["transactions"][step_id] = {"status": "pending", "tx_hash": tx_hash}
        atomic_write_json(state_path, state)
    tx = junod.wait_tx(tx_hash)
    record: dict[str, Any] = {"status": "complete", "tx_hash": tx_hash}
    if step["kind"] == "store_code":
        values = _event_values(tx, "code_id")
        if len(values) != 1:
            raise RuntimeError(f"transaction {tx_hash} did not emit one code_id")
        code_id = _uint(values[0], f"transaction.{tx_hash}.code_id", positive=True)
        actual_checksum = _chain_checksum(junod.code_info(code_id))
        if actual_checksum != step["sha256"]:
            raise RuntimeError(
                f"stored code {code_id} checksum mismatch: expected {step['sha256']}, "
                f"found {actual_checksum}"
            )
        state["code_ids"][step_id.split(":", 1)[1]] = code_id
        record["code_id"] = code_id
    else:
        values = _event_values(tx, "_contract_address")
        if step["expected_address"] not in values:
            raise RuntimeError(
                f"transaction {tx_hash} did not instantiate expected {step['expected_address']}"
            )
        if not reconcile_existing_instantiate(config, state, step, junod):
            raise RuntimeError(
                f"transaction {tx_hash} did not leave a queryable contract at "
                f"{step['expected_address']}"
            )
        record["contract_address"] = step["expected_address"]
    state["transactions"][step_id] = record
    atomic_write_json(state_path, state)
    return f"completed {step_id} in {tx_hash}"


def command_validate(args: argparse.Namespace) -> None:
    config = load_config(args.config, args.root)
    print(json.dumps({"valid": True, "config_sha256": config_hash(config)}, sort_keys=True))


def command_addresses(args: argparse.Namespace) -> None:
    config = load_config(args.config, args.root)
    print(json.dumps(derive_addresses(config), indent=2, sort_keys=True))


def command_plan(args: argparse.Namespace) -> None:
    reject_output_collision(args.output, args.config, args.state)
    require_external_mutable_path(args.state, args.root, "state path")
    require_external_mutable_path(args.output, args.root, "plan output")
    config = load_config(args.config, args.root)
    state = load_state(args.state, config)
    plan = build_plan(config, state, args.root)
    if args.output:
        atomic_write_json(args.output, plan)
    else:
        print(json.dumps(plan, indent=2, sort_keys=True))


def command_preflight(args: argparse.Namespace) -> None:
    reject_output_collision(args.output, args.config)
    require_external_mutable_path(args.output, args.root, "preflight output")
    config = load_config(args.config, args.root)
    report = preflight_chain(config, Junod(args.junod, config))
    if args.output:
        atomic_write_json(args.output, report)
    else:
        print(json.dumps(report, indent=2, sort_keys=True))


def command_apply_next(args: argparse.Namespace) -> None:
    require_external_mutable_path(args.state, args.root, "state path")
    config = load_config(args.config, args.root)
    if not args.yes:
        raise ValidationError("apply-next requires --yes; inspect the exact plan first")
    with exclusive_state_lock(args.state):
        state = load_state(args.state, config)
        junod = Junod(args.junod, config)
        validate_deployer_key(config, junod)
        preflight_chain(config, junod)
        print(apply_next(config, state, args.root, args.state, junod))


def command_verify(args: argparse.Namespace) -> None:
    reject_output_collision(args.output, args.config, args.state)
    require_external_mutable_path(args.state, args.root, "state path")
    require_external_mutable_path(args.output, args.root, "verification output")
    config = load_config(args.config, args.root)
    with exclusive_state_lock(args.state):
        state = load_state(args.state, config)
        junod = Junod(args.junod, config)
        preflight = preflight_chain(config, junod)
        report = verify_deployment(config, state, junod, preflight)
        atomic_write_json(args.output, report)
        state["verified"] = {
            "report": str(args.output),
            "sha256": sha256_file(args.output),
        }
        atomic_write_json(args.state, state)
    print(json.dumps({"valid": True, "checks": len(report["checks"])}, sort_keys=True))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    result.add_argument("--config", type=Path, required=True)
    subcommands = result.add_subparsers(dest="command", required=True)
    validate = subcommands.add_parser("validate")
    validate.set_defaults(handler=command_validate)
    addresses = subcommands.add_parser("addresses")
    addresses.set_defaults(handler=command_addresses)
    plan = subcommands.add_parser("plan")
    plan.add_argument("--state", type=Path, required=True)
    plan.add_argument("--output", type=Path)
    plan.set_defaults(handler=command_plan)
    preflight = subcommands.add_parser("preflight")
    preflight.add_argument("--output", type=Path)
    preflight.add_argument("--junod", default="junod")
    preflight.set_defaults(handler=command_preflight)
    apply = subcommands.add_parser("apply-next")
    apply.add_argument("--state", type=Path, required=True)
    apply.add_argument("--junod", default="junod")
    apply.add_argument("--yes", action="store_true")
    apply.set_defaults(handler=command_apply_next)
    verify = subcommands.add_parser("verify")
    verify.add_argument("--state", type=Path, required=True)
    verify.add_argument("--output", type=Path, required=True)
    verify.add_argument("--junod", default="junod")
    verify.set_defaults(handler=command_verify)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        args.root = args.root.resolve()
        args.config = args.config.resolve()
        args.handler(args)
    except (ValidationError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
