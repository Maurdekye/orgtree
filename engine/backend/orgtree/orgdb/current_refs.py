"""Physical links for current docket roles, separate from their authored values.

An unchanged role retains its already resolved identity through a rename. A new
role follows design §3.0: birth stamp first, otherwise directional generation;
missing, deleted or replaced identities point to an identity-specific tombstone.
Historical principals never call this resolver.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable, Mapping

from . import codec, principal_columns


def exact(value: Any) -> str:
    """Identity comparisons retain scalar types, unlike Python dict equality."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def recorded_identity(value: Any) -> Any:
    """Holder metadata such as `from` and `by` cannot change its physical role."""
    return {k: v for k, v in value.items() if k in ('node', 'born', 'generation', 'deleted')} \
        if isinstance(value, Mapping) else value


@dataclass(frozen=True)
class Reference:
    name: str
    born: str
    generation: int
    deleted: bool

    @property
    def stamp(self) -> tuple[str, str, int]:
        return self.name, self.born, self.generation

    def tombstone_record(self) -> dict[str, Any]:
        return dict(state='deleted', seat_id=self.born, generation=self.generation)


def reference(value: Any) -> Reference | None:
    """Only supported agent roles acquire a link; misfits remain exact in extra."""
    if isinstance(value, str):
        value = {'node': value}
    if not isinstance(value, Mapping):
        return None
    name = value.get('node')
    if (not codec.fits('text', name) or not name
            or principal_columns.kind(name) != 'agent'):
        return None
    born, generation, deleted = (value.get(k) for k in ('born', 'generation', 'deleted'))
    if (born is not None and not codec.fits('text', born)
            or generation is not None and not codec.fits('int', generation)
            or deleted is not None and not codec.fits('bool', deleted)):
        return None
    return Reference(name, born or '', generation or 0, deleted or False)


def continues(ref: Reference, row: Mapping[str, Any]) -> bool:
    """Retiring does not change an identity; authorization still reads its state."""
    if ref.deleted or row.get('tombstone'):
        return False
    if ref.born:
        return ref.born == str(row.get('seat_id') or '')
    generation = row.get('generation') or 0
    try:
        return int(generation) >= ref.generation
    except (TypeError, ValueError, OverflowError):
        return False


class Resolver:
    """Point lookup and tombstone insertion supplied by conversion or a writer."""

    def __init__(self, find: Callable[[str], Mapping[str, Any] | None],
                 tombstone: Callable[[Reference], int]) -> None:
        self.find = find
        self.tombstone = tombstone

    def __call__(self, value: Any, previous: Any = codec.MISSING,
                 previous_id: int | None = None) -> int | None:
        ref = reference(value)
        if ref is None:
            return None
        if (previous_id is not None and previous is not codec.MISSING
                and exact(recorded_identity(value)) == exact(recorded_identity(previous))):
            return previous_id
        row = self.find(ref.name)
        if row is not None and continues(ref, row):
            return int(row['id'])
        return self.tombstone(ref)


def seat_reviewer(seat: Mapping[str, Any]) -> Any:
    """A reviewer matching the holder uses its stamp, never a live namesake."""
    reviewer, holder = seat.get('reviewer', codec.MISSING), seat.get('holder')
    if isinstance(holder, Mapping) and reviewer == holder.get('node'):
        return holder
    return reviewer
