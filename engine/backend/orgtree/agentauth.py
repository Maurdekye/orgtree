"""Engine-local MCP credentials; the signing key never enters child environments."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets

_key: bytes | None = None


def enable() -> None:
    global _key
    _key = secrets.token_bytes(32)


def child_env(slug: str, nid: str, *, generation: int | None = None) -> dict[str, str]:
    if _key is None:
        return {}
    # Callers holding an Org snapshot already know its generation. Reusing it
    # avoids reloading the whole organization once per forecasted agent. The
    # HTTP authorization path still validates this generation against live state.
    if generation is None:
        from . import store
        with store.DOC_LOCK:
            generation = int(store.load_org(slug).node(nid).get('generation', 0))
    if type(generation) is not int or generation < 0:
        raise ValueError('Invalid agent generation')
    payload = json.dumps([slug, nid, generation], separators=(',', ':')).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip('=')
    signature = hmac.new(_key, encoded.encode(), hashlib.sha256).hexdigest()
    return {'ORGTREE_AGENT_TOKEN': encoded + '.' + signature}


def verify(token: str) -> tuple[str, str, int] | None:
    if not _key or not token:
        return None
    try:
        encoded, signature = token.split('.', 1)
        expected = hmac.new(_key, encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        slug, nid, generation = json.loads(base64.urlsafe_b64decode(
            encoded + '=' * (-len(encoded) % 4)))
        if not isinstance(slug, str) or not isinstance(nid, str) or type(generation) is not int:
            return None
        return slug, nid, generation
    except (ValueError, TypeError):
        return None
