# pyright: strict
"""@net: — the mail-hub client (F-06).

Two halves:
- IDENTITY (Phase A): the org's permanent network identity + hub config.
- TRANSPORT (Phase C): the spool sender + multiplexed long-poll daemon.

Identity model (docs/mailserver-spec.md §3, all user-ruled):
  secret      = secrets.token_hex(16)        minted BY the org at creation
  fingerprint = sha256(secret)               the hub stores only this
  slug        = f"{org}.{username}.{fingerprint[:6]}"   minted ONCE, persisted,
                never recomputed — the address survives moves and renames.

Transport model (spec §4/§10, all ruled): outbound sends return instantly by
writing a SPOOL entry into the org doc (staged inside the caller's DOC_LOCK,
riding the same save as the org-inbox row — no crash window where the ledger
says "queued" with no spool entry); the SENDER thread drains spools with
backoff and retries FOREVER ("no hub yet" is a status, not an error). The
POLLER thread holds one multiplexed long poll per hub address covering every
participating org; inbound mail is dedup'd against a persisted seen-ring,
DELIVERED FIRST (deliver_org_inbox = net_wake auto), recorded seen, then
ACKED — a crash between steps duplicates, never loses. Receipts are
best-effort and never block correspondence.

⚠ Secret hygiene: the secret lives in the org doc (`net_identity`) and is
returned by exactly one loopback-admin endpoint (`GET /api/orgs/{slug}/net`).
It must never enter a tree payload, an agent's context, a log line, or a URL —
on the wire it rides headers only. Kiosk orgs mint NO identity at all: they are
sealed from the outside world, and an identity that does not exist cannot leak
(stronger than filtering rosters).

⚠ Lock discipline: DOC_LOCK is never held across an HTTP call. The daemon
threads take it only to read/mutate docs, in the same order as everyone else.
"""

from __future__ import annotations

import getpass
import hashlib
import os
import tempfile
import threading
import time
import uuid
from typing import TYPE_CHECKING, Any, Callable, cast

import re
import secrets
from urllib.parse import urlsplit

from .ledger import now

if TYPE_CHECKING:
    from .ledger import Org

# the local hub's default address; overridable via defaults.json
# ("net_hub_address" — translated into the "local" hub entry at org creation,
# never written raw into an org doc)
DEFAULT_HUB_ADDRESS = "http://127.0.0.1:7370"
DEFAULT_HUB_PORT = 7370
LOCAL_HUB_ID = "local"    # the implicit same-machine hub; per-hub state keys
                          # on this id, so its ADDRESS may be edited freely


def normalize_hub_address(addr: str) -> str:
    """A bare host is a valid hub address (user spec 2026-08-05): no scheme
    assumes http, no port assumes the hub default (7370). https entries with
    no port are left alone — a tunneled hub (trycloudflare) listens on 443
    and appending 7370 would break it. Invalid input is returned as typed —
    the connect loop's status line is where 'unreachable' belongs, not a 422
    at the settings form."""
    a = str(addr or "").strip().rstrip("/")
    if not a:
        return ""
    if "://" not in a:
        a = "http://" + a
    try:
        u = urlsplit(a)
        if u.scheme == "http" and u.hostname and u.port is None:
            a = f"http://{u.netloc}:{DEFAULT_HUB_PORT}"
            if u.path:
                a += u.path
    except ValueError:
        pass                       # e.g. a malformed port — keep as typed
    return a


def _sanitize_user(user: str) -> str:
    """The username is human-readable decoration in the slug (uniqueness comes
    from the fingerprint suffix). Dots separate the slug's three parts, so the
    username must never contain one."""
    s = re.sub(r"[^A-Za-z0-9_-]", "-", user).strip("-").lower()
    return s or "user"


def mint_identity(org: "Org") -> dict[str, Any] | None:
    """Mint the org's permanent network identity. Idempotent — an existing
    identity is returned untouched (the slug is IMMUTABLE for the org's
    lifetime, user ruling). Returns None for kiosk orgs, which have no
    identity by design. Caller holds DOC_LOCK and saves."""
    if org.d.get("kiosk"):
        return None
    ident = org.d.get("net_identity")
    if isinstance(ident, dict) and ident.get("secret"):
        return ident
    secret = secrets.token_hex(16)               # the repo's credential pattern
    fp = hashlib.sha256(secret.encode()).hexdigest()
    ident = {
        "secret": secret,
        "fingerprint": fp,
        "slug": f"{org.d['slug']}.{_sanitize_user(getpass.getuser())}.{fp[:6]}",
        "minted_at": now(),
    }
    org.d["net_identity"] = ident
    return ident


def hub_entries(autoconnect: bool, remote_addresses: list[str],
                local_address: str = DEFAULT_HUB_ADDRESS) -> list[dict[str, Any]]:
    """Build the initial `net_hubs` list for a new org. The local hub entry
    exists only under autoconnect; remote hubs are explicit addresses, each
    with a client-minted id so per-hub state survives address edits. Hub
    NAMES are discovered on connect (user ruling), never set here."""
    hubs: list[dict[str, Any]] = []
    if autoconnect:
        hubs.append({"id": LOCAL_HUB_ID,
                     "address": local_address.strip() or DEFAULT_HUB_ADDRESS,
                     "enabled": True})
    for a in remote_addresses:
        a = a.strip()
        if a:
            hubs.append({"id": uuid.uuid4().hex[:8], "address": a,
                         "enabled": True})
    return hubs


# ═══════════════════════════════════════════════ Phase C — the transport ═══

SEEN_RING = 500          # per hub: inbound message ids kept for dedupe
STALE_AFTER_S = 3600.0   # inbound older than this gets the staleness stamp
POLL_WAIT_S = 25.0       # server clamps to its own 55 s ceiling
BACKOFF_MAX_S = 30.0

# set by api._wire_notify: broadcast an org's `changed` event (thread-safe
# there). Called on every CONNECTIVITY TRANSITION so the UI's status dots are
# realtime without polling (user amendment 2026-08-05).
notify_changed: Callable[[str], None] | None = None

_started = False
_kick = threading.Event()
# in-memory per (org_slug, hub_id): {"connected", "last_ok", "error"} — status
# for the tree payload; per hub ADDRESS: roster + discovered name
_status: dict[tuple[str, str], dict[str, Any]] = {}
_status_lock = threading.Lock()
_rosters: dict[str, list[dict[str, Any]]] = {}
_hub_names: dict[str, str] = {}
# read receipts queued by _confirm_delivered (supervisor) until the sender
# thread flushes them; restart loses at most a pending "read" — the far end
# self-heals to "delivered", which is honest
_read_q: list[tuple[str, str]] = []      # (org_slug, net_id)
_read_q_lock = threading.Lock()
# delivered receipts queued at delivery time (we know the hub they came from).
# ⚠ its OWN lock (redteam ⑤): the poller appends while the sender snapshots,
# and an unlocked snapshot dropped receipts — a lost DELIVERED does not
# self-heal (the row sits at 'sent' until a read happens to follow)
_dlv_q: list[tuple[str, str, str]] = []  # (org_slug, hub_id, net_id)
_dlv_q_lock = threading.Lock()
_backoff: dict[str, float] = {}          # hub address → monotonic not-before
_backoff_n: dict[str, int] = {}          # consecutive failures PER ADDRESS
                                         # (redteam ③: len(_backoff) counted
                                         # addresses, not attempts — flat 2 s)


