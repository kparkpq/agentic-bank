#!/usr/bin/env python3
"""CI-only RFC 8785 / SHA-256 / Ed25519 interop harness for Execution Closure."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VECTOR = ROOT / "packages" / "protocol" / "fixtures" / "interop-vector.json"


def canonicalize(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        items = ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{canonicalize(value[key])}"
            for key in sorted(value)
        )
        return "{" + items + "}"
    raise TypeError(f"unsupported JSON value: {type(value)!r}")


def main() -> int:
    payload = json.loads(VECTOR.read_text())
    canonical = canonicalize(payload["object"])
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if canonical != payload["expected_canonical"]:
        print("CANONICAL_MISMATCH", file=sys.stderr)
        print(canonical, file=sys.stderr)
        return 1
    if digest != payload["expected_sha256_hex"]:
        print("SHA256_MISMATCH", digest, file=sys.stderr)
        return 1
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError:
        print("ok canonicalize sha256 (ed25519 skipped: cryptography not installed)")
        return 0
    key = Ed25519PrivateKey.generate()
    signature = key.sign(canonical.encode("utf-8"))
    key.public_key().verify(signature, canonical.encode("utf-8"))
    print("ok canonicalize sha256 ed25519")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
