"""The shared app-database turn queue (design §2.4).

The host supplies a registered engine instance and a runtime connection
factory. A start_turn job first commits the org request pending -> queued,
then calls enqueue with that durable request id. Terminal tickets stay, so
retrying an old job never creates a second turn. An agent with an open ticket
raises AgentBusy; the job retries after the previous provider has stopped.

claim serializes admission on one small row, using SKIP LOCKED. Running AND
stopping tickets occupy slots. Completion matches the numbered claim and its
owner. A stale heartbeat alone never frees a slot: reclaim_expired first asks
the host to terminate/verify the exact process and its provider tree, outside
the transaction, and only then records dead/lost. The host alone calls it.

No connection or admin credential is held here. Each operation owns one short
transaction on a fresh runtime connection. Waiting is the adapter's concern.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

DEFAULT_LIMIT = 16
MAX_LIMIT = 512
LEASE_SECONDS = 30
HEARTBEAT_SECONDS = 5


class AgentBusy(RuntimeError):
    """Another request still reserves this agent."""


class LostClaim(RuntimeError):
    """This process no longer owns this numbered claim."""


@dataclass(frozen=True)
class Request:
    request_id: str
    org_id: int
    agent_id: int
    agent_name: str
    lane: str


@dataclass(frozen=True)
class Ticket:
    request_id: str
    org_id: int
    agent_id: int
    state: str
    epoch: int
    owner: int | None


_TICKET_COLS = "request_id, org_id, agent_id, state, claim_epoch, lease_owner"


def _ticket(row: Any) -> Ticket | None:
    return None if row is None else Ticket(*row)


def clamp_limit(value: Any) -> int:
    try:
        return max(0, min(MAX_LIMIT, int(value)))
    except (ValueError, TypeError):
        return DEFAULT_LIMIT


def app_connection() -> Any:
    """Runtime connection to this install's app database, never the admin."""
    from .orgdb import conn, names
    return conn.connect(conn.runtime_base(), names.app(), application_name="orgtree-turnqueue")