def _fail(addr: str) -> None:
    n = _backoff_n.get(addr, 0) + 1
    _backoff_n[addr] = n
    _backoff[addr] = time.monotonic() + min(BACKOFF_MAX_S, 2.0 ** n)


def _ok(addr: str) -> None:
    _backoff_n.pop(addr, None)
    _backoff.pop(addr, None)


def kick() -> None:
    """Wake the sender thread now (called after a send staged a spool entry)."""
    _kick.set()


def note_read(slug: str, net_ids: list[str]) -> None:
    """A turn provably consumed inbound net mail (the _confirm_delivered
    seam) — queue READ receipts for the next flush."""
    if not net_ids:
        return
    with _read_q_lock:
        _read_q.extend((slug, i) for i in net_ids)
    _kick.set()


def spool_append(org: "Org", peer: str, body: str, oid: str,
                 kind: str = "message",
                 attachments: list[str] | None = None) -> str:
    """Stage an outbound @net: message. PURE doc mutation on the caller's
    already-loaded org — it rides the caller's save (api.py agent dispatch),
    so the org-inbox row and the spool entry land atomically. Returns the hub
    message id (the idempotency key).

    ⚠ Raises when NO hub is enabled (redteam ①): the old LOCAL_HUB_ID
    fallback filed the entry under an id the org may not have, where no
    drain ever visits — a message that says "queued" and never leaves.
    Callers refuse at the door instead."""
    peer = peer.removeprefix("@net:")    # tolerate the prefixed form (redteam)
    hubs = [h for h in (org.d.get("net_hubs") or []) if h.get("enabled")]
    if not hubs:
        from .ledger import LedgerError
        raise LedgerError(
            "no mailserver is configured — enable a hub in the org's "
            "settings (mailserver tab) before addressing @net: mail")
    # ⚠ WHICH hub the entry files under decides whether it can EVER leave
    # (remote-side investigation 2026-08-05: `hubs[0]` filed everything
    # under a dead implicit local entry while the reachable hub sat second
    # in the list — four messages "queued" forever with the recipient
    # online). Pick like the transport ruling picks: the hub whose roster
    # HOLDS the target wins; failing that, a hub that is currently
    # connected; only then list order. Never refuse on a cold roster —
    # offline addressing must not require a live hub (FR-07), the spool
    # holds until one is back.
    hub_id = None
    for h in hubs:
        with _status_lock:
            roster = _rosters.get(str(h.get("address") or "")) or []
        if any(str(r.get("slug")) == peer for r in roster):
            hub_id = str(h["id"])
            break
    if hub_id is None:
        # tier 2 (cross-org find 2026-08-05, via neoja): "connected" alone is
        # weak evidence — a hub can be connected with a roster that has never
        # synced (fresh registration, container restart), and picking it over
        # a hub that actually knows the peer is a silent misroute in list
        # order. Prefer a connected hub whose roster knows OTHER parties;
        # fall back to any connected hub only when every roster is cold.
        # ⚠ MEMBERSHIP, not cardinality (neoja's proof 2026-08-06 on the
        # first cut): a hub's roster INCLUDES the registering org itself, so
        # bare truthiness was satisfied for every hub we are on and the
        # strict pass degenerated to list order — measured with one message
        # either side of the boundary, both misfiled identically. "Knows
        # someone besides us" is the signal the tier was built to read.
        oslug = str(org.d.get("slug") or "")
        own = str((org.d.get("net_identity") or {}).get("slug") or "")
        for need_roster in (True, False):
            for h in hubs:
                with _status_lock:
                    st = _status.get((oslug, str(h.get("id")))) or {}
                    roster = _rosters.get(str(h.get("address") or "")) or []
                others = any(str(r.get("slug")) != own for r in roster)
                if st.get("connected") and (others or not need_roster):
                    hub_id = str(h["id"])
                    break
            if hub_id is not None:
                break
    if hub_id is None:
        hub_id = str(hubs[0]["id"])
    entry: dict[str, Any] = {"id": uuid.uuid4().hex, "to": peer, "body": body,
                             "kind": kind, "at": now(), "oid": oid, "tries": 0}
    metas: list[dict[str, Any]] = []
    if attachments:
        entry["attachments"] = list(attachments)[:10]
        for p in entry["attachments"]:
            try:
                metas.append({"name": os.path.basename(p),
                              "bytes": os.path.getsize(p)})
            except OSError:
                metas.append({"name": os.path.basename(p), "bytes": 0})
    spool = org.d.setdefault("net_spool", {})
    spool.setdefault(hub_id, []).append(entry)
    # stamp the org-inbox row with the delivery state machine's first state
    for row in reversed(org.d.get("org_inbox") or []):
        if row.get("id") == oid:
            row["state"] = "queued"
            row["state_at"] = now()
            row["net_id"] = entry["id"]
            if metas:
                row["attachments"] = metas
            break
    return str(entry["id"])


def status_block(org_d: dict[str, Any]) -> dict[str, Any] | None:
    """The tree payload's `net` block — config + live status, NEVER the
    secret (or the full fingerprint; the slug's baked-in 6-char suffix is the
    only identity material a payload carries)."""
    if org_d.get("kiosk") is not None:
        return None
    ident = cast("dict[str, Any]", org_d.get("net_identity") or {})
    hubs_out: list[dict[str, Any]] = []
    slug = str(org_d.get("slug") or "")
    spool = cast("dict[str, list[Any]]", org_d.get("net_spool") or {})
    net_state = cast("dict[str, dict[str, Any]]",
                     org_d.get("net_state") or {})
    for h in cast("list[dict[str, Any]]", org_d.get("net_hubs") or []):
        hid = str(h.get("id"))
        with _status_lock:
            st = dict(_status.get((slug, hid)) or {})
            roster = list(_rosters.get(str(h.get("address") or "")) or [])
            name = h.get("name") or _hub_names.get(str(h.get("address") or ""))
        connected = bool(st.get("connected"))
        # user ruling 2026-08-05: the IMPLICIT local entry is INVISIBLE until
        # the hub has actually answered once (registered_at is the durable
        # signal; the daemon keeps dialling quietly, backed off). An EXPLICIT
        # typed remote is always shown, offline included — the user asserted
        # it exists, so silence would be the wrong answer. The registration
        # counts only for the address it was earned against (second wave):
        # a re-added/re-pointed entry starts hidden again.
        cell = net_state.get(hid) or {}
        seen = connected or bool(
            cell.get("registered_at")
            and cell.get("address") == str(h.get("address")))
        # §10: per-message failures, summarized where the mailserver tab
        # reads — "N stuck, last error: …" instead of a bare queue count
        entries = spool.get(hid) or []
        stuck = [e for e in entries if e.get("last_err")]
        newest = max(stuck, key=lambda e: int(e.get("tries") or 0),
                     default=None)
        hubs_out.append({
            "id": hid, "address": h.get("address"),
            "enabled": bool(h.get("enabled")), "name": name,
            "connected": connected,
            "hidden": hid == LOCAL_HUB_ID and not seen,
            "last_ok": st.get("last_ok"), "error": st.get("error"),
            "queued": len(entries),
            **({"stuck": len(stuck),
                "stuck_err": str(newest.get("last_err"))[:200]}
               if newest else {}),
            "roster": [r for r in roster
                       if r.get("slug") != ident.get("slug")],
        })
    return {"slug": ident.get("slug"), "hubs": hubs_out}


