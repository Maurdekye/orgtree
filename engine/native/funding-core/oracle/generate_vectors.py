"""Generate the funding-core parity vectors from the real Python ledger.

Every expected value comes from calling the current `orgtree.ledger.Org`
methods (`free`, `committed`, `_chain_acquire`, `reallocate`, `hire`,
`rehire`) on synthetic organizations built in memory under a temporary
ORGTREE_DATA. Nothing here reimplements a funding rule. The Rust crate is
checked against what these calls returned.

Besides the outcome (grants written, warnings, notices, refusal message),
each row records what the Python code actually READ while deciding: the
organization's node table, node fields, tier prices and settings are wrapped
in recording dict subclasses for the duration of the call. Effect builders
(`_notify`, `_notify_ev`, `_log`, `node_ref`) are recorded as effects, not
as reads. For `hire` and `rehire` the WHOLE call is recorded, minus an
explicit list of non-funding helpers, fields and settings (see
NON_FUNDING_CALLS below); every row is checked against an unfiltered
recording of the same call so that no other key can go missing. This is the
honest read set a later port must either reproduce or deliberately change;
it is not an idealized lock set.

Run on the engine runtime only (CPython 3.13.15):

    engine/runtime/python.exe engine/native/funding-core/oracle/generate_vectors.py --check
    engine/runtime/python.exe engine/native/funding-core/oracle/generate_vectors.py --write

It writes nothing outside the vectors file and a temporary ORGTREE_DATA.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import random
import sys
import tempfile
from pathlib import Path
from typing import Any

SCHEMA = "orgtree.funding-core-vectors/v1"
REQUIRED_PYTHON = (3, 13)
CRATE = Path(__file__).resolve().parents[1]
DEFAULT_VECTORS = CRATE / "vectors" / "funding-vectors.json"
ANCHORED = ["engine/backend/orgtree/ledger.py"]

USER = "@user"
SYSTEM = "@system"

# ---------------------------------------------------------------- recording
# `sink` is where a read goes while recording is on: LOG for the funding
# decision, ASIDE for reads made inside a named non-funding helper or an
# effect builder (kept so the accounting check can prove nothing else was
# dropped).
LOG: set[str] = set()
ASIDE: set[str] = set()
REC: dict[str, Any] = {"on": False, "sink": LOG}


def _note(s: str) -> None:
    if REC["on"]:
        REC["sink"].add(s)


class RecNode(dict):
    """One node document. Records `f:<node>:<field>` reads and writes. The
    node id lives in an attribute, never in the document itself."""

    _rid = "?"

    def __getitem__(self, k):
        _note(f"f:{self._rid}:{k}")
        return dict.__getitem__(self, k)

    def get(self, k, default=None):
        _note(f"f:{self._rid}:{k}")
        return dict.get(self, k, default)

    def __contains__(self, k):
        _note(f"f:{self._rid}:{k}")
        return dict.__contains__(self, k)

    def __setitem__(self, k, v):
        _note(f"w:{self._rid}:{k}")
        dict.__setitem__(self, k, v)


class RecNodes(dict):
    """The node table. `n:<id>` for a lookup or membership test (hit or
    miss); `scan` for any whole-table iteration."""

    def __getitem__(self, k):
        _note(f"n:{k}")
        return dict.__getitem__(self, k)

    def get(self, k, default=None):
        _note(f"n:{k}")
        return dict.get(self, k, default)

    def __contains__(self, k):
        _note(f"n:{k}")
        return dict.__contains__(self, k)

    def items(self):
        _note("scan")
        return dict.items(self)

    def keys(self):
        _note("scan")
        return dict.keys(self)

    def values(self):
        _note("scan")
        return dict.values(self)

    def __iter__(self):
        _note("scan")
        return dict.__iter__(self)

    def __len__(self):
        _note("scan")
        return dict.__len__(self)

    def __setitem__(self, k, v):
        _note(f"w:nodes:{k}")
        dict.__setitem__(self, k, v)


class RecTiers(dict):
    def __getitem__(self, k):
        _note(f"t:{k}")
        return dict.__getitem__(self, k)

    def get(self, k, default=None):
        _note(f"t:{k}")
        return dict.get(self, k, default)

    def __contains__(self, k):
        _note(f"t:{k}")
        return dict.__contains__(self, k)


QUIET_DOC_KEYS = ("nodes", "tiers")


class RecDoc(dict):
    def __getitem__(self, k):
        if k not in QUIET_DOC_KEYS:
            _note(f"d:{k}")
        return dict.__getitem__(self, k)

    def get(self, k, default=None):
        if k not in QUIET_DOC_KEYS:
            _note(f"d:{k}")
        return dict.get(self, k, default)

    def __contains__(self, k):
        if k not in QUIET_DOC_KEYS:
            _note(f"d:{k}")
        return dict.__contains__(self, k)

    def setdefault(self, k, default=None):
        if k not in QUIET_DOC_KEYS:
            _note(f"d:{k}")
        return dict.setdefault(self, k, default)


class Recorder:
    """Switch recording on for one call; restores the previous state."""

    def __enter__(self):
        self.prev = (REC["on"], REC["sink"])
        REC["on"], REC["sink"] = True, LOG
        LOG.clear()
        ASIDE.clear()
        return self

    def __exit__(self, *exc):
        REC["on"], REC["sink"] = self.prev
        return False


def aside(fn):
    """Run `fn` with its reads sent to ASIDE instead of LOG."""
    def wrapper(*a, **k):
        prev = REC["sink"]
        REC["sink"] = ASIDE
        try:
            return fn(*a, **k)
        finally:
            REC["sink"] = prev
    return wrapper


def muted(fn, sink):
    """An effect builder: observed through `sink`, its reads set aside."""
    def wrapper(*a, **k):
        prev = REC["sink"]
        REC["sink"] = ASIDE
        try:
            sink(a, k)
            return fn(*a, **k)
        finally:
            REC["sink"] = prev
    return wrapper


# ---------------------------------------------------------------- encoding
def num(v: Any) -> Any:
    """A grant/price/amount exactly as the document holds it. JSON keeps the
    int/float distinction: Python writes every float with '.', 'e', 'inf' or
    'nan', and never an int that way."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise RuntimeError(f"non-numeric amount in the parity domain: {v!r}")
    return v


# Refusal messages the funding step may raise. Anything else stops the oracle
# rather than being written down as expected behavior nobody reviewed.
KNOWN_PREFIXES = (
    "no such node: ",
    "unknown actor: ",
    "not enough free credits on the chain: ",
    "grant must be a non-negative integer",
    "only the user hires at top level",
)
KNOWN_INFIXES = (
    " has no authority over ",
    ", not live",
    " free of the ",
    " is not on ",
    " would put a top-level grant at ",
    " unused; the rest is committed",
    " may hire only within its own subtree",
    " is a LOST generation",
    " is UNRECOVERABLE — rehiring ",
)