class Queue:
    def __init__(self, connect: Callable[[], Any] = app_connection) -> None:
        from contextlib import contextmanager
        import threading
        # One process cannot exhaust max_connections with a large waiting
        # backlog. Connections are short lived; one of these four may LISTEN.
        budget = threading.BoundedSemaphore(4)

        @contextmanager
        def bounded() -> Any:
            with budget, connect() as c:
                yield c
        self.connect = bounded

    @staticmethod
    def _gate(c: Any, *, skip: bool = False) -> Any:
        return c.execute("SELECT slot_limit, last_org_id FROM orgtree.turn_admission "
                         "WHERE singleton FOR UPDATE" + (" SKIP LOCKED" if skip else "")).fetchone()

    def enqueue(self, request: Request, instance_id: int) -> Ticket:
        """Idempotent app half of start_turn. Never revives a terminal id.

        The gate orders commits, rather than timestamps or sequence numbers
        allocated by transactions that may commit in reverse order.
        """
        import psycopg
        try:
            with self.connect() as c, c.transaction():
                self._gate(c)
                if c.execute("SELECT id FROM orgtree.engine_instances WHERE id = %s AND dead_at IS NULL "
                             "AND heartbeat_at > clock_timestamp() - interval '30 seconds' FOR SHARE",
                             (instance_id,)).fetchone() is None:
                    raise LostClaim("enqueuing instance is dead or its heartbeat expired")
                c.execute("INSERT INTO orgtree.turn_queue_orgs (org_id) VALUES (%s) "
                          "ON CONFLICT (org_id) DO NOTHING", (request.org_id,))
                c.execute("INSERT INTO orgtree.turn_tickets "
                          "(request_id, org_id, agent_id, agent_name, lane, state, lease_owner) "
                          "VALUES (%s, %s, %s, %s, %s, 'waiting', %s) "
                          "ON CONFLICT (request_id) DO NOTHING",
                          (request.request_id, request.org_id, request.agent_id,
                           request.agent_name, request.lane, instance_id))
                row = c.execute("SELECT " + _TICKET_COLS + ", agent_name, lane "
                                "FROM orgtree.turn_tickets WHERE request_id = %s",
                                (request.request_id,)).fetchone()
                if (row[1], row[2], row[7]) != (request.org_id, request.agent_id, request.lane):
                    raise ValueError("request id already belongs to a different turn")
                if row[3] == "waiting" and row[6] != request.agent_name:
                    c.execute("UPDATE orgtree.turn_tickets SET agent_name = %s "
                              "WHERE request_id = %s", (request.agent_name, request.request_id))
                return _ticket(row[:6])
        except psycopg.errors.UniqueViolation as exc:
            if exc.diag.constraint_name == "turn_tickets_one_open":
                raise AgentBusy("agent still has an open turn") from None
            raise

    def get(self, request_id: str) -> Ticket | None:
        with self.connect() as c:
            return _ticket(c.execute("SELECT " + _TICKET_COLS +
                                    " FROM orgtree.turn_tickets WHERE request_id = %s",
                                    (request_id,)).fetchone())

    def claim(self, instance_id: int, request_id: str | None = None) -> Ticket | None:
        """Claim the fair head, or nothing. A busy admission gate never waits.

        With request_id supplied, only that caller's request can be claimed;
        it cannot pass the fair head. Without it, a worker claims any head.
        Locked FIFO heads are skipped as whole orgs, never overtaken within
        their org. The host must start by CAS on the queued org request.
        """
        with self.connect() as c, c.transaction():
            gate = self._gate(c, skip=True)
            if gate is None:
                return None
            alive = c.execute("SELECT id FROM orgtree.engine_instances WHERE id = %s "
                              "AND dead_at IS NULL AND heartbeat_at > "
                              "clock_timestamp() - interval '30 seconds' FOR SHARE",
                              (instance_id,)).fetchone()
            if alive is None:
                raise LostClaim("engine instance is dead or its heartbeat expired")
            held = c.execute("SELECT count(*) FROM orgtree.turn_tickets "
                             "WHERE state IN ('running', 'stopping')").fetchone()[0]
            if held >= gate[0]:
                return None
            row = c.execute(
                "SELECT t.request_id FROM orgtree.turn_tickets t "
                "JOIN orgtree.turn_queue_orgs r ON r.org_id = t.org_id "
                "WHERE t.state = 'waiting' AND NOT EXISTS ("
                "SELECT 1 FROM orgtree.turn_tickets earlier WHERE earlier.org_id = t.org_id "
                "AND earlier.state = 'waiting' AND earlier.id < t.id) "
                "ORDER BY CASE WHEN r.position > COALESCE((SELECT position "
                "FROM orgtree.turn_queue_orgs WHERE org_id = %s), 0) THEN 0 ELSE 1 END, "
                "r.position, t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED", (gate[1],)).fetchone()
            if row is None or (request_id is not None and row[0] != request_id):
                return None
            ticket = _ticket(c.execute("UPDATE orgtree.turn_tickets SET state = 'running', "
                                      "claim_epoch = claim_epoch + 1, lease_owner = %s, "
                                      "started_at = clock_timestamp() WHERE request_id = %s "
                                      "RETURNING " + _TICKET_COLS, (instance_id, row[0])).fetchone())
            c.execute("UPDATE orgtree.turn_admission SET last_org_id = %s WHERE singleton",
                      (ticket.org_id,))
            return ticket

    def finish(self, ticket: Ticket) -> bool:
        """The provider is stopped: finish exactly this running claim."""
        with self.connect() as c, c.transaction():
            self._gate(c)
            return c.execute("UPDATE orgtree.turn_tickets SET state = 'done', "
                             "ended_at = clock_timestamp() WHERE request_id = %s "
                             "AND claim_epoch = %s AND lease_owner = %s AND state = 'running' "
                             "RETURNING id", (ticket.request_id, ticket.epoch, ticket.owner)).fetchone() is not None

    def cancel(self, request: Request) -> Ticket:
        """App half of cancellation, after the org half commits.

        Running becomes stopping and remains charged until owner/host stop
        acknowledgement. A missing ticket gets a terminal tombstone, blocking
        every late enqueue. Repeated cancellation never moves the epoch again.
        """
        with self.connect() as c, c.transaction():
            self._gate(c)
            c.execute("INSERT INTO orgtree.turn_tickets "
                      "(request_id, org_id, agent_id, agent_name, lane, state, ended_at) "
                      "VALUES (%s, %s, %s, %s, %s, 'cancelled', clock_timestamp()) "
                      "ON CONFLICT (request_id) DO NOTHING",
                      (request.request_id, request.org_id, request.agent_id, request.agent_name, request.lane))
            row = c.execute("SELECT " + _TICKET_COLS + ", lane FROM orgtree.turn_tickets "
                            "WHERE request_id = %s", (request.request_id,)).fetchone()
            if (row[1], row[2], row[6]) != (request.org_id, request.agent_id, request.lane):
                raise ValueError("request id already belongs to a different turn")
            c.execute("UPDATE orgtree.turn_tickets SET "
                      "state = CASE WHEN state = 'waiting' THEN 'cancelled' ELSE 'stopping' END, "
                      "claim_epoch = claim_epoch + 1, "
                      "ended_at = CASE WHEN state = 'waiting' THEN clock_timestamp() ELSE NULL END "
                      "WHERE request_id = %s AND state IN ('waiting', 'running')", (request.request_id,))
            return _ticket(c.execute("SELECT " + _TICKET_COLS + " FROM orgtree.turn_tickets "
                                    "WHERE request_id = %s", (request.request_id,)).fetchone())

    def cancel_before_start(self, ticket: Ticket) -> bool:
        """Start's org CAS failed: no provider launched; free this claim now."""
        with self.connect() as c, c.transaction():
            self._gate(c)
            return c.execute("UPDATE orgtree.turn_tickets SET state = 'cancelled', "
                             "claim_epoch = claim_epoch + 1, ended_at = clock_timestamp() "
                             "WHERE request_id = %s AND claim_epoch = %s AND lease_owner = %s "
                             "AND state = 'running' RETURNING id",
                             (ticket.request_id, ticket.epoch, ticket.owner)).fetchone() is not None

    def acknowledge_stop(self, request_id: str, instance_id: int, epoch: int) -> bool:
        """The current owner has stopped its provider; free a stopping claim."""
        with self.connect() as c, c.transaction():
            self._gate(c)
            return c.execute("UPDATE orgtree.turn_tickets SET state = 'cancelled', "
                             "ended_at = clock_timestamp() WHERE request_id = %s "
                             "AND lease_owner = %s AND claim_epoch = %s AND state = 'stopping' "
                             "RETURNING id", (request_id, instance_id, epoch)).fetchone() is not None

    def heartbeat(self, instance_id: int) -> list[Ticket]:
        """Host calls every 5 s. Returns owned turns, including stop requests.

        The host reconciles them against org requests and tells the owning
        process to stop. A dead instance can never resurrect its lease.
        """
        with self.connect() as c, c.transaction():
            return heartbeat(c, instance_id)

    def reclaim_expired(self, instance_id: int, confirm_dead: Callable[[dict[str, Any]], bool]) -> list[Ticket]:
        """Host only: terminate the exact stale process/tree, THEN reclaim.

        The callback gets id/host/pid/started_at/heartbeat_at. It must verify
        process identity and provider termination, not only heartbeat age.
        False, an exception, or a refreshed lease means no reclamation.
        """
        with self.connect() as c:
            row = c.execute("SELECT id, host, pid, started_at, heartbeat_at "
                            "FROM orgtree.engine_instances WHERE id = %s AND dead_at IS NULL "
                            "AND heartbeat_at <= clock_timestamp() - interval '30 seconds'",
                            (instance_id,)).fetchone()
        if row is None:
            return []
        identity = dict(zip(("id", "host", "pid", "started_at", "heartbeat_at"), row))
        if not confirm_dead(identity):
            return []
        with self.connect() as c, c.transaction():
            self._gate(c)
            dead = c.execute("UPDATE orgtree.engine_instances SET dead_at = clock_timestamp() "
                             "WHERE id = %s AND host = %s AND pid = %s AND started_at = %s "
                             "AND heartbeat_at = %s AND dead_at IS NULL "
                             "AND heartbeat_at <= clock_timestamp() - interval '30 seconds' RETURNING id", row).fetchone()
            if dead is None:
                return []
            return [_ticket(r) for r in c.execute("UPDATE orgtree.turn_tickets SET state = 'lost', "
                                                  "claim_epoch = claim_epoch + 1, ended_at = clock_timestamp() "
                                                  "WHERE lease_owner = %s AND state IN ('waiting', 'running', 'stopping') "
                                                  "RETURNING " + _TICKET_COLS, (instance_id,)).fetchall()]

    def set_limit(self, limit: Any) -> None:
        with self.connect() as c, c.transaction():
            self._gate(c)
            c.execute("UPDATE orgtree.turn_admission SET slot_limit = %s WHERE singleton", (clamp_limit(limit),))

    def snapshot(self) -> dict[str, Any]:
        # A single statement sees the limit and tickets at one snapshot.
        with self.connect() as c:
            rows = c.execute("SELECT a.slot_limit, o.slug, "
                             "count(t.id) FILTER (WHERE t.state = 'waiting'), "
                             "count(t.id) FILTER (WHERE t.state IN ('running', 'stopping')) "
                             "FROM orgtree.turn_admission a LEFT JOIN orgtree.turn_tickets t "
                             "ON t.state IN ('waiting', 'running', 'stopping') "
                             "LEFT JOIN orgtree.orgs o ON o.org_id = t.org_id "
                             "GROUP BY a.slot_limit, o.slug").fetchall()
        return {"limit": rows[0][0], "held": sum(r[3] for r in rows),
                "waiting": sum(r[2] for r in rows),
                "waiting_by_org": {r[1]: r[2] for r in rows if r[2]}}


