import copy
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "release"))
sys.path.insert(0, str(ROOT / "deployment"))
import gas_report  # noqa: E402
import juno_voice_deploy as deploy  # noqa: E402
import release_manifest as release  # noqa: E402
import test_juno_voice_deploy as deploy_tests  # noqa: E402
import test_release_manifest as release_tests  # noqa: E402


class GasReportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = deploy_tests.DeploymentPlannerTests(
            "test_valid_config_and_address_derivation"
        )
        self.fixture.setUp()
        self.config = self.fixture.config
        self.gas = {
            "safety_margin_bps": 2000,
            "measurements": [
                {"case": case, "fixture": True}
                for case in sorted(release.REQUIRED_GAS_CASES)
            ],
        }

    def tearDown(self):
        self.fixture.tearDown()

    def prepared(self, gas=None):
        return gas_report.build_payload(
            self.gas if gas is None else gas,
            self.config,
            measured_by="gas-operator",
            reviewed_by="independent-gas-reviewer",
            measured_at="2026-08-05T00:00:00Z",
            reviewed_at="2026-08-05T01:00:00Z",
            methodology="instrumented target-chain configured-maximum observations",
        )

    def declarations(self, prepared):
        return [
            {
                "identity": identity,
                "payload_sha256": prepared["signed_payload_sha256"],
                "method": "unauthenticated-declaration",
                "value": f"declared-by-{identity}",
            }
            for identity in (prepared["measured_by"], prepared["reviewed_by"])
        ]

    def test_prepare_and_finalize_bind_measurements_roles_and_payload(self):
        prepared = self.prepared()
        report = gas_report.finalize_report(
            prepared, self.declarations(prepared), self.config
        )
        release.validate_gas_report_document(report, self.gas, self.config)
        self.assertEqual(
            deploy.sha256_bytes(deploy.canonical_json(self.gas["measurements"])),
            report["measurements_sha256"],
        )

    def test_tampered_payload_measurements_and_declarations_are_rejected(self):
        prepared = self.prepared()
        tampered = copy.deepcopy(prepared)
        tampered["methodology"] = "changed after signing"
        with self.assertRaisesRegex(gas_report.GasReportError, "payload hash"):
            gas_report.finalize_report(
                tampered, self.declarations(prepared), self.config
            )

        declarations = self.declarations(prepared)
        declarations[0]["payload_sha256"] = "00" * 32
        with self.assertRaisesRegex(gas_report.GasReportError, "does not bind"):
            gas_report.finalize_report(prepared, declarations, self.config)

        report = gas_report.finalize_report(
            prepared, self.declarations(prepared), self.config
        )
        changed_gas = copy.deepcopy(self.gas)
        changed_gas["measurements"][0]["fixture"] = False
        with self.assertRaisesRegex(release.EvidenceError, "does not bind"):
            release.validate_gas_report_document(report, changed_gas, self.config)

        with self.assertRaisesRegex(gas_report.GasReportError, "must be distinct"):
            gas_report.build_payload(
                self.gas,
                self.config,
                measured_by="same-person",
                reviewed_by="same-person",
                measured_at="2026-08-05T00:00:00Z",
                reviewed_at="2026-08-05T01:00:00Z",
                methodology="fixture",
            )

    def test_schema_closes_the_exact_report_and_signature_shapes(self):
        schema = json.loads((ROOT / "release" / "gas-report.schema.json").read_text())
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        self.assertEqual(
            {*release.GAS_REPORT_PAYLOAD_FIELDS, "signed_payload_sha256", "declarations"},
            set(schema["required"]),
        )
        cases = [
            item["const"]
            for item in schema["properties"]["measurement_cases"]["prefixItems"]
        ]
        self.assertEqual(sorted(release.REQUIRED_GAS_CASES), cases)
        declaration = schema["$defs"]["declaration"]
        self.assertFalse(declaration["additionalProperties"])
        self.assertEqual(set(declaration["required"]), set(declaration["properties"]))

    def test_constructed_report_round_trips_through_complete_release_gate(self):
        packet = release_tests.ReleaseEvidenceTests(
            "test_complete_evidence_packet_is_accepted"
        )
        packet.setUp()
        try:
            gas = packet.evidence["gas"]
            prepared = gas_report.build_payload(
                {
                    "safety_margin_bps": gas["safety_margin_bps"],
                    "measurements": gas["measurements"],
                },
                packet.config,
                measured_by="roundtrip-gas-operator",
                reviewed_by="roundtrip-independent-reviewer",
                measured_at="2026-08-05T00:00:00Z",
                reviewed_at="2026-08-05T01:00:00Z",
                methodology="round-trip fixture",
            )
            report = gas_report.finalize_report(
                prepared, self.declarations(prepared), packet.config
            )
            report_path = packet.root / gas["report"]["path"]
            report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
            gas["report"]["sha256"] = deploy.sha256_file(report_path)

            packet.resign_release_decision(packet.evidence)

            release.validate_evidence(
                packet.evidence,
                packet.root,
                packet.config,
                allowed_signers=packet.root / "release-trusted-signers",
                authorization_principal="release-authority",
            )
        finally:
            packet.tearDown()


if __name__ == "__main__":
    unittest.main()