def check_known(msg: str) -> None:
    if msg.startswith(KNOWN_PREFIXES) or any(s in msg for s in KNOWN_INFIXES):
        return
    raise SystemExit(f"oracle stopped: unknown LedgerError pattern: {msg!r}")


# ---------------------------------------------------------------- synthetic org
class Builder:
    def __init__(self, ledger):
        self.ledger = ledger
        base = ledger.Org.create("oracle-funding")
        base.hire(USER, None, "haiku", 0, "tmpl")
        self.tmpl = copy.deepcopy(dict(base.node("tmpl")))
        base.d["nodes"] = {}
        self.base_doc = base.d

    def org(self, spec: dict) -> Any:
        """Build an Org whose funding-relevant facts are exactly `spec`,
        AFTER construction so no init migration rewrites them."""
        doc = copy.deepcopy(self.base_doc)
        doc["nodes"] = {}
        org = self.ledger.Org(doc)
        tiers = RecTiers()
        for k, v in spec["tiers"]:
            dict.__setitem__(tiers, k, v)
        nodes = RecNodes()
        for nid, f in spec["nodes"]:
            n = copy.deepcopy(self.tmpl)
            for key in ("parent", "state", "model", "grant", "created"):
                n[key] = f[key]
            n.pop("ui_order", None)
            if "ui_order" in f:
                n["ui_order"] = f["ui_order"]
            n["bearer_state"] = f.get("bearer_state")
            n["successor"] = None
            n["title"] = nid
            n["lineage"] = nid
            rn = RecNode(n)
            rn._rid = nid
            dict.__setitem__(nodes, nid, rn)
        d = RecDoc(org.d)
        dict.__setitem__(d, "nodes", nodes)
        dict.__setitem__(d, "tiers", tiers)
        for key in ("max_top_grant", "cascade_hire", "cascade_alloc"):
            dict.pop(d, key, None)
        for key, v in spec["settings"]:
            dict.__setitem__(d, key, v)
        dict.__setitem__(d, "whole_grants_v1", True)
        org.d = d
        return org


def grant_map(org) -> dict[str, str]:
    return {k: json.dumps(dict.__getitem__(v, "grant")) for k, v in dict.items(org.d["nodes"])}


def changed(before: dict[str, str], org) -> list[list[Any]]:
    out = []
    for k, v in dict.items(org.d["nodes"]):
        if k not in before:
            continue
        g = dict.__getitem__(v, "grant")
        if before[k] != json.dumps(g):
            out.append([k, num(g)])
    return out


class Effects:
    """Effect calls observed during an operation. They run with recording
    muted: building a notice or an event is not part of the decision."""

    def __init__(self, org):
        self.notices: list[list[Any]] = []
        self.events: list[list[Any]] = []
        self.logs: list[list[Any]] = []
        self.strand: list[list[Any]] = []
        self.acquire_warnings: list[str] = []
        self.acquire_calls: list[list[Any]] = []
        org._notify = muted(org._notify, lambda a, k: self.notices.append([list(a[0]), a[1]]))

        def ev(a, k):
            e = a[1]
            p = {x: e.get(x) for x in ("node", "relation", "delta", "now", "free", "by")}
            self.events.append([list(a[0]), e.get("variant"), p])
        org._notify_ev = muted(org._notify_ev, ev)
        org._log = muted(org._log, lambda a, k: self.logs.append([a[0], list(a[3])]))
        org.node_ref = muted(org.node_ref, lambda a, k: None)
        orig_strand = org._stranding_warnings

        def strand(payer, before, after, *, actor=None):
            r = orig_strand(payer, before, after, actor=actor)
            self.strand.append([payer, num(before), num(after), list(r)])
            return r
        org._stranding_warnings = strand


def run(call) -> dict:
    try:
        return {"ok": call()}
    except Exception as e:  # noqa: BLE001
        name = type(e).__name__
        if name == "LedgerError":
            check_known(str(e))
        return {"raises": name, "message": str(e)}


def split_rw(log: set[str]) -> tuple[list[str], list[str]]:
    s = sorted(log)
    return [x for x in s if not x.startswith("w:")], [x for x in s if x.startswith("w:")]


def finish(out: dict, org, before, eff: Effects) -> dict:
    out["grants_changed"] = changed(before, org)
    out["notices"] = eff.notices
    out["strand"] = eff.strand
    return out


def acquire_row(b: Builder, spec, actor, payer, need, cascade) -> dict:
    org = b.org(spec)
    eff = Effects(org)
    before = grant_map(org)
    warnings: list[str] = []
    with Recorder():
        res = run(lambda: org._chain_acquire(actor, payer, need, warnings, cascade=cascade))
        reads, writes = split_rw(LOG)
    out = {"op": "acquire", "spec": spec, "actor": actor, "payer": payer,
           "need": num(need), "cascade": cascade}
    res.pop("ok", None)
    out.update(res)
    out.update({"warnings": warnings, "reads": reads, "writes": writes})
    return finish(out, org, before, eff)


def value_row(b: Builder, spec, fn: str, nid: str) -> dict:
    org = b.org(spec)
    with Recorder():
        res = run(lambda: getattr(org, fn)(nid))
        reads, _ = split_rw(LOG)
    out = {"op": fn, "spec": spec, "node": nid}
    if "ok" in res:
        out["value"] = num(res.pop("ok"))
    out.update(res)
    out["reads"] = reads
    return out


def reallocate_row(b: Builder, spec, actor, nid, delta) -> dict:
    org = b.org(spec)
    eff = Effects(org)
    before = grant_map(org)
    with Recorder():
        res = run(lambda: org.reallocate(actor, nid, delta))
        reads, writes = split_rw(LOG)
    out = {"op": "reallocate", "spec": spec, "actor": actor, "node": nid, "delta": num(delta)}
    if "ok" in res:
        out["grant"] = num(res["ok"]["grant"])
        out["warnings"] = list(res["ok"]["warnings"])
    else:
        out.update(res)
    out.update({"reads": reads, "writes": writes, "events": eff.events, "logs": eff.logs})
    return finish(out, org, before, eff)


# hire and rehire are recorded for the WHOLE call. Only what is listed here is
# left out of their read/write sets, and every one of these is named in the
# README ("Hire and rehire read sets"):
# - reads made inside these helpers, which decide scopes, tools, dirs,
#   visibility, the kiosk tier ceiling, the depth and width caps, the Fable
#   lock, peers, pending mail and the new node's identity (set aside, not
#   dropped: see `unaccounted`);
NON_FUNDING_CALLS = ("_check_tier_ceiling", "depth", "org_children", "effective_dirs",
                     "_clamp_dirs", "_clamp_tools", "_clamp_vis", "_apply_ceiling",
                     "clear_fable_lock", "_new_node", "_peers_of", "waking_mail")
