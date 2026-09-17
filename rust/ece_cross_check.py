#!/usr/bin/env python3
"""Cross-language conformance check: Rust encrypt -> Python reference decrypt.

Runs `target/release/ardoise ece-cross` (encrypts a payload with the Rust
RFC 8291 aes128gcm implementation), then:

  1. decrypts the wire bytes with http_ece — the exact crypto the Python
     backend ships via pywebpush (the reference implementation), and
  2. verifies the VAPID JWT (ES256) with `cryptography` against the public
     key derived from the VAPID scalar.

Both checks must pass for the Rust sender to be wire-compatible with the
Python backend and with real browsers (which implement the same RFC).
"""
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ROOT = Path(__file__).resolve().parent
BINARY = ROOT / "target" / "release" / "ardoise"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64url_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def main() -> int:
    if not BINARY.exists():
        print(f"binaire introuvable: {BINARY} (cargo build --release)", file=sys.stderr)
        return 1

    # "Browser" material: the client's ECDH key pair + 16-byte auth secret.
    client = ec.generate_private_key(ec.SECP256R1())
    client_pub = client.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    auth = os.urandom(16)
    payload = "Nouvelle depense : Pizza (42,50 EUR)"
    vapid_scalar = os.urandom(32)

    pid = os.getpid()
    inp = Path(f"/tmp/ece-cross-{pid}.json")
    out_bin = Path(f"/tmp/ece-cross-{pid}.bin")
    out_jwt = Path(f"/tmp/ece-cross-{pid}.jwt")
    out_pub = Path(f"/tmp/ece-cross-{pid}.pub")
    inp.write_text(json.dumps({
        "vapid_private_key": b64url(vapid_scalar),
        "vapid_subject": "mailto:ardoise@example.com",
        "endpoint": "https://fcm.googleapis.com/fcm/send/crosscheck",
        "p256dh": b64url(client_pub),
        "auth": b64url(auth),
        "payload": payload,
    }))

    try:
        subprocess.run(
            [str(BINARY), "ece-cross", str(inp), str(out_bin), str(out_jwt), str(out_pub)],
            check=True,
        )
        wire = out_bin.read_bytes()
        jwt = out_jwt.read_text().strip()
        vapid_pub_bytes = out_pub.read_bytes()

        # 1) Reference decrypt with http_ece (what pywebpush/the Python
        #    backend's crypto does). dh defaults to the keyid in the wire.
        from pywebpush import http_ece

        decrypted = http_ece.decrypt(
            content=wire,
            private_key=client,
            auth_secret=auth,
            version="aes128gcm",
        )
        assert decrypted == payload.encode(), f"payload != : {decrypted!r}"
        print(f"ECE: {len(wire)} octets, http_ece.decrypt() -> {decrypted.decode()!r} OK")

        # 2) VAPID JWT: ES256 over the VAPID public key from the scalar.
        assert len(vapid_pub_bytes) == 65 and vapid_pub_bytes[0] == 0x04
        vapid_pub = ec.EllipticCurvePublicNumbers(
            x=int.from_bytes(vapid_pub_bytes[1:33], "big"),
            y=int.from_bytes(vapid_pub_bytes[33:65], "big"),
            curve=ec.SECP256R1(),
        ).public_key()
        h, c, sig = jwt.split(".")
        raw_sig = b64url_dec(sig)
        # JOSE ES256: raw r || s, 64 bytes (not DER).
        assert len(raw_sig) == 64, f"ES256: 64 octets attendus, {len(raw_sig)} vus"
        der = encode_dss_signature(
            int.from_bytes(raw_sig[:32], "big"),
            int.from_bytes(raw_sig[32:], "big"),
        )
        vapid_pub.verify(der, f"{h}.{c}".encode(), ec.ECDSA(hashes.SHA256()))
        claims = json.loads(b64url_dec(c))
        header = json.loads(b64url_dec(h))
        assert header["alg"] == "ES256", header
        assert claims["aud"] == "https://fcm.googleapis.com", claims
        assert claims["sub"] == "mailto:ardoise@example.com", claims
        assert claims["exp"] > time.time() + 40000, claims
        print(f"VAPID JWT: ES256 OK (aud={claims['aud']}, sub={claims['sub']}, exp~{claims['exp'] - time.time():.0f}s)")
    finally:
        for p in (inp, out_bin, out_jwt, out_pub):
            p.unlink(missing_ok=True)

    print("CROSS-CONFORMANCE OK: wire Rust == reference http_ece/pywebpush")
    return 0


if __name__ == "__main__":
    sys.exit(main())
