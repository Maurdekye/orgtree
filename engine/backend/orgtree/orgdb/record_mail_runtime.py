"""Ordered mailbox delivery stages from retained snapshot inputs."""
from __future__ import annotations

import copy
from .record_mail import decoded
from .record_runtime import SupervisorOverlays


def inputs(state, ids, contexts):
    result = {}
    for aid in ids:
        context = contexts[aid]
        row = state.raw.execute('SELECT name FROM orgtree.agents WHERE id=%s AND NOT tombstone',
                                (int(aid),)).fetchone()
        if row is None:
            continue
        name = row[0]
        result[aid] = dict(slug=state.slug,name=name,
            leased=bool(context.nodes[name].get('drive_lease')),
            batches=[batch for _,batch in decoded(state,'delivering','agent_id=%s',(int(aid),),order='idx')])
    return result


class MailboxOverlays(SupervisorOverlays):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self._mail = {}

    def adopt_mail(self, inputs, *, removed=()):
        for key in removed:
            self._mail.pop(key,None)
        self._mail.update(copy.deepcopy(inputs))
        return self._refresh(set(inputs).intersection(self._bodies))

    def _fields(self,key):
        from .. import supervisor
        fields = super()._fields(key)
        source = self._mail.get(key)
        fields['mail_stages'] = (supervisor._delivery_stages(source['slug'],source['name'],
            source['batches'],leased=source['leased']) if source else {})
        return fields
