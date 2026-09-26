"""@net: Phase C — the transport, attacked.

Phase C is the first part of orgtree that keeps state on BOTH sides of a
network: a spool here, a queue there, and two clocks. Every interesting failure
is therefore a state that only one side believes in — a message spooled under a
hub id nobody visits, an id evicted from a dedupe ring that the far end still
holds, a receipt flushed to a hub that never saw the message. None of those
raise; they just sit there looking like "queued".

So this suite is written from the failure end. It drives the REAL client
functions (`_poll_pass`, `_register_pending`, `_drain_spools`, `_flush_receipts`)
against the REAL hub app over an in-process sync ASGI bridge, and then asks the
question the happy path never does: after this, is there anything left that
nobody will ever pick up?

    §1  the ladder — register → send → deliver → ack → receipts, in one pass
    §2  spool routing — which hub id an outbound is filed under, and who visits
    §3  the seen-ring — duplicate collapse, and what falls off the end
    §4  receipts — both directions, and what a receipt does to the WRONG hub
    §5  failure handling — backoff, retries, and what a dead hub costs
    §6  the secret — headers only, never a URL, never a payload, never a log
    §7  the user's own compose surface — staging, refusals, and leftovers
    §8  the second wave — A/B/C re-attacked with D+E+F underneath them

Hermetic: two in-process hubs on throwaway data dirs, no socket, no thread
(the daemons are never started — every pass is driven by hand).

    python backend/tests/test_net_transport.py [-v]
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import traceback

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, ".."))
# ⚠ FORCE this worktree's engine + pinned hub ahead of everything: an
# installed Orgtree can shadow `orgtree` via the machine's default path.
sys.path.insert(0, os.path.join(_REPO, "engine", "mailhub"))
sys.path.insert(0, os.path.join(_REPO, "engine", "backend"))

_TMP = tempfile.mkdtemp(prefix="orgtree-nettr-")
os.environ["ORGTREE_DATA"] = os.path.join(_TMP, "data")

# ⚠ a throwaway ORGTREE_DATA does NOT isolate the MAIL HUB: net._default_address
# falls back to net.DEFAULT_HUB_ADDRESS — the operator's real hub — when this
# root has no defaults.json, and any rig that starts the net daemon then
# registers its fixture orgs there permanently. Measured twice (user report
# 2026-08-06; ~45 fixture orgs again on 2026-08-10). The discard port refuses
# instantly, so registration fails harmlessly into the backoff.
# Guarded over this whole directory by test_external_mail §1.
os.makedirs(os.environ["ORGTREE_DATA"], exist_ok=True)
with open(os.path.join(os.environ["ORGTREE_DATA"], "defaults.json"), "w",
          encoding="utf-8") as _f:
    _f.write('{"net_hub_address": "http://127.0.0.1:9"}')

os.environ["USERPROFILE"] = os.environ["HOME"] = os.path.join(_TMP, "home")
os.makedirs(os.environ["HOME"], exist_ok=True)
os.environ["ORGTREE_STEER_HOOK"] = "0"
os.environ["HUB_DATA"] = os.path.join(_TMP, "hubA")     # read at import
os.environ["HUB_NAME"] = "hub-a"

import httpx                                                     # noqa: E402
from mailhub import app as hubapp, db as hubdb                   # noqa: E402

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, net, store, supervisor                  # noqa: E402
from orgtree.ledger import LedgerError, MCP_RETIRED, USER        # noqa: E402

hubapp.print = lambda *a, **k: None            # the hub's per-request log line

PASS = 0
FAIL: list[tuple[str, str]] = []
GAPS: list[tuple[str, str, str]] = []
VERBOSE = "-v" in sys.argv
ALL_TOOLS = {"bash": True, "web": True, "edit": True, "subagents": True, "mcp": []}


def check(label, fn) -> None:
    global PASS
    try:
        fn()
    except Exception:                                            # noqa: BLE001
        FAIL.append((label, traceback.format_exc()))
        print(f"  FAIL     {label}")
        return
    PASS += 1
    print(f"  ok {PASS:3d}  {label}")


def fixture(ok, msg) -> None:
    """A PRECONDITION inside a gap body — raised as a RuntimeError so `gap`
    below re-reports it as a broken check instead of swallowing it as the
    finding.

    ⚠ Learned the expensive way (2026-08-06, test_batched_asks). A gap
    body's whole contract is "this assert fails", so a fixture assert and the
    assert that measures the defect are indistinguishable: gap() catches the
    first AssertionError it meets and files it as the finding. A credit
    request for 8 against a grant of 20 took the at-or-below no-op branch, so
    no row ever existed — the gap fired on its own scaffolding while the
    defect it named was real but unexercised. Use fixture(...) for every setup
    precondition in a gap body; keep a bare `assert` for the property under
    test."""
    if not ok:
        raise RuntimeError(f"fixture: {msg}")


def gap(label, why, fn) -> None:
    """Inverted expectation (see test_rename.py): asserts the SAFE property,
    is expected to FAIL today, keeps the suite green, and turns RED the day it
    is fixed."""
    global PASS
    try:
        fn()
    except AssertionError as e:
        GAPS.append((label, why, str(e).split("\n")[0][:300]))
        print(f"  ⚑ GAP    {label}")
        return
    except Exception:                                            # noqa: BLE001
        FAIL.append((label + " (gap check errored)", traceback.format_exc()))
        print(f"  FAIL     {label} — the gap check itself broke")
        return
    PASS += 1
    print(f"  ok {PASS:3d}  {label}  ← FIXED: promote out of gap()")


# ─────────────────────────────────────────────────────── the in-process hubs
HUB_A, HUB_B = "http://hub-a.test", "http://hub-b.test"
_HUB_DIRS = {"hub-a.test": os.path.join(_TMP, "hubA"),
             "hub-b.test": os.path.join(_TMP, "hubB")}
_HUB_NAMES = {"hub-a.test": "hub-a", "hub-b.test": "hub-b"}
SENT_URLS: list[str] = []          # every URL the client requested
SENT_HEADERS: list[dict] = []      # …and its headers, for the §6 sweep


class _SyncASGI(httpx.BaseTransport):
    """httpx's ASGITransport is async-only, and the sync Client asserts a
    SyncByteStream — so the response is read to completion and rebuilt. Also
    the hub FLEET switch: mailhub.db resolves its paths from module globals,
    so pointing them at this request's host is what makes two hubs possible in
    one process (requests here are sequential by construction)."""

    def __init__(self) -> None:
        self.inner = httpx.ASGITransport(app=hubapp.app)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        data_dir = _HUB_DIRS[host]
        hubdb.DATA_DIR = data_dir
        hubdb.DB_PATH = os.path.join(data_dir, "hub.sqlite3")
        hubdb.BLOB_DIR = os.path.join(data_dir, "blobs")
        hubapp.HUB_NAME = _HUB_NAMES[host]
        SENT_URLS.append(str(request.url))
        SENT_HEADERS.append(dict(request.headers))
        body = request.read()

        async def go() -> tuple[int, list[tuple[bytes, bytes]], bytes]:
            req = httpx.Request(request.method, request.url,
                                headers=request.headers, content=body)
            resp = await self.inner.handle_async_request(req)
            out = b"".join([c async for c in resp.aiter_raw()])
            await resp.aclose()
            drop = (b"content-length", b"transfer-encoding", b"content-encoding")
            hdrs = [(k, v) for k, v in resp.headers.raw if k.lower() not in drop]
            return resp.status_code, hdrs, out

        code, hdrs, out = asyncio.run(go())
        return httpx.Response(code, headers=hdrs, content=out)


def _mk_client(**_kw) -> httpx.Client:
    return httpx.Client(transport=_SyncASGI(), timeout=5.0)


net._client = _mk_client                       # type: ignore[assignment]
net._poll_client = _mk_client                  # type: ignore[assignment]
net.POLL_WAIT_S = 0.0                          # no long poll in a test
supervisor.chatq_register_org = lambda slug: None
supervisor.chatq_deregister_org = lambda slug: None
supervisor.storage_check = lambda slug: None
supervisor.send_message = lambda *a, **k: {"accepted": True}   # never drive a CLI

_n = [0]


def spec(**over):
    s = dict(add_dirs=[], tools=dict(ALL_TOOLS), org_visibility="team",
             charter="net transport test")
    s.update(over)
    return s


def mkorg(hubs=(HUB_A,), tops=("ceo",), autoconnect=False):
    """A saved org with an identity, the given hub addresses, and holders."""
    _n[0] += 1
    org = store.create_org(f"zz net {_n[0]}")
    slug = org.d["slug"]
    net.mint_identity(org)
    org.d["net_autoconnect"] = autoconnect
    org.d["net_hubs"] = net.hub_entries(autoconnect, list(hubs))
    for t in tops:
        org.hire(USER, None, "haiku", 5, t, **spec())
        org.audience_grant(USER, t, "extern")
    store.save_org(org)
    return slug


def parts_for(*slugs):
    p = net._participants()
    return {s: p[s] for s in slugs if s in p}


def net_slug(slug):
    return str(store.load_org(slug).d["net_identity"]["slug"])


def hub_ids(slug):
    return [str(h["id"]) for h in store.load_org(slug).d["net_hubs"]]


def spool_of(slug):
    return {k: list(v) for k, v in
            (store.load_org(slug).d.get("net_spool") or {}).items() if v}


def ladder(*slugs, passes=1):
    """Register everyone, drain outbound, poll+deliver, flush receipts."""
    for _ in range(passes):
        p = parts_for(*slugs)
        net._register_pending(p)
        p = parts_for(*slugs)          # registration flags are in the doc
        net._drain_spools(p)
        net._poll_pass(p)
        net._flush_receipts(p)


def send_net(slug, sender, to_net_slug, body="hello over the wire"):
    """The real outbound path: an org-inbox row plus a spool entry, exactly as
    api.py's agent dispatch stages it."""
    org = store.load_org(slug)
    r = org.post_mail(sender, f"@net:{to_net_slug}", body)
    oid = org.d["org_inbox"][-1]["id"]
    # ⚠ the BARE network slug — api.py passes `to[5:]`, and the spool entry's
    # `to` goes straight onto the wire, where the hub matches it against
    # orgs.slug. Passing the prefixed form here spools an address the hub can
    # never resolve (measured: an eternal 422 retry loop). See the gap in §2.
    mid = net.spool_append(org, to_net_slug, body, oid)
    store.save_org(org)
    return mid, r