def probe_peer(target: str) -> bool:
    """User ruling 2026-08-12 (the unknown-recipient send gate): is `target`
    on ANY known hub's roster RIGHT NOW? The local cache answers first
    (offline-cheap, the common case); a miss earns exactly one live GET
    /api/roster per known hub — a freshly registered peer must not be
    refused for the crime of beating the next poll pass. Each live answer
    also refreshes the cache, so the miss cost amortizes. Hub unreachable →
    the cache's answer stands (an absent peer refuses; the message says a
    fresh registration appears on the next refresh)."""
    with _status_lock:
        addrs = list(_rosters.keys())
        for roster in _rosters.values():
            if any(str(r.get("slug") or "") == target for r in roster):
                return True
    found = False
    for addr in addrs:
        try:
            with _client() as c:
                r = c.get(f"{addr}/api/roster")
            if r.status_code != 200:
                continue
            body = cast("dict[str, Any]", r.json() or {})
            roster = cast("list[dict[str, Any]]",
                          body.get("roster") or [])
            with _status_lock:
                _rosters[addr] = list(roster)
            if any(str(x.get("slug") or "") == target for x in roster):
                found = True
        except Exception:                                        # noqa: BLE001
            continue
    return found


def remote_peers() -> list[dict[str, Any]]:
    """Roster rows for orgtree_list_orgs — every known remote peer across all
    connected hubs, deduped by network slug."""
    with _status_lock:
        rows = [dict(r) for roster in _rosters.values() for r in roster]
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in rows:
        s = str(r.get("slug") or "")
        if s and s not in seen:
            seen.add(s)
            out.append({"slug": f"@net:{s}", "name": r.get("org_name") or s,
                        "online": bool(r.get("online")),
                        "last_seen": r.get("last_seen"),
                        "kind": r.get("kind") or "org",   # FR-06: org | chat
                        "blurb": r.get("blurb") or ""})
    return out


def _set_status(slug: str, hub_id: str, connected: bool,
                error: str | None = None) -> None:
    """Record status; broadcast ONLY on a transition (realtime dots without
    broadcast spam)."""
    key = (slug, hub_id)
    with _status_lock:
        prev = _status.get(key)
        changed = prev is None or bool(prev.get("connected")) != connected \
            or (prev.get("error") or None) != (error or None)
        _status[key] = {"connected": connected,
                        "last_ok": now() if connected
                        else (prev or {}).get("last_ok"),
                        "error": error}
    if changed and notify_changed:
        try:
            notify_changed(slug)
        except Exception:                                        # noqa: BLE001
            pass


def _participants() -> dict[str, dict[str, Any]]:
    """Snapshot which orgs talk to which hubs. Loads docs (cheap at this
    scale, and the storage watchdog already does the same each 20 s); mints
    missing identities/backfills hub lists for pre-F-06 orgs under DOC_LOCK
    (the chatq precedent: existing orgs join automatically)."""
    from . import store
    out: dict[str, dict[str, Any]] = {}
    for o in store.list_orgs():
        slug = str(o["slug"])
        if o.get("kiosk"):
            continue
        try:
            org = store.load_org(slug)
        except Exception:                                        # noqa: BLE001
            continue
        if org.d.get("kiosk") is not None:
            continue
        if not org.d.get("net_identity") or "net_hubs" not in org.d:
            try:
                with store.DOC_LOCK:
                    org = store.load_org(slug)
                    mint_identity(org)
                    if "net_hubs" not in org.d:
                        org.d.setdefault("net_autoconnect", True)
                        org.d["net_hubs"] = hub_entries(
                            bool(org.d.get("net_autoconnect", True)), [],
                            _default_address())
                    store.save_org(org)
            except Exception:                                    # noqa: BLE001
                continue
        ident = org.d.get("net_identity") or {}
        hubs = [dict(h) for h in (org.d.get("net_hubs") or [])
                if h.get("enabled") and h.get("address")]
        if not ident.get("secret"):
            continue
        # RECONCILE per-hub state with the hub list (redteam second wave —
        # "per-hub state outlives the hub it describes"): a net_state cell
        # whose id has NO current entry (removed local) is dropped, and one
        # whose stored address differs from the entry's CURRENT address is
        # dropped too — otherwise a re-added local hub inherits an old
        # registration (shows visible before it ever answered) and, worse,
        # a re-pointed address inherits the previous machine's dedupe ring,
        # silently swallowing a re-homed peer's re-sent ids. Dropping a ring
        # risks a bounded duplicate, never a loss (the ratified trade). Cells
        # written before this change carry no address and reset once.
        state_now = cast("dict[str, dict[str, Any]]",
                         org.d.get("net_state") or {})
        cur_addr = {str(h["id"]): str(h["address"]) for h in hubs}
        # ANY mismatch resets — including cells with no stored address (a
        # legacy or hand-planted ring must not survive an address edit; a
        # one-time reset costs at most a bounded duplicate)
        stale = [k for k, v in state_now.items()
                 if k not in cur_addr or v.get("address") != cur_addr[k]]
        if stale:
            try:
                with store.DOC_LOCK:
                    org = store.load_org(slug)
                    st2 = org.d.setdefault("net_state", {})
                    for k in stale:
                        st2.pop(k, None)
                    store.save_org(org)
            except Exception:                                    # noqa: BLE001
                pass
        # SELF-HEAL orphaned spool keys (redteam ②): anything queued under a
        # hub id the org no longer has re-keys to the first enabled hub —
        # covers direct doc edits, not just the settings path (addresses are
        # hub-agnostic, ruled, so any hub may carry the entry)
        spool = cast("dict[str, list[Any]]", org.d.get("net_spool") or {})
        hub_id_set = {str(h["id"]) for h in hubs}
        orphans = [k for k in spool if k not in hub_id_set and spool.get(k)]
        if orphans and hubs:
            try:
                with store.DOC_LOCK:
                    org = store.load_org(slug)
                    sp = cast("dict[str, list[Any]]",
                              org.d.setdefault("net_spool", {}))
                    tgt = str(hubs[0]["id"])
                    for k in [x for x in list(sp) if x not in hub_id_set]:
                        moved: list[Any] = sp.pop(k) or []
                        if moved:
                            sp.setdefault(tgt, []).extend(moved)
                    store.save_org(org)
            except Exception:                                    # noqa: BLE001
                pass
        net_state = cast("dict[str, dict[str, Any]]",
                         org.d.get("net_state") or {})
        spool = cast("dict[str, list[Any]]", org.d.get("net_spool") or {})
        out[slug] = {"net_slug": str(ident.get("slug")),
                     "secret": str(ident.get("secret")),
                     "name": str(org.d.get("name") or slug),
                     "hubs": hubs,
                     "registered": {
                         str(h["id"]):
                         bool((net_state.get(str(h["id"])) or {})
                              .get("registered_at"))
                         for h in hubs},
                     "spool": {k: len(v) for k, v in spool.items()}}
    return out


