#!/usr/bin/env python3
"""Strict evidence validation and Juno Voice v2 release-manifest generation."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deployment"))
import juno_voice_deploy as deploy  # noqa: E402
import release_auth  # noqa: E402


EVIDENCE_SCHEMA = "juno-voice/release-evidence/v2"
MANIFEST_SCHEMA = "juno-voice/release-manifest/v2"
TX_HASH = re.compile(r"^[0-9A-F]{64}$")
REQUIRED_SCENARIOS = {
    "multi_fund_ratify_pay",
    "reset_renominate_pay",
    "moderate_expire_pull_refunds",
    "paid_bounty_graduation",
    "bonded_registration_approval",
    "snapshot_turnout_distribution",
    "failed_turnout_no_distribution",
    "suspension_before_execution",
    "guardian_stop_governor_recovery",
    "consecutive_epoch_isolation",
    "partial_ballot_retention",
    "retained_only_no_distribution",
    "underfunded_terminal_epoch",
    "expired_terminal_epoch",
    "aborted_terminal_epoch",
    "numeric_identity_assignment",
    "bounty_source_rotation",
    "bond_transition_table",
}
REQUIRED_SCENARIO_ASSERTIONS = {
    "multi_fund_ratify_pay": {
        "bounty_paid_state": "query_response_equals",
        "contributor_receipts_state": "query_response_equals",
        "recipient_balance_delta": "balance_delta_equals",
        "payout_event": "transaction_event_equals",
    },
    "reset_renominate_pay": {
        "first_round_reset_state": "query_response_equals",
        "later_round_paid_state": "query_response_equals",
        "old_receipt_isolation": "query_response_equals",
        "recipient_balance_delta": "balance_delta_equals",
    },
    "moderate_expire_pull_refunds": {
        "refunding_state": "query_response_equals",
        "first_refund_balance_delta": "balance_delta_equals",
        "second_refund_balance_delta": "balance_delta_equals",
        "refund_events": "matching_events_equal",
    },
    "paid_bounty_graduation": {
        "paid_bounty_state": "query_response_equals",
        "active_graduated_project_state": "query_response_equals",
        "graduation_event": "transaction_event_equals",
    },
    "bonded_registration_approval": {
        "pending_bonded_project_state": "query_response_equals",
        "active_approved_project_state": "query_response_equals",
        "bond_disposition_state": "query_response_equals",
        "approval_event": "transaction_event_equals",
    },
    "snapshot_turnout_distribution": {
        "epoch_snapshot_state": "query_response_equals",
        "historical_ballot_state": "query_response_equals",
        "project_balance_delta": "balance_delta_equals",
        "distribution_event": "transaction_event_equals",
    },
    "failed_turnout_no_distribution": {
        "failed_turnout_state": "query_response_equals",
        "vault_balance_unchanged": "balance_delta_equals",
        "no_transfer_events": "matching_events_equal",
    },
    "suspension_before_execution": {
        "suspended_project_state": "query_response_equals",
        "terminal_epoch_state": "query_response_equals",
        "project_balance_unchanged": "balance_delta_equals",
        "no_project_transfer_events": "matching_events_equal",
    },
    "guardian_stop_governor_recovery": {
        "guardian_stopped_state": "query_response_equals",
        "agent_resume_rejected": "transaction_code_equals",
        "governor_resumed_state": "query_response_equals",
        "authority_state": "query_response_equals",
    },
    "consecutive_epoch_isolation": {
        "first_epoch_state": "query_response_equals",
        "second_epoch_state": "query_response_equals",
        "first_ballot_state": "query_response_equals",
        "second_ballot_state": "query_response_equals",
        "snapshot_isolation_state": "query_response_equals",
    },
    "partial_ballot_retention": {
        "partial_epoch_state": "query_response_equals",
        "partial_ballot_state": "query_response_equals",
        "project_balance_delta": "balance_delta_equals",
        "distribution_event": "transaction_event_equals",
    },
    "retained_only_no_distribution": {
        "retained_only_epoch_state": "query_response_equals",
        "retained_only_ballot_state": "query_response_equals",
        "vault_balance_unchanged": "balance_delta_equals",
        "retained_only_terminal_event": "transaction_event_equals",
        "no_transfer_events": "matching_events_equal",
    },
    "underfunded_terminal_epoch": {
        "underfunded_epoch_state": "query_response_equals",
        "vault_balance_unchanged": "balance_delta_equals",
        "underfunded_terminal_event": "transaction_event_equals",
        "no_transfer_events": "matching_events_equal",
    },
    "expired_terminal_epoch": {
        "expired_epoch_state": "query_response_equals",
        "vault_balance_unchanged": "balance_delta_equals",
        "expired_terminal_event": "transaction_event_equals",
        "no_transfer_events": "matching_events_equal",
    },
    "aborted_terminal_epoch": {
        "aborted_epoch_state": "query_response_equals",
        "vault_balance_unchanged": "balance_delta_equals",
        "aborted_terminal_event": "transaction_event_equals",
        "no_transfer_events": "matching_events_equal",
    },
    "numeric_identity_assignment": {
        "assigned_bonded_project_state": "query_response_equals",
        "assigned_graduated_project_state": "query_response_equals",
        "registration_assignment_event": "transaction_event_equals",
    },
    "bounty_source_rotation": {
        "old_source_project_state": "query_response_equals",
        "replacement_source_project_state": "query_response_equals",
        "old_source_replay_rejected": "transaction_code_equals",
    },
    "bond_transition_table": {
        "bond_pending_state": "query_response_equals",
        "bond_active_state": "query_response_equals",
        "bond_suspended_state": "query_response_equals",
        "bond_rejected_refunded_state": "query_response_equals",
        "bond_rejected_forfeited_state": "query_response_equals",
        "bond_retired_claimable_state": "query_response_equals",
        "bond_retired_claimed_state": "query_response_equals",
        "graduated_bond_free_state": "query_response_equals",
    },
}
QUERY_PROOFS = {
    "bounty_paid_state": ("bounty", "bounty", "paid_bounty"),
    "contributor_receipts_state": ("bounty", "receipts", "multiple_receipts"),
    "first_round_reset_state": ("bounty", "round", "reset_round"),
    "later_round_paid_state": ("bounty", "round", "paid_round"),
    "old_receipt_isolation": ("bounty", "receipt", "old_receipt"),
    "refunding_state": ("bounty", "bounty", "refunding_bounty"),
    "paid_bounty_state": ("bounty", "bounty", "paid_bounty"),
    "active_graduated_project_state": ("registry", "project", "graduated_project"),
    "pending_bonded_project_state": ("registry", "project", "pending_bonded_project"),
    "active_approved_project_state": ("registry", "project", "approved_bonded_project"),
    "bond_disposition_state": ("registry", "accounting", "held_bond_accounting"),
    "epoch_snapshot_state": ("gauge", "epoch", "distributed_epoch"),
    "historical_ballot_state": ("gauge", "epoch_ballot", "epoch_ballot"),
    "failed_turnout_state": ("gauge", "epoch", "failed_turnout_epoch"),
    "suspended_project_state": ("registry", "project", "suspended_project"),
    "terminal_epoch_state": ("gauge", "epoch", "no_eligible_epoch"),
    "guardian_stopped_state": ("gauge", "gauge", "stopped_gauge"),
    "governor_resumed_state": ("gauge", "gauge", "resumed_gauge"),
    "authority_state": ("gauge", "config", "snapshot_authorities"),
    "first_epoch_state": ("gauge", "epoch", "distributed_epoch"),
    "second_epoch_state": ("gauge", "epoch", "distributed_epoch"),
    "first_ballot_state": ("gauge", "epoch_ballot", "epoch_ballot"),
    "second_ballot_state": ("gauge", "epoch_ballot", "epoch_ballot"),
    "snapshot_isolation_state": ("gauge", "list_epochs", "isolated_epoch_list"),
    "partial_epoch_state": ("gauge", "epoch", "partial_epoch"),
    "partial_ballot_state": ("gauge", "epoch_ballot", "partial_ballot"),
    "retained_only_epoch_state": ("gauge", "epoch", "retained_only_epoch"),
    "retained_only_ballot_state": ("gauge", "epoch_ballot", "retained_only_ballot"),
    "underfunded_epoch_state": ("gauge", "epoch", "underfunded_epoch"),
    "expired_epoch_state": ("gauge", "epoch", "expired_epoch"),
    "aborted_epoch_state": ("gauge", "epoch", "aborted_epoch"),
    "assigned_bonded_project_state": ("registry", "project", "approved_bonded_project"),
    "assigned_graduated_project_state": ("registry", "project", "graduated_project"),
    "old_source_project_state": ("registry", "project", "graduated_project_any_source"),
    "replacement_source_project_state": ("registry", "project", "graduated_project_any_source"),
    "bond_pending_state": ("registry", "project", "pending_bonded_project"),
    "bond_active_state": ("registry", "project", "approved_bonded_project"),
    "bond_suspended_state": ("registry", "project", "suspended_project"),
    "bond_rejected_refunded_state": ("registry", "project", "rejected_refunded_project"),
    "bond_rejected_forfeited_state": ("registry", "project", "rejected_forfeited_project"),
    "bond_retired_claimable_state": ("registry", "project", "retired_claimable_project"),
    "bond_retired_claimed_state": ("registry", "project", "retired_claimed_project"),
    "graduated_bond_free_state": ("registry", "project", "graduated_project"),
}
QUERY_PAYLOAD_FIELDS = {
    "bounty": {"bounty_id"},
    "receipts": {"bounty_id", "round", "start_after", "limit"},
    "round": {"bounty_id", "round"},
    "receipt": {"bounty_id", "round", "voter"},
    "project": {"project_id"},
    "accounting": set(),
    "epoch": {"gauge", "epoch"},
    "epoch_ballot": {"gauge", "epoch", "voter"},
    "gauge": {"id"},
    "config": set(),
    "list_epochs": {"gauge", "start_after", "limit"},
}
POSITIVE_BALANCE_ASSERTIONS = {
    "recipient_balance_delta",
    "first_refund_balance_delta",
    "second_refund_balance_delta",
    "project_balance_delta",
}
ZERO_BALANCE_ASSERTIONS = {
    "vault_balance_unchanged",
    "project_balance_unchanged",
}
EMPTY_EVENT_ASSERTIONS = {"no_transfer_events", "no_project_transfer_events"}
TRANSACTION_EVENT_PROOFS = {
    "payout_event": {
        "event_type": "wasm-juno_voice_bounties.ratification_finalized",
        "contract": "bounty",
        "required_keys": (
            "_contract_address",
            "bounty_id",
            "round",
            "outcome",
            "yes_weight",
            "no_weight",
            "participating_weight",
            "next_status",
        ),
        "fixed_attributes": {"outcome": "paid", "next_status": "paid"},
    },
    "graduation_event": {
        "event_type": "wasm-juno_voice_bounties.project_graduated",
        "contract": "bounty",
        "required_keys": (
            "_contract_address",
            "bounty_id",
            "agent",
            "registry",
            "project_id",
            "payout_address",
        ),
        "fixed_attributes": {},
    },
    "approval_event": {
        "event_type": "wasm-hack_juno_registry.registration_reviewed",
        "contract": "registry",
        "required_keys": (
            "_contract_address",
            "project_id",
            "curator",
            "decision",
            "reason_code",
            "status",
        ),
        "fixed_attributes": {"decision": "approve", "status": "active"},
    },
    "distribution_event": {
        "event_type": "wasm",
        "contract": "gauge",
        "required_keys": (
            "_contract_address",
            "action",
            "sender",
            "gauge_id",
            "epoch_id",
            "snapshot_height",
            "snapshot_total_power",
            "participating_power",
            "allocated_power",
            "total_cast",
            "retained_option_power",
            "unallocated_power",
            "selected_project_power",
            "emitted_value",
            "retained_value",
            "min_turnout_bps",
            "policy_version",
            "epoch_budget",
            "denom",
            "execution_deadline",
            "outcome",
            "message_count",
        ),
        "fixed_attributes": {
            "action": "execute_snapshot_epoch",
            "outcome": "distributed",
        },
    },
    "registration_assignment_event": {
        "event_type": "wasm-hack_juno_registry.project_registered",
        "contract": "registry",
        "required_keys": (
            "_contract_address",
            "project_id",
            "applicant",
            "payout_address",
            "bond",
        ),
        "fixed_attributes": {},
    },
    "retained_only_terminal_event": {
        "event_type": "wasm",
        "contract": "gauge",
        "required_keys": (
            "_contract_address", "action", "sender", "gauge_id", "epoch_id",
            "snapshot_height", "snapshot_total_power", "participating_power",
            "allocated_power", "total_cast", "retained_option_power",
            "unallocated_power", "selected_project_power", "emitted_value",
            "retained_value", "min_turnout_bps", "policy_version", "epoch_budget",
            "denom", "execution_deadline", "outcome", "message_count",
        ),
        "fixed_attributes": {
            "action": "execute_snapshot_epoch",
            "outcome": "no_eligible_options",
            "message_count": "0",
        },
    },
    "underfunded_terminal_event": {
        "event_type": "wasm",
        "contract": "gauge",
        "required_keys": (
            "_contract_address", "action", "sender", "gauge_id", "epoch_id",
            "snapshot_height", "snapshot_total_power", "participating_power",
            "allocated_power", "total_cast", "retained_option_power",
            "unallocated_power", "selected_project_power", "emitted_value",
            "retained_value", "min_turnout_bps", "policy_version", "epoch_budget",
            "denom", "execution_deadline", "outcome", "message_count",
            "required_value", "available_balance",
        ),
        "fixed_attributes": {
            "action": "execute_snapshot_epoch",
            "outcome": "insufficient_funds",
            "message_count": "0",
        },
    },
    "expired_terminal_event": {
        "event_type": "wasm",
        "contract": "gauge",
        "required_keys": (
            "_contract_address", "action", "sender", "gauge_id", "epoch_id",
            "snapshot_height", "snapshot_total_power", "participating_power",
            "allocated_power", "total_cast", "retained_option_power",
            "unallocated_power", "selected_project_power", "emitted_value",
            "retained_value", "min_turnout_bps", "policy_version", "epoch_budget",
            "denom", "execution_deadline", "outcome", "message_count",
        ),
        "fixed_attributes": {
            "action": "expire_snapshot_epoch",
            "outcome": "expired",
            "message_count": "0",
        },
    },
    "aborted_terminal_event": {
        "event_type": "wasm",
        "contract": "gauge",
        "required_keys": (
            "_contract_address", "action", "sender", "gauge_id", "epoch_id",
            "snapshot_height", "snapshot_total_power", "participating_power",
            "allocated_power", "total_cast", "retained_option_power",
            "unallocated_power", "selected_project_power", "emitted_value",
            "retained_value", "min_turnout_bps", "policy_version", "epoch_budget",
            "denom", "execution_deadline", "outcome", "message_count", "reason",
        ),
        "fixed_attributes": {
            "action": "abort_snapshot_epoch",
            "outcome": "aborted",
            "message_count": "0",
        },
    },
}
MATCHING_EVENT_PROOFS = {
    "refund_events": {
        "event_type": "wasm-juno_voice_bounties.refund_claimed",
        "contract": "bounty",
    }
}
EMPTY_TRANSFER_EVENT_PROOFS = {
    "no_transfer_events": {
        "balance_assertion": "vault_balance_unchanged",
        "address_attribute": "sender",
    },
    "no_project_transfer_events": {
        "balance_assertion": "project_balance_unchanged",
        "address_attribute": "recipient",
    },
}
REQUIRED_GAS_CASES = {
    "bounty_max_contributors",
    "registry_max_projects",
    "gauge_max_options",
    "adapter_max_messages",
    "query_max_pagination",
    "bounty_max_history",
    "gauge_max_cleanup_batch",
}
GAS_REPORT_SCHEMA = "juno-voice/gas-report/v1"
GAS_REPORT_PAYLOAD_FIELDS = (
    "schema_version",
    "status",
    "chain_id",
    "config_sha256",
    "source",
    "safety_margin_bps",
    "measurements_sha256",
    "measurement_cases",
    "measured_by",
    "reviewed_by",
    "measured_at",
    "reviewed_at",
    "methodology",
)
RELEASE_DECISION_SCHEMA = "juno-voice/release-decision/v2"
RELEASE_DECISION_PAYLOAD_FIELDS = (
    "schema_version",
    "status",
    "authorization",
    "production_authorized",
    "chain_id",
    "config_sha256",
    "source",
    "bound_evidence",
    "signers",
    "decided_at",
)
RELEASE_SIGNOFF_REVIEW_FIELDS = (
    "status",
    "maintainers",
    "security_reviewer",
    "operations_reviewer",
)
RELEASE_DECISION_EVIDENCE_FIELDS = (
    "build_manifest_sha256",
    "deployment_verification_sha256",
    "upstream_attestation_sha256",
    "security_attestation_sha256",
    "public_testnet_report_sha256",
    "gas_report_sha256",
    "canary_report_sha256",
    "canary_governance_decision_sha256",
    "operations_rehearsal_report_sha256",
    "reviewed_evidence_sha256",
)
GAS_CASE_PROFILES = {
    "bounty_max_contributors": {
        "contract": "bounty",
        "kind": "smart_query",
        "operation": "contributions",
        "response_collection": "contributions",
    },
    "registry_max_projects": {
        "contract": "registry",
        "kind": "smart_query",
        "operation": "projects",
        "response_collection": "projects",
    },
    "gauge_max_options": {
        "contract": "gauge",
        "kind": "smart_query",
        "operation": "epoch_allocations",
        "response_collection": "allocations",
    },
    "adapter_max_messages": {
        "contract": "registry",
        "kind": "smart_query",
        "operation": "sample_gauge_msgs",
        "response_collection": "execute",
    },
    "query_max_pagination": {
        "contract": "bounty",
        "kind": "smart_query",
        "operation": "bounties",
        "response_collection": "bounties",
    },
    "bounty_max_history": {
        "contract": "bounty",
        "kind": "smart_query",
        "operation": "history",
        "response_collection": "entries",
    },
    "gauge_max_cleanup_batch": {
        "contract": "gauge",
        "kind": "execute",
        "operation": "cleanup_epoch",
        "response_collection": None,
    },
}
EPOCH_RESPONSE_FIELDS = {
    "gauge_id",
    "epoch_id",
    "snapshot_height",
    "snapshot_total_power",
    "participating_power",
    "allocated_power",
    "total_cast",
    "retained_option",
    "retained_option_power",
    "unallocated_power",
    "selected_project_power",
    "emitted_value",
    "retained_value",
    "min_turnout_bps",
    "policy_version",
    "epoch_budget",
    "denom",
    "opens_at",
    "closes_at",
    "execution_deadline",
    "voter_count",
    "option_count",
    "outcome",
    "cleanup",
}
REQUIRED_SNAPSHOT_QUERIES = {
    "first_voter_before_change",
    "first_total_before_change",
    "first_voter_after_change",
    "first_total_after_change",
    "second_voter_after_change",
    "second_total_after_change",
}
REQUIRED_OPERATIONAL_REHEARSALS = {
    "pause_new_activity",
    "failed_epoch",
    "adapter_failure",
    "governor_recovery",
    "refund_and_expiry",
    "unused_funds_recovery",
}
OPERATIONAL_REHEARSAL_CODE_PROFILES = {
    "pause_new_activity": {"minimum_successes": 1, "minimum_failures": 1},
    "failed_epoch": {"minimum_successes": 1, "minimum_failures": 0},
    "adapter_failure": {"minimum_successes": 0, "minimum_failures": 1},
    "governor_recovery": {"minimum_successes": 1, "minimum_failures": 1},
    "refund_and_expiry": {"minimum_successes": 3, "minimum_failures": 0},
    "unused_funds_recovery": {"minimum_successes": 1, "minimum_failures": 0},
}
REQUIRED_RUNBOOKS = {
    "deployment/runbooks/DEPLOYMENT.md",
    "deployment/runbooks/MONITORING.md",
    "deployment/runbooks/PAUSE_AND_RECOVERY.md",
    "deployment/runbooks/REFUNDS_AND_EXPIRY.md",
    "deployment/runbooks/SUBMODULE_UPDATE.md",
    "deployment/runbooks/RELEASE.md",
}
RUNBOOK_REQUIRED_SECTIONS = {
    "deployment/runbooks/DEPLOYMENT.md": (
        "# Deployment runbook",
        "## Preconditions",
        "## Dry run",
        "## Broadcast and restart",
        "## Post-deployment reconciliation",
        "## Rollback boundary",
    ),
    "deployment/runbooks/MONITORING.md": (
        "# Monitoring runbook",
        "## Collection cadence",
        "## Balance and liability alerts",
        "## Bounty liveness alerts",
        "## Registry and adapter alerts",
        "## Snapshot and epoch alerts",
        "## Tranche alerts",
    ),
    "deployment/runbooks/PAUSE_AND_RECOVERY.md": (
        "# Pause and recovery runbook",
        "## Decision table",
        "## Pause procedure",
        "## Failed epoch or adapter",
        "## Governor recovery",
    ),
    "deployment/runbooks/REFUNDS_AND_EXPIRY.md": (
        "# Refund and expiry runbook",
        "## Entering refunds",
        "## Contributor claims",
        "## Reconciliation",
    ),
    "deployment/runbooks/SUBMODULE_UPDATE.md": (
        "# dao-contracts submodule update runbook",
        "## Upstream acceptance",
        "## Pin advancement and verification",
        "## Release evidence",
    ),
    "deployment/runbooks/RELEASE.md": (
        "# Release runbook",
        "## Candidate construction",
        "## Evidence gates",
        "## Authorization boundary",
    ),
}
BUILD_ARTIFACT_REPOSITORIES = {
    "juno_voice_bounties": "juno-voice",
    "hack_juno_registry_adapter": "juno-voice",
    "dao_dao_core": "dao-contracts",
    "dao_voting_juno_staked": "dao-contracts",
    "gauge_orchestrator": "dao-contracts",
}
BUILD_SCHEMAS = {
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
BUILD_EVIDENCE_FILES = {
    "build_provenance_sha256": "build-provenance.txt",
    "build_tools_sha256": "build-tools.txt",
    "checksums_sha256": "checksums.txt",
    "sizes_sha256": "sizes.txt",
}


class EvidenceError(ValueError):
    pass


def fail(path: str, message: str) -> None:
    raise EvidenceError(f"{path}: {message}")


def obj(value: Any, path: str, keys: Iterable[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(path, "must be an object")
    expected = set(keys)
    missing = sorted(expected - set(value))
    extra = sorted(set(value) - expected)
    if missing:
        fail(path, f"missing keys: {', '.join(missing)}")
    if extra:
        fail(path, f"unexpected keys: {', '.join(extra)}")
    return value


def nonempty(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        fail(path, "must be a nonempty string")
    return value


def uint(value: Any, path: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        fail(path, "must be an unsigned integer")
    if positive and value == 0:
        fail(path, "must be positive")
    return value


def tx_hash(value: Any, path: str) -> str:
    value = nonempty(value, path)
    if not TX_HASH.fullmatch(value):
        fail(path, "must be an uppercase 32-byte transaction hash")
    return value


def https_url(value: Any, path: str) -> str:
    value = nonempty(value, path)
    if not value.startswith("https://"):
        fail(path, "must be an https URL")
    return value


def file_ref(value: Any, path: str, root: Path) -> dict[str, str]:
    value = obj(value, path, ("path", "sha256"))
    relative = Path(nonempty(value["path"], f"{path}.path"))
    if relative.is_absolute() or ".." in relative.parts:
        fail(f"{path}.path", "must be a relative path without '..'")
    checksum = nonempty(value["sha256"], f"{path}.sha256")
    if not deploy.HEX_64.fullmatch(checksum):
        fail(f"{path}.sha256", "must be 64 lowercase hex characters")
    actual_path = (root / relative).resolve()
    if not actual_path.is_relative_to(root.resolve()) or not actual_path.is_file():
        fail(f"{path}.path", "does not identify a repository file")
    actual = deploy.sha256_file(actual_path)
    if actual != checksum:
        fail(f"{path}.sha256", f"expected {checksum}, found {actual}")
    return value


def load_evidence(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise EvidenceError(f"cannot read evidence {path}: {error}") from error


def response_messages(response: dict[str, Any], tx: dict[str, Any]) -> list[Any] | None:
    for candidate in (tx, response, response.get("tx_response", {})):
        if not isinstance(candidate, dict):
            continue
        messages = candidate.get("tx", {}).get("body", {}).get("messages")
        if isinstance(messages, list):
            return messages
    return None


def _transaction_evidence(
    transcript: dict[str, Any], transaction_hash: str, path: str
) -> dict[str, Any]:
    matches = [
        item
        for item in transcript["transaction_evidence"]
        if isinstance(item, dict) and item.get("hash") == transaction_hash
    ]
    if len(matches) != 1:
        fail(path, "must reference exactly one captured transaction")
    return matches[0]


def _event_has_attributes(event: Any, expected: dict[str, str]) -> bool:
    if not isinstance(event, dict):
        return False
    attributes = event.get("attributes")
    if not isinstance(attributes, list):
        return False
    observed = {
        (item.get("key"), item.get("value"))
        for item in attributes
        if isinstance(item, dict)
    }
    return all((key, value) in observed for key, value in expected.items())


def validate_transaction_event(event: Any, path: str) -> None:
    event = obj(event, path, ("type", "attributes"))
    nonempty(event["type"], f"{path}.type")
    attributes = event["attributes"]
    if not isinstance(attributes, list) or not attributes:
        fail(f"{path}.attributes", "must be a nonempty array")
    for index, attribute in enumerate(attributes):
        attribute_path = f"{path}.attributes[{index}]"
        if not isinstance(attribute, dict):
            fail(attribute_path, "must be an object")
        if set(attribute) not in ({"key", "value"}, {"key", "value", "index"}):
            fail(attribute_path, "must contain key/value and optional index only")
        nonempty(attribute["key"], f"{attribute_path}.key")
        if not isinstance(attribute["value"], str):
            fail(f"{attribute_path}.value", "must be a string")
        if "index" in attribute and not isinstance(attribute["index"], bool):
            fail(f"{attribute_path}.index", "must be a boolean")


def allowed_scenario_contracts(
    config: dict[str, Any], addresses: dict[str, str]
) -> set[str]:
    agent = config["agent_operations"]
    membership = agent["membership"]
    membership_address = (
        membership["group_address"]
        if membership["kind"] == "cw4"
        else membership["nft_address"]
    )
    allowed = set(addresses.values())
    allowed.add(membership_address)
    allowed.update(
        agent[field]
        for field in (
            "core_address",
            "voting_module_address",
            "proposal_module_address",
        )
    )
    return allowed


def validate_transaction_message(
    message: Any, allowed_contracts: set[str], path: str
) -> None:
    if not isinstance(message, dict) or not message:
        fail(path, "must be a nonempty decoded message object")
    message_type = nonempty(message.get("@type"), f"{path}.@type")
    if message_type != "/cosmwasm.wasm.v1.MsgExecuteContract":
        return
    contract = nonempty(message.get("contract"), f"{path}.contract")
    if contract not in allowed_contracts:
        fail(
            f"{path}.contract",
            "is not a verified Juno Voice or Agent Operations destination",
        )


def validate_captured_transaction(
    capture: Any,
    expected_hash: str,
    allowed_contracts: set[str],
    path: str,
) -> dict[str, Any]:
    capture = obj(
        capture,
        path,
        (
            "hash",
            "height",
            "code",
            "gas_wanted",
            "gas_used",
            "response_sha256",
            "response",
            "messages",
            "events",
        ),
    )
    if tx_hash(capture["hash"], f"{path}.hash") != expected_hash:
        fail(f"{path}.hash", "does not match the referenced transaction")
    height = uint(capture["height"], f"{path}.height", positive=True)
    code = uint(capture["code"], f"{path}.code")
    gas_wanted = uint(capture["gas_wanted"], f"{path}.gas_wanted", positive=True)
    gas_used = uint(capture["gas_used"], f"{path}.gas_used", positive=True)
    if gas_used > gas_wanted:
        fail(f"{path}.gas_used", "must not exceed gas_wanted")
    checksum = nonempty(capture["response_sha256"], f"{path}.response_sha256")
    if not deploy.HEX_64.fullmatch(checksum):
        fail(f"{path}.response_sha256", "must be SHA-256")
    response = capture["response"]
    if not isinstance(response, dict) or not response:
        fail(f"{path}.response", "must contain the complete query-tx response")
    if checksum != deploy.sha256_bytes(deploy.canonical_json(response)):
        fail(f"{path}.response_sha256", "does not match the complete response")
    response_tx = response.get("tx_response", response)
    if not isinstance(response_tx, dict):
        fail(f"{path}.response", "has a malformed tx_response")
    if str(response_tx.get("txhash", "")).upper() != expected_hash:
        fail(f"{path}.response.txhash", "does not match the captured transaction")
    for field, expected in (
        ("height", height),
        ("code", code),
        ("gas_wanted", gas_wanted),
        ("gas_used", gas_used),
    ):
        try:
            observed = int(response_tx.get(field, 0))
        except (TypeError, ValueError):
            fail(f"{path}.response.{field}", "is not an integer")
        if observed != expected:
            fail(f"{path}.response.{field}", "does not match the captured summary")
    messages = response_messages(response, response_tx)
    if not messages or messages != capture["messages"]:
        fail(f"{path}.messages", "must exactly match the decoded transaction messages")
    for index, message in enumerate(messages):
        validate_transaction_message(message, allowed_contracts, f"{path}.messages[{index}]")
    events = response_tx.get("events")
    if not isinstance(events, list) or not events or events != capture["events"]:
        fail(f"{path}.events", "must exactly match the nonempty transaction events")
    for index, event in enumerate(events):
        validate_transaction_event(event, f"{path}.events[{index}]")
    return capture


def gas_report_payload(document: dict[str, Any]) -> dict[str, Any]:
    return {field: document[field] for field in GAS_REPORT_PAYLOAD_FIELDS}


def gas_report_payload_sha256(payload: dict[str, Any]) -> str:
    return deploy.sha256_bytes(deploy.canonical_json(payload))


def validate_gas_report_document(
    document: Any,
    gas: dict[str, Any],
    config: dict[str, Any],
    path: str = "gas.report.document",
) -> dict[str, Any]:
    document = obj(
        document,
        path,
        (*GAS_REPORT_PAYLOAD_FIELDS, "signed_payload_sha256", "declarations"),
    )
    if document["schema_version"] != GAS_REPORT_SCHEMA:
        fail(f"{path}.schema_version", "is invalid")
    if document["status"] != "passed":
        fail(f"{path}.status", "must equal 'passed'")
    if document["chain_id"] != config["chain"]["chain_id"]:
        fail(f"{path}.chain_id", "does not match deployment config")
    if document["config_sha256"] != deploy.config_hash(config):
        fail(f"{path}.config_sha256", "does not match deployment config")
    if document["source"] != config["source"]:
        fail(f"{path}.source", "does not match deployment config")
    if (
        uint(
            document["safety_margin_bps"],
            f"{path}.safety_margin_bps",
            positive=True,
        )
        != gas["safety_margin_bps"]
    ):
        fail(f"{path}.safety_margin_bps", "does not match gas evidence")
    measurements_sha256 = nonempty(
        document["measurements_sha256"], f"{path}.measurements_sha256"
    )
    if not deploy.HEX_64.fullmatch(measurements_sha256):
        fail(f"{path}.measurements_sha256", "must be SHA-256")
    expected_measurements_sha256 = deploy.sha256_bytes(
        deploy.canonical_json(gas["measurements"])
    )
    if measurements_sha256 != expected_measurements_sha256:
        fail(f"{path}.measurements_sha256", "does not bind the gas measurements")
    expected_cases = sorted(REQUIRED_GAS_CASES)
    if document["measurement_cases"] != expected_cases:
        fail(f"{path}.measurement_cases", "must list the seven required cases exactly")
    measured_by = nonempty(document["measured_by"], f"{path}.measured_by")
    reviewed_by = nonempty(document["reviewed_by"], f"{path}.reviewed_by")
    if measured_by == reviewed_by:
        fail(path, "measurer and reviewer must be distinct")
    nonempty(document["measured_at"], f"{path}.measured_at")
    nonempty(document["reviewed_at"], f"{path}.reviewed_at")
    nonempty(document["methodology"], f"{path}.methodology")
    payload = gas_report_payload(document)
    signed_payload_sha256 = nonempty(
        document["signed_payload_sha256"], f"{path}.signed_payload_sha256"
    )
    if not deploy.HEX_64.fullmatch(signed_payload_sha256):
        fail(f"{path}.signed_payload_sha256", "must be SHA-256")
    if signed_payload_sha256 != gas_report_payload_sha256(payload):
        fail(f"{path}.signed_payload_sha256", "does not match the report payload")
    declarations = document["declarations"]
    if not isinstance(declarations, list) or len(declarations) != 2:
        fail(f"{path}.declarations", "must contain measurer and reviewer declarations")
    seen_identities: set[str] = set()
    for index, declaration in enumerate(declarations):
        declaration_path = f"{path}.declarations[{index}]"
        declaration = obj(
            declaration,
            declaration_path,
            ("identity", "payload_sha256", "method", "value"),
        )
        identity = nonempty(declaration["identity"], f"{declaration_path}.identity")
        if identity in seen_identities:
            fail(f"{declaration_path}.identity", "is duplicated")
        seen_identities.add(identity)
        if declaration["payload_sha256"] != signed_payload_sha256:
            fail(f"{declaration_path}.payload_sha256", "does not match the reviewed payload")
        nonempty(declaration["method"], f"{declaration_path}.method")
        nonempty(declaration["value"], f"{declaration_path}.value")
    if seen_identities != {measured_by, reviewed_by}:
        fail(f"{path}.declarations", "must be made by the measurer and reviewer")
    return document


def release_review_payload(evidence: dict[str, Any]) -> dict[str, Any]:
    payload = copy.deepcopy(evidence)
    signoff = evidence["release_signoff"]
    payload["release_signoff"] = {
        field: copy.deepcopy(signoff[field])
        for field in RELEASE_SIGNOFF_REVIEW_FIELDS
    }
    return payload


def release_review_payload_sha256(evidence: dict[str, Any]) -> str:
    return deploy.sha256_bytes(deploy.canonical_json(release_review_payload(evidence)))


def release_decision_bound_evidence(evidence: dict[str, Any]) -> dict[str, str]:
    return {
        "build_manifest_sha256": evidence["build_manifest"]["sha256"],
        "deployment_verification_sha256": evidence["deployment_verification"][
            "sha256"
        ],
        "upstream_attestation_sha256": evidence["upstream_review"]["attestation"][
            "sha256"
        ],
        "security_attestation_sha256": evidence["security_review"]["attestation"][
            "sha256"
        ],
        "public_testnet_report_sha256": evidence["public_testnet"][
            "evidence_report"
        ]["sha256"],
        "gas_report_sha256": evidence["gas"]["report"]["sha256"],
        "canary_report_sha256": evidence["canary"]["report"]["sha256"],
        "canary_governance_decision_sha256": evidence["canary"][
            "governance_decision"
        ]["sha256"],
        "operations_rehearsal_report_sha256": evidence["operations_rehearsal"][
            "report"
        ]["sha256"],
        "reviewed_evidence_sha256": release_review_payload_sha256(evidence),
    }


def release_decision_payload(document: dict[str, Any]) -> dict[str, Any]:
    return {field: document[field] for field in RELEASE_DECISION_PAYLOAD_FIELDS}


def release_decision_payload_sha256(document: dict[str, Any]) -> str:
    return deploy.sha256_bytes(
        deploy.canonical_json(release_decision_payload(document))
    )


def resolve_assertion_actual(
    transcript: dict[str, Any], predicate: str, source: Any, path: str
) -> Any:
    if predicate == "query_response_equals":
        source = obj(source, f"{path}.source", ("query_index",))
        index = uint(source["query_index"], f"{path}.source.query_index")
        if index >= len(transcript["queries"]):
            fail(f"{path}.source.query_index", "is outside captured queries")
        return transcript["queries"][index]["response"]
    if predicate == "balance_delta_equals":
        source = obj(source, f"{path}.source", ("before_index", "after_index"))
        before_index = uint(source["before_index"], f"{path}.source.before_index")
        after_index = uint(source["after_index"], f"{path}.source.after_index")
        balances = transcript["balances"]
        if before_index >= len(balances) or after_index >= len(balances):
            fail(f"{path}.source", "references a missing balance observation")
        before = balances[before_index]
        after = balances[after_index]
        if before["address"] != after["address"] or before["denom"] != after["denom"]:
            fail(f"{path}.source", "balance observations must use one address and denom")
        if before["height"] >= after["height"]:
            fail(f"{path}.source", "after balance height must be later than before")
        transaction_heights = [item["height"] for item in transcript["transaction_evidence"]]
        if before["height"] >= min(transaction_heights) or after["height"] < max(
            transaction_heights
        ):
            fail(
                f"{path}.source",
                "balance observations must bracket all scenario transactions",
            )
        return str(int(after["amount"]) - int(before["amount"]))
    if predicate in ("transaction_event_equals", "transaction_message_equals"):
        index_field = "event_index" if predicate == "transaction_event_equals" else "message_index"
        source = obj(source, f"{path}.source", ("transaction_hash", index_field))
        transaction_hash = tx_hash(source["transaction_hash"], f"{path}.source.transaction_hash")
        transaction = _transaction_evidence(transcript, transaction_hash, f"{path}.source")
        index = uint(source[index_field], f"{path}.source.{index_field}")
        collection = transaction["events"] if index_field == "event_index" else transaction["messages"]
        if index >= len(collection):
            fail(f"{path}.source.{index_field}", "is outside captured transaction data")
        return collection[index]
    if predicate == "matching_events_equal":
        source = obj(
            source,
            f"{path}.source",
            ("transaction_hashes", "event_type", "attributes"),
        )
        hashes = source["transaction_hashes"]
        if not isinstance(hashes, list) or not hashes:
            fail(f"{path}.source.transaction_hashes", "must be a nonempty array")
        event_type = nonempty(source["event_type"], f"{path}.source.event_type")
        attributes = source["attributes"]
        if not isinstance(attributes, dict) or not attributes:
            fail(f"{path}.source.attributes", "must be a nonempty string map")
        if any(not isinstance(key, str) or not isinstance(value, str) for key, value in attributes.items()):
            fail(f"{path}.source.attributes", "must contain only string keys and values")
        matches = []
        seen_hashes: set[str] = set()
        for index, value in enumerate(hashes):
            transaction_hash = tx_hash(value, f"{path}.source.transaction_hashes[{index}]")
            if transaction_hash in seen_hashes:
                fail(f"{path}.source.transaction_hashes[{index}]", "is duplicated")
            seen_hashes.add(transaction_hash)
            transaction = _transaction_evidence(transcript, transaction_hash, f"{path}.source")
            for event_index, event in enumerate(transaction["events"]):
                if (
                    isinstance(event, dict)
                    and event.get("type") == event_type
                    and _event_has_attributes(event, attributes)
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
        source = obj(source, f"{path}.source", ("transaction_hash",))
        transaction_hash = tx_hash(source["transaction_hash"], f"{path}.source.transaction_hash")
        return _transaction_evidence(transcript, transaction_hash, f"{path}.source")["code"]
    fail(f"{path}.predicate", "is not a supported linked predicate")


def validate_named_event_proof(
    transcript: dict[str, Any],
    name: str,
    predicate: str,
    source: Any,
    actual: Any,
    path: str,
) -> None:
    transaction_requirement = TRANSACTION_EVENT_PROOFS.get(name)
    if transaction_requirement is not None:
        if predicate != "transaction_event_equals":
            fail(f"{path}.predicate", "must be a direct transaction event proof")
        if not isinstance(actual, dict):
            fail(f"{path}.actual", "must be an emitted event object")
        if actual.get("type") != transaction_requirement["event_type"]:
            fail(
                f"{path}.actual.type",
                f"must equal {transaction_requirement['event_type']!r}",
            )
        raw_attributes = actual.get("attributes")
        if not isinstance(raw_attributes, list):
            fail(f"{path}.actual.attributes", "must be an array")
        attributes: dict[str, str] = {}
        for index, attribute in enumerate(raw_attributes):
            if not isinstance(attribute, dict):
                fail(f"{path}.actual.attributes[{index}]", "must be an object")
            key = attribute.get("key")
            value = attribute.get("value")
            if not isinstance(key, str) or not key:
                fail(f"{path}.actual.attributes[{index}].key", "must be nonempty")
            if not isinstance(value, str) or not value:
                fail(f"{path}.actual.attributes[{index}].value", "must be nonempty")
            if key in attributes:
                fail(f"{path}.actual.attributes[{index}].key", "is duplicated")
            attributes[key] = value
        required_keys = set(transaction_requirement["required_keys"])
        if set(attributes) != required_keys:
            fail(
                f"{path}.actual.attributes",
                "does not contain the exact stable event attribute set",
            )
        contract_address = transcript["addresses"][transaction_requirement["contract"]]
        if attributes["_contract_address"] != contract_address:
            fail(
                f"{path}.actual.attributes._contract_address",
                "does not match the verified deployment address",
            )
        for key, value in transaction_requirement["fixed_attributes"].items():
            if attributes.get(key) != value:
                fail(f"{path}.actual.attributes.{key}", f"must equal {value!r}")
        return

    matching_requirement = MATCHING_EVENT_PROOFS.get(name)
    if matching_requirement is not None:
        if predicate != "matching_events_equal" or not isinstance(source, dict):
            fail(f"{path}.predicate", "must be a matching-event proof")
        expected_attributes = {
            "_contract_address": transcript["addresses"][matching_requirement["contract"]]
        }
        if source.get("event_type") != matching_requirement["event_type"]:
            fail(
                f"{path}.source.event_type",
                f"must equal {matching_requirement['event_type']!r}",
            )
        if source.get("attributes") != expected_attributes:
            fail(
                f"{path}.source.attributes",
                "must select the verified bounty contract without arbitrary filters",
            )
        return

    empty_requirement = EMPTY_TRANSFER_EVENT_PROOFS.get(name)
    if empty_requirement is None:
        return
    if predicate != "matching_events_equal" or not isinstance(source, dict):
        fail(f"{path}.predicate", "must be a matching-event proof")
    balance_assertions = [
        assertion
        for assertion in transcript["assertions"]
        if isinstance(assertion, dict)
        and assertion.get("name") == empty_requirement["balance_assertion"]
    ]
    if len(balance_assertions) != 1:
        fail(
            f"{path}.source",
            "cannot bind the transfer scan to its required balance proof",
        )
    balance_source = balance_assertions[0].get("source")
    if not isinstance(balance_source, dict):
        fail(f"{path}.source", "has a malformed linked balance proof")
    before_index = balance_source.get("before_index")
    if (
        isinstance(before_index, bool)
        or not isinstance(before_index, int)
        or before_index < 0
        or before_index >= len(transcript["balances"])
    ):
        fail(f"{path}.source", "has an invalid linked balance observation")
    address = transcript["balances"][before_index]["address"]
    expected_attributes = {empty_requirement["address_attribute"]: address}
    if source.get("event_type") != "transfer":
        fail(f"{path}.source.event_type", "must equal 'transfer'")
    if source.get("attributes") != expected_attributes:
        fail(
            f"{path}.source.attributes",
            "must scan transfers for the address in the unchanged-balance proof",
        )


def _proof_object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(path, "must be an object")
    return value


def _uint128_string(value: Any, path: str, *, positive: bool = False) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value):
        fail(path, "must be a canonical Uint128 string")
    parsed = int(value)
    if positive and parsed == 0:
        fail(path, "must be positive")
    return parsed


def _positive_int_field(value: Any, path: str) -> int:
    return uint(value, path, positive=True)


def _validate_epoch_common(
    response: dict[str, Any], query_payload: dict[str, Any], path: str
) -> None:
    if response.get("gauge_id") != query_payload["gauge"]:
        fail(f"{path}.gauge_id", "does not match the queried gauge")
    if response.get("epoch_id") != query_payload["epoch"]:
        fail(f"{path}.epoch_id", "does not match the queried epoch")
    _positive_int_field(response.get("snapshot_height"), f"{path}.snapshot_height")
    snapshot_total = _uint128_string(
        response.get("snapshot_total_power"),
        f"{path}.snapshot_total_power",
        positive=True,
    )
    participating = _uint128_string(
        response.get("participating_power"), f"{path}.participating_power"
    )
    allocated = _uint128_string(response.get("allocated_power"), f"{path}.allocated_power")
    total_cast = _uint128_string(response.get("total_cast"), f"{path}.total_cast")
    retained_option = response.get("retained_option")
    if retained_option != "do-not-distribute":
        fail(f"{path}.retained_option", "must equal the configured retained option")
    retained_power = _uint128_string(
        response.get("retained_option_power"), f"{path}.retained_option_power"
    )
    unallocated = _uint128_string(response.get("unallocated_power"), f"{path}.unallocated_power")
    selected_power = _uint128_string(
        response.get("selected_project_power"), f"{path}.selected_project_power"
    )
    emitted = _uint128_string(response.get("emitted_value"), f"{path}.emitted_value")
    retained = _uint128_string(response.get("retained_value"), f"{path}.retained_value")
    if not (
        allocated == total_cast
        and allocated <= participating <= snapshot_total
        and retained_power <= allocated
        and unallocated == participating - allocated
        and selected_power <= allocated - retained_power
    ):
        fail(path, "does not preserve snapshot allocation invariants")
    turnout = response.get("min_turnout_bps")
    if isinstance(turnout, bool) or not isinstance(turnout, int) or not 0 <= turnout <= 10_000:
        fail(f"{path}.min_turnout_bps", "must be in 0..=10000")
    _positive_int_field(response.get("policy_version"), f"{path}.policy_version")
    budget = _uint128_string(response.get("epoch_budget"), f"{path}.epoch_budget", positive=True)
    if response.get("denom") != deploy.DENOM:
        fail(f"{path}.denom", f"must equal {deploy.DENOM!r}")
    opens_at = uint(response.get("opens_at"), f"{path}.opens_at")
    closes_at = uint(response.get("closes_at"), f"{path}.closes_at")
    deadline = uint(response.get("execution_deadline"), f"{path}.execution_deadline")
    if not opens_at < closes_at < deadline:
        fail(f"{path}.execution_deadline", "must follow the voting close")
    if response.get("outcome") != "open" and emitted + retained != budget:
        fail(path, "does not reconcile emitted plus retained value to the epoch budget")


def validate_named_query_proof(
    transcript: dict[str, Any],
    name: str,
    predicate: str,
    source: Any,
    actual: Any,
    path: str,
) -> None:
    requirement = QUERY_PROOFS.get(name)
    if requirement is None:
        return
    if predicate != "query_response_equals" or not isinstance(source, dict):
        fail(f"{path}.predicate", "must be a linked smart-query proof")
    query_index = source.get("query_index")
    if (
        isinstance(query_index, bool)
        or not isinstance(query_index, int)
        or query_index < 0
        or query_index >= len(transcript["queries"])
    ):
        fail(f"{path}.source.query_index", "does not reference a captured query")
    query_evidence = transcript["queries"][query_index]
    contract_name, query_name, semantics = requirement
    if query_evidence.get("contract") != transcript["addresses"][contract_name]:
        fail(
            f"{path}.source.query_index",
            f"must query the verified {contract_name} contract",
        )
    query_message = query_evidence.get("query")
    if not isinstance(query_message, dict) or set(query_message) != {query_name}:
        fail(f"{path}.query", f"must use the {query_name!r} query variant")
    query_payload = query_message[query_name]
    if not isinstance(query_payload, dict) or set(query_payload) != QUERY_PAYLOAD_FIELDS[query_name]:
        fail(f"{path}.query.{query_name}", "has the wrong query fields")
    response = _proof_object(actual, f"{path}.actual")

    if semantics in ("paid_bounty", "refunding_bounty"):
        bounty = _proof_object(response.get("bounty"), f"{path}.actual.bounty")
        _positive_int_field(bounty.get("id"), f"{path}.actual.bounty.id")
        if bounty["id"] != query_payload["bounty_id"]:
            fail(f"{path}.actual.bounty.id", "does not match the queried bounty")
        total = _uint128_string(
            bounty.get("total_contribution"),
            f"{path}.actual.bounty.total_contribution",
            positive=True,
        )
        refunded = _uint128_string(
            bounty.get("refunded_amount"), f"{path}.actual.bounty.refunded_amount"
        )
        if semantics == "paid_bounty":
            if bounty.get("status") != "paid":
                fail(f"{path}.actual.bounty.status", "must equal 'paid'")
            paid = _uint128_string(
                bounty.get("paid_amount"), f"{path}.actual.bounty.paid_amount"
            )
            if paid != total or refunded != 0:
                fail(f"{path}.actual.bounty", "must prove one full payout and no refund")
            nonempty(bounty.get("paid_recipient"), f"{path}.actual.bounty.paid_recipient")
        else:
            if bounty.get("status") != "refunding":
                fail(f"{path}.actual.bounty.status", "must equal 'refunding'")
            if refunded >= total:
                fail(f"{path}.actual.bounty.refunded_amount", "must leave a pull refund pending")
        return

    if semantics == "multiple_receipts":
        receipts = response.get("receipts")
        if not isinstance(receipts, list) or len(receipts) < 2:
            fail(f"{path}.actual.receipts", "must contain at least two vote receipts")
        voters: set[str] = set()
        for index, receipt in enumerate(receipts):
            receipt = _proof_object(receipt, f"{path}.actual.receipts[{index}]")
            if receipt.get("bounty_id") != query_payload["bounty_id"] or receipt.get(
                "round"
            ) != query_payload["round"]:
                fail(f"{path}.actual.receipts[{index}]", "does not match the queried round")
            voter = nonempty(receipt.get("voter"), f"{path}.actual.receipts[{index}].voter")
            if voter in voters:
                fail(f"{path}.actual.receipts[{index}].voter", "is duplicated")
            voters.add(voter)
            _uint128_string(
                receipt.get("weight"), f"{path}.actual.receipts[{index}].weight", positive=True
            )
        return

    if semantics in ("reset_round", "paid_round"):
        if response.get("bounty_id") != query_payload["bounty_id"] or response.get(
            "number"
        ) != query_payload["round"]:
            fail(f"{path}.actual", "does not match the queried round")
        if response.get("finalized_at") is None:
            fail(f"{path}.actual.finalized_at", "must prove a finalized round")
        outcome = response.get("outcome")
        if semantics == "reset_round" and outcome not in ("no_votes", "tie", "no_majority"):
            fail(f"{path}.actual.outcome", "must be a reset outcome")
        if semantics == "paid_round" and outcome != "paid":
            fail(f"{path}.actual.outcome", "must equal 'paid'")
        return

    if semantics == "old_receipt":
        if response.get("bounty_id") != query_payload["bounty_id"] or response.get(
            "round"
        ) != query_payload["round"]:
            fail(f"{path}.actual", "does not preserve the queried old-round receipt")
        if response.get("voter") != query_payload["voter"]:
            fail(f"{path}.actual.voter", "does not match the queried voter")
        _uint128_string(response.get("weight"), f"{path}.actual.weight", positive=True)
        return

    if semantics in (
        "graduated_project",
        "graduated_project_any_source",
        "pending_bonded_project",
        "approved_bonded_project",
        "suspended_project",
        "rejected_refunded_project",
        "rejected_forfeited_project",
        "retired_claimable_project",
        "retired_claimed_project",
    ):
        _positive_int_field(query_payload["project_id"], f"{path}.query.project.project_id")
        if response.get("id") != query_payload["project_id"]:
            fail(f"{path}.actual.id", "does not match the queried project")
        expected_status = {
            "graduated_project": "active",
            "graduated_project_any_source": "active",
            "pending_bonded_project": "pending",
            "approved_bonded_project": "active",
            "suspended_project": "suspended",
            "rejected_refunded_project": "rejected",
            "rejected_forfeited_project": "rejected",
            "retired_claimable_project": "retired",
            "retired_claimed_project": "retired",
        }[semantics]
        if response.get("status") != expected_status:
            fail(f"{path}.actual.status", f"must equal {expected_status!r}")
        provenance = _proof_object(response.get("provenance"), f"{path}.actual.provenance")
        if semantics in ("graduated_project", "graduated_project_any_source"):
            graduated = _proof_object(
                provenance.get("graduated_bounty"),
                f"{path}.actual.provenance.graduated_bounty",
            )
            _positive_int_field(
                graduated.get("source_bounty_id"),
                f"{path}.actual.provenance.graduated_bounty.source_bounty_id",
            )
            source_contract = nonempty(
                graduated.get("source_bounty_contract"),
                f"{path}.actual.provenance.graduated_bounty.source_bounty_contract",
            )
            try:
                source_bytes = deploy.decode_address(source_contract, "juno")
            except ValueError:
                fail(
                    f"{path}.actual.provenance.graduated_bounty.source_bounty_contract",
                    "must be a valid Juno address",
                )
            if len(source_bytes) != 32:
                fail(
                    f"{path}.actual.provenance.graduated_bounty.source_bounty_contract",
                    "must be a 32-byte Juno contract address",
                )
            if semantics == "graduated_project" and source_contract != transcript["addresses"]["bounty"]:
                fail(
                    f"{path}.actual.provenance.graduated_bounty.source_bounty_contract",
                    "must equal the verified bounty contract",
                )
            if response.get("bond") is not None:
                fail(f"{path}.actual.bond", "must be null for graduated provenance")
        else:
            bonded = _proof_object(
                provenance.get("bonded_registration"),
                f"{path}.actual.provenance.bonded_registration",
            )
            nonempty(
                bonded.get("applicant"),
                f"{path}.actual.provenance.bonded_registration.applicant",
            )
            bond = _proof_object(response.get("bond"), f"{path}.actual.bond")
            expected_bond_state = {
                "pending_bonded_project": "deposited",
                "approved_bonded_project": "deposited",
                "suspended_project": "deposited",
                "rejected_refunded_project": "refunded",
                "rejected_forfeited_project": "forfeited",
                "retired_claimable_project": "claimable",
                "retired_claimed_project": "claimed",
            }[semantics]
            if bond.get("state") != expected_bond_state:
                fail(
                    f"{path}.actual.bond.state",
                    f"must equal {expected_bond_state!r}",
                )
            _uint128_string(bond.get("amount"), f"{path}.actual.bond.amount", positive=True)
        return

    if semantics == "held_bond_accounting":
        liability = _uint128_string(
            response.get("bond_liability"), f"{path}.actual.bond_liability", positive=True
        )
        received = _uint128_string(
            response.get("lifetime_bonds_received"),
            f"{path}.actual.lifetime_bonds_received",
            positive=True,
        )
        if received < liability:
            fail(f"{path}.actual", "bond receipts cannot be below the held liability")
        return

    if semantics in (
        "distributed_epoch",
        "failed_turnout_epoch",
        "no_eligible_epoch",
        "partial_epoch",
        "retained_only_epoch",
        "underfunded_epoch",
        "expired_epoch",
        "aborted_epoch",
    ):
        _validate_epoch_common(response, query_payload, f"{path}.actual")
        outcome = response.get("outcome")
        if semantics in ("distributed_epoch", "partial_epoch"):
            distributed = _proof_object(outcome, f"{path}.actual.outcome").get("distributed")
            distributed = _proof_object(distributed, f"{path}.actual.outcome.distributed")
            _positive_int_field(
                distributed.get("message_count"),
                f"{path}.actual.outcome.distributed.message_count",
            )
            if semantics == "partial_epoch":
                participating = int(response["participating_power"])
                allocated = int(response["allocated_power"])
                if not 0 < allocated < participating:
                    fail(f"{path}.actual", "must prove a nonempty partial allocation")
                if int(response["unallocated_power"]) == 0:
                    fail(f"{path}.actual.unallocated_power", "must be positive")
                if int(response["emitted_value"]) == 0 or int(response["retained_value"]) == 0:
                    fail(f"{path}.actual", "must prove both emission and retention")
        elif semantics == "failed_turnout_epoch":
            if outcome != "no_distribution_turnout":
                fail(f"{path}.actual.outcome", "must equal 'no_distribution_turnout'")
            participating = int(response["participating_power"])
            total = int(response["snapshot_total_power"])
            if participating * 10_000 >= total * response["min_turnout_bps"]:
                fail(f"{path}.actual", "does not prove turnout below the threshold")
        elif semantics in ("no_eligible_epoch", "retained_only_epoch"):
            if outcome != "no_eligible_options":
                fail(f"{path}.actual.outcome", "must equal 'no_eligible_options'")
            if semantics == "retained_only_epoch":
                participating = int(response["participating_power"])
                if not (
                    participating > 0
                    and int(response["allocated_power"]) == participating
                    and int(response["retained_option_power"]) == participating
                    and int(response["unallocated_power"]) == 0
                    and int(response["selected_project_power"]) == 0
                    and int(response["emitted_value"]) == 0
                    and int(response["retained_value"]) == int(response["epoch_budget"])
                ):
                    fail(f"{path}.actual", "does not prove retained-only terminal accounting")
        elif semantics == "underfunded_epoch":
            insufficient = _proof_object(outcome, f"{path}.actual.outcome").get("insufficient_funds")
            insufficient = _proof_object(
                insufficient, f"{path}.actual.outcome.insufficient_funds"
            )
            required = _uint128_string(
                insufficient.get("required"),
                f"{path}.actual.outcome.insufficient_funds.required",
                positive=True,
            )
            available = _uint128_string(
                insufficient.get("available"),
                f"{path}.actual.outcome.insufficient_funds.available",
            )
            if available >= required or int(response["emitted_value"]) != 0:
                fail(f"{path}.actual", "does not prove terminal insufficient funds")
        elif semantics == "expired_epoch":
            if outcome != "expired" or int(response["emitted_value"]) != 0:
                fail(f"{path}.actual", "does not prove terminal expiry without emission")
        else:
            aborted = _proof_object(outcome, f"{path}.actual.outcome").get("aborted")
            aborted = _proof_object(aborted, f"{path}.actual.outcome.aborted")
            nonempty(aborted.get("reason"), f"{path}.actual.outcome.aborted.reason")
            if int(response["emitted_value"]) != 0:
                fail(f"{path}.actual.emitted_value", "must be zero for an abort")
        return

    if semantics in ("epoch_ballot", "partial_ballot", "retained_only_ballot"):
        ballot = _proof_object(response.get("ballot"), f"{path}.actual.ballot")
        if ballot.get("voter") != query_payload["voter"]:
            fail(f"{path}.actual.ballot.voter", "does not match the queried voter")
        _uint128_string(ballot.get("power"), f"{path}.actual.ballot.power", positive=True)
        votes = ballot.get("votes")
        if not isinstance(votes, list) or not votes:
            fail(f"{path}.actual.ballot.votes", "must contain a historical allocation")
        if semantics == "partial_ballot":
            total = Decimal(0)
            for index, vote in enumerate(votes):
                vote = _proof_object(vote, f"{path}.actual.ballot.votes[{index}]")
                option = vote.get("option")
                if not isinstance(option, str) or not re.fullmatch(r"project:[1-9][0-9]*", option):
                    fail(f"{path}.actual.ballot.votes[{index}].option", "must be a canonical project option")
                try:
                    weight = Decimal(vote.get("weight"))
                except (InvalidOperation, TypeError):
                    fail(f"{path}.actual.ballot.votes[{index}].weight", "must be a decimal")
                if weight <= 0:
                    fail(f"{path}.actual.ballot.votes[{index}].weight", "must be positive")
                total += weight
            if total >= 1:
                fail(f"{path}.actual.ballot.votes", "must leave an unallocated remainder")
        elif semantics == "retained_only_ballot":
            if len(votes) != 1 or votes[0] != {"option": "do-not-distribute", "weight": "1"}:
                fail(f"{path}.actual.ballot.votes", "must be one full retained-option allocation")
        _positive_int_field(
            ballot.get("receipt_index"), f"{path}.actual.ballot.receipt_index"
        )
        return

    if semantics in ("stopped_gauge", "resumed_gauge"):
        if response.get("id") != query_payload["id"]:
            fail(f"{path}.actual.id", "does not match the queried gauge")
        expected = semantics == "stopped_gauge"
        if response.get("is_stopped") is not expected:
            fail(f"{path}.actual.is_stopped", f"must equal {expected}")
        policy = _proof_object(response.get("snapshot_policy"), f"{path}.actual.snapshot_policy")
        if policy.get("denom") != deploy.DENOM:
            fail(f"{path}.actual.snapshot_policy.denom", f"must equal {deploy.DENOM!r}")
        if policy.get("retained_option") != "do-not-distribute":
            fail(
                f"{path}.actual.snapshot_policy.retained_option",
                "must equal the configured retained option",
            )
        _positive_int_field(
            policy.get("execution_window_seconds"),
            f"{path}.actual.snapshot_policy.execution_window_seconds",
        )
        return

    if semantics == "snapshot_authorities":
        if response.get("owner") != transcript["addresses"]["program_vault"]:
            fail(f"{path}.actual.owner", "must equal the verified Program Vault")
        if response.get("dao_core") != transcript["addresses"]["program_vault"]:
            fail(f"{path}.actual.dao_core", "must equal the verified Program Vault")
        power_source = _proof_object(
            response.get("power_source"), f"{path}.actual.power_source"
        )
        snapshot = _proof_object(
            power_source.get("epoch_snapshot"),
            f"{path}.actual.power_source.epoch_snapshot",
        )
        if snapshot.get("guardian") != transcript["addresses"]["agent_operations"]:
            fail(
                f"{path}.actual.power_source.epoch_snapshot.guardian",
                "must equal the verified Agent Operations DAO",
            )
        return

    if semantics == "isolated_epoch_list":
        epochs = response.get("epochs")
        if not isinstance(epochs, list) or len(epochs) < 2:
            fail(f"{path}.actual.epochs", "must contain at least two epochs")
        ids: set[int] = set()
        heights: set[int] = set()
        for index, epoch in enumerate(epochs):
            epoch = _proof_object(epoch, f"{path}.actual.epochs[{index}]")
            epoch_id = _positive_int_field(
                epoch.get("epoch_id"), f"{path}.actual.epochs[{index}].epoch_id"
            )
            height = _positive_int_field(
                epoch.get("snapshot_height"),
                f"{path}.actual.epochs[{index}].snapshot_height",
            )
            ids.add(epoch_id)
            heights.add(height)
        if len(ids) < 2 or len(heights) < 2:
            fail(f"{path}.actual.epochs", "must prove distinct epochs and snapshot heights")
        return

    fail(f"{path}.actual", f"has unsupported query proof semantics {semantics!r}")


def validate_scenario_query_relationships(
    transcript: dict[str, Any], scenario_id: str, path: str
) -> None:
    assertions = {
        assertion["name"]: assertion
        for assertion in transcript["assertions"]
        if isinstance(assertion, dict) and isinstance(assertion.get("name"), str)
    }

    def query_for(name: str) -> dict[str, Any]:
        return transcript["queries"][assertions[name]["source"]["query_index"]]

    def event_attributes(name: str) -> dict[str, str]:
        raw = assertions[name]["actual"]["attributes"]
        return {item["key"]: item["value"] for item in raw}

    def bind_epoch_event(query_name: str, event_name: str) -> None:
        epoch = assertions[query_name]["actual"]
        attributes = event_attributes(event_name)
        expected = {
            "gauge_id": str(epoch["gauge_id"]),
            "epoch_id": str(epoch["epoch_id"]),
            "snapshot_height": str(epoch["snapshot_height"]),
            "snapshot_total_power": epoch["snapshot_total_power"],
            "participating_power": epoch["participating_power"],
            "allocated_power": epoch["allocated_power"],
            "total_cast": epoch["total_cast"],
            "retained_option_power": epoch["retained_option_power"],
            "unallocated_power": epoch["unallocated_power"],
            "selected_project_power": epoch["selected_project_power"],
            "emitted_value": epoch["emitted_value"],
            "retained_value": epoch["retained_value"],
            "min_turnout_bps": str(epoch["min_turnout_bps"]),
            "policy_version": str(epoch["policy_version"]),
            "epoch_budget": epoch["epoch_budget"],
            "denom": epoch["denom"],
            "execution_deadline": str(epoch["execution_deadline"]),
        }
        outcome = epoch["outcome"]
        if isinstance(outcome, str):
            expected["outcome"] = outcome
            expected["message_count"] = "0"
        elif "distributed" in outcome:
            expected["outcome"] = "distributed"
            expected["message_count"] = str(outcome["distributed"]["message_count"])
        elif "insufficient_funds" in outcome:
            expected["outcome"] = "insufficient_funds"
            expected["message_count"] = "0"
        elif "aborted" in outcome:
            expected["outcome"] = "aborted"
            expected["message_count"] = "0"
        if any(attributes.get(key) != value for key, value in expected.items()):
            fail(path, f"{event_name} does not bind the queried epoch accounting")

    if scenario_id == "multi_fund_ratify_pay":
        bounty = query_for("bounty_paid_state")["query"]["bounty"]["bounty_id"]
        receipts = query_for("contributor_receipts_state")["query"]["receipts"]
        if receipts["bounty_id"] != bounty:
            fail(path, "paid bounty and contributor receipts must reference one bounty")
    elif scenario_id == "reset_renominate_pay":
        first = query_for("first_round_reset_state")["query"]["round"]
        later = query_for("later_round_paid_state")["query"]["round"]
        receipt = query_for("old_receipt_isolation")["query"]["receipt"]
        if not (
            first["bounty_id"] == later["bounty_id"] == receipt["bounty_id"]
            and receipt["round"] == first["round"]
            and later["round"] > first["round"]
        ):
            fail(path, "round-reset proofs do not preserve one bounty and an older receipt")
    elif scenario_id == "paid_bounty_graduation":
        bounty_query = query_for("paid_bounty_state")["query"]["bounty"]
        project = assertions["active_graduated_project_state"]["actual"]
        provenance = project["provenance"]["graduated_bounty"]
        if provenance["source_bounty_id"] != bounty_query["bounty_id"]:
            fail(path, "graduated project provenance does not reference the paid bounty")
    elif scenario_id == "bonded_registration_approval":
        pending = query_for("pending_bonded_project_state")["query"]["project"]
        active = query_for("active_approved_project_state")["query"]["project"]
        if pending["project_id"] != active["project_id"]:
            fail(path, "pending and approved proofs must reference one project")
    elif scenario_id in (
        "snapshot_turnout_distribution",
        "partial_ballot_retention",
        "retained_only_no_distribution",
    ):
        epoch_name = {
            "snapshot_turnout_distribution": "epoch_snapshot_state",
            "partial_ballot_retention": "partial_epoch_state",
            "retained_only_no_distribution": "retained_only_epoch_state",
        }[scenario_id]
        ballot_name = {
            "snapshot_turnout_distribution": "historical_ballot_state",
            "partial_ballot_retention": "partial_ballot_state",
            "retained_only_no_distribution": "retained_only_ballot_state",
        }[scenario_id]
        epoch = query_for(epoch_name)["query"]["epoch"]
        ballot = query_for(ballot_name)["query"]["epoch_ballot"]
        if epoch["gauge"] != ballot["gauge"] or epoch["epoch"] != ballot["epoch"]:
            fail(path, "snapshot epoch and historical ballot must reference one epoch")
        if scenario_id in ("snapshot_turnout_distribution", "partial_ballot_retention"):
            bind_epoch_event(epoch_name, "distribution_event")
        elif scenario_id == "retained_only_no_distribution":
            bind_epoch_event(epoch_name, "retained_only_terminal_event")
    elif scenario_id in (
        "underfunded_terminal_epoch",
        "expired_terminal_epoch",
        "aborted_terminal_epoch",
    ):
        query_name, event_name = {
            "underfunded_terminal_epoch": (
                "underfunded_epoch_state", "underfunded_terminal_event"
            ),
            "expired_terminal_epoch": (
                "expired_epoch_state", "expired_terminal_event"
            ),
            "aborted_terminal_epoch": (
                "aborted_epoch_state", "aborted_terminal_event"
            ),
        }[scenario_id]
        bind_epoch_event(query_name, event_name)
        attributes = event_attributes(event_name)
        outcome = assertions[query_name]["actual"]["outcome"]
        if scenario_id == "underfunded_terminal_epoch":
            insufficient = outcome["insufficient_funds"]
            if (
                attributes.get("required_value") != insufficient["required"]
                or attributes.get("available_balance") != insufficient["available"]
            ):
                fail(path, "underfunded event does not bind required and available value")
        if scenario_id == "aborted_terminal_epoch":
            if attributes.get("reason") != outcome["aborted"]["reason"]:
                fail(path, "abort event does not bind the terminal reason")
    elif scenario_id == "numeric_identity_assignment":
        bonded = assertions["assigned_bonded_project_state"]["actual"]
        graduated = assertions["assigned_graduated_project_state"]["actual"]
        if graduated["id"] != bonded["id"] + 1:
            fail(path, "registry-assigned IDs must be consecutive in chain transaction order")
        project_id = event_attributes("registration_assignment_event").get("project_id")
        if project_id != str(bonded["id"]):
            fail(path, "registration event does not bind the assigned numeric project ID")
    elif scenario_id == "bounty_source_rotation":
        old = assertions["old_source_project_state"]["actual"]
        replacement = assertions["replacement_source_project_state"]["actual"]
        old_source = old["provenance"]["graduated_bounty"]
        replacement_source = replacement["provenance"]["graduated_bounty"]
        if not (
            old["id"] != replacement["id"]
            and old_source["source_bounty_id"]
            == replacement_source["source_bounty_id"]
            and old_source["source_bounty_contract"]
            != replacement_source["source_bounty_contract"]
            and replacement_source["source_bounty_contract"]
            == transcript["addresses"]["bounty"]
        ):
            fail(path, "does not prove source-namespaced bounty ID reuse after rotation")
    elif scenario_id == "bond_transition_table":
        states = {
            name: assertions[name]["actual"]
            for name in REQUIRED_SCENARIO_ASSERTIONS[scenario_id]
        }
        lifecycle_names = (
            "bond_pending_state", "bond_active_state", "bond_suspended_state",
            "bond_retired_claimable_state", "bond_retired_claimed_state",
        )
        if len({states[name]["id"] for name in lifecycle_names}) != 1:
            fail(path, "pending, active, suspended, retired, and claimed proofs must follow one bond")
        if len({state["id"] for state in states.values()}) < 4:
            fail(path, "bond transition evidence must cover multiple independent project paths")
    elif scenario_id == "guardian_stop_governor_recovery":
        stopped = query_for("guardian_stopped_state")["query"]["gauge"]
        resumed = query_for("governor_resumed_state")["query"]["gauge"]
        if stopped["id"] != resumed["id"]:
            fail(path, "stop and recovery proofs must reference one gauge")
    elif scenario_id == "consecutive_epoch_isolation":
        first = query_for("first_epoch_state")["query"]["epoch"]
        second = query_for("second_epoch_state")["query"]["epoch"]
        first_ballot = query_for("first_ballot_state")["query"]["epoch_ballot"]
        second_ballot = query_for("second_ballot_state")["query"]["epoch_ballot"]
        listed = assertions["snapshot_isolation_state"]["actual"]["epochs"]
        listed_pairs = {(epoch["epoch_id"], epoch["snapshot_height"]) for epoch in listed}
        first_response = assertions["first_epoch_state"]["actual"]
        second_response = assertions["second_epoch_state"]["actual"]
        if not (
            first["gauge"] == second["gauge"]
            and first["epoch"] != second["epoch"]
            and (first_ballot["gauge"], first_ballot["epoch"])
            == (first["gauge"], first["epoch"])
            and (second_ballot["gauge"], second_ballot["epoch"])
            == (second["gauge"], second["epoch"])
            and first_response["snapshot_height"] != second_response["snapshot_height"]
            and (first_response["epoch_id"], first_response["snapshot_height"])
            in listed_pairs
            and (second_response["epoch_id"], second_response["snapshot_height"])
            in listed_pairs
        ):
            fail(path, "consecutive epoch proofs do not establish snapshot isolation")


def validate_scenario_transcript(
    reference: dict[str, str],
    root: Path,
    config: dict[str, Any],
    scenario_id: str,
    transactions: list[str],
    assertion_count: int,
    code_ids: dict[str, int],
    addresses: dict[str, str],
) -> None:
    transcript_path = root / reference["path"]
    try:
        transcript = json.loads(transcript_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail(f"scenario.{scenario_id}.evidence", f"must be a JSON transcript: {error}")
    obj(
        transcript,
        f"scenario.{scenario_id}.transcript",
        (
            "schema_version",
            "scenario_id",
            "chain_id",
            "config_sha256",
            "code_checksums",
            "code_ids",
            "addresses",
            "mock_components",
            "transactions",
            "transaction_evidence",
            "queries",
            "balances",
            "assertions",
            "passed",
        ),
    )
    if transcript["schema_version"] != "juno-voice/uni7-scenario-transcript/v2":
        fail(f"scenario.{scenario_id}.schema_version", "is invalid")
    if transcript["scenario_id"] != scenario_id:
        fail(f"scenario.{scenario_id}.scenario_id", "does not match the evidence entry")
    if transcript["chain_id"] != config["chain"]["chain_id"]:
        fail(f"scenario.{scenario_id}.chain_id", "does not match deployment config")
    if transcript["config_sha256"] != deploy.config_hash(config):
        fail(f"scenario.{scenario_id}.config_sha256", "does not match deployment config")
    expected_checksums = {
        name: item["sha256"] for name, item in config["artifacts"].items()
    }
    if transcript["code_checksums"] != expected_checksums:
        fail(f"scenario.{scenario_id}.code_checksums", "does not match exact artifacts")
    if transcript["code_ids"] != code_ids:
        fail(f"scenario.{scenario_id}.code_ids", "does not match deployment verification")
    if transcript["addresses"] != addresses:
        fail(f"scenario.{scenario_id}.addresses", "does not match deployment verification")
    if transcript["mock_components"] != []:
        fail(f"scenario.{scenario_id}.mock_components", "must be empty")
    if transcript["transactions"] != transactions:
        fail(f"scenario.{scenario_id}.transactions", "does not match evidence entry")
    transaction_evidence = transcript["transaction_evidence"]
    if not isinstance(transaction_evidence, list) or len(transaction_evidence) != len(transactions):
        fail(f"scenario.{scenario_id}.transaction_evidence", "must cover every transaction")
    allowed_message_contracts = allowed_scenario_contracts(config, addresses)
    if scenario_id == "bounty_source_rotation":
        old_source_assertions = [
            assertion
            for assertion in transcript["assertions"]
            if isinstance(assertion, dict)
            and assertion.get("name") == "old_source_project_state"
        ]
        if len(old_source_assertions) == 1:
            try:
                old_source = old_source_assertions[0]["actual"]["provenance"][
                    "graduated_bounty"
                ]["source_bounty_contract"]
            except (KeyError, TypeError):
                old_source = None
            if isinstance(old_source, str):
                allowed_message_contracts.add(old_source)
    evidence_hashes = []
    successful_transactions = 0
    for index, transaction in enumerate(transaction_evidence):
        transaction = obj(
            transaction,
            f"scenario.{scenario_id}.transaction_evidence[{index}]",
            (
                "hash",
                "height",
                "code",
                "gas_wanted",
                "gas_used",
                "response_sha256",
                "response",
                "messages",
                "events",
            ),
        )
        evidence_hashes.append(tx_hash(
            transaction["hash"],
            f"scenario.{scenario_id}.transaction_evidence[{index}].hash",
        ))
        uint(transaction["height"], f"scenario.{scenario_id}.transaction_evidence[{index}].height", positive=True)
        uint(transaction["code"], f"scenario.{scenario_id}.transaction_evidence[{index}].code")
        uint(transaction["gas_wanted"], f"scenario.{scenario_id}.transaction_evidence[{index}].gas_wanted", positive=True)
        uint(transaction["gas_used"], f"scenario.{scenario_id}.transaction_evidence[{index}].gas_used", positive=True)
        if not deploy.HEX_64.fullmatch(nonempty(
            transaction["response_sha256"],
            f"scenario.{scenario_id}.transaction_evidence[{index}].response_sha256",
        )):
            fail(f"scenario.{scenario_id}.transaction_evidence[{index}].response_sha256", "must be SHA-256")
        response = transaction["response"]
        if not isinstance(response, dict) or not response:
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].response",
                "must contain the complete query-tx response",
            )
        actual_response_hash = deploy.sha256_bytes(deploy.canonical_json(response))
        if actual_response_hash != transaction["response_sha256"]:
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].response_sha256",
                "does not match the complete response",
            )
        response_tx = response.get("tx_response", response)
        if not isinstance(response_tx, dict):
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].response",
                "has a malformed tx_response",
            )
        response_hash = str(response_tx.get("txhash", "")).upper()
        if response_hash != transaction["hash"]:
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].response.txhash",
                "does not match the captured transaction",
            )
        for field in ("height", "gas_wanted", "gas_used"):
            try:
                response_value = int(response_tx.get(field))
            except (TypeError, ValueError):
                fail(
                    f"scenario.{scenario_id}.transaction_evidence[{index}].response.{field}",
                    "is not an integer",
                )
            if response_value != transaction[field]:
                fail(
                    f"scenario.{scenario_id}.transaction_evidence[{index}].response.{field}",
                    "does not match the captured summary",
                )
        try:
            response_code = int(response_tx.get("code", 0))
        except (TypeError, ValueError):
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].response.code",
                "is not an integer",
            )
        if response_code != transaction["code"]:
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].response.code",
                "does not match the captured summary",
            )
        if response_code == 0:
            successful_transactions += 1
        messages = response_messages(response, response_tx)
        if not messages or messages != transaction["messages"]:
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].messages",
                "must exactly match the decoded transaction messages",
            )
        for message_index, message in enumerate(messages):
            validate_transaction_message(
                message,
                allowed_message_contracts,
                f"scenario.{scenario_id}.transaction_evidence[{index}].messages[{message_index}]",
            )
        events = response_tx.get("events")
        if not isinstance(events, list) or not events or events != transaction["events"]:
            fail(
                f"scenario.{scenario_id}.transaction_evidence[{index}].events",
                "must exactly match the emitted transaction events",
            )
        for event_index, event in enumerate(events):
            validate_transaction_event(
                event,
                f"scenario.{scenario_id}.transaction_evidence[{index}].events[{event_index}]",
            )
    if evidence_hashes != transactions:
        fail(f"scenario.{scenario_id}.transaction_evidence", "order does not match transactions")
    if successful_transactions == 0:
        fail(
            f"scenario.{scenario_id}.transaction_evidence",
            "must contain at least one successful transaction",
        )
    queries = transcript["queries"]
    if not isinstance(queries, list) or not queries:
        fail(f"scenario.{scenario_id}.queries", "must contain chain query evidence")
    allowed_query_contracts = allowed_scenario_contracts(config, addresses)
    for index, query in enumerate(queries):
        query = obj(
            query,
            f"scenario.{scenario_id}.queries[{index}]",
            ("height", "contract", "query", "response", "response_sha256"),
        )
        uint(query["height"], f"scenario.{scenario_id}.queries[{index}].height", positive=True)
        deploy.decode_address(
            query["contract"],
            config["chain"]["bech32_prefix"],
            f"scenario.{scenario_id}.queries[{index}].contract",
        )
        if query["contract"] not in allowed_query_contracts:
            fail(
                f"scenario.{scenario_id}.queries[{index}].contract",
                "is not one of the verified Juno Voice or Agent Operations contracts",
            )
        if not isinstance(query["query"], dict) or not query["query"]:
            fail(f"scenario.{scenario_id}.queries[{index}].query", "must be a nonempty object")
        if not deploy.HEX_64.fullmatch(nonempty(
            query["response_sha256"],
            f"scenario.{scenario_id}.queries[{index}].response_sha256",
        )):
            fail(f"scenario.{scenario_id}.queries[{index}].response_sha256", "must be SHA-256")
        actual_response_hash = deploy.sha256_bytes(deploy.canonical_json(query["response"]))
        if actual_response_hash != query["response_sha256"]:
            fail(f"scenario.{scenario_id}.queries[{index}].response_sha256", "does not match response")
    balances = transcript["balances"]
    if not isinstance(balances, list) or len(balances) < 2:
        fail(f"scenario.{scenario_id}.balances", "must contain pre/post chain balances")
    for index, balance in enumerate(balances):
        balance = obj(
            balance,
            f"scenario.{scenario_id}.balances[{index}]",
            ("label", "height", "address", "denom", "amount"),
        )
        nonempty(balance["label"], f"scenario.{scenario_id}.balances[{index}].label")
        uint(balance["height"], f"scenario.{scenario_id}.balances[{index}].height", positive=True)
        deploy.decode_address(
            balance["address"],
            config["chain"]["bech32_prefix"],
            f"scenario.{scenario_id}.balances[{index}].address",
        )
        if balance["denom"] != deploy.DENOM:
            fail(f"scenario.{scenario_id}.balances[{index}].denom", "must equal ujuno")
        if not isinstance(balance["amount"], str) or not re.fullmatch(r"0|[1-9][0-9]*", balance["amount"]):
            fail(f"scenario.{scenario_id}.balances[{index}].amount", "must be a Uint128 string")
    assertions = transcript["assertions"]
    if not isinstance(assertions, list) or len(assertions) != assertion_count:
        fail(f"scenario.{scenario_id}.assertions", "count does not match evidence entry")
    seen_assertions: dict[str, str] = {}
    seen_sources: set[tuple[str, bytes]] = set()
    for index, assertion in enumerate(assertions):
        assertion_path = f"scenario.{scenario_id}.assertions[{index}]"
        assertion = obj(
            assertion,
            assertion_path,
            ("name", "predicate", "source", "expected", "actual", "passed"),
        )
        name = nonempty(assertion["name"], f"{assertion_path}.name")
        if name in seen_assertions:
            fail(f"{assertion_path}.name", "is duplicated")
        predicate = nonempty(assertion["predicate"], f"{assertion_path}.predicate")
        if REQUIRED_SCENARIO_ASSERTIONS[scenario_id].get(name) != predicate:
            fail(
                f"{assertion_path}.predicate",
                "does not match the required named proof profile",
            )
        source_identity = (predicate, deploy.canonical_json(assertion["source"]))
        if source_identity in seen_sources:
            fail(f"{assertion_path}.source", "is reused by another assertion")
        seen_sources.add(source_identity)
        actual = resolve_assertion_actual(
            transcript,
            predicate,
            assertion["source"],
            assertion_path,
        )
        validate_named_event_proof(
            transcript,
            name,
            predicate,
            assertion["source"],
            actual,
            assertion_path,
        )
        validate_named_query_proof(
            transcript,
            name,
            predicate,
            assertion["source"],
            actual,
            assertion_path,
        )
        if deploy.canonical_json(assertion["actual"]) != deploy.canonical_json(actual):
            fail(
                f"{assertion_path}.actual",
                "does not match the referenced chain evidence",
            )
        computed_passed = deploy.canonical_json(assertion["expected"]) == deploy.canonical_json(actual)
        if assertion["passed"] is not computed_passed:
            fail(
                f"{assertion_path}.passed",
                "does not match the linked evidence comparison",
            )
        if assertion["passed"] is not True:
            fail(f"{assertion_path}.passed", "must be true")
        if name in POSITIVE_BALANCE_ASSERTIONS and int(actual) <= 0:
            fail(f"{assertion_path}.actual", "must prove a positive balance delta")
        if name in ZERO_BALANCE_ASSERTIONS and actual != "0":
            fail(f"{assertion_path}.actual", "must prove an unchanged balance")
        if name in EMPTY_EVENT_ASSERTIONS and actual != []:
            fail(f"{assertion_path}.actual", "must prove no matching transfer events")
        if name == "refund_events" and not actual:
            fail(f"{assertion_path}.actual", "must prove at least one refund event")
        if name in ("agent_resume_rejected", "old_source_replay_rejected") and actual == 0:
            fail(f"{assertion_path}.actual", "must prove a failed transaction code")
        if name == "old_source_replay_rejected":
            transaction = _transaction_evidence(
                transcript,
                assertion["source"]["transaction_hash"],
                f"{assertion_path}.source",
            )
            old_projects = [
                item
                for item in assertions
                if isinstance(item, dict) and item.get("name") == "old_source_project_state"
            ]
            if len(old_projects) != 1:
                fail(
                    f"{assertion_path}.source",
                    "requires exactly one old-source project proof",
                )
            old_project = old_projects[0]["actual"]
            old_provenance = old_project["provenance"]["graduated_bounty"]
            messages = transaction["messages"]
            expected_execute = {
                "graduate_project": {
                    "bounty_id": old_provenance["source_bounty_id"]
                }
            }
            if (
                len(messages) != 1
                or messages[0].get("@type")
                != "/cosmwasm.wasm.v1.MsgExecuteContract"
                or messages[0].get("contract")
                != old_provenance["source_bounty_contract"]
                or messages[0].get("msg") != expected_execute
                or messages[0].get("funds") != []
            ):
                fail(
                    f"{assertion_path}.source",
                    "must be a failed replay of the old source/bounty pair",
                )
        if predicate == "matching_events_equal" and set(
            assertion["source"]["transaction_hashes"]
        ) != set(transactions):
            fail(
                f"{assertion_path}.source.transaction_hashes",
                "must cover every scenario transaction",
            )
        seen_assertions[name] = predicate
    if seen_assertions != REQUIRED_SCENARIO_ASSERTIONS[scenario_id]:
        fail(
            f"scenario.{scenario_id}.assertions",
            "does not match the required named proof profile",
        )
    validate_scenario_query_relationships(
        transcript, scenario_id, f"scenario.{scenario_id}.assertions"
    )
    if transcript["passed"] is not True:
        fail(f"scenario.{scenario_id}.passed", "must be true")


def validate_evidence(
    evidence: dict[str, Any],
    root: Path,
    config: dict[str, Any],
    *,
    allowed_signers: Path,
    authorization_principal: str,
) -> None:
    """Validate a complete packet, including final release authorization."""
    _validate_evidence(
        evidence,
        root,
        config,
        require_release_decision=True,
        allowed_signers=allowed_signers,
        authorization_principal=authorization_principal,
    )


def validate_pre_decision_evidence(
    evidence: dict[str, Any], root: Path, config: dict[str, Any]
) -> None:
    """Validate every gate except the explicitly not-yet-created decision."""
    _validate_evidence(
        evidence,
        root,
        config,
        require_release_decision=False,
        allowed_signers=None,
        authorization_principal=None,
    )


def _validate_evidence(
    evidence: dict[str, Any],
    root: Path,
    config: dict[str, Any],
    *,
    require_release_decision: bool,
    allowed_signers: Path | None,
    authorization_principal: str | None,
) -> None:
    obj(
        evidence,
        "$",
        (
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
        ),
    )
    if evidence["schema_version"] != EVIDENCE_SCHEMA:
        fail("schema_version", f"must equal {EVIDENCE_SCHEMA!r}")
    build_ref = file_ref(evidence["build_manifest"], "build_manifest", root)
    try:
        build = json.loads((root / build_ref["path"]).read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail("build_manifest", f"must be a JSON build manifest: {error}")
    validate_build_manifest(build, config, root, (root / build_ref["path"]).resolve())
    verification_ref = file_ref(
        evidence["deployment_verification"], "deployment_verification", root
    )
    try:
        verification = json.loads((root / verification_ref["path"]).read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail("deployment_verification", f"must be a JSON verification report: {error}")
    obj(
        verification,
        "deployment_verification",
        (
            "schema_version",
            "config_sha256",
            "chain_id",
            "source",
            "preflight",
            "code_ids",
            "addresses",
            "observations",
            "checks",
        ),
    )
    if verification.get("schema_version") != deploy.VERIFICATION_SCHEMA:
        fail("deployment_verification.schema_version", "is invalid")
    if verification.get("config_sha256") != deploy.config_hash(config):
        fail("deployment_verification.config_sha256", "does not match deployment config")
    if verification.get("chain_id") != config["chain"]["chain_id"]:
        fail("deployment_verification.chain_id", "does not match deployment config")
    if verification.get("source") != config["source"]:
        fail("deployment_verification.source", "does not match deployment config")
    try:
        deploy.validate_preflight_report(config, verification["preflight"])
    except deploy.ValidationError as error:
        fail("deployment_verification.preflight", str(error))
    verification_code_ids = verification.get("code_ids")
    verification_addresses = verification.get("addresses")
    if not isinstance(verification_code_ids, dict) or set(verification_code_ids) != set(deploy.REQUIRED_ARTIFACTS):
        fail("deployment_verification.code_ids", "must contain all five artifacts")
    parsed_code_ids = [
        uint(verification_code_ids[name], f"deployment_verification.code_ids.{name}", positive=True)
        for name in deploy.REQUIRED_ARTIFACTS
    ]
    if len(set(parsed_code_ids)) != len(parsed_code_ids):
        fail("deployment_verification.code_ids", "must contain five distinct code IDs")
    if verification_addresses != deploy.derive_addresses(config):
        fail("deployment_verification.addresses", "does not match deterministic addresses")
    expected_checks = deploy.expected_verification_checks(config, verification_code_ids)
    if verification["checks"] != expected_checks:
        fail("deployment_verification.checks", "does not match the complete verification profile")
    try:
        deploy.validate_verification_observations(
            config,
            verification_code_ids,
            verification_addresses,
            verification["observations"],
        )
    except (deploy.ValidationError, RuntimeError) as error:
        fail("deployment_verification.observations", str(error))

    upstream = obj(
        evidence["upstream_review"],
        "upstream_review",
        ("status", "repository", "commit", "review_url", "accepted_by", "attestation"),
    )
    if upstream["status"] != "accepted":
        fail("upstream_review.status", "must equal 'accepted'")
    https_url(upstream["repository"], "upstream_review.repository")
    https_url(upstream["review_url"], "upstream_review.review_url")
    if upstream["commit"] != config["source"]["dao_contracts_commit"]:
        fail("upstream_review.commit", "must equal the configured submodule commit")
    nonempty(upstream["accepted_by"], "upstream_review.accepted_by")
    upstream_attestation_ref = file_ref(
        upstream["attestation"], "upstream_review.attestation", root
    )
    try:
        upstream_attestation = json.loads(
            (root / upstream_attestation_ref["path"]).read_text()
        )
    except (OSError, json.JSONDecodeError) as error:
        fail("upstream_review.attestation", f"must be a JSON attestation: {error}")
    upstream_attestation = obj(
        upstream_attestation,
        "upstream_review.attestation.document",
        (
            "schema_version",
            "status",
            "repository",
            "commit",
            "review_url",
            "accepted_by",
            "accepted_at",
            "signature",
        ),
    )
    if upstream_attestation["schema_version"] != "juno-voice/upstream-attestation/v1":
        fail("upstream_review.attestation.schema_version", "is invalid")
    for field in ("status", "repository", "commit", "review_url", "accepted_by"):
        if upstream_attestation[field] != upstream[field]:
            fail(
                f"upstream_review.attestation.{field}",
                "does not match the accepted upstream review",
            )
    nonempty(upstream_attestation["accepted_at"], "upstream_review.attestation.accepted_at")
    upstream_signature = obj(
        upstream_attestation["signature"],
        "upstream_review.attestation.signature",
        ("method", "value"),
    )
    nonempty(upstream_signature["method"], "upstream_review.attestation.signature.method")
    nonempty(upstream_signature["value"], "upstream_review.attestation.signature.value")

    security = obj(
        evidence["security_review"],
        "security_review",
        (
            "status",
            "reviewer",
            "scope_parent_commit",
            "scope_dao_contracts_commit",
            "report",
            "attestation",
            "open_critical",
            "open_high",
            "lower_findings",
        ),
    )
    if security["status"] != "passed":
        fail("security_review.status", "must equal 'passed'")
    nonempty(security["reviewer"], "security_review.reviewer")
    if security["scope_parent_commit"] != config["source"]["parent_commit"]:
        fail("security_review.scope_parent_commit", "does not match configured source")
    if security["scope_dao_contracts_commit"] != config["source"]["dao_contracts_commit"]:
        fail("security_review.scope_dao_contracts_commit", "does not match configured source")
    security_report_ref = file_ref(security["report"], "security_review.report", root)
    security_attestation_ref = file_ref(
        security["attestation"], "security_review.attestation", root
    )
    if uint(security["open_critical"], "security_review.open_critical") != 0:
        fail("security_review.open_critical", "must be zero")
    if uint(security["open_high"], "security_review.open_high") != 0:
        fail("security_review.open_high", "must be zero")
    if not isinstance(security["lower_findings"], list):
        fail("security_review.lower_findings", "must be an array")
    seen_findings: set[str] = set()
    for index, finding in enumerate(security["lower_findings"]):
        finding = obj(
            finding,
            f"security_review.lower_findings[{index}]",
            ("id", "severity", "disposition", "rationale"),
        )
        finding_id = nonempty(finding["id"], f"security_review.lower_findings[{index}].id")
        if finding_id in seen_findings:
            fail(f"security_review.lower_findings[{index}].id", "is duplicated")
        seen_findings.add(finding_id)
        if finding["severity"] not in ("medium", "low", "informational"):
            fail(f"security_review.lower_findings[{index}].severity", "is invalid")
        if finding["disposition"] not in ("resolved", "accepted"):
            fail(f"security_review.lower_findings[{index}].disposition", "is invalid")
        nonempty(finding["rationale"], f"security_review.lower_findings[{index}].rationale")
    try:
        attestation = json.loads((root / security_attestation_ref["path"]).read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail("security_review.attestation", f"must be a JSON attestation: {error}")
    attestation = obj(
        attestation,
        "security_review.attestation.document",
        (
            "schema_version",
            "status",
            "reviewer",
            "scope_parent_commit",
            "scope_dao_contracts_commit",
            "report_sha256",
            "open_critical",
            "open_high",
            "lower_finding_ids",
            "signed_at",
            "signature",
        ),
    )
    if attestation["schema_version"] != "juno-voice/security-attestation/v1":
        fail("security_review.attestation.schema_version", "is invalid")
    for field, expected in (
        ("status", security["status"]),
        ("reviewer", security["reviewer"]),
        ("scope_parent_commit", security["scope_parent_commit"]),
        ("scope_dao_contracts_commit", security["scope_dao_contracts_commit"]),
        ("report_sha256", security_report_ref["sha256"]),
        ("open_critical", 0),
        ("open_high", 0),
    ):
        if attestation[field] != expected:
            fail(f"security_review.attestation.{field}", "does not match the reviewed evidence")
    lower_finding_ids = attestation["lower_finding_ids"]
    if (
        not isinstance(lower_finding_ids, list)
        or any(not isinstance(value, str) for value in lower_finding_ids)
        or set(lower_finding_ids) != seen_findings
        or len(lower_finding_ids) != len(seen_findings)
    ):
        fail(
            "security_review.attestation.lower_finding_ids",
            "does not match the dispositioned lower findings",
        )
    nonempty(attestation["signed_at"], "security_review.attestation.signed_at")
    signature = obj(
        attestation["signature"],
        "security_review.attestation.signature",
        ("method", "value"),
    )
    nonempty(signature["method"], "security_review.attestation.signature.method")
    nonempty(signature["value"], "security_review.attestation.signature.value")

    testnet = obj(
        evidence["public_testnet"],
        "public_testnet",
        (
            "chain_id",
            "config_sha256",
            "code_checksums",
            "scenarios",
            "snapshot",
            "evidence_report",
        ),
    )
    if testnet["chain_id"] != "uni-7" or testnet["chain_id"] != config["chain"]["chain_id"]:
        fail("public_testnet.chain_id", "must equal configured uni-7")
    if testnet["config_sha256"] != deploy.config_hash(config):
        fail("public_testnet.config_sha256", "does not match deployment config")
    expected_checksums = {
        name: item["sha256"] for name, item in config["artifacts"].items()
    }
    if testnet["code_checksums"] != expected_checksums:
        fail("public_testnet.code_checksums", "must exactly match all configured artifacts")
    scenarios = testnet["scenarios"]
    if not isinstance(scenarios, list):
        fail("public_testnet.scenarios", "must be an array")
    seen_scenarios: set[str] = set()
    seen_scenario_transactions: set[str] = set()
    for index, scenario in enumerate(scenarios):
        scenario = obj(
            scenario,
            f"public_testnet.scenarios[{index}]",
            ("id", "status", "transactions", "assertion_count", "evidence"),
        )
        scenario_id = nonempty(scenario["id"], f"public_testnet.scenarios[{index}].id")
        if scenario_id in seen_scenarios:
            fail(f"public_testnet.scenarios[{index}].id", "is duplicated")
        seen_scenarios.add(scenario_id)
        if scenario["status"] != "passed":
            fail(f"public_testnet.scenarios[{index}].status", "must equal 'passed'")
        transactions = scenario["transactions"]
        if not isinstance(transactions, list) or not transactions:
            fail(f"public_testnet.scenarios[{index}].transactions", "must be nonempty")
        for tx_index, value in enumerate(transactions):
            value = tx_hash(value, f"public_testnet.scenarios[{index}].transactions[{tx_index}]")
            if value in seen_scenario_transactions:
                fail(
                    f"public_testnet.scenarios[{index}].transactions[{tx_index}]",
                    "is reused by another scenario",
                )
            seen_scenario_transactions.add(value)
        uint(
            scenario["assertion_count"],
            f"public_testnet.scenarios[{index}].assertion_count",
            positive=True,
        )
        transcript_ref = file_ref(
            scenario["evidence"],
            f"public_testnet.scenarios[{index}].evidence",
            root,
        )
        validate_scenario_transcript(
            transcript_ref,
            root,
            config,
            scenario_id,
            transactions,
            scenario["assertion_count"],
            verification_code_ids,
            verification_addresses,
        )
    if seen_scenarios != REQUIRED_SCENARIOS:
        missing = sorted(REQUIRED_SCENARIOS - seen_scenarios)
        extra = sorted(seen_scenarios - REQUIRED_SCENARIOS)
        fail("public_testnet.scenarios", f"scenario set mismatch; missing={missing}, extra={extra}")
    snapshot = obj(
        testnet["snapshot"],
        "public_testnet.snapshot",
        (
            "module_activation_height",
            "export_boundary",
            "observed_retention_blocks",
            "required_retention_blocks",
            "liquid_staking_allowlist",
            "power_basis",
            "stake_change_transactions",
            "voter_address",
            "first_epoch_height",
            "second_epoch_height",
            "historical_power_queries",
            "evidence",
        ),
    )
    module_activation_height = uint(
        snapshot["module_activation_height"],
        "public_testnet.snapshot.module_activation_height",
        positive=True,
    )
    if snapshot["export_boundary"] != "EndBlock":
        fail("public_testnet.snapshot.export_boundary", "must equal 'EndBlock'")
    observed = uint(
        snapshot["observed_retention_blocks"],
        "public_testnet.snapshot.observed_retention_blocks",
    )
    required = uint(
        snapshot["required_retention_blocks"],
        "public_testnet.snapshot.required_retention_blocks",
        positive=True,
    )
    if required != config["tranche"]["snapshot_retention_blocks"] or (
        observed != 0 and observed < required
    ):
        fail("public_testnet.snapshot.observed_retention_blocks", "does not satisfy configured retention")
    if not isinstance(snapshot["liquid_staking_allowlist"], list):
        fail("public_testnet.snapshot.liquid_staking_allowlist", "must be an array")
    if snapshot["liquid_staking_allowlist"]:
        fail(
            "public_testnet.snapshot.liquid_staking_allowlist",
            "must be empty for the native-staking-only v1 voting module",
        )
    seen_lst_addresses: set[str] = set()
    for index, address in enumerate(snapshot["liquid_staking_allowlist"]):
        deploy.decode_address(
            address,
            config["chain"]["bech32_prefix"],
            f"public_testnet.snapshot.liquid_staking_allowlist[{index}]",
        )
        if address in seen_lst_addresses:
            fail(
                f"public_testnet.snapshot.liquid_staking_allowlist[{index}]",
                "is duplicated",
            )
        seen_lst_addresses.add(address)
    if snapshot["power_basis"] != "native bonded Juno stake at the exported snapshot height":
        fail(
            "public_testnet.snapshot.power_basis",
            "does not describe the exact v1 native staking power basis",
        )
    voter_address = nonempty(
        snapshot["voter_address"], "public_testnet.snapshot.voter_address"
    )
    deploy.decode_address(
        voter_address,
        config["chain"]["bech32_prefix"],
        "public_testnet.snapshot.voter_address",
    )
    stake_txs = snapshot["stake_change_transactions"]
    if not isinstance(stake_txs, list) or len(stake_txs) < 2:
        fail("public_testnet.snapshot.stake_change_transactions", "must contain at least two transactions")
    all_evidence_transactions = set(seen_scenario_transactions)
    stake_hashes: set[str] = set()
    stake_heights: list[int] = []
    staking_power_delta = 0
    staking_message_types = {
        "delegate": "/cosmos.staking.v1beta1.MsgDelegate",
        "undelegate": "/cosmos.staking.v1beta1.MsgUndelegate",
        "redelegate": "/cosmos.staking.v1beta1.MsgBeginRedelegate",
    }
    for index, value in enumerate(stake_txs):
        stake_path = f"public_testnet.snapshot.stake_change_transactions[{index}]"
        value = obj(
            value,
            stake_path,
            ("hash", "height", "kind", "transaction_evidence"),
        )
        value_hash = tx_hash(
            value["hash"],
            f"{stake_path}.hash",
        )
        value_height = uint(
            value["height"],
            f"{stake_path}.height",
            positive=True,
        )
        if value_hash in all_evidence_transactions:
            fail(
                f"public_testnet.snapshot.stake_change_transactions[{index}].hash",
                "is reused by other release evidence",
            )
        if value_hash in stake_hashes:
            fail(
                f"public_testnet.snapshot.stake_change_transactions[{index}].hash",
                "is duplicated",
            )
        stake_hashes.add(value_hash)
        stake_heights.append(value_height)
        all_evidence_transactions.add(value_hash)
        kind = nonempty(value["kind"], f"{stake_path}.kind")
        if kind not in staking_message_types:
            fail(f"{stake_path}.kind", "is not a supported native staking change")
        capture = validate_captured_transaction(
            value["transaction_evidence"],
            value_hash,
            allowed_scenario_contracts(config, verification_addresses),
            f"{stake_path}.transaction_evidence",
        )
        if capture["height"] != value_height:
            fail(f"{stake_path}.height", "does not match the captured transaction")
        if capture["code"] != 0:
            fail(f"{stake_path}.transaction_evidence.code", "must prove successful execution")
        if len(capture["messages"]) != 1:
            fail(f"{stake_path}.transaction_evidence.messages", "must contain one staking message")
        message = capture["messages"][0]
        expected_type = staking_message_types[kind]
        expected_fields = (
            ("@type", "delegator_address", "validator_src_address", "validator_dst_address", "amount")
            if kind == "redelegate"
            else ("@type", "delegator_address", "validator_address", "amount")
        )
        message = obj(message, f"{stake_path}.transaction_evidence.messages[0]", expected_fields)
        if message["@type"] != expected_type:
            fail(f"{stake_path}.transaction_evidence.messages[0].@type", "does not match kind")
        if message["delegator_address"] != voter_address:
            fail(
                f"{stake_path}.transaction_evidence.messages[0].delegator_address",
                "must equal the historical-power voter",
            )
        validator_fields = (
            ("validator_src_address", "validator_dst_address")
            if kind == "redelegate"
            else ("validator_address",)
        )
        validators: list[str] = []
        for field in validator_fields:
            validator = nonempty(
                message[field], f"{stake_path}.transaction_evidence.messages[0].{field}"
            )
            deploy.decode_address(
                validator,
                f"{config['chain']['bech32_prefix']}valoper",
                f"{stake_path}.transaction_evidence.messages[0].{field}",
            )
            validators.append(validator)
        if len(validators) == 2 and validators[0] == validators[1]:
            fail(f"{stake_path}.transaction_evidence.messages[0]", "redelegation validators must differ")
        coin = obj(
            message["amount"],
            f"{stake_path}.transaction_evidence.messages[0].amount",
            ("denom", "amount"),
        )
        if coin["denom"] != config["chain"]["native_denom"]:
            fail(
                f"{stake_path}.transaction_evidence.messages[0].amount.denom",
                "does not match the configured native denom",
            )
        amount = _uint128_string(
            coin["amount"],
            f"{stake_path}.transaction_evidence.messages[0].amount.amount",
            positive=True,
        )
        if kind == "delegate":
            staking_power_delta += amount
        elif kind == "undelegate":
            staking_power_delta -= amount
    first_height = uint(snapshot["first_epoch_height"], "public_testnet.snapshot.first_epoch_height", positive=True)
    second_height = uint(snapshot["second_epoch_height"], "public_testnet.snapshot.second_epoch_height", positive=True)
    if first_height >= second_height:
        fail("public_testnet.snapshot.second_epoch_height", "must be after the first epoch height")
    if first_height < module_activation_height:
        fail(
            "public_testnet.snapshot.first_epoch_height",
            "must not precede snapshot-module activation",
        )
    if not all(first_height < height < second_height for height in stake_heights):
        fail(
            "public_testnet.snapshot.stake_change_transactions",
            "must occur after the first snapshot and before the later snapshot",
        )
    historical_queries = snapshot["historical_power_queries"]
    if not isinstance(historical_queries, list):
        fail("public_testnet.snapshot.historical_power_queries", "must be an array")
    observed_queries: dict[str, tuple[int, int]] = {}
    for index, query_capture in enumerate(historical_queries):
        query_path = f"public_testnet.snapshot.historical_power_queries[{index}]"
        query_capture = obj(
            query_capture,
            query_path,
            (
                "name",
                "observed_at_height",
                "contract",
                "query",
                "response",
                "response_sha256",
            ),
        )
        name = nonempty(query_capture["name"], f"{query_path}.name")
        if name in observed_queries:
            fail(f"{query_path}.name", "is duplicated")
        if name not in REQUIRED_SNAPSHOT_QUERIES:
            fail(f"{query_path}.name", "is not a required historical query")
        observed_at = uint(
            query_capture["observed_at_height"],
            f"{query_path}.observed_at_height",
            positive=True,
        )
        if query_capture["contract"] != verification_addresses["voting_module"]:
            fail(f"{query_path}.contract", "must equal the verified voting module")
        is_voter = "voter" in name
        variant = "voting_power_at_height" if is_voter else "total_power_at_height"
        query_message = obj(query_capture["query"], f"{query_path}.query", (variant,))
        query_payload = obj(
            query_message[variant],
            f"{query_path}.query.{variant}",
            ("address", "height") if is_voter else ("height",),
        )
        expected_height = second_height if name.startswith("second_") else first_height
        if query_payload["height"] != expected_height:
            fail(f"{query_path}.query.{variant}.height", "does not match the named epoch")
        if is_voter and query_payload["address"] != voter_address:
            fail(f"{query_path}.query.{variant}.address", "does not match voter_address")
        response = obj(query_capture["response"], f"{query_path}.response", ("power", "height"))
        if response["height"] != expected_height:
            fail(f"{query_path}.response.height", "does not match the requested height")
        power = _uint128_string(
            response["power"],
            f"{query_path}.response.power",
            positive=not is_voter,
        )
        response_sha256 = nonempty(
            query_capture["response_sha256"], f"{query_path}.response_sha256"
        )
        if not deploy.HEX_64.fullmatch(response_sha256):
            fail(f"{query_path}.response_sha256", "must be SHA-256")
        if response_sha256 != deploy.sha256_bytes(deploy.canonical_json(response)):
            fail(f"{query_path}.response_sha256", "does not match the captured response")
        observed_queries[name] = (observed_at, power)
    if set(observed_queries) != REQUIRED_SNAPSHOT_QUERIES:
        fail(
            "public_testnet.snapshot.historical_power_queries",
            "must contain exactly the six before/after historical power queries",
        )
    first_change_height = min(stake_heights)
    last_change_height = max(stake_heights)
    if any(
        observed_queries[name][0] >= first_change_height
        for name in ("first_voter_before_change", "first_total_before_change")
    ):
        fail(
            "public_testnet.snapshot.historical_power_queries",
            "before-change observations must precede the first staking change",
        )
    if any(
        observed_queries[name][0] <= last_change_height
        for name in (
            "first_voter_after_change",
            "first_total_after_change",
            "second_voter_after_change",
            "second_total_after_change",
        )
    ):
        fail(
            "public_testnet.snapshot.historical_power_queries",
            "after-change observations must follow the last staking change",
        )
    if (
        observed_queries["first_voter_before_change"][1]
        != observed_queries["first_voter_after_change"][1]
        or observed_queries["first_total_before_change"][1]
        != observed_queries["first_total_after_change"][1]
    ):
        fail(
            "public_testnet.snapshot.historical_power_queries",
            "the first epoch must remain fixed across the staking changes",
        )
    if (
        observed_queries["second_voter_after_change"][1]
        == observed_queries["first_voter_after_change"][1]
    ):
        fail(
            "public_testnet.snapshot.historical_power_queries",
            "the later epoch must observe changed voter power",
        )
    observed_power_delta = (
        observed_queries["second_voter_after_change"][1]
        - observed_queries["first_voter_after_change"][1]
    )
    if observed_power_delta != staking_power_delta:
        fail(
            "public_testnet.snapshot.stake_change_transactions",
            "captured native staking amounts do not reconcile to changed voter power",
        )
    latest_observation_height = max(
        observation[0] for observation in observed_queries.values()
    )
    if observed != 0 and latest_observation_height - first_height < required:
        fail(
            "public_testnet.snapshot.historical_power_queries",
            "does not prove a successful historical query after the required retention window",
        )
    file_ref(snapshot["evidence"], "public_testnet.snapshot.evidence", root)
    testnet_report_ref = file_ref(
        testnet["evidence_report"], "public_testnet.evidence_report", root
    )

    gas = obj(evidence["gas"], "gas", ("safety_margin_bps", "measurements", "report"))
    margin = uint(gas["safety_margin_bps"], "gas.safety_margin_bps", positive=True)
    if margin < 1000 or margin > 10_000:
        fail("gas.safety_margin_bps", "must be between 1000 and 10000")
    if not isinstance(gas["measurements"], list):
        fail("gas.measurements", "must be an array")
    seen_cases: set[str] = set()
    expected_configured_maxima = {
        "bounty_max_contributors": config["bounty"]["max_contributors"],
        "registry_max_projects": deploy.MAX_ACTIVE_PROJECTS,
        "gauge_max_options": deploy.MAX_GAUGE_OPTIONS,
        "adapter_max_messages": config["registry"]["max_selected_projects"],
        "query_max_pagination": max(
            config["bounty"]["limits"]["max_page_limit"],
            config["registry"]["max_page_limit"],
        ),
        "bounty_max_history": config["bounty"]["limits"]["max_page_limit"],
        "gauge_max_cleanup_batch": 100,
    }
    seen_gas_transactions: set[str] = set()
    for index, measurement in enumerate(gas["measurements"]):
        measurement = obj(
            measurement,
            f"gas.measurements[{index}]",
            (
                "case",
                "configured_max",
                "measurement_kind",
                "height",
                "contract",
                "operation",
                "request",
                "gas_limit",
                "gas_used",
                "response_bytes",
                "response",
                "response_sha256",
                "transaction",
            ),
        )
        case = nonempty(measurement["case"], f"gas.measurements[{index}].case")
        if case in seen_cases:
            fail(f"gas.measurements[{index}].case", "is duplicated")
        seen_cases.add(case)
        if case not in GAS_CASE_PROFILES:
            fail(f"gas.measurements[{index}].case", "is not a required gas case")
        profile = GAS_CASE_PROFILES[case]
        configured_max = uint(
            measurement["configured_max"],
            f"gas.measurements[{index}].configured_max",
            positive=True,
        )
        if case in expected_configured_maxima and configured_max != expected_configured_maxima[case]:
            fail(f"gas.measurements[{index}].configured_max", "does not match deployment limit")
        if measurement["measurement_kind"] != profile["kind"]:
            fail(
                f"gas.measurements[{index}].measurement_kind",
                f"must equal {profile['kind']!r}",
            )
        measurement_height = uint(
            measurement["height"],
            f"gas.measurements[{index}].height",
            positive=True,
        )
        expected_contract = verification_addresses[profile["contract"]]
        if measurement["contract"] != expected_contract:
            fail(
                f"gas.measurements[{index}].contract",
                f"must equal the verified {profile['contract']} contract",
            )
        if measurement["operation"] != profile["operation"]:
            fail(
                f"gas.measurements[{index}].operation",
                f"must equal {profile['operation']!r}",
            )
        request = obj(
            measurement["request"],
            f"gas.measurements[{index}].request",
            (profile["operation"],),
        )
        payload = request[profile["operation"]]
        if not isinstance(payload, dict):
            fail(f"gas.measurements[{index}].request.{profile['operation']}", "must be an object")
        gas_limit = uint(
            measurement["gas_limit"],
            f"gas.measurements[{index}].gas_limit",
            positive=True,
        )
        gas_used = uint(
            measurement["gas_used"],
            f"gas.measurements[{index}].gas_used",
            positive=True,
        )
        if gas_used * (10_000 + margin) > gas_limit * 10_000:
            fail(f"gas.measurements[{index}].gas_used", "does not retain the declared safety margin")
        response = measurement["response"]
        if not isinstance(response, dict) or not response:
            fail(f"gas.measurements[{index}].response", "must be a nonempty object")
        response_sha256 = nonempty(
            measurement["response_sha256"],
            f"gas.measurements[{index}].response_sha256",
        )
        if not deploy.HEX_64.fullmatch(response_sha256):
            fail(f"gas.measurements[{index}].response_sha256", "must be SHA-256")
        response_bytes = deploy.canonical_json(response)
        if response_sha256 != deploy.sha256_bytes(response_bytes):
            fail(f"gas.measurements[{index}].response_sha256", "does not match the captured response")
        if uint(
            measurement["response_bytes"],
            f"gas.measurements[{index}].response_bytes",
            positive=True,
        ) != len(response_bytes):
            fail(f"gas.measurements[{index}].response_bytes", "does not match the captured response")
        measurement_tx = tx_hash(
            measurement["transaction"], f"gas.measurements[{index}].transaction"
        )
        if measurement_tx in seen_gas_transactions:
            fail(f"gas.measurements[{index}].transaction", "is duplicated")
        if measurement_tx in all_evidence_transactions:
            fail(
                f"gas.measurements[{index}].transaction",
                "is reused by other release evidence",
            )
        seen_gas_transactions.add(measurement_tx)
        all_evidence_transactions.add(measurement_tx)

        gas_path = f"gas.measurements[{index}]"
        operation = profile["operation"]
        if case == "bounty_max_contributors":
            obj(payload, f"{gas_path}.request.{operation}", ("bounty_id", "start_after", "limit"))
            uint(payload["bounty_id"], f"{gas_path}.request.{operation}.bounty_id", positive=True)
        elif case == "registry_max_projects":
            obj(payload, f"{gas_path}.request.{operation}", ("start_after", "limit"))
        elif case == "gauge_max_options":
            obj(payload, f"{gas_path}.request.{operation}", ("gauge", "epoch", "start_after", "limit"))
            uint(payload["gauge"], f"{gas_path}.request.{operation}.gauge")
            uint(payload["epoch"], f"{gas_path}.request.{operation}.epoch", positive=True)
        elif case == "adapter_max_messages":
            obj(
                payload,
                f"{gas_path}.request.{operation}",
                ("selected", "epoch_budget", "available_balance", "denom"),
            )
            selected = payload["selected"]
            if not isinstance(selected, list) or len(selected) != configured_max:
                fail(f"{gas_path}.request.{operation}.selected", "must contain the configured maximum selections")
            selected_options: set[str] = set()
            for selected_index, allocation in enumerate(selected):
                allocation_path = f"{gas_path}.request.{operation}.selected[{selected_index}]"
                if not isinstance(allocation, list) or len(allocation) != 2:
                    fail(allocation_path, "must be an option/weight pair")
                option = nonempty(allocation[0], f"{allocation_path}[0]")
                if option in selected_options:
                    fail(f"{allocation_path}[0]", "is duplicated")
                selected_options.add(option)
                nonempty(allocation[1], f"{allocation_path}[1]")
            _uint128_string(payload["epoch_budget"], f"{gas_path}.request.{operation}.epoch_budget", positive=True)
            _uint128_string(payload["available_balance"], f"{gas_path}.request.{operation}.available_balance", positive=True)
            if payload["denom"] != config["chain"]["native_denom"]:
                fail(f"{gas_path}.request.{operation}.denom", "does not match the configured native denom")
        elif case == "query_max_pagination":
            obj(payload, f"{gas_path}.request.{operation}", ("start_after", "limit"))
        elif case == "bounty_max_history":
            obj(payload, f"{gas_path}.request.{operation}", ("bounty_id", "start_after", "limit"))
            uint(payload["bounty_id"], f"{gas_path}.request.{operation}.bounty_id", positive=True)
        else:
            obj(payload, f"{gas_path}.request.{operation}", ("gauge", "epoch", "limit"))
            uint(payload["gauge"], f"{gas_path}.request.{operation}.gauge")
            uint(payload["epoch"], f"{gas_path}.request.{operation}.epoch", positive=True)

        if case != "adapter_max_messages" and payload.get("limit") != configured_max:
            fail(f"{gas_path}.request.{operation}.limit", "does not request the configured maximum")
        if "start_after" in payload and payload["start_after"] is not None:
            fail(f"{gas_path}.request.{operation}.start_after", "must be null for a full maximum page")

        collection_name = profile["response_collection"]
        if collection_name is not None:
            response = obj(response, f"{gas_path}.response", (collection_name,))
            collection = response[collection_name]
            if not isinstance(collection, list) or len(collection) != configured_max:
                fail(
                    f"{gas_path}.response.{collection_name}",
                    "must contain the configured maximum observed items",
                )
            if case == "adapter_max_messages":
                for message_index, message in enumerate(collection):
                    message_path = f"{gas_path}.response.execute[{message_index}]"
                    message = obj(message, message_path, ("bank",))
                    bank = obj(message["bank"], f"{message_path}.bank", ("send",))
                    send = obj(bank["send"], f"{message_path}.bank.send", ("to_address", "amount"))
                    deploy.decode_address(
                        send["to_address"],
                        config["chain"]["bech32_prefix"],
                        f"{message_path}.bank.send.to_address",
                    )
                    amounts = send["amount"]
                    if not isinstance(amounts, list) or len(amounts) != 1:
                        fail(f"{message_path}.bank.send.amount", "must contain one native coin")
                    coin = obj(amounts[0], f"{message_path}.bank.send.amount[0]", ("denom", "amount"))
                    if coin["denom"] != config["chain"]["native_denom"]:
                        fail(f"{message_path}.bank.send.amount[0].denom", "does not match the configured native denom")
                    _uint128_string(coin["amount"], f"{message_path}.bank.send.amount[0].amount", positive=True)
        else:
            response_tx = response.get("tx_response", response)
            if not isinstance(response_tx, dict):
                fail(f"{gas_path}.response", "has a malformed tx_response")
            if str(response_tx.get("txhash", "")).upper() != measurement_tx:
                fail(f"{gas_path}.response.txhash", "does not match the measurement transaction")
            for field, expected in (
                ("height", measurement_height),
                ("gas_wanted", gas_limit),
                ("gas_used", gas_used),
                ("code", 0),
            ):
                try:
                    observed_value = int(response_tx.get(field, 0))
                except (TypeError, ValueError):
                    fail(f"{gas_path}.response.{field}", "is not an integer")
                if observed_value != expected:
                    fail(f"{gas_path}.response.{field}", "does not match the measurement summary")
            events = response_tx.get("events")
            if not isinstance(events, list):
                fail(f"{gas_path}.response.events", "must be an array")
            cleanup_events = [
                event
                for event in events
                if isinstance(event, dict)
                and event.get("type") == "wasm"
                and _event_has_attributes(
                    event,
                    {
                        "_contract_address": expected_contract,
                        "action": "cleanup_snapshot_epoch",
                        "processed": str(configured_max),
                    },
                )
            ]
            if len(cleanup_events) != 1:
                fail(f"{gas_path}.response.events", "must prove one maximum-batch cleanup event")
    if seen_cases != REQUIRED_GAS_CASES:
        fail("gas.measurements", "must contain exactly the seven configured maximum cases")
    gas_report_ref = file_ref(gas["report"], "gas.report", root)
    try:
        gas_report_document = json.loads((root / gas_report_ref["path"]).read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail("gas.report", f"must be a JSON gas report: {error}")
    validate_gas_report_document(gas_report_document, gas, config)

    canary = obj(
        evidence["canary"],
        "canary",
        ("status", "epochs", "maximum_total_value", "report", "governance_decision"),
    )
    if canary["status"] != "passed":
        fail("canary.status", "must equal 'passed'")
    epochs = canary["epochs"]
    if not isinstance(epochs, list) or len(epochs) < 2:
        fail("canary.epochs", "must contain at least two completed low-value epochs")
    seen_epochs: set[int] = set()
    seen_snapshot_heights: set[int] = set()
    seen_canary_transactions: set[str] = set()
    previous_epoch = 0
    previous_snapshot_height = 0
    total_value = 0
    allowed_canary_contracts = allowed_scenario_contracts(config, verification_addresses)
    for index, epoch in enumerate(epochs):
        canary_path = f"canary.epochs[{index}]"
        epoch = obj(
            epoch,
            canary_path,
            (
                "epoch",
                "snapshot_height",
                "outcome",
                "distributed_value",
                "transaction",
                "transaction_evidence",
                "epoch_query",
            ),
        )
        epoch_id = uint(epoch["epoch"], f"{canary_path}.epoch", positive=True)
        if epoch_id in seen_epochs:
            fail(f"{canary_path}.epoch", "is duplicated")
        if epoch_id <= previous_epoch:
            fail(f"{canary_path}.epoch", "must be strictly increasing")
        seen_epochs.add(epoch_id)
        previous_epoch = epoch_id
        snapshot_height = uint(
            epoch["snapshot_height"],
            f"{canary_path}.snapshot_height",
            positive=True,
        )
        if snapshot_height in seen_snapshot_heights or snapshot_height <= previous_snapshot_height:
            fail(
                f"{canary_path}.snapshot_height",
                "must be distinct and strictly increasing",
            )
        seen_snapshot_heights.add(snapshot_height)
        previous_snapshot_height = snapshot_height
        if epoch["outcome"] != "distributed":
            fail(f"{canary_path}.outcome", "must equal 'distributed'")
        value = uint(
            epoch["distributed_value"],
            f"{canary_path}.distributed_value",
            positive=True,
        )
        if value > int(config["gauge"]["epoch_budget"]):
            fail(f"{canary_path}.distributed_value", "exceeds epoch budget")
        total_value += value
        canary_tx = tx_hash(epoch["transaction"], f"{canary_path}.transaction")
        if canary_tx in seen_canary_transactions:
            fail(f"{canary_path}.transaction", "is duplicated")
        if canary_tx in all_evidence_transactions:
            fail(
                f"{canary_path}.transaction",
                "is reused by other release evidence",
            )
        seen_canary_transactions.add(canary_tx)
        all_evidence_transactions.add(canary_tx)
        capture = validate_captured_transaction(
            epoch["transaction_evidence"],
            canary_tx,
            allowed_canary_contracts,
            f"{canary_path}.transaction_evidence",
        )
        if capture["code"] != 0:
            fail(f"{canary_path}.transaction_evidence.code", "must prove successful execution")
        if capture["height"] <= snapshot_height:
            fail(f"{canary_path}.transaction_evidence.height", "must follow the snapshot height")

        distribution_events = [
            event
            for event in capture["events"]
            if isinstance(event, dict)
            and event.get("type") == TRANSACTION_EVENT_PROOFS["distribution_event"]["event_type"]
            and _event_has_attributes(
                event,
                {
                    "_contract_address": verification_addresses["gauge"],
                    "action": "execute_snapshot_epoch",
                    "outcome": "distributed",
                },
            )
        ]
        if len(distribution_events) != 1:
            fail(f"{canary_path}.transaction_evidence.events", "must contain one gauge distribution event")
        distribution_event = distribution_events[0]
        validate_named_event_proof(
            {"addresses": verification_addresses},
            "distribution_event",
            "transaction_event_equals",
            {},
            distribution_event,
            f"{canary_path}.distribution_event",
        )
        distribution_attributes = {
            attribute["key"]: attribute["value"]
            for attribute in distribution_event["attributes"]
        }

        query_capture = obj(
            epoch["epoch_query"],
            f"{canary_path}.epoch_query",
            (
                "observed_at_height",
                "contract",
                "query",
                "response",
                "response_sha256",
            ),
        )
        query_observed_at = uint(
            query_capture["observed_at_height"],
            f"{canary_path}.epoch_query.observed_at_height",
            positive=True,
        )
        if query_observed_at < capture["height"]:
            fail(f"{canary_path}.epoch_query.observed_at_height", "must include post-execution state")
        if query_capture["contract"] != verification_addresses["gauge"]:
            fail(f"{canary_path}.epoch_query.contract", "must equal the verified gauge contract")
        query_message = obj(
            query_capture["query"], f"{canary_path}.epoch_query.query", ("epoch",)
        )
        query_payload = obj(
            query_message["epoch"],
            f"{canary_path}.epoch_query.query.epoch",
            ("gauge", "epoch"),
        )
        gauge_id = uint(
            query_payload["gauge"],
            f"{canary_path}.epoch_query.query.epoch.gauge",
        )
        if query_payload["epoch"] != epoch_id:
            fail(f"{canary_path}.epoch_query.query.epoch.epoch", "does not match the canary epoch")
        response = obj(
            query_capture["response"],
            f"{canary_path}.epoch_query.response",
            EPOCH_RESPONSE_FIELDS,
        )
        response_checksum = nonempty(
            query_capture["response_sha256"],
            f"{canary_path}.epoch_query.response_sha256",
        )
        if not deploy.HEX_64.fullmatch(response_checksum) or response_checksum != deploy.sha256_bytes(
            deploy.canonical_json(response)
        ):
            fail(f"{canary_path}.epoch_query.response_sha256", "does not match the captured response")
        _validate_epoch_common(response, query_payload, f"{canary_path}.epoch_query.response")
        if response["snapshot_height"] != snapshot_height:
            fail(f"{canary_path}.epoch_query.response.snapshot_height", "does not match the canary snapshot")
        for field in ("opens_at", "closes_at", "voter_count", "option_count"):
            uint(response[field], f"{canary_path}.epoch_query.response.{field}")
        if response["opens_at"] >= response["closes_at"]:
            fail(f"{canary_path}.epoch_query.response.closes_at", "must follow opens_at")
        cleanup = obj(
            response["cleanup"],
            f"{canary_path}.epoch_query.response.cleanup",
            ("phase", "cursor", "complete"),
        )
        if cleanup["phase"] not in ("ballots", "options", "complete"):
            fail(f"{canary_path}.epoch_query.response.cleanup.phase", "is invalid")
        uint(cleanup["cursor"], f"{canary_path}.epoch_query.response.cleanup.cursor")
        if not isinstance(cleanup["complete"], bool):
            fail(f"{canary_path}.epoch_query.response.cleanup.complete", "must be boolean")
        outcome = _proof_object(
            response["outcome"], f"{canary_path}.epoch_query.response.outcome"
        )
        distributed = _proof_object(
            outcome.get("distributed"),
            f"{canary_path}.epoch_query.response.outcome.distributed",
        )
        message_count = uint(
            distributed.get("message_count"),
            f"{canary_path}.epoch_query.response.outcome.distributed.message_count",
            positive=True,
        )

        expected_event_values = {
            "gauge_id": str(gauge_id),
            "epoch_id": str(epoch_id),
            "snapshot_height": str(snapshot_height),
            "snapshot_total_power": response["snapshot_total_power"],
            "participating_power": response["participating_power"],
            "allocated_power": response["allocated_power"],
            "total_cast": response["total_cast"],
            "retained_option_power": response["retained_option_power"],
            "unallocated_power": response["unallocated_power"],
            "selected_project_power": response["selected_project_power"],
            "emitted_value": response["emitted_value"],
            "retained_value": response["retained_value"],
            "min_turnout_bps": str(response["min_turnout_bps"]),
            "policy_version": str(response["policy_version"]),
            "epoch_budget": str(config["gauge"]["epoch_budget"]),
            "denom": config["chain"]["native_denom"],
            "execution_deadline": str(response["execution_deadline"]),
            "message_count": str(message_count),
        }
        for attribute, expected in expected_event_values.items():
            if distribution_attributes.get(attribute) != expected:
                fail(f"{canary_path}.distribution_event.{attribute}", "does not match verified epoch state")
        if int(response["emitted_value"]) != value:
            fail(
                f"{canary_path}.epoch_query.response.emitted_value",
                "does not match distributed_value",
            )

        transfer_total = 0
        transfer_count = 0
        amount_pattern = re.compile(
            rf"^([1-9][0-9]*){re.escape(config['chain']['native_denom'])}$"
        )
        for event in capture["events"]:
            if not isinstance(event, dict) or event.get("type") != "transfer":
                continue
            attributes = {
                attribute.get("key"): attribute.get("value")
                for attribute in event.get("attributes", [])
                if isinstance(attribute, dict)
            }
            if attributes.get("sender") != verification_addresses["program_vault"]:
                continue
            recipient = nonempty(
                attributes.get("recipient"), f"{canary_path}.transfer.recipient"
            )
            deploy.decode_address(
                recipient,
                config["chain"]["bech32_prefix"],
                f"{canary_path}.transfer.recipient",
            )
            amount_match = amount_pattern.fullmatch(str(attributes.get("amount", "")))
            if amount_match is None:
                fail(f"{canary_path}.transfer.amount", "must be one positive configured-denom coin")
            transfer_total += int(amount_match.group(1))
            transfer_count += 1
        if transfer_count != message_count or transfer_total != value:
            fail(
                f"{canary_path}.transaction_evidence.events",
                "distribution transfers do not match message_count and distributed_value",
            )
    maximum = uint(canary["maximum_total_value"], "canary.maximum_total_value", positive=True)
    if total_value > maximum or maximum >= int(config["tranche"]["maximum_amount"]):
        fail(
            "canary.maximum_total_value",
            "must bound canary distributions below the full tranche maximum",
        )
    canary_report_ref = file_ref(canary["report"], "canary.report", root)
    canary_decision_ref = file_ref(
        canary["governance_decision"], "canary.governance_decision", root
    )
    try:
        canary_decision = json.loads((root / canary_decision_ref["path"]).read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail("canary.governance_decision", f"must be a JSON decision record: {error}")
    canary_decision = obj(
        canary_decision,
        "canary.governance_decision.document",
        (
            "schema_version",
            "status",
            "authorization",
            "production_authorized",
            "chain_id",
            "config_sha256",
            "source",
            "epochs",
            "transactions",
            "maximum_total_value",
            "larger_recurring_tranche_authorized",
            "decided_by",
            "decided_at",
            "signature",
        ),
    )
    if canary_decision["schema_version"] != "juno-voice/canary-decision/v1":
        fail("canary.governance_decision.schema_version", "is invalid")
    expected_canary_decision = {
        "status": "accepted",
        "authorization": "testnet_canary_complete_only",
        "production_authorized": False,
        "chain_id": config["chain"]["chain_id"],
        "config_sha256": deploy.config_hash(config),
        "source": config["source"],
        "epochs": [item["epoch"] for item in epochs],
        "transactions": [item["transaction"] for item in epochs],
        "maximum_total_value": maximum,
        "larger_recurring_tranche_authorized": False,
    }
    for field, expected in expected_canary_decision.items():
        if canary_decision[field] != expected:
            fail(
                f"canary.governance_decision.{field}",
                "does not match the completed canary evidence",
            )
    nonempty(canary_decision["decided_by"], "canary.governance_decision.decided_by")
    nonempty(canary_decision["decided_at"], "canary.governance_decision.decided_at")
    canary_signature = obj(
        canary_decision["signature"],
        "canary.governance_decision.signature",
        ("method", "value"),
    )
    nonempty(canary_signature["method"], "canary.governance_decision.signature.method")
    nonempty(canary_signature["value"], "canary.governance_decision.signature.value")

    runbooks = evidence["runbooks"]
    if not isinstance(runbooks, list):
        fail("runbooks", "must be an array")
    seen_runbooks: set[str] = set()
    for index, reference in enumerate(runbooks):
        reference = file_ref(reference, f"runbooks[{index}]", root)
        runbook_path = reference["path"]
        if runbook_path in seen_runbooks:
            fail(f"runbooks[{index}].path", "is duplicated")
        seen_runbooks.add(runbook_path)
        if runbook_path in RUNBOOK_REQUIRED_SECTIONS:
            contents = (root / runbook_path).read_text()
            for section in RUNBOOK_REQUIRED_SECTIONS[runbook_path]:
                if section not in contents.splitlines():
                    fail(
                        f"runbooks[{index}]",
                        f"is missing required operational section {section!r}",
                    )
    if seen_runbooks != REQUIRED_RUNBOOKS:
        fail("runbooks", "must bind all six required operational runbooks exactly")

    rehearsal = obj(
        evidence["operations_rehearsal"],
        "operations_rehearsal",
        (
            "status",
            "chain_id",
            "config_sha256",
            "performed_by",
            "reviewed_by",
            "cases",
            "report",
        ),
    )
    if rehearsal["status"] != "passed":
        fail("operations_rehearsal.status", "must equal 'passed'")
    if rehearsal["chain_id"] != config["chain"]["chain_id"]:
        fail("operations_rehearsal.chain_id", "does not match deployment config")
    if rehearsal["config_sha256"] != deploy.config_hash(config):
        fail("operations_rehearsal.config_sha256", "does not match deployment config")
    operator = nonempty(rehearsal["performed_by"], "operations_rehearsal.performed_by")
    rehearsal_reviewer = nonempty(
        rehearsal["reviewed_by"], "operations_rehearsal.reviewed_by"
    )
    if operator == rehearsal_reviewer:
        fail("operations_rehearsal", "operator and reviewer must be distinct")
    rehearsal_cases = rehearsal["cases"]
    if not isinstance(rehearsal_cases, list):
        fail("operations_rehearsal.cases", "must be an array")
    seen_rehearsal_cases: set[str] = set()
    for index, case in enumerate(rehearsal_cases):
        case_path = f"operations_rehearsal.cases[{index}]"
        case = obj(
            case,
            case_path,
            (
                "case",
                "status",
                "transactions",
                "transaction_evidence",
                "assertion_count",
                "evidence",
            ),
        )
        case_name = nonempty(case["case"], f"{case_path}.case")
        if case_name in seen_rehearsal_cases:
            fail(f"{case_path}.case", "is duplicated")
        seen_rehearsal_cases.add(case_name)
        if case["status"] != "passed":
            fail(f"{case_path}.status", "must equal 'passed'")
        transactions = case["transactions"]
        if not isinstance(transactions, list) or not transactions:
            fail(f"{case_path}.transactions", "must be a nonempty array")
        local_transactions: set[str] = set()
        ordered_transactions: list[str] = []
        for tx_index, transaction in enumerate(transactions):
            transaction = tx_hash(
                transaction, f"{case_path}.transactions[{tx_index}]"
            )
            if transaction in local_transactions:
                fail(f"{case_path}.transactions[{tx_index}]", "is duplicated")
            if transaction in all_evidence_transactions:
                fail(
                    f"{case_path}.transactions[{tx_index}]",
                    "is reused by other release evidence",
                )
            local_transactions.add(transaction)
            ordered_transactions.append(transaction)
            all_evidence_transactions.add(transaction)
        captures = case["transaction_evidence"]
        if not isinstance(captures, list) or len(captures) != len(ordered_transactions):
            fail(f"{case_path}.transaction_evidence", "must cover every rehearsal transaction")
        captured_hashes: list[str] = []
        successful = 0
        failed = 0
        for capture_index, (expected_hash, capture) in enumerate(
            zip(ordered_transactions, captures)
        ):
            capture = validate_captured_transaction(
                capture,
                expected_hash,
                allowed_scenario_contracts(config, verification_addresses),
                f"{case_path}.transaction_evidence[{capture_index}]",
            )
            captured_hashes.append(capture["hash"])
            if capture["code"] == 0:
                successful += 1
            else:
                failed += 1
        if captured_hashes != ordered_transactions:
            fail(f"{case_path}.transaction_evidence", "does not match transaction order")
        profile = OPERATIONAL_REHEARSAL_CODE_PROFILES.get(case_name)
        if profile is not None and (
            successful < profile["minimum_successes"]
            or failed < profile["minimum_failures"]
        ):
            fail(
                f"{case_path}.transaction_evidence",
                "does not satisfy the required successful/rejected action profile",
            )
        uint(case["assertion_count"], f"{case_path}.assertion_count", positive=True)
        file_ref(case["evidence"], f"{case_path}.evidence", root)
    if seen_rehearsal_cases != REQUIRED_OPERATIONAL_REHEARSALS:
        fail(
            "operations_rehearsal.cases",
            "must contain exactly the six required operational rehearsals",
        )
    operations_report_ref = file_ref(
        rehearsal["report"], "operations_rehearsal.report", root
    )

    signoff_value = evidence["release_signoff"]
    if (
        not require_release_decision
        and isinstance(signoff_value, dict)
        and set(signoff_value) == {*RELEASE_SIGNOFF_REVIEW_FIELDS, "decision"}
    ):
        signoff_value = {
            field: signoff_value[field] for field in RELEASE_SIGNOFF_REVIEW_FIELDS
        }
    signoff_fields = (
        (*RELEASE_SIGNOFF_REVIEW_FIELDS, "decision")
        if require_release_decision
        else RELEASE_SIGNOFF_REVIEW_FIELDS
    )
    signoff = obj(signoff_value, "release_signoff", signoff_fields)
    if signoff["status"] != "approved_testnet_candidate":
        fail("release_signoff.status", "must equal 'approved_testnet_candidate'")
    if not isinstance(signoff["maintainers"], list) or len(signoff["maintainers"]) < 2:
        fail("release_signoff.maintainers", "must contain at least two maintainers")
    for index, maintainer in enumerate(signoff["maintainers"]):
        nonempty(maintainer, f"release_signoff.maintainers[{index}]")
    if len(set(signoff["maintainers"])) != len(signoff["maintainers"]):
        fail("release_signoff.maintainers", "must contain distinct maintainers")
    security_signer = nonempty(
        signoff["security_reviewer"], "release_signoff.security_reviewer"
    )
    operations_signer = nonempty(
        signoff["operations_reviewer"], "release_signoff.operations_reviewer"
    )
    if operations_signer != rehearsal_reviewer:
        fail(
            "release_signoff.operations_reviewer",
            "must equal the independent operations rehearsal reviewer",
        )
    if security_signer != security["reviewer"]:
        fail(
            "release_signoff.security_reviewer",
            "must equal the independent security review author",
        )
    all_signers = [*signoff["maintainers"], security_signer, operations_signer]
    if len(set(all_signers)) != len(all_signers):
        fail("release_signoff", "maintainer, security, and operations roles must be distinct")
    if not require_release_decision:
        return
    if allowed_signers is None or authorization_principal is None:
        fail(
            "release_signoff.decision.authorization_record",
            "requires explicit authorization trust parameters",
        )
        return
    decision_ref = file_ref(signoff["decision"], "release_signoff.decision", root)
    try:
        decision = json.loads((root / decision_ref["path"]).read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail("release_signoff.decision", f"must be a JSON decision record: {error}")
    decision = obj(
        decision,
        "release_signoff.decision.document",
        (
            "schema_version",
            "status",
            "authorization",
            "production_authorized",
            "chain_id",
            "config_sha256",
            "source",
            "bound_evidence",
            "signers",
            "decided_at",
            "signed_payload_sha256",
            "reviewer_declarations",
            "authorization_record",
        ),
    )
    if decision["schema_version"] != RELEASE_DECISION_SCHEMA:
        fail("release_signoff.decision.schema_version", "is invalid")
    for field, expected in (
        ("status", "approved_testnet_candidate"),
        ("authorization", "testnet_release_candidate_only"),
        ("production_authorized", False),
        ("chain_id", config["chain"]["chain_id"]),
        ("config_sha256", deploy.config_hash(config)),
        ("source", config["source"]),
    ):
        if decision[field] != expected:
            fail(f"release_signoff.decision.{field}", "does not match the release evidence")
    bound_evidence = obj(
        decision["bound_evidence"],
        "release_signoff.decision.bound_evidence",
        RELEASE_DECISION_EVIDENCE_FIELDS,
    )
    expected_evidence_hashes = release_decision_bound_evidence(evidence)
    if bound_evidence != expected_evidence_hashes:
        fail(
            "release_signoff.decision.bound_evidence",
            "does not bind every reviewed release evidence document",
        )
    decision_signers = obj(
        decision["signers"],
        "release_signoff.decision.signers",
        ("maintainers", "security_reviewer", "operations_reviewer"),
    )
    if decision_signers != {
        "maintainers": signoff["maintainers"],
        "security_reviewer": security_signer,
        "operations_reviewer": operations_signer,
    }:
        fail("release_signoff.decision.signers", "does not match the release sign-off roles")
    nonempty(decision["decided_at"], "release_signoff.decision.decided_at")
    signed_payload_sha256 = nonempty(
        decision["signed_payload_sha256"],
        "release_signoff.decision.signed_payload_sha256",
    )
    if not deploy.HEX_64.fullmatch(signed_payload_sha256):
        fail(
            "release_signoff.decision.signed_payload_sha256",
            "must be SHA-256",
        )
    if signed_payload_sha256 != release_decision_payload_sha256(decision):
        fail(
            "release_signoff.decision.signed_payload_sha256",
            "does not match the release decision payload",
        )
    declarations = decision["reviewer_declarations"]
    if not isinstance(declarations, list) or len(declarations) != len(all_signers):
        fail("release_signoff.decision.reviewer_declarations", "must contain one declaration per reviewer")
    observed_identities: set[str] = set()
    for index, declaration in enumerate(declarations):
        declaration_path = f"release_signoff.decision.reviewer_declarations[{index}]"
        declaration = obj(
            declaration,
            declaration_path,
            ("identity", "payload_sha256", "method", "value"),
        )
        identity = nonempty(declaration["identity"], f"{declaration_path}.identity")
        if identity in observed_identities:
            fail(f"{declaration_path}.identity", "is duplicated")
        observed_identities.add(identity)
        if declaration["payload_sha256"] != signed_payload_sha256:
            fail(
                f"{declaration_path}.payload_sha256",
                "does not match the reviewed release decision payload",
            )
        nonempty(declaration["method"], f"{declaration_path}.method")
        nonempty(declaration["value"], f"{declaration_path}.value")
    if observed_identities != set(all_signers):
        fail("release_signoff.decision.reviewer_declarations", "does not cover every release reviewer")
    try:
        release_auth.verify_authorization(
            decision["authorization_record"],
            signed_payload_sha256,
            allowed_signers,
            authorization_principal,
        )
    except release_auth.AuthorizationError as error:
        fail("release_signoff.decision.authorization_record", str(error))


def validate_build_manifest(
    build: dict[str, Any],
    config: dict[str, Any],
    root: Path,
    manifest_path: Path,
) -> None:
    obj(
        build,
        "build_manifest",
        ("schema_version", "source", "builder", "artifacts", "schemas", "build_evidence"),
    )
    if build["schema_version"] != "juno-voice/build-manifest/v1":
        fail("build_manifest.schema_version", "is invalid")
    if build["source"] != config["source"]:
        fail("build_manifest.source", "does not match deployment config")
    builder = obj(
        build["builder"],
        "build_manifest.builder",
        (
            "optimizer_image",
            "juno_voice_rust",
            "dao_contracts_rust",
            "juno_voice_cosmwasm_check",
            "dao_contracts_cosmwasm_check",
            "wasm_tools",
            "recursive_clone_rebuilds",
            "byte_for_byte_repeatable",
        ),
    )
    for field in (
        "optimizer_image",
        "juno_voice_rust",
        "dao_contracts_rust",
        "juno_voice_cosmwasm_check",
        "dao_contracts_cosmwasm_check",
        "wasm_tools",
    ):
        if builder.get(field) != config["builder"][field]:
            fail(f"build_manifest.builder.{field}", "does not match deployment config")
    if builder["recursive_clone_rebuilds"] != 2 or builder["byte_for_byte_repeatable"] is not True:
        fail("build_manifest.builder", "must prove two byte-identical recursive clone builds")
    entries = build["artifacts"]
    if not isinstance(entries, list) or len(entries) != len(deploy.REQUIRED_ARTIFACTS):
        fail("build_manifest.artifacts", "must contain exactly five artifacts")
    expected_names = list(deploy.REQUIRED_ARTIFACTS)
    if [entry.get("name") if isinstance(entry, dict) else None for entry in entries] != expected_names:
        fail("build_manifest.artifacts", "artifact order and names do not match the release set")
    artifact_lines: list[str] = []
    size_lines: list[str] = []
    total_size = 0
    for index, (name, configured) in enumerate(config["artifacts"].items()):
        entry = obj(
            entries[index],
            f"build_manifest.artifacts[{index}]",
            (
                "name",
                "file",
                "sha256",
                "size_bytes",
                "cw2_contract",
                "cw2_version",
                "source_repository",
            ),
        )
        for field in ("sha256", "cw2_contract", "cw2_version"):
            if entry[field] != configured[field]:
                fail(f"build_manifest.artifacts.{name}.{field}", "does not match config")
        expected_file = f"{name}.wasm"
        if entry["file"] != expected_file:
            fail(f"build_manifest.artifacts.{name}.file", f"must equal {expected_file!r}")
        if entry["source_repository"] != BUILD_ARTIFACT_REPOSITORIES[name]:
            fail(
                f"build_manifest.artifacts.{name}.source_repository",
                "does not match source ownership",
            )
        size = uint(entry["size_bytes"], f"build_manifest.artifacts.{name}.size_bytes", positive=True)
        artifact_path = (manifest_path.parent / expected_file).resolve()
        configured_path = (root / configured["path"]).resolve()
        if artifact_path != configured_path or not artifact_path.is_relative_to(root.resolve()):
            fail(
                f"build_manifest.artifacts.{name}.file",
                "does not resolve to the configured repository artifact",
            )
        if not artifact_path.is_file():
            fail(f"build_manifest.artifacts.{name}.file", "artifact file does not exist")
        if artifact_path.stat().st_size != size:
            fail(f"build_manifest.artifacts.{name}.size_bytes", "does not match artifact bytes")
        if deploy.sha256_file(artifact_path) != entry["sha256"]:
            fail(f"build_manifest.artifacts.{name}.sha256", "does not match artifact bytes")
        artifact_lines.append(f"{entry['sha256']}  {expected_file}")
        size_lines.append(f"{size} {expected_file}")
        total_size += size

    schemas = build["schemas"]
    if not isinstance(schemas, list) or len(schemas) != len(deploy.REQUIRED_ARTIFACTS):
        fail("build_manifest.schemas", "must bind exactly five public API schemas")
    if [entry.get("name") if isinstance(entry, dict) else None for entry in schemas] != expected_names:
        fail("build_manifest.schemas", "schema order and names do not match deployed artifacts")
    for index, name in enumerate(expected_names):
        schema = obj(
            schemas[index],
            f"build_manifest.schemas[{index}]",
            ("name", "file", "sha256", "source_repository"),
        )
        expected_file, expected_repository = BUILD_SCHEMAS[name]
        if schema["file"] != expected_file:
            fail(f"build_manifest.schemas[{index}].file", "does not match canonical schema path")
        if schema["source_repository"] != expected_repository:
            fail(f"build_manifest.schemas[{index}].source_repository", "does not match source ownership")
        if not isinstance(schema["sha256"], str) or not deploy.HEX_64.fullmatch(schema["sha256"]):
            fail(f"build_manifest.schemas[{index}].sha256", "must be a SHA-256 digest")
        schema_path = (root / expected_file).resolve()
        if not schema_path.is_relative_to(root.resolve()) or not schema_path.is_file():
            fail(f"build_manifest.schemas[{index}].file", "schema file does not exist")
        if deploy.sha256_file(schema_path) != schema["sha256"]:
            fail(f"build_manifest.schemas[{index}].sha256", "does not match schema bytes")

    build_evidence = obj(
        build["build_evidence"],
        "build_manifest.build_evidence",
        BUILD_EVIDENCE_FILES,
    )
    evidence_paths: dict[str, Path] = {}
    for name, filename in BUILD_EVIDENCE_FILES.items():
        checksum = build_evidence[name]
        if not isinstance(checksum, str) or not deploy.HEX_64.fullmatch(checksum):
            fail(f"build_manifest.build_evidence.{name}", "must be a SHA-256 digest")
        evidence_path = (manifest_path.parent / filename).resolve()
        if not evidence_path.is_relative_to(root.resolve()) or not evidence_path.is_file():
            fail(f"build_manifest.build_evidence.{name}", f"missing {filename}")
        if deploy.sha256_file(evidence_path) != checksum:
            fail(f"build_manifest.build_evidence.{name}", f"does not match {filename}")
        evidence_paths[name] = evidence_path

    expected_provenance = {
        "parent_commit": config["source"]["parent_commit"],
        "dao_contracts_commit": config["source"]["dao_contracts_commit"],
        "optimizer_image": builder["optimizer_image"],
        "juno_voice_rust": builder["juno_voice_rust"],
        "dao_contracts_rust": builder["dao_contracts_rust"],
        "juno_voice_cosmwasm_check": builder["juno_voice_cosmwasm_check"],
        "dao_contracts_cosmwasm_check": builder["dao_contracts_cosmwasm_check"],
        "wasm_tools": builder["wasm_tools"],
        "recursive_clone_rebuilds": "2",
    }
    observed_provenance: dict[str, str] = {}
    for line in evidence_paths["build_provenance_sha256"].read_text().splitlines():
        if line.count("=") != 1:
            fail("build_manifest.build_evidence.build_provenance_sha256", "has malformed lines")
        key, value = line.split("=", 1)
        if not key or key in observed_provenance:
            fail("build_manifest.build_evidence.build_provenance_sha256", "has invalid keys")
        observed_provenance[key] = value
    if observed_provenance != expected_provenance:
        fail("build_manifest.build_evidence.build_provenance_sha256", "has wrong provenance")

    expected_checksums = "\n".join(artifact_lines) + "\n"
    if evidence_paths["checksums_sha256"].read_text() != expected_checksums:
        fail("build_manifest.build_evidence.checksums_sha256", "does not list exact artifacts")
    expected_sizes = "\n".join([*size_lines, f"{total_size} total"]) + "\n"
    normalized_sizes = "\n".join(
        " ".join(line.split())
        for line in evidence_paths["sizes_sha256"].read_text().splitlines()
    ) + "\n"
    if normalized_sizes != expected_sizes:
        fail("build_manifest.build_evidence.sizes_sha256", "does not list exact artifact sizes")
    tools = evidence_paths["build_tools_sha256"].read_text().splitlines()
    expected_tool_prefixes = (
        f"rustc {builder['juno_voice_rust']}",
        f"cargo {builder['juno_voice_rust']}",
        f"rustc {builder['dao_contracts_rust']}",
        f"cargo {builder['dao_contracts_rust']}",
        "wasm-opt ",
    )
    expected_tool_identities = (
        f"wasm-tools {builder['wasm_tools']}",
        f"Contract checking {builder['juno_voice_cosmwasm_check']}",
        f"Contract checking {builder['dao_contracts_cosmwasm_check']}",
    )
    if (
        len(tools) != len(expected_tool_prefixes) + len(expected_tool_identities)
        or any(
            not line.startswith(prefix)
            for line, prefix in zip(tools, expected_tool_prefixes)
        )
        or tuple(tools[len(expected_tool_prefixes) :]) != expected_tool_identities
    ):
        fail("build_manifest.build_evidence.build_tools_sha256", "has wrong tool identities")


def generate_manifest(
    root: Path,
    config_path: Path,
    state_path: Path,
    verification_path: Path,
    build_path: Path,
    evidence_path: Path,
    *,
    allowed_signers: Path,
    authorization_principal: str,
) -> dict[str, Any]:
    config = deploy.load_config(config_path, root)
    state = deploy.load_state(state_path, config)
    if set(state["code_ids"]) != set(deploy.REQUIRED_ARTIFACTS):
        fail("state.code_ids", "deployment is incomplete")
    required_steps = {"instantiate:registry", "instantiate:bounty", "instantiate:program_vault"}
    completed = {
        name for name, record in state["transactions"].items()
        if isinstance(record, dict) and record.get("status") == "complete"
    }
    if not required_steps.issubset(completed):
        fail("state.transactions", "all three instantiate steps must be complete")

    verification = json.loads(verification_path.read_text())
    if verification.get("schema_version") != deploy.VERIFICATION_SCHEMA:
        fail("deployment_verification.schema_version", "is invalid")
    for field, expected in (
        ("config_sha256", deploy.config_hash(config)),
        ("chain_id", config["chain"]["chain_id"]),
        ("source", config["source"]),
        ("code_ids", state["code_ids"]),
        ("addresses", deploy.derive_addresses(config)),
    ):
        if verification.get(field) != expected:
            fail(f"deployment_verification.{field}", "does not match deployment state")
    if state.get("verified", {}).get("sha256") != deploy.sha256_file(verification_path):
        fail("state.verified", "does not bind the supplied verification report")

    build = json.loads(build_path.read_text())
    validate_build_manifest(build, config, root, build_path.resolve())
    evidence = load_evidence(evidence_path)
    validate_evidence(
        evidence,
        root,
        config,
        allowed_signers=allowed_signers,
        authorization_principal=authorization_principal,
    )
    if evidence["build_manifest"]["sha256"] != deploy.sha256_file(build_path):
        fail("evidence.build_manifest", "does not bind the supplied build manifest")
    if evidence["deployment_verification"]["sha256"] != deploy.sha256_file(verification_path):
        fail("evidence.deployment_verification", "does not bind the supplied verification report")

    return {
        "schema_version": MANIFEST_SCHEMA,
        "authorization": "testnet_release_candidate_only",
        "production_authorized": False,
        "config": {
            "path": str(config_path.relative_to(root)),
            "sha256": deploy.sha256_file(config_path),
            "canonical_sha256": deploy.config_hash(config),
        },
        "source": copy.deepcopy(config["source"]),
        "builder": copy.deepcopy(build["builder"]),
        "artifacts": copy.deepcopy(build["artifacts"]),
        "schemas": copy.deepcopy(build["schemas"]),
        "chain": {
            "chain_id": config["chain"]["chain_id"],
            "native_denom": config["chain"]["native_denom"],
            "code_ids": copy.deepcopy(state["code_ids"]),
            "addresses": deploy.derive_addresses(config),
            "code_admin": config["deployment"]["code_admin"],
            "application_governor": deploy.derive_addresses(config)["program_vault"],
            "agent_operations": config["agent_operations"]["core_address"],
            "deployment_transactions": copy.deepcopy(state["transactions"]),
        },
        "deployment_verification": copy.deepcopy(evidence["deployment_verification"]),
        "evidence": {
            "path": str(evidence_path.relative_to(root)),
            "sha256": deploy.sha256_file(evidence_path),
            "upstream_review": copy.deepcopy(evidence["upstream_review"]),
            "security_review": copy.deepcopy(evidence["security_review"]),
            "public_testnet_report": copy.deepcopy(evidence["public_testnet"]["evidence_report"]),
            "gas_report": copy.deepcopy(evidence["gas"]["report"]),
            "canary_report": copy.deepcopy(evidence["canary"]["report"]),
            "operations_rehearsal_report": copy.deepcopy(
                evidence["operations_rehearsal"]["report"]
            ),
            "release_signoff": copy.deepcopy(evidence["release_signoff"]),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    subcommands = parser.add_subparsers(dest="command", required=True)
    validate = subcommands.add_parser("validate-evidence")
    validate.add_argument("--config", type=Path, required=True)
    validate.add_argument("--evidence", type=Path, required=True)
    validate.add_argument("--allowed-signers", type=Path, required=True)
    validate.add_argument("--authorization-principal", required=True)
    generate = subcommands.add_parser("generate")
    generate.add_argument("--config", type=Path, required=True)
    generate.add_argument("--state", type=Path, required=True)
    generate.add_argument("--verification", type=Path, required=True)
    generate.add_argument("--build", type=Path, required=True)
    generate.add_argument("--evidence", type=Path, required=True)
    generate.add_argument("--allowed-signers", type=Path, required=True)
    generate.add_argument("--authorization-principal", required=True)
    generate.add_argument("--output", type=Path, required=True)
    try:
        args = parser.parse_args()
        root = args.root.resolve()
        config = deploy.load_config(args.config.resolve(), root)
        evidence = load_evidence(args.evidence.resolve())
        if args.command == "validate-evidence":
            validate_evidence(
                evidence,
                root,
                config,
                allowed_signers=args.allowed_signers.resolve(),
                authorization_principal=args.authorization_principal,
            )
            print(json.dumps({"valid": True}, sort_keys=True))
        else:
            manifest = generate_manifest(
                root,
                args.config.resolve(),
                args.state.resolve(),
                args.verification.resolve(),
                args.build.resolve(),
                args.evidence.resolve(),
                allowed_signers=args.allowed_signers.resolve(),
                authorization_principal=args.authorization_principal,
            )
            deploy.atomic_write_json(args.output.resolve(), manifest)
            print(json.dumps({"valid": True, "manifest_sha256": deploy.sha256_file(args.output.resolve())}, sort_keys=True))
    except (EvidenceError, deploy.ValidationError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