# - these node fields, read or written in the method bodies for the same
#   purposes (`scope` holds dirs/tools/visibility; `archived_at` is a
#   timestamp cleared on rehire);
NON_FUNDING_FIELDS = frozenset({"scope", "archived_at"})
# - these org settings, read in the method bodies for the same purposes;
NON_FUNDING_SETTINGS = frozenset({"dirs", "default_tools", "default_visibility", "max_depth",
                                  "max_children", "fable_lock", "watchdogs", "default_account",
                                  "slug"})
# - every key of the node a hire creates (its id is not a funding input; its
#   grant is reported as `new_grant`).


def excluded(key: str, new_ids: set[str]) -> bool:
    kind, _, rest = key.partition(":")
    if kind == "d":
        return rest in NON_FUNDING_SETTINGS
    if kind == "n":
        return rest in new_ids
    if kind == "w" and rest.startswith("nodes:"):
        return rest[len("nodes:"):] in new_ids
    if kind in ("f", "w"):
        nid, _, field = rest.rpartition(":")
        return nid in new_ids or field in NON_FUNDING_FIELDS
    return False


def funding_step(org, eff: Effects) -> None:
    """Observe the chain acquisitions and set aside the named non-funding
    helpers for a whole-call hire/rehire recording."""
    acq = org._chain_acquire

    def acquire(actor, payer, need, warnings, cascade=True):
        n0 = len(warnings)
        eff.acquire_calls.append([actor, payer, num(need), bool(cascade)])
        try:
            return acq(actor, payer, need, warnings, cascade=cascade)
        finally:
            eff.acquire_warnings.extend(warnings[n0:])
    org._chain_acquire = acquire
    for name in NON_FUNDING_CALLS:
        setattr(org, name, aside(getattr(org, name)))


def recorded_step(b: Builder, spec, call) -> tuple[Any, dict, set[str], Effects, dict, dict]:
    """Run `call(org)` as a hire/rehire row: whole-call recording with the
    listed exclusions. Returns the org, the result, the reported keys, the
    effects and the grant/state maps from before the call, and checks the
    accounting against an unfiltered recording of the same call."""
    org = b.org(spec)
    eff = Effects(org)
    funding_step(org, eff)
    before, states = grant_map(org), state_map(org)
    ids = set(dict.keys(org.d["nodes"]))
    with Recorder():
        res = run(lambda: call(org))
        log, side = set(LOG), set(ASIDE)
    new_ids = set(dict.keys(org.d["nodes"])) - ids
    reported = {k for k in log if not excluded(k, new_ids)}
    raw = b.org(spec)
    with Recorder():
        run(lambda: call(raw))
        everything = set(LOG)
    missing = unaccounted(everything, reported, side, new_ids)
    if missing or not reported <= everything:
        raise SystemExit(f"oracle stopped: unaccounted funding keys {sorted(missing)} "
                         f"or phantom keys {sorted(reported - everything)}")
    return org, res, reported, eff, before, states


def unaccounted(everything: set[str], reported: set[str], side: set[str], new_ids: set[str]) -> set[str]:
    """Keys Python touched that are neither reported nor covered by a listed
    exclusion. Must be empty: a funding key is never dropped silently."""
    return {k for k in everything if k not in reported and k not in side and not excluded(k, new_ids)}


AGENT_SCOPE = dict(add_dirs=[], tools={"bash": False, "web": False, "edit": False,
                                       "subagents": False, "mcp": []},
                   org_visibility="self", charter="synthetic funding probe")


def hire_row(b: Builder, spec, actor, parent, tier, grant) -> dict:
    kw = {} if actor == USER else dict(AGENT_SCOPE)
    org, res, keys, eff, before, _ = recorded_step(
        b, spec, lambda o: o.hire(actor, parent, tier, grant, "newhire", **copy.deepcopy(kw)))
    reads, writes = split_rw(keys)
    out = {"op": "hire", "spec": spec, "actor": actor, "parent": parent, "tier": tier,
           "grant": num(grant)}
    if "ok" in res:
        new = [k for k in dict.keys(org.d["nodes"]) if k not in before]
        if len(new) != 1:
            raise SystemExit(f"oracle stopped: hire created {new}")
        out["new_grant"] = num(dict.__getitem__(org.d["nodes"][new[0]], "grant"))
    else:
        out.update(res)
    out.update({"acquire_calls": eff.acquire_calls, "warnings": eff.acquire_warnings,
                "reads": reads, "writes": writes})
    return finish(out, org, before, eff)


def state_map(org) -> dict[str, str]:
    return {k: dict.__getitem__(v, "state") for k, v in dict.items(org.d["nodes"])}


def rehire_row(b: Builder, spec, actor, nid, grant) -> dict:
    org, res, keys, eff, before, states = recorded_step(b, spec, lambda o: o.rehire(actor, nid, grant))
    reads, writes = split_rw(keys)
    out = {"op": "rehire", "spec": spec, "actor": actor, "node": nid,
           "grant": None if grant is None else num(grant)}
    if "ok" in res:
        r = res["ok"]
        if r.get("cost") == 0 and any("already live" in w for w in r.get("warnings", [])):
            out["noop"] = list(r["warnings"])
    else:
        out.update(res)
    out.update({"acquire_calls": eff.acquire_calls, "warnings": eff.acquire_warnings,
                "reads": reads, "writes": writes})
    # a rehire also makes archived superiors live first; a refusal part-way
    # leaves those in memory, so the state change is recorded too
    out["states_changed"] = [[k, s] for k, s in state_map(org).items() if states.get(k) != s]
    return finish(out, org, before, eff)


# ---------------------------------------------------------------- specs
def node(parent, state="live", model="haiku", grant: Any = 0,
         created="2026-01-01T00:00:00.000Z", ui_order: Any = "absent", bearer_state=None) -> dict:
    f = {"parent": parent, "state": state, "model": model, "grant": grant, "created": created}
    if ui_order != "absent":
        f["ui_order"] = ui_order
    if bearer_state is not None:
        f["bearer_state"] = bearer_state
    return f


BASE_TIERS = [["haiku", 1], ["sonnet", 2], ["opus", 4], ["luna", 0.1], ["gpt-reserve", 0.2],
              ["flash", 1], ["pro", 2], ["astra", 10], ["sol", 2], ["terra", 2]]


def spec(nodes, settings=None, tiers=None) -> dict:
    return {"nodes": [[k, v] for k, v in nodes],
            "tiers": copy.deepcopy(tiers or BASE_TIERS),
            "settings": [[k, v] for k, v in (settings or [])]}


def chain3(top: Any = 10, mid: Any = 5, leaf: Any = 2, settings=None, tiers=None) -> dict:
    return spec([("top", node(None, grant=top)),
                 ("mid", node("top", grant=mid, created="2026-01-01T00:00:01.000Z")),
                 ("leaf", node("mid", grant=leaf, created="2026-01-01T00:00:02.000Z"))],
                settings, tiers)