def inbox_rows(slug, direction="in"):
    return [r for r in (store.load_org(slug).d.get("org_inbox") or [])
            if r.get("dir") == direction]


# ══════════════════════════════════════════════════════════════════════ §1
def sec_ladder() -> None:
    net._backoff.clear()   # process-global: a previous section's dead hub must not mute this one
    print("\n§1  the ladder — one pass, end to end")

    def _round_trip():
        a, b = mkorg(), mkorg()
        mid, _ = send_net(a, "ceo", net_slug(b), "ping")
        ladder(a, b)
        got = inbox_rows(b, "in")
        assert got and got[-1]["body"] == "ping", got
        assert got[-1]["peer"] == f"@net:{net_slug(a)}", got[-1]
        assert not spool_of(a), f"the spool must be empty after custody: {spool_of(a)}"
        row = [r for r in inbox_rows(a, "out") if r.get("net_id") == mid][0]
        assert row["state"] in ("sent", "delivered", "read"), row
    check("a message crosses and the sender's row advances past 'queued'",
          _round_trip)

    def _delivered_receipt():
        a, b = mkorg(), mkorg()
        mid, _ = send_net(a, "ceo", net_slug(b), "receipt me")
        ladder(a, b, passes=3)      # deliver, flush delivered, poll it back
        row = [r for r in inbox_rows(a, "out") if r.get("net_id") == mid][0]
        assert row["state"] == "delivered", row
    check("the recipient's delivery reaches the sender as a receipt",
          _delivered_receipt)

    def _read_receipt():
        a, b = mkorg(), mkorg()
        mid, _ = send_net(a, "ceo", net_slug(b), "read me")
        ladder(a, b, passes=2)
        net.note_read(b, [mid])
        ladder(a, b, passes=3)
        row = [r for r in inbox_rows(a, "out") if r.get("net_id") == mid][0]
        assert row["state"] == "read", row
    check("a read receipt from the consuming turn reaches the sender",
          _read_receipt)

    def _registration_persists():
        a = mkorg()
        ladder(a)
        st = store.load_org(a).d.get("net_state") or {}
        hid = hub_ids(a)[0]
        assert (st.get(hid) or {}).get("registered_at"), st
        assert net._status.get((a, hid), {}).get("connected") is True
    check("registration is persisted and the status dot goes green",
          _registration_persists)

    def _hub_name_discovered():
        a = mkorg()
        ladder(a)
        h = store.load_org(a).d["net_hubs"][0]
        assert h.get("name") == "hub-a", (
            f"this org's hub entry never learned the hub's name: {h}. "
            f"_record_hub_name returns early when the name is already in the "
            f"process-global _hub_names cache, so only the FIRST org to "
            f"connect to an address gets `name` written onto its entry")
    # PROMOTED from gap() 2026-08-05: _record_hub_name now compares against
    # THIS org's entry, so every participant's doc learns the name — not only
    # the first one to reach the address. The doc is what survives a restart,
    # and status_block's cache fallback used to hide the difference.
    check("every org's hub entry learns the hub's name, not just the first",
          _hub_name_discovered)


# ══════════════════════════════════════════════════════════════════════ §2
def sec_spool_routing() -> None:
    net._backoff.clear()   # process-global: a previous section's dead hub must not mute this one
    print("\n§2  spool routing — who files it, and who ever visits")

    def _picks_the_enabled_remote():
        # local DISABLED, one remote enabled: the entry must be filed under the
        # REMOTE's id, not under 'local'
        a = mkorg(hubs=(HUB_A,), autoconnect=True)
        org = store.load_org(a)
        for h in org.d["net_hubs"]:
            if h["id"] == net.LOCAL_HUB_ID:
                h["enabled"] = False
        store.save_org(org)
        remote = [h["id"] for h in store.load_org(a).d["net_hubs"]
                  if h["id"] != net.LOCAL_HUB_ID][0]
        b = mkorg()
        send_net(a, "ceo", net_slug(b))
        assert list(spool_of(a)) == [remote], spool_of(a)
    check("a disabled local hub is not chosen as the spool destination",
          _picks_the_enabled_remote)

    def _no_enabled_hub_refused():
        # promoted from gap() 2026-08-05: spool_append (and both api.py call
        # sites, doorside) now REFUSE when no hub is enabled — the old
        # LOCAL_HUB_ID fallback filed the entry under an id no drain visits,
        # a "queued" that never left and never errored
        a = mkorg(hubs=(), autoconnect=False)
        assert store.load_org(a).d["net_hubs"] == [], "precondition: no hubs"
        b = mkorg()
        org = store.load_org(a)
        try:
            net.spool_append(org, net_slug(b), "into the void", "oid-x")
            raise AssertionError("a send with no enabled hub must refuse")
        except LedgerError as e:
            assert "no mailserver" in str(e), e
        assert not spool_of(a), "the refusal must spool nothing"
    check("a send with no reachable hub is refused at the door",
          _no_enabled_hub_refused)

    def _hub_replaced_mid_life():
        # the settings edit the implementer asked about: net_hubs is REPLACED
        # (new ids), and anything already spooled is keyed under the old id
        a, b = mkorg(), mkorg()
        send_net(a, "ceo", net_slug(b), "before the edit")
        old_id = list(spool_of(a))[0]
        org = store.load_org(a)
        org.d["net_hubs"] = net.hub_entries(False, [HUB_A])   # fresh uuid id
        store.save_org(org)
        new_id = hub_ids(a)[0]
        assert new_id != old_id, "precondition: the edit re-minted the id"
        ladder(a, b, passes=2)
        assert not spool_of(a), (
            f"a queued message stayed under the RETIRED hub id {old_id!r} "
            f"after the hub list was replaced with {new_id!r}: "
            f"{spool_of(a)}. It is now unreachable — the drain only visits "
            f"ids that are in net_hubs")
    # promoted from gap() 2026-08-05: fixed at BOTH layers — the settings
    # write reuses ids by address and re-keys orphans, and _participants
    # SELF-HEALS spool keys the org no longer has (covers direct doc edits
    # like this one), moving entries to the first enabled hub
    check("replacing the hub list does not strand what is already spooled",
          _hub_replaced_mid_life)

    def _two_hubs_one_spool_each():
        a = mkorg(hubs=(HUB_A, HUB_B))
        b = mkorg(hubs=(HUB_A,))
        send_net(a, "ceo", net_slug(b), "which hub?")
        assert list(spool_of(a)) == [hub_ids(a)[0]], (
            "with two enabled hubs the entry goes to the FIRST — deliberate "
            "(hub-agnostic addressing), pinned so a change is a decision")
    check("with several hubs the first enabled one carries the message",
          _two_hubs_one_spool_each)


# ══════════════════════════════════════════════════════════════════════ §3
def sec_seen_ring() -> None:
    net._backoff.clear()   # process-global: a previous section's dead hub must not mute this one
    print("\n§3  the seen-ring — collapse, and the far edge")

    def _duplicate_collapses():
        a, b = mkorg(), mkorg()
        send_net(a, "ceo", net_slug(b), "exactly once")
        ladder(a, b)
        before = len(inbox_rows(b, "in"))
        # re-queue the SAME hub message: the hub redelivers an unacked message,
        # and a lost ack is the normal way this happens
        p = parts_for(b)
        hid = hub_ids(b)[0]
        con = hubdb.connect()
        try:
            con.execute("UPDATE messages SET state='queued', fetched_at=NULL")
            con.commit()
        finally:
            con.close()
        net._poll_pass(p)
        assert len(inbox_rows(b, "in")) == before, (
            "a redelivered message was delivered to the org twice")
    check("a redelivered message is collapsed by the seen-ring",
          _duplicate_collapses)

    def _ring_is_bounded():
        a = mkorg()
        org = store.load_org(a)
        hid = hub_ids(a)[0]
        ring = (org.d.setdefault("net_state", {})
                .setdefault(hid, {}).setdefault("seen_ids", []))
        ring.extend(f"m{i}" for i in range(net.SEEN_RING + 50))
        del ring[:-net.SEEN_RING]
        store.save_org(org)
        got = (store.load_org(a).d["net_state"][hid]["seen_ids"])
        assert len(got) == net.SEEN_RING and got[0] == "m50", got[:2]
    check(f"the ring keeps the newest {net.SEEN_RING} ids", _ring_is_bounded)

    def _eviction_is_a_redelivery_window():
        # OPEN QUESTION, measured: an id evicted from the ring is no longer a
        # duplicate to us. The hub keeps a message for RETENTION_DAYS (30) and
        # redelivers until acked, so the window is real but narrow: it needs
        # SEEN_RING newer messages from the SAME hub between the delivery and
        # the redelivery, i.e. a lost ack plus 500 messages.
        a, b = mkorg(), mkorg()
        send_net(a, "ceo", net_slug(b), "the ancient one")
        ladder(a, b)
        org = store.load_org(b)
        hid = hub_ids(b)[0]
        ring = org.d["net_state"][hid]["seen_ids"]
        assert len(ring) == 1
        ring[:] = [f"newer{i}" for i in range(net.SEEN_RING)]   # evicted
        store.save_org(org)
        before = len(inbox_rows(b, "in"))
        con = hubdb.connect()
        try:
            con.execute("UPDATE messages SET state='queued', fetched_at=NULL")
            con.commit()
        finally:
            con.close()
        net._poll_pass(parts_for(b))
        # PG-3f: the delivery carries op_key net:<hub>:<id>, so an id the
        # ring has forgotten still finds its org_tx receipt and REPLAYS
        # (nothing posted twice) — for as long as the receipt is kept
        assert len(inbox_rows(b, "in")) == before, (
            "an id evicted from the ring was delivered again although its "
            "delivery receipt still exists — re-read this check")
        note = (f"an id evicted from the {net.SEEN_RING}-entry ring is no "
                f"longer delivered again while its delivery receipt exists: "
                f"durable on PostgreSQL, in process memory only on the SQLite "
                f"and JSON stores (a restart reopens the window there; hub "
                f"retention is {hubapp.RETENTION_DAYS} days).")
        GAPS.append(("the seen-ring's far edge is a redelivery window on the "
                     "SQLite/JSON stores after a restart",
                     "DESIGN QUESTION, not a defect: at-least-once plus a "
                     "bounded ring means duplicates are possible by "
                     "construction; the op_key receipt closes it wherever "
                     "receipts are durable. The alternative is a persisted "
                     "high-water mark per hub (received_at is monotonic on "
                     "the hub side) instead of a set of ids.", note))
        print("  ⚑ GAP    the seen-ring's far edge (SQLite/JSON, after a restart)")
    check("(measuring the ring's far edge)", _eviction_is_a_redelivery_window)


