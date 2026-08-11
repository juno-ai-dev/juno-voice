import copy
import json
import sys
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deployment"))
from test_juno_voice_deploy import DeploymentPlannerTests  # noqa: E402

import juno_voice_deploy as deploy  # noqa: E402
import uni7_capture as capture  # noqa: E402


class Uni7CaptureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = DeploymentPlannerTests("test_valid_config_and_address_derivation")
        self.fixture.setUp()
        self.config = self.fixture.config
        self.state = deploy.empty_state(self.config)
        self.state["code_ids"] = {
            name: index for index, name in enumerate(deploy.REQUIRED_ARTIFACTS, start=101)
        }
        self.state["verified"] = {"report": "verification.json", "sha256": "12" * 32}
        self.transcript_path = self.fixture.root / "outside-transcript.json"

    def tearDown(self):
        self.fixture.tearDown()

    def test_transcript_schema_closes_deployment_maps_and_required_profiles(self):
        schema = json.loads((ROOT / "integration" / "transcript.schema.json").read_text())
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            set(capture.release.REQUIRED_SCENARIOS),
            set(schema["properties"]["scenario_id"]["enum"]),
        )
        for definition_name in ("codeChecksums", "codeIds"):
            definition = schema["$defs"][definition_name]
            self.assertFalse(definition["additionalProperties"])
            self.assertEqual(set(deploy.REQUIRED_ARTIFACTS), set(definition["required"]))
            self.assertEqual(set(definition["required"]), set(definition["properties"]))
        addresses = schema["$defs"]["addresses"]
        self.assertEqual(set(deploy.derive_addresses(self.config)), set(addresses["required"]))
        self.assertFalse(addresses["additionalProperties"])
        transaction = schema["$defs"]["transactionEvidence"]
        self.assertEqual(set(transaction["required"]), set(transaction["properties"]))
        self.assertFalse(transaction["additionalProperties"])
        event = schema["$defs"]["transactionEvent"]
        attribute = schema["$defs"]["eventAttribute"]
        self.assertFalse(event["additionalProperties"])
        self.assertFalse(attribute["additionalProperties"])
        self.assertEqual({"type", "attributes"}, set(event["required"]))
        self.assertEqual({"key", "value"}, set(attribute["required"]))
        self.assertEqual(
            {"$ref": "#/$defs/transactionEvent"},
            transaction["properties"]["events"]["items"],
        )
        self.assertEqual(
            {"$ref": "#/$defs/transactionMessage"},
            transaction["properties"]["messages"]["items"],
        )
        self.assertEqual(
            ["@type"], schema["$defs"]["transactionMessage"]["required"]
        )
        self.assertIs(True, schema["$defs"]["linkedAssertion"]["properties"]["passed"]["const"])

    def test_init_binds_deployment_and_finalize_requires_real_evidence(self):
        args = Namespace(
            scenario="multi_fund_ratify_pay",
            transcript=self.transcript_path,
        )
        capture.command_init(args, self.config, self.state)
        transcript = capture.load_transcript(self.transcript_path)
        self.assertEqual(self.state["code_ids"], transcript["code_ids"])
        self.assertEqual(deploy.derive_addresses(self.config), transcript["addresses"])
        with self.assertRaisesRegex(capture.CaptureError, "transaction"):
            capture.command_finalize(args, transcript)

        payout_event = {
            "type": "wasm-juno_voice_bounties.ratification_finalized",
            "attributes": [
                {"key": "_contract_address", "value": transcript["addresses"]["bounty"]},
                {"key": "bounty_id", "value": "1"},
                {"key": "round", "value": "1"},
                {"key": "outcome", "value": "paid"},
                {"key": "yes_weight", "value": "2"},
                {"key": "no_weight", "value": "0"},
                {"key": "participating_weight", "value": "2"},
                {"key": "next_status", "value": "paid"},
            ],
        }
        transcript.update(
            {
                "transactions": ["AB" * 32],
                "transaction_evidence": [
                    {
                        "hash": "AB" * 32,
                        "height": 10,
                        "code": 0,
                        "gas_wanted": 2,
                        "gas_used": 1,
                        "response_sha256": "34" * 32,
                        "response": {"fixture": True},
                        "messages": [{"@type": "/cosmwasm.wasm.v1.MsgExecuteContract"}],
                        "events": [payout_event],
                    }
                ],
                "queries": [
                    {
                        "height": 10,
                        "contract": transcript["addresses"]["bounty"],
                        "query": {"bounty": {"bounty_id": 1}},
                        "response": {
                            "bounty": {
                                "id": 1,
                                "status": "paid",
                                "total_contribution": "100",
                                "paid_amount": "100",
                                "refunded_amount": "0",
                                "paid_recipient": transcript["addresses"]["registry"],
                            }
                        },
                        "response_sha256": deploy.sha256_bytes(
                            deploy.canonical_json(
                                {
                                    "bounty": {
                                        "id": 1,
                                        "status": "paid",
                                        "total_contribution": "100",
                                        "paid_amount": "100",
                                        "refunded_amount": "0",
                                        "paid_recipient": transcript["addresses"]["registry"],
                                    }
                                }
                            )
                        ),
                    },
                    {
                        "height": 10,
                        "contract": transcript["addresses"]["bounty"],
                        "query": {
                            "receipts": {
                                "bounty_id": 1,
                                "round": 1,
                                "start_after": None,
                                "limit": 100,
                            }
                        },
                        "response": {
                            "receipts": [
                                {
                                    "bounty_id": 1,
                                    "round": 1,
                                    "voter": transcript["addresses"]["registry"],
                                    "weight": "60",
                                },
                                {
                                    "bounty_id": 1,
                                    "round": 1,
                                    "voter": transcript["addresses"]["agent_operations"],
                                    "weight": "40",
                                },
                            ]
                        },
                        "response_sha256": deploy.sha256_bytes(
                            deploy.canonical_json(
                                {
                                    "receipts": [
                                        {
                                            "bounty_id": 1,
                                            "round": 1,
                                            "voter": transcript["addresses"]["registry"],
                                            "weight": "60",
                                        },
                                        {
                                            "bounty_id": 1,
                                            "round": 1,
                                            "voter": transcript["addresses"][
                                                "agent_operations"
                                            ],
                                            "weight": "40",
                                        },
                                    ]
                                }
                            )
                        ),
                    },
                ],
                "balances": [
                    {
                        "label": "before",
                        "height": 9,
                        "address": self.config["chain"]["deployer_address"],
                        "denom": "ujuno",
                        "amount": "10",
                    },
                    {
                        "label": "after",
                        "height": 10,
                        "address": self.config["chain"]["deployer_address"],
                        "denom": "ujuno",
                        "amount": "11",
                    },
                ],
                "assertions": [
                    {
                        "name": "bounty_paid_state",
                        "predicate": "query_response_equals",
                        "source": {"query_index": 0},
                        "expected": {
                            "bounty": {
                                "id": 1,
                                "status": "paid",
                                "total_contribution": "100",
                                "paid_amount": "100",
                                "refunded_amount": "0",
                                "paid_recipient": transcript["addresses"]["registry"],
                            }
                        },
                        "actual": {
                            "bounty": {
                                "id": 1,
                                "status": "paid",
                                "total_contribution": "100",
                                "paid_amount": "100",
                                "refunded_amount": "0",
                                "paid_recipient": transcript["addresses"]["registry"],
                            }
                        },
                        "passed": True,
                    },
                    {
                        "name": "contributor_receipts_state",
                        "predicate": "query_response_equals",
                        "source": {"query_index": 1},
                        "expected": {
                            "receipts": [
                                {
                                    "bounty_id": 1,
                                    "round": 1,
                                    "voter": transcript["addresses"]["registry"],
                                    "weight": "60",
                                },
                                {
                                    "bounty_id": 1,
                                    "round": 1,
                                    "voter": transcript["addresses"]["agent_operations"],
                                    "weight": "40",
                                },
                            ]
                        },
                        "actual": {
                            "receipts": [
                                {
                                    "bounty_id": 1,
                                    "round": 1,
                                    "voter": transcript["addresses"]["registry"],
                                    "weight": "60",
                                },
                                {
                                    "bounty_id": 1,
                                    "round": 1,
                                    "voter": transcript["addresses"]["agent_operations"],
                                    "weight": "40",
                                },
                            ]
                        },
                        "passed": True,
                    },
                    {
                        "name": "recipient_balance_delta",
                        "predicate": "balance_delta_equals",
                        "source": {"before_index": 0, "after_index": 1},
                        "expected": "1",
                        "actual": "1",
                        "passed": True,
                    },
                    {
                        "name": "payout_event",
                        "predicate": "transaction_event_equals",
                        "source": {"transaction_hash": "AB" * 32, "event_index": 0},
                        "expected": payout_event,
                        "actual": payout_event,
                        "passed": True,
                    },
                ],
            }
        )
        weak_query = copy.deepcopy(transcript)
        weak_query["queries"][0]["query"] = {"health": {}}
        with self.assertRaisesRegex(capture.CaptureError, "bounty.*query variant"):
            capture.command_finalize(args, weak_query)
        weak = copy.deepcopy(transcript)
        unrelated = {
            "type": "wasm",
            "attributes": [
                {
                    "key": "_contract_address",
                    "value": transcript["addresses"]["bounty"],
                }
            ],
        }
        weak["transaction_evidence"][0]["events"] = [unrelated]
        weak["assertions"][3]["expected"] = unrelated
        weak["assertions"][3]["actual"] = unrelated
        with self.assertRaisesRegex(capture.CaptureError, "ratification_finalized"):
            capture.command_finalize(args, weak)
        capture.command_finalize(args, transcript)
        finalized = json.loads(self.transcript_path.read_text())
        self.assertTrue(finalized["passed"])
        with self.assertRaisesRegex(capture.CaptureError, "immutable"):
            capture.load_transcript(self.transcript_path)

    def test_linked_query_assertion_computes_result_from_capture(self):
        capture.command_init(
            Namespace(scenario="failed_turnout_no_distribution", transcript=self.transcript_path),
            self.config,
            self.state,
        )
        transcript = capture.load_transcript(self.transcript_path)
        transcript["queries"].append(
            {
                "response": {"messages": ["unexpected"]},
            }
        )
        expected = self.fixture.root / "expected.json"
        expected.write_text('{"messages":[]}')
        capture.command_assert_query(
            Namespace(
                name="no-transfers",
                query_index=0,
                expected=expected,
                transcript=self.transcript_path,
            ),
            transcript,
        )
        recorded = json.loads(self.transcript_path.read_text())
        self.assertFalse(recorded["assertions"][0]["passed"])
        self.assertEqual(
            {"messages": ["unexpected"]}, recorded["assertions"][0]["actual"]
        )

    def test_capture_tx_accepts_only_the_declared_failure_code(self):
        capture.command_init(
            Namespace(
                scenario="guardian_stop_governor_recovery",
                transcript=self.transcript_path,
            ),
            self.config,
            self.state,
        )
        transcript = capture.load_transcript(self.transcript_path)
        transaction_hash = "CD" * 32
        response = {
            "txhash": transaction_hash,
            "height": "10",
            "code": 5,
            "gas_wanted": "2",
            "gas_used": "1",
            "events": [
                {
                    "type": "message",
                    "attributes": [{"key": "action", "value": "fixture"}],
                }
            ],
            "tx": {"body": {"messages": [{"@type": "/fixture.Msg"}]}},
        }
        args = Namespace(
            tx_hash=transaction_hash,
            expected_code=5,
            junod="junod",
            transcript=self.transcript_path,
        )
        with patch.object(capture, "command_json", return_value=response):
            capture.command_capture_tx(args, self.config, transcript)
        recorded = json.loads(self.transcript_path.read_text())
        self.assertEqual(5, recorded["transaction_evidence"][0]["code"])

        other_path = self.fixture.root / "other-transcript.json"
        capture.command_init(
            Namespace(
                scenario="guardian_stop_governor_recovery",
                transcript=other_path,
            ),
            self.config,
            self.state,
        )
        args.transcript = other_path
        with patch.object(capture, "command_json", return_value=response):
            with self.assertRaisesRegex(capture.CaptureError, "does not match expected"):
                args.expected_code = 0
                capture.command_capture_tx(
                    args, self.config, capture.load_transcript(other_path)
                )

        outside_path = self.fixture.root / "outside-destination-transcript.json"
        capture.command_init(
            Namespace(
                scenario="guardian_stop_governor_recovery",
                transcript=outside_path,
            ),
            self.config,
            self.state,
        )
        outside_response = copy.deepcopy(response)
        outside_response["tx"]["body"]["messages"] = [
            {
                "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
                "contract": self.config["chain"]["deployer_address"],
            }
        ]
        args.transcript = outside_path
        args.expected_code = 5
        with patch.object(capture, "command_json", return_value=outside_response):
            with self.assertRaisesRegex(capture.CaptureError, "not a verified"):
                capture.command_capture_tx(
                    args, self.config, capture.load_transcript(outside_path)
                )


if __name__ == "__main__":
    unittest.main()