def handcrafted(b: Builder) -> dict[str, list[dict]]:
    acq: list[dict] = []
    val: list[dict] = []
    rea: list[dict] = []
    hir: list[dict] = []
    reh: list[dict] = []

    # committed/free: sort ties, unrecoverable seats, archived excluded, USER
    s = spec([("p", node(None, grant=20)),
              ("a", node("p", model="luna", grant=0.1, ui_order=1)),
              ("b", node("p", model="gpt-reserve", grant=0.2, ui_order=1.0)),
              ("c", node("p", state="unrecoverable", model="sonnet", grant=1)),
              ("d", node("p", state="archived", model="opus", grant=3)),
              ("e", node("p", model="luna", grant=0.7, ui_order=0, created="2025-12-31T00:00:00.000Z"))])
    for fn in ("committed", "free"):
        for nid in ("p", "a", "d", "zz"):
            val.append(value_row(b, s, fn, nid))
    val.append(value_row(b, s, "free", USER))
    # ten 0.1 seats: plain summation and CPython 3.13's compensated sum part
    ten = spec([("p", node(None, grant=1))] +
               [(f"k{i}", node("p", model="luna", grant=0.0, ui_order=float(i))) for i in range(10)])
    val.append(value_row(b, ten, "committed", "p"))
    val.append(value_row(b, ten, "free", "p"))
    mixed = spec([("p", node(None, grant=5))] +
                 [(f"k{i}", node("p", model=m, grant=g, ui_order=float(i)))
                  for i, (m, g) in enumerate([("opus", 1), ("luna", 0.1), ("opus", 2), ("luna", 0.2), ("haiku", 0.7)])],
                 tiers=[["opus", 4], ["luna", 0.1], ["haiku", 0.3]])
    val.append(value_row(b, mixed, "committed", "p"))
    order = spec([("p", node(None, grant=5))] +
                 [(f"k{i}", node("p", model="luna", grant=g, ui_order=u, created=c))
                  for i, (g, u, c) in enumerate([(1e16, 2, "b"), (0.1, 1, "b"), (-1e16, 1, "a"), (0.3, 1.0, "a")])],
                 tiers=[["luna", 0.1]])
    val.append(value_row(b, order, "committed", "p"))

    # cascade on / off; exact and 0.01 short
    for cascade in (True, False):
        for need in (8, 8.01, 7.99, 0, -1, 0.5):
            acq.append(acquire_row(b, chain3(top=20, mid=10, leaf=0), USER, "mid", need, cascade))
    t = chain3(top=20, mid=10, leaf=1)
    for need in (10.0, 17, 25.99, 26, 26.01, 27):
        acq.append(acquire_row(b, t, "top", "mid", need, True))
    # actor off chain, system actor, stranger, actor == payer
    acq.append(acquire_row(b, t, "leaf", "mid", 1, True))
    acq.append(acquire_row(b, t, SYSTEM, "mid", 1, True))
    acq.append(acquire_row(b, t, "stranger", "mid", 100, True))
    acq.append(acquire_row(b, t, "mid", "mid", 3, True))
    acq.append(acquire_row(b, t, "mid", "mid", 30, True))
    # the measured 104 under 100 -> 104.2 case (sub-$1 seat, USER carry)
    t104 = spec([("boss", node(None, grant=100))])
    acq.append(acquire_row(b, t104, USER, "boss", 104.2, True))
    acq.append(acquire_row(b, t104, "boss", "boss", 104.2, True))
    deep = spec([("r", node(None, grant=3)), ("s", node("r", grant=1.5)),
                 ("u", node("s", model="luna", grant=0.3)), ("v", node("u", model="luna", grant=0))],
                tiers=[["haiku", 1], ["luna", 0.1]])
    for need in (0.35, 1.1, 2.45, 6.05, 0.01):
        acq.append(acquire_row(b, deep, USER, "v", need, True))
        acq.append(acquire_row(b, deep, "r", "v", need, True))
    # cap boundaries (D-014) and grandfathering
    for cap in (0, None, 30, 30.9, 29, True, False, "absent"):
        st = [] if cap == "absent" else [["max_top_grant", cap]]
        for need in (10, 10.01, 9.99):
            acq.append(acquire_row(b, chain3(top=20, mid=10, leaf=0, settings=st), USER, "mid", need + 10, True))
    over = chain3(top=50, mid=10, leaf=0, settings=[["max_top_grant", 40]])
    acq.append(acquire_row(b, over, USER, "mid", 5, True))
    acq.append(acquire_row(b, over, USER, "mid", 10.5, True))
    # stranding thresholds: archived children of a contributor
    st = spec([("top", node(None, grant=30)),
               ("mid", node("top", grant=12)),
               ("ar1", node("mid", state="archived", model="opus", grant=1)),
               ("ar2", node("mid", state="archived", model="haiku", grant=4, bearer_state="resident")),
               ("ar3", node("mid", state="archived", model="haiku", grant=6.5)),
               ("liv", node("mid", model="haiku", grant=2))])
    for need in (4, 5, 6, 6.01, 7, 7.5, 9, 12):
        acq.append(acquire_row(b, st, USER, "mid", need, True))
        acq.append(acquire_row(b, st, "top", "mid", need, True))
        acq.append(acquire_row(b, st, "mid", "mid", need, True))
    # dangling parent and missing payer
    dang = spec([("orph", node("ghost", grant=1))])
    acq.append(acquire_row(b, dang, USER, "orph", 5, True))
    acq.append(acquire_row(b, dang, USER, "nobody", 5, True))

    # reallocate: snap-up, negative deltas, authority, liveness, cap, cascade_alloc
    fr = spec([("top", node(None, grant=104.2)), ("mid", node("top", grant=3.4)),
               ("kid", node("mid", model="luna", grant=0))], tiers=[["haiku", 1], ["luna", 0.1]])
    for actor, nid, delta in [(USER, "top", 0.8), (USER, "top", 0.79), (USER, "top", -0.2),
                              (USER, "mid", 0.6), (USER, "mid", 0.2), (USER, "mid", -0.4), (USER, "mid", -2.3),
                              (USER, "mid", -2.4), (USER, "mid", -3), ("top", "mid", 1), ("top", "mid", 200),
                              ("mid", "mid", 1), ("kid", "mid", 1), ("top", "kid", 0.5), (SYSTEM, "mid", 1),
                              (SYSTEM, "mid", -1), ("ghost", "mid", 1), (USER, "ghost", 1), (USER, "mid", 0),
                              (USER, "top", 10**6)]:
        rea.append(reallocate_row(b, fr, actor, nid, delta))
    capd = spec([("top", node(None, grant=95)), ("mid", node("top", grant=0))], settings=[["max_top_grant", 100]])
    for delta in (5, 5.01, 6, -1):
        rea.append(reallocate_row(b, capd, USER, "top", delta))
        rea.append(reallocate_row(b, capd, USER, "mid", delta + 95))
    for cv in (False, True, "absent", 0, "", "no", None):
        stt = [] if cv == "absent" else [["cascade_alloc", cv]]
        rea.append(reallocate_row(b, chain3(top=20, mid=1, leaf=0, settings=stt), "top", "mid", 5))
    strd = spec([("top", node(None, grant=30)), ("mid", node("top", grant=12)),
                 ("ar1", node("mid", state="archived", model="opus", grant=1)),
                 ("ar2", node("mid", state="archived", model="haiku", grant=4, bearer_state="resident"))])
    for delta in (-2, -7, -7.5, -8, -12, -12.5):
        rea.append(reallocate_row(b, strd, "top", "mid", delta))
        rea.append(reallocate_row(b, strd, "mid", "mid", delta))
        rea.append(reallocate_row(b, strd, USER, "mid", delta))
    notlive = spec([("top", node(None, grant=5)), ("arch", node("top", state="archived", grant=1)),
                    ("unr", node("top", state="unrecoverable", grant=1))])
    rea.append(reallocate_row(b, notlive, USER, "arch", 1))
    rea.append(reallocate_row(b, notlive, USER, "unr", 1))

    # hire funding step
    h = chain3(top=20, mid=5, leaf=0, tiers=[["haiku", 0.3], ["opus", 4], ["luna", 0.1]])
    for actor, parent, tier, grant in [(USER, None, "haiku", 3), (USER, "mid", "haiku", 3), (USER, "mid", "opus", 30),
                                       ("top", "mid", "haiku", 10), ("top", "mid", "opus", 30), ("mid", "mid", "haiku", 4),
                                       ("mid", "mid", "haiku", 5), ("leaf", "mid", "haiku", 1), ("mid", None, "haiku", 1),
                                       (USER, "mid", "haiku", 2.5), (USER, "mid", "haiku", -1), (USER, "mid", "luna", 3.0),
                                       (USER, None, "haiku", 2000)]:
        hir.append(hire_row(b, h, actor, parent, tier, grant))
    for cv in (False, True):
        hir.append(hire_row(b, chain3(top=20, mid=1, leaf=0, settings=[["cascade_hire", cv]]), "top", "mid", "haiku", 3))
    hir.append(hire_row(b, spec([("top", node(None, grant=5)), ("arch", node("top", state="archived", grant=1))]),
                        USER, "arch", "haiku", 1))
    hir.append(hire_row(b, spec([("boss", node(None, grant=100))]), USER, "boss", "gpt-reserve", 104))

    # rehire funding step
    rh = spec([("top", node(None, grant=20)), ("mid", node("top", grant=6)),
               ("old", node("mid", state="archived", model="haiku", grant=2.5)),
               ("tarch", node(None, state="archived", model="haiku", grant=7)),
               ("lost", node("mid", state="archived", grant=1, bearer_state="lost"))],
              settings=[["max_top_grant", 10]])
    for actor, nid, grant in [(USER, "old", None), (USER, "old", 3.2), (USER, "old", 40), ("top", "old", None),
                              ("mid", "old", 3), ("mid", "old", 5), ("mid", "old", 4.99), (USER, "tarch", None),
                              (USER, "tarch", 12), (USER, "tarch", 9.5), (USER, "mid", None), (USER, "lost", None),
                              ("old", "old", None)]:
        reh.append(rehire_row(b, rh, actor, nid, grant))

    # children() order is observable: several dependents stranded at once
    # are named in sorted (ui_order, created) order, not document order
    def sorted_kids(liv_grant):
        return spec([("top", node(None, grant=40)), ("mid", node("top", grant=20)),
                     ("z9", node("mid", state="archived", model="haiku", grant=5, ui_order=3)),
                     ("a1", node("mid", state="archived", model="haiku", grant=5, ui_order=1,
                                 created="2026-01-02T00:00:00.000Z")),
                     ("m5", node("mid", state="archived", model="haiku", grant=5, ui_order=1.0,
                                 created="2026-01-01T00:00:00.000Z")),
                     ("b2", node("mid", state="archived", model="luna", grant=8.9, bearer_state="resident",
                                 ui_order=2)),
                     ("liv", node("mid", model="haiku", grant=liv_grant, ui_order=0))])
    so = sorted_kids(2)
    for need in (8, 8.01, 11.5, 17, 20):
        acq.append(acquire_row(b, so, USER, "mid", need, True))
        acq.append(acquire_row(b, so, "top", "mid", need, True))
    for actor, delta in ((USER, -11.5), ("top", -12), ("mid", -17)):
        rea.append(reallocate_row(b, so, actor, "mid", delta))
    # a cost exactly equal to the free before: still affordable before
    edge = sorted_kids(10)
    for need in (0.01, 1, 3, 3.01):
        acq.append(acquire_row(b, edge, USER, "mid", need, True))
        acq.append(acquire_row(b, edge, "mid", "mid", need, True))
    for actor, delta in ((USER, -1), ("top", -3), ("top", -3.5)):
        rea.append(reallocate_row(b, edge, actor, "mid", delta))
    hir.append(hire_row(b, edge, USER, "mid", "haiku", 1))

    # D-014 equality: a top-level grant landing exactly on the cap is allowed
    alone = spec([("top", node(None, grant=25))], settings=[["max_top_grant", 30]])
    for need in (29.5, 30, 30.01, 31):
        acq.append(acquire_row(b, alone, USER, "top", need, True))
    for delta in (5, 4.5, 5.01):
        rea.append(reallocate_row(b, alone, USER, "top", delta))
    for g in (30, 31):
        hir.append(hire_row(b, alone, USER, None, "haiku", g))
    tarc = spec([("t", node(None, state="archived", grant=7))], settings=[["max_top_grant", 30]])
    for g in (None, 30, 29.01, 30.01):
        reh.append(rehire_row(b, tarc, USER, "t", g))

    # a fractional cap is int()-truncated: 40.5 and 40.9 both cap at 40,
    # so a top-level grant of 41 is refused on every path
    for cap in (40.5, 40.9):
        st = [["max_top_grant", cap]]
        for g in (40, 41):
            hir.append(hire_row(b, spec([], settings=st), USER, None, "haiku", g))
        capk = spec([("top", node(None, grant=40)), ("kid", node("top", grant=39))], settings=st)
        rea.append(reallocate_row(b, capk, USER, "top", 1))
        acq.append(acquire_row(b, capk, USER, "top", 1, True))
        acq.append(acquire_row(b, capk, USER, "kid", 1, True))
        tarc40 = spec([("t", node(None, state="archived", grant=7))], settings=st)
        for g in (40, 41):
            reh.append(rehire_row(b, tarc40, USER, "t", g))

    # the need is _q(price + grant): 0.57 + 1 is 1.5699999999999998 in
    # floating point and becomes 1.57
    grid = [["haiku", 1], ["cheap", 0.57]]
    g57 = chain3(top=20, mid=5, leaf=0, tiers=grid)
    for actor in (USER, "top", "mid"):
        hir.append(hire_row(b, g57, actor, "mid", "cheap", 1))
    g57r = spec([("top", node(None, grant=20)), ("mid", node("top", grant=0)),
                 ("old", node("mid", state="archived", model="cheap", grant=0))], tiers=grid)
    for g in (1, None):
        reh.append(rehire_row(b, g57r, "top", "old", g))

    # min(free, remaining) keeps its FIRST argument on a tie: free 8.0
    # against an int need of 8 inflates mid's grant to the float 8.0
    tie = spec([("top", node(None, grant=10.5)), ("k", node("top", grant=0.5, ui_order=0)),
                ("mid", node("top", grant=0, ui_order=1))], tiers=[["haiku", 1]])
    hir.append(hire_row(b, tie, "top", "mid", "haiku", 7))
    acq.append(acquire_row(b, tie, "top", "mid", 8, True))
    acq.append(acquire_row(b, tie, "top", "mid", 8.0, True))

    # rehire through archived superiors: each is rehired first, top-most
    # first, with its own chain acquisition; unrecoverable and lost ones stop it
    def arch_chain(top_grant, c_grant):
        return spec([("top", node(None, grant=top_grant)),
                     ("a", node("top", state="archived", model="haiku", grant=4)),
                     ("b", node("a", state="archived", model="luna", grant=2.5)),
                     ("c", node("b", state="archived", model="haiku", grant=c_grant)),
                     ("u", node("top", state="unrecoverable", grant=1)),
                     ("ub", node("u", state="archived", grant=2)),
                     ("la", node("top", state="archived", grant=1, bearer_state="lost")),
                     ("lb", node("la", state="archived", grant=1))],
                    tiers=[["haiku", 1], ["luna", 0.1]])
    ac = arch_chain(30, 1)
    for actor, nid, grant in [(USER, "c", None), (USER, "c", 6), ("top", "c", None), ("top", "b", 3.2),
                              (USER, "ub", None), (USER, "lb", None), ("a", "c", None), ("top", "a", 1)]:
        reh.append(rehire_row(b, ac, actor, nid, grant))
    tight = arch_chain(12, 10)
    for actor, grant in (("top", None), (USER, None), ("top", 0)):
        reh.append(rehire_row(b, tight, actor, "c", grant))
    # top-most first is observable: an archived superior acting on the chain
    # is refused over the TOP-MOST archived node, not over itself
    reh.append(rehire_row(b, ac, "b", "c", None))
    deep4 = spec([("top", node(None, grant=40)),
                  ("a", node("top", state="archived", model="haiku", grant=3)),
                  ("b", node("a", state="archived", model="luna", grant=2)),
                  ("c", node("b", state="archived", model="haiku", grant=1)),
                  ("d", node("c", state="archived", model="haiku", grant=2))],
                 tiers=[["haiku", 1], ["luna", 0.1]])
    for actor in ("c", "b", "top", USER):
        reh.append(rehire_row(b, deep4, actor, "d", None))
    # a refused rehire keeps grants an earlier superior rehire inflated: an
    # agent actor short on the target's acquisition, and a USER cascade
    # whose second inflation crosses max_top_grant
    part = spec([("top", node(None, grant=20)), ("m", node("top", grant=2)),
                 ("a", node("m", state="archived", model="haiku", grant=4)),
                 ("c", node("a", state="archived", model="haiku", grant=30))],
                tiers=[["haiku", 1]])
    for actor, grant in (("top", None), ("top", 17), ("top", 18)):
        reh.append(rehire_row(b, part, actor, "c", grant))
    capped = spec([("top", node(None, grant=2)),
                   ("a", node("top", state="archived", model="haiku", grant=3)),
                   ("c", node("a", state="archived", model="haiku", grant=10))],
                  settings=[["max_top_grant", 10]], tiers=[["haiku", 1]])
    for grant in (None, 8, 9):
        reh.append(rehire_row(b, capped, USER, "c", grant))

    # summation-sensitive committed(): a seat whose total is an int beyond a
    # 32-bit C long leaves sum()'s fast path, so later floats are added
    # without compensation — visible after _q at this magnitude
    bigtiers = [["haiku", 1], ["luna", 0.1], ["gpt-reserve", 0.2]]
    for big, rest in [(35184372088832, [("gpt-reserve", 0.01), ("luna", 2.675), ("luna", 1.3), ("luna", 2.675),
                                        ("luna", 0.7)]),
                      (26388279066624, [("gpt-reserve", 0.2), ("luna", 0.05), ("gpt-reserve", 0.2),
                                        ("gpt-reserve", 0.2)]),
                      (35184372088832, [("luna", 0.01), ("gpt-reserve", 0.1), ("gpt-reserve", 0.3),
                                        ("luna", 2.675)]),
                      (2147483647, [("luna", 0.1), ("luna", 0.2), ("luna", 0.3)]),
                      (2147483646, [("luna", 0.1), ("luna", 0.2), ("luna", 0.3)])]:
        kids = [("k0", node("p", model="haiku", grant=big, ui_order=0))]
        kids += [(f"k{i + 1}", node("p", model=m, grant=g, ui_order=i + 1)) for i, (m, g) in enumerate(rest)]
        sp = spec([("p", node(None, grant=2 ** 46))] + kids, tiers=bigtiers)
        val.append(value_row(b, sp, "committed", "p"))
        val.append(value_row(b, sp, "free", "p"))
    # a compensated fractional run, then a seat total outside a 32-bit C
    # long: sum() adds the pending compensation before leaving the float
    # path, so the 0.1 lost against 1e16 comes back
    for wide in (2 ** 31, -2 ** 31 - 2, 2 ** 40):
        kids = [("k0", node("p", model="luna", grant=1e16, ui_order=0)),
                ("k1", node("p", model="luna", grant=0, ui_order=1)),
                ("k2", node("p", model="luna", grant=-1e16, ui_order=2)),
                ("k3", node("p", model="haiku", grant=wide, ui_order=3))]
        sp = spec([("p", node(None, grant=2 ** 46))] + kids, tiers=bigtiers)
        val.append(value_row(b, sp, "committed", "p"))
        val.append(value_row(b, sp, "free", "p"))
    return {"acquire": acq, "value": val, "reallocate": rea, "hire": hir, "rehire": reh}


