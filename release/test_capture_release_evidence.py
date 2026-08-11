import copy
import json
import sys
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "release"))
sys.path.insert(0, str(ROOT / "deployment"))
sys.path.insert(0, str(ROOT / "integration"))
import test_juno_voice_deploy as deploy_tests  # noqa: E402

import capture_release_evidence as capture  # noqa: E402
import juno_voice_deploy as deploy  # noqa: E402
import test_release_manifest as release_tests  # noqa: E402


class ReleaseCaptureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = deploy_tests.DeploymentPlannerTests(
            "test_valid_config_and_address_derivation"
        )
        self.fixture.setUp()
        self.config = self.fixture.config
        self.addresses = deploy.derive_addresses(self.config)
        voter_raw = deploy.decode_address(
            self.config["chain"]["deployer_address"],
            self.config["chain"]["bech32_prefix"],
        )
        self.validator = deploy.encode_address(
            voter_raw, f"{self.config['chain']['bech32_prefix']}valoper"
        )

    def tearDown(self):
        self.fixture.tearDown()

    def transaction_response(
        self, transaction_hash: str, code: int, message: dict, height: int = 10
    ):
        return {
            "txhash": transaction_hash,
            "height": str(height),
            "code": code,
            "gas_wanted": "200000",
            "gas_used": "100000",
            "events": [
                {
                    "type": "message",
                    "attributes": [{"key": "action", "value": "fixture"}],
                }
            ],
            "tx": {"body": {"messages": [message]}},
        }

    def test_staking_change_capture_emits_release_shape_and_rejects_wrong_denom(self):
        transaction_hash = "AB" * 32
        message = {
            "@type": "/cosmos.staking.v1beta1.MsgDelegate",
            "delegator_address": self.config["chain"]["deployer_address"],
            "validator_address": self.validator,
            "amount": {"denom": self.config["chain"]["native_denom"], "amount": "10"},
        }
        args = Namespace(
            tx_hash=transaction_hash,
            voter=self.config["chain"]["deployer_address"],
            kind="delegate",
            junod="junod",
        )
        with patch.object(
            capture.chain,
            "command_json",
            return_value=self.transaction_response(transaction_hash, 0, message),
        ):
            record = capture.command_staking_change(args, self.config)
        self.assertEqual(
            {"hash", "height", "kind", "transaction_evidence"}, set(record)
        )
        self.assertEqual("delegate", record["kind"])
        self.assertEqual(transaction_hash, record["transaction_evidence"]["hash"])

        wrong_message = copy.deepcopy(message)
        wrong_message["amount"]["denom"] = "wrong"
        with patch.object(
            capture.chain,
            "command_json",
            return_value=self.transaction_response(transaction_hash, 0, wrong_message),
        ):
            with self.assertRaisesRegex(capture.ReleaseCaptureError, "native denom"):
                capture.command_staking_change(args, self.config)

    def test_canary_capture_combines_raw_transaction_and_exact_epoch_query(self):
        transaction_hash = "CD" * 32
        message = {
            "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
            "contract": self.addresses["gauge"],
        }
        epoch_response = {
            "gauge_id": 0,
            "epoch_id": 7,
            "snapshot_height": 100,
            "outcome": {"distributed": {"message_count": 1}},
        }
        args = Namespace(
            tx_hash=transaction_hash,
            gauge_id=0,
            epoch_id=7,
            snapshot_height=100,
            distributed_value=5,
            query_height=120,
            junod="junod",
        )
        responses = [
            self.transaction_response(transaction_hash, 0, message, 110),
            {"data": epoch_response},
        ]
        with patch.object(capture.chain, "command_json", side_effect=responses):
            record = capture.command_canary_epoch(args, self.config)
        self.assertEqual(transaction_hash, record["transaction"])
        self.assertEqual(120, record["epoch_query"]["observed_at_height"])
        self.assertEqual(
            {"epoch": {"gauge": 0, "epoch": 7}}, record["epoch_query"]["query"]
        )
        self.assertEqual(epoch_response, record["epoch_query"]["response"])

    def test_smart_query_can_add_snapshot_evidence_name(self):
        query_path = self.fixture.root / "query.json"
        query_path.write_text('{"total_power_at_height":{"height":100}}')
        args = Namespace(
            contract="voting_module",
            query_file=query_path,
            height=120,
            name="first_total_after_change",
            junod="junod",
        )
        with patch.object(
            capture.chain,
            "command_json",
            return_value={"data": {"power": "10", "height": 100}},
        ):
            record = capture.command_smart_query(args, self.config)
        self.assertEqual("first_total_after_change", record["name"])
        self.assertEqual(120, record["observed_at_height"])
        self.assertEqual(self.addresses["voting_module"], record["contract"])

    def test_rehearsal_bundle_enforces_case_code_profile(self):
        args = Namespace(
            transaction=[f"{'EF' * 32}:5"],
            case="adapter_failure",
            junod="junod",
        )
        failed_capture = {"hash": "EF" * 32, "code": 5}
        with patch.object(capture, "capture_transaction", return_value=failed_capture):
            bundle = capture.command_rehearsal_transactions(args, self.config)
        self.assertEqual(["EF" * 32], bundle["transactions"])

        with patch.object(
            capture,
            "capture_transaction",
            return_value={"hash": "EF" * 32, "code": 0},
        ):
            with self.assertRaisesRegex(capture.ReleaseCaptureError, "success/rejection"):
                capture.command_rehearsal_transactions(args, self.config)

    def test_capture_output_must_be_external_new_file(self):
        inside = ROOT / "release" / "would-be-capture.json"
        with self.assertRaisesRegex(deploy.ValidationError, "outside"):
            capture.write_new_output(inside, ROOT, {"fixture": True})

        outside = self.fixture.root / "capture.json"
        capture.write_new_output(outside, ROOT, {"fixture": True})
        self.assertTrue(outside.is_file())
        with self.assertRaisesRegex(capture.ReleaseCaptureError, "overwrite"):
            capture.write_new_output(outside, ROOT, {"fixture": True})

    def test_generated_fragments_round_trip_through_complete_release_gate(self):
        packet = release_tests.ReleaseEvidenceTests(
            "test_complete_evidence_packet_is_accepted"
        )
        packet.setUp()
        try:
            evidence = packet.evidence
            config = packet.config

            stake = evidence["public_testnet"]["snapshot"][
                "stake_change_transactions"
            ][0]
            with patch.object(
                capture.chain,
                "command_json",
                return_value=stake["transaction_evidence"]["response"],
            ):
                generated_stake = capture.command_staking_change(
                    Namespace(
                        tx_hash=stake["hash"],
                        voter=config["chain"]["deployer_address"],
                        kind=stake["kind"],
                        junod="junod",
                    ),
                    config,
                )
            evidence["public_testnet"]["snapshot"][
                "stake_change_transactions"
            ][0] = generated_stake

            historical = evidence["public_testnet"]["snapshot"][
                "historical_power_queries"
            ][0]
            query_path = packet.root / "historical-query.json"
            query_path.write_text(json.dumps(historical["query"]))
            with patch.object(
                capture.chain,
                "command_json",
                return_value={"data": historical["response"]},
            ):
                generated_query = capture.command_smart_query(
                    Namespace(
                        contract="voting_module",
                        query_file=query_path,
                        height=historical["observed_at_height"],
                        name=historical["name"],
                        junod="junod",
                    ),
                    config,
                )
            evidence["public_testnet"]["snapshot"][
                "historical_power_queries"
            ][0] = generated_query

            canary = evidence["canary"]["epochs"][0]
            with patch.object(
                capture.chain,
                "command_json",
                side_effect=[
                    canary["transaction_evidence"]["response"],
                    {"data": canary["epoch_query"]["response"]},
                ],
            ):
                generated_canary = capture.command_canary_epoch(
                    Namespace(
                        tx_hash=canary["transaction"],
                        gauge_id=canary["epoch_query"]["query"]["epoch"]["gauge"],
                        epoch_id=canary["epoch"],
                        snapshot_height=canary["snapshot_height"],
                        distributed_value=canary["distributed_value"],
                        query_height=canary["epoch_query"]["observed_at_height"],
                        junod="junod",
                    ),
                    config,
                )
            evidence["canary"]["epochs"][0] = generated_canary

            rehearsal = next(
                case
                for case in evidence["operations_rehearsal"]["cases"]
                if case["case"] == "governor_recovery"
            )
            specifications = [
                f"{item['hash']}:{item['code']}"
                for item in rehearsal["transaction_evidence"]
            ]
            with patch.object(
                capture.chain,
                "command_json",
                side_effect=[
                    item["response"] for item in rehearsal["transaction_evidence"]
                ],
            ):
                generated_rehearsal = capture.command_rehearsal_transactions(
                    Namespace(
                        transaction=specifications,
                        case=rehearsal["case"],
                        junod="junod",
                    ),
                    config,
                )
            rehearsal["transactions"] = generated_rehearsal["transactions"]
            rehearsal["transaction_evidence"] = generated_rehearsal[
                "transaction_evidence"
            ]

            capture.release.validate_evidence(evidence, packet.root, config)
        finally:
            packet.tearDown()


if __name__ == "__main__":
    unittest.main()
