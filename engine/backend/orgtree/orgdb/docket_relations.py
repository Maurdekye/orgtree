"""Exact docket records stored beside an item, selected by its physical id.

Delivery is a fixed stage map. Review seats and artifact grants are ordered
occurrences. Their typed rows keep authored values; exceptional containers
retain their original path. Current-agent resolution is a writer callback.
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Callable, Mapping, Sequence
import json
from typing import Any

from . import codec, current_refs
from .codec import Field as F, Spec
from .sections import Table, table

STAGES = ('implemented', 'committed', 'pushed', 'deployed', 'in_build')
DELIVERY = Spec('work_item_delivery', (
    F('claimed_at', 'ts', nullable=True), F('claimed_by', 'principal'),
    F('ref', 'text', nullable=True), F('note', 'text', nullable=True),
    F('verified', 'bool', nullable=True), F('method', 'text', nullable=True),
    F('detail', 'text', nullable=True), F('resolved_oid', 'text', nullable=True),
    F('target', 'text', nullable=True), F('ref_as_of', 'text', nullable=True),
    F('fetched_at', 'ts', nullable=True), F('observed_at', 'ts', nullable=True),
))
DELIVERY_TABLE = table(DELIVERY, child_key='claim_id', placement=(
    ('item_id', 'bigint', 'item_id bigint NOT NULL REFERENCES orgtree.work_items(id) ON DELETE CASCADE'),
    ('stage', 'text', 'stage text NOT NULL CHECK (stage IN ('+
     ','.join("'"+stage+"'" for stage in STAGES)+'))'),
    ('claim_is', 'char(1)', "claim_is char(1) NOT NULL CHECK (claim_is IN ('n','o','x'))"),
), derived=('row_version bigint NOT NULL DEFAULT 0',), indexes=(
    'CREATE UNIQUE INDEX work_item_delivery_stage ON orgtree.work_item_delivery(item_id,stage)',
))
SEAT = Spec('work_item_review_seats', (
    F('reviewer', 'text', col='reviewer_name', nullable=True),
    F('holder', 'principal'), F('recheck_owner', 'principal'),
    F('granted_by', 'principal'), F('at', 'ts', nullable=True),
    F('state', 'text', nullable=True, values=('granted', 'spent', 'revoked')),
    F('note', 'text', nullable=True), F('answered_request', 'int', nullable=True),
    F('spent_at', 'ts', nullable=True), F('spent_via', 'text', nullable=True),
    F('revoked_at', 'ts', nullable=True), F('revoked_by', 'principal'),
    F('revoked_reason', 'text', nullable=True),
))


def agent_column(column):
    return (column, 'bigint', column+' bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE')


SEAT_TABLE = table(SEAT, child_key='seat_id', placement=(
    ('item_id', 'bigint', 'item_id bigint NOT NULL REFERENCES orgtree.work_items(id) ON DELETE CASCADE'),
    ('seq', 'integer', 'seq integer NOT NULL CHECK (seq >= 0)'),
    agent_column('reviewer_agent_id'), agent_column('holder_agent_id'),
    agent_column('recheck_owner_agent_id'),
), derived=('row_version bigint NOT NULL DEFAULT 0',), indexes=(
    'CREATE UNIQUE INDEX work_item_review_seats_seq ON orgtree.work_item_review_seats(item_id,seq)',
    'CREATE INDEX work_item_review_seats_reviewer ON orgtree.work_item_review_seats(reviewer_agent_id,item_id,seq)',
    'CREATE INDEX work_item_review_seats_reviewer_name ON orgtree.work_item_review_seats(reviewer_name,item_id,seq DESC)',
    'CREATE INDEX work_item_review_seats_holder ON orgtree.work_item_review_seats(holder_agent_id,item_id)',
    'CREATE INDEX work_item_review_seats_recheck_owner ON orgtree.work_item_review_seats(recheck_owner_agent_id,item_id)',
))
GRANT = Spec('work_item_artifact_grants', (
    F('to', 'text', col='recipient_name', nullable=True),
    F('at', 'ts', nullable=True), F('by', 'principal'),
    F('revoked_at', 'ts', nullable=True), F('note', 'text', nullable=True),
))
GRANT_TABLE = table(GRANT, child_key='grant_id', placement=(
    ('item_id', 'bigint', 'item_id bigint NOT NULL'),
    ('artifact_id', 'bigint', 'artifact_id bigint NOT NULL'),
    ('pos', 'integer', 'pos integer NOT NULL CHECK (pos >= 0)'),
    agent_column('agent_id'),
), derived=(
    'row_version bigint NOT NULL DEFAULT 0',
    'FOREIGN KEY (item_id,artifact_id) REFERENCES orgtree.work_item_artifacts(item_id,id) '
    'ON DELETE CASCADE NOT DEFERRABLE',
), indexes=(
    'CREATE UNIQUE INDEX work_item_artifact_grants_pos ON orgtree.work_item_artifact_grants(artifact_id,pos)',
    'CREATE INDEX work_item_artifact_grants_artifact ON orgtree.work_item_artifact_grants(artifact_id,item_id,pos)',
    'CREATE INDEX work_item_artifact_grants_agent ON orgtree.work_item_artifact_grants(agent_id,item_id,artifact_id,pos DESC)',
    'CREATE INDEX work_item_artifact_grants_name ON orgtree.work_item_artifact_grants(artifact_id,recipient_name,pos DESC)',
    'CREATE INDEX work_item_artifact_grants_item ON orgtree.work_item_artifact_grants(item_id,artifact_id)',
))
TABLES = (DELIVERY_TABLE, SEAT_TABLE, GRANT_TABLE)
ARTIFACT_TABLE = 'work_item_artifacts'


def list_shape(value):
    """Use a child relation only for a whole list of supported record objects."""
    return (None if value is codec.MISSING else 'n' if value is None else
            'l' if isinstance(value, list) and all(isinstance(x, dict) for x in value) else 'x')


def item_layout(base: Mapping[str, Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Declare external records as indexed item children for exports and readers."""
    result = {name: dict(entry) for name, entry in base.items()}
    artifact = result[ARTIFACT_TABLE]
    artifact['keys'] += (('id', 'bigint'), ('grants_is', 'char(1)'))
    result['work_item_holders']['keys'] += (('agent_id', 'bigint'),)
    for child in TABLES:
        name = child.spec.table
        if name in result:
            raise ValueError(f'docket relation declared twice: {name}')
        entry = dict(child.layout()[name])
        if name == GRANT.table:
            entry.update(parent_table=ARTIFACT_TABLE, parent_cols=('item_id', 'artifact_id'),
                         ref_cols=('item_id', 'id'), pos='pos')
        else:
            entry.update(parent_table='work_items', parent_cols=('item_id',),
                         ref_cols=('id',), pos='stage' if name == DELIVERY.table else 'seq')
        result[name] = entry
    return result


