"""Exact typed storage for the ledger's tagged running sums (schema gap G6).

The integer path is unbounded; the float path keeps its compensation separately.
These helpers return record-local extra fields for the existing JSON escape codec.
They do not calculate a new estimate or interpret an exceptional legacy value.
"""

from __future__ import annotations

from decimal import Decimal
import math
from typing import Any, Mapping

from . import codec


def columns(key: str) -> tuple[tuple[str, str], ...]:
    """The complete physical fragment for one sum state."""
    return ((key + '_is', 'char(1)'), (key + '_kind', 'char(1)'),
            (key + '_integer', 'numeric'), (key + '_float', 'double precision'),
            (key + '_compensation', 'double precision'))


def encode(key: str, value: Any = codec.MISSING) -> tuple[dict[str, Any], dict[str, Any]]:
    """Typed columns and an extra fragment for one original sum-state key."""
    row: dict[str, Any] = {key + suffix: None for suffix in
                           ('_is', '_kind', '_integer', '_float', '_compensation')}
    extra: dict[str, Any] = {}
    if value is codec.MISSING:
        return row, extra
    if value is None:
        row[key + '_is'] = 'n'
        return row, extra
    if isinstance(value, list):
        if len(value) == 2 and value[0] == 'i' and type(value[1]) is int:
            row.update({key + '_is': 'l', key + '_kind': 'i',
                        key + '_integer': Decimal(value[1])})
            return row, extra
        if (len(value) == 3 and value[0] == 'f'
                and all(type(v) is float and math.isfinite(v) for v in value[1:])):
            row.update({key + '_is': 'l', key + '_kind': 'f',
                        key + '_float': value[1], key + '_compensation': value[2]})
            return row, extra
    if not codec.fits('json', value):
        raise codec.ShapeError(f'{key}: a sum state no JSON escape column can hold')
    row[key + '_is'] = 'x'
    extra[key] = value
    return row, extra


def decode(key: str, row: Mapping[str, Any], extra: Mapping[str, Any]) -> Any:
    """Reconstruct the original tagged state, rejecting damaged typed rows."""
    shape = row.get(key + '_is')
    kind = row.get(key + '_kind')
    integer = row.get(key + '_integer')
    total = row.get(key + '_float')
    compensation = row.get(key + '_compensation')
    fields = (kind, integer, total, compensation)
    if shape in (None, 'n', 'x'):
        if any(v is not None for v in fields):
            raise codec.ShapeError(f'{key}: inactive sum state contains typed values')
        if shape == 'x':
            if key not in extra:
                raise codec.ShapeError(f'{key}: exceptional sum state has no original value')
            return extra[key]
        if key in extra:
            raise codec.ShapeError(f'{key}: inactive sum state conflicts with extra')
        return codec.MISSING if shape is None else None
    if shape != 'l' or key in extra:
        raise codec.ShapeError(f'{key}: invalid sum-state shape or duplicate original')
    if kind == 'i' and total is None and compensation is None:
        if (not isinstance(integer, (int, Decimal)) or isinstance(integer, bool)
                or (isinstance(integer, Decimal) and not integer.is_finite())
                or integer != int(integer)):
            raise codec.ShapeError(f'{key}: integer sum state has no exact integer')
        return ['i', int(integer)]
    if (kind == 'f' and integer is None
            and all(type(v) is float and math.isfinite(v) for v in (total, compensation))):
        return ['f', total, compensation]
    raise codec.ShapeError(f'{key}: invalid sum-state kind or typed values')
