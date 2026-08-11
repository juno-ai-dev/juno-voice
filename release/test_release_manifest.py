import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deployment"))
from test_juno_voice_deploy import DeploymentPlannerTests  # noqa: E402

import juno_voice_deploy as deploy  # noqa: E402
import release_manifest as release  # noqa: E402


class ReleaseEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = DeploymentPlannerTests("test_valid_config_and_address_derivation")
        self.fixture.setUp()
        self.root = self.fixture.root
        self.config = self.fixture.config

        def reference(path: str, content: str = "evidence\n"):
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
            return {"path": path, "sha256": deploy.sha256_file(target)}

        self.reference = reference
        for schema_path, _repository in release.BUILD_SCHEMAS.values():
            reference(schema_path, '{"schema":"fixture"}\n')
        artifact_entries = []
        for name, item in self.config["artifacts"].items():
            artifact_path = self.root / item["path"]
            artifact_entries.append(
                {
                    "name": name,
                    "file": f"{name}.wasm",
                    "sha256": item["sha256"],
                    "size_bytes": artifact_path.stat().st_size,
                    "cw2_contract": item["cw2_contract"],
                    "cw2_version": item["cw2_version"],
                    "source_repository": release.BUILD_ARTIFACT_REPOSITORIES[name],
                }
            )
        provenance = reference(
            "artifacts/build-provenance.txt",
            "\n".join(
                (
                    f"parent_commit={self.config['source']['parent_commit']}",
                    f"dao_contracts_commit={self.config['source']['dao_contracts_commit']}",
                    f"optimizer_image={self.config['builder']['optimizer_image']}",
                    f"juno_voice_rust={self.config['builder']['juno_voice_rust']}",
                    f"dao_contracts_rust={self.config['builder']['dao_contracts_rust']}",
                    f"juno_voice_cosmwasm_check={self.config['builder']['juno_voice_cosmwasm_check']}",
                    f"dao_contracts_cosmwasm_check={self.config['builder']['dao_contracts_cosmwasm_check']}",
                    f"wasm_tools={self.config['builder']['wasm_tools']}",
                    "recursive_clone_rebuilds=2",
                )
            )
            + "\n",
        )
        tools = reference(
            "artifacts/build-tools.txt",
            "\n".join(
                (
                    "rustc 1.85.1 (fixture)",
                    "cargo 1.85.1 (fixture)",
                    "rustc 1.81.0 (fixture)",
                    "cargo 1.81.0 (fixture)",
                    "wasm-opt version fixture",
                    "wasm-tools 1.254.0",
                    "Contract checking 3.0.4",
                    "Contract checking 1.5.11",
                )
            )
            + "\n",
        )
        checksums = reference(
            "artifacts/checksums.txt",
            "\n".join(
                f"{entry['sha256']}  {entry['file']}" for entry in artifact_entries
            )
            + "\n",
        )
        sizes = reference(
            "artifacts/sizes.txt",
            "\n".join(
                [
                    *(f"{entry['size_bytes']} {entry['file']}" for entry in artifact_entries),
                    f"{sum(entry['size_bytes'] for entry in artifact_entries)} total",
                ]
            )
            + "\n",
        )
        build_document = {
            "schema_version": "juno-voice/build-manifest/v1",
            "source": self.config["source"],
            "builder": {
                **self.config["builder"],
                "recursive_clone_rebuilds": 2,
                "byte_for_byte_repeatable": True,
            },
            "artifacts": artifact_entries,
            "schemas": [
                {
                    "name": name,
                    "file": release.BUILD_SCHEMAS[name][0],
                    "sha256": deploy.sha256_file(
                        self.root / release.BUILD_SCHEMAS[name][0]
                    ),
                    "source_repository": release.BUILD_SCHEMAS[name][1],
                }
                for name in deploy.REQUIRED_ARTIFACTS
            ],
            "build_evidence": {
                "build_provenance_sha256": provenance["sha256"],
                "build_tools_sha256": tools["sha256"],
                "checksums_sha256": checksums["sha256"],
                "sizes_sha256": sizes["sha256"],
            },
        }
        build = reference(
            "artifacts/build-manifest.json",
            json.dumps(build_document, indent=2, sort_keys=True) + "\n",
        )
        code_ids = {
            name: index for index, name in enumerate(deploy.REQUIRED_ARTIFACTS, start=101)
        }
        addresses = deploy.derive_addresses(self.config)
        messages = deploy.instantiate_messages(self.config, code_ids)
        agent = self.config["agent_operations"]
        xgov = self.config["chain"]["xgov_module_account"]
        deployer = self.config["chain"]["deployer_address"]
        observations = {
            "release_code_checksums": {
                name: self.config["artifacts"][name]["sha256"]
                for name in self.config["artifacts"]
            },
            "contract_info": {
                component: {"code_id": code_ids[artifact], "admin": xgov, "creator": creator}
                for component, artifact, creator in (
                    ("program_vault", "dao_dao_core", deployer),
                    ("bounty", "juno_voice_bounties", deployer),
                    ("registry", "hack_juno_registry_adapter", deployer),
                    ("voting_module", "dao_voting_juno_staked", addresses["program_vault"]),
                    ("gauge", "gauge_orchestrator", addresses["program_vault"]),
                )
            },
            "vault_state": {
                "admin": xgov,
                "voting_module": addresses["voting_module"],
                "proposal_modules": [
                    {"address": addresses["gauge"], "status": "enabled"}
                ],
            },
            "voting_dao": addresses["program_vault"],
            "bounty_config": {
                **messages["bounty"],
                "ratification_seconds": deploy.RATIFICATION_SECONDS,
            },
            "registry_config": {
                **messages["registry"],
                "max_active_projects": deploy.MAX_ACTIVE_PROJECTS,
            },
            "gauge_config": {
                "dao_core": addresses["program_vault"],
                "owner": addresses["program_vault"],
                "voting_powers": addresses["voting_module"],
                "hook_caller": addresses["gauge"],
                "power_source": {
                    "epoch_snapshot": {"guardian": addresses["agent_operations"]}
                },
            },
            "gauge_state": {
                "id": 0,
                **messages["gauge_inner"]["gauges"][0],
            },
            "agent_core_state": {
                "voting_module": agent["voting_module_address"],
                "proposal_modules": [
                    {"address": agent["proposal_module_address"], "status": "enabled"}
                ],
            },
            "agent_voting_group": agent["cw4_group_address"],
            "agent_members": {
                "members": [
                    {"addr": item["address"], "weight": item["weight"]}
                    for item in agent["members"]
                ]
            },
            "agent_members_tail": {"members": []},
            "agent_proposal_config": {
                "dao": agent["core_address"],
                "threshold": {
                    "absolute_count": {"threshold": str(agent["threshold_weight"])}
                },
                "max_voting_period": {"time": agent["voting_duration_seconds"]},
            },
            "agent_code_checksums": {
                "core": agent["core_checksum"],
                "voting": agent["voting_checksum"],
                "proposal": agent["proposal_checksum"],
                "cw4_group": agent["cw4_group_checksum"],
            },
            "agent_contract_info": {
                "core": {"code_id": agent["core_code_id"]},
                "voting": {"code_id": agent["voting_code_id"]},
                "proposal": {"code_id": agent["proposal_code_id"]},
                "cw4_group": {"code_id": agent["cw4_group_code_id"]},
            },
        }
        verification_document = {
            "schema_version": deploy.VERIFICATION_SCHEMA,
            "config_sha256": deploy.config_hash(self.config),
            "chain_id": "uni-7",
            "source": self.config["source"],
            "preflight": {
                "schema_version": deploy.PREFLIGHT_SCHEMA,
                "config_sha256": deploy.config_hash(self.config),
                "chain_id": "uni-7",
                "latest_block_height": 9,
                "catching_up": False,
                "staking_bond_denom": self.config["chain"]["native_denom"],
                "xgov_module_account": self.config["chain"]["xgov_module_account"],
                "checks": [
                    "chain_id",
                    "rpc_synced",
                    "staking_bond_denom",
                    "xgov_module_account",
                ],
            },
            "code_ids": code_ids,
            "addresses": addresses,
            "observations": observations,
            "checks": deploy.expected_verification_checks(self.config, code_ids),
        }
        verification = reference(
            "deployment/verification.json",
            json.dumps(verification_document, indent=2, sort_keys=True) + "\n",
        )
        upstream_attestation_document = {
            "schema_version": "juno-voice/upstream-attestation/v1",
            "status": "accepted",
            "repository": "https://github.com/juno-ai-dev/dao-contracts",
            "commit": self.config["source"]["dao_contracts_commit"],
            "review_url": "https://github.com/juno-ai-dev/dao-contracts/pull/1",
            "accepted_by": "upstream-maintainer",
            "accepted_at": "2026-08-05T00:00:00Z",
            "signature": {"method": "fixture", "value": "fixture-signature"},
        }
        upstream_attestation = reference(
            "evidence/upstream-attestation.json",
            json.dumps(upstream_attestation_document, indent=2, sort_keys=True)
            + "\n",
        )
        audit = reference("evidence/audit.pdf", "independent audit\n")
        attestation_document = {
            "schema_version": "juno-voice/security-attestation/v1",
            "status": "passed",
            "reviewer": "independent-reviewer",
            "scope_parent_commit": self.config["source"]["parent_commit"],
            "scope_dao_contracts_commit": self.config["source"][
                "dao_contracts_commit"
            ],
            "report_sha256": audit["sha256"],
            "open_critical": 0,
            "open_high": 0,
            "lower_finding_ids": ["LOW-1"],
            "signed_at": "2026-08-05T00:00:00Z",
            "signature": {"method": "fixture", "value": "fixture-signature"},
        }
        attestation = reference(
            "evidence/audit-attestation.json",
            json.dumps(attestation_document, indent=2, sort_keys=True) + "\n",
        )
        snapshot_report = reference("evidence/snapshot.json", "{}\n")
        testnet_report = reference("evidence/uni7.json", "{}\n")
        gas_report = reference("evidence/gas.json", "{}\n")
        canary_report = reference("evidence/canary.json", "{}\n")
        governance_document = {
            "schema_version": "juno-voice/canary-decision/v1",
            "status": "accepted",
            "authorization": "testnet_canary_complete_only",
            "production_authorized": False,
            "chain_id": "uni-7",
            "config_sha256": deploy.config_hash(self.config),
            "source": self.config["source"],
            "epochs": [1, 2],
            "transactions": [f"{301:064X}", f"{302:064X}"],
            "maximum_total_value": 2,
            "larger_recurring_tranche_authorized": False,
            "decided_by": "canary-governance-reviewer",
            "decided_at": "2026-08-05T00:00:00Z",
            "signature": {"method": "fixture", "value": "fixture-signature"},
        }
        governance = reference(
            "evidence/canary-decision.json",
            json.dumps(governance_document, indent=2, sort_keys=True) + "\n",
        )
        operations_report = reference("evidence/operations-rehearsal.json", "{}\n")
        release_signers = [
            "maintainer-one",
            "maintainer-two",
            "independent-reviewer",
            "operations-reviewer",
        ]
        decision_document = {
            "schema_version": release.RELEASE_DECISION_SCHEMA,
            "status": "approved_testnet_candidate",
            "authorization": "testnet_release_candidate_only",
            "production_authorized": False,
            "chain_id": "uni-7",
            "config_sha256": deploy.config_hash(self.config),
            "source": self.config["source"],
            "bound_evidence": {
                "build_manifest_sha256": build["sha256"],
                "deployment_verification_sha256": verification["sha256"],
                "upstream_attestation_sha256": upstream_attestation["sha256"],
                "security_attestation_sha256": attestation["sha256"],
                "public_testnet_report_sha256": testnet_report["sha256"],
                "gas_report_sha256": gas_report["sha256"],
                "canary_report_sha256": canary_report["sha256"],
                "canary_governance_decision_sha256": governance["sha256"],
                "operations_rehearsal_report_sha256": operations_report["sha256"],
                "reviewed_evidence_sha256": "00" * 32,
            },
            "signers": {
                "maintainers": ["maintainer-one", "maintainer-two"],
                "security_reviewer": "independent-reviewer",
                "operations_reviewer": "operations-reviewer",
            },
            "decided_at": "2026-08-05T00:00:00Z",
            "signed_payload_sha256": "00" * 32,
            "signatures": [
                {
                    "identity": identity,
                    "payload_sha256": "00" * 32,
                    "method": "fixture",
                    "value": f"fixture-signature-{index}",
                }
                for index, identity in enumerate(release_signers, start=1)
            ],
        }
        decision = reference(
            "evidence/release-decision.json",
            json.dumps(decision_document, indent=2, sort_keys=True) + "\n",
        )
        runbooks = [
            reference(path, (ROOT / path).read_text())
            for path in sorted(release.REQUIRED_RUNBOOKS)
        ]
        code_checksums = {
            name: item["sha256"] for name, item in self.config["artifacts"].items()
        }
        scenario_entries = []
        for scenario_index, scenario in enumerate(sorted(release.REQUIRED_SCENARIOS), start=1):
            scenario_tx = f"{scenario_index:064X}"

            event_assertion_name = next(
                (
                    name
                    for name, predicate in release.REQUIRED_SCENARIO_ASSERTIONS[
                        scenario
                    ].items()
                    if predicate == "transaction_event_equals"
                ),
                None,
            )

            def scenario_event():
                if event_assertion_name is not None:
                    requirement = release.TRANSACTION_EVENT_PROOFS[
                        event_assertion_name
                    ]
                    fixed = requirement["fixed_attributes"]
                    attributes = []
                    for key in requirement["required_keys"]:
                        if key == "_contract_address":
                            value = addresses[requirement["contract"]]
                        elif key in fixed:
                            value = fixed[key]
                        elif key == "registry":
                            value = addresses["registry"]
                        else:
                            value = f"fixture-{key}"
                        attributes.append({"key": key, "value": value})
                    return {
                        "type": requirement["event_type"],
                        "attributes": attributes,
                    }
                if scenario == "moderate_expire_pull_refunds":
                    return {
                        "type": release.MATCHING_EVENT_PROOFS["refund_events"][
                            "event_type"
                        ],
                        "attributes": [
                            {
                                "key": "_contract_address",
                                "value": addresses["bounty"],
                            },
                            {"key": "bounty_id", "value": "1"},
                            {"key": "contributor", "value": addresses["bounty"]},
                            {"key": "amount", "value": "1"},
                            {"key": "fully_refunded", "value": "true"},
                        ],
                    }
                return {
                    "type": "wasm",
                    "attributes": [
                        {
                            "key": "_contract_address",
                            "value": addresses["bounty"],
                        }
                    ],
                }

            def transaction_record(transaction_hash: str, code: int):
                response = {
                    "txhash": transaction_hash,
                    "height": "10",
                    "code": code,
                    "gas_wanted": "500000",
                    "gas_used": "400000",
                    "events": [scenario_event()],
                    "tx": {
                        "body": {
                            "messages": [
                                {
                                    "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
                                    "contract": addresses["bounty"],
                                }
                            ]
                        }
                    },
                }
                return {
                    "hash": transaction_hash,
                    "height": 10,
                    "code": code,
                    "gas_wanted": 500_000,
                    "gas_used": 400_000,
                    "response_sha256": deploy.sha256_bytes(
                        deploy.canonical_json(response)
                    ),
                    "response": response,
                    "messages": response["tx"]["body"]["messages"],
                    "events": response["events"],
                }

            transaction_records = [transaction_record(scenario_tx, 0)]
            scenario_transactions = [scenario_tx]
            if scenario == "guardian_stop_governor_recovery":
                failed_tx = f"{1000 + scenario_index:064X}"
                scenario_transactions.append(failed_tx)
                transaction_records.append(transaction_record(failed_tx, 5))

            required_assertions = release.REQUIRED_SCENARIO_ASSERTIONS[scenario]

            def query_fixture(name: str):
                contract_name, query_name, semantics = release.QUERY_PROOFS[name]
                voter = self.config["chain"]["deployer_address"]
                second_voter = addresses["agent_operations"]
                project_id = "fixture-project"
                query_payloads = {
                    "bounty": {"bounty_id": 1},
                    "receipts": {
                        "bounty_id": 1,
                        "round": 1,
                        "start_after": None,
                        "limit": 100,
                    },
                    "round": {
                        "bounty_id": 1,
                        "round": 2 if name == "later_round_paid_state" else 1,
                    },
                    "receipt": {"bounty_id": 1, "round": 1, "voter": voter},
                    "project": {"project_id": project_id},
                    "accounting": {},
                    "epoch": {
                        "gauge": 0,
                        "epoch": 2
                        if name in ("second_epoch_state",)
                        else 1,
                    },
                    "epoch_ballot": {
                        "gauge": 0,
                        "epoch": 2
                        if name in ("second_ballot_state",)
                        else 1,
                        "voter": voter,
                    },
                    "gauge": {"id": 0},
                    "config": {},
                    "list_epochs": {"gauge": 0, "start_after": None, "limit": 2},
                }

                def epoch_response(epoch_id: int, height: int, outcome):
                    return {
                        "gauge_id": 0,
                        "epoch_id": epoch_id,
                        "snapshot_height": height,
                        "snapshot_total_power": "100",
                        "participating_power": "60",
                        "total_cast": "60",
                        "min_turnout_bps": 5_000,
                        "epoch_budget": "1000",
                        "denom": "ujuno",
                        "outcome": outcome,
                    }

                if semantics in ("paid_bounty", "refunding_bounty"):
                    paid = semantics == "paid_bounty"
                    response = {
                        "bounty": {
                            "id": 1,
                            "status": "paid" if paid else "refunding",
                            "total_contribution": "100",
                            "paid_amount": "100" if paid else "0",
                            "refunded_amount": "0",
                            "paid_recipient": voter if paid else None,
                        }
                    }
                elif semantics == "multiple_receipts":
                    response = {
                        "receipts": [
                            {
                                "bounty_id": 1,
                                "round": 1,
                                "voter": voter,
                                "weight": "60",
                            },
                            {
                                "bounty_id": 1,
                                "round": 1,
                                "voter": second_voter,
                                "weight": "40",
                            },
                        ]
                    }
                elif semantics in ("reset_round", "paid_round"):
                    response = {
                        "bounty_id": 1,
                        "number": query_payloads["round"]["round"],
                        "outcome": "no_majority"
                        if semantics == "reset_round"
                        else "paid",
                        "finalized_at": "1",
                    }
                elif semantics == "old_receipt":
                    response = {
                        "bounty_id": 1,
                        "round": 1,
                        "voter": voter,
                        "weight": "60",
                    }
                elif semantics in (
                    "graduated_project",
                    "pending_bonded_project",
                    "approved_bonded_project",
                    "suspended_project",
                ):
                    if semantics == "graduated_project":
                        provenance = {"graduated_bounty": {"source_bounty_id": 1}}
                        bond = None
                        status = "active"
                    else:
                        provenance = {"bonded_registration": {"applicant": voter}}
                        bond = {"amount": "100", "state": "deposited"}
                        status = {
                            "pending_bonded_project": "pending",
                            "approved_bonded_project": "active",
                            "suspended_project": "suspended",
                        }[semantics]
                    response = {
                        "id": project_id,
                        "status": status,
                        "provenance": provenance,
                        "bond": bond,
                    }
                elif semantics == "held_bond_accounting":
                    response = {
                        "bond_liability": "100",
                        "lifetime_bonds_received": "100",
                    }
                elif semantics in (
                    "distributed_epoch",
                    "failed_turnout_epoch",
                    "no_eligible_epoch",
                ):
                    epoch_id = query_payloads["epoch"]["epoch"]
                    if semantics == "distributed_epoch":
                        outcome = {"distributed": {"message_count": 1}}
                    elif semantics == "failed_turnout_epoch":
                        outcome = "no_distribution_turnout"
                    else:
                        outcome = "no_eligible_options"
                    response = epoch_response(epoch_id, 100 + epoch_id, outcome)
                    if semantics == "failed_turnout_epoch":
                        response["participating_power"] = "49"
                elif semantics == "epoch_ballot":
                    response = {
                        "ballot": {
                            "voter": voter,
                            "power": "60",
                            "votes": [{"option": "project-a", "weight": "1"}],
                            "receipt_index": 1,
                        }
                    }
                elif semantics in ("stopped_gauge", "resumed_gauge"):
                    response = {
                        "id": 0,
                        "is_stopped": semantics == "stopped_gauge",
                        "snapshot_policy": {"denom": "ujuno"},
                    }
                elif semantics == "snapshot_authorities":
                    response = {
                        "owner": addresses["program_vault"],
                        "dao_core": addresses["program_vault"],
                        "power_source": {
                            "epoch_snapshot": {
                                "guardian": addresses["agent_operations"]
                            }
                        },
                    }
                else:
                    response = {
                        "epochs": [
                            epoch_response(
                                1, 101, {"distributed": {"message_count": 1}}
                            ),
                            epoch_response(
                                2, 102, {"distributed": {"message_count": 1}}
                            ),
                        ]
                    }
                return (
                    addresses[contract_name],
                    {query_name: query_payloads[query_name]},
                    response,
                )

            query_names = [
                name
                for name, predicate in required_assertions.items()
                if predicate == "query_response_equals"
            ]
            queries = []
            for query_index, name in enumerate(query_names):
                contract, query_message, response = query_fixture(name)
                queries.append(
                    {
                        "height": 10 + query_index,
                        "contract": contract,
                        "query": query_message,
                        "response": response,
                        "response_sha256": deploy.sha256_bytes(
                            deploy.canonical_json(response)
                        ),
                    }
                )

            balance_names = [
                name
                for name, predicate in required_assertions.items()
                if predicate == "balance_delta_equals"
            ]
            balances = []
            for name in balance_names:
                after_amount = (
                    "11" if name in release.POSITIVE_BALANCE_ASSERTIONS else "10"
                )
                balances.extend(
                    [
                        {
                            "label": f"{name}-before",
                            "height": 9,
                            "address": self.config["chain"]["deployer_address"],
                            "denom": "ujuno",
                            "amount": "10",
                        },
                        {
                            "label": f"{name}-after",
                            "height": 10,
                            "address": self.config["chain"]["deployer_address"],
                            "denom": "ujuno",
                            "amount": after_amount,
                        },
                    ]
                )
            if not balances:
                balances = [
                    {
                        "label": label,
                        "height": height,
                        "address": self.config["chain"]["deployer_address"],
                        "denom": "ujuno",
                        "amount": amount,
                    }
                    for label, height, amount in (
                        ("context-before", 9, "10"),
                        ("context-after", 10, "10"),
                    )
                ]
            transcript = {
                "schema_version": "juno-voice/uni7-scenario-transcript/v1",
                "scenario_id": scenario,
                "chain_id": "uni-7",
                "config_sha256": deploy.config_hash(self.config),
                "code_checksums": code_checksums,
                "code_ids": code_ids,
                "addresses": addresses,
                "mock_components": [],
                "transactions": scenario_transactions,
                "transaction_evidence": transaction_records,
                "queries": queries or [
                    {
                        "height": 10,
                        "contract": self.config["agent_operations"]["core_address"],
                        "query": {"fixture_context": {}},
                        "response": {"context": True},
                        "response_sha256": deploy.sha256_bytes(
                            deploy.canonical_json({"context": True})
                        ),
                    }
                ],
                "balances": balances,
                "assertions": [],
                "passed": True,
            }
            query_index = 0
            balance_index = 0
            for name, predicate in required_assertions.items():
                if predicate == "query_response_equals":
                    source = {"query_index": query_index}
                    query_index += 1
                elif predicate == "balance_delta_equals":
                    source = {
                        "before_index": balance_index * 2,
                        "after_index": balance_index * 2 + 1,
                    }
                    balance_index += 1
                elif predicate == "transaction_event_equals":
                    source = {"transaction_hash": scenario_tx, "event_index": 0}
                elif predicate == "matching_events_equal":
                    if name == "refund_events":
                        event_type = release.MATCHING_EVENT_PROOFS[name]["event_type"]
                        attributes = {"_contract_address": addresses["bounty"]}
                    else:
                        requirement = release.EMPTY_TRANSFER_EVENT_PROOFS[name]
                        event_type = "transfer"
                        attributes = {
                            requirement["address_attribute"]: self.config["chain"][
                                "deployer_address"
                            ]
                        }
                    source = {
                        "transaction_hashes": [scenario_tx],
                        "event_type": event_type,
                        "attributes": attributes,
                    }
                else:
                    source = {"transaction_hash": scenario_transactions[1]}
                actual = release.resolve_assertion_actual(
                    transcript, predicate, source, f"fixture.{scenario}.{name}"
                )
                transcript["assertions"].append(
                    {
                        "name": name,
                        "predicate": predicate,
                        "source": source,
                        "expected": copy.deepcopy(actual),
                        "actual": copy.deepcopy(actual),
                        "passed": True,
                    }
                )
            report = reference(
                f"evidence/scenarios/{scenario}.json",
                json.dumps(transcript, indent=2, sort_keys=True) + "\n",
            )
            scenario_entries.append(
                {
                    "id": scenario,
                    "status": "passed",
                    "transactions": scenario_transactions,
                    "assertion_count": len(required_assertions),
                    "evidence": report,
                }
            )

        def historical_power_query(
            name: str, observed_at_height: int, height: int, power: str
        ):
            is_voter = "voter" in name
            variant = (
                "voting_power_at_height" if is_voter else "total_power_at_height"
            )
            payload = {"height": height}
            if is_voter:
                payload["address"] = self.config["chain"]["deployer_address"]
            response = {"power": power, "height": height}
            return {
                "name": name,
                "observed_at_height": observed_at_height,
                "contract": addresses["voting_module"],
                "query": {variant: payload},
                "response": response,
                "response_sha256": deploy.sha256_bytes(
                    deploy.canonical_json(response)
                ),
            }

        voter_raw = deploy.decode_address(
            self.config["chain"]["deployer_address"],
            self.config["chain"]["bech32_prefix"],
        )
        validator_address = deploy.encode_address(
            voter_raw, f"{self.config['chain']['bech32_prefix']}valoper"
        )

        def staking_change(kind: str, index: int, height: int, amount: str):
            transaction_hash = f"{100 + index:064X}"
            message_type = {
                "delegate": "/cosmos.staking.v1beta1.MsgDelegate",
                "undelegate": "/cosmos.staking.v1beta1.MsgUndelegate",
            }[kind]
            message = {
                "@type": message_type,
                "delegator_address": self.config["chain"]["deployer_address"],
                "validator_address": validator_address,
                "amount": {
                    "denom": self.config["chain"]["native_denom"],
                    "amount": amount,
                },
            }
            event = {
                "type": "message",
                "attributes": [{"key": "action", "value": kind}],
            }
            response = {
                "txhash": transaction_hash,
                "height": str(height),
                "code": 0,
                "gas_wanted": "200000",
                "gas_used": "100000",
                "events": [event],
                "tx": {"body": {"messages": [message]}},
            }
            capture = {
                "hash": transaction_hash,
                "height": height,
                "code": 0,
                "gas_wanted": 200_000,
                "gas_used": 100_000,
                "response_sha256": deploy.sha256_bytes(
                    deploy.canonical_json(response)
                ),
                "response": response,
                "messages": [message],
                "events": [event],
            }
            return {
                "hash": transaction_hash,
                "height": height,
                "kind": kind,
                "transaction_evidence": capture,
            }

        retention_observation_height = max(
            17,
            10 + self.config["tranche"]["snapshot_retention_blocks"],
        )

        gas_maxima = {
            "bounty_max_contributors": self.config["bounty"]["max_contributors"],
            "registry_max_projects": 99,
            "gauge_max_options": 100,
            "adapter_max_messages": self.config["registry"]["max_selected_projects"],
            "query_max_pagination": 100,
            "bounty_max_history": self.config["bounty"]["limits"]["max_page_limit"],
            "gauge_max_cleanup_batch": 100,
        }

        def gas_measurement(case: str, index: int):
            configured_max = gas_maxima[case]
            profile = release.GAS_CASE_PROFILES[case]
            operation = profile["operation"]
            if case == "bounty_max_contributors":
                payload = {"bounty_id": 1, "start_after": None, "limit": configured_max}
            elif case == "registry_max_projects":
                payload = {"start_after": None, "limit": configured_max}
            elif case == "gauge_max_options":
                payload = {
                    "gauge": 0,
                    "epoch": 1,
                    "start_after": None,
                    "limit": configured_max,
                }
            elif case == "adapter_max_messages":
                payload = {
                    "selected": [
                        [f"project-{item:03}", "0.01"]
                        for item in range(configured_max)
                    ],
                    "epoch_budget": "1000",
                    "available_balance": "1000",
                    "denom": self.config["chain"]["native_denom"],
                }
            elif case == "query_max_pagination":
                payload = {"start_after": None, "limit": configured_max}
            elif case == "bounty_max_history":
                payload = {"bounty_id": 1, "start_after": None, "limit": configured_max}
            else:
                payload = {"gauge": 0, "epoch": 1, "limit": configured_max}

            transaction_hash = f"{200 + index:064X}"
            height = 30 + index
            gas_limit = 1_000_000
            gas_used = 500_000
            collection_name = profile["response_collection"]
            if collection_name is not None:
                if case == "adapter_max_messages":
                    collection = [
                        {
                            "bank": {
                                "send": {
                                    "to_address": self.config["chain"]["deployer_address"],
                                    "amount": [
                                        {
                                            "denom": self.config["chain"]["native_denom"],
                                            "amount": "1",
                                        }
                                    ],
                                }
                            }
                        }
                        for _ in range(configured_max)
                    ]
                else:
                    collection = [{"fixture_index": item} for item in range(configured_max)]
                response = {collection_name: collection}
            else:
                response = {
                    "txhash": transaction_hash,
                    "height": str(height),
                    "code": 0,
                    "gas_wanted": str(gas_limit),
                    "gas_used": str(gas_used),
                    "events": [
                        {
                            "type": "wasm",
                            "attributes": [
                                {
                                    "key": "_contract_address",
                                    "value": addresses["gauge"],
                                },
                                {"key": "action", "value": "cleanup_snapshot_epoch"},
                                {"key": "processed", "value": str(configured_max)},
                            ],
                        }
                    ],
                }
            response_bytes = deploy.canonical_json(response)
            return {
                "case": case,
                "configured_max": configured_max,
                "measurement_kind": profile["kind"],
                "height": height,
                "contract": addresses[profile["contract"]],
                "operation": operation,
                "request": {operation: payload},
                "gas_limit": gas_limit,
                "gas_used": gas_used,
                "response_bytes": len(response_bytes),
                "response": response,
                "response_sha256": deploy.sha256_bytes(response_bytes),
                "transaction": transaction_hash,
            }

        def canary_epoch(epoch: int):
            transaction_hash = f"{300 + epoch:064X}"
            snapshot_height = epoch * 10
            execution_height = 40 + epoch
            distribution_event = {
                "type": "wasm",
                "attributes": [
                    {"key": "_contract_address", "value": addresses["gauge"]},
                    {"key": "action", "value": "execute_snapshot_epoch"},
                    {
                        "key": "sender",
                        "value": self.config["chain"]["deployer_address"],
                    },
                    {"key": "gauge_id", "value": "0"},
                    {"key": "epoch_id", "value": str(epoch)},
                    {"key": "snapshot_height", "value": str(snapshot_height)},
                    {"key": "snapshot_total_power", "value": "100"},
                    {"key": "participating_power", "value": "60"},
                    {"key": "total_cast", "value": "60"},
                    {"key": "min_turnout_bps", "value": "5000"},
                    {
                        "key": "epoch_budget",
                        "value": str(self.config["gauge"]["epoch_budget"]),
                    },
                    {
                        "key": "denom",
                        "value": self.config["chain"]["native_denom"],
                    },
                    {"key": "outcome", "value": "distributed"},
                    {"key": "message_count", "value": "1"},
                ],
            }
            transfer_event = {
                "type": "transfer",
                "attributes": [
                    {"key": "sender", "value": addresses["program_vault"]},
                    {
                        "key": "recipient",
                        "value": self.config["chain"]["deployer_address"],
                    },
                    {
                        "key": "amount",
                        "value": f"1{self.config['chain']['native_denom']}",
                    },
                ],
            }
            messages = [
                {
                    "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
                    "contract": addresses["gauge"],
                }
            ]
            transaction_response = {
                "txhash": transaction_hash,
                "height": str(execution_height),
                "code": 0,
                "gas_wanted": "500000",
                "gas_used": "400000",
                "events": [distribution_event, transfer_event],
                "tx": {"body": {"messages": messages}},
            }
            transaction_capture = {
                "hash": transaction_hash,
                "height": execution_height,
                "code": 0,
                "gas_wanted": 500_000,
                "gas_used": 400_000,
                "response_sha256": deploy.sha256_bytes(
                    deploy.canonical_json(transaction_response)
                ),
                "response": transaction_response,
                "messages": messages,
                "events": transaction_response["events"],
            }
            epoch_response = {
                "gauge_id": 0,
                "epoch_id": epoch,
                "snapshot_height": snapshot_height,
                "snapshot_total_power": "100",
                "participating_power": "60",
                "total_cast": "60",
                "min_turnout_bps": 5_000,
                "epoch_budget": str(self.config["gauge"]["epoch_budget"]),
                "denom": self.config["chain"]["native_denom"],
                "opens_at": 1,
                "closes_at": 2,
                "voter_count": 1,
                "option_count": 1,
                "outcome": {"distributed": {"message_count": 1}},
                "cleanup": {"phase": "ballots", "cursor": 0, "complete": False},
            }
            return {
                "epoch": epoch,
                "snapshot_height": snapshot_height,
                "outcome": "distributed",
                "distributed_value": 1,
                "transaction": transaction_hash,
                "transaction_evidence": transaction_capture,
                "epoch_query": {
                    "observed_at_height": execution_height,
                    "contract": addresses["gauge"],
                    "query": {"epoch": {"gauge": 0, "epoch": epoch}},
                    "response": epoch_response,
                    "response_sha256": deploy.sha256_bytes(
                        deploy.canonical_json(epoch_response)
                    ),
                },
            }

        operational_codes = {
            "pause_new_activity": [0, 5],
            "failed_epoch": [0],
            "adapter_failure": [5],
            "governor_recovery": [5, 0],
            "refund_and_expiry": [0, 0, 0],
            "unused_funds_recovery": [0],
        }
        operational_targets = {
            "pause_new_activity": "bounty",
            "failed_epoch": "gauge",
            "adapter_failure": "gauge",
            "governor_recovery": "gauge",
            "refund_and_expiry": "bounty",
            "unused_funds_recovery": "program_vault",
        }

        def operational_case(case: str, case_index: int):
            transactions = []
            captures = []
            for action_index, code in enumerate(operational_codes[case], start=1):
                transaction_hash = f"{5000 + case_index * 10 + action_index:064X}"
                height = 1000 + case_index * 10 + action_index
                message = {
                    "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
                    "contract": addresses[operational_targets[case]],
                }
                event = {
                    "type": "message",
                    "attributes": [
                        {"key": "action", "value": f"{case}-{action_index}"}
                    ],
                }
                response = {
                    "txhash": transaction_hash,
                    "height": str(height),
                    "code": code,
                    "gas_wanted": "300000",
                    "gas_used": "200000",
                    "events": [event],
                    "tx": {"body": {"messages": [message]}},
                }
                transactions.append(transaction_hash)
                captures.append(
                    {
                        "hash": transaction_hash,
                        "height": height,
                        "code": code,
                        "gas_wanted": 300_000,
                        "gas_used": 200_000,
                        "response_sha256": deploy.sha256_bytes(
                            deploy.canonical_json(response)
                        ),
                        "response": response,
                        "messages": [message],
                        "events": [event],
                    }
                )
            report_document = {
                "schema_version": "juno-voice/operations-rehearsal-case/v1",
                "case": case,
                "chain_id": "uni-7",
                "config_sha256": deploy.config_hash(self.config),
                "transactions": transactions,
                "passed": True,
            }
            return {
                "case": case,
                "status": "passed",
                "transactions": transactions,
                "transaction_evidence": captures,
                "assertion_count": len(captures),
                "evidence": reference(
                    f"evidence/operations/{case}.json",
                    json.dumps(report_document, indent=2, sort_keys=True) + "\n",
                ),
            }

        self.evidence = {
            "schema_version": release.EVIDENCE_SCHEMA,
            "build_manifest": build,
            "deployment_verification": verification,
            "upstream_review": {
                "status": "accepted",
                "repository": "https://github.com/juno-ai-dev/dao-contracts",
                "commit": self.config["source"]["dao_contracts_commit"],
                "review_url": "https://github.com/juno-ai-dev/dao-contracts/pull/1",
                "accepted_by": "upstream-maintainer",
                "attestation": upstream_attestation,
            },
            "security_review": {
                "status": "passed",
                "reviewer": "independent-reviewer",
                "scope_parent_commit": self.config["source"]["parent_commit"],
                "scope_dao_contracts_commit": self.config["source"]["dao_contracts_commit"],
                "report": audit,
                "attestation": attestation,
                "open_critical": 0,
                "open_high": 0,
                "lower_findings": [
                    {
                        "id": "LOW-1",
                        "severity": "low",
                        "disposition": "accepted",
                        "rationale": "Documented operational tradeoff",
                    }
                ],
            },
            "public_testnet": {
                "chain_id": "uni-7",
                "config_sha256": deploy.config_hash(self.config),
                "code_checksums": code_checksums,
                "scenarios": scenario_entries,
                "snapshot": {
                    "module_activation_height": 1,
                    "export_boundary": "EndBlock",
                    "observed_retention_blocks": self.config["tranche"]["snapshot_retention_blocks"],
                    "required_retention_blocks": self.config["tranche"]["snapshot_retention_blocks"],
                    "liquid_staking_allowlist": [],
                    "power_basis": "native bonded Juno stake at the exported snapshot height",
                    "stake_change_transactions": [
                        staking_change("delegate", 1, 15, "11"),
                        staking_change("undelegate", 2, 16, "1"),
                    ],
                    "voter_address": self.config["chain"]["deployer_address"],
                    "first_epoch_height": 10,
                    "second_epoch_height": 20,
                    "historical_power_queries": [
                        historical_power_query(
                            "first_voter_before_change", 12, 10, "10"
                        ),
                        historical_power_query(
                            "first_total_before_change", 12, 10, "100"
                        ),
                        historical_power_query(
                            "first_voter_after_change",
                            retention_observation_height,
                            10,
                            "10",
                        ),
                        historical_power_query(
                            "first_total_after_change",
                            retention_observation_height,
                            10,
                            "100",
                        ),
                        historical_power_query(
                            "second_voter_after_change",
                            retention_observation_height,
                            20,
                            "20",
                        ),
                        historical_power_query(
                            "second_total_after_change",
                            retention_observation_height,
                            20,
                            "110",
                        ),
                    ],
                    "evidence": snapshot_report,
                },
                "evidence_report": testnet_report,
            },
            "gas": {
                "safety_margin_bps": 2000,
                "measurements": [
                    gas_measurement(case, index)
                    for index, case in enumerate(sorted(release.REQUIRED_GAS_CASES), start=1)
                ],
                "report": gas_report,
            },
            "canary": {
                "status": "passed",
                "epochs": [canary_epoch(epoch) for epoch in (1, 2)],
                "maximum_total_value": 2,
                "report": canary_report,
                "governance_decision": governance,
            },
            "runbooks": runbooks,
            "operations_rehearsal": {
                "status": "passed",
                "chain_id": "uni-7",
                "config_sha256": deploy.config_hash(self.config),
                "performed_by": "testnet-operator",
                "reviewed_by": "operations-reviewer",
                "cases": [
                    operational_case(case, index)
                    for index, case in enumerate(
                        sorted(release.REQUIRED_OPERATIONAL_REHEARSALS), start=1
                    )
                ],
                "report": operations_report,
            },
            "release_signoff": {
                "status": "approved_testnet_candidate",
                "maintainers": ["maintainer-one", "maintainer-two"],
                "security_reviewer": "independent-reviewer",
                "operations_reviewer": "operations-reviewer",
                "decision": decision,
            },
        }

        gas_report_payload = {
            "schema_version": release.GAS_REPORT_SCHEMA,
            "status": "passed",
            "chain_id": self.config["chain"]["chain_id"],
            "config_sha256": deploy.config_hash(self.config),
            "source": self.config["source"],
            "safety_margin_bps": self.evidence["gas"]["safety_margin_bps"],
            "measurements_sha256": deploy.sha256_bytes(
                deploy.canonical_json(self.evidence["gas"]["measurements"])
            ),
            "measurement_cases": sorted(release.REQUIRED_GAS_CASES),
            "measured_by": "testnet-gas-operator",
            "reviewed_by": "independent-gas-reviewer",
            "measured_at": "2026-08-05T00:00:00Z",
            "reviewed_at": "2026-08-05T01:00:00Z",
            "methodology": "target-chain configured-maximum measurements",
        }
        gas_payload_sha256 = release.gas_report_payload_sha256(gas_report_payload)
        gas_report_document = {
            **gas_report_payload,
            "signed_payload_sha256": gas_payload_sha256,
            "signatures": [
                {
                    "identity": identity,
                    "payload_sha256": gas_payload_sha256,
                    "method": "fixture",
                    "value": f"fixture-{identity}-signature",
                }
                for identity in (
                    gas_report_payload["measured_by"],
                    gas_report_payload["reviewed_by"],
                )
            ],
        }
        gas_report_path = self.root / gas_report["path"]
        gas_report_path.write_text(
            json.dumps(gas_report_document, indent=2, sort_keys=True) + "\n"
        )
        gas_report["sha256"] = deploy.sha256_file(gas_report_path)
        decision_document["bound_evidence"] = (
            release.release_decision_bound_evidence(self.evidence)
        )
        decision_payload_sha256 = release.release_decision_payload_sha256(
            decision_document
        )
        decision_document["signed_payload_sha256"] = decision_payload_sha256
        for signature in decision_document["signatures"]:
            signature["payload_sha256"] = decision_payload_sha256
        decision_path = self.root / decision["path"]
        decision_path.write_text(
            json.dumps(decision_document, indent=2, sort_keys=True) + "\n"
        )
        decision["sha256"] = deploy.sha256_file(decision_path)

    def tearDown(self):
        self.fixture.tearDown()

    def resign_release_decision(self, evidence):
        decision_ref = evidence["release_signoff"]["decision"]
        decision_path = self.root / decision_ref["path"]
        document = json.loads(decision_path.read_text())
        document["bound_evidence"] = release.release_decision_bound_evidence(
            evidence
        )
        payload_sha256 = release.release_decision_payload_sha256(document)
        document["signed_payload_sha256"] = payload_sha256
        for signature in document["signatures"]:
            signature["payload_sha256"] = payload_sha256
        decision_path.write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n"
        )
        decision_ref["sha256"] = deploy.sha256_file(decision_path)

    def test_release_evidence_schema_closes_every_required_profile(self):
        schema = json.loads((ROOT / "release" / "evidence.schema.json").read_text())
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(self.evidence), set(schema["required"]))
        section_definitions = {
            "upstream_review": "upstreamReview",
            "security_review": "securityReview",
            "public_testnet": "publicTestnet",
            "gas": "gas",
            "canary": "canary",
            "operations_rehearsal": "operationsRehearsal",
            "release_signoff": "releaseSignoff",
        }
        for section, definition_name in section_definitions.items():
            with self.subTest(section=section):
                definition = schema["$defs"][definition_name]
                self.assertFalse(definition["additionalProperties"])
                self.assertEqual(set(self.evidence[section]), set(definition["required"]))
                self.assertEqual(set(definition["required"]), set(definition["properties"]))

        scenario_ids = set(schema["$defs"]["scenario"]["properties"]["id"]["enum"])
        contained_scenarios = {
            item["contains"]["properties"]["id"]["const"]
            for item in schema["$defs"]["scenarios"]["allOf"]
        }
        self.assertEqual(release.REQUIRED_SCENARIOS, scenario_ids)
        self.assertEqual(release.REQUIRED_SCENARIOS, contained_scenarios)

        gas_cases = set(schema["$defs"]["gasMeasurement"]["properties"]["case"]["enum"])
        contained_gas_cases = {
            item["contains"]["properties"]["case"]["const"]
            for item in schema["$defs"]["gasMeasurements"]["allOf"]
        }
        self.assertEqual(release.REQUIRED_GAS_CASES, gas_cases)
        self.assertEqual(release.REQUIRED_GAS_CASES, contained_gas_cases)
        gas_operations = set(
            schema["$defs"]["gasMeasurement"]["properties"]["operation"]["enum"]
        )
        self.assertEqual(
            {profile["operation"] for profile in release.GAS_CASE_PROFILES.values()},
            gas_operations,
        )

        snapshot_query_names = set(
            schema["$defs"]["historicalPowerQuery"]["properties"]["name"]["enum"]
        )
        contained_snapshot_query_names = {
            item["contains"]["properties"]["name"]["const"]
            for item in schema["$defs"]["historicalPowerQueries"]["allOf"]
        }
        self.assertEqual(release.REQUIRED_SNAPSHOT_QUERIES, snapshot_query_names)
        self.assertEqual(
            release.REQUIRED_SNAPSHOT_QUERIES, contained_snapshot_query_names
        )
        self.assertEqual(
            set(self.evidence["public_testnet"]["snapshot"]["stake_change_transactions"][0]),
            set(schema["$defs"]["stakeChange"]["required"]),
        )
        self.assertEqual(
            set(schema["$defs"]["stakeChange"]["required"]),
            set(schema["$defs"]["stakeChange"]["properties"]),
        )
        self.assertEqual(
            set(self.evidence["canary"]["epochs"][0]),
            set(schema["$defs"]["canaryEpoch"]["required"]),
        )
        self.assertEqual(
            set(schema["$defs"]["canaryEpoch"]["required"]),
            set(schema["$defs"]["canaryEpoch"]["properties"]),
        )

        runbook_paths = {
            item["contains"]["properties"]["path"]["const"]
            for item in schema["$defs"]["runbooks"]["allOf"]
        }
        self.assertEqual(release.REQUIRED_RUNBOOKS, runbook_paths)

        rehearsal_cases = set(
            schema["$defs"]["operationalRehearsalCase"]["properties"]["case"][
                "enum"
            ]
        )
        contained_rehearsal_cases = {
            item["contains"]["properties"]["case"]["const"]
            for item in schema["$defs"]["operationalRehearsalCases"]["allOf"]
        }
        self.assertEqual(release.REQUIRED_OPERATIONAL_REHEARSALS, rehearsal_cases)
        self.assertEqual(
            release.REQUIRED_OPERATIONAL_REHEARSALS, contained_rehearsal_cases
        )
        self.assertEqual(
            set(self.evidence["operations_rehearsal"]["cases"][0]),
            set(schema["$defs"]["operationalRehearsalCase"]["required"]),
        )
        self.assertEqual(
            set(schema["$defs"]["operationalRehearsalCase"]["required"]),
            set(schema["$defs"]["operationalRehearsalCase"]["properties"]),
        )

        query_proofs = {
            name
            for assertions in release.REQUIRED_SCENARIO_ASSERTIONS.values()
            for name, predicate in assertions.items()
            if predicate == "query_response_equals"
        }
        self.assertEqual(query_proofs, set(release.QUERY_PROOFS))
        event_proofs = {
            name
            for assertions in release.REQUIRED_SCENARIO_ASSERTIONS.values()
            for name, predicate in assertions.items()
            if predicate in ("transaction_event_equals", "matching_events_equal")
        }
        self.assertEqual(
            event_proofs,
            set(release.TRANSACTION_EVENT_PROOFS)
            | set(release.MATCHING_EVENT_PROOFS)
            | set(release.EMPTY_TRANSFER_EVENT_PROOFS),
        )

    def test_complete_evidence_packet_is_accepted(self):
        release.validate_evidence(self.evidence, self.root, self.config)

    def test_open_high_or_missing_scenario_is_rejected(self):
        wrong = copy.deepcopy(self.evidence)
        wrong["security_review"]["open_high"] = 1
        with self.assertRaisesRegex(release.EvidenceError, "must be zero"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        wrong["public_testnet"]["scenarios"].pop()
        with self.assertRaisesRegex(release.EvidenceError, "scenario set mismatch"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_content_hash_substitution_is_rejected(self):
        wrong = copy.deepcopy(self.evidence)
        wrong["security_review"]["report"]["sha256"] = "00" * 32
        with self.assertRaisesRegex(release.EvidenceError, "expected"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_security_attestation_binds_scope_report_findings_and_signature(self):
        wrong = copy.deepcopy(self.evidence)
        attestation_ref = wrong["security_review"]["attestation"]
        path = self.root / attestation_ref["path"]
        original = path.read_text()
        path.write_text("{}\n")
        attestation_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "missing keys"):
            release.validate_evidence(wrong, self.root, self.config)
        path.write_text(original)

        wrong = copy.deepcopy(self.evidence)
        attestation_ref = wrong["security_review"]["attestation"]
        path = self.root / attestation_ref["path"]
        document = json.loads(path.read_text())
        document["report_sha256"] = "00" * 32
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        attestation_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "does not match the reviewed evidence"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_upstream_attestation_binds_repository_commit_review_and_acceptor(self):
        wrong = copy.deepcopy(self.evidence)
        attestation_ref = wrong["upstream_review"]["attestation"]
        path = self.root / attestation_ref["path"]
        document = json.loads(path.read_text())
        document["commit"] = "00" * 20
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        attestation_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "accepted upstream review"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_deployment_observation_substitution_is_rejected(self):
        wrong = copy.deepcopy(self.evidence)
        reference = wrong["deployment_verification"]
        path = self.root / reference["path"]
        report = json.loads(path.read_text())
        report["observations"]["contract_info"]["bounty"]["creator"] = (
            self.config["chain"]["xgov_module_account"]
        )
        path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        reference["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "bounty.creator mismatch"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_build_manifest_binds_artifact_schema_and_evidence_bytes(self):
        artifact = self.root / self.config["artifacts"]["juno_voice_bounties"]["path"]
        original_artifact = artifact.read_bytes()
        artifact.write_bytes(original_artifact + b"substitution")
        with self.assertRaisesRegex(release.EvidenceError, "size_bytes"):
            release.validate_evidence(self.evidence, self.root, self.config)
        artifact.write_bytes(original_artifact)

        schema = self.root / release.BUILD_SCHEMAS["juno_voice_bounties"][0]
        original_schema = schema.read_bytes()
        schema.write_bytes(original_schema + b"substitution")
        with self.assertRaisesRegex(release.EvidenceError, "does not match schema bytes"):
            release.validate_evidence(self.evidence, self.root, self.config)
        schema.write_bytes(original_schema)

        checksums = self.root / "artifacts" / "checksums.txt"
        original_checksums = checksums.read_bytes()
        checksums.write_bytes(original_checksums + b"substitution")
        with self.assertRaisesRegex(release.EvidenceError, "does not match checksums.txt"):
            release.validate_evidence(self.evidence, self.root, self.config)
        checksums.write_bytes(original_checksums)

    def test_build_manifest_rejects_wrong_validator_executable_identity(self):
        tools = self.root / "artifacts" / "build-tools.txt"
        tools.write_text(
            tools.read_text().replace(
                "Contract checking 3.0.4", "cosmwasm-check 3.0.4"
            )
        )
        manifest_path = self.root / self.evidence["build_manifest"]["path"]
        manifest = json.loads(manifest_path.read_text())
        manifest["build_evidence"]["build_tools_sha256"] = deploy.sha256_file(tools)
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        self.evidence["build_manifest"]["sha256"] = deploy.sha256_file(manifest_path)

        with self.assertRaisesRegex(release.EvidenceError, "wrong tool identities"):
            release.validate_evidence(self.evidence, self.root, self.config)

    def test_unlinked_assertion_and_reused_transactions_are_rejected(self):
        wrong = copy.deepcopy(self.evidence)
        first = wrong["public_testnet"]["scenarios"][0]
        transcript_path = self.root / first["evidence"]["path"]
        transcript = json.loads(transcript_path.read_text())
        original_actual = copy.deepcopy(transcript["assertions"][0]["actual"])
        transcript["assertions"][0]["actual"] = "not-paid"
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        first["evidence"]["sha256"] = deploy.sha256_file(transcript_path)
        with self.assertRaisesRegex(release.EvidenceError, "referenced chain evidence"):
            release.validate_evidence(wrong, self.root, self.config)

        transcript["assertions"][0]["actual"] = original_actual
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        self.evidence["public_testnet"]["scenarios"][0]["evidence"]["sha256"] = (
            deploy.sha256_file(transcript_path)
        )

        wrong = copy.deepcopy(self.evidence)
        first = wrong["public_testnet"]["scenarios"][0]
        transcript = json.loads(transcript_path.read_text())
        transcript["assertions"][0]["source"]["query_index"] = 999
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        first["evidence"]["sha256"] = deploy.sha256_file(transcript_path)
        with self.assertRaisesRegex(release.EvidenceError, "outside captured queries"):
            release.validate_evidence(wrong, self.root, self.config)

        transcript["assertions"][0]["source"]["query_index"] = 0
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        self.evidence["public_testnet"]["scenarios"][0]["evidence"]["sha256"] = (
            deploy.sha256_file(transcript_path)
        )

        wrong = copy.deepcopy(self.evidence)
        duplicate = wrong["public_testnet"]["scenarios"][0]["transactions"][0]
        second = wrong["public_testnet"]["scenarios"][1]
        second["transactions"] = [duplicate]
        second_path = self.root / second["evidence"]["path"]
        second_transcript = json.loads(second_path.read_text())
        second_transcript["transactions"] = [duplicate]
        second_transcript["transaction_evidence"][0]["hash"] = duplicate
        second_path.write_text(json.dumps(second_transcript, indent=2, sort_keys=True) + "\n")
        second["evidence"]["sha256"] = deploy.sha256_file(second_path)
        with self.assertRaisesRegex(release.EvidenceError, "reused by another scenario"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_named_event_proof_rejects_an_unrelated_wasm_event(self):
        wrong = copy.deepcopy(self.evidence)
        scenario = next(
            item
            for item in wrong["public_testnet"]["scenarios"]
            if item["id"] == "multi_fund_ratify_pay"
        )
        transcript_path = self.root / scenario["evidence"]["path"]
        transcript = json.loads(transcript_path.read_text())
        unrelated = {
            "type": "wasm",
            "attributes": [
                {
                    "key": "_contract_address",
                    "value": transcript["addresses"]["bounty"],
                }
            ],
        }
        transaction = transcript["transaction_evidence"][0]
        transaction["events"] = [unrelated]
        transaction["response"]["events"] = [unrelated]
        transaction["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(transaction["response"])
        )
        assertion = next(
            item for item in transcript["assertions"] if item["name"] == "payout_event"
        )
        assertion["expected"] = unrelated
        assertion["actual"] = unrelated
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        scenario["evidence"]["sha256"] = deploy.sha256_file(transcript_path)
        with self.assertRaisesRegex(release.EvidenceError, "ratification_finalized"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_named_query_proof_rejects_arbitrary_query_and_response(self):
        wrong = copy.deepcopy(self.evidence)
        scenario = next(
            item
            for item in wrong["public_testnet"]["scenarios"]
            if item["id"] == "multi_fund_ratify_pay"
        )
        transcript_path = self.root / scenario["evidence"]["path"]
        transcript = json.loads(transcript_path.read_text())
        transcript["queries"][0]["query"] = {"health": {}}
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        scenario["evidence"]["sha256"] = deploy.sha256_file(transcript_path)
        with self.assertRaisesRegex(release.EvidenceError, "bounty.*query variant"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        scenario = next(
            item
            for item in wrong["public_testnet"]["scenarios"]
            if item["id"] == "multi_fund_ratify_pay"
        )
        transcript["queries"][0]["query"] = {"bounty": {"bounty_id": 1}}
        response = transcript["queries"][0]["response"]
        response["bounty"]["status"] = "open"
        response["bounty"]["paid_amount"] = "0"
        transcript["queries"][0]["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(response)
        )
        assertion = next(
            item
            for item in transcript["assertions"]
            if item["name"] == "bounty_paid_state"
        )
        assertion["expected"] = copy.deepcopy(response)
        assertion["actual"] = copy.deepcopy(response)
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        scenario["evidence"]["sha256"] = deploy.sha256_file(transcript_path)
        with self.assertRaisesRegex(release.EvidenceError, "must equal 'paid'"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_contract_message_destination_must_be_verified(self):
        wrong = copy.deepcopy(self.evidence)
        scenario = wrong["public_testnet"]["scenarios"][0]
        transcript_path = self.root / scenario["evidence"]["path"]
        transcript = json.loads(transcript_path.read_text())
        outside = self.config["chain"]["deployer_address"]
        self.assertNotIn(
            outside,
            release.allowed_scenario_contracts(self.config, transcript["addresses"]),
        )
        transaction = transcript["transaction_evidence"][0]
        message = transaction["messages"][0]
        message["contract"] = outside
        transaction["response"]["tx"]["body"]["messages"][0]["contract"] = outside
        transaction["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(transaction["response"])
        )
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        scenario["evidence"]["sha256"] = deploy.sha256_file(transcript_path)
        with self.assertRaisesRegex(release.EvidenceError, "not a verified"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_negative_transfer_scan_is_bound_to_unchanged_balance_address(self):
        wrong = copy.deepcopy(self.evidence)
        scenario = next(
            item
            for item in wrong["public_testnet"]["scenarios"]
            if item["id"] == "failed_turnout_no_distribution"
        )
        transcript_path = self.root / scenario["evidence"]["path"]
        transcript = json.loads(transcript_path.read_text())
        assertion = next(
            item
            for item in transcript["assertions"]
            if item["name"] == "no_transfer_events"
        )
        assertion["source"]["attributes"] = {"sender": "deliberately-absent"}
        transcript_path.write_text(json.dumps(transcript, indent=2, sort_keys=True) + "\n")
        scenario["evidence"]["sha256"] = deploy.sha256_file(transcript_path)
        with self.assertRaisesRegex(release.EvidenceError, "unchanged-balance proof"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_zero_retention_means_pruning_disabled(self):
        self.evidence["public_testnet"]["snapshot"]["observed_retention_blocks"] = 0
        self.resign_release_decision(self.evidence)
        release.validate_evidence(self.evidence, self.root, self.config)

    def test_transaction_reuse_across_evidence_categories_is_rejected(self):
        wrong = copy.deepcopy(self.evidence)
        wrong["gas"]["measurements"][0]["transaction"] = wrong["public_testnet"][
            "snapshot"
        ]["stake_change_transactions"][0]["hash"]
        with self.assertRaisesRegex(release.EvidenceError, "other release evidence"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_gas_measurements_bind_verified_contract_requests_and_maximum_responses(self):
        wrong = copy.deepcopy(self.evidence)
        measurement = next(
            item
            for item in wrong["gas"]["measurements"]
            if item["case"] == "registry_max_projects"
        )
        measurement["contract"] = wrong["public_testnet"]["snapshot"]["voter_address"]
        with self.assertRaisesRegex(release.EvidenceError, "verified registry contract"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        measurement = next(
            item
            for item in wrong["gas"]["measurements"]
            if item["case"] == "bounty_max_history"
        )
        measurement["response"]["entries"].pop()
        encoded = deploy.canonical_json(measurement["response"])
        measurement["response_bytes"] = len(encoded)
        measurement["response_sha256"] = deploy.sha256_bytes(encoded)
        with self.assertRaisesRegex(release.EvidenceError, "configured maximum observed items"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        measurement = next(
            item
            for item in wrong["gas"]["measurements"]
            if item["case"] == "gauge_max_cleanup_batch"
        )
        measurement["response"]["events"][0]["attributes"][2]["value"] = "99"
        encoded = deploy.canonical_json(measurement["response"])
        measurement["response_bytes"] = len(encoded)
        measurement["response_sha256"] = deploy.sha256_bytes(encoded)
        with self.assertRaisesRegex(release.EvidenceError, "maximum-batch cleanup event"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_canary_requires_distinct_positive_distributions(self):
        wrong = copy.deepcopy(self.evidence)
        wrong["canary"]["epochs"][1]["outcome"] = "no_distribution_turnout"
        wrong["canary"]["epochs"][1]["distributed_value"] = 0
        with self.assertRaisesRegex(release.EvidenceError, "must equal 'distributed'"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        wrong["canary"]["maximum_total_value"] = int(
            self.config["tranche"]["maximum_amount"]
        )
        with self.assertRaisesRegex(release.EvidenceError, "below the full tranche"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_canary_binds_transaction_epoch_state_and_native_transfer_value(self):
        wrong = copy.deepcopy(self.evidence)
        epoch = wrong["canary"]["epochs"][0]
        capture = epoch["transaction_evidence"]
        capture["events"][1]["attributes"][2]["value"] = (
            f"2{self.config['chain']['native_denom']}"
        )
        capture["response"]["events"] = copy.deepcopy(capture["events"])
        capture["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(capture["response"])
        )
        with self.assertRaisesRegex(release.EvidenceError, "distribution transfers"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        epoch = wrong["canary"]["epochs"][0]
        epoch["epoch_query"]["response"]["snapshot_height"] += 1
        epoch["epoch_query"]["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(epoch["epoch_query"]["response"])
        )
        with self.assertRaisesRegex(release.EvidenceError, "canary snapshot"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        epoch = wrong["canary"]["epochs"][0]
        epoch["transaction_evidence"]["messages"][0]["contract"] = (
            self.config["chain"]["deployer_address"]
        )
        epoch["transaction_evidence"]["response"]["tx"]["body"]["messages"] = (
            copy.deepcopy(epoch["transaction_evidence"]["messages"])
        )
        epoch["transaction_evidence"]["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(epoch["transaction_evidence"]["response"])
        )
        with self.assertRaisesRegex(release.EvidenceError, "verified Juno Voice"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_canary_governance_decision_binds_completed_epochs_and_scope(self):
        wrong = copy.deepcopy(self.evidence)
        decision_ref = wrong["canary"]["governance_decision"]
        path = self.root / decision_ref["path"]
        original = path.read_text()
        document = json.loads(original)
        document["transactions"][0] = f"{9999:064X}"
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        decision_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "completed canary evidence"):
            release.validate_evidence(wrong, self.root, self.config)
        path.write_text(original)

        wrong = copy.deepcopy(self.evidence)
        decision_ref = wrong["canary"]["governance_decision"]
        path.write_text("{}\n")
        decision_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "missing keys"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_release_decision_binds_evidence_roles_scope_and_signatures(self):
        wrong = copy.deepcopy(self.evidence)
        decision_ref = wrong["release_signoff"]["decision"]
        path = self.root / decision_ref["path"]
        original = path.read_text()
        document = json.loads(original)
        document["bound_evidence"]["gas_report_sha256"] = "00" * 32
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        decision_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "every reviewed release evidence"):
            release.validate_evidence(wrong, self.root, self.config)
        path.write_text(original)

        wrong = copy.deepcopy(self.evidence)
        decision_ref = wrong["release_signoff"]["decision"]
        document = json.loads(path.read_text())
        document["signatures"].pop()
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        decision_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "one signature per signer"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_release_decision_commits_full_evidence_and_signature_payloads(self):
        wrong = copy.deepcopy(self.evidence)
        wrong["public_testnet"]["scenarios"].reverse()
        with self.assertRaisesRegex(
            release.EvidenceError, "every reviewed release evidence"
        ):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        decision_ref = wrong["release_signoff"]["decision"]
        path = self.root / decision_ref["path"]
        original = path.read_text()
        document = json.loads(original)
        document["decided_at"] = "2026-08-05T02:00:00Z"
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        decision_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "decision payload"):
            release.validate_evidence(wrong, self.root, self.config)
        path.write_text(original)

        wrong = copy.deepcopy(self.evidence)
        decision_ref = wrong["release_signoff"]["decision"]
        document = json.loads(path.read_text())
        document["signatures"][0]["payload_sha256"] = "00" * 32
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        decision_ref["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "signed release decision"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_snapshot_queries_bind_fixed_and_changed_historical_power(self):
        wrong = copy.deepcopy(self.evidence)
        query = next(
            item
            for item in wrong["public_testnet"]["snapshot"][
                "historical_power_queries"
            ]
            if item["name"] == "first_voter_after_change"
        )
        query["response"]["power"] = "11"
        query["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(query["response"])
        )
        with self.assertRaisesRegex(release.EvidenceError, "first epoch must remain fixed"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        query = next(
            item
            for item in wrong["public_testnet"]["snapshot"][
                "historical_power_queries"
            ]
            if item["name"] == "second_voter_after_change"
        )
        query["contract"] = wrong["public_testnet"]["snapshot"]["voter_address"]
        with self.assertRaisesRegex(release.EvidenceError, "verified voting module"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        snapshot = wrong["public_testnet"]["snapshot"]
        too_early = (
            snapshot["first_epoch_height"]
            + snapshot["required_retention_blocks"]
            - 1
        )
        for item in snapshot["historical_power_queries"]:
            if "after_change" in item["name"]:
                item["observed_at_height"] = too_early
        with self.assertRaisesRegex(release.EvidenceError, "required retention window"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_snapshot_staking_changes_are_captured_and_reconcile_to_voter_power(self):
        wrong = copy.deepcopy(self.evidence)
        stake = wrong["public_testnet"]["snapshot"]["stake_change_transactions"][0]
        capture = stake["transaction_evidence"]
        capture["messages"][0]["delegator_address"] = self.config["agent_operations"][
            "core_address"
        ]
        capture["response"]["tx"]["body"]["messages"] = copy.deepcopy(
            capture["messages"]
        )
        capture["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(capture["response"])
        )
        with self.assertRaisesRegex(release.EvidenceError, "historical-power voter"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        stake = wrong["public_testnet"]["snapshot"]["stake_change_transactions"][0]
        capture = stake["transaction_evidence"]
        capture["messages"][0]["amount"]["amount"] = "10"
        capture["response"]["tx"]["body"]["messages"] = copy.deepcopy(
            capture["messages"]
        )
        capture["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(capture["response"])
        )
        with self.assertRaisesRegex(release.EvidenceError, "do not reconcile"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_runbooks_require_operational_sections_and_distinct_paths(self):
        wrong = copy.deepcopy(self.evidence)
        monitoring = next(
            item
            for item in wrong["runbooks"]
            if item["path"] == "deployment/runbooks/MONITORING.md"
        )
        path = self.root / monitoring["path"]
        original = path.read_text()
        path.write_text("# Monitoring runbook\n")
        monitoring["sha256"] = deploy.sha256_file(path)
        with self.assertRaisesRegex(release.EvidenceError, "required operational section"):
            release.validate_evidence(wrong, self.root, self.config)
        path.write_text(original)

        wrong = copy.deepcopy(self.evidence)
        wrong["runbooks"].append(copy.deepcopy(wrong["runbooks"][0]))
        with self.assertRaisesRegex(release.EvidenceError, "is duplicated"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_operational_rehearsal_requires_every_case_and_independent_review(self):
        wrong = copy.deepcopy(self.evidence)
        wrong["operations_rehearsal"]["cases"].pop()
        with self.assertRaisesRegex(release.EvidenceError, "six required operational rehearsals"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        wrong["operations_rehearsal"]["reviewed_by"] = wrong[
            "operations_rehearsal"
        ]["performed_by"]
        with self.assertRaisesRegex(release.EvidenceError, "operator and reviewer"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        wrong["release_signoff"]["operations_reviewer"] = "different-reviewer"
        with self.assertRaisesRegex(release.EvidenceError, "operations rehearsal reviewer"):
            release.validate_evidence(wrong, self.root, self.config)

    def test_operational_rehearsal_binds_raw_transactions_and_code_profiles(self):
        wrong = copy.deepcopy(self.evidence)
        case = next(
            item
            for item in wrong["operations_rehearsal"]["cases"]
            if item["case"] == "adapter_failure"
        )
        capture = case["transaction_evidence"][0]
        capture["code"] = 0
        capture["response"]["code"] = 0
        capture["response_sha256"] = deploy.sha256_bytes(
            deploy.canonical_json(capture["response"])
        )
        with self.assertRaisesRegex(release.EvidenceError, "successful/rejected action profile"):
            release.validate_evidence(wrong, self.root, self.config)

        wrong = copy.deepcopy(self.evidence)
        wrong["operations_rehearsal"]["cases"][0]["transaction_evidence"].pop()
        with self.assertRaisesRegex(release.EvidenceError, "cover every rehearsal transaction"):
            release.validate_evidence(wrong, self.root, self.config)


if __name__ == "__main__":
    unittest.main()