class DocketTable(Table):
    """The ordinary codec children followed by the item's normalized relations."""

    def layout(self):
        return item_layout(super().layout())

    def ddl(self, schema='orgtree'):
        artifact = codec.quote(schema)+'.'+codec.quote(ARTIFACT_TABLE)
        additions = [
            'ALTER TABLE orgtree.work_item_holders ADD COLUMN agent_id bigint '
            'REFERENCES orgtree.agents(id) NOT DEFERRABLE',
            'CREATE INDEX work_item_holders_agent ON orgtree.work_item_holders(agent_id,item_id,pos)',
            f'ALTER TABLE {artifact} ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY',
            f"ALTER TABLE {artifact} ADD COLUMN grants_is char(1) CHECK (grants_is IN ('n','l','x'))",
            f'ALTER TABLE {artifact} ADD CONSTRAINT work_item_artifact_id UNIQUE(id)',
            f'ALTER TABLE {artifact} ADD CONSTRAINT work_item_artifact_row_id UNIQUE(item_id,id)',
        ]
        return super().ddl(schema)+additions+[
            statement for child in TABLES for statement in child.ddl(schema)]


def core(record: Mapping[str, Any]) -> dict[str, Any]:
    """Remove supported stages from the item's exact object before codec fill."""
    result = dict(record)
    delivery = record.get('delivery')
    if isinstance(delivery, dict):
        result['delivery'] = {key: value for key, value in delivery.items() if key not in STAGES}
    seats = record.get('review_seats', codec.MISSING)
    if list_shape(seats) in ('n', 'l'):
        result.pop('review_seats', None)
    artifacts = record.get('artifacts', codec.MISSING)
    if list_shape(artifacts) == 'l':
        result['artifacts'] = []
        for artifact in artifacts:
            clean = dict(artifact)
            if list_shape(artifact.get('grants', codec.MISSING)) in ('n', 'l'):
                clean.pop('grants', None)
            result['artifacts'].append(clean)
    return result


def _allocate(table, out, allocator, previous=()):
    if allocator is not None:
        return allocator(table)
    return 1 + max((r.get('id', 0) for r in (*out.get(table, ()), *previous)), default=0)


def _identity(value):
    return ('missing',) if value is codec.MISSING else (
        'value', json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False))


