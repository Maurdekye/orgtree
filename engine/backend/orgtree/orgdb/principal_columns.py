"""Recorded principal values in typed columns, without resolving an agent.

Historical actors never become foreign keys. Current roles use these same exact
recorded values beside their separately resolved immediate physical reference.
Unknown keys and scalar misfits return to the original principal's extra path.
"""

from __future__ import annotations

from typing import Any, Mapping

from . import codec

_FIELDS = {'node': 'text', 'generation': 'int', 'born': 'text', 'deleted': 'bool'}
_SUFFIX = {'node': 'name', 'generation': 'generation', 'born': 'born', 'deleted': 'deleted'}


def _columns(prefix: str, aliases: Mapping[str, str] | None) -> dict[str, str]:
    unknown = set(aliases or ()) - set(_FIELDS)
    if unknown:
        raise ValueError(f'unknown principal column aliases: {sorted(unknown)}')
    return {field: (aliases or {}).get(field, prefix + '_' + suffix)
            for field, suffix in _SUFFIX.items()}


def kind(name: str) -> str:
    """Structural kind of a fitting recorded name; never an authorization check."""
    if name == 'user':
        return 'user'
    if name == 'orgtree':
        return 'engine'
    if name.startswith(('@org:', '@net:')):
        return 'outside'
    return 'agent'


def columns(prefix: str, aliases: Mapping[str, str] | None = None
            ) -> tuple[tuple[str, str], ...]:
    """Physical columns; aliases reuse a table's existing recorded actor headers."""
    cols = _columns(prefix, aliases)
    out = [(prefix + '_is', 'char(1)'), (prefix + '_kind', 'text')]
    for field, typ in _FIELDS.items():
        out.extend(((cols[field], codec.SQL_TYPES[typ]),
                    (cols[field] + '_null', 'boolean')))
    return tuple(out)


def encode(key: str, value: Any = codec.MISSING, *, prefix: str | None = None,
           aliases: Mapping[str, str] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Columns plus record-local extra for a missing/null/string/object principal."""
    prefix = prefix or key
    cols = _columns(prefix, aliases)
    row: dict[str, Any] = {prefix + '_is': None, prefix + '_kind': None}
    for column in cols.values():
        row[column] = row[column + '_null'] = None
    if value is codec.MISSING:
        return row, {}
    if value is None:
        row[prefix + '_is'] = 'n'
        return row, {}
    if isinstance(value, str) and codec.fits('text', value):
        row.update({prefix + '_is': 's', prefix + '_kind': kind(value), cols['node']: value})
        return row, {}
    if isinstance(value, dict):
        row[prefix + '_is'] = 'o'
        remainder = {k: v for k, v in value.items() if k not in _FIELDS}
        for field, typ in _FIELDS.items():
            v = value.get(field, codec.MISSING)
            if v is codec.MISSING:
                continue
            if v is None:
                row[cols[field] + '_null'] = True
            elif codec.fits(typ, v):
                row[cols[field]] = codec.to_column(typ, v)
            else:
                remainder[field] = v
        if row[cols['node']] is not None:
            row[prefix + '_kind'] = kind(row[cols['node']])
        if not codec.fits('json', remainder):
            raise codec.ShapeError(f'{key}: a principal no JSON escape column can hold')
        return row, {key: remainder} if remainder else {}
    if not codec.fits('json', value):
        raise codec.ShapeError(f'{key}: a principal no JSON escape column can hold')
    row[prefix + '_is'] = 'x'
    return row, {key: value}


def decode(key: str, row: Mapping[str, Any], extra: Mapping[str, Any], *,
           prefix: str | None = None, aliases: Mapping[str, str] | None = None) -> Any:
    """Recorded shape and fields only; names are not read from a current agent."""
    prefix = prefix or key
    cols = _columns(prefix, aliases)
    shape = row.get(prefix + '_is')
    if shape in (None, 'n', 'x'):
        if (row.get(prefix + '_kind') is not None
                or any(row.get(c) is not None or row.get(c + '_null') is not None
                       for c in cols.values())):
            raise codec.ShapeError(f'{key}: inactive principal contains typed values')
        if shape == 'x':
            if key not in extra:
                raise codec.ShapeError(f'{key}: exceptional principal has no original value')
            return extra[key]
        if key in extra:
            raise codec.ShapeError(f'{key}: inactive principal conflicts with extra')
        return codec.MISSING if shape is None else None
    if shape == 's':
        name = row.get(cols['node'])
        if (key in extra or not codec.fits('text', name) or row.get(cols['node'] + '_null')
                or any(row.get(cols[f]) is not None or row.get(cols[f] + '_null') is not None
                       for f in _FIELDS if f != 'node')):
            raise codec.ShapeError(f'{key}: invalid bare-string principal')
        if row.get(prefix + '_kind') != kind(name):
            raise codec.ShapeError(f'{key}: principal kind disagrees with recorded name')
        return name
    if shape != 'o' or (key in extra and not isinstance(extra[key], dict)):
        raise codec.ShapeError(f'{key}: invalid principal shape')
    value = dict(extra.get(key, {}))
    for field, typ in _FIELDS.items():
        column = cols[field]
        stored = row.get(column)
        is_null = row.get(column + '_null')
        if stored is not None or is_null:
            if field in value or (stored is not None and is_null):
                raise codec.ShapeError(f'{key}: duplicate principal field {field}')
            if stored is not None and not codec.fits(typ, stored):
                raise codec.ShapeError(f'{key}: invalid typed principal field {field}')
            value[field] = None if is_null else codec.from_column(typ, stored)
    name = row.get(cols['node'])
    if row.get(prefix + '_kind') != (kind(name) if name is not None else None):
        raise codec.ShapeError(f'{key}: principal kind disagrees with recorded name')
    return value