# ══════════════════════════════════════════════════════════════════════ §4
def sec_receipts() -> None:
    net._backoff.clear()   # process-global: a previous section's dead hub must not mute this one
    print("\n§4  receipts — the right hub, and the wrong one")

    def _wrong_hub_is_a_noop():
        # v1 flushes READ receipts to every enabled hub. The implementer's
        # question: on a hub that holds a DIFFERENT message with the same id,
        # is the no-op really a no-op? Client-minted ids make this adversarial
        # only — so it is constructed by hand.
        a = mkorg(hubs=(HUB_A, HUB_B))
        b = mkorg(hubs=(HUB_A,))
        c = mkorg(hubs=(HUB_B,))
        mid, _ = send_net(a, "ceo", net_slug(b), "the real one")
        ladder(a, b, passes=2)
        # plant a COLLIDING id on hub B, addressed to a's own net slug
        p = parts_for(a, c)
        net._register_pending(p)
        con_dir = _HUB_DIRS["hub-b.test"]
        hubdb.DATA_DIR = con_dir
        hubdb.DB_PATH = os.path.join(con_dir, "hub.sqlite3")
        hubdb.BLOB_DIR = os.path.join(con_dir, "blobs")
        con = hubdb.connect()
        try:
            con.execute(
                "INSERT OR REPLACE INTO messages (id, from_slug, to_slug, "
                "body, received_at, state) VALUES (?,?,?,?,?,'queued')",
                (mid, net_slug(c), net_slug(a), "the impostor", "2026-01-01"))
            con.commit()
        finally:
            con.close()
        net.note_read(a, [mid])         # a's turn consumed ITS message
        net._flush_receipts(parts_for(a))
        hubdb.DATA_DIR = con_dir
        hubdb.DB_PATH = os.path.join(con_dir, "hub.sqlite3")
        con = hubdb.connect()
        try:
            row = con.execute("SELECT read_at, to_slug FROM messages WHERE id=?",
                              (mid,)).fetchone()
        finally:
            con.close()
        assert row is not None, "the planted row vanished — re-read the setup"
        assert row["read_at"] is None, (
            "a message on hub B was stamped READ because it happens to share "
            "an id with one the org read on hub A: the hub's guard is "
            "`to_slug IN (my slugs)` and the impostor IS addressed to me, so "
            "nothing on the hub side can tell the two apart")
    # promoted from gap() 2026-08-05: reads now route to the hub whose
    # seen-ring holds the id; an id in NO ring (evicted, or never inbound) is
    # DROPPED rather than fanned out — receipts are best-effort by spec, so
    # the far end honestly keeps `delivered` and cross-hub stamping is
    # impossible even at the ring's far edge
    check("a read receipt cannot stamp an unrelated message on another hub",
          _wrong_hub_is_a_noop)

    def _delivered_queue_has_no_lock():
        # ⚠ THE FIRST VERSION OF THIS CHECK PASSED VACUOUSLY: it looked for a
        # `with … lock` in the 120 characters before the snapshot and found
        # the `with _read_q_lock:` block three lines ABOVE, which guards the
        # OTHER queue. A guard that can be satisfied by its neighbour measures
        # nothing — so the requirement is now a lock that can only be this
        # queue's, named for it.
        src = io.open(os.path.join(_REPO, "engine", "backend", "orgtree", "net.py"),
                      encoding="utf-8").read()
        assert "_dlv_q_lock" in src, (
            "_flush_receipts snapshots and clears _dlv_q with no lock of its "
            "own while _deliver_inbound appends to it from the poller thread "
            "(net.py:654) — an append landing between `dlv = list(_dlv_q)` "
            "and `_dlv_q.clear()` is dropped. Its sibling _read_q takes "
            "_read_q_lock for exactly this reason")
        body = src[src.index("def _flush_receipts"):src.index("def _sender_loop")]
        i = body.index("dlv = list(_dlv_q)")
        assert "_dlv_q_lock" in body[max(0, i - 120):i],             "the lock exists but is not taken around the snapshot"
    # promoted from gap() 2026-08-05: _dlv_q now has its OWN _dlv_q_lock,
    # taken at the poller's append, the sender's snapshot+clear, and the
    # failure re-queue
    check("the delivered-receipt queue is locked like its read sibling",
          _delivered_queue_has_no_lock)

    def _receipts_requeue_on_failure():
        a, b = mkorg(), mkorg()
        mid, _ = send_net(a, "ceo", net_slug(b), "flush fails")
        ladder(a, b)
        net.note_read(b, [mid])
        real = net._client

        def boom(**_kw):
            raise RuntimeError("hub unreachable")
        net._client = boom                       # type: ignore[assignment]
        try:
            net._flush_receipts(parts_for(b))
        finally:
            net._client = real                   # type: ignore[assignment]
        with net._read_q_lock:
            assert any(m == mid for _s, m in net._read_q), (
                "a failed flush dropped the read receipt instead of re-queuing")
        net._flush_receipts(parts_for(b))
        with net._read_q_lock:
            net._read_q.clear()
    check("a failed receipt flush re-queues instead of losing the receipt",
          _receipts_requeue_on_failure)


# ══════════════════════════════════════════════════════════════════════ §5
def sec_failure() -> None:
    print("\n§5  failure handling — what a dead hub actually costs")

    def _backoff_grows():
        net._backoff.clear()
        a = mkorg(hubs=("http://dead.test",))
        _HUB_DIRS["dead.test"] = os.path.join(_TMP, "dead")   # never registered
        real = net._client

        def boom(**_kw):
            raise RuntimeError("connection refused")
        net._client = boom                       # type: ignore[assignment]
        waits = []
        try:
            import time as _t
            for _ in range(4):
                # simulate the window EXPIRING between attempts (pop the
                # deadline, keep the per-address failure counter) — without
                # this the register pass skips the address and no attempt is
                # ever measured
                net._backoff.pop("http://dead.test", None)
                before = _t.monotonic()
                net._register_pending(parts_for(a))
                waits.append(round(net._backoff.get("http://dead.test", 0.0)
                                   - before, 2))
        finally:
            net._client = real                   # type: ignore[assignment]
        assert waits == sorted(waits) and waits[-1] > waits[0], (
            f"the backoff never grows for a hub that keeps failing: {waits}")
        net._backoff.pop("http://dead.test", None)
        net._backoff_n.pop("http://dead.test", None)
    # promoted from gap() 2026-08-05: _fail() keeps a consecutive-failure
    # count PER ADDRESS (2^n, capped) and _ok() resets it — the old formula
    # counted how many ADDRESSES had ever failed, so a dead hub retried at a
    # flat ~2-4 s forever
    check("a repeatedly failing hub is retried less and less often",
          _backoff_grows)

    def _unknown_recipient_keeps_retrying():
        a = mkorg()
        org = store.load_org(a)
        r = org.post_mail("ceo", "@net:nobody.here.abcdef", "into the dark")
        oid = org.d["org_inbox"][-1]["id"]
        net.spool_append(org, "@net:nobody.here.abcdef", "into the dark", oid)
        store.save_org(org)
        ladder(a, passes=2)
        left = spool_of(a)
        assert left, "an unknown recipient must be RETAINED, not dropped"
        e = list(left.values())[0][0]
        assert int(e.get("tries") or 0) >= 1 and e.get("last_err"), e
        assert "no org registered" in str(e["last_err"]).lower(), e["last_err"]
        _ = r
    check("mail to an unregistered peer is retained with the reason recorded",
          _unknown_recipient_keeps_retrying)

    def _hub_5xx_marks_disconnected():
        a = mkorg()
        ladder(a)
        assert net._status[(a, hub_ids(a)[0])]["connected"] is True
        real = net._poll_client

        def boom(**_kw):
            raise RuntimeError("hub fell over")
        net._poll_client = boom                  # type: ignore[assignment]
        try:
            net._poll_pass(parts_for(a))
        finally:
            net._poll_client = real              # type: ignore[assignment]
        st = net._status[(a, hub_ids(a)[0])]
        assert st["connected"] is False and st["error"], st
        assert st["last_ok"], "the last good time must survive the failure"
    check("a hub that stops answering flips the status dot and keeps last_ok",
          _hub_5xx_marks_disconnected)