def random_spec(rng: random.Random) -> dict:
    n = rng.randint(3, 12)
    ids = [f"n{i}" for i in range(n)]
    tiers = [["haiku", rng.choice([1, 0.3, 0.33, 1.7])], ["sonnet", rng.choice([2, 1.25, 2.35])],
             ["opus", rng.choice([4, 3.99, 4.1])], ["luna", rng.choice([0.1, 0.07, 0.15])],
             ["gpt-reserve", rng.choice([0.2, 0.21, 0.3])]]
    tnames = [t[0] for t in tiers]
    parents: dict[str, Any] = {}
    for i, k in enumerate(ids):
        parents[k] = None if i == 0 or rng.random() < 0.12 else ids[rng.randrange(i)]
    created = [f"2026-01-01T00:00:0{rng.randint(0, 3)}.000Z" for _ in ids]
    order = ids[:]
    rng.shuffle(order)
    nodes = []
    for k in order:
        i = ids.index(k)
        state = "live" if parents[k] is None else rng.choices(["live", "archived", "unrecoverable"], [70, 22, 8])[0]
        r = rng.random()
        if r < 0.3:
            grant: Any = rng.randint(0, 30)
        elif r < 0.85:
            grant = rng.randint(0, 3000) / 100
        else:
            grant = rng.choice([0.1 + 0.2, 1 / 3, 2.675, 0.125, 7.005, 1e-3])
        u = rng.random()
        if u < 0.5:
            ui: Any = float(i)
        elif u < 0.75:
            ui = rng.randint(0, 3)
        elif u < 0.9:
            ui = rng.choice([0.5, 1.0, 2.0])
        else:
            ui = "absent"
        bs = rng.choice([None, None, None, "resident", ""]) if state == "archived" else None
        nodes.append((k, node(parents[k], state=state, model=rng.choice(tnames), grant=grant,
                              created=created[i], ui_order=ui, bearer_state=bs)))
    settings = []
    for key in ("cascade_hire", "cascade_alloc"):
        c = rng.random()
        if c < 0.2:
            settings.append([key, False])
        elif c < 0.4:
            settings.append([key, True])
    c = rng.random()
    if c < 0.25:
        settings.append(["max_top_grant", rng.choice([0, 50, 100, 1000, 40.5])])
    elif c < 0.35:
        settings.append(["max_top_grant", None])
    return spec(nodes, settings, tiers)


