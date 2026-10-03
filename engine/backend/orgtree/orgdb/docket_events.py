"""One typed sequence for the legacy docket's retained history.

The mapper owns exact source records. The plain event header serves typed
queries. No current value is stored twice: it is an explicit same-item pointer.
"""
from __future__ import annotations

import json
from typing import Any, Mapping

from . import codec
from .mappers import docket as D


def canonical(value):
    """Exact JSON equality: Python == would conflate True, 1 and 1.0."""
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)


def event_kind(source, record):
    if source in ('scope','scope_archive'):
        return 'decision' if isinstance(record,dict) and record.get('kind')=='decision' else 'scope'
    return dict(candidate_verdicts='verdict',review_packets='review_packet',
                dismissals='dismissal',quick_staff_receipts='quick_staff_receipt').get(source,source)


def event_header(source, record):
    """Derive safe typed lookup columns without changing the original record."""
    value = record if isinstance(record,dict) else {}
    actor = value.get('by')
    principal = actor if isinstance(actor,dict) else {'node':actor}
    changes = value.get('changes')
    changed = (source=='history' and value.get('kind')!='folded' and bool(value.get('at')) and
               (value.get('op') in ('accept','reopen','supersede') or
                (value.get('op')=='update' and isinstance(changes,dict) and 'status' in changes) or
                (value.get('op')=='dismiss_attention' and value.get('from')!='blocked')))
    content = next((value[k] for k in ('text','note','reason') if isinstance(value.get(k),str)),None)
    return dict(kind=event_kind(source,record),
                at=codec.parse_ts(value['at']) if codec.fits('ts',value.get('at')) else None,
                by_node=principal.get('node') if codec.fits('text',principal.get('node')) else None,
                by_generation=principal.get('generation') if codec.fits('int',principal.get('generation')) else None,
                by_born=principal.get('born') if codec.fits('text',principal.get('born')) else None,
                content=content if codec.fits('text',content) else None,status_change=changed,
                original_at=codec.to_column('json',value['at']) if 'at' in value else None,
                original_scope_seq=codec.to_column('json',value['seq']) if 'seq' in value else None)


def encode_event(source, value, *, id, item_id, seq):
    out = {}
    codec.encode(D.EVENT,{source:value},dict(id=id,item_id=item_id,seq=seq,source=source,
                                           **event_header(source,value)),out,link=D.EVENTS.link)
    return out['work_item_events'][0]


def event_value(row):
    return codec.decode(D.EVENT,row,None,(row['id'],))[row['source']]


def encode_item(record: Mapping[str,Any], keys: Mapping[str,Any], out: codec.Rows) -> None:
    """Conversion in deterministic source rank/position order, no invented dates."""
    keys = dict(keys)
    start = len(out.get('work_item_events',[]))
    events = []
    for source in D.EVENT_SOURCES:
        value = record.get(source)
        if isinstance(value,list):
            for entry in value:
                events.append(encode_event(source,entry,id=start+len(events)+1,
                                           item_id=keys['id'],seq=len(events)+1))
    for field,column in D.CURRENT_POINTERS.items():
        current = record.get(field)
        if current is not None:
            source = 'candidate_verdicts' if field=='candidate_verdict' else 'review_packets'
            matches = [e for e in events if e['source']==source and
                       canonical(event_value(e))==canonical(current)]
            if not matches:
                raise codec.ShapeError(f"work item {record.get('slug')!r}: {field} matches no event in {source}")
            keys[column] = matches[-1]['id']
    core = {k:v for k,v in record.items() if k not in D.CURRENT_POINTERS and
            (k not in D.EVENT_SOURCES or not isinstance(v,list))}
    codec.encode(D.WORK_ITEM,core,keys,out,link=D.WORK_ITEMS.link)
    out.setdefault('work_item_events',[]).extend(events)


def decode_item(row, children, events):
    record = codec.decode(D.WORK_ITEM,row,children,(row['id'],))
    by_id = {e['id']:e for e in events}
    for source in D.EVENT_SOURCES:
        state = row.get(source+'_events_is')
        if state=='l':
            record[source] = [event_value(e) for e in sorted(events,key=lambda e:e['seq']) if e['source']==source]
        elif state=='n':
            record[source] = None
    for field,column in D.CURRENT_POINTERS.items():
        state = row.get(column+'_is')
        if state=='n':
            record[field] = None
        elif state=='v':
            event = by_id.get(row[column])
            source = 'candidate_verdicts' if field=='candidate_verdict' else 'review_packets'
            if event is None or event['item_id']!=row['id'] or event['source']!=source:
                raise codec.ShapeError(f"work item {record.get('slug')!r}: invalid {field} pointer")
            record[field] = event_value(event)
    return record