# ══════════════════════════════════════════════════════════════════════ §6
def sec_secret() -> None:
    net._backoff.clear()   # process-global: a previous section's dead hub must not mute this one
    print("\n§6  the secret — one carrier, and no copies")

    def _headers_only():
        a, b = mkorg(), mkorg()
        send_net(a, "ceo", net_slug(b), "watch the wire")
        SENT_URLS.clear()
        SENT_HEADERS.clear()
        ladder(a, b, passes=2)
        secret = store.load_org(a).d["net_identity"]["secret"]
        assert SENT_URLS, "nothing was sent — the check would pass vacuously"
        for u in SENT_URLS:
            assert secret not in u, f"THE SECRET RODE IN A URL: {u}"
        carried = [h for h in SENT_HEADERS if secret in json.dumps(h)]
        assert carried, "the secret never rode at all — re-read the harness"
        for h in carried:
            assert secret in h.get("x-org-auth", ""), (
                f"the secret appeared in a header other than x-org-auth: "
                f"{[k for k, v in h.items() if secret in str(v)]}")
    check("the secret rides X-Org-Auth only — never a URL, never another header",
          _headers_only)

    def _not_in_the_tree_payload():
        a = mkorg()
        ladder(a)
        blob = json.dumps(store.load_org(a).tree())
        d = store.load_org(a).d["net_identity"]
        assert d["secret"] not in blob and d["fingerprint"] not in blob
        block = net.status_block(store.load_org(a).d)
        assert block is not None and json.dumps(block).find(d["secret"]) < 0
        assert d["fingerprint"] not in json.dumps(block), (
            "the status block carries the full fingerprint — the 6-char "
            "suffix baked into the slug is the only identity material a "
            "payload should hold")
    check("neither the tree payload nor the status block carries it",
          _not_in_the_tree_payload)

    def _not_in_an_agents_context():
        a, b = mkorg(), mkorg()
        send_net(a, "ceo", net_slug(b), "inbound with a secret nearby")
        ladder(a, b)
        secret_b = store.load_org(b).d["net_identity"]["secret"]
        rows = inbox_rows(b, "in")
        mail = (store.load_org(b).d.get("mail") or {}).get("ceo") or []
        blob = json.dumps(rows) + json.dumps(mail)
        assert secret_b not in blob, "the org's own secret reached an agent's mail"
        assert "@net:" in json.dumps(rows), "…and the peer address did arrive"
    check("an agent's mail never carries its org's network secret",
          _not_in_an_agents_context)


# ══════════════════════════════════════════════════════════════════════ §7
def api_call(app, method, path, body=None, content=None, params=b""):
    """One request against the admin app with a hand-built scope."""
    payload = content if content is not None else (
        b"" if body is None else json.dumps(body).encode())
    hdrs = [(b"host", b"127.0.0.1:7411")]
    if payload:
        hdrs += [(b"content-type", b"application/json"),
                 (b"content-length", str(len(payload)).encode())]
    st, chunks = [0], []

    async def receive():
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.start":
            st[0] = msg["status"]
        elif msg["type"] == "http.response.body":
            chunks.append(msg.get("body", b""))

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
             "method": method, "scheme": "http", "path": path,
             "raw_path": path.encode(), "query_string": params,
             "root_path": "", "headers": hdrs,
             "client": ("127.0.0.1", 5), "server": ("127.0.0.1", 7411)}
    try:
        asyncio.run(app(scope, receive, send))
    except Exception as e:                                       # noqa: BLE001
        st[0] = st[0] or 500
        chunks.append(f"{type(e).__name__}: {e}".encode())
    raw = b"".join(chunks)
    try:
        return st[0], json.loads(raw)
    except Exception:                                            # noqa: BLE001
        return st[0], raw.decode("utf-8", "replace")


def stage_dir():
    return os.path.join(store.DATA_ROOT, api._COMPOSE_DIR)


def sec_compose() -> None:
    print("\n§7  the user's compose surface — staging, refusals, leftovers")
    net._backoff.clear()

    def upload(slug, data=b"a plan", name="plan.md"):
        return api_call(api.app, "POST", f"/api/orgs/{slug}/org_inbox/upload",
                        content=data, params=f"name={name}".encode())

    def _upload_stages_a_file():
        a = mkorg()
        code, j = upload(a)
        assert code == 200 and j["bytes"] == 6, (code, j)
        assert j["name"] == "plan.md", j
        owner, path = api._COMPOSE_STAGE[j["id"]]   # per-ORG tuples (2026-08-05)
        assert owner == a, "the stage records which org staged the file"
        assert os.path.isfile(path) and open(path, "rb").read() == b"a plan"
        assert os.path.dirname(path) == stage_dir(), path
    check("an upload stages a real file under <data>/net_stage",
          _upload_stages_a_file)

    def _name_is_sanitised():
        a = mkorg()
        _c, j = upload(a, name="../../etc/passwd")
        path = api._COMPOSE_STAGE[j["id"]][1]
        assert os.path.dirname(path) == stage_dir(), path
        assert ".." not in os.path.basename(path), path
    check("a hostile filename cannot escape the stage directory",
          _name_is_sanitised)

    def _send_rides_the_spool():
        a, b = mkorg(), mkorg()
        _c, j = upload(a, b"the attachment")
        # the unknown-recipient gate (user ruling 2026-08-12) consults the
        # roster before anything spools — this rig has no live hub, so the
        # recipient is seeded where a real registration would have put it
        net._rosters.setdefault(HUB_A, []).append(
            {"slug": net_slug(b), "online": True})
        code, r = api_call(api.app, "POST", f"/api/orgs/{a}/org_inbox/send",
                           {"to": f"@net:{net_slug(b)}",
                            "body": "from the user",
                            "attachments": [j["id"]]})
        assert code == 200, (code, r)
        row = inbox_rows(a, "out")[-1]
        assert row["by"] == "user" and row["state"] == "queued", row
        entry = list(spool_of(a).values())[0][0]
        assert entry["attachments"] == [api._COMPOSE_STAGE[j["id"]][1]], entry
        ladder(a, b, passes=2)
        got = inbox_rows(b, "in")[-1]
        assert got["body"] == "from the user", got
    check("a user-composed message with an attachment crosses the wire",
          _send_rides_the_spool)

    def _retired_mcp_form_is_refused():
        # user ruling 2026-09-25: the external-chat MCP server is retired and
        # outside chats use the mail hub only, so a compose to @mcp: refuses
        # (with or without an attachment) before anything is recorded — the
        # same treatment @ext: got on 2026-08-05.
        a = mkorg()
        _c, j = upload(a)
        for extra in ({}, {"attachments": [j["id"]]}):
            code, r = api_call(api.app, "POST",
                               f"/api/orgs/{a}/org_inbox/send",
                               {"to": "@mcp:peer", "body": "x", **extra})
            assert code == 422, (extra, code, r)
            assert r.get("detail") == MCP_RETIRED, r
        assert not [x for x in inbox_rows(a, "out")
                    if x.get("peer") == "@mcp:peer"],             "a refused @mcp: compose still logged an org-inbox row"
    check("a compose to the retired @mcp: form is refused and records nothing",
          _retired_mcp_form_is_refused)

    def _restart_fails_safe():
        # _COMPOSE_STAGE is in-memory: a restart invalidates every staged id.
        # The SEND must refuse rather than quietly send an empty message.
        a, b = mkorg(), mkorg()
        _c, j = upload(a)
        api._COMPOSE_STAGE.clear()                     # <- the restart
        code, r = api_call(api.app, "POST", f"/api/orgs/{a}/org_inbox/send",
                           {"to": f"@net:{net_slug(b)}", "body": "after restart",
                            "attachments": [j["id"]]})
        assert code == 422 and "re-upload" in json.dumps(r), (code, r)
        assert not [x for x in inbox_rows(a, "out")
                    if x.get("body") == "after restart"], \
            "the refused send still logged an org-inbox row"
    check("a restart invalidates staged ids and the send fails SAFE",
          _restart_fails_safe)

    def _stage_is_swept():
        a, b = mkorg(), mkorg()
        before = set(os.listdir(stage_dir())) if os.path.isdir(stage_dir()) \
            else set()
        _c, j = upload(a, b"x" * 1000, name="leaked.bin")
        # seed the roster past the unknown-recipient gate (2026-08-12)
        net._rosters.setdefault(HUB_A, []).append(
            {"slug": net_slug(b), "online": True})
        api_call(api.app, "POST", f"/api/orgs/{a}/org_inbox/send",
                 {"to": f"@net:{net_slug(b)}", "body": "sent",
                  "attachments": [j["id"]]})
        ladder(a, b, passes=2)                          # shipped to the hub
        after = set(os.listdir(stage_dir()))
        assert after == before, (
            f"the staged file survives a COMPLETED send: "
            f"{sorted(after - before)}. Nothing ever removes anything from "
            f"{stage_dir()} — every compose upload leaks up to 25 MB, "
            f"permanently")
    # PROMOTED from gap() 2026-08-05: the stage is now swept at startup (the
    # in-memory ids die with the process, so everything there is unreachable),
    # aged out at each upload, and deleted per file once its spool entry
    # reaches hub custody. Agent-scratch attachments are deliberately left
    # alone — only files under net_stage are the transport's to remove.
    check("the compose stage does not accumulate files forever",
          _stage_is_swept)

    def _kiosk_is_sealed():
        _n[0] += 1
        org = store.create_org(f"zz kiosk {_n[0]}")
        org.d["kiosk"] = {"enabled": True, "token": "t" * 16, "credits": 10}
        store.save_org(org)
        code, r = api_call(api.app, "POST",
                           f"/api/orgs/{org.d['slug']}/org_inbox/send",
                           {"to": "@org:someone", "body": "x"})
        # the SEAL must be the reason — not a retired address form, which
        # would make this pass for the wrong reason
        assert code == 422 and "sealed kiosk" in json.dumps(r), (code, r)
    check("a sealed kiosk cannot compose outward either", _kiosk_is_sealed)

    def _address_guards():
        a = mkorg()
        for to, needle in (("nobody", "outside address"),
                           ("", "outside address"),
                           (f"@net:{net_slug(a)}", "this organization")):
            code, r = api_call(api.app, "POST",
                               f"/api/orgs/{a}/org_inbox/send",
                               {"to": to, "body": "x"})
            assert code == 422 and needle in json.dumps(r), (to, code, r)
    check("a bare name and the org's own address are both refused",
          _address_guards)

    def _no_hub_refused_at_the_door():
        a = mkorg(hubs=(), autoconnect=False)
        b = mkorg()
        code, r = api_call(api.app, "POST", f"/api/orgs/{a}/org_inbox/send",
                           {"to": f"@net:{net_slug(b)}", "body": "x"})
        assert code == 422 and "mailserver" in json.dumps(r), (code, r)
        assert not spool_of(a), "a refused send must not spool"
    check("composing @net: with no hub is refused, not spooled",
          _no_hub_refused_at_the_door)

    def _public_gateway_cannot_compose():
        _n[0] += 1
        org = store.create_org(f"zz kiosk pub {_n[0]}")
        org.d["kiosk"] = {"enabled": True, "token": "k" * 20, "credits": 10}
        store.save_org(org)
        k, tok = org.d["slug"], org.d["kiosk"]["token"]
        pub = api.PublicGateway(api.app)
        for path in (f"/k/{tok}/api/orgs/{k}/org_inbox/send",
                     f"/k/{tok}/api/orgs/{k}/org_inbox/upload"):
            code, _r = api_call(pub, "POST", path,
                                {"to": "@org:x", "body": "y"})
            assert code == 404, (path, code)
    check("☞ a kiosk visitor reaches neither compose endpoint",
          _public_gateway_cannot_compose)

    def _oversize_refused():
        a = mkorg()
        code, r = api_call(api.app, "POST",
                           f"/api/orgs/{a}/org_inbox/upload",
                           content=b"\x00" * (api._NET_ATT_MAX + 1),
                           params=b"name=big.bin")
        assert code == 413, (code, r)
    check("an oversize compose upload is refused", _oversize_refused)


