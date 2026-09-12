"""Bounded operator attention projection across organizations; no providers."""
import hashlib
from . import store
from .notification_state import question_items


def notices(limit=200, offset=0):
    rows = []
    def add(org, key, kind, title, body, agent=None, item=None, source_id=None, generation=None):
        identity = f"{org.d['slug']}:{org.d.get('created')}:{key}"
        rows.append({'id':hashlib.sha256(identity.encode()).hexdigest(), 'org':org.d['slug'],
                     'kind':kind, 'title':str(title)[:200], 'body':str(body or '')[:500],
                     **({'source_id':str(source_id)} if source_id is not None else {}),
                     **({'generation':generation} if generation is not None else {}),
                     **({'agent':str(agent)} if agent else {}), **({'item':str(item)} if item else {})})
    for _, org in store.list_orgs_with_docs():
        for ask in org.d.get('asks') or []:
            node = (org.d.get('nodes') or {}).get(ask.get('node'))
            if ask.get('status') == 'open' and node and node.get('state') == 'live':
                add(org, 'ask:'+str(ask.get('id')), 'question', 'Question from '+str(ask.get('node')),
                    ask.get('question') or next((q.get('question') for q in ask.get('questions',[]) if q.get('question')), 'A question needs your answer.'), ask.get('node'), source_id=ask.get('id'))
        for mail in org.d.get('user_inbox') or []:
            add(org,'mail:'+str(mail.get('id')), 'urgent-mail' if mail.get('urgent') else 'routine',
                'Message from '+str(mail.get('from') or org.d.get('name')),
                (mail.get('urgent_reason') if mail.get('urgent') else None) or mail.get('body') or mail.get('text') or 'Open the message in Orgtree.',
                mail.get('from'), source_id=mail.get('id'))
        attached = question_items(org.d)
        for item in org.d.get('work_items') or []:
            attention = item.get('manual_attention')
            if attention or item.get('slug') in attached:
                owner = item.get('owner') or {}
                epoch = item.get('notification_attention_epoch', (attention or {}).get('set_rev') or 1)
                add(org,'work:'+str(item.get('slug'))+':'+str(epoch),
                    'work-attention',item.get('title'),(attention or {}).get('reason') or 'An attached question needs your answer.',owner.get('node'),item.get('slug'))
        for doc in org.d.get('documents') or []:
            add(org, 'document:'+str(doc.get('id')), 'document', doc.get('title') or 'New presented document',
                'Presented by '+str(doc.get('node')), doc.get('node'), source_id=doc.get('id'))
        for nid, node in (org.d.get('nodes') or {}).items():
            frozen = node.get('frozen')
            if node.get('state') == 'live' and frozen:
                generation = int(node.get('generation') or 0)
                add(org, f"frozen:{nid}:{generation}:{frozen.get('at')}", 'agent-frozen',
                    'Agent frozen: '+nid, 'Open the agent to see its current state.', nid, generation=generation)
    priority = {'question':0,'urgent-mail':1,'work-attention':2,'routine':3,'document':4,'agent-frozen':5}
    rows.sort(key=lambda row:(priority[row['kind']],row['org'],row['id']))
    offset = max(0, offset)
    end = offset + max(1, limit)
    return {'notices':rows[offset:end], 'total':len(rows), 'truncated':len(rows)>end,
            'next_offset':end if len(rows)>end else None,
            # The full, small identity list permits cleanup even when a resolved
            # alert was on a different page. Content stays paged and bounded.
            'active':[{'org':r['org'], 'id':r['id']} for r in rows]}
