import base64
import copy
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import juno_voice_deploy as deploy


def address(byte: int, size: int = 20) -> str:
    return deploy.encode_address(bytes([byte]) * size, "juno")


class DeploymentPlannerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        artifacts = {}
        for index, (name, identity) in enumerate(deploy.REQUIRED_ARTIFACTS.items(), start=1):
            path = self.root / "artifacts" / f"{name}.wasm"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\0asm" + bytes([index]) * 32)
            artifacts[name] = {
                "path": str(path.relative_to(self.root)),
                "sha256": deploy.sha256_file(path),
                "cw2_contract": identity[0],
                "cw2_version": identity[1],
            }
        optimizer_digest = "12" * 32
        agent_review = self.root / "evidence" / "agent-operations-review.json"
        agent_review.parent.mkdir(parents=True, exist_ok=True)
        agent_review.write_text('{"reviewed":true}\n')
        self.config = {
            "schema_version": deploy.CONFIG_SCHEMA,
            "environment": "uni-7",
            "chain": {
                "chain_id": "uni-7",
                "rpc": "https://rpc.example.invalid",
                "grpc": "https://grpc.example.invalid",
                "native_denom": "ujuno",
                "bech32_prefix": "juno",
                "xgov_module_account": address(1),
                "deployer_address": address(2),
                "deployer_key_name": "juno-voice-deployer",
                "gas_prices": "0.075ujuno",
                "gas_adjustment": "1.4",
                "tx_timeout_seconds": 120,
            },
            "source": {
                "parent_commit": "ab" * 20,
                "dao_contracts_commit": "cd" * 20,
            },
            "builder": {
                "optimizer_image": f"cosmwasm/optimizer@sha256:{optimizer_digest}",
                "juno_voice_rust": "1.85.1",
                "dao_contracts_rust": "1.81.0",
                "juno_voice_cosmwasm_check": "3.0.4",
                "dao_contracts_cosmwasm_check": "1.5.11",
                "wasm_tools": "1.254.0",
            },
            "artifacts": artifacts,
            "deployment": {
                "code_admin": address(1),
                "program_vault_salt": "juno-voice-v2-vault",
                "program_vault_label": "juno-voice-v2-vault",
                "voting_module_salt": "juno-voice-v2-voting",
                "voting_module_label": "juno-voice-v2-voting",
                "gauge_salt": "juno-voice-v2-gauge",
                "gauge_label": "juno-voice-v2-gauge",
                "bounty_salt": "juno-voice-v2-bounty",
                "bounty_label": "juno-voice-v2-bounty",
                "registry_salt": "juno-voice-v2-registry",
                "registry_label": "juno-voice-v2-registry",
            },
            "cutover": {
                "mode": "no_prior_composition",
                "historical_v1": None,
            },
            "agent_operations": {
                "mode": "bind_reviewed",
                "core_address": address(3),
                "core_code_id": 30,
                "core_checksum": "30" * 32,
                "voting_module_address": address(4),
                "voting_code_id": 31,
                "voting_checksum": "31" * 32,
                "proposal_module_address": address(5),
                "proposal_code_id": 32,
                "proposal_checksum": "32" * 32,
                "membership": {
                    "kind": "cw721_roles",
                    "nft_address": address(6),
                    "nft_code_id": 33,
                    "nft_checksum": "33" * 32,
                    "minter": address(3),
                    "tokens": [
                        {"token_id": "agent:builder", "owner": address(7), "role": "builder", "weight": 1},
                        {"token_id": "agent:steward", "owner": address(8), "role": "steward", "weight": 2},
                    ],
                    "total_power": 3,
                },
                "proposal": {
                    "threshold": {"kind": "threshold_quorum", "threshold": "majority", "quorum": "0.33"},
                    "voting_duration_seconds": 86_400,
                },
                "review_reference": {
                    "path": "evidence/agent-operations-review.json",
                    "sha256": deploy.sha256_file(agent_review),
                },
            },
            "bounty": {
                "min_contribution": "1000000",
                "max_bounty_total": "100000000000",
                "min_lifetime_seconds": 604_800,
                "max_lifetime_seconds": 7_776_000,
                "max_contributors": 500,
                "max_rounds": 20,
                "ratification_seconds": 259_200,
                "limits": {
                    "max_title_bytes": 128,
                    "max_summary_bytes": 2048,
                    "max_acceptance_criteria_bytes": 4096,
                    "max_uri_bytes": 512,
                    "max_rationale_bytes": 2048,
                    "max_reason_bytes": 2048,
                    "max_page_limit": 100,
                },
            },
            "registry": {
                "spam_destination": address(1),
                "registration_bond": "100000000",
                "payout_address_delay_seconds": 86_400,
                "epoch_ceiling": "1000000000",
                "min_project_share": "0.01",
                "max_project_share": "0.20",
                "max_selected_projects": 20,
                "max_active_projects": 99,
                "reserved_option": "do-not-distribute",
                "max_page_limit": 100,
                "max_metadata_uri_bytes": 512,
                "max_reason_bytes": 2048,
            },
            "gauge": {
                "title": "Hack Juno weekly allocation",
                "power_source": "epoch_snapshot",
                "epoch_size_seconds": 604_800,
                "min_turnout_bps": 100,
                "epoch_budget": "1000000000",
                "retained_option": "do-not-distribute",
                "execution_window_seconds": 86_400,
                "min_percent_selected": "0.01",
                "max_available_percentage": "0.20",
                "max_options_selected": 20,
                "option_capacity": 100,
                "reset_epoch_seconds": None,
            },
            "tranche": {
                "maximum_amount": "10000000000",
                "term_start_time": 2_000_000_000,
                "term_end_time": 2_010_000_000,
                "unused_funds_policy": "return_to_community_pool",
                "snapshot_retention_blocks": 200_000,
                "observed_min_block_seconds": 6,
                "operational_margin_seconds": 172_800,
            },
        }

    def tearDown(self):
        self.temporary.cleanup()

    def test_valid_config_and_address_derivation(self):
        deploy.validate_config(self.config, self.root)
        addresses = deploy.derive_addresses(self.config)
        self.assertEqual(set(addresses), {
            "program_vault", "voting_module", "gauge", "bounty", "registry", "agent_operations"
        })
        for name, value in addresses.items():
            deploy.decode_address(value, "juno", name)
        self.assertEqual(addresses, deploy.derive_addresses(self.config))
        self.assertNotEqual(addresses["program_vault"], addresses["bounty"])

    def test_mainnet_cutover_requires_explicit_disjoint_historical_composition(self):
        config = copy.deepcopy(self.config)
        config["environment"] = "juno-mainnet"
        config["chain"]["chain_id"] = "juno-1"
        with self.assertRaisesRegex(deploy.ValidationError, "historical v1 composition"):
            deploy.validate_config(config, self.root)

        components = ("bounty", "registry", "program_vault", "voting_module", "gauge")
        config["cutover"] = {
            "mode": "replace_historical_v1",
            "historical_v1": {
                component: {
                    "address": address(20 + index),
                    "code_id": str(5_150 + index),
                    "checksum": f"{40 + index:02x}" * 32,
                }
                for index, component in enumerate(components)
            },
        }
        deploy.validate_config(config, self.root)

        collision = copy.deepcopy(config)
        collision["cutover"]["historical_v1"]["bounty"]["address"] = (
            deploy.derive_addresses(collision)["bounty"]
        )
        with self.assertRaisesRegex(deploy.ValidationError, "addresses collide"):
            deploy.validate_config(collision, self.root)

        checksum_reuse = copy.deepcopy(config)
        checksum_reuse["cutover"]["historical_v1"]["bounty"]["checksum"] = (
            checksum_reuse["artifacts"]["gauge_orchestrator"]["sha256"]
        )
        with self.assertRaisesRegex(deploy.ValidationError, "checksums must be disjoint"):
            deploy.validate_config(checksum_reuse, self.root)

        code_ids = {
            name: 100 + index
            for index, name in enumerate(deploy.REQUIRED_ARTIFACTS, start=1)
        }
        code_ids["juno_voice_bounties"] = 5_150
        with self.assertRaisesRegex(deploy.ValidationError, "reuses a historical v1 code ID"):
            deploy.verify_code_ids(config, code_ids, object())

    def test_historical_cutover_observation_rejects_nonempty_or_substituted_v1(self):
        config = copy.deepcopy(self.config)
        components = ("bounty", "registry", "program_vault", "voting_module", "gauge")
        config["cutover"] = {
            "mode": "replace_historical_v1",
            "historical_v1": {
                component: {
                    "address": address(20 + index),
                    "code_id": 5_150 + index,
                    "checksum": f"{40 + index:02x}" * 32,
                }
                for index, component in enumerate(components)
            },
        }
        deploy.validate_config(config, self.root)
        historical = config["cutover"]["historical_v1"]
        observation = {
            "mode": "replace_historical_v1",
            "historical_v1": {
                "contract_info": {
                    component: {
                        "code_id": identity["code_id"],
                        "admin": config["chain"]["xgov_module_account"],
                    }
                    for component, identity in historical.items()
                },
                "code_checksums": {
                    component: identity["checksum"]
                    for component, identity in historical.items()
                },
                "balances": {"program_vault": "0", "bounty": "0", "registry": "0"},
                "bounty_health": {
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
                "bounty_page": {"bounties": []},
                "registry_health": {
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
                "registry_projects": {"projects": []},
                "registry_applications": {"projects": []},
                "registry_options": {"options": ["do-not-distribute"]},
                "gauge_state": {"current_epoch": None},
                "gauge_epochs": {"epochs": []},
            },
        }
        deploy.validate_cutover_observation(config, observation)

        for label, mutate in (
            (
                "funded vault",
                lambda value: value["historical_v1"]["balances"].__setitem__(
                    "program_vault", "1"
                ),
            ),
            (
                "existing bounty",
                lambda value: value["historical_v1"].__setitem__(
                    "bounty_page", {"bounties": [{"id": 1}]}
                ),
            ),
            (
                "open epoch",
                lambda value: value["historical_v1"]["gauge_state"].__setitem__(
                    "current_epoch", 1
                ),
            ),
            (
                "omitted epoch state",
                lambda value: value["historical_v1"]["gauge_state"].pop("current_epoch"),
            ),
            (
                "substituted code",
                lambda value: value["historical_v1"]["contract_info"]["gauge"].__setitem__(
                    "code_id", 99
                ),
            ),
        ):
            with self.subTest(label=label):
                wrong = copy.deepcopy(observation)
                mutate(wrong)
                with self.assertRaises(deploy.ValidationError):
                    deploy.validate_cutover_observation(config, wrong)

    def test_source_checkout_must_equal_reviewed_parent_not_a_descendant(self):
        repository = self.root / "source"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        subprocess.run(["git", "-C", str(repository), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repository), "config", "user.name", "Test"], check=True)
        submodule = repository / "deps" / "dao-contracts"
        submodule.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(submodule)], check=True)
        subprocess.run(["git", "-C", str(submodule), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(submodule), "config", "user.name", "Test"], check=True)
        (submodule / "README").write_text("pin\n")
        subprocess.run(["git", "-C", str(submodule), "add", "README"], check=True)
        subprocess.run(["git", "-C", str(submodule), "commit", "-qm", "pin"], check=True)
        pin = subprocess.check_output(["git", "-C", str(submodule), "rev-parse", "HEAD"], text=True).strip()
        subprocess.run(
            ["git", "-c", "protocol.file.allow=always", "-C", str(repository), "submodule", "add", "-q", str(submodule), "deps/dao-contracts"],
            check=True,
        )
        subprocess.run(["git", "-C", str(repository), "commit", "-qam", "reviewed"], check=True)
        reviewed = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
        config = copy.deepcopy(self.config)
        config["source"] = {"parent_commit": reviewed, "dao_contracts_commit": pin}
        (repository / "later").write_text("unreviewed descendant\n")
        subprocess.run(["git", "-C", str(repository), "add", "later"], check=True)
        subprocess.run(["git", "-C", str(repository), "commit", "-qm", "later"], check=True)
        with self.assertRaisesRegex(deploy.ValidationError, "must exactly equal"):
            deploy.validate_source_checkout(config, repository)

    def test_gitmodules_changes_trigger_backend_ci(self):
        workflow = (Path(__file__).parents[1] / ".github" / "workflows" / "backend.yml").read_text()
        self.assertEqual(2, workflow.count('- ".gitmodules"'))

    def test_json_schema_has_closed_shape_parity_with_authoritative_config(self):
        schema = json.loads(Path(__file__).with_name("config.schema.json").read_text())
        self.assertEqual(set(self.config), set(schema["required"]))
        self.assertFalse(schema["additionalProperties"])

        direct_sections = (
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
        )
        for section in direct_sections:
            with self.subTest(section=section):
                reference = schema["properties"][section]["$ref"]
                definition = schema["$defs"][reference.removeprefix("#/$defs/")]
                self.assertFalse(definition["additionalProperties"])
                self.assertEqual(set(self.config[section]), set(definition["required"]))
                self.assertEqual(set(definition["required"]), set(definition["properties"]))

        limits = schema["$defs"]["bounty_limits"]
        self.assertEqual(set(self.config["bounty"]["limits"]), set(limits["required"]))
        self.assertFalse(limits["additionalProperties"])
        self.assertEqual(2, len(schema["$defs"]["agent_membership"]["oneOf"]))
        self.assertEqual(259_200, schema["$defs"]["bounty"]["properties"]["ratification_seconds"]["const"])
        self.assertEqual(99, schema["$defs"]["registry"]["properties"]["max_active_projects"]["const"])
        self.assertEqual(100, schema["$defs"]["gauge"]["properties"]["option_capacity"]["const"])

    def test_cw721_schema_and_runtime_constraints_are_equivalent(self):
        schema = json.loads(Path(__file__).with_name("config.schema.json").read_text())
        token_schema = schema["$defs"]["agent_token"]
        proposal_schema = schema["$defs"]["agent_proposal"]
        threshold_schema = proposal_schema["properties"]["threshold"]["oneOf"][1]
        self.assertEqual(256, token_schema["properties"]["token_id"]["maxLength"])
        self.assertEqual(128, token_schema["properties"]["role"]["maxLength"])
        self.assertEqual(
            "#/$defs/positive_decimal_fraction",
            threshold_schema["properties"]["quorum"]["$ref"],
        )
        self.assertEqual(
            "integer",
            proposal_schema["properties"]["voting_duration_seconds"]["type"],
        )

        too_long_token = copy.deepcopy(self.config)
        too_long_token["agent_operations"]["membership"]["tokens"][0]["token_id"] = "x" * 257
        with self.assertRaisesRegex(deploy.ValidationError, "token_id"):
            deploy.validate_config(too_long_token, self.root)

        too_long_role = copy.deepcopy(self.config)
        too_long_role["agent_operations"]["membership"]["tokens"][0]["role"] = "x" * 129
        with self.assertRaisesRegex(deploy.ValidationError, "role"):
            deploy.validate_config(too_long_role, self.root)

        duration_string = copy.deepcopy(self.config)
        duration_string["agent_operations"]["proposal"]["voting_duration_seconds"] = "86400"
        with self.assertRaisesRegex(deploy.ValidationError, "voting_duration_seconds"):
            deploy.validate_config(duration_string, self.root)

        zero_quorum = copy.deepcopy(self.config)
        zero_quorum["agent_operations"]["proposal"]["threshold"]["quorum"] = "0"
        with self.assertRaisesRegex(deploy.ValidationError, "quorum"):
            deploy.validate_config(zero_quorum, self.root)

    def test_rejects_wrong_denom_artifact_and_retention(self):
        wrong = copy.deepcopy(self.config)
        wrong["chain"]["native_denom"] = "uatom"
        with self.assertRaisesRegex(deploy.ValidationError, "native_denom"):
            deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["artifacts"]["juno_voice_bounties"]["sha256"] = "00" * 32
        with self.assertRaisesRegex(deploy.ValidationError, "expected"):
            deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["tranche"]["snapshot_retention_blocks"] = 1
        with self.assertRaisesRegex(deploy.ValidationError, "retention"):
            deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["gauge"]["retained_option"] = "project:1"
        with self.assertRaisesRegex(deploy.ValidationError, "retained_option"):
            deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["gauge"]["execution_window_seconds"] = 0
        with self.assertRaisesRegex(deploy.ValidationError, "execution_window_seconds"):
            deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["gauge"]["execution_window_seconds"] = 2**64
        with self.assertRaisesRegex(deploy.ValidationError, "must fit u64"):
            deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["registry"]["implicit_governor"] = address(9)
        with self.assertRaisesRegex(deploy.ValidationError, "unexpected keys"):
            deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["builder"]["wasm_tools"] = "1.255.0"
        with self.assertRaisesRegex(deploy.ValidationError, "builder.wasm_tools"):
            deploy.validate_config(wrong, self.root)

    def test_plan_is_two_phase_and_compiles_exact_nested_messages(self):
        state = deploy.empty_state(self.config)
        first = deploy.build_plan(self.config, state, self.root)
        self.assertEqual(5, sum(step["kind"] == "store_code" for step in first["steps"]))
        self.assertEqual("blocked", first["steps"][-1]["status"])

        state["code_ids"] = {
            name: index for index, name in enumerate(deploy.REQUIRED_ARTIFACTS, start=101)
        }
        second = deploy.build_plan(self.config, state, self.root)
        instantiates = [step for step in second["steps"] if step["kind"] == "instantiate2"]
        self.assertEqual(["registry", "bounty", "program_vault"], [s["id"].split(":")[1] for s in instantiates])
        messages = deploy.instantiate_messages(self.config, state["code_ids"])
        vault = messages["program_vault"]
        self.assertEqual(self.config["chain"]["xgov_module_account"], vault["admin"])
        voting = vault["voting_module_instantiate_info"]
        self.assertEqual({}, json.loads(base64.b64decode(voting["msg"])))
        gauge_module = vault["proposal_modules_instantiate_info"][0]
        nested_gauge = json.loads(base64.b64decode(gauge_module["msg"]))
        self.assertEqual(messages["addresses"]["voting_module"], nested_gauge["voting_powers"])
        self.assertEqual(messages["addresses"]["registry"], nested_gauge["gauges"][0]["adapter"])
        self.assertEqual("", nested_gauge["hook_caller"])
        self.assertEqual("ujuno", nested_gauge["gauges"][0]["snapshot_policy"]["denom"])
        self.assertEqual(
            "do-not-distribute",
            nested_gauge["gauges"][0]["snapshot_policy"]["retained_option"],
        )
        self.assertEqual(
            86_400,
            nested_gauge["gauges"][0]["snapshot_policy"]["execution_window_seconds"],
        )

    def test_state_is_bound_to_config_and_addresses(self):
        state_path = self.root / "state.json"
        state = deploy.empty_state(self.config)
        deploy.atomic_write_json(state_path, state)
        self.assertEqual(state, deploy.load_state(state_path, self.config))
        state["addresses"]["registry"] = address(9)
        deploy.atomic_write_json(state_path, state)
        with self.assertRaisesRegex(deploy.ValidationError, "do not match"):
            deploy.load_state(state_path, self.config)

        state = deploy.empty_state(self.config)
        state["transactions"]["unknown:step"] = {"status": "complete"}
        deploy.atomic_write_json(state_path, state)
        with self.assertRaisesRegex(deploy.ValidationError, "unknown steps"):
            deploy.load_state(state_path, self.config)

    def test_mutable_paths_and_concurrent_state_access_fail_closed(self):
        state_path = self.root / "state.json"
        with self.assertRaisesRegex(deploy.ValidationError, "outside"):
            deploy.require_external_mutable_path(state_path, self.root, "state path")
        with self.assertRaisesRegex(deploy.ValidationError, "overwrite"):
            deploy.reject_output_collision(state_path, state_path)
        with deploy.exclusive_state_lock(state_path):
            with self.assertRaisesRegex(RuntimeError, "locked by another process"):
                with deploy.exclusive_state_lock(state_path):
                    pass

    def test_instantiate2_matches_cosmwasm_reference_vector(self):
        # cosmwasm_std::addresses::instantiate2_address_impl_works, first
        # no-message vector. This catches length-prefixing and ADR-028 changes.
        creator_raw = bytes.fromhex("9999999999aaaaaaaaaabbbbbbbbbbcccccccccc")
        creator = deploy.encode_address(creator_raw, "juno")
        result = deploy.instantiate2_address(
            "13a1fc994cc6d1c81b746ee0c0ff6f90043875e0bf1d9be6b7d779fc978dc2a5",
            creator,
            "a",
            "juno",
        )
        self.assertEqual(
            bytes.fromhex("5e865d3e45ad3e961f77fd77d46543417ced44d924dc3e079b5415ff6775f847"),
            deploy.decode_address(result, "juno"),
        )

    def test_config_hash_uses_canonical_json(self):
        expected = hashlib.sha256(
            json.dumps(self.config, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        self.assertEqual(expected, deploy.config_hash(self.config))

    def test_chain_checksum_and_legacy_base64_events_are_normalized(self):
        raw = bytes(range(32))
        self.assertEqual(raw.hex(), deploy._chain_checksum({
            "data_hash": base64.b64encode(raw).decode()
        }))
        tx = {
            "events": [
                {
                    "attributes": [
                        {
                            "key": base64.b64encode(b"code_id").decode(),
                            "value": base64.b64encode(b"42").decode(),
                        }
                    ]
                }
            ]
        }
        self.assertEqual(["42"], deploy._event_values(tx, "code_id"))
        with self.assertRaisesRegex(RuntimeError, "broadcast rejected with code 5"):
            deploy._tx_hash(
                {
                    "txhash": "AB" * 32,
                    "code": 5,
                    "raw_log": "fixture rejection",
                }
            )

    def test_chain_preflight_rejects_wrong_native_staking_denom(self):
        class FakeChain:
            bond_denom = "ujuno"
            catching_up = False

            def status(self):
                return {
                    "NodeInfo": {"network": "uni-7"},
                    "SyncInfo": {
                        "catching_up": self.catching_up,
                        "latest_block_height": "12345",
                    },
                }

            def staking_params(self):
                return {"params": {"bond_denom": self.bond_denom}}

            def module_account(self, name):
                self.requested_module = name
                return {
                    "account": {
                        "base_account": {
                            "address": self_config["chain"]["xgov_module_account"]
                        },
                        "name": "gov",
                    }
                }

        self_config = self.config
        chain = FakeChain()
        report = deploy.preflight_chain(self.config, chain)
        self.assertEqual(deploy.PREFLIGHT_SCHEMA, report["schema_version"])
        self.assertEqual(12345, report["latest_block_height"])
        self.assertEqual("ujuno", report["staking_bond_denom"])
        self.assertEqual("gov", chain.requested_module)
        self.assertEqual(
            self.config["chain"]["xgov_module_account"],
            report["xgov_module_account"],
        )

        chain.bond_denom = "ujunox"
        with self.assertRaisesRegex(RuntimeError, "staking bond denom mismatch"):
            deploy.preflight_chain(self.config, chain)

        chain.bond_denom = "ujuno"
        chain.catching_up = True
        with self.assertRaisesRegex(RuntimeError, "not confirmed synced"):
            deploy.preflight_chain(self.config, chain)

    def test_deployer_key_must_match_instantiate2_creator(self):
        self_config = self.config

        class FakeJunod:
            value = {"address": self_config["chain"]["deployer_address"]}

            def key_record(self):
                return self.value

        junod = FakeJunod()
        self.assertEqual(
            self.config["chain"]["deployer_address"],
            deploy.validate_deployer_key(self.config, junod),
        )
        junod.value = {"address": address(99)}
        with self.assertRaisesRegex(RuntimeError, "deployer key address mismatch"):
            deploy.validate_deployer_key(self.config, junod)

    def test_config_validator_mirrors_contract_hard_bounds(self):
        cases = (
            ("bounty.max_rounds", lambda value: value["bounty"].update(max_rounds=101)),
            (
                "bounty.max_lifetime_seconds",
                lambda value: value["bounty"].update(
                    max_lifetime_seconds=deploy.MAX_BOUNTY_LIFETIME_SECONDS + 1
                ),
            ),
            (
                "bounty.limits.max_page_limit",
                lambda value: value["bounty"]["limits"].update(max_page_limit=101),
            ),
            (
                "registry.payout_address_delay_seconds",
                lambda value: value["registry"].update(
                    payout_address_delay_seconds=deploy.MAX_PAYOUT_ADDRESS_DELAY_SECONDS + 1
                ),
            ),
            (
                "registry.max_metadata_uri_bytes",
                lambda value: value["registry"].update(max_metadata_uri_bytes=2049),
            ),
            (
                "agent_operations.membership.tokens",
                lambda value: value["agent_operations"]["membership"].update(
                    tokens=[
                        {"token_id": f"agent:{index}", "owner": address(index + 20), "role": "builder", "weight": 1}
                        for index in range(deploy.MAX_AGENT_MEMBERS + 1)
                    ],
                    total_power=deploy.MAX_AGENT_MEMBERS + 1,
                ),
            ),
            (
                "registry.max_project_share",
                lambda value: value["registry"].update(max_project_share="1"),
            ),
            ("gauge.title", lambda value: value["gauge"].update(title="x" * 129)),
            (
                "registry.min_project_share",
                lambda value: value["registry"].update(min_project_share="1e-2"),
            ),
        )
        for field, mutate in cases:
            with self.subTest(field=field):
                wrong = copy.deepcopy(self.config)
                mutate(wrong)
                with self.assertRaisesRegex(deploy.ValidationError, field.replace(".", r"\.")):
                    deploy.validate_config(wrong, self.root)

        wrong = copy.deepcopy(self.config)
        wrong["agent_operations"]["review_reference"]["sha256"] = "00" * 32
        with self.assertRaisesRegex(deploy.ValidationError, "review_reference.sha256"):
            deploy.validate_config(wrong, self.root)

    def test_pending_transaction_is_reconciled_without_rebroadcast(self):
        state_path = self.root / "state.json"
        state = deploy.empty_state(self.config)
        first_name = next(iter(deploy.REQUIRED_ARTIFACTS))
        tx_hash = "AB" * 32
        state["transactions"][f"store:{first_name}"] = {
            "status": "pending",
            "tx_hash": tx_hash,
        }
        deploy.atomic_write_json(state_path, state)
        expected_checksum = self.config["artifacts"][first_name]["sha256"]
        test_case = self

        class FakeJunod:
            def tx(self, _args):
                raise AssertionError("pending transaction must not be rebroadcast")

            def wait_tx(self, actual_hash):
                test_case.assertEqual(tx_hash, actual_hash)
                return {
                    "events": [
                        {"attributes": [{"key": "code_id", "value": "77"}]}
                    ]
                }

            def code_info(self, code_id):
                test_case.assertEqual(77, code_id)
                return {"code_hash": expected_checksum}

        result = deploy.apply_next(
            self.config,
            deploy.load_state(state_path, self.config),
            self.root,
            state_path,
            FakeJunod(),
        )
        self.assertIn("completed", result)
        recorded = deploy.load_state(state_path, self.config)
        self.assertEqual(77, recorded["code_ids"][first_name])
        self.assertEqual("complete", recorded["transactions"][f"store:{first_name}"]["status"])

    def test_ready_store_reuses_exact_on_chain_code_without_broadcast(self):
        state_path = self.root / "state.json"
        state = deploy.empty_state(self.config)
        deploy.atomic_write_json(state_path, state)
        first_name = next(iter(deploy.REQUIRED_ARTIFACTS))

        class FakeJunod:
            def code_ids_by_checksum(self, checksum):
                self.checksum = checksum
                return [88]

            def tx(self, _args):
                raise AssertionError("exact existing code must not be uploaded again")

        fake = FakeJunod()
        result = deploy.apply_next(
            self.config,
            state,
            self.root,
            state_path,
            fake,
        )
        self.assertIn("existing exact code ID 88", result)
        self.assertEqual(
            self.config["artifacts"][first_name]["sha256"], fake.checksum
        )
        recorded = deploy.load_state(state_path, self.config)
        self.assertEqual(88, recorded["code_ids"][first_name])
        self.assertTrue(recorded["transactions"][f"store:{first_name}"]["reused_exact_code"])

    def test_ready_instantiate_reconciles_exact_existing_contract_without_broadcast(self):
        state_path = self.root / "state.json"
        state = deploy.empty_state(self.config)
        state["code_ids"] = {
            name: index for index, name in enumerate(deploy.REQUIRED_ARTIFACTS, start=101)
        }
        state["transactions"] = {
            f"store:{name}": {
                "status": "complete",
                "code_id": code_id,
                "reused_exact_code": True,
            }
            for name, code_id in state["code_ids"].items()
        }
        deploy.atomic_write_json(state_path, state)
        expected = deploy.instantiate_messages(self.config, state["code_ids"])
        registry_address = expected["addresses"]["registry"]
        registry_code_id = state["code_ids"]["hack_juno_registry_adapter"]
        checksums = {
            code_id: self.config["artifacts"][name]["sha256"]
            for name, code_id in state["code_ids"].items()
        }
        self_config = self.config
        test_case = self

        class FakeJunod:
            def code_info(self, code_id):
                return {"code_hash": checksums[code_id]}

            def contract_info(self, contract_address):
                if contract_address != registry_address:
                    raise RuntimeError("not found")
                return {
                    "code_id": registry_code_id,
                    "admin": self_config["chain"]["xgov_module_account"],
                    "creator": self_config["chain"]["deployer_address"],
                }

            def smart(self, contract_address, query):
                test_case.assertEqual(registry_address, contract_address)
                test_case.assertEqual({"config": {}}, query)
                return {
                    **expected["registry"],
                    "max_active_projects": deploy.MAX_ACTIVE_PROJECTS,
                }

            def tx(self, _args):
                raise AssertionError("existing deterministic contract must not be rebroadcast")

        result = deploy.apply_next(
            self.config,
            deploy.load_state(state_path, self.config),
            self.root,
            state_path,
            FakeJunod(),
        )
        self.assertIn("reconciled instantiate:registry", result)
        recorded = deploy.load_state(state_path, self.config)
        self.assertTrue(recorded["transactions"]["instantiate:registry"]["reconciled_existing"])

    def test_pending_instantiate_rechecks_full_contract_configuration(self):
        state_path = self.root / "state.json"
        state = deploy.empty_state(self.config)
        state["code_ids"] = {
            name: index for index, name in enumerate(deploy.REQUIRED_ARTIFACTS, start=101)
        }
        state["transactions"] = {
            f"store:{name}": {
                "status": "complete",
                "code_id": code_id,
                "reused_exact_code": True,
            }
            for name, code_id in state["code_ids"].items()
        }
        tx_hash = "EF" * 32
        state["transactions"]["instantiate:registry"] = {
            "status": "pending",
            "tx_hash": tx_hash,
        }
        deploy.atomic_write_json(state_path, state)
        messages = deploy.instantiate_messages(self.config, state["code_ids"])
        registry_address = messages["addresses"]["registry"]
        checksums = {
            code_id: self.config["artifacts"][name]["sha256"]
            for name, code_id in state["code_ids"].items()
        }
        self_config = self.config

        class FakeJunod:
            def code_info(self, code_id):
                return {"code_hash": checksums[code_id]}

            def wait_tx(self, actual_hash):
                self_hash = actual_hash
                if self_hash != tx_hash:
                    raise AssertionError(self_hash)
                return {
                    "events": [
                        {
                            "attributes": [
                                {
                                    "key": "_contract_address",
                                    "value": registry_address,
                                }
                            ]
                        }
                    ]
                }

            def contract_info(self, contract_address):
                if contract_address != registry_address:
                    raise AssertionError(contract_address)
                return {
                    "code_id": state["code_ids"]["hack_juno_registry_adapter"],
                    "admin": self_config["chain"]["xgov_module_account"],
                    "creator": self_config["chain"]["deployer_address"],
                }

            def smart(self, contract_address, query):
                if contract_address != registry_address or query != {"config": {}}:
                    raise AssertionError((contract_address, query))
                return {
                    **messages["registry"],
                    "governor": address(99),
                    "max_active_projects": deploy.MAX_ACTIVE_PROJECTS,
                }

            def tx(self, _args):
                raise AssertionError("pending transaction must not be rebroadcast")

        with self.assertRaisesRegex(RuntimeError, "reconcile:registry:governor mismatch"):
            deploy.apply_next(
                self.config,
                deploy.load_state(state_path, self.config),
                self.root,
                state_path,
                FakeJunod(),
            )
        recorded = deploy.load_state(state_path, self.config)
        self.assertEqual(
            "pending", recorded["transactions"]["instantiate:registry"]["status"]
        )

    def test_chain_verification_checks_authorities_modules_and_economics(self):
        state = deploy.empty_state(self.config)
        state["code_ids"] = {
            name: index for index, name in enumerate(deploy.REQUIRED_ARTIFACTS, start=101)
        }
        addresses = deploy.derive_addresses(self.config)
        messages = deploy.instantiate_messages(self.config, state["code_ids"])
        agent = self.config["agent_operations"]
        xgov = self.config["chain"]["xgov_module_account"]
        own_contracts = {
            addresses["program_vault"]: (state["code_ids"]["dao_dao_core"], self.config["chain"]["deployer_address"]),
            addresses["bounty"]: (state["code_ids"]["juno_voice_bounties"], self.config["chain"]["deployer_address"]),
            addresses["registry"]: (state["code_ids"]["hack_juno_registry_adapter"], self.config["chain"]["deployer_address"]),
            addresses["voting_module"]: (state["code_ids"]["dao_voting_juno_staked"], addresses["program_vault"]),
            addresses["gauge"]: (state["code_ids"]["gauge_orchestrator"], addresses["program_vault"]),
        }
        agent_contracts = {
            agent["core_address"]: agent["core_code_id"],
            agent["voting_module_address"]: agent["voting_code_id"],
            agent["proposal_module_address"]: agent["proposal_code_id"],
            agent["membership"]["nft_address"]: agent["membership"]["nft_code_id"],
        }
        checksums = {
            state["code_ids"][name]: item["sha256"]
            for name, item in self.config["artifacts"].items()
        }
        checksums.update(
            {
                agent["core_code_id"]: agent["core_checksum"],
                agent["voting_code_id"]: agent["voting_checksum"],
                agent["proposal_code_id"]: agent["proposal_checksum"],
                agent["membership"]["nft_code_id"]: agent["membership"]["nft_checksum"],
            }
        )

        class FakeChain:
            bad_owner = False

            def code_info(self, code_id):
                return {"code_hash": checksums[code_id]}

            def contract_info(self, contract_address):
                if contract_address in own_contracts:
                    code_id, creator = own_contracts[contract_address]
                    return {"code_id": code_id, "creator": creator, "admin": xgov}
                return {"code_id": agent_contracts[contract_address], "admin": ""}

            def balance(self, contract_address, denom):
                if contract_address != addresses["program_vault"] or denom != "ujuno":
                    raise AssertionError((contract_address, denom))
                return "0"

            def smart(self, contract_address, query):
                if contract_address == addresses["program_vault"]:
                    return {
                        "admin": xgov,
                        "voting_module": addresses["voting_module"],
                        "proposal_modules": [{"address": addresses["gauge"], "status": "enabled"}],
                    }
                if contract_address == addresses["voting_module"]:
                    return addresses["program_vault"]
                if contract_address == addresses["bounty"]:
                    if "identity_state" in query:
                        return {"next_bounty_id": 1}
                    if "bounties" in query:
                        return {"bounties": []}
                    if "health" in query:
                        return {
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
                        }
                    return {**messages["bounty"], "ratification_seconds": 259_200, "version": 1}
                if contract_address == addresses["registry"]:
                    if "identity_state" in query:
                        return {"next_project_id": 1, "consumed_source_bounties": 0}
                    if "projects" in query or "applications" in query:
                        return {"projects": []}
                    if "all_options" in query:
                        return {"options": ["do-not-distribute"]}
                    if "health" in query:
                        return {
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
                        }
                    return {**messages["registry"], "max_active_projects": 99, "version": 1}
                if contract_address == addresses["gauge"] and "config" in query:
                    return {
                        "dao_core": addresses["program_vault"],
                        "owner": address(9) if self.bad_owner else addresses["program_vault"],
                        "voting_powers": addresses["voting_module"],
                        "hook_caller": addresses["gauge"],
                        "power_source": {"epoch_snapshot": {"guardian": addresses["agent_operations"]}},
                    }
                if contract_address == addresses["gauge"]:
                    if "list_epochs" in query:
                        return {"epochs": []}
                    return {
                        "id": 0,
                        **messages["gauge_inner"]["gauges"][0],
                        "is_stopped": False,
                        "current_epoch": None,
                    }
                if contract_address == agent["core_address"]:
                    return {
                        "voting_module": agent["voting_module_address"],
                        "proposal_modules": [
                            {"address": agent["proposal_module_address"], "status": "enabled"}
                        ],
                    }
                if contract_address == agent["voting_module_address"]:
                    if "total_power_at_height" in query:
                        return {"power": str(agent["membership"]["total_power"]), "height": 123}
                    return {"nft_address": agent["membership"]["nft_address"]}
                if contract_address == agent["membership"]["nft_address"]:
                    if "all_tokens" in query:
                        if query["all_tokens"]["start_after"] is not None:
                            return {"tokens": []}
                        return {
                            "tokens": sorted(item["token_id"] for item in agent["membership"]["tokens"])
                        }
                    if "minter" in query:
                        return {"minter": agent["membership"]["minter"]}
                    if "num_tokens" in query:
                        return {"count": len(agent["membership"]["tokens"])}
                    if "all_nft_info" in query:
                        token_id = query["all_nft_info"]["token_id"]
                        item = next(item for item in agent["membership"]["tokens"] if item["token_id"] == token_id)
                        return {
                            "access": {"owner": item["owner"], "approvals": []},
                            "info": {"token_uri": None, "extension": {"role": item["role"], "weight": item["weight"]}},
                        }
                if contract_address == agent["proposal_module_address"]:
                    return {
                        "dao": agent["core_address"],
                        "threshold": deploy._agent_proposal_threshold(agent),
                        "max_voting_period": {"time": agent["proposal"]["voting_duration_seconds"]},
                    }
                raise AssertionError((contract_address, query))

        preflight = {
            "schema_version": deploy.PREFLIGHT_SCHEMA,
            "config_sha256": deploy.config_hash(self.config),
            "chain_id": self.config["chain"]["chain_id"],
            "latest_block_height": 12345,
            "catching_up": False,
            "staking_bond_denom": self.config["chain"]["native_denom"],
            "xgov_module_account": self.config["chain"]["xgov_module_account"],
            "cutover": {
                "mode": "no_prior_composition",
                "historical_v1": None,
            },
            "checks": [
                "chain_id",
                "rpc_synced",
                "staking_bond_denom",
                "xgov_module_account",
                "cutover",
            ],
        }
        chain = FakeChain()
        report = deploy.verify_deployment(self.config, state, chain, preflight)
        self.assertEqual(deploy.VERIFICATION_SCHEMA, report["schema_version"])
        self.assertEqual(preflight, report["preflight"])
        self.assertGreater(len(report["checks"]), 50)
        chain.bad_owner = True
        with self.assertRaisesRegex(RuntimeError, "gauge:owner mismatch"):
            deploy.verify_deployment(self.config, state, chain, preflight)


if __name__ == "__main__":
    unittest.main()