# ══════════════════════════════════════════════════════════════════════ §8
def sec_second_wave() -> None:
    """A/B/C re-attacked against HEAD, now that D, E and F have moved under
    them. The theme is STATE THAT OUTLIVES ITS SUBJECT: per-hub state keys on
    a hub id, the local hub's id is the CONSTANT 'local', and nothing clears
    that state when the entry is removed or re-pointed."""
    print("\n§8  the second wave — state that outlives its hub")
    net._backoff.clear()

    def settings(slug, **body):
        return api_call(api.app, "POST", f"/api/orgs/{slug}/settings", body)

    def local_hub_org():
        a = mkorg(hubs=(), autoconnect=True)     # implicit local entry only
        return a

    def _never_registered_is_invisible_everywhere():
        a = local_hub_org()
        d = store.load_org(a).d
        blk = net.status_block(d)
        local = [h for h in blk["hubs"] if h["id"] == net.LOCAL_HUB_ID][0]
        assert local["hidden"] is True, local
        # …and the org-inbox panel stays hidden too: the mailbox is one of the
        # surfaces the user named, and it has its own trigger in ledger.tree()
        org = store.load_org(a)
        org.d["audiences"] = [x for x in org.d["audiences"]
                              if x.get("grantor") != "@extern"]
        store.save_org(org)
        assert store.load_org(a).tree()["org_inbox"]["visible"] is False, (
            "the org-inbox panel is showing for a hub that has never answered")
    check("a never-registered local hub is invisible on BOTH surfaces",
          _never_registered_is_invisible_everywhere)

    def _registered_then_removed_then_readded():
        a = local_hub_org()
        with store.DOC_LOCK:
            o = store.load_org(a)
            o.d["net_state"] = {net.LOCAL_HUB_ID: {
                "registered_at": "2026-01-01T00:00:00Z"}}
            store.save_org(o)
        assert settings(a, net_autoconnect=False)[0] == 200
        assert store.load_org(a).d["net_hubs"] == [], "the entry was removed"
        assert settings(a, net_autoconnect=True)[0] == 200
        blk = net.status_block(store.load_org(a).d)
        local = [h for h in blk["hubs"] if h["id"] == net.LOCAL_HUB_ID][0]
        assert local["hidden"] is True, (
            "a local hub REMOVED and re-added is shown immediately as though "
            "it had answered: net_state['local'].registered_at survives the "
            "removal, and the re-added entry reuses the constant id, so the "
            "'has it ever answered' test reads a fact about a DIFFERENT "
            "configuration")
    # promoted from gap() 2026-08-05: per-hub state now carries the ADDRESS
    # it was earned against — the settings write and the daemon both drop
    # cells for removed ids / changed addresses, and the hidden test compares
    # the address, so a re-added local entry starts hidden until it answers
    check("re-adding the local hub starts it hidden again",
          _registered_then_removed_then_readded)

    def _address_change_carries_the_dedupe_ring():
        # THE SHARP ONE: per-hub state is keyed by hub id, and the local hub's
        # id is a constant — so re-pointing it at a DIFFERENT MACHINE inherits
        # the previous hub's seen-ring.
        a = local_hub_org()
        with store.DOC_LOCK:
            o = store.load_org(a)
            o.d["net_state"] = {net.LOCAL_HUB_ID: {
                "registered_at": "2026-01-01T00:00:00Z",
                "seen_ids": ["id-delivered-by-the-OLD-hub"]}}
            store.save_org(o)
        code, _j = settings(a, net_hubs=[{"id": net.LOCAL_HUB_ID,
                                          "address": "http://other-box:7370",
                                          "enabled": True}])
        assert code == 200, code
        st = (store.load_org(a).d.get("net_state") or {}).get(
            net.LOCAL_HUB_ID, {})
        assert "id-delivered-by-the-OLD-hub" not in (st.get("seen_ids") or []), (
            "the dedupe ring followed the hub id to a DIFFERENT ADDRESS: a "
            "message the old hub already delivered will be silently dropped "
            "as a duplicate when the new hub delivers it. Sender-side spool "
            "entries keep their id across a hub change, so this is reachable "
            "whenever a peer re-homes and retries")
    # promoted from gap() 2026-08-05: the state cell records the address it
    # was earned against; the settings write (and the daemon, for direct doc
    # edits) DROPS the cell on any address mismatch — dedupe ring included,
    # since a ring carried to a different machine silently swallowed a
    # re-homed peer's re-sent ids (dropping risks a bounded duplicate, never
    # a loss). Address-less legacy cells reset once, by design.
    check("per-hub state does not follow the hub id to a new address",
          _address_change_carries_the_dedupe_ring)

    def _hub_swap_mid_drain_neither_loses_nor_doubles():
        # the daemon snapshots participants, then the user replaces the hub
        # list underneath it. At-least-once must still hold: the hub collapses
        # the retry on the entry id, and the spool must end up empty.
        a, b = mkorg(), mkorg()
        ladder(a, b)                       # both registered
        send_net(a, "ceo", net_slug(b), "mid-flight")
        stale = parts_for(a, b)            # the daemon's snapshot, taken EARLY
        code, _j = settings(a, net_hubs=[{"address": HUB_A, "enabled": True}])
        assert code == 200, code
        net._drain_spools(stale)           # drains under the OLD key
        net._drain_spools(parts_for(a, b))  # …and again under the new one
        net._poll_pass(parts_for(a, b))
        assert not spool_of(a), f"the entry was stranded: {spool_of(a)}"
        bodies = [r["body"] for r in inbox_rows(b, "in")]
        assert bodies.count("mid-flight") == 1, (
            f"a hub-list edit during a drain delivered it {bodies.count('mid-flight')} "
            f"times — the hub's idempotent send is what must collapse it")
    check("a hub-list edit mid-drain neither strands nor doubles a message",
          _hub_swap_mid_drain_neither_loses_nor_doubles)

    def _prune_vs_a_slow_compose():
        # a staged file older than the age-out is pruned even while a compose
        # still references it — the send must then FAIL SAFE, not send an
        # empty attachment
        a, b = mkorg(), mkorg()
        code, j = api_call(api.app, "POST",
                           f"/api/orgs/{a}/org_inbox/upload",
                           content=b"slow compose", params=b"name=slow.txt")
        assert code == 200, (code, j)
        path = api._COMPOSE_STAGE[j["id"]][1] \
            if isinstance(api._COMPOSE_STAGE[j["id"]], tuple) \
            else api._COMPOSE_STAGE[j["id"]]
        old = time.time() - 86400 * 2
        os.utime(path, (old, old))                 # staged two days ago
        api._prune_stage()                         # what the next upload runs
        assert not os.path.exists(path), "the age-out did not fire"
        code, r = api_call(api.app, "POST", f"/api/orgs/{a}/org_inbox/send",
                           {"to": f"@net:{net_slug(b)}", "body": "with a file",
                            "attachments": [j["id"]]})
        assert code == 422 and "re-upload" in json.dumps(r), (code, r)
        assert not spool_of(a), "the refused send still spooled"
    check("an aged-out staged file makes the send fail safe, not send blind",
          _prune_vs_a_slow_compose)

    def _identity_survives_a_delete_and_restore():
        a = mkorg()
        ident = dict(store.load_org(a).d["net_identity"])
        store.delete_org(a)
        trash = os.path.join(store.DATA_ROOT, "deleted")
        f = [x for x in os.listdir(trash) if a in x][0]
        # `org_path` is the restore target under EITHER backend ("putting the
        # file back IS the restore"). The trash copy of a sqlite org is a
        # `<slug>.db`, and moving it to a `.json` name made the store try to
        # MIGRATE a database as though it were a document.
        shutil.move(os.path.join(trash, f), store.org_path(a))
        back = store.load_org(a).d["net_identity"]
        assert back == ident, (
            "a deleted-then-restored org came back with a different network "
            "identity — every peer that knows its address would be writing to "
            "a slug that no longer authenticates")
        assert back["secret"] == ident["secret"], "the secret must survive too"
    check("delete + restore keeps the org's network identity intact",
          _identity_survives_a_delete_and_restore)

    def _identity_does_not_follow_the_org_name():
        # already pinned in §1 against the doc; here through the REAL surface
        # an operator touches — the settings write — since that is the path
        # that would re-derive it if anyone ever added a rename
        a = mkorg()
        ident = dict(store.load_org(a).d["net_identity"])
        code, _j = settings(a, default_top_grant=7)
        assert code == 200, code
        assert store.load_org(a).d["net_identity"] == ident, \
            "a settings write disturbed the network identity"
        assert net._participants().get(a, {}).get("net_slug") == ident["slug"]
    check("a settings write never re-derives the network identity",
          _identity_does_not_follow_the_org_name)


