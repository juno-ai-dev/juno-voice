import copy
import io
import json
import subprocess
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
        self.key = self.packet.release_key
        self.allowed_signers = self.packet.root / "release-trusted-signers"
        self.authorization_principal = "release-authority"

    def tearDown(self):
        self.packet.tearDown()

    def prepared(self):
        return release_decision.build_payload(
            self.evidence,
            self.config,
            decided_at="2026-08-05T02:00:00Z",
        )

    def declarations(self, prepared):
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
                "method": "unauthenticated-declaration",
                "value": f"declared-by-{identity}",
            }
            for identity in identities
        ]

    def authorization(self, prepared):
        message = self.packet.root / "release-payload"
        signature_path = message.with_suffix(message.suffix + ".sig")
        signature_path.unlink(missing_ok=True)
        message.write_text(prepared["signed_payload_sha256"] + "\n")
        subprocess.run(
            ["ssh-keygen", "-Y", "sign", "-q", "-f", str(self.key), "-n", "juno-voice-release-v2", str(message)],
            check=True,
        )
        signature = message.with_suffix(message.suffix + ".sig").read_text()
        return {
            "identity": "release-authority",
            "payload_sha256": prepared["signed_payload_sha256"],
            "method": "sshsig",
            "namespace": "juno-voice-release-v2",
            "signature": signature,
        }

    def finalize(self, prepared, declarations):
        return release_decision.finalize_decision(
            prepared,
            declarations,
            self.config,
            authorization=self.authorization(prepared),
            allowed_signers=self.allowed_signers,
            authorization_principal=self.authorization_principal,
        )

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
        decision = self.finalize(prepared, self.declarations(prepared))
        self.install_decision(decision)
        release.validate_evidence(
            self.evidence,
            self.packet.root,
            self.config,
            allowed_signers=self.allowed_signers,
            authorization_principal=self.authorization_principal,
        )

    def test_evidence_mutation_after_declaration_invalidates_decision(self):
        prepared = self.prepared()
        decision = self.finalize(prepared, self.declarations(prepared))
        self.install_decision(decision)
        self.evidence["public_testnet"]["scenarios"].reverse()
        with self.assertRaisesRegex(
            release.EvidenceError, "every reviewed release evidence"
        ):
            release.validate_evidence(
                self.evidence,
                self.packet.root,
                self.config,
                allowed_signers=self.allowed_signers,
                authorization_principal=self.authorization_principal,
            )

    def test_tampered_payload_and_incomplete_declarations_are_rejected(self):
        prepared = self.prepared()
        tampered = copy.deepcopy(prepared)
        tampered["decided_at"] = "changed-after-payload-hash"
        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError, "hash does not match"
        ):
            self.finalize(tampered, self.declarations(prepared))

        declarations = self.declarations(prepared)
        declarations[0]["payload_sha256"] = "00" * 32
        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError, "does not bind"
        ):
            self.finalize(prepared, declarations)

        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError, "one declaration per"
        ):
            self.finalize(prepared, self.declarations(prepared)[:-1])

    def test_arbitrary_declarations_cannot_authorize_a_release(self):
        prepared = self.prepared()
        arbitrary = {
            "identity": "release-authority",
            "payload_sha256": prepared["signed_payload_sha256"],
            "method": "fixture",
            "value": "signed-by-anyone",
        }
        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError,
            "authenticated SSH authorization",
        ):
            release_decision.finalize_decision(
                prepared,
                self.declarations(prepared),
                self.config,
                authorization=arbitrary,
                allowed_signers=Path("missing-trust-root"),
                authorization_principal=self.authorization_principal,
            )

        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError,
            "explicit allowed-signers trust root",
        ):
            release_decision.finalize_decision(
                prepared,
                self.declarations(prepared),
                self.config,
                authorization=self.authorization(prepared),
                allowed_signers=self.packet.root / "missing-trust-root",
                authorization_principal=self.authorization_principal,
            )

    def test_unrelated_trusted_signer_cannot_claim_release_authority(self):
        prepared = self.prepared()
        unrelated_key = self.packet.root / "unrelated-release-key"
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(unrelated_key)],
            check=True,
        )
        expected_public_key = self.key.with_suffix(".pub").read_text().strip()
        unrelated_public_key = unrelated_key.with_suffix(".pub").read_text().strip()
        self.allowed_signers.write_text(
            f"{self.authorization_principal} {expected_public_key}\n"
            f"unrelated-signer {unrelated_public_key}\n"
        )
        self.key = unrelated_key
        authorization = self.authorization(prepared)
        authorization["identity"] = "unrelated-signer"

        with self.assertRaisesRegex(
            release_decision.ReleaseDecisionError, "expected authorization principal"
        ):
            release_decision.finalize_decision(
                prepared,
                self.declarations(prepared),
                self.config,
                authorization=authorization,
                allowed_signers=self.allowed_signers,
                authorization_principal=self.authorization_principal,
            )

    def test_required_authorization_parameters_fail_closed(self):
        prepared = self.prepared()
        with self.assertRaises(TypeError):
            release_decision.finalize_decision(
                prepared,
                self.declarations(prepared),
                self.config,
                authorization=self.authorization(prepared),
                allowed_signers=self.allowed_signers,
            )
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            release_decision.parser().parse_args(
                [
                    "--config", "config.json", "--output", "decision.json", "finalize",
                    "--payload", "payload.json", "--declaration", "review.json",
                    "--authorization", "authorization.json", "--allowed-signers", "trusted",
                ]
            )
        self.assertEqual(2, raised.exception.code)

        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "release" / "release_manifest.py"),
                "validate-evidence",
                "--config", "config.json",
                "--evidence", "evidence.json",
                "--allowed-signers", "trusted",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(2, result.returncode)
        self.assertIn("--authorization-principal", result.stderr)

    def test_more_than_four_declarations_are_supported_by_runtime_and_schema(self):
        prepared = self.prepared()
        prepared["signers"]["maintainers"].append("maintainer-three")
        prepared["signed_payload_sha256"] = release.release_decision_payload_sha256(prepared)
        decision = self.finalize(prepared, self.declarations(prepared))
        self.assertEqual(5, len(decision["reviewer_declarations"]))
        schema = json.loads(
            (ROOT / "release" / "release-decision.schema.json").read_text()
        )
        declarations_schema = schema["properties"]["reviewer_declarations"]
        self.assertNotIn("maxItems", declarations_schema)

    def test_schema_closes_payload_evidence_roles_and_declarations(self):
        schema = json.loads(
            (ROOT / "release" / "release-decision.schema.json").read_text()
        )
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        self.assertEqual(
            {
                *release.RELEASE_DECISION_PAYLOAD_FIELDS,
                "signed_payload_sha256",
                "reviewer_declarations",
                "authorization_record",
            },
            set(schema["required"]),
        )
        bound = schema["$defs"]["boundEvidence"]
        self.assertFalse(bound["additionalProperties"])
        self.assertEqual(
            set(release.RELEASE_DECISION_EVIDENCE_FIELDS), set(bound["required"])
        )
        self.assertEqual(set(bound["required"]), set(bound["properties"]))
        declaration = schema["$defs"]["declaration"]
        self.assertFalse(declaration["additionalProperties"])
        self.assertEqual(set(declaration["required"]), set(declaration["properties"]))
        authorization = schema["$defs"]["authorizationRecord"]
        self.assertFalse(authorization["additionalProperties"])
        self.assertEqual(set(authorization["required"]), set(authorization["properties"]))

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
