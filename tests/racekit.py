"""PG-5: a small harness that FORCES an interleaving of org_tx transactions
and checks that the interleaving it asked for is the one that happened.

THE PROBLEM. A race test that merely starts two threads and hopes proves
nothing: the scheduler usually runs them one after the other and the test is
green whether or not the code is safe. Each family's race test (PYPG-PLAN.md
§2, RT1-RT10) needs the same three things, so they live here once:

  * HOLD a named actor at an org_tx pause point (`before_lock`, `after_lock`,
    `before_commit`, `after_commit` — PG-0's test hooks) or at a `mark()`
    the test puts in its own code, until the test releases it;
  * PROVE that another actor is WAITING ON A ROW LOCK, from the lock
    manager's own state — the fake's `RowLocks` wait-for table, or
    PostgreSQL's `pg_stat_activity.wait_event_type = 'Lock'` for that
    actor's own backend pid. Never from "it has not finished yet";
  * RECORD the achieved order of every point every actor passed, and FAIL
    unless the order the test expects is the order that happened.

A run whose forcing did not happen fails instead of passing: a gate that
never fired, a gate never released, an actor that is still running at the
end, an actor that raised when the test did not say it may, and a
`blocked()` that the lock manager does not confirm are all failures.

USE:

    with racekit.Race() as race:
        a = race.actor("A", write_row, "a")
        b = race.actor("B", write_row, "a")
        ga = race.hold(a, "after_lock")        # A will stop holding its locks
        race.start(a)
        race.reached(ga)                        # A is provably holding them
        race.start(b)
        race.blocked(b)                         # B provably waits on a row lock
        race.release(ga)
        race.join(a, b)
        race.expect_order("A.after_commit", "B.after_lock")

Pass `Race(pair="converted")` when both racers are org_tx paths: it refuses
to arm while `orgtx.TRANSITION_FENCE` is on (plan decision 19), because then
DOC_LOCK, not the row locks, orders them. `pair="unconverted"` (one racer is
legacy DOC_LOCK code) leaves the fence alone. `race.facts` records both.

Inside actor code, `race.mark("body-enter")` records a point of the test's
own (and can be held like any pause point). `Race.mark` is a no-op on a
thread that is not an actor.

ISOLATION (fail closed). `Race()` refuses to arm unless
`ORGTREE_ORGTX_TEST_HOOKS=1`, the data root is inside the system temp folder,
and — on the PostgreSQL backend — `ORGTREE_PG_URL` names a database that
`disposable_pg()` created in this process. It never touches live data.

LIMITS. Actors are threads in one process: on the fake that is the only
thing its per-process locks can order; on PostgreSQL each actor still gets
its own server session, so the row locks are the server's. Two engine
PROCESSES on one PostgreSQL are not modelled here.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import tempfile
import threading
import time
import traceback
from typing import Any, Callable
from typing import TYPE_CHECKING
from urllib.parse import urlsplit, urlunsplit

if TYPE_CHECKING:
    from orgtree import orgtx

# orgtree is imported where it is used, never at import time: a test must be
# able to create its disposable database (disposable_pg) BEFORE store reads
# ORGTREE_STORE / ORGTREE_PG_URL.

WAIT_S = 5.0

_disposable_urls: set[str] = set()


class RaceFailure(AssertionError):
    """The forced interleaving did not happen, or was not the one expected."""


def disposable_pg(admin_url: str, prefix: str) -> str:
    """Create a throwaway database `<prefix>_t<pid>` on the DISPOSABLE server
    `admin_url`, and return its URL. Only a URL returned here arms a Race on
    the PostgreSQL backend. Drop it with `drop_disposable_pg`."""
    import psycopg
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", prefix):
        raise ValueError(f"bad database prefix {prefix!r}")
    db = f"{prefix}_t{os.getpid()}"
    with psycopg.connect(admin_url, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {db}")
        c.execute(f"CREATE DATABASE {db}")
    p = urlsplit(admin_url)
    url = urlunsplit((p.scheme, p.netloc, "/" + db, p.query, p.fragment))
    _disposable_urls.add(url)
    return url


def drop_disposable_pg(admin_url: str, url: str) -> None:
    import psycopg
    if url not in _disposable_urls:
        raise ValueError("not a database disposable_pg created")
    db = urlsplit(url).path.lstrip("/")
    with psycopg.connect(admin_url, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {db} WITH (FORCE)")
    _disposable_urls.discard(url)


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def isolation_proof() -> dict[str, str]:
    """Why this process may force races: returns the facts, or raises."""
    from orgtree import store
    if os.environ.get("ORGTREE_ORGTX_TEST_HOOKS", "") != "1":
        raise RaceFailure("racekit needs ORGTREE_ORGTX_TEST_HOOKS=1")
    tmp = Path(tempfile.gettempdir()).resolve()
    root = Path(store.DATA_ROOT).resolve()
    if not _inside(root, tmp) or root == tmp:
        raise RaceFailure(f"data root {root} is not a throwaway folder inside {tmp}")
    facts = {"data_root": str(root), "backend": store.STORE_BACKEND}
    if store.STORE_BACKEND == "postgres":
        if os.environ.get("ORGTREE_PG_CONNINFO", "").strip():
            # pgstore prefers CONNINFO over the URL: it would bypass the check below
            raise RaceFailure("ORGTREE_PG_CONNINFO is set; racekit only runs on the "
                              "ORGTREE_PG_URL that disposable_pg() created")
        url = os.environ.get("ORGTREE_PG_URL", "")
        if url not in _disposable_urls:
            raise RaceFailure("ORGTREE_PG_URL is not a database disposable_pg() "
                              "created in this process")
        facts["pg_database"] = urlsplit(url).path.lstrip("/")
    return facts


class Gate:
    """A hold on one actor at the nth time it passes one point."""

    def __init__(self, actor: str, point: str, nth: int):
        self.actor, self.point, self.nth = actor, point, nth
        self.fired = 0
        self.arrived = threading.Event()
        self.released = threading.Event()
        self.timed_out = False

    def __repr__(self) -> str:
        return f"<Gate {self.actor}.{self.point}#{self.nth} fired={self.fired}>"


class Actor:
    def __init__(self, race: "Race", name: str, fn: Callable[..., Any],
                 args: tuple[Any, ...], kwargs: dict[str, Any], may_raise: bool):
        self.race, self.name = race, name
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.may_raise = may_raise
        self.result: Any = None
        self.error: BaseException | None = None
        self.error_tb = ""
        self.counts: dict[str, int] = {}
        self.lock_owner: object | None = None     # fake: its RowLocks owner token
        self.pg_pids: list[int] = []               # postgres: its sessions
        self.thread = threading.Thread(target=self._run, name=f"race:{name}", daemon=True)

    def _run(self) -> None:
        with self.race._cv:           # before fn runs, so its first point is ours
            self.race._by_thread[threading.get_ident()] = self
        try:
            self.result = self.fn(*self.args, **self.kwargs)
            self.race._event(self, "done")
        except BaseException as e:                 # noqa: BLE001 — reported by the race
            self.error, self.error_tb = e, traceback.format_exc()
            self.race._event(self, "raised")

    def __repr__(self) -> str:
        return f"<Actor {self.name}>"


def fence_state() -> str:
    """`orgtx.TRANSITION_FENCE` (plan decision 19): while ON, every org_tx
    takes DOC_LOCK before its rows, so DOC_LOCK, not the row locks, orders
    two org_tx paths. 'absent' on a build that has no fence."""
    from orgtree import orgtx
    if not hasattr(orgtx, "TRANSITION_FENCE"):
        return "absent"
    return "on" if orgtx.TRANSITION_FENCE else "off"


class Race:
    def __init__(self, wait: float = WAIT_S, hold: float | None = None,
                 pair: str | None = None):
        # `pair` (plan decision 19): "converted" = both racers are org_tx
        # paths, meaningful only with the transition fence OFF, so it refuses
        # to arm with the fence on; "unconverted" = one racer is legacy
        # DOC_LOCK code, fence left as the build ships it. Either way the
        # fence state is recorded in `facts`.
        if pair not in (None, "converted", "unconverted"):
            raise ValueError(f"pair must be 'converted' or 'unconverted', not {pair!r}")
        self.pair = pair
        # `wait` bounds each step the TEST waits for; `hold` bounds how long a
        # gate holds an actor, and outlasts several steps by default
        self.wait = wait
        self.hold_s = 3 * wait if hold is None else hold
        self.facts: dict[str, str] = {}
        self.events: list[tuple[str, str]] = []
        self.blocked_on: dict[str, str] = {}
        self._actors: dict[str, Actor] = {}
        self._by_thread: dict[int, Actor] = {}
        self._gates: dict[tuple[str, str, int], Gate] = {}
        self._cv = threading.Condition()
        self._undo: list[Callable[[], None]] = []
        self._armed = False

    # ------------------------------------------------------------ arming
    def __enter__(self) -> "Race":
        from orgtree import orgtx
        self.facts = isolation_proof()
        self.facts["transition_fence"] = fence_state()
        self.facts["pair"] = self.pair or "unspecified"
        if self.pair == "converted" and self.facts["transition_fence"] == "on":
            raise RaceFailure("a converted-vs-converted race needs orgtx.TRANSITION_FENCE "
                              "off: with it on, DOC_LOCK orders the racers and hides the "
                              "row-lock ordering under test")
        self._backend = orgtx.backend()
        orgtx.set_pause_hook(self._hook)
        self._undo.append(lambda: orgtx.set_pause_hook(None))
        if isinstance(self._backend, orgtx.SeamBackend):
            self._wrap_row_locks(self._backend.locks)
        elif isinstance(self._backend, orgtx.PgBackend):
            self._wrap_pg_open()
        else:
            raise RaceFailure(f"no lock-wait probe for backend {type(self._backend).__name__}")
        self._armed = True
        return self

    def __exit__(self, et: Any, ev: Any, tb: Any) -> None:
        with self._cv:
            gates = list(self._gates.values())
        for g in gates:
            g.released.set()
        for a in self._actors.values():
            if a.thread.is_alive():
                a.thread.join(self.wait)
        for fn in reversed(self._undo):
            fn()
        self._undo.clear()
        self._armed = False
        if et is not None:
            return
        problems: list[str] = []
        for g in gates:
            if g.fired != 1:
                problems.append(f"{g!r} did not fire exactly once — the interleaving it forces did not happen")
            if g.timed_out:
                problems.append(f"{g!r} was never released within {self.hold_s}s")
        for a in self._actors.values():
            if not a.thread.ident:
                problems.append(f"{a!r} was never started")
            elif a.thread.is_alive():
                problems.append(f"{a!r} is still running (hung)")
            elif a.error is not None and not a.may_raise:
                problems.append(f"{a!r} raised:\n{a.error_tb}")
        if problems:
            raise RaceFailure("\n".join(problems) + f"\nachieved order: {self.order()}")

    # ------------------------------------------------------------ probes
    def _wrap_row_locks(self, locks: orgtx.RowLocks) -> None:
        orig = locks.acquire
        race = self

        def acquire(owner: object, key: orgtx.RowKey, exclusive: bool, timeout: float) -> None:
            a = race._current()
            if a is not None:
                a.lock_owner = owner
            return orig(owner, key, exclusive, timeout)

        locks.acquire = acquire                    # type: ignore[method-assign]
        self._undo.append(lambda: delattr(locks, "acquire"))

        def waiting(a: Actor) -> str | None:
            if a.lock_owner is None:
                return None
            if hasattr(locks, "waiting"):           # PG-0 round 2: public view
                blockers = locks.waiting(a.lock_owner)
            else:
                with locks._cv:                     # the lock manager's own state
                    blockers = frozenset(locks._waits.get(a.lock_owner, ()))
            return "row lock (RowLocks wait-for table)" if blockers else None
        self._waiting = waiting

    def _wrap_pg_open(self) -> None:
        import psycopg
        from orgtree import pgstore
        orig = pgstore.open_conn
        race = self

        def open_conn(*a: Any, **k: Any) -> Any:
            conn = orig(*a, **k)
            act = race._current()
            if act is not None:
                act.pg_pids.append(int(conn.raw.info.backend_pid))
            return conn

        pgstore.open_conn = open_conn               # type: ignore[assignment]
        self._undo.append(lambda: setattr(pgstore, "open_conn", orig))
        probe = psycopg.connect(os.environ["ORGTREE_PG_URL"], autocommit=True)
        self._undo.append(probe.close)

        def waiting(a: Actor) -> str | None:
            if not a.pg_pids:
                return None
            row = probe.execute(
                "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = %s",
                (a.pg_pids[-1],)).fetchone()
            if row is None or row[0] != "Lock":
                return None
            return f"postgres Lock/{row[1]} (pid {a.pg_pids[-1]})"
        self._waiting = waiting

    # ------------------------------------------------------------ recording
    def _current(self) -> Actor | None:
        return self._by_thread.get(threading.get_ident())

    def _event(self, a: Actor, point: str) -> Gate | None:
        with self._cv:
            n = a.counts[point] = a.counts.get(point, 0) + 1
            self.events.append((a.name, point))
            g = self._gates.get((a.name, point, n))
            if g is not None:
                g.fired += 1
                g.arrived.set()
            self._cv.notify_all()
            return g

    def _pass(self, point: str) -> None:
        a = self._current()
        if a is None:
            return
        g = self._event(a, point)
        if g is not None and not g.released.wait(self.hold_s):
            g.timed_out = True
            raise RaceFailure(f"{g!r} was never released")

    def _hook(self, point: str, tx: orgtx.OrgTx) -> None:
        self._pass(point)

    def mark(self, label: str) -> None:
        """Record (and, if a gate names it, hold at) a point of the test's own."""
        if ":" in label or "." in label:
            raise ValueError("a mark label may not contain '.' or ':'")
        self._pass(label)

    # ------------------------------------------------------------ driving
    def actor(self, name: str, fn: Callable[..., Any], *args: Any,
              may_raise: bool = False, **kwargs: Any) -> Actor:
        if not self._armed:
            raise RaceFailure("Race is not armed: use it as a context manager")
        if name in self._actors or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError(f"bad or duplicate actor name {name!r}")
        a = Actor(self, name, fn, args, kwargs, may_raise)
        self._actors[name] = a
        return a

    def hold(self, a: Actor, point: str, nth: int = 1) -> Gate:
        if a.thread.ident:
            raise RaceFailure(f"hold {a.name}.{point} before starting {a.name}")
        key = (a.name, point, nth)
        if key in self._gates:
            raise ValueError(f"duplicate gate {key}")
        g = self._gates[key] = Gate(a.name, point, nth)
        return g

    def start(self, *actors: Actor) -> None:
        for a in actors:
            a.thread.start()

    def reached(self, g: Gate) -> None:
        """Wait until the gate's actor is being held there."""
        if not g.arrived.wait(self.wait):
            raise RaceFailure(f"{g!r} was not reached within {self.wait}s; "
                              f"achieved order: {self.order()}")

    def release(self, g: Gate) -> None:
        if not g.arrived.is_set():
            raise RaceFailure(f"release of {g!r} before it was reached")
        g.released.set()

    def blocked(self, a: Actor) -> str:
        """Wait until the LOCK MANAGER reports `a` waiting on a row lock.
        Records `<name>.blocked` in the order. Fails if it never does."""
        deadline = time.monotonic() + self.wait
        while True:
            how = self._waiting(a)
            if how is not None:
                self.blocked_on[a.name] = how
                self._event(a, "blocked")
                return how
            if not a.thread.is_alive() or time.monotonic() > deadline:
                raise RaceFailure(f"{a!r} was never seen waiting on a row lock; "
                                  f"achieved order: {self.order()}")
            time.sleep(0.005)

    def not_blocked(self, a: Actor, g: Gate) -> None:
        """`a` reaches gate `g` without the lock manager ever seeing it wait."""
        deadline = time.monotonic() + self.wait
        while not g.arrived.is_set():
            if self._waiting(a) is not None:
                raise RaceFailure(f"{a!r} waited on a row lock before {g!r}")
            if time.monotonic() > deadline:
                raise RaceFailure(f"{g!r} was not reached within {self.wait}s")
            time.sleep(0.002)

    def join(self, *actors: Actor) -> None:
        for a in actors:
            a.thread.join(self.wait)
            if a.thread.is_alive():
                raise RaceFailure(f"{a!r} did not finish within {self.wait}s; "
                                  f"achieved order: {self.order()}")
            if a.error is not None and not a.may_raise:
                raise RaceFailure(f"{a!r} raised:\n{a.error_tb}")

    # ------------------------------------------------------------ checking
    def order(self) -> list[str]:
        with self._cv:
            return [f"{n}.{p}" for n, p in self.events]

    def expect_order(self, *steps: str) -> None:
        """Each step is `Actor.point` or `Actor.point#n` (nth pass). They must
        all have happened, in exactly this relative order."""
        got = self.order()
        counts: dict[str, int] = {}
        numbered: list[str] = []
        for s in got:
            counts[s] = counts.get(s, 0) + 1
            numbered.append(f"{s}#{counts[s]}")
        last = -1
        for step in steps:
            want = step if "#" in step else step + "#1"
            try:
                at = numbered.index(want)
            except ValueError:
                raise RaceFailure(f"{step} never happened; achieved order: {got}") from None
            if at <= last:
                raise RaceFailure(f"{step} happened out of the expected order "
                                  f"{list(steps)}; achieved order: {got}")
            last = at
