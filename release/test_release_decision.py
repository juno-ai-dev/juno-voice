import copy
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "release"))
sys.path.insert(0, str(ROOT / "deployment"))
import juno_voice_deploy as deploy  # noqa: E402
import release_decision  # noqa: E402
import release_manifest as release  # noqa: E402
import test_release_manifest as release_tests  # noqa: E402


class ReleaseDecisionTests(unittest.TestCase):
    def setUp(self):
        self.packet = release_tests.ReleaseEvidenceTests(
            "test_complete_evidence_packet_is_accepted"
        )
        self.packet.setUp()
        self.evidence = self.packet.evidence
        self.config = self.packet.config

    def tearDown(self):
        self.packet.tearDown()

    def prepared(self):
        return release_decision.build_payload(
            self.evidence,
            self.config,
            decided_at="2026-08-05T02:00:00Z",
        )

    def signatures(self, prepared):
        signers = prepared["signers"]
        identities = [
            *signers["maintainers"],
            signers["security_reviewer"],
            signers["operations_reviewer"],
        ]
        return [
            {
                "identity": identity,
                "payload_sha256": prepared["signed_payload_sha256"],
                "method": "fixture",
                "value": f"signed-by-{identity}",
            }
            for identity in identities
        ]

    def install_decision(self, document):
        reference = self.evidence["release_signoff"]["decision"]
        path = self.packet.root / reference["path"]
        path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        reference["sha256"] = deploy.sha256_file(path)

    def test_prepared_and_finalized_decision_passes_complete_release_gate(self):
        prepared = self.prepared()
        unsigned_candidate = copy.deepcopy(self.evidence)
        unsigned_candidate["release_signoff"].pop("decision")
        self.assertEqual(
            prepared["bound_evidence"]["reviewed_evidence_sha256"],
            release_decision.build_payload(
                unsigned_candidate,
                self.config,
                decided_at=prepared["decided_at"],
            )["bound_evidence"]["reviewed_evidence_sha256"],
        )
        decision = release_decision.finalize_decision(
            prepared, self.signatures(prepared), self.config
        )
        self.install_decision(decision)
        release.validate_evidence(self.evidence, self.packet.root, self.config)

    def test_evidence_mutation_after_signing_invalidates_decision(self):
        prepared = self.prepared()
        decision = release_decision.finalize_decision(
            prepared, self.signatures(prepared), self.config
        )
        self.install_decision(decision)
        self.evidence["public_testnet"]["scenarios"].reverse()
        with self.assertRaisesRegex(
            release.EvidenceError, "every reviewed release evidence"
        ):
            release.validate_evidence(self.evidence, self.packet.root, self.config)

    def test_tampered_payload_and_incomplete_signatures_are_rejected(self):
        prepared = self.prepared()
        tampered = copy.deepcopy(prepared)
        tampered["decided_at"] = "changed-after-payload-hash"
        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError, "hash does not match"
        ):
            release_decision.finalize_decision(
                tampered, self.signatures(prepared), self.config
            )

        signatures = self.signatures(prepared)
        signatures[0]["payload_sha256"] = "00" * 32
        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError, "does not bind"
        ):
            release_decision.finalize_decision(prepared, signatures, self.config)

        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError, "one signature per"
        ):
            release_decision.finalize_decision(
                prepared, self.signatures(prepared)[:-1], self.config
            )

    def test_schema_closes_payload_evidence_roles_and_signatures(self):
        schema = json.loads(
            (ROOT / "release" / "release-decision.schema.json").read_text()
        )
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        self.assertEqual(
            {
                *release.RELEASE_DECISION_PAYLOAD_FIELDS,
                "signed_payload_sha256",
                "signatures",
            },
            set(schema["required"]),
        )
        bound = schema["$defs"]["boundEvidence"]
        self.assertFalse(bound["additionalProperties"])
        self.assertEqual(
            set(release.RELEASE_DECISION_EVIDENCE_FIELDS), set(bound["required"])
        )
        self.assertEqual(set(bound["required"]), set(bound["properties"]))
        signature = schema["$defs"]["signature"]
        self.assertFalse(signature["additionalProperties"])
        self.assertEqual(set(signature["required"]), set(signature["properties"]))

    def test_prepare_cli_validates_unsigned_candidate_before_writing(self):
        candidate = copy.deepcopy(self.evidence)
        candidate["release_signoff"].pop("decision")
        config_path = self.packet.root / "deployment-config.json"
        evidence_path = self.packet.root / "evidence-candidate.json"
        config_path.write_text(json.dumps(self.config, indent=2, sort_keys=True) + "\n")
        evidence_path.write_text(
            json.dumps(candidate, indent=2, sort_keys=True) + "\n"
        )
        with tempfile.TemporaryDirectory() as external:
            output = Path(external) / "decision-payload.json"
            arguments = [
                "release_decision.py",
                "--root",
                str(self.packet.root),
                "--config",
                str(config_path),
                "--output",
                str(output),
                "prepare",
                "--evidence",
                str(evidence_path),
                "--decided-at",
                "2026-08-05T02:00:00Z",
            ]
            with patch.object(sys, "argv", arguments), patch.object(
                release_decision.deploy, "load_config", return_value=self.config
            ):
                self.assertEqual(0, release_decision.main())
            self.assertTrue(output.is_file())

            candidate["public_testnet"]["scenarios"][0]["status"] = "failed"
            evidence_path.write_text(
                json.dumps(candidate, indent=2, sort_keys=True) + "\n"
            )
            rejected_output = Path(external) / "rejected-payload.json"
            arguments[arguments.index(str(output))] = str(rejected_output)
            with patch.object(sys, "argv", arguments), patch.object(
                release_decision.deploy, "load_config", return_value=self.config
            ), redirect_stderr(io.StringIO()):
                self.assertEqual(2, release_decision.main())
            self.assertFalse(rejected_output.exists())


if __name__ == "__main__":
    unittest.main()