def stale_instances(conn: Any, max_age_s: float = LEASE_SECONDS) -> list[tuple[Any, ...]]:
    """Lease candidates only. The host still has to verify process death."""
    if max_age_s <= 0:
        raise ValueError("lease age must be positive")
    return conn.execute("SELECT id, host, pid, started_at, heartbeat_at FROM orgtree.engine_instances "
                        "WHERE dead_at IS NULL AND heartbeat_at <= clock_timestamp() - %s * interval '1 second' "
                        "ORDER BY id", (max_age_s,)).fetchall()


def reclaim_instance(conn: Any, instance_id: int) -> dict[str, int]:
    """Host-only acknowledgement of verified death, including startup recovery.

    A new host holding the data-root lock may reclaim its predecessor without
    waiting 30 s: the guardian already killed that whole tree. A worker is
    reclaimed only after the host checks pid/start time and kills its tree.
    This function deliberately does NOT derive death from a heartbeat.
    """
    counts = {"waiting": 0, "running": 0, "stopping": 0}
    with conn.transaction():
        Queue._gate(conn)
        if conn.execute("UPDATE orgtree.engine_instances SET dead_at = clock_timestamp() "
                        "WHERE id = %s AND dead_at IS NULL RETURNING id", (instance_id,)).fetchone() is None:
            return counts
        rows = conn.execute("SELECT state FROM orgtree.turn_tickets WHERE lease_owner = %s "
                            "AND state IN ('waiting', 'running', 'stopping') FOR UPDATE", (instance_id,)).fetchall()
        for row in rows:
            counts[row[0]] += 1
        conn.execute("UPDATE orgtree.turn_tickets SET state = 'lost', claim_epoch = claim_epoch + 1, "
                     "ended_at = clock_timestamp() WHERE lease_owner = %s "
                     "AND state IN ('waiting', 'running', 'stopping')", (instance_id,))
    return counts


def heartbeat(conn: Any, instance_id: int) -> list[Ticket]:
    """Owner's 5 s heartbeat and authoritative reread of its tickets."""
    with conn.transaction():
        if conn.execute("UPDATE orgtree.engine_instances SET heartbeat_at = clock_timestamp() "
                        "WHERE id = %s AND dead_at IS NULL RETURNING id", (instance_id,)).fetchone() is None:
            raise LostClaim("engine instance was marked dead")
        return [_ticket(r) for r in conn.execute("SELECT " + _TICKET_COLS +
                                                " FROM orgtree.turn_tickets WHERE lease_owner = %s "
                                                "AND state IN ('waiting', 'running', 'stopping')",
                                                (instance_id,)).fetchall()]