# A dead address, not the real hub: the discard port refuses instantly, so
# registration fails harmlessly into the existing backoff rather than hanging.
UNROUTABLE_HUB_ADDRESS = "http://127.0.0.1:9"


def _under_os_temp(path: str) -> bool:
    """Is `path` inside the OS temp directory?

    THE FLOOR UNDER THE TEST-RIG HUB HAZARD. A rig mints a throwaway
    ORGTREE_DATA with `tempfile.mkdtemp`, creates fixture orgs in it, and if
    that rig also boots a backend, `_participants` registers every one of them
    against whatever `_default_address` returns. A fresh data root has no
    `defaults.json`, so that used to be DEFAULT_HUB_ADDRESS - the OPERATOR'S
    REAL HUB - and the fixtures landed in the live roster as selectable
    recipients that can never receive anything. It happened: ~45 fixture orgs
    on 2026-08-06, and again on 2026-08-10 after a fix that covered three
    suites and missed a fourth which grew a live backend later.

    Every repair before this one asked the RIG to remember something. This one
    does not, which is the whole point: a rig author who knows nothing about
    the hub cannot forget it.

    ⚠ COMPARE RESOLVED PATHS, NEVER NAMES. On Windows %TEMP% commonly arrives
    in 8.3 SHORT FORM (the user folder as NCOLA~1 rather than spelled out)
    while the data root arrives long, and either side can be a symlink or a
    substituted drive. A string compare says "not temp" for the same
    directory spelled two ways, which fails OPEN - straight back to the real
    hub. os.path.realpath resolves both forms; normcase handles the
    case-insensitive filesystem.
    ⚠ AND IT FAILS IN THE SAFE DIRECTION ON PURPOSE. A genuine install whose
    data root really does sit under the OS temp directory gets the dead
    address and its hub registration visibly does not work. That is correct:
    such an install is already misconfigured (temp is periodically cleared, so
    its orgs are one cleanup away from gone), and a loud "the hub never
    connects" is a better outcome than a quiet one that pollutes a shared
    roster. Set `net_hub_address` in defaults.json to override - the explicit
    value always wins, and this branch is only ever reached when there is none.
    """
    try:
        root = os.path.normcase(os.path.realpath(path))
        temp = os.path.normcase(os.path.realpath(tempfile.gettempdir()))
    except (OSError, ValueError):
        return False
    return root == temp or root.startswith(temp + os.sep)


def _default_address() -> str:
    # defaults.json is api-owned; read it directly to avoid an import cycle
    import json
    from . import store
    try:
        d = json.load(open(os.path.join(store.DATA_ROOT, "defaults.json"),
                           encoding="utf-8"))
        if isinstance(d, dict):
            explicit = str(cast("dict[str, Any]", d)
                           .get("net_hub_address") or "")
            if explicit:
                return explicit
    except (OSError, ValueError):
        pass
    # No explicit address. The default is the operator's real hub
    # UNLESS this data root is a throwaway one under the OS temp
    # directory - see _under_os_temp for why that is the floor and
    # why it fails in this direction.
    return (UNROUTABLE_HUB_ADDRESS
            if _under_os_temp(store.DATA_ROOT)
            else DEFAULT_HUB_ADDRESS)


def _client() -> Any:
    import httpx
    return httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0))


def _poll_client() -> Any:
    import httpx
    return httpx.Client(timeout=httpx.Timeout(POLL_WAIT_S + 10.0,
                                              connect=5.0))


def _auth_header(pairs: list[tuple[str, str]]) -> dict[str, str]:
    return {"X-Org-Auth": " ".join(f"{s}:{sec}" for s, sec in pairs)}


def _record_hub_name(addr: str, name: Any, parts: dict[str, dict[str, Any]],
                     hub_ids: dict[str, str]) -> None:
    """Persist a discovered hub name onto EVERY org's matching hub entry.
    ⚠ The skip must be PER ORG (redteam ④): an address-level early-return
    meant only the first caller's doc learned the name — the UI looked right
    off the in-memory cache while every other doc stayed nameless, and the
    doc is what survives a restart. The parts snapshot carries each org's
    current entry, so the check is cheap (no doc load on the skip path)."""
    from . import store
    if not name or not isinstance(name, str):
        return
    with _status_lock:
        _hub_names[addr] = name
    for slug in parts:
        hid = hub_ids.get(slug)
        if not hid:
            continue
        mine = next((h for h in parts[slug]["hubs"]
                     if str(h.get("id")) == hid), None)
        if mine is not None and mine.get("name") == name:
            continue
        try:
            with store.DOC_LOCK:
                org = store.load_org(slug)
                for h in org.d.get("net_hubs") or []:
                    if str(h.get("id")) == hid and h.get("name") != name:
                        h["name"] = name
                        store.save_org(org)
                        break
            if mine is not None:
                mine["name"] = name      # keep the snapshot honest this pass
        except Exception:                                        # noqa: BLE001
            pass


def _groups(parts: dict[str, dict[str, Any]]) \
        -> dict[str, dict[str, str]]:
    """address → {org_slug: hub_id} — one multiplexed connection per hub
    ADDRESS covering every participating org."""
    g: dict[str, dict[str, str]] = {}
    for slug, p in parts.items():
        for h in p["hubs"]:
            g.setdefault(str(h["address"]), {})[slug] = str(h["id"])
    return g


def _clear_registration(slug: str, hub_id: str) -> None:
    """The 401 self-heal (neoja finding + the roster-prune wave,
    2026-08-06): a hub answering 401 means it does not know us — a pruned
    row, a manual unregister, or a rebuilt data volume. `registered_at` was
    written exactly once and nothing ever cleared it, so an org whose hub
    row vanished believed it was registered and 401'd forever with no
    self-heal — the failure mode that made any roster prune unsafe.
    Clearing the flag makes the register loop re-register on its next pass
    (idempotent: same secret → same fingerprint → the hub re-mints the
    identical address, first-write-wins satisfied by our own hash)."""
    from . import store
    try:
        with store.DOC_LOCK:
            org = store.load_org(slug)
            cell = (org.d.get("net_state") or {}).get(hub_id)
            if cell and cell.get("registered_at"):
                cell["registered_at"] = None
                store.save_org(org)
    except Exception:                                            # noqa: BLE001
        pass