def ancestors_of(sp: dict, k: Any) -> list[str]:
    par = {x: v["parent"] for x, v in sp["nodes"]}
    out, cur, seen = [], par.get(k), {k}
    while cur is not None and cur not in seen and cur in par:
        out.append(cur)
        seen.add(cur)
        cur = par.get(cur)
    return out


def random_rows(b: Builder, rng: random.Random, count: int) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"acquire": [], "value": [], "reallocate": [], "hire": [], "rehire": []}
    needs = [0, 1, 2.5, 0.01, 0.35, 5, 7.77, 13, 21.05, 40, 0.1 + 0.2, -1]
    for _ in range(count):
        sp = random_spec(rng)
        ids = [k for k, _ in sp["nodes"]]
        state = {k: v["state"] for k, v in sp["nodes"]}
        par = {k: v["parent"] for k, v in sp["nodes"]}
        live = [k for k in ids if state[k] == "live"]
        pick = rng.random()
        k = rng.choice(ids)
        if pick < 0.2:
            out["value"].append(value_row(b, sp, rng.choice(["free", "committed"]), k))
        elif pick < 0.55:
            payer = rng.choice(live)
            actor = rng.choice([USER, USER, payer, rng.choice(ids)] + ancestors_of(sp, payer))
            out["acquire"].append(acquire_row(b, sp, actor, payer, rng.choice(needs), rng.random() < 0.8))
        elif pick < 0.8:
            actor = rng.choice([USER, USER, k, rng.choice(ids)] + ancestors_of(sp, k))
            delta = rng.choice([1, 2, 5, 0.5, -1, -0.5, -3, 0.25, 10, -10, 0.99, 3.01])
            out["reallocate"].append(reallocate_row(b, sp, actor, k, delta))
        elif pick < 0.92:
            parent = rng.choice(live + [None])
            extra = ([parent] + ancestors_of(sp, parent)) if parent else []
            actor = rng.choice([USER, USER, rng.choice(ids)] + extra)
            tier = rng.choice([t[0] for t in sp["tiers"]])
            out["hire"].append(hire_row(b, sp, actor, parent, tier, rng.choice([0, 1, 3, 7, 12])))
        else:
            arch = [x for x in ids if state[x] == "archived" and (par[x] is None or state.get(par[x]) == "live")]
            if not arch:
                continue
            nid = rng.choice(arch)
            actor = rng.choice([USER, USER] + ancestors_of(sp, nid))
            out["rehire"].append(rehire_row(b, sp, actor, nid, rng.choice([None, None, 2, 3.5, 8])))
    return out


