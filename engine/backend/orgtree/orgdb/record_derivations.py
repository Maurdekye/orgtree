"""Record dependencies and transition-table capture (step-6 addendum, rev 3).

This is the schema-wide declaration, not a heuristic based on table prefixes.
Source triggers name direct records and scopes using ONLY OLD/NEW transition
rows. Cross-table work belongs to the serialized scope resolver. Panel pieces
extend these declarations alongside their entity/window body builders.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Mapping


@dataclass(frozen=True)
class Name:
    """An entity/id SQL expression over the transition row alias ``r``."""
    entity: str
    id: str
    when: str = 'true'
    # Optional UPDATE dependency columns. Empty means any actual row change.
    # Only agents use column guards: its immutable id pairs OLD with NEW.
    changed: tuple[str, ...] = ()


@dataclass(frozen=True)
class Source:
    names: tuple[Name, ...] = ()
    excluded: str = ''

    def __post_init__(self):
        if bool(self.names) == bool(self.excluded.strip()):
            raise ValueError('declare record dependencies OR an exclusion reason')


def group(*names: str) -> tuple[Name, ...]:
    return tuple(Name("'org'", repr(name)) for name in names)


def agent(column: str = 'agent_id') -> Name:
    return Name("'agent'", f'r.{column}::text', f'r.{column} IS NOT NULL')


def scope(kind: str, key: str, when: str = 'true', *, changed=()) -> Name:
    return Name("'~scope'", f"'{kind}:' || ({key})::text", when, tuple(changed))


def named(column: str) -> Name:
    return scope('name', f'r.{column}', f'r.{column} IS NOT NULL')


SOURCES: dict[str, Source] = {
    'agents': Source((agent('id'), agent('parent_id'), agent('predecessor_id'),
        agent('successor_id'),
        scope('pile', "coalesce(r.parent_id, 0)::text || ':' || r.id::text"),
        scope('pile', "r.id::text || ':-'"),
        scope('chain', 'r.parent_id', 'r.parent_id IS NOT NULL'),
        scope('lineage', 'r.id'), scope('lineage', 'r.successor_id', 'r.successor_id IS NOT NULL'),
        scope('references', 'r.id', changed=('name','tombstone')),
        scope('refname', 'r.name', changed=('name','tombstone')),
        # Leave subtree scopes unresolved until a reader's bounded snapshot.
        # Every changed bearer has its own row/id, just like the live root.
        scope('subtree', 'r.id', changed=('parent','parent_id','parent_misfit',
            'state','state_misfit','tombstone','extra','scope_is',
            'scope_permission_mode','scope_org_visibility','scope_effort',
            'scope_model_version','scope_prefer_reserve','scope_account_fallback',
            'scope_tools_is','scope_tools_bash','scope_tools_web','scope_tools_edit',
            'scope_tools_subagents','scope_tools_mcp_is','scope_add_dirs_is')),
        scope('detail', 'r.id'),
        *group('cost', 'audit', 'foreground', 'org_inbox'))),
    'org_settings': Source((*group('settings', 'cost', 'net', 'org_inbox'), Name("'agent'", "'*'"))),
    'org_sections': Source((*group('settings', 'tiers', 'cost', 'audit', 'foreground', 'asks',
        'audiences', 'watchdogs', 'inbox_summary', 'org_inbox', 'net', 'work_summary'),
        Name("'agent'", "'*'"))),
    'org_section_owners': Source((agent(),)),
    'org_dirs': Source(group('settings')),
    'org_tier_prices': Source((*group('tiers', 'audit'), Name("'agent'", "'*'"))),
    'org_tier_models': Source((*group('tiers', 'audit'), Name("'agent'", "'*'"))),
    'tool_lists': Source((scope('tools', 'r.id'),)),
    'tool_list_items': Source((scope('tools', 'r.list_id'),)),
    'asks': Source((*group('asks'), named('node'))),
    'ask_options': Source((*group('asks'), scope('ask', 'r.asks_id'))),
    'ask_work_items': Source((*group('asks', 'work_summary'), scope('ask', 'r.asks_id'))),
    'credit_requests': Source((*group('asks'), named('node'))),
    'scope_requests': Source((*group('asks'), named('node'))),
    'scope_request_items': Source((*group('asks'), scope('request', 'r.scope_requests_id'))),
    'audience_grants': Source((*group('audiences', 'org_inbox'), named('grantee'))),
    'audience_requests': Source(group('audiences')),
    'watchdogs': Source(group('watchdogs')),
    'watchdog_events': Source(group('watchdogs')),
    'watchdog_tombs': Source(group('watchdogs')),
    'documents': Source((named('node'),)),
    'user_inbox': Source(group('inbox_summary')),
    'user_inbox_attachments': Source(group('inbox_summary')),
    'org_inbox': Source(group('org_inbox')),
    'net_hubs': Source(group('net')),
    'net_state': Source(group('net')),
    'net_state_seen_ids': Source(group('net')),
    'org_doc_migrations': Source((*group('settings'), Name("'agent'", "'*'"))),
    'org_doc_migration_holders': Source((*group('settings'), Name("'agent'", "'*'"))),
    'org_doc_migration_healed': Source((*group('settings'), Name("'agent'", "'*'"))),
    'work_items': Source(group('work_summary')),
    'work_item_participants': Source(group('work_summary')),
    'work_item_done': Source(group('work_summary')),
    'work_item_next': Source(group('work_summary')),
    'work_item_acceptance': Source(group('work_summary')),
    'work_item_acceptance_checks': Source(group('work_summary')),
    'work_item_dependencies': Source(group('work_summary')),
    'work_item_review_seat_requests': Source(group('work_summary')),
    'work_item_review_seats': Source(group('work_summary')),
    'work_item_artifact_grants': Source(group('work_summary')),
    'work_item_delivery': Source(group('work_summary')),
    'work_item_holders': Source(group('work_summary')),
    'work_item_artifacts': Source(group('work_summary')),
    'work_item_findings': Source(group('work_summary')),
    'work_item_finding_decisions': Source(group('work_summary')),
    'work_item_events': Source(group('work_summary')),
    'work_scope_log': Source(group('work_summary')),
    'docket_question_links': Source(group('work_summary')),
    'agent_mcp_servers': Source((agent(), scope('subtree','r.agent_id'))),
    'agent_dir_grants': Source((agent(), scope('subtree','r.agent_id'))),
    'agent_tool_denials': Source((agent(),)),
    'agent_tool_approvals': Source((agent(),)),
    'agent_carriers': Source((agent(),)),
    'agent_carrier_tokens': Source((agent(),)),
    'agent_carrier_mail': Source((agent(),)),
    'agent_texts': Source((agent(),)),
    'agent_runtime': Source((agent(),)),
    'agent_mail_drain': Source((agent(),)),
    'agent_turns': Source((agent(),)),
    # Child rows name both OLD and NEW turn ids without looking up owners.
    # A deleted turn names its agent through agent_turns' own capture.
    'agent_turn_cost_unknown_fields': Source((scope('turn','r.turn_id'),)),
    'agent_turn_model_usage_keys': Source((scope('turn','r.turn_id'),)),
    'mail': Source((agent(),)),
    'delivery_batches': Source((agent(),)),
    'delivery_batch_ids': Source((scope('delivery', 'r.delivery_batches_id'),)),
}

# A local detail version belongs to the agent's own rows, not to a pile or
# parent capture that merely names it. Predecessor-detail changes also name
# successor bodies, whose opaque token depends on the whole predecessor chain.
for _table, _source in tuple(SOURCES.items()):
    if _table == 'agents':
        continue
    _direct = [n for n in _source.names if n.entity == "'agent'" and n.id == 'r.agent_id::text']
    if _direct:
        SOURCES[_table] = Source((*_source.names, scope('detail', 'r.agent_id'),
                                 scope('lineage', 'r.agent_id')))

# These explicit exclusions are for the TREE feed. A later panel extension must
# replace its relevant exclusion with that panel's dependencies in this map.
_EXCLUDED: dict[str, tuple[str, ...]] = {
    'Identity is checked beside the cursor, never served as a body': ('org_identity',),
    'Derived counters/locks are dirtied by their source rows, never by their own flush': (
        'org_revision', 'org_topology', 'foreground_parent_counts', 'docket_counters',
        'record_detail_versions', 'agent_subtree_stats'),
    'Capture/revision bookkeeping; capturing it would recurse': (
        'changes', 'revisions', 'record_time_state'),
    'Migration/conversion provenance does not feed tree bodies': (
        'schema_migrations', 'conversion_runs', 'conversion_run_kinds'),
    'Compatibility section-presence and transaction receipts do not feed tree bodies': (
        'compat_meta', 'tx_receipts', 'op_receipts'),
    'Unregistered document keys are not tree header keys': ('org_extra',),
    'Private account side files belong to the host/app overlay, not org bodies': (
        'org_accounts', 'org_account_marks', 'org_account_spend', 'org_account_aliases',
        'org_account_mark_audit'),
    'Durable jobs/admission state belongs to the runtime overlay': ('jobs', 'turn_requests'),
    'Lifecycle registry bookkeeping does not feed org tree bodies': ('retired_slugs',),
    'Panel history/log rows; no tree body reads this source': (
        'events', 'event_warnings', 'event_refs', 'lifecycle_events', 'notice_log', 'notices',
        'watchdog_history', 'agent_turn_errors', 'mail_transitions', 'mail_log',
        'mail_log_attachments', 'mail_log_attachments_missing', 'mailboxes',
        'user_outbox', 'user_outbox_attachments', 'user_outbox_attachments_missing',
        'user_mail_log', 'user_mail_log_attachments', 'reply_events', 'file_deliveries',
        'reservations', 'reservation_paths', 'orphan_keys', 'orphan_key_sections',
        'steer_records', 'steer_record_mail_ids', 'steer_record_delivery_ids',
        'steer_record_acked_ids', 'steer_record_recorded_ids', 'manual_attempts',
        'manual_attempt_mail_ids', 'steer_attempts', 'steer_attempt_toks',
        'steer_attempt_mail_ids', 'steer_attempt_views'),
}
for _reason, _tables in _EXCLUDED.items():
    for _table in _tables:
        if _table in SOURCES:
            raise ValueError(f'duplicate dependency: {_table}')
        SOURCES[_table] = Source(excluded=_reason)


_TABLE = re.compile(r'\b(CREATE|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?orgtree\.(\w+)\b', re.I)
_IDENTIFIER = re.compile(r'[a-z][a-z0-9_]*\Z')


def tables(migrations: Mapping[str, str]) -> set[str]:
    current = set()
    for file in sorted(migrations):
        for operation, name in _TABLE.findall(migrations[file]):
            if operation.upper() == 'CREATE':
                current.add(name.lower())
            else:
                current.discard(name.lower())
    return current


def completeness(migrations: Mapping[str, str], sources: Mapping[str, Source] = SOURCES) -> list[str]:
    current = tables(migrations)
    return ([f'{table}: missing record derivation or exclusion reason'
             for table in sorted(current - sources.keys())]
            + [f'{table}: capture declared for a missing or dropped table'
               for table, source in sorted(sources.items()) if source.names and table not in current])


def capture_function(table: str, source: Source) -> str:
    """Generate one transition-only function used by the table's three triggers.

    Each branch names both sides of an UPDATE; DISTINCT and the transaction key
    deduplicate within/across statements. The transaction-local scope flag is
    rollback/savepoint safe. No schema lookup or record body construction here.
    """
    if not _IDENTIFIER.fullmatch(table):
        raise ValueError(f'invalid source table: {table!r}')
    if source.excluded:
        return ''
    queries = []
    for operation, relations in (('INSERT', ('new_rows',)),
                                 ('UPDATE', ('old_rows', 'new_rows')),
                                 ('DELETE', ('old_rows',))):
        selects = []
        for relation in relations:
            for name in source.names:
                condition = name.when
                if operation == 'UPDATE':
                    other = 'new_rows' if relation == 'old_rows' else 'old_rows'
                    if name.changed:
                        if table != 'agents' or any(not _IDENTIFIER.fullmatch(c) for c in name.changed):
                            raise ValueError('column guards require agents and column identifiers')
                        left = ','.join(f'r.{c}' for c in name.changed)
                        right = ','.join(f'p.{c}' for c in name.changed)
                        # JSON text preserves NULL equality and authored JSON
                        # escapes that PostgreSQL jsonb cannot represent.
                        same = f'to_json(ROW({left}))::text=to_json(ROW({right}))::text'
                        same = 'p.id=r.id AND ' + same
                    else:
                        # Composite equality cannot compare json; jsonb also
                        # rejects preserved NUL/lone-surrogate JSON escapes.
                        same = 'to_json(r)::text=to_json(p)::text'
                    condition = f'({condition}) AND NOT EXISTS (SELECT 1 FROM {other} p WHERE {same})'
                selects.append(f'SELECT {name.entity} AS entity, {name.id} AS entity_id '
                               f'FROM {relation} r WHERE {condition}')
        branch = 'IF' if not queries else 'ELSIF'
        queries.append(f"  {branch} TG_OP = '{operation}' THEN\n"
            '    INSERT INTO orgtree.changes (xid, entity, entity_id)\n'
            '      SELECT DISTINCT pg_current_xact_id(), entity, entity_id FROM (\n        '
            + '\n        UNION ALL\n        '.join(selects)
            + '\n      ) named WHERE entity IS NOT NULL AND entity_id IS NOT NULL\n'
              '      ON CONFLICT DO NOTHING;')
    pending = ("  PERFORM set_config('orgtree.pending_scopes', '1', true);\n"
               if any(name.entity == "'~scope'" for name in source.names) else '')
    return (f'CREATE FUNCTION orgtree.record_capture_{table}() RETURNS trigger\n'
        'LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$\nBEGIN\n'
        "  IF current_setting('orgtree.capture', true) = 'off' THEN RETURN NULL; END IF;\n"
        + '\n'.join(queries) + '\n  END IF;\n' + pending
        + '  RETURN NULL;\nEND\n$fn$;\n')


def capture_sql(sources: Mapping[str, Source] = SOURCES) -> str:
    parts = []
    for table, source in sorted(sources.items()):
        if source.excluded:
            continue
        parts.append(capture_function(table, source))
        for operation, refs in (('INSERT', 'NEW TABLE AS new_rows'),
                                ('UPDATE', 'OLD TABLE AS old_rows NEW TABLE AS new_rows'),
                                ('DELETE', 'OLD TABLE AS old_rows')):
            parts.append(f'CREATE TRIGGER record_capture_{operation.lower()} AFTER {operation} '
                f'ON orgtree.{table} REFERENCING {refs} FOR EACH STATEMENT '
                f'EXECUTE FUNCTION orgtree.record_capture_{table}();\n')
    return '\n'.join(parts)


def capture_violations(sql: str) -> list[str]:
    """Reject statement-time cross-table reads, locks and unscoped writes.

    This checks the generated migration text, not just the Python declarations;
    a later hand edit must not move resolution back into statement time.
    """
    out = []
    functions = re.finditer(r'CREATE FUNCTION orgtree\.(record_capture_\w+)\(\).*?'
                            r'AS \$fn\$(.*?)\$fn\$;', sql, re.S)
    for function in functions:
        name, body = function.groups()
        code = re.sub(r"'(?:[^']|'')*'", "''", body)
        code = re.sub(r'--[^\n]*', '', code)
        reads = re.findall(r'\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9.]*)', code, re.I)
        for relation in sorted(set(reads) - {'old_rows', 'new_rows'}):
            out.append(f'{name}: statement capture reads {relation}')
        if re.search(r'\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b', code, re.I):
            out.append(f'{name}: statement capture takes a row lock')
        writes = re.findall(r'\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(orgtree\.\w+)', code, re.I)
        if set(writes) - {'orgtree.changes'}:
            out.append(f'{name}: statement capture writes outside own changes')
        calls = re.sub(r'\bINSERT\s+INTO\s+orgtree\.\w+\s*\(', 'INSERT (', code, flags=re.I)
        if re.search(r'\borgtree\.[a-z_][a-z_0-9]*\s*\(', calls, re.I):
            out.append(f'{name}: statement capture calls an org function')
        if 'pg_current_xact_id()' not in code:
            out.append(f'{name}: statement capture has no own transaction key')
    return out


@dataclass(frozen=True)
class Stream:
    """A window's source. Expressions use ``r``; order keys must be immutable.

    Union streams supply globally unique IDs, for example ``'notice:'||r.id``.
    Each stream uses the same order-key types and directions. The body builder
    receives those IDs unchanged, including when routing deleted-row tombstones.
    """
    table: str
    partition: str
    id: str
    order: tuple[str, ...]
    predicate: str = 'true'


@dataclass(frozen=True)
class Window:
    name: str
    size: int
    streams: tuple[Stream, ...]

    def __post_init__(self):
        if not _IDENTIFIER.fullmatch(self.name) or self.size < 1 or not self.streams:
            raise ValueError('window requires an identifier, positive K and at least one stream')
        width = len(self.streams[0].order)
        if not width or any(len(s.order) != width or not _IDENTIFIER.fullmatch(s.table)
                            for s in self.streams):
            raise ValueError('window streams require tables and matching nonempty order keys')


def with_windows(sources: Mapping[str, Source], windows: tuple[Window, ...]) -> dict[str, Source]:
    """Extend the ONE declaration map; no second handwritten capture list."""
    if len({w.name for w in windows}) != len(windows):
        raise ValueError('duplicate window name')
    result = dict(sources)
    for window in windows:
        for stream in window.streams:
            source = result.get(stream.table)
            if source is None:
                raise ValueError(f'window source is not declared: {stream.table}')
            entity = f"'{window.name}:' || ({stream.partition})::text"
            names = (Name(entity, stream.id),
                     scope(f'window:{window.name}', stream.partition))
            result[stream.table] = Source((*source.names, *names))
    return result


def window_resolution(window: Window) -> str:
    """Bounded resolution after the revision lock, over the committed state.

    ``partition_key`` and ``named_count`` are resolver locals. Taking K+m from
    EACH union stream is enough to compute the merged first K+m. The transaction
    count comes from captured distinct entry IDs, not the number of statements.
    """
    streams = []
    aliases = [f'key{i}' for i in range(len(window.streams[0].order))]
    order = ', '.join(f'{alias} DESC NULLS LAST' for alias in aliases)
    for stream in window.streams:
        columns = ', '.join(f'{expression} AS {alias}'
                            for expression, alias in zip(stream.order, aliases))
        streams.append(f'(SELECT ({stream.id})::text AS id, {columns} FROM orgtree.{stream.table} r '
            f'WHERE ({stream.partition})::text = partition_key AND ({stream.predicate}) '
            f'ORDER BY {order}, ({stream.id})::text COLLATE "C" LIMIT {window.size} + named_count)')
    return ('WITH candidates AS (' + ' UNION ALL '.join(streams) + '), ranked AS ('
        f'SELECT id, row_number() OVER (ORDER BY {order}, id COLLATE "C") AS rank FROM candidates) '
        'INSERT INTO orgtree.changes(xid,entity,entity_id) '
        f"SELECT pg_current_xact_id(), '{window.name}:' || partition_key, id FROM ranked "
        f'WHERE rank BETWEEN greatest(1,{window.size}-named_count+1) AND {window.size}+named_count '
        'ON CONFLICT DO NOTHING;')