def _register_pending(parts: dict[str, dict[str, Any]]) -> None:
    from . import store
    for slug, p in parts.items():
        for h in p["hubs"]:
            hid = str(h["id"])
            if p["registered"].get(hid):
                continue
            addr = str(h["address"])
            if time.monotonic() < _backoff.get(addr, 0.0):
                continue
            try:
                with _client() as c:
                    r = c.post(f"{addr}/api/register",
                               json={"slug": p["net_slug"],
                                     "org_name": p["name"],
                                     "username": _sanitize_user(
                                         getpass.getuser())},
                               headers=_auth_header(
                                   [(p["net_slug"], p["secret"])]))
                if r.status_code != 200:
                    _set_status(slug, hid, False,
                                f"register: HTTP {r.status_code}")
                    continue
                data = r.json()
                _record_hub_name(addr, data.get("name"), {slug: p},
                                 {slug: hid})
                # the register response already carries the full roster —
                # adopt it NOW (redteam §9, user-reported 20–30 s panel
                # lag): the only other writer is the poll pass, which on an
                # idle hub blocks its whole 25 s wait window first
                with _status_lock:
                    _rosters[addr] = list(
                        cast("list[dict[str, Any]]",
                             data.get("roster") or []))
                with store.DOC_LOCK:
                    org = store.load_org(slug)
                    st = org.d.setdefault("net_state", {})
                    cell = st.setdefault(hid, {})
                    cell["registered_at"] = now()
                    # the state is a fact about THIS address (redteam second
                    # wave): a re-pointed or re-added entry must not inherit
                    # another machine's registration or dedupe ring
                    cell["address"] = addr
                    store.save_org(org)
                _set_status(slug, hid, True)
                _ok(addr)
            except Exception as e:                               # noqa: BLE001
                _fail(addr)
                _set_status(slug, hid, False, type(e).__name__)


def unregister_org(doc: dict[str, Any], *, timeout: float = 4.0,
                   ) -> dict[str, Any]:
    """The polite exit, made reachable from orgtree. Removes THIS org's row
    from every hub on its list.

    THE DEFECT THIS CLOSES. `POST /api/unregister` has existed on the hub
    since 2026-08-06 — "the polite exit", written in the same wave that added
    the roster prune — and nothing in this backend ever called it.
    `hubtool.unregister_identity` has the verb for a chat identity; an ORG
    had none. So deleting an org left its row behind, and the compose picker
    kept offering it as a recipient that can never receive anything. The
    route was built and the caller never was, which is the same shape as the
    org charter that reached nobody and the standing notes nothing read.

    ⚠ THE HUB IS NOT THE AUTHORITY ON WHETHER AN ORG STILL EXISTS, and this
    is why the fix is a polite exit rather than a sweep. A roster row whose
    org is absent from THIS machine may be an org living on ANOTHER install
    pointed at the same hub — "I cannot see it" is a fact about the observer.
    Only the holder of an identity's secret can say it is gone, which is
    exactly who calls this, and it is why the hub authenticates the request
    and deletes only the caller's own slugs.

    ⚠ IT MUST NOT BE ABLE TO FAIL A DELETE. Every error is caught and
    reported in the return value: a hub that is down, slow or gone is a
    completely normal condition, and an org that cannot be deleted because
    some unrelated machine is unreachable would be a far worse defect than
    the stale row. The row is not lost either way — the hub prunes rows
    unseen for ORG_RETENTION_DAYS, so an unregister that fails degrades to
    the timeout that was the only behaviour before this existed.

    ⚠ SAFE ACROSS A RESTORE, which matters because deletion here is a
    REVERSIBLE RENAME into <data>/deleted/. The local doc keeps its identity
    (this only drops the remote row, exactly as `hubtool` does), so a
    restored org re-registers on the next 401 with the SAME secret and the
    hub re-mints the IDENTICAL address — see `_clear_registration`. Nothing
    about the org's network identity is destroyed here.

    Takes a doc SNAPSHOT rather than a slug, because the caller must read it
    before the document is renamed away.
    """
    ident = doc.get("net_identity")
    if not isinstance(ident, dict) or not ident.get("secret"):
        return {"unregistered": [], "why": "no network identity"}
    net_slug, secret = str(ident.get("slug") or ""), str(ident["secret"])
    if not net_slug:
        return {"unregistered": [], "why": "identity has no slug"}
    hubs = [h for h in cast("list[dict[str, Any]]", doc.get("net_hubs") or [])
            if h.get("enabled") and h.get("address")]
    done: list[str] = []
    errors: dict[str, str] = {}
    for h in hubs:
        addr = str(h["address"])
        try:
            import httpx
            with httpx.Client(timeout=httpx.Timeout(timeout,
                                                    connect=timeout)) as c:
                r = c.post(f"{addr}/api/unregister", json={},
                           headers=_auth_header([(net_slug, secret)]))
            if r.status_code == 200:
                done.append(addr)
            elif r.status_code == 401:
                # the hub already does not know us: a prune, a rebuilt
                # volume, or a second delete. The goal state is reached, so
                # this is a success and not an error to report at the user.
                done.append(addr)
            else:
                errors[addr] = f"HTTP {r.status_code}"
        except Exception as e:                                   # noqa: BLE001
            errors[addr] = type(e).__name__
    return {"unregistered": done, **({"errors": errors} if errors else {})}