def encode_lists(record, item_id, out, *, previous=None, allocate=None, resolve=None):
    """Encode seat and grant occurrences; physical current references are supplied separately."""
    previous = previous or {}
    seats = record.get('review_seats', codec.MISSING)
    out['work_items'][-1]['review_seats_is'] = list_shape(seats)
    old_seats = {r['seq']: r for r in previous.get(SEAT.table, ())}
    if len(old_seats) != len(previous.get(SEAT.table, ())):
        raise codec.ShapeError('review_seats: duplicate sequence')
    if list_shape(seats) == 'l':
        for pos, seat in enumerate(seats):
            old = old_seats.get(pos)
            if old is not None and old['item_id'] != item_id:
                raise codec.ShapeError('review_seats: previous row belongs to another item')
            rid = old['id'] if old else _allocate(SEAT.table, out, allocate, previous.get(SEAT.table, ()))
            old_value = codec.decode(SEAT, old, None) if old else {}
            keys = dict(id=rid, item_id=item_id, seq=pos)
            for role in ('reviewer', 'holder', 'recheck_owner'):
                column = role+'_agent_id'
                current = current_refs.seat_reviewer(seat) if role == 'reviewer' else seat.get(role, codec.MISSING)
                prior = current_refs.seat_reviewer(old_value) if role == 'reviewer' else old_value.get(role, codec.MISSING)
                keys[column] = resolve(current, prior,
                                       old.get(column) if old else None) if resolve else None
            codec.encode(SEAT, seat, keys, out, link=SEAT_TABLE.link)

    artifacts = record.get('artifacts', codec.MISSING)
    if list_shape(artifacts) != 'l':
        return
    from .mappers import docket as D
    spec = D.WORK_ITEM.field('artifacts').spec
    old_artifacts = defaultdict(deque)
    for old in previous.get(ARTIFACT_TABLE, ()):
        if old['item_id'] != item_id:
            raise codec.ShapeError('artifacts: previous row belongs to another item')
        old_value = codec.decode(spec, old, None)
        old_artifacts[_identity(old_value.get('id', codec.MISSING))].append(old)
    old_grants = defaultdict(dict)
    for old in previous.get(GRANT.table, ()):
        group = old_grants[old['artifact_id']]
        if old['item_id'] != item_id or old['pos'] in group:
            raise codec.ShapeError('grants: duplicate position or another item')
        group[old['pos']] = old
    artifact_rows = [r for r in out.get(ARTIFACT_TABLE, ()) if r['item_id'] == item_id]
    if len(artifact_rows) != len(artifacts):
        raise codec.ShapeError('artifacts: encoded child count differs')
    for artifact, row in zip(artifacts, artifact_rows):
        group = old_artifacts[_identity(artifact.get('id', codec.MISSING))]
        old = group.popleft() if group else None
        aid = old['id'] if old else _allocate(ARTIFACT_TABLE, out, allocate,
                                            previous.get(ARTIFACT_TABLE, ()))
        row.update(id=aid, grants_is=list_shape(artifact.get('grants', codec.MISSING)))
        grants = artifact.get('grants', codec.MISSING)
        if list_shape(grants) != 'l':
            continue
        for pos, grant in enumerate(grants):
            old_grant = old_grants[aid].get(pos)
            gid = old_grant['id'] if old_grant else _allocate(GRANT.table, out, allocate,
                                                            previous.get(GRANT.table, ()))
            old_value = codec.decode(GRANT, old_grant, None) if old_grant else {}
            recipient = resolve(grant.get('to', codec.MISSING),
                                old_value.get('to', codec.MISSING),
                                old_grant.get('agent_id') if old_grant else None) if resolve else None
            codec.encode(GRANT, grant, dict(id=gid, item_id=item_id, artifact_id=aid,
                                          pos=pos, agent_id=recipient), out, link=GRANT_TABLE.link)


def restore_list(record, key, state, values):
    """Refuse contradictory parent state instead of dropping unseen relation rows."""
    if state == 'l':
        if key in record:
            raise codec.ShapeError(f'{key}: child list conflicts with parent extra')
        record[key] = values
    elif state in (None, 'n', 'x'):
        if values:
            raise codec.ShapeError(f'{key}: inactive list has child rows')
        if state == 'n':
            if key in record:
                raise codec.ShapeError(f'{key}: null list conflicts with parent extra')
            record[key] = None
        elif state == 'x' and key not in record:
            raise codec.ShapeError(f'{key}: exceptional list has no original value')
        elif state is None and key in record:
            raise codec.ShapeError(f'{key}: absent list has an extra value')
    else:
        raise codec.ShapeError(f'{key}: invalid list shape')


