"""One typed sequence for the legacy docket's retained history.

The mapper owns exact source records. The plain event header serves typed
queries. No current value is stored twice: it is an explicit same-item pointer.
"""
from __future__ import annotations

import json
from difflib import SequenceMatcher
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
    row = out['work_item_events'][0]
    # history.by uses the canonical actor header columns. Filling an inactive
    # history object clears them, so restore other sources' headers afterwards.
    row.update(event_header(source, value))
    return row


def event_value(row):
    return codec.decode(D.EVENT,row,None,(row['id'],))[row['source']]


def pointers(record, events):
    """Resolve explicit current values against their exact retained source."""
    out = {}
    for field,column in D.CURRENT_POINTERS.items():
        out[column] = None
        current = record.get(field)
        if current is None:
            continue
        source = 'candidate_verdicts' if field=='candidate_verdict' else 'review_packets'
        token = canonical(current)
        matches = [e for e in events if e['source']==source and
                   canonical(event_value(e))==token]
        if not matches:
            raise codec.ShapeError(f"work item {record.get('slug')!r}: {field} matches no event in {source}")
        out[column] = max(matches,key=lambda e:e['seq'])['id']
    return out


def difference(record, previous, *, item_id, allocate):
    """Preserve equal rows; apply a legacy fold/rewrite/removal and append tails.

    A replacement takes the affected old rows' slots. Newly appended entries
    take max(seq)+1 across all sources. Rows outside that difference are kept
    byte for byte, including their identity and sequence.
    """
    events, removed, rewritten = [], [], []
    top = max((e['seq'] for e in previous),default=0)
    for source in D.EVENT_SOURCES:
        old = sorted((e for e in previous if e['source']==source),key=lambda e:e['seq'])
        value = record.get(source)
        new = value if isinstance(value,list) else []
        a = [canonical(event_value(e)) for e in old]
        b = [canonical(e) for e in new]
        # Most writes append. Avoid quadratic matching for a long repeated tail.
        if b[:len(a)]==a:
            opcodes = [('equal',0,len(a),0,len(a)),('insert',len(a),len(a),len(a),len(b))]
        else:
            opcodes = SequenceMatcher(a=a,b=b,autojunk=False).get_opcodes()
        for op,a1,a2,b1,b2 in opcodes:
            if op=='equal':
                events.extend(old[a1:a2])
                continue
            reused = min(a2-a1,b2-b1)
            for offset in range(reused):
                row = old[a1+offset]
                events.append(encode_event(source,new[b1+offset],id=row['id'],
                                           item_id=item_id,seq=row['seq']))
                rewritten.append(row['id'])
            removed.extend(e['id'] for e in old[a1+reused:a2])
            if b2-b1>reused and b2!=len(b):
                raise codec.ShapeError(f"work item {record.get('slug')!r}: inserted {source} entry before untouched history")
            for entry in new[b1+reused:b2]:
                top += 1
                events.append(encode_event(source,entry,id=allocate(),item_id=item_id,seq=top))
    return sorted(events,key=lambda e:e['seq']),removed,rewritten


def encode_current(record, keys, events, out):
    core = {k:v for k,v in record.items() if k not in D.CURRENT_POINTERS and
            (k not in D.EVENT_SOURCES or not isinstance(v,list))}
    codec.encode(D.WORK_ITEM,core,D.row_keys(core,id=keys['id'],list_key=keys['list_key'],
                 ord=keys['ord'],archive_seq=keys.get('archive_seq'),original=record,events=events),
                 out,link=D.WORK_ITEMS.link)


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
    encode_current(record,keys,events,out)
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
