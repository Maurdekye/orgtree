"""A run's signed identity, separate from its unchanged seat credential.

The signing key stays in the app database and trusted engine memory. Child
transports get only a signed claim; an old transport keeps its old claim.
Verification authenticates the claim. Authorization still comes from the
request row's FOR SHARE lock in the actual tool/result transaction.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import hashlib
import hmac
import json
from typing import Any, Callable, Iterator
from uuid import UUID

HEADER = 'X-Orgtree-Turn-Token'
ENV = 'ORGTREE_TURN_TOKEN'


@dataclass(frozen=True)
class Run:
    org: str
    agent: str
    org_id: int
    agent_id: int
    request_id: str
    epoch: int
    owner: int
    token: str

    def __post_init__(self) -> None:
        if not self.org or not self.agent or not isinstance(self.org, str) or not isinstance(self.agent, str):
            raise ValueError('run needs an org and agent name')
        for name in ('org_id', 'agent_id', 'epoch', 'owner'):
            if type(getattr(self, name)) is not int or not 0 < getattr(self, name) < 2 ** 63:
                raise ValueError('run ' + name + ' must fit a positive database bigint')
        if type(self.request_id) is not str or type(self.token) is not str:
            raise ValueError('run identities must be canonical UUIDs')
        if str(UUID(self.request_id)) != self.request_id or str(UUID(self.token)) != self.token:
            raise ValueError('run identities must be canonical UUIDs')


_current: ContextVar[Run | None] = ContextVar('orgtree_durable_run', default=None)


def current() -> Run | None:
    return _current.get()


@contextmanager
def bind(run: Run | None) -> Iterator[None]:
    saved = _current.set(run)
    try:
        yield
    finally:
        _current.reset(saved)


def sign(run: Run, key: bytes) -> str:
    if not isinstance(key, bytes) or len(key) != 32:
        raise ValueError('turn signing key must be 32 bytes')
    payload = [1, run.org, run.agent, run.org_id, run.agent_id,
               run.request_id, run.epoch, run.owner, run.token]
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':'),
                                                 ensure_ascii=True).encode()).decode().rstrip('=')
    return encoded + '.' + hmac.new(key, encoded.encode(), hashlib.sha256).hexdigest()


def verify(credential: str, key_for: Callable[[int], bytes | None]) -> Run | None:
    """Bounded parser and owner-key lookup; never consult current RAM identity."""
    if not isinstance(credential, str) or not 1 <= len(credential) <= 4096:
        return None
    try:
        encoded, signature = credential.split('.', 1)
        payload = json.loads(base64.b64decode(encoded + '=' * (-len(encoded) % 4),
                                            altchars=b'-_', validate=True))
        if not isinstance(payload, list) or len(payload) != 9 or type(payload[0]) is not int or payload[0] != 1:
            return None
        run = Run(*payload[1:])
        key = key_for(run.owner)
        if not isinstance(key, bytes) or len(key) != 32:
            return None
        expected = hmac.new(key, encoded.encode(), hashlib.sha256).hexdigest()
        return run if hmac.compare_digest(signature, expected) else None
    except (ValueError, TypeError, UnicodeError):
        return None


def fence(raw: Any, org: str, org_id: int) -> None:
    """Called before the transaction locks any lower-tier rows."""
    run = current()
    if run is None:
        return
    if (org, org_id) != (run.org, run.org_id):
        raise RuntimeError('run fence must use its own org transaction connection')
    from .turn_requests import fence as request_fence
    request_fence(raw, run)
