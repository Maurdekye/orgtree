"""The declared enum columns of section tables, including flattened objects."""

from __future__ import annotations

from typing import Any, Iterable, Iterator

from . import codec
from .sections import Section


def columns(secs: Iterable[Section], *, include_markers: bool = False) -> Iterator[dict[str, Any]]:
    """One entry per constrained column; child records have their own local paths."""
    seen: set[tuple[str, str]] = set()
    for section in secs:
        for root in section.tables:
            for table, layout in root.layout().items():
                spec = layout['spec']
                if spec is None:
                    continue
                fields = [(col, path, vals, 'value') for col, path, vals in codec.enumerated(spec)]
                if include_markers:
                    fields += [(col, path, vals, 'marker') for col, path, vals in codec.markers(spec)]
                for column, path, values, kind in fields:
                    key = (table, column)
                    if key in seen:
                        raise ValueError(f'enum column declared twice: {table}.{column}')
                    seen.add(key)
                    yield dict(table=table, column=column, path=path, values=values,
                               kind=kind, keys=tuple(k for k, _ in layout['keys']), spec=spec,
                               layout=layout)


def misfits(org: str, rows: codec.Rows, secs: Iterable[Section]) -> list[dict[str, Any]]:
    """Name each legacy enum misfit without echoing its possibly private value.

    Exact values are already in extra. Nulls denote presence, not unknown enum
    members; a bad-shaped parent belongs to the codec's ordinary shape report.
    Keys are row placement, so every nested child record can be found precisely.
    """
    found = []
    for entry in columns(secs):
        for row in rows.get(entry['table'], []):
            extra = row.get('extra')
            value = getattr(extra, 'obj', extra)
            for key in entry['path']:
                if not isinstance(value, dict) or key not in value:
                    value = None
                    break
                value = value[key]
            if value is not None and (not codec.fits('text', value)
                                      or value not in entry['values']):
                found.append(dict(org=org, table=entry['table'],
                                  record={key: row[key] for key in entry['keys']},
                                  field='.'.join(entry['path']), column=entry['column']))
    return found
