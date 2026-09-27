"""One preallocated independent read-only socket; every acknowledged write checked."""
import contextlib
import json
import threading
import psycopg
from psycopg import sql


def decode(value):
    return json.loads(value) if isinstance(value, str) else value


def is_write(tool, args):
    return tool in ("orgtree_status", "orgtree_message", "orgtree_send_notice") or (
        tool == "orgtree_work" and args.get("action") in ("update", "evidence", "create"))


class WriteOracle:
    def __init__(self, descriptor):
        self.mutex = threading.Lock()
        self.keys = {}
        self.keys_mutex = threading.Lock()
        self.counts = dict(acknowledged=0, checked=0, failed=0)
        self.conn = psycopg.connect(descriptor["pg_url"], autocommit=True,
            application_name="scale-write-oracle",
            options="-c default_transaction_read_only=on -c statement_timeout=30000")
        self.conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
        try:
            row = self.conn.execute("SELECT org_id FROM public.orgs WHERE slug=%s", (descriptor["org"],)).fetchone()
            if not row:
                raise ValueError("oracle org missing")
            self.schema = sql.Identifier("org_" + str(row[0]))
            self.floor = self.conn.execute(sql.SQL("SELECT coalesce(max(seq),0) FROM {}.log_d")
                                           .format(self.schema)).fetchone()[0]
        except BaseException:
            self.conn.close()
            raise

    def close(self):
        self.conn.close()

    def lock(self, actor, tool, args):
        key = (("node", actor) if tool == "orgtree_status" else
               ("item", args["slug"]) if tool == "orgtree_work" and "slug" in args and
               args.get("action") in ("update", "evidence") else None)
        if key is None:
            return contextlib.nullcontext()
        with self.keys_mutex:
            return self.keys.setdefault(key, threading.Lock())

    def check(self, actor, tool, args, response):
        if not is_write(tool, args):
            return None
        if not isinstance(response, dict) or response.get("error") or response.get("isError"):
            return None  # no success acknowledged
        with self.mutex:
            self.counts["acknowledged"] += 1
            try:
                if response.get("state") == "running":
                    raise ValueError("asynchronous operation has no committed outcome yet")
                with self.conn.transaction():
                    passed = self._check(actor, tool, args, response)
                self.counts["checked"] += 1
                result = dict(passed=bool(passed), method="independent committed raw rows")
            except Exception as exc:
                result = dict(passed=False, error=f"{type(exc).__name__}: {exc}")
            self.counts["failed"] += not result["passed"]
            return result

    def _check(self, actor, tool, args, response):
        if tool == "orgtree_status":
            row = self.conn.execute(sql.SQL("SELECT val FROM {}.nodes WHERE id=%s").format(self.schema),
                                    (actor,)).fetchone()
            actual = decode(row[0]).get("last_status", {}) if row else {}
            return actual.get("summary") == args["summary"] and actual.get("status") == args["status"]
        if tool == "orgtree_work":
            slug = response.get("created") if args["action"] == "create" else args["slug"]
            row = self.conn.execute(sql.SQL("SELECT val FROM {}.doc WHERE key=%s").format(self.schema),
                                    ("work_items\x1f" + str(slug),)).fetchone()
            item = decode(row[0]) if row else {}
            if args["action"] == "evidence":
                return any(e.get("ref") == args.get("ref") and e.get("note") == args.get("note")
                           for e in item.get("evidence", []))
            fields = ("title", "objective") if args["action"] == "create" else ("done_so_far", "working_on_next")
            return all(item.get(key) == args[key] for key in fields)
        # Newly acknowledged mail is in the durable mail log even after drain.
        # Bound the observation to this arm's new seq domain, never LIKE-scan
        # accumulated inactive history. Observe raw source rows, not an index.
        mid = response.get("id")
        rows = self.conn.execute(sql.SQL("SELECT val FROM {}.log_d WHERE sect='mail_log' "
            "AND owner=%s AND seq>%s").format(self.schema), (args["to"], self.floor))
        return bool(mid) and any(str((m := decode(row[0])).get("id")) == str(mid)
                                and m.get("body") == args["body"] for row in rows)