def _drain_spools(parts: dict[str, dict[str, Any]]) -> None:
    """Ship queued outbound. At-least-once: the hub send is idempotent on the
    entry id, so a crash after send / before the doc update just re-sends."""
    from . import store
    for slug, p in parts.items():
        for h in p["hubs"]:
            hid = str(h["id"])
            if not p["spool"].get(hid):
                continue
            addr = str(h["address"])
            if time.monotonic() < _backoff.get(addr, 0.0):
                # THE SILENT-FAILURE AMPLIFIER (remote-side finding
                # 2026-08-05): register runs before drain on the same loop
                # and re-arms this same per-address backoff, so an
                # enabled-but-down hub starves the drain indefinitely —
                # tries never moved, last_err was never written, and the
                # entries most certain to be stuck were exactly the ones
                # that looked pristine. Nothing is attempted here, so
                # `tries` stays honest — but the SKIP now stamps its
                # reason, so the ⚠ glyph and the stuck counts fire for
                # never-visited entries too. (The backoff stays SHARED by
                # design: splitting it would spend real connect timeouts
                # probing a dead hub every pass; visibility was the only
                # missing piece.)
                with _status_lock:
                    why = str((_status.get((slug, hid)) or {}).get("error")
                              or "connection failing; retrying")
                _stamp_skip(slug, hid, f"hub unreachable — {why}")
                continue
            # snapshot the entries OUTSIDE the lock hold during HTTP
            with store.DOC_LOCK:
                org = store.load_org(slug)
                entries = [dict(e) for e in
                           (org.d.get("net_spool") or {}).get(hid, [])]
            for e in entries:
                # F-06 D: upload attachments first (resumable — successful
                # ids persist on the entry so a retry never re-uploads).
                # A file DELETED since the send was staged is dropped with a
                # note rather than stalling the entry forever.
                try:
                    att_ids = _ship_attachments(slug, hid, addr, p, e)
                except Exception as ex:                          # noqa: BLE001
                    _fail(addr)
                    _set_status(slug, hid, False, type(ex).__name__)
                    _bump_try(slug, hid, str(e["id"]), type(ex).__name__)
                    break
                try:
                    with _client() as c:
                        r = c.post(f"{addr}/api/send",
                                   json={"id": e["id"], "to": e["to"],
                                         "body": e["body"],
                                         "kind": e.get("kind"),
                                         "sent_at": e.get("at"),
                                         "from": p["net_slug"],
                                         "attachments": att_ids},
                                   headers=_auth_header(
                                       [(p["net_slug"], p["secret"])]))
                except Exception as ex:                          # noqa: BLE001
                    _fail(addr)
                    _set_status(slug, hid, False, type(ex).__name__)
                    _bump_try(slug, hid, str(e["id"]), type(ex).__name__)
                    break
                if r.status_code == 200:
                    _spool_done(slug, hid, str(e["id"]))
                    _set_status(slug, hid, True)
                    _ok(addr)
                elif r.status_code == 401:
                    # the hub does not recognize the SENDER (pruned row /
                    # rebuilt volume): heal the registration and surface it;
                    # the entry retries after the re-register
                    _clear_registration(slug, hid)
                    _bump_try(slug, hid, str(e["id"]),
                              "hub did not recognize this org — "
                              "re-registering, will retry")
                elif r.status_code == 422:
                    # unknown recipient: the append-time hub pick is a
                    # one-shot guess, so a refuted guess is re-checked here —
                    # if another enabled hub's roster POSITIVELY holds the
                    # peer, the entry re-files there instead of retrying the
                    # refuting hub forever (cross-org find 2026-08-05: a
                    # cold-roster tier-2 pick was a sticky misroute).
                    if _refile_known_elsewhere(slug, hid, str(e["id"]),
                                               str(e["to"]), p["hubs"]):
                        _ok(addr)      # the hub answered; only the guess was wrong
                        continue
                    # no evidence elsewhere: keep retrying forever (the peer
                    # may register later — hub-agnostic addresses, ruled),
                    # but surface the reason
                    _bump_try(slug, hid, str(e["id"]),
                              str(r.json().get("detail", "unknown recipient"))
                              if r.headers.get("content-type", "")
                              .startswith("application/json")
                              else f"HTTP {r.status_code}")
                else:
                    _bump_try(slug, hid, str(e["id"]),
                              f"HTTP {r.status_code}")


def _ship_attachments(slug: str, hub_id: str, addr: str,
                      p: dict[str, Any], e: dict[str, Any]) -> list[str]:
    """Upload a spool entry's attachment files to the hub, resumably: each
    uploaded id is persisted onto the entry (`att_ids`) so a crash or later
    failure never re-uploads. Unreadable files are dropped with a note."""
    from . import store
    paths = [str(x) for x in
             cast("list[Any]", e.get("attachments") or [])]
    att_ids = [str(x) for x in cast("list[Any]", e.get("att_ids") or [])]
    while len(att_ids) < len(paths):
        path = paths[len(att_ids)]
        try:
            data = open(path, "rb").read()
        except OSError:
            # deleted since staging — drop it rather than stall forever
            with store.DOC_LOCK:
                org = store.load_org(slug)
                for se in (org.d.get("net_spool") or {}).get(hub_id, []):
                    if se.get("id") == e["id"]:
                        se["attachments"] = [x for x in se["attachments"]
                                             if x != path]
                        se["last_err"] = (f"attachment vanished before "
                                          f"upload: {os.path.basename(path)}")
                        store.save_org(org)
                        break
            paths.remove(path)
            continue
        with _client() as c:
            r = c.post(f"{addr}/api/attachments",
                       params={"name": os.path.basename(path)},
                       content=data,
                       headers=_auth_header([(p["net_slug"], p["secret"])]))
        if r.status_code != 200:
            raise RuntimeError(f"attachment upload HTTP {r.status_code}")
        att_ids.append(str(cast("dict[str, Any]", r.json())["id"]))
        with store.DOC_LOCK:
            org = store.load_org(slug)
            for se in (org.d.get("net_spool") or {}).get(hub_id, []):
                if se.get("id") == e["id"]:
                    se["att_ids"] = list(att_ids)
                    store.save_org(org)
                    break
    return att_ids


def _spool_done(slug: str, hub_id: str, entry_id: str) -> None:
    """Hub custody confirmed — remove the spool entry, advance the org-inbox
    row to `sent` (the 200 IS the 'received' receipt), and delete any
    compose-STAGED files the entry carried (redteam: nothing ever swept the
    stage; the hub holds its own copy now). Agent-scratch attachments are
    the agent's own files and stay."""
    from . import store
    removed: dict[str, Any] | None = None
    with store.DOC_LOCK:
        org = store.load_org(slug)
        spool = org.d.setdefault("net_spool", {})
        removed = next((e for e in spool.get(hub_id, [])
                        if e.get("id") == entry_id), None)
        spool[hub_id] = [e for e in spool.get(hub_id, [])
                         if e.get("id") != entry_id]
        _stamp_row(org.d, entry_id, "sent")
        store.save_org(org)
    for pth in cast("list[Any]", (removed or {}).get("attachments") or []):
        p = str(pth)
        if os.path.basename(os.path.dirname(p)) == "net_stage":
            try:
                os.remove(p)
            except OSError:
                pass


def _refile_known_elsewhere(slug: str, hub_id: str, entry_id: str,
                            peer: str,
                            hubs: list[dict[str, Any]]) -> str | None:
    """The 422-heal (cross-org find 2026-08-05, via neoja): an entry filed
    onto a hub that answers "no org registered" would retry THERE forever,
    even after another enabled hub's roster warms up and names the peer.
    Moves on POSITIVE evidence only — another hub's cached roster holds the
    slug; mere absence proves nothing (the peer may register later). A
    ping-pong between two hubs with mutually stale rosters is bounded by
    `refiled` (rosters refresh every poll, so a stale claim dies within a
    cycle anyway). Returns the new hub id, or None to fall through to the
    normal retry-and-surface path."""
    target: str | None = None
    for h in hubs:
        if str(h["id"]) == hub_id:
            continue
        with _status_lock:
            roster = _rosters.get(str(h.get("address") or "")) or []
        if any(str(r.get("slug")) == peer for r in roster):
            target = str(h["id"])
            break
    if target is None:
        return None
    from . import store
    with store.DOC_LOCK:
        org = store.load_org(slug)
        spool = cast("dict[str, list[dict[str, Any]]]",
                     org.d.setdefault("net_spool", {}))
        lst = spool.get(hub_id) or []
        e = next((x for x in lst if x.get("id") == entry_id), None)
        if e is None or int(e.get("refiled") or 0) >= 4:
            return None
        spool[hub_id] = [x for x in lst if x.get("id") != entry_id]
        e["refiled"] = int(e.get("refiled") or 0) + 1
        e.pop("last_err", None)
        spool.setdefault(target, []).append(e)
        # the org-inbox row too (redteam residual gap on 761c63f): an earlier
        # refusal may have _bump_try-stamped it, and a stale "no org
        # registered" ⚠ on a now-correctly-routed message reads as still
        # failing until the next delivery would have popped it
        for row in reversed(cast("list[dict[str, Any]]",
                                 org.d.get("org_inbox") or [])):
            if row.get("net_id") == entry_id:
                row.pop("last_err", None)
                row.pop("tries", None)
                break
        store.save_org(org)
    return target


