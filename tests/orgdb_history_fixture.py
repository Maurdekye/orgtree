"""One synthetic history scale for the5000 recorded agent-hour benchmark.

Inputs are a current synthetic document and the numeric live-copy census. No
real record body is accepted or returned by the census contract. Current rows
remain fixed; only synthetic retained history grows at the measured rates.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import copy
import json
import math
from pathlib import Path
import statistics
import time


TARGET_HOURS = 5000
BASELINE_HOURS = 1
SAMPLES = 9
AT = '2026-10-01T10:00:00.000Z'
OLD = '2010-01-01T00:00:00.000Z'


def load_census(path=None):
    source = Path(path) if path else Path(__file__).with_name('fixtures') / 'orgdb_history_rates_20261002.json'
    return json.loads(source.read_text(encoding='utf-8-sig'))


def targets(census, hours=TARGET_HOURS):
    if census.get('measured_agent_hours', 0) <= 0:
        raise ValueError('no recorded duration denominator; report the coverage gap')
    return {key: math.ceil(rate * hours)
            for key, rate in census['rows_per_agent_hour'].items()}


def build_document(current, counts):
    """Build synthetic retained counts plus the fixed current inputs.

    `current` is the guard's zero-history engine-shaped fixture, not a live
    document. Recent-only turns use the difference between the deduplicated
    turn rate and the full log rate, capped at eight per archived body. Active
    recent turns and other current inputs stay fixed at both history sizes.
    """
    doc = copy.deepcopy(current)
    def count(key):
        value = counts.get(key, 0)
        if not isinstance(value, int) or value < 0:
            raise ValueError(f'invalid synthetic history count: {key}')
        return value

    prototype = doc['nodes']['dev']
    for i in range(count('archived_agents')):
        name = f'archive-{i:06}'
        node = copy.deepcopy(prototype)
        node.update(state='archived', archived_at=OLD, title=name, parent='boss',
                    seat_id=f'seat-{name}', session_id=f'session-{name}', lineage=name,
                    cost_usd=0.25, ui_order=-i-1, turns=[])
        if 'name' in prototype:
            node['name'] = name
        doc['nodes'][name] = node
    recent_only = max(0, count('deduplicated_turns') - count('turn_log'))
    if recent_only > 8 * count('archived_agents'):
        raise ValueError('recent-only turn target exceeds the archived recent-list capacity')
    for i in range(recent_only):
        node = doc['nodes'][f'archive-{i // 8:06}']
        node['turns'].append(dict(n=i % 8, at=OLD, ms=50))
    for key in ('asks', 'scope_requests', 'credit_requests', 'audience_requests'):
        history = [dict(id=f'closed-{key}-{i}', node='dev',
                        status='answered' if key == 'asks' else 'denied',
                        question='retained synthetic question', at=OLD, resolved_at=OLD,
                        reason='synthetic retained request')
                   for i in range(count('closed_' + key))]
        doc[key] = history + list(doc.get(key) or [])
    for key in ('mail_log', 'steered_log', 'turn_error_log', 'work_scope_log'):
        total = count(key)
        doc[key] = {}
        for owner, size in (('dev', (total + 1)//2), ('ops', total//2)):
            doc[key][owner] = [dict(id=f'{key}-{owner}-{i}', at=OLD,
                                    body='synthetic retained mail', text='retained',
                                    **{'from': 'boss'}) for i in range(size)]
    doc['turn_log'] = {'dev': [dict(n=i, at=OLD, ms=50, cost=0.1)
                               for i in range(count('turn_log'))]}
    for key in ('user_mail_log', 'user_inbox', 'user_outbox', 'org_inbox',
                'notice_log', 'watchdog_history'):
        history = [dict(id=f'{key}-{i}', at=OLD, node='dev', body='synthetic retained message',
                        text='retained', gist='retained', **{'from': 'dev'})
                   for i in range(count(key))]
        doc[key] = history + list(doc.get(key) or [])
    doc['events'] = [dict(op='hire', actor='dev', at=OLD, detail={'node': 'dev'})
                     for _ in range(count('events'))] + list(doc.get('events') or [])
    doc['audiences'] = [dict(grantee='archive-000000', grantor='user', granted_at=OLD)
                        for _ in range(count('audiences'))] + list(doc.get('audiences') or [])
    doc['orphan_keys'] = {f'old-{i}': dict(cause='retire', at=OLD)
                          for i in range(count('orphan_keys'))}
    doc['documents'] = [dict(id=f'document-history-{i}', node='dev', title='Retained presentation',
                             at=OLD, body='synthetic text', format='markdown')
                        for i in range(count('documents'))] + list(doc.get('documents') or [])
    prototype = next(row for row in doc['work_items_archive'] if row['slug'] == 'held-work')
    archives = []
    for i in range(count('archived_docket')):
        row = copy.deepcopy(prototype)
        row.update(slug=f'archive-work-{i}', title='Retained work', archived_at=OLD,
                   status='done', updated_at='2099-01-01T00:00:00Z')
        row.pop('manual_attention', None)
        row['history'] = []
        row['status_history'] = []
        archives.append(row)
    # Distribute long event histories over retained items, not current inputs.
    for key, metric in (('history', 'docket_history'), ('status_history', 'docket_status_history')):
        total = count(metric)
        if total and not archives:
            raise ValueError('docket events require a retained synthetic item')
        if archives:
            base, remainder = divmod(total, len(archives))
            for i, row in enumerate(archives):
                row[key] = [dict(at=OLD, op='status', changes={'status': {'from': 'open', 'to': 'done'}})
                            for _ in range(base + (i < remainder))]
    doc['work_items_archive'] = archives + list(doc['work_items_archive'])
    return doc


def sample(reader, slug):
    """Uninstrumented complete public calls, same cache policy at both sizes."""
    reader(slug)
    seconds = []
    for _ in range(SAMPLES):
        started = time.perf_counter()
        result = reader(slug)
        seconds.append(time.perf_counter() - started)
        if result is None:
            raise AssertionError('reader did not return a native result')
    return dict(samples_ms=[value * 1000 for value in seconds],
                median_ms=statistics.median(seconds) * 1000)


def added_latency(before, after):
    return after['median_ms'] - before['median_ms']