# ══════════════════════════════════════════════════════════════════════ §9
def sec_connect_latency() -> None:
    """USER REPORT 2026-08-05: "when connecting to a remote mailserver, the
    other connected clients don't immediately show up — it takes about 20-30
    seconds."

    The roster the UI draws comes from ONE place: `_rosters[addr]`, written
    only from the `/api/poll` response. That call is a LONG POLL (25 s in
    production), so on a freshly added hub the panel stays empty until the
    first poll returns — which is the reported delay, to the second. The
    register response that already ran seconds earlier carries the very same
    roster and throws it away."""
    print("\n§9  connect latency — why a new hub shows no clients for ~25 s")

    def _register_response_carries_the_roster():
        """The data is IN HAND at registration — measured off the wire, so the
        'one line' fix below is a fact, not a hope."""
        neighbour = mkorg()
        net._register_pending(parts_for(neighbour))
        me = mkorg()
        p = parts_for(me)[me]
        with net._client() as c:
            r = c.post(f"{HUB_A}/api/register",
                       json={"slug": p["net_slug"], "org_name": p["name"],
                             "username": "tester"},
                       headers=net._auth_header([(p["net_slug"], p["secret"])]))
        assert r.status_code == 200, r.text
        roster = r.json().get("roster") or []
        assert any(x["slug"] == net_slug(neighbour) for x in roster), roster
    check("connect · /api/register's own response already lists every client "
          "on the hub", _register_response_carries_the_roster)

    def _roster_visible_right_after_registration():
        neighbour = mkorg()
        net._register_pending(parts_for(neighbour))
        net._poll_pass(parts_for(neighbour))       # the neighbour is settled
        me = mkorg()
        with net._status_lock:
            net._rosters.pop(HUB_A, None)          # a FRESH connection
        net._register_pending(parts_for(me))       # …and nothing else
        with net._status_lock:
            seen = list(net._rosters.get(HUB_A) or [])
        assert seen, (
            "after registering, the org knows of NO other client on the hub "
            "— the panel stays empty until the first long poll returns, which "
            "is the 20-30 s the user measured")
    # promoted from gap() 2026-08-05, fixed same day (0ef9bc0): the register
    # response's roster is adopted into _rosters immediately — the panel no
    # longer waits out the first 25 s poll window
    check("connect · a freshly connected hub shows its other clients "
          "immediately, without waiting for the first long poll",
          _roster_visible_right_after_registration)

    def _poll_does_populate_it():
        """ANTI-VACUITY: the same assertion PASSES once a poll has run, so the
        gap above is about WHEN the roster arrives, not whether it ever does."""
        neighbour = mkorg()
        net._register_pending(parts_for(neighbour))
        me = mkorg()
        with net._status_lock:
            net._rosters.pop(HUB_A, None)
        ladder(me, neighbour)
        with net._status_lock:
            seen = [x["slug"] for x in (net._rosters.get(HUB_A) or [])]
        assert net_slug(neighbour) in seen, seen
    check("connect · the roster DOES arrive on the first completed poll (so "
          "the gap above is about latency, not absence)", _poll_does_populate_it)

    def _the_wait_is_the_number_the_user_felt():
        src = open(os.path.join(_REPO, "engine", "backend", "orgtree", "net.py"),
                   encoding="utf-8").read()
        m = re.search(r"POLL_WAIT_S\s*=\s*([0-9.]+)", src)
        assert m, "POLL_WAIT_S is gone — re-derive the connect latency"
        assert 20.0 <= float(m.group(1)) <= 30.0, (
            f"POLL_WAIT_S is now {m.group(1)}; the user's measured 20-30 s "
            f"delay was this constant, so a change here changes the symptom")
    check("connect · the long-poll window is 20-30 s in production — the "
          "delay the user measured IS this constant",
          _the_wait_is_the_number_the_user_felt)


# ═════════════════════════════════════════════════════════════════════ §10
def sec_failed_send_visibility() -> None:
    """USER-DIRECTED REPORT (via the curator, 2026-08-05): an org's own extern
    view "shows a response was sent back", while the hub's message log — read
    directly — never received it.

    That pair is not a contradiction: the org-inbox OUT row is written at
    compose time and stamped `queued`; the wire attempt happens later on the
    sender loop, and when it fails the reason is recorded on the SPOOL entry
    (`tries` / `last_err`) — a structure no payload exposes. So a message that
    can never be delivered looks, from the org's side, exactly like one that
    was."""
    print("\n§10  a send that never lands — what the org's own side shows")

    def _successful_send_advances_the_row():
        """ANTI-VACUITY: the state machine DOES work, so the gap below is
        about failure reporting, not about states never moving."""
        a, b = mkorg(), mkorg()
        ladder(a, b)
        mid, _ = send_net(a, "ceo", net_slug(b), "this one lands")
        ladder(a, b)
        row = next(r for r in inbox_rows(a, "out") if r.get("net_id") == mid)
        assert row.get("state") in ("sent", "delivered", "read"), row
    check("visibility · a delivered message advances its out row past queued",
          _successful_send_advances_the_row)

    def _failed_send_is_visible_where_the_user_looks():
        a = mkorg()
        ladder(a)
        # a recipient that is not registered on this hub — the shape a stale
        # address produces (the hub answers 422 and the entry retries forever)
        mid, _ = send_net(a, "ceo", "ghost.nobody.abcdef", "into the void")
        for _ in range(3):
            ladder(a)
        d = store.load_org(a).d
        entry = next(e for v in (d.get("net_spool") or {}).values()
                     for e in v if e["id"] == mid)
        assert entry.get("tries", 0) >= 1 and entry.get("last_err"), (
            "fixture: the send must have failed on the wire")
        row = next(r for r in inbox_rows(a, "out") if r.get("net_id") == mid)
        block = net.status_block(d) or {}
        surfaced = (row.get("state") not in (None, "queued")
                    or row.get("error") or row.get("last_err")
                    or any(h.get("error") for h in (block.get("hubs") or [])))
        assert surfaced, (
            f"the message has failed {entry['tries']}x with "
            f"{entry['last_err']!r} and the org's own view still shows only "
            f"state={row.get('state')!r}: the failure exists ONLY inside "
            f"net_spool, which no payload exposes")
    # promoted from gap() 2026-08-05, fixed same day: BOTH suggested fixes
    # shipped — _bump_try copies last_err+tries onto the org-inbox out row
    # (the ⚠ glyph and its tooltip read them), and status_block carries a
    # per-hub stuck count + newest reason for the mailservers tab
    check("visibility · a send that keeps failing says so where the sender "
          "can see it", _failed_send_is_visible_where_the_user_looks)

    def _failure_fields_ride_the_row_and_clear_on_success():
        """The fixed shape, both directions: a failing row carries the reason;
        a row that finally lands sheds it (nobody should read
        'sent · last error …')."""
        a = mkorg()
        ladder(a)
        mid, _ = send_net(a, "ceo", "ghost2.nobody.abcdef", "also lost")
        ladder(a)
        row = next(r for r in inbox_rows(a, "out") if r.get("net_id") == mid)
        assert row.get("last_err") and int(row.get("tries") or 0) >= 1, row
        assert row.get("state") == "queued", row
        # …and a delivery that lands retires the note (_stamp_row pops it)
        b = mkorg()
        ladder(a, b)
        mid2, _ = send_net(a, "ceo", net_slug(b), "this one lands")
        ladder(a, b)
        row2 = next(r for r in inbox_rows(a, "out")
                    if r.get("net_id") == mid2)
        assert row2.get("state") in ("sent", "delivered", "read"), row2
        assert "last_err" not in row2 and "tries" not in row2, row2
    check("visibility · the failure note rides the out row while it fails "
          "and clears when a delivery lands",
          _failure_fields_ride_the_row_and_clear_on_success)


# ═════════════════════════════════════════════════════════════════════ §11
def sec_hub_choice() -> None:
    """USER REPORT 2026-08-05 (the third attempt at the same send): an org on
    another machine composes to a `@net:` peer, is told "queued for the mail
    hub — …", and the hub it is queued for never receives it. Measured from
    the hub side: that org POLLS us continuously and has called /api/send
    exactly zero times.

    `spool_append` picks the destination hub as `hubs[0]` — the first ENABLED
    entry in the org's list, which is the org's own local hub by construction
    (`hub_entries` puts it first). Inbound listens on every hub; outbound only
    ever talks to one. So a recipient that lives on the SECOND hub is
    unreachable, and the failure is invisible until you read the spool."""
    print("\n§11  which hub an outbound message is staged for")

    def _two_hub_org(peer_on_second: str):
        a = mkorg(hubs=(HUB_A, HUB_B))
        with store.DOC_LOCK:
            org = store.load_org(a)
            for h in org.d["net_hubs"]:
                h["enabled"] = True
            store.save_org(org)
        ids = hub_ids(a)
        addrs = [str(h["address"]) for h in store.load_org(a).d["net_hubs"]]
        # only the SECOND hub's roster knows the recipient
        with net._status_lock:
            net._rosters[addrs[0]] = []
            net._rosters[addrs[1]] = [{"slug": peer_on_second, "online": True}]
        return a, ids, addrs

    def _staged_for_the_hub_that_can_reach_it():
        peer = "faraway.other-machine.abcdef"
        a, ids, _addrs = _two_hub_org(peer)
        with store.DOC_LOCK:
            org = store.load_org(a)
            org.post_mail("ceo", f"@net:{peer}", "can you hear me")
            mid = net.spool_append(org, peer, "can you hear me",
                                   oid=org.d["org_inbox"][-1]["id"])
            store.save_org(org)
        spool = store.load_org(a).d.get("net_spool") or {}
        where = [k for k, v in spool.items() if any(e["id"] == mid for e in v)]
        assert where == [ids[1]], (
            f"staged for hub {where} — the recipient is only on {ids[1]}, so "
            f"this message will be offered to a hub that has never heard of "
            f"it (422, retried forever) while the hub that CAN deliver it is "
            f"never asked")
    # promoted from gap() 2026-08-05, fixed the same day (6f547ae) after the
    # remote org's own agent reached the same root cause independently:
    # spool_append now picks the hub whose roster holds the target, then a
    # currently connected one, and only then list order.
    check("hub-choice · an outbound message is staged for a hub that can "
          "actually reach the recipient", _staged_for_the_hub_that_can_reach_it)

    def _both_directions_resolve_rather_than_position():
        """The asymmetry that caused the live failure, pinned in its FIXED
        shape. The previous guard here asserted the DEFECT (`hubs[0]` present
        in spool_append) and kept passing after the fix — a check that still
        passes while telling the wrong story is worse than no check, so it is
        re-pointed at the ordering that now has to hold."""
        src = open(os.path.join(_REPO, "engine", "backend", "orgtree", "net.py"),
                   encoding="utf-8").read()
        i = src.index("def _poll_pass")
        assert "for addr, members in groups.items()" in src[i:i + 1200], (
            "inbound stopped iterating every enabled hub")
        j = src.index("def spool_append")
        seg = src[j:j + 2600]
        assert "_rosters" in seg, (
            "spool_append no longer consults the rosters — the destination is "
            "being chosen without asking who can deliver")
        # comments in that function DISCUSS the old hubs[0] behaviour, so
        # compare CODE only — the first draft of this guard tripped on the
        # commit's own explanatory comment
        code = "\n".join(ln for ln in seg.splitlines()
                         if not ln.lstrip().startswith("#"))
        assert "hubs[0]" not in code[:code.index("_rosters")], (
            "a positional pick happens BEFORE the roster is consulted")
    check("hub-choice · inbound polls every enabled hub and outbound resolves "
          "by who can deliver (rosters consulted before any positional "
          "fallback)", _both_directions_resolve_rather_than_position)