# ---------------------------------------------------------------- tables
def section_fmt_g(rng: random.Random) -> list[list[Any]]:
    """Python's format(x, 'g'), which every message and warning uses."""
    vals: list[Any] = [0.0, -0.0, 0, 1, -1, 0.5, 104.2, 0.1 + 0.2, 1 / 3, 2.675, 1234565, 1234575,
                       123456.5, 12345.65, 1024.125, 999999.5, 9999995, 0.0001, 0.00001234565,
                       1e16, 1e-5, 123456, 1234567, 100000, 1000000, 0.000125, 7.005, 1e300, 5e-324,
                       float("inf"), float("-inf"), -2.5e-7, 10**15, 999999, 9999994, 0.00009999995]
    for _ in range(400):
        e = rng.randint(-8, 9)
        vals.append(round(rng.uniform(-1, 1) * 10 ** e, rng.randint(0, 9)))
        m = rng.randint(1, 999999)
        vals.append(m * 5 * 10 ** rng.randint(-8, 3) if rng.random() < 0.5 else m + 0.5)
    for _ in range(200):
        vals.append(rng.randint(0, 10**6) / 100 - rng.randint(0, 10**6) / 100)
    return [[num(v), format(v, "g")] for v in vals]


def section_sum(rng: random.Random) -> list[list[Any]]:
    """Python's builtin sum() over mixed int/float items, which committed()
    uses. CPython 3.12+ compensates float sums, so plain addition differs."""
    rows = []
    pool = [0.1, 0.2, 0.3, 1e16, -1e16, 1e-3, 2.675, 0.125, 1, 2, -3, 0.7, 1e100, -1e100]
    for _ in range(600):
        items: list[Any] = []
        for _ in range(rng.randint(0, 9)):
            r = rng.random()
            if r < 0.3:
                items.append(rng.randint(-5, 1000))
            elif r < 0.6:
                items.append(rng.randint(0, 100000) / 100)
            elif r < 0.85:
                items.append(rng.choice(pool))
            else:
                items.append(rng.uniform(-1e6, 1e6))
        rows.append([[num(x) for x in items], sum(items)])
    for items in ([0.1] * 10, [1.0, 1e100, 1.0, -1e100], [-0.0], [1e16, 1, 1.0], [2**62, 2**62, 1.5],
                  [-0.0, -0.0], [0.5, -0.0], [1e308, 1e308, -1e308]):
        rows.append([[num(x) for x in items], sum(items)])
    # The engine runtime is Windows x64, where C `long` is 32 bits: an int
    # item outside [-2**31, 2**31) leaves both fast paths, and whatever
    # follows is added with plain `+`, uncompensated.
    for items in ([2**31, 1e16, 0.1, -1e16], [2**31 - 1, 1e16, 0.1, -1e16], [-2**31, 1e16, 0.1, -1e16],
                  [-2**31 - 1, 1e16, 0.1, -1e16], [0.5, 2**31, 1e16, 0.1, -1e16], [0.5, 2**31 - 1, 1e16, 0.1, -1e16],
                  [5, 2**31 - 1, 1e16, 0.1, -1e16], [2**31 - 1, 2**31 - 1, 0.2, 1e16, 0.2, -1e16],
                  [2**40, 0.1, 0.2, 0.3], [2**53 + 1, 1.0, 0.5], [0.1, 2**62, 0.2, 1e16, -1e16, 0.3],
                  [1e16, 0.1, -1e16, 2**33, 0.1, 1e16, -1e16],
                  # the pending compensation is added when a wide int ends
                  # the float phase, and stays visible in the result
                  [1e16, 0.1, -1e16, 2**31], [1e16, 0.3, -1e16, -2**31 - 1], [0.1, 0.2, 0.3, 2**33],
                  [1e16, 0.1, -1e16, 2**33, 0.5], [0.5, 1e16, 0.1, -1e16, 2**40, 0.25],
                  [1e16, 0.1, -1e16, 2**64], [1e16, 1.0, -1e16, 0.25, 2**31, 0.1]):
        rows.append([[num(x) for x in items], sum(items)])
    wide = [2**31 - 1, 2**31, -2**31, -2**31 - 1, 2**33 + 7, 2**40, 2**53 + 1, 2**62, -2**63, 2**64]
    for _ in range(300):
        items = []
        for _ in range(rng.randint(1, 8)):
            r = rng.random()
            if r < 0.3:
                items.append(rng.choice(wide))
            elif r < 0.45:
                items.append(rng.randint(-5, 1000))
            else:
                items.append(rng.choice(pool + [rng.uniform(-1e6, 1e6)]))
        rows.append([[num(x) for x in items], sum(items)])
    return rows