def _stamp_skip(slug: str, hub_id: str, err: str) -> None:
    """The drain did NOT attempt these entries — record why anyway, on the
    spool entries AND their org-inbox out rows, so a hub the backoff never
    lets the drain visit still shows its stuck mail (`tries` is untouched:
    no attempt happened). Writes only when the reason CHANGED — the steady
    state costs one save total, not one per pass."""
    from . import store
    err = err[:200]
    with store.DOC_LOCK:
        org = store.load_org(slug)
        entries = (org.d.get("net_spool") or {}).get(hub_id, [])
        if not entries or all(e.get("last_err") == err for e in entries):
            return
        for e in entries:
            e["last_err"] = err
        ids = {str(e.get("id")) for e in entries}
        for row in cast("list[dict[str, Any]]", org.d.get("org_inbox") or []):
            if row.get("net_id") in ids and row.get("last_err") != err:
                row["last_err"] = err
        store.save_org(org)


def _bump_try(slug: str, hub_id: str, entry_id: str, err: str) -> None:
    from . import store
    with store.DOC_LOCK:
        org = store.load_org(slug)
        for e in (org.d.get("net_spool") or {}).get(hub_id, []):
            if e.get("id") == entry_id:
                e["tries"] = int(e.get("tries") or 0) + 1
                e["last_err"] = err[:200]
                # redteam §10 (user-reported "shows sent, hub never saw
                # it"): the failure used to live ONLY here, a structure no
                # payload exposes — copy it onto the org-inbox out row the
                # sender actually reads. A later success clears it
                # (_stamp_row advances the state; the stale reason is
                # removed on the next delivery receipt path via _ship).
                for row in reversed(cast("list[dict[str, Any]]",
                                         org.d.get("org_inbox") or [])):
                    if row.get("net_id") == entry_id:
                        row["tries"] = e["tries"]
                        row["last_err"] = e["last_err"]
                        break
                store.save_org(org)
                return


def _stamp_row(org_d: Any, net_id: str, state: str) -> bool:
    """Advance an org-inbox out row's delivery state (monotonic; tolerant of
    rows trimmed by the 200-cap — a missing row is silently fine)."""
    order = ["queued", "sent", "delivered", "read"]
    rows = cast("list[dict[str, Any]]", org_d.get("org_inbox") or [])
    for row in reversed(rows):
        if row.get("net_id") == net_id:
            cur = str(row.get("state") or "queued")
            if cur in order and order.index(state) > order.index(cur):
                row["state"] = state
                row["state_at"] = now()
                # a delivery that finally lands retires the failure note
                # (§10): the row must not read "sent · last error …"
                row.pop("last_err", None)
                row.pop("tries", None)
                return True
            return False
    return False


def _apply_receipts(slug: str, receipts: list[dict[str, Any]]) -> None:
    from . import store
    if not receipts:
        return
    with store.DOC_LOCK:
        org = store.load_org(slug)
        hit = False
        for r in receipts:
            st = str(r.get("state") or "")
            if st == "fetched":
                st = "sent"          # custody stages collapse into "sent"
            if st in ("sent", "delivered", "read"):
                hit = _stamp_row(org.d, str(r.get("id")), st) or hit
        if hit:
            store.save_org(org)


def _deliver_inbound(slug: str, hub_id: str, msgs: list[dict[str, Any]],
                     addr: str = "",
                     p: dict[str, Any] | None = None) -> list[str]:
    """Deliver polled messages: dedupe on the persisted seen-ring, deliver
    FIRST, record seen, then return the ids to ack. Duplicates never
    double-drive; a crash mid-sequence redelivers, never loses."""
    from . import store, supervisor
    ack: list[str] = []
    for m in msgs:
        mid = str(m.get("id") or "")
        if not mid:
            continue
        with store.DOC_LOCK:
            org = store.load_org(slug)
            ring = (org.d.setdefault("net_state", {})
                    .setdefault(hub_id, {}).setdefault("seen_ids", []))
            seen = mid in ring
        if not seen:
            body = str(m.get("body") or "")
            # F-06 D: fetch attachments to a temp dir; deliver_org_inbox does
            # the per-recipient uploads/ copy + sandbox chown. A fetch failure
            # is NOTED in the body, never a lost message.
            tmp_dir = ""
            att_paths: list[str] = []
            atts = cast("list[dict[str, Any]]", m.get("attachments") or [])
            if atts and addr and p:
                import tempfile
                tmp_dir = tempfile.mkdtemp(prefix=f"net-{mid[:8]}-")
                for a in atts:
                    try:
                        with _client() as c:
                            r = c.get(f"{addr}/api/attachments/{a['id']}",
                                      headers=_auth_header(
                                          [(p["net_slug"], p["secret"])]))
                        if r.status_code != 200:
                            raise RuntimeError(f"HTTP {r.status_code}")
                        name = os.path.basename(
                            str(a.get("name") or "file"))[:255] or "file"
                        dst = os.path.join(tmp_dir, name)
                        with open(dst, "wb") as f:
                            f.write(r.content)
                        att_paths.append(dst)
                    except Exception as ex:                      # noqa: BLE001
                        body += (f"\n[attachment {a.get('name')!r} could not "
                                 f"be fetched from the hub: "
                                 f"{type(ex).__name__}]")
            sent_at = str(m.get("sent_at") or "")
            try:
                import datetime
                dt = datetime.datetime.fromisoformat(
                    sent_at.replace("Z", "+00:00"))
                age = (datetime.datetime.now(datetime.timezone.utc)
                       - dt).total_seconds()
                if age > STALE_AFTER_S:
                    unit = (f"{age / 86400:.1f} days" if age >= 86400
                            else f"{age / 3600:.1f} hours")
                    body = (f"[arrived via the mail hub — sent {sent_at}, "
                            f"{unit} ago; the sender may have moved on]\n\n"
                            + body)
            except ValueError:
                pass
            supervisor.deliver_org_inbox(slug, f"@net:{m.get('from')}", body,
                                         attachments=att_paths or None,
                                         net_id=mid)
            if tmp_dir:
                import shutil
                shutil.rmtree(tmp_dir, ignore_errors=True)
            with store.DOC_LOCK:
                org = store.load_org(slug)
                cell = (org.d.setdefault("net_state", {})
                        .setdefault(hub_id, {}))
                if addr:
                    # the ring is a fact about THIS address (second wave)
                    cell.setdefault("address", addr)
                ring = cell.setdefault("seen_ids", [])
                if mid not in ring:
                    ring.append(mid)
                    del ring[:-SEEN_RING]
                store.save_org(org)
            with _dlv_q_lock:             # redteam ⑤: the sender snapshots
                _dlv_q.append((slug, hub_id, mid))
        ack.append(mid)
    return ack


