#!/usr/bin/env python3
"""Verify release authorization against an explicit OpenSSH allowed-signers root."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Any

NAMESPACE = "juno-voice-release-v1"
METHOD = "sshsig"


class AuthorizationError(ValueError):
    pass


def verify_authorization(
    record: Any,
    payload_sha256: str,
    allowed_signers: Path,
    expected_principal: str,
) -> dict[str, str]:
    """Verify an SSHSIG over the lowercase payload hash plus a trailing newline."""
    fields = {"identity", "payload_sha256", "method", "namespace", "signature"}
    if not isinstance(record, dict) or set(record) != fields:
        raise AuthorizationError("authenticated SSH authorization has an unexpected shape")
    for field in fields:
        if not isinstance(record[field], str) or not record[field]:
            raise AuthorizationError(f"authenticated SSH authorization {field} must be nonempty")
    if not isinstance(expected_principal, str) or not expected_principal:
        raise AuthorizationError("authenticated SSH authorization requires an expected principal")
    if record["identity"] != expected_principal:
        raise AuthorizationError(
            "authenticated SSH authorization identity does not match the expected authorization principal"
        )
    if record["payload_sha256"] != payload_sha256:
        raise AuthorizationError("authenticated SSH authorization does not bind the release payload")
    if record["method"] != METHOD or record["namespace"] != NAMESPACE:
        raise AuthorizationError("authenticated SSH authorization must use the required sshsig method and namespace")
    if not isinstance(allowed_signers, Path):
        raise AuthorizationError("authenticated SSH authorization requires an explicit allowed-signers Path")
    if not allowed_signers.is_file():
        raise AuthorizationError("authenticated SSH authorization requires an explicit allowed-signers trust root")
    with tempfile.TemporaryDirectory() as temporary:
        signature_path = Path(temporary) / "authorization.sig"
        signature_path.write_text(record["signature"])
        try:
            result = subprocess.run(
                [
                    "ssh-keygen", "-Y", "verify", "-q",
                    "-f", str(allowed_signers),
                    "-I", expected_principal,
                    "-n", NAMESPACE,
                    "-s", str(signature_path),
                ],
                input=f"{payload_sha256}\n",
                text=True,
                capture_output=True,
                check=False,
            )
        except OSError as error:
            raise AuthorizationError(f"cannot execute ssh-keygen verifier: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip() or "signature is not valid for the trusted identity"
        raise AuthorizationError(f"authenticated SSH authorization failed: {detail}")
    return record