# ---------------------------------------------------------------- driver
def anchors(repo: Path) -> dict[str, str]:
    return {p: hashlib.sha256((repo / p).read_bytes()).hexdigest() for p in ANCHORED}


def build(repo: Path) -> dict:
    if sys.version_info[:2] != REQUIRED_PYTHON:
        raise SystemExit(f"run with the engine runtime Python {REQUIRED_PYTHON}, not {sys.version}")
    sys.path.insert(0, str(repo / "engine" / "backend"))
    from orgtree import ledger  # noqa: PLC0415

    if ledger.CREDIT_PLACES != 2 or ledger.USER != USER or ledger.SYSTEM != SYSTEM:
        raise SystemExit("oracle stopped: ledger constants moved; review the vectors by hand")
    b = Builder(ledger)
    rng = random.Random(20260923)
    hand = handcrafted(b)
    rnd = random_rows(b, rng, 1400)
    doc: dict[str, Any] = {
        "schema": SCHEMA,
        "oracle": {"python": ".".join(map(str, sys.version_info[:3])), "anchors": anchors(repo)},
        "limits": ("Synthetic organizations only. Expected values are current Python behavior, "
                   "not a new contract. Reads are what the Python code touched, not a lock set."),
        "fmt_g": section_fmt_g(rng),
        "sum": section_sum(rng),
    }
    for k in ("value", "acquire", "reallocate", "hire", "rehire"):
        doc[k] = hand[k] + rnd[k]
    # Rows Python is never run on. Its chain walk and its archived-superior
    # walk have no cycle guard and would not terminate; a rehire of an
    # unrecoverable node is a re-seed and a hire of an unpriced tier fails
    # tier validation, both outside the funding step. The crate must refuse
    # every one of them as outside its parity domain.
    cyc = spec([("a", node("b", grant=1)), ("b", node("a", grant=1))])
    doc["outside"] = [
        {"op": "acquire", "reason": "cycle", "spec": cyc,
         "actor": USER, "payer": "a", "need": 5, "cascade": True},
        {"op": "acquire", "reason": "cycle",
         "spec": spec([("r", node(None, grant=1)), ("a", node("b", grant=1)), ("b", node("a", grant=1))]),
         "actor": "r", "payer": "a", "need": 5, "cascade": True},
        {"op": "rehire", "reason": "cycle",
         "spec": spec([("r", node(None, grant=9)), ("a", node("b", state="archived", grant=1)),
                       ("b", node("a", state="archived", grant=1))]),
         "actor": USER, "node": "a", "grant": None},
        {"op": "rehire", "reason": "reseed",
         "spec": spec([("r", node(None, grant=9)), ("u", node("r", state="unrecoverable", grant=1))]),
         "actor": USER, "node": "u", "grant": None},
        {"op": "hire", "reason": "unpriced tier", "spec": chain3(),
         "actor": USER, "parent": "mid", "tier": "fable", "grant": 1},
    ]
    return doc


def render(doc: dict) -> str:
    """One row per line so a changed vector shows up as a readable diff."""
    parts = ["{"]
    keys = list(doc)
    for i, k in enumerate(keys):
        v = doc[k]
        tail = "," if i < len(keys) - 1 else ""
        if isinstance(v, list):
            parts.append(f" {json.dumps(k)}: [")
            for j, row in enumerate(v):
                sep = "," if j < len(v) - 1 else ""
                parts.append("  " + json.dumps(row, ensure_ascii=True, separators=(",", ":")) + sep)
            parts.append(" ]" + tail)
        else:
            parts.append(f" {json.dumps(k)}: " + json.dumps(v, ensure_ascii=True, separators=(",", ":")) + tail)
    parts.append("}")
    return "\n".join(parts) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo-root", type=Path, default=CRATE.parents[2])
    ap.add_argument("--vectors", type=Path, default=DEFAULT_VECTORS)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="orgtree-funding-oracle-") as data:
        os.environ["ORGTREE_DATA"] = data
        doc = build(args.repo_root.resolve())
    text = render(doc)
    digest = hashlib.sha256(text.encode()).hexdigest()
    if args.write:
        args.vectors.parent.mkdir(parents=True, exist_ok=True)
        args.vectors.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {args.vectors} ({len(text)} bytes, sha256 {digest})")
        return 0
    current = args.vectors.read_text(encoding="utf-8")
    if current != text:
        print(f"MISMATCH: {args.vectors} differs from vectors regenerated from current source")
        return 1
    print(f"matches: {args.vectors} ({len(text)} bytes, sha256 {digest})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