def decode_lists(record, row, children):
    """Reconstruct the original ordered seat list and each grant occurrence list."""
    if children is None:
        if row.get('review_seats_is') == 'l' or row.get('artifacts_is') == 'l':
            raise ValueError('docket relations: child rows needed')
        seats = []
    else:
        seats = children.of(SEAT.table, (row['id'],))
    seqs = [r['seq'] for r in seats]
    if seqs != list(range(len(seats))):
        raise codec.ShapeError('review_seats: missing or repeated occurrence')
    restore_list(record, 'review_seats', row.get('review_seats_is'),
                 [codec.decode(SEAT, r, None) for r in seats])
    if row.get('artifacts_is') != 'l':
        return
    artifact_rows = children.of(ARTIFACT_TABLE, (row['id'],))
    artifacts = record['artifacts']
    if len(artifact_rows) != len(artifacts):
        raise codec.ShapeError('artifacts: decoded child count differs')
    for artifact, stored in zip(artifacts, artifact_rows):
        grants = children.of(GRANT.table, (row['id'], stored['id']))
        positions = [r['pos'] for r in grants]
        if positions != list(range(len(grants))):
            raise codec.ShapeError('grants: missing or repeated occurrence')
        restore_list(artifact, 'grants', stored.get('grants_is'),
                     [codec.decode(GRANT, r, None) for r in grants])


def encode(record: Mapping[str, Any], item_id: int, out: codec.Rows, *,
           previous: Sequence[Mapping[str, Any]] = (),
           allocate: Callable[[str], int] | None = None) -> None:
    """Keep an existing stage's surrogate; conversion allocates deterministic ids."""
    delivery = record.get('delivery')
    if not isinstance(delivery, dict):
        return
    old = {row['stage']: row for row in previous}
    if len(old) != len(previous) or any(row['item_id'] != item_id for row in previous):
        raise codec.ShapeError('delivery: duplicate stage or another item in previous rows')
    for stage in STAGES:
        if stage not in delivery:
            continue
        value = delivery[stage]
        if stage in old:
            rid = old[stage]['id']
        else:
            rid = _allocate(DELIVERY.table, out, allocate, previous)
        shape = 'n' if value is None else 'o' if isinstance(value, dict) else 'x'
        codec.encode(DELIVERY, value if shape == 'o' else {},
                     dict(id=rid, item_id=item_id, stage=stage, claim_is=shape), out,
                     link=DELIVERY_TABLE.link)
        if shape == 'x':
            if not codec.fits('json', value):
                raise codec.ShapeError('delivery: a claim no JSON escape column can hold')
            out[DELIVERY.table][-1]['extra'] = codec.to_column('json', {'claim': value})


def claim(row: Mapping[str, Any]) -> Any:
    """Decode the authored object or its explicit null/exceptional shape."""
    shape = row.get('claim_is')
    if shape == 'o':
        return codec.decode(DELIVERY, row, None)
    if shape not in ('n', 'x'):
        raise codec.ShapeError('delivery: invalid claim shape')
    if any(row.get(column) is not None for column, _ in codec.columns(DELIVERY)):
        raise codec.ShapeError('delivery: inactive claim has typed fields')
    extra = codec.from_column('json', row.get('extra'))
    if shape == 'n':
        if extra is not None:
            raise codec.ShapeError('delivery: null claim has extra fields')
        return None
    if not isinstance(extra, dict) or set(extra) != {'claim'}:
        raise codec.ShapeError('delivery: exceptional claim has no original value')
    return extra['claim']


def decode(record: dict[str, Any], row: Mapping[str, Any], children: codec.Children | None) -> None:
    """Merge supported stages with the original exceptional parent-map keys."""
    if row.get('delivery_is') == 'o' and children is None:
        raise ValueError('delivery: child rows needed')
    relations = children.of(DELIVERY.table, (row['id'],)) if children is not None else []
    if row.get('delivery_is') != 'o':
        if relations:
            raise codec.ShapeError('delivery: inactive container has claim rows')
        return
    delivery = record.get('delivery')
    if not isinstance(delivery, dict):
        raise codec.ShapeError('delivery: object marker has no object')
    seen = set()
    for entry in relations:
        stage = entry.get('stage')
        if (stage not in STAGES or stage in seen or stage in delivery
                or entry.get('item_id') != row['id']):
            raise codec.ShapeError('delivery: invalid, duplicated or conflicting stage')
        seen.add(stage)
        delivery[stage] = claim(entry)
