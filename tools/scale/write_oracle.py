"""Independent read-only PG checks; never use the engine's cache or connection pool."""
import contextlib
import json
import threading
import psycopg
from psycopg import sql


def decode(value):
    return json.loads(value) if isinstance(value, str) else value


class WriteOracle:
    def __init__(self, descriptor):
        self.url = descriptor['pg_url']
        self.locks = {}
        self.mu = threading.Lock()
        self._connection_lock = threading.Lock()
        # Reserve capacity before traffic. This is never the engine's pool.
        self._conn = psycopg.connect(self.url, autocommit=True,
                                     application_name='scale-write-oracle',
                                     options='-c default_transaction_read_only=on -c statement_timeout=30000')
        self._conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
        try:
            with self.connection() as conn:
                row = conn.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (descriptor['org'],)).fetchone()
                if not row:
                    raise RuntimeError('oracle: org missing')
                self.schema = 'org_' + str(row[0])
        except BaseException:
            self.close()
            raise

    @contextlib.contextmanager
    def connection(self):
        # Fresh transaction, not a fresh socket: no snapshot crosses checks.
        # One lock protects transaction boundaries as well as individual queries.
        with self._connection_lock:
            if self._conn.closed:
                raise RuntimeError('oracle: reserved connection is closed')
            with self._conn.transaction():
                yield self._conn

    def close(self):
        with self._connection_lock:
            self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    def lock(self, actor, tool, args):
        key = (('status', actor) if tool == 'orgtree_status' else
               ('item', args['slug']) if tool == 'orgtree_work' and args.get('action') == 'update' else None)
        if key is None:
            return contextlib.nullcontext()
        with self.mu:
            return self.locks.setdefault(key, threading.Lock())

    def items(self, conn, slug=None):
        """Read committed raw storage, independent of the product's row reader."""
        row = conn.execute(sql.SQL("SELECT val FROM {}.doc WHERE key='work_items'")
                           .format(sql.Identifier(self.schema))).fetchone()
        value = decode(row[0]) if row else []
        if isinstance(value, list):
            return {it['slug']: it for it in value if slug is None or it['slug'] == slug}
        if not isinstance(value, dict) or value.get('format') != 'orgtree.work-items/v1':
            raise RuntimeError('oracle: unknown work-item layout')
        ids = value['ids'] if slug is None else ([slug] if slug in value['ids'] else [])
        found = conn.execute(sql.SQL('SELECT key,val FROM {}.doc WHERE key = ANY(%s)')
                             .format(sql.Identifier(self.schema)),
                             (['work_items\x1f' + item for item in ids],)).fetchall()
        result = {key.split('\x1f', 1)[1]: decode(raw) for key, raw in found}
        if set(result) != set(ids) or any(item.get('slug') != key for key, item in result.items()):
            raise RuntimeError('oracle: missing or inconsistent committed item row')
        return result

    def check_overwrite(self, actor, tool, args):
        if tool != 'orgtree_status' and not (tool == 'orgtree_work' and args.get('action') == 'update'):
            return None
        with self.connection() as conn:
            if tool == 'orgtree_status':
                row = conn.execute(sql.SQL('SELECT val::jsonb->\'last_status\' FROM {}.nodes WHERE id=%s')
                                   .format(sql.Identifier(self.schema)), (actor,)).fetchone()
                actual = decode(row[0]) if row and row[0] is not None else {}
                expected = {'status': 'idle' if args['status'] == 'done' else args['status'],
                            'summary': args['summary']}
            else:
                item = self.items(conn, args['slug']).get(args['slug'], {})
                expected = {key: args[key] for key in ('done_so_far', 'working_on_next') if key in args}
                actual = {key: item.get(key) for key in expected}
        passed = all(actual.get(key) == value for key, value in expected.items())
        return {'passed': passed, 'expected': expected, 'actual': actual,
                'method': 'fresh read-only PostgreSQL transaction on one reserved independent connection after HTTP acknowledgment'}

    def snapshot(self, receipts=()):
        def dictionaries(value):
            if isinstance(value, dict):
                yield value
                for child in value.values():
                    yield from dictionaries(child)
            elif isinstance(value, list):
                for child in value:
                    yield from dictionaries(child)
        def contains(value, wanted):
            if isinstance(value, str):
                return value == wanted
            if isinstance(value, dict):
                return any(contains(v, wanted) for v in value.values())
            if isinstance(value, list):
                return any(contains(v, wanted) for v in value)
            return False
        with self.connection() as conn:
            conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            counts = {table: conn.execute(sql.SQL('SELECT count(*) FROM {}.{}').format(
                sql.Identifier(self.schema), sql.Identifier(table))).fetchone()[0]
                for table in ('doc', 'nodes', 'log_d', 'log_l')}
            items = self.items(conn)
            mail_rows = []
            for table in ('doc', 'log_d', 'log_l'):
                for row in conn.execute(sql.SQL("SELECT val FROM {}.{} WHERE val LIKE %s").format(
                        sql.Identifier(self.schema), sql.Identifier(table)), ('%[scale:%',)):
                    mail_rows.extend(dictionaries(decode(row[0])))
            checks = []
            for receipt in receipts:
                args, response = receipt['args'], receipt['response']
                tool = receipt['tool']
                if response.get('error') or response.get('isError') or response.get('state') == 'running':
                    continue
                passed = None
                if tool in ('orgtree_message', 'orgtree_send_notice'):
                    mid = response.get('id')
                    passed = bool(mid) and any(str(m.get('id')) == str(mid) and contains(m, args['body'])
                                              for m in mail_rows)
                elif tool == 'orgtree_work' and args.get('action') == 'evidence':
                    passed = any(e.get('ref') == args.get('ref') and e.get('note') == args.get('note')
                                 for e in items.get(args['slug'], {}).get('evidence', []))
                elif tool == 'orgtree_work' and args.get('action') == 'create':
                    created = items.get(response.get('created'), {})
                    passed = created.get('title') == args['title'] and created.get('objective') == args['objective']
                if passed is not None:
                    checks.append({'request_id': receipt['request_id'], 'tool': tool,
                                   'action': args.get('action'), 'passed': passed})
        return {'counts': counts, 'append_checks': checks,
                'passed': all(check['passed'] for check in checks)}
