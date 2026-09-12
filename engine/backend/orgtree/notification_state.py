"""Notification identity metadata; independent of delivery and in-app indicators."""
from typing import Any, Mapping


def question_items(doc: Mapping[str, Any]) -> set[str]:
    return {q.get('work_item') for ask in doc.get('asks') or []
            if ask.get('status') == 'open' for q in ask.get('questions') or []
            if q.get('work_item')}


def reconcile_attention(doc: Mapping[str, Any], *, initialize_only: bool = False) -> None:
    """Record effective attention edges at the write boundary. On load, only
    initialize legacy metadata, before a first rewrite can change set_rev.
    No reads write to disk. Source handoffs and rewrites keep the same epoch;
    a clear/reassert between desktop polls still increments it.
    """
    items = doc.get('work_items') or []
    if initialize_only and all('notification_attention_active' in item for item in items):
        return
    attached = question_items(doc)
    for item in items:
        previous = item.get('notification_attention_active')
        if initialize_only and previous is not None:
            continue
        active = bool(item.get('manual_attention') or item.get('slug') in attached)
        if previous is None:
            item['notification_attention_epoch'] = int((item.get('manual_attention') or {}).get('set_rev') or 1)
        elif active and not previous:
            item['notification_attention_epoch'] = int(item.get('notification_attention_epoch') or 0) + 1
        item['notification_attention_active'] = active