# ═════════════════════════════════════════════════════════════════════ §12
def sec_hub_pick_heal() -> None:
    """761c63f — the two halves of the hub pick, after the cross-org find.

    §11 fixed "which hub does an entry file under" at APPEND time. This is the
    follow-up: `connected` turned out to be weak evidence (a hub can be
    connected with a roster that has never synced), and — because a 422
    unknown-recipient retries the same hub forever by ruling — a single bad
    guess was permanent. So the pick got a second gate, and the drain got a
    heal that treats the append-time choice as REFUTABLE.

    The invariant that must survive both: a message is never moved because a
    hub does not know the peer (absence proves nothing — FR-07 says an address
    may be given before the recipient exists). It moves only when some other
    hub POSITIVELY names them."""
    print("\n§12  the cold-roster gate and the 422 re-file heal")

    def _fresh_rosters():
        """`_rosters` is a module global keyed by ADDRESS, and HUB_A/HUB_B are
        fixed — so a roster another check stubbed outlives it. Every check
        below states the roster world it wants rather than inheriting one."""
        with net._status_lock:
            net._rosters.clear()
            for k in [k for k in net._status if k[1]]:
                net._status.pop(k, None)

    def two_hub_org():
        a = mkorg(hubs=(HUB_A, HUB_B))
        with store.DOC_LOCK:
            org = store.load_org(a)
            for h in org.d["net_hubs"]:
                h["enabled"] = True
            store.save_org(org)
        addrs = [str(h["address"]) for h in store.load_org(a).d["net_hubs"]]
        return a, hub_ids(a), addrs

    def connect(slug, hid, on=True):
        with net._status_lock:
            net._status[(slug, hid)] = {"connected": on}

    def file_to(slug, peer):
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.post_mail("ceo", f"@net:{peer}", "which hub gets this")
            mid = net.spool_append(org, peer, "which hub gets this",
                                   oid=org.d["org_inbox"][-1]["id"])
            store.save_org(org)
        spool = store.load_org(slug).d.get("net_spool") or {}
        where = [k for k, v in spool.items() if any(e["id"] == mid for e in v)]
        return mid, (where[0] if where else None)

    # ---- the append-time gate ------------------------------------------
    def _a_hubs_roster_contains_ourselves():
        """THE FACT THE FIXTURES BELOW REST ON, measured against a real hub
        rather than assumed — because assuming it wrong is what made the
        first cut of this section certify an inert gate.

        `/register` answers with the hub's whole roster, and the org that
        just registered is in it: there is one roster builder and it takes no
        requester argument, so no implementation of it could filter the
        caller. `status_block` strips our own row when it builds the payload,
        which is downstream and does not change what `_rosters` holds. So a
        roster is EMPTY only before the first successful register — after
        that it is never empty on a hub we are on, and "does this roster have
        content" answers yes everywhere. (Cross-org finding 2026-08-06, with
        two live messages either side of the boundary as proof.)"""
        _fresh_rosters()
        a = mkorg(hubs=(HUB_A,))
        ladder(a)
        with net._status_lock:
            roster = list(net._rosters.get(HUB_A) or [])
        mine = net_slug(a)
        assert any(str(r.get("slug")) == mine for r in roster), (
            f"the hub's roster does not contain the registering org — the "
            f"whole membership argument below rests on this: "
            f"{[r.get('slug') for r in roster][:6]}")
        # …and the PAYLOAD layer strips it again, which is exactly why the raw
        # cache is misleading: everything a human ever sees has self removed,
        # so "the roster has content" reads as a fact about OTHERS when the
        # value `spool_append` consults means nothing of the kind
        block = net.status_block(store.load_org(a).d) or {}
        shown = [r.get("slug") for h in block.get("hubs", [])
                 for r in h.get("roster", [])]
        assert mine not in shown, (
            f"status_block stopped stripping our own row; the two layers no "
            f"longer differ and this check's premise is stale: {shown[:6]}")
        # the "alone on the hub" case the fixtures below stub is NOT reproduced
        # live on purpose: this suite's hub DB accumulates every org every
        # earlier check registered, so by here the roster holds dozens. The
        # measured fact is the INCLUSION; aloneness is stated by construction.
    check("hub-pick · a hub's roster INCLUDES the org that registered — "
          "measured, because it is why a truthiness gate reads as satisfied "
          "everywhere", _a_hubs_roster_contains_ourselves)

    def _cold_connected_loses_to_warm_connected():
        """⚠ The rosters here carry OUR OWN slug, as a real one always does.
        The first version of this check seeded the cold hub with `[]`, a state
        that cannot occur on a hub we are registered with — so it passed
        against a gate that was inert in production (it read cardinality, and
        cardinality is always true). Modelling the real shape is what makes
        this discriminate: under a truthiness gate hub A qualifies and list
        order wins; only a MEMBERSHIP test reaches hub B."""
        _fresh_rosters()
        a, ids, addrs = two_hub_org()
        connect(a, ids[0]); connect(a, ids[1])
        mine = net_slug(a)
        with net._status_lock:
            net._rosters[addrs[0]] = [{"slug": mine}]        # registered, alone
            net._rosters[addrs[1]] = [{"slug": mine},
                                      {"slug": "someone.else.111111"}]
        _mid, hid = file_to(a, "stranger.other.abcdef")
        assert hid == ids[1], (
            f"filed onto {hid} — the FIRST hub is connected but its roster "
            f"knows nobody except us, so the gate degenerated to list order "
            f"while a hub that has actually synced other parties sat second")
    check("hub-pick · a connected hub that knows only US loses to one that "
          "knows other parties (membership, not cardinality — the gate the "
          "cross-org proof showed was inert)",
          _cold_connected_loses_to_warm_connected)

    def _all_cold_still_files_somewhere():
        """FR-07, restated at the new gate: a cold world must never refuse or
        stall — the spool exists precisely to hold mail until a hub is back.
        'Cold' now means "knows nobody but us", which is the state every hub
        is in on a fresh machine."""
        _fresh_rosters()
        a, ids, addrs = two_hub_org()
        connect(a, ids[0]); connect(a, ids[1])
        mine = net_slug(a)
        with net._status_lock:
            net._rosters[addrs[0]] = [{"slug": mine}]
            net._rosters[addrs[1]] = [{"slug": mine}]
        _mid, hid = file_to(a, "stranger.other.abcdef")
        assert hid == ids[0], (
            f"filed onto {hid}: with every roster knowing only us the gate "
            f"must fall through to any connected hub in list order, not "
            f"refuse and not stall")
    check("hub-pick · when every roster knows only us the gate falls through "
          "instead of refusing (FR-07 offline addressing)",
          _all_cold_still_files_somewhere)

    def _positive_knowledge_still_outranks_everything():
        """ANTI-VACUITY for the two above: tier 1 is unchanged, so a hub that
        actually holds the peer wins even when a warm, connected hub with a
        full roster sits ahead of it in the list."""
        _fresh_rosters()
        a, ids, addrs = two_hub_org()
        connect(a, ids[0]); connect(a, ids[1])
        with net._status_lock:
            net._rosters[addrs[0]] = [{"slug": "a-crowd.other.222222"},
                                      {"slug": "another.other.333333"}]
            net._rosters[addrs[1]] = [{"slug": "wanted.other.abcdef"}]
        _mid, hid = file_to(a, "wanted.other.abcdef")
        assert hid == ids[1], (
            f"filed onto {hid} — the roster that NAMES the recipient must "
            f"beat a merely-populated one, or §11 regressed")
    check("hub-pick · a roster that names the recipient still outranks a "
          "merely-warm one (tier 1 over tier 2)",
          _positive_knowledge_still_outranks_everything)

    def _nothing_connected_files_by_list_order():
        _fresh_rosters()
        a, ids, _addrs = two_hub_org()
        _mid, hid = file_to(a, "stranger.other.abcdef")
        assert hid == ids[0], f"filed onto {hid} with no hub connected"
    check("hub-pick · with nothing connected at all the entry still files "
          "(tier 3, list order — unchanged)",
          _nothing_connected_files_by_list_order)

    # ---- the 422 heal ---------------------------------------------------
    def _absence_never_moves_mail():
        """The invariant the heal must not break. A hub refusing a recipient
        is not evidence the recipient is elsewhere — hub-agnostic addresses
        are ruled, and a peer may register tomorrow."""
        _fresh_rosters()
        a, ids, addrs = two_hub_org()
        mid, hid = file_to(a, "not-yet-born.other.abcdef")
        with net._status_lock:
            net._rosters[addrs[0]] = [{"slug": "somebody.else.111111"}]
            net._rosters[addrs[1]] = [{"slug": "another.else.222222"}]
        hubs = [dict(h) for h in store.load_org(a).d["net_hubs"]]
        moved = net._refile_known_elsewhere(a, hid, mid,
                                            "not-yet-born.other.abcdef", hubs)
        assert moved is None, f"moved to {moved} on nobody's positive evidence"
        spool = store.load_org(a).d.get("net_spool") or {}
        assert [k for k, v in spool.items() if v] == [hid], (
            "the entry left its hub although no roster names the recipient")
    check("422-heal · an entry moves on POSITIVE evidence only — a peer no "
          "roster knows stays put and keeps retrying (FR-07)",
          _absence_never_moves_mail)

    def _refile_preserves_the_entry_identity():
        """The id is the hub's idempotency key AND the org-inbox row's
        `net_id`. A refile that re-minted either would leave the row unable
        to ever advance its state — "queued" forever on a message that was
        in fact delivered, which is this whole thread's failure shape."""
        _fresh_rosters()
        a, ids, addrs = two_hub_org()
        mid, hid = file_to(a, "wanted.other.abcdef")
        other = ids[1] if hid == ids[0] else ids[0]
        other_addr = addrs[1] if hid == ids[0] else addrs[0]
        with net._status_lock:
            net._rosters[other_addr] = [{"slug": "wanted.other.abcdef"}]
        row = [r for r in store.load_org(a).d["org_inbox"]
               if r.get("dir") == "out"][-1]
        hubs = [dict(h) for h in store.load_org(a).d["net_hubs"]]
        moved = net._refile_known_elsewhere(a, hid, mid,
                                            "wanted.other.abcdef", hubs)
        assert moved == other, f"refiled to {moved}, expected {other}"
        spool = store.load_org(a).d.get("net_spool") or {}
        assert not spool.get(hid), "the entry is still on the refuting hub too"
        e = next(x for x in spool[other] if x["id"] == mid)
        assert e["oid"] == row["id"] and str(row.get("net_id")) == mid, (
            "the refile broke the entry↔row link — the org-inbox row can no "
            "longer be stamped when this message lands")
        assert int(e.get("refiled") or 0) == 1, e
    check("422-heal · a refile preserves the entry id and its org-inbox link "
          "(the idempotency key and `net_id` both survive)",
          _refile_preserves_the_entry_identity)

    def _ping_pong_is_bounded():
        """Two hubs with mutually stale rosters each claim the peer. Without
        a bound the entry would shuttle forever, invisible and undelivered."""
        _fresh_rosters()
        a, ids, addrs = two_hub_org()
        mid, hid = file_to(a, "claimed.other.abcdef")
        with net._status_lock:
            net._rosters[addrs[0]] = [{"slug": "claimed.other.abcdef"}]
            net._rosters[addrs[1]] = [{"slug": "claimed.other.abcdef"}]
        hubs = [dict(h) for h in store.load_org(a).d["net_hubs"]]
        seen, at = [], hid
        for _ in range(8):
            nxt = net._refile_known_elsewhere(a, at, mid,
                                              "claimed.other.abcdef", hubs)
            if nxt is None:
                break
            seen.append(nxt)
            at = nxt
        assert len(seen) <= 4, f"shuttled {len(seen)} times: {seen}"
        assert seen, "a mutually-claimed peer never moved at all"
    check("422-heal · mutually stale rosters cannot shuttle an entry forever "
          "(bounded at 4 moves)", _ping_pong_is_bounded)

    def _a_refiled_row_stops_showing_the_refuted_hubs_error():
        """A re-file clears the failure note on BOTH carriers — the spool entry
        and the org-inbox row — because the row is the one the sender reads
        (§10). The sequence that reaches it: hub A refuses, no other roster
        knows the peer yet, so `_bump_try` stamps the row; later a roster warms
        and the entry is re-filed correctly. Was the residual gap on 761c63f
        (the entry was cleared, the row was not); measured rather than assumed,
        because "the row says a message is failing when it is not" is the exact
        shape this whole thread has been about.

        ⚠ The e2e check below does NOT cover this: there the heal short-circuits
        before `_bump_try`, so the row never carries a note at all. Only the
        refuse-THEN-warm order reaches the seam — which is why this check
        stamps the row by hand instead of driving it through the ladder."""
        _fresh_rosters()
        a, ids, addrs = two_hub_org()
        mid, hid = file_to(a, "wanted.other.abcdef")
        # phase 1: refused, nobody else knows them → the row is stamped
        net._bump_try(a, hid, mid, "no org registered as wanted.other.abcdef")
        row = [r for r in store.load_org(a).d["org_inbox"]
               if r.get("net_id") == mid][0]
        assert row.get("last_err"), "the fixture did not stamp the row"
        # phase 2: the other hub's roster warms and names them
        other = ids[1] if hid == ids[0] else ids[0]
        with net._status_lock:
            net._rosters[addrs[1] if hid == ids[0] else addrs[0]] = [
                {"slug": "wanted.other.abcdef"}]
        hubs = [dict(h) for h in store.load_org(a).d["net_hubs"]]
        assert net._refile_known_elsewhere(a, hid, mid,
                                           "wanted.other.abcdef", hubs) == other
        row = [r for r in store.load_org(a).d["org_inbox"]
               if r.get("net_id") == mid][0]
        assert not row.get("last_err"), (
            f"the row still reads {row.get('last_err')!r} after the entry was "
            f"re-filed onto a hub that DOES know the recipient — the sender "
            f"sees ⚠ 'delivery failing' on a message that is now correctly "
            f"routed and about to be delivered")
    # promoted from gap() 2026-08-05, fixed the same day: the re-file now
    # clears the org-inbox row beside the spool entry. Deviation from the
    # finding's suggestion, deliberate: `tries` is popped TOO, for symmetry
    # with `_stamp_row` — the frontend never renders a row's tries without
    # its error note, and a later real failure on the new hub re-copies the
    # honest cumulative count from the entry anyway (`_bump_try`).
    check("422-heal · a re-filed entry's row stops showing the refuted hub's "
          "error", _a_refiled_row_stops_showing_the_refuted_hubs_error)

    # ---- end to end, on the real two-hub fleet --------------------------
    def _a_misfiled_message_heals_and_lands():
        """The whole point, measured on real hubs: the sender talks to both,
        the recipient exists on hub B only, and the entry is staged while
        every roster is still cold — exactly the cross-org report. Hub A
        answers 422; the entry must end up delivered rather than retrying A
        for the rest of the process's life."""
        _fresh_rosters()
        a = mkorg(hubs=(HUB_A, HUB_B))
        with store.DOC_LOCK:
            org = store.load_org(a)
            for h in org.d["net_hubs"]:
                h["enabled"] = True
            store.save_org(org)
        b = mkorg(hubs=(HUB_B,))
        bslug = net_slug(b)
        mid, _r = send_net(a, "ceo", bslug, "healed across hubs")
        staged = [k for k, v in spool_of(a).items() if any(e["id"] == mid for e in v)]
        assert staged and staged[0] == hub_ids(a)[0], (
            f"the fixture must stage onto hub A to test the heal, got {staged}")
        ladder(a, b, passes=3)
        assert not spool_of(a), f"still spooled after three passes: {spool_of(a)}"
        got = [r["body"] for r in inbox_rows(b, "in")]
        assert "healed across hubs" in got, (
            f"the message never reached the recipient: {got}")
        row = [r for r in store.load_org(a).d["org_inbox"]
               if r.get("net_id") == mid][0]
        assert row.get("state") in ("sent", "delivered", "read"), row
        assert "last_err" not in row, (
            f"the row still carries the refuted hub's failure note: {row}")
    check("422-heal · end to end on two real hubs: a message staged onto the "
          "wrong hub re-files itself and is delivered, and its row stops "
          "showing the refuted hub's error",
          _a_misfiled_message_heals_and_lands)

    def _heal_runs_before_the_failure_is_recorded():
        """Drift guard, code only (the §11 lesson: a guard that reads comments
        tells the wrong story). Order matters — if `_bump_try` ran first, a
        guess that was merely refuted would be stamped onto the sender's row
        as a delivery failure before the heal had a chance to fix it."""
        src = open(os.path.join(_REPO, "engine", "backend", "orgtree", "net.py"),
                   encoding="utf-8").read()
        i = src.index("elif r.status_code == 422:")
        seg = "\n".join(ln for ln in src[i:i + 1400].splitlines()
                        if not ln.lstrip().startswith("#"))
        assert "_refile_known_elsewhere" in seg, "the 422 heal is gone"
        assert seg.index("_refile_known_elsewhere") < seg.index("_bump_try"), (
            "the failure is recorded before the heal is tried")
        heal = src[src.index("def _refile_known_elsewhere"):]
        heal = "\n".join(ln for ln in heal[:1600].splitlines()
                         if not ln.lstrip().startswith("#"))
        assert "_rosters" in heal and "refiled" in heal, (
            "the heal no longer requires positive roster evidence, or lost "
            "its move bound — re-read §12 before trusting these checks")
    check("422-heal · the heal is consulted BEFORE the failure is stamped, "
          "and still needs positive roster evidence plus a move bound",
          _heal_runs_before_the_failure_is_recorded)


def main() -> int:
    print("orgtree · @net Phase C — the transport, attacked")
    sec_ladder()
    sec_spool_routing()
    sec_seen_ring()
    sec_receipts()
    sec_failure()
    sec_secret()
    sec_compose()
    sec_second_wave()
    sec_connect_latency()
    sec_failed_send_visibility()
    sec_hub_choice()
    sec_hub_pick_heal()

    print()
    if GAPS:
        print("findings (asserted inverted — they turn RED when fixed):")
        for label, why, saw in GAPS:
            print(f"  ⚑ {label}\n      why: {why}\n      saw: {saw}")
        print()
    if FAIL:
        for label, tb in FAIL:
            print(f"\n✗ {label}\n{tb}")
        print(f"net-transport: {PASS} passed · {len(FAIL)} FAILED · {len(GAPS)} findings")
        return 1
    print(f"net-transport: all {PASS} checks passed"
          + (f" · {len(GAPS)} findings" if GAPS else ""))
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    sys.exit(rc)
