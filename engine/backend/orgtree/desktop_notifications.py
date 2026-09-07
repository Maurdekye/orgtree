"""Bounded operator attention projection across organizations; no providers."""
import hashlib
from . import store


def notices(limit=200):
    rows = []
    def add(org, key, kind, title, body, agent=None, item=None):
        identity = f"{org.d['slug']}:{org.d.get('created')}:{key}"
        rows.append({'id':hashlib.sha256(identity.encode()).hexdigest(), 'org':org.d['slug'],
                     'kind':kind, 'title':str(title)[:200], 'body':str(body or '')[:500],
                     **({'agent':str(agent)} if agent else {}), **({'item':str(item)} if item else {})})
    for _, org in store.list_orgs_with_docs():
        for ask in org.d.get('asks') or []:
            if ask.get('status') == 'open':
                add(org, 'ask:'+str(ask.get('id')), 'question', 'Question from '+str(ask.get('node')),
                    ask.get('question'), ask.get('node'))
        for mail in org.d.get('user_inbox') or []:
            add(org,'mail:'+str(mail.get('id')), 'urgent-mail' if mail.get('urgent') else 'routine',
                'Message from '+str(mail.get('from') or org.d.get('name')), mail.get('body') or mail.get('text'), mail.get('from'))
        for item in org.d.get('work_items') or []:
            attention = item.get('manual_attention')
            if attention:
                owner = item.get('owner') or {}
                add(org,'work:'+str(item.get('slug'))+':'+str(attention.get('set_rev')),
                    'work-attention',item.get('title'),attention.get('reason'),owner.get('node'),item.get('slug'))
    priority = {'question':0,'urgent-mail':1,'work-attention':2,'routine':3}
    rows.sort(key=lambda row:(priority[row['kind']],row['org'],row['id']))
    return {'notices':rows[:limit], 'total':len(rows), 'truncated':len(rows)>limit}
