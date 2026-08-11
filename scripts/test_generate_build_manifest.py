import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("generate-build-manifest.py")
SPEC = importlib.util.spec_from_file_location("generate_build_manifest", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load build manifest generator")
build_manifest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_manifest)


class BuildManifestGeneratorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        for index, filename in enumerate(build_manifest.ARTIFACTS, start=1):
            (self.artifacts / filename).write_bytes(b"\0asm" + bytes([index]) * 32)
        for relative, _repository in build_manifest.SCHEMAS.values():
            schema = self.root / relative
            schema.parent.mkdir(parents=True, exist_ok=True)
            schema.write_text('{"fixture":true}\n')
        self.parent_commit = "ab" * 20
        self.dao_commit = "cd" * 20
        self.optimizer = f"cosmwasm/optimizer@sha256:{'12' * 32}"
        (self.artifacts / "build-provenance.txt").write_text(
            "\n".join(
                (
                    f"parent_commit={self.parent_commit}",
                    f"dao_contracts_commit={self.dao_commit}",
                    f"optimizer_image={self.optimizer}",
                    "juno_voice_rust=1.85.1",
                    "dao_contracts_rust=1.81.0",
                    "juno_voice_cosmwasm_check=3.0.4",
                    "dao_contracts_cosmwasm_check=1.5.11",
                    "wasm_tools=1.254.0",
                    "recursive_clone_rebuilds=2",
                )
            )
            + "\n"
        )
        (self.artifacts / "build-tools.txt").write_text(
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
            + "\n"
        )
        entries = [
            (
                filename,
                build_manifest.digest(self.artifacts / filename),
                (self.artifacts / filename).stat().st_size,
            )
            for filename in build_manifest.ARTIFACTS
        ]
        (self.artifacts / "checksums.txt").write_text(
            "\n".join(f"{checksum}  {filename}" for filename, checksum, _size in entries)
            + "\n"
        )
        (self.artifacts / "sizes.txt").write_text(
            "\n".join(
                [
                    *(f"{size} {filename}" for filename, _checksum, size in entries),
                    f"{sum(size for _filename, _checksum, size in entries)} total",
                ]
            )
            + "\n"
        )
        self.output = self.artifacts / "build-manifest.json"

    def tearDown(self):
        self.temporary.cleanup()

    def run_generator(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--artifacts",
                str(self.artifacts),
                "--source-root",
                str(self.root),
                "--output",
                str(self.output),
                "--parent-commit",
                self.parent_commit,
                "--dao-contracts-commit",
                self.dao_commit,
                "--optimizer-image",
                self.optimizer,
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_generator_binds_all_artifact_schema_and_tool_bytes(self):
        completed = self.run_generator()
        self.assertEqual(0, completed.returncode, completed.stderr)
        manifest = json.loads(self.output.read_text())
        self.assertEqual("1.254.0", manifest["builder"]["wasm_tools"])
        self.assertEqual(
            build_manifest.digest(self.artifacts / "build-tools.txt"),
            manifest["build_evidence"]["build_tools_sha256"],
        )
        self.assertEqual(5, len(manifest["artifacts"]))
        self.assertEqual(5, len(manifest["schemas"]))

    def test_generator_rejects_substituted_validator_identity(self):
        tools = self.artifacts / "build-tools.txt"
        tools.write_text(
            tools.read_text().replace(
                "wasm-tools 1.254.0", "wasm-tools 1.254.0 substituted"
            )
        )
        completed = self.run_generator()
        self.assertNotEqual(0, completed.returncode)
        self.assertIn("exact build tool identities", completed.stderr)

    def test_generator_rejects_floating_source_identity(self):
        self.parent_commit = "main"
        completed = self.run_generator()
        self.assertNotEqual(0, completed.returncode)
        self.assertIn("40 lowercase hexadecimal", completed.stderr)


if __name__ == "__main__":
    unittest.main()