def _read_hub_of(slug: str, mid: str) -> str | None:
    """Which hub delivered this inbound id? The persisted seen-ring answers —
    redteam ⑥: fanning a read receipt to EVERY hub stamps `read` on any hub
    where an id collides (adversarial-only with uuid ids, but the precise
    route costs nothing). None = evicted from the ring; fall back to fan-out."""
    from . import store
    try:
        org = store.load_org(slug)
        for hid, st in (org.d.get("net_state") or {}).items():
            if mid in (st.get("seen_ids") or []):
                return str(hid)
    except Exception:                                            # noqa: BLE001
        pass
    return None


def _flush_receipts(parts: dict[str, dict[str, Any]]) -> None:
    """Best-effort delivered/read receipts — a failure re-queues; receipts
    never block correspondence."""
    with _read_q_lock:
        reads = list(_read_q)
        _read_q.clear()
    with _dlv_q_lock:
        dlv = list(_dlv_q)
        _dlv_q.clear()
    by_dest: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for slug, hid, mid in dlv:
        by_dest.setdefault((slug, hid), []).append(
            {"id": mid, "state": "delivered", "at": now()})
    for slug, mid in reads:
        # route the read to the hub that DELIVERED the id (seen-ring lookup).
        # An id in NO ring (ring-evicted, or never inbound here) is DROPPED,
        # not fanned out — redteam ⑥ constructed a same-id message on a second
        # hub that a fan-out stamps `read` although nobody read it. Receipts
        # are best-effort by spec; the far end honestly keeps `delivered`.
        owner = _read_hub_of(slug, mid)
        if owner is None:
            continue
        by_dest.setdefault((slug, owner), []).append(
            {"id": mid, "state": "read", "at": now()})
    for (slug, hid), recs in by_dest.items():
        p = parts.get(slug)
        if not p:
            continue
        addr = next((str(h["address"]) for h in p["hubs"]
                     if str(h["id"]) == hid), None)
        if not addr:
            continue
        try:
            with _client() as c:
                c.post(f"{addr}/api/receipts", json={"receipts": recs},
                       headers=_auth_header([(p["net_slug"], p["secret"])]))
            # the recipient's own out-rows don't change here; sender-side
            # states arrive via the poll's receipts
        except Exception:                                        # noqa: BLE001
            with _read_q_lock:
                _read_q.extend((slug, str(r["id"])) for r in recs
                               if r["state"] == "read")
            with _dlv_q_lock:
                _dlv_q.extend((slug, hid, str(r["id"])) for r in recs
                              if r["state"] == "delivered")


def _sender_loop() -> None:
    from . import store
    rev = -1
    parts: dict[str, dict[str, Any]] = {}
    while True:
        _kick.wait(2.0)
        _kick.clear()
        try:
            if store.REVISION != rev:
                rev = store.REVISION
                parts = _participants()
            _register_pending(parts)
            # spool counts move under our feet — refresh cheaply each pass
            parts = {**parts}
            _drain_spools(_participants() if _kick.is_set() else parts)
            _flush_receipts(parts)
        except Exception:                                        # noqa: BLE001
            pass


def _poller_loop() -> None:
    from . import store
    rev = -1
    parts: dict[str, dict[str, Any]] = {}
    while True:
        try:
            if store.REVISION != rev:
                rev = store.REVISION
                parts = _participants()
            if not _poll_pass(parts):
                time.sleep(2.0)
        except Exception:                                        # noqa: BLE001
            time.sleep(2.0)


def _poll_pass(parts: dict[str, dict[str, Any]]) -> bool:
    """One sweep over every hub-address group: long-poll, deliver, ack, apply
    receipts. Split out of the loop so a test (or the smoke) can drive exactly
    one pass. Returns False when there was nothing to poll."""
    groups = _groups(parts)
    if not groups:
        return False
    for addr, members in groups.items():
        # only poll registered members (auth would 401 otherwise —
        # registration is the sender loop's job)
        pairs = [(parts[s]["net_slug"], parts[s]["secret"])
                 for s in members if parts[s]["registered"]
                 .get(members[s])]
        if not pairs:
            time.sleep(1.0)
            continue
        if time.monotonic() < _backoff.get(addr, 0.0):
            time.sleep(1.0)
            continue
        by_net = {parts[s]["net_slug"]: s for s in members}
        try:
            with _poll_client() as c:
                r = c.post(f"{addr}/api/poll",
                           params={"wait": POLL_WAIT_S},
                           headers=_auth_header(pairs))
        except Exception as e:                                   # noqa: BLE001
            _fail(addr)
            for s, hid in members.items():
                _set_status(s, hid, False, type(e).__name__)
            continue
        if r.status_code != 200:
            _fail(addr)
            for s, hid in members.items():
                _set_status(s, hid, False, f"HTTP {r.status_code}")
            if r.status_code == 401:
                # the hub does not know us — clear the durable flag so the
                # register loop re-registers next pass (see _clear_registration)
                for s, hid in members.items():
                    _clear_registration(s, hid)
            continue
        _ok(addr)
        data = cast("dict[str, Any]", r.json())
        _record_hub_name(addr, data.get("name"), parts, dict(members))
        with _status_lock:
            _rosters[addr] = list(
                cast("list[dict[str, Any]]", data.get("roster") or []))
        for s, hid in members.items():
            if parts[s]["registered"].get(hid):
                _set_status(s, hid, True)
        by_org: dict[str, list[dict[str, Any]]] = {}
        for m in cast("list[dict[str, Any]]", data.get("messages") or []):
            local = by_net.get(str(m.get("to") or ""))
            if local:
                by_org.setdefault(local, []).append(m)
        for s, msgs in by_org.items():
            hid = members[s]
            ack = _deliver_inbound(s, hid, msgs, addr=addr, p=parts[s])
            if ack:
                try:
                    with _client() as c:
                        c.post(f"{addr}/api/ack", json={"ids": ack},
                               headers=_auth_header(
                                   [(parts[s]["net_slug"],
                                     parts[s]["secret"])]))
                except Exception:                                # noqa: BLE001
                    pass               # unacked → redelivered → seen-ring
        by_receipt: dict[str, list[dict[str, Any]]] = {}
        for rc in cast("list[dict[str, Any]]",
                       data.get("receipts") or []):
            # receipts belong to the SENDER side: route each to the org
            # whose outbound row carries the id — we don't know which, so
            # offer to all members (missing rows are fine)
            for s in members:
                by_receipt.setdefault(s, []).append(rc)
        for s, recs in by_receipt.items():
            _apply_receipts(s, recs)
    return True


def start_net_client() -> None:
    """Start the sender + poller daemons (api._wire_notify). Idempotent."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_sender_loop, daemon=True,
                     name="net-sender").start()
    threading.Thread(target=_poller_loop, daemon=True,
                     name="net-poller").start()
