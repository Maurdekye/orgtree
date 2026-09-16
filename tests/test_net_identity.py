"""@net: Phase A — the org's permanent network identity and its hub list (F-06).

An org's net identity is a CREDENTIAL and an ADDRESS at once, and the two pull
in opposite directions. The address (`org.username.fp[:6]`) must be stable for
the org's whole life — it is what other machines write to, so recomputing it
from anything mutable would silently break every peer that has it. The secret
must never be seen: it lives in the org doc, and exactly one loopback endpoint
is allowed to hand it back.

Neither property fails loudly. A slug recomputed on load still looks like a
slug; a secret that leaks into a tree payload still renders a normal-looking
org. So this suite checks the two of them the only way that means anything:
mint, mutate the things the slug must NOT follow, and assert it did not move —
then sweep every other reachable payload for the secret's literal bytes.

    §1  the mint — shape, derivation, and minted-ONCE
    §2  kiosks mint nothing (anti-enumeration by NONEXISTENCE, not by filter)
    §3  hub entries — the local id, remote ids, blanks, and unnamed-at-birth
    §4  the defaults plumbing — net_hub_address shapes it, never lands in a doc
    §5  secret hygiene — where it may appear, and everywhere it may not
    §6  username sanitization — the slug keeps exactly three parts

Hermetic: throwaway ORGTREE_DATA + HOME, no listener, no Docker, no CLI. The
API is driven by calling the ASGI app with a hand-built scope (same technique
as test_api_surface.py) so the PUBLIC gateway is exercised for real.

    python backend/tests/test_net_identity.py [-v]
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import traceback

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
# ⚠ FORCE this worktree's engine ahead of everything: an installed Orgtree
# (C:\Program Files\Orgtree\resources\engine) can shadow `orgtree` via the
# machine's default path, and a suite that silently imports the INSTALLED
# build measures the wrong code entirely.
_ROOT = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(_ROOT, "engine", "mailhub"))
sys.path.insert(0, os.path.join(_ROOT, "engine", "backend"))

_TMP = tempfile.mkdtemp(prefix="orgtree-net-")
_HOME = os.path.join(_TMP, "home")
os.makedirs(_HOME, exist_ok=True)
os.environ["ORGTREE_DATA"] = os.path.join(_TMP, "data")
os.environ["USERPROFILE"] = _HOME
os.environ["HOME"] = _HOME
os.environ["ORGTREE_STEER_HOOK"] = "0"
os.environ["ORGTREE_PORT"] = "7404"          # never bound — only _share_url reads it
os.environ["ORGTREE_PUBLIC_PORT"] = "7404"

from orgtree import api, net, sandbox, store, supervisor          # noqa: E402
from orgtree.ledger import LedgerError, Org, USER                 # noqa: E402

# no chatq registry writes, no Docker, no host storage walks
supervisor.chatq_register_org = lambda slug: None
supervisor.chatq_deregister_org = lambda slug: None
supervisor.storage_check = lambda slug: None
sandbox.warm = lambda org: None

ADMIN = api.app
PUBLIC = api.PublicGateway(api.app)

PASS = 0
FAIL: list[tuple[str, str]] = []
GAPS: list[tuple[str, str, str]] = []
VERBOSE = "-v" in sys.argv


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


def gap(label, why, fn) -> None:
    """A property that SHOULD hold and currently does not — asserted inverted
    so the suite stays green while the finding is printed every run, and so it
    turns RED the day someone fixes it (see test_rename.py)."""
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


# ------------------------------------------------------------------ the wire
class R:
    def __init__(self, status, body):
        self.status, self.body = status, body
        try:
            self.json = json.loads(body)
        except Exception:                                        # noqa: BLE001
            self.json = None

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    def __repr__(self):
        return f"<{self.status} {self.text[:160]!r}>"


def call(app, method, path, body=None, headers=()):
    """Invoke an ASGI app with a hand-built scope — the same technique as
    test_api_surface.py, so the gateway sees exactly what uvicorn would hand
    it."""
    payload = b"" if body is None else json.dumps(body).encode()
    hdrs = [(b"host", b"127.0.0.1:7404")]
    hdrs += [(k.lower().encode(), v.encode()) for k, v in headers]
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

    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
             "http_version": "1.1", "method": method, "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": b"",
             "root_path": "", "headers": hdrs,
             "client": ("127.0.0.1", 5555), "server": ("127.0.0.1", 7404)}
    try:
        asyncio.run(app(scope, receive, send))
    except Exception as e:                                       # noqa: BLE001
        st[0] = st[0] or 500
        chunks.append(f"{type(e).__name__}: {e}".encode())
    return R(st[0], b"".join(chunks))


_n = [0]


def make_org(**over):
    """A normal org through the REAL creation path (so the net block runs)."""
    _n[0] += 1
    body = {"name": f"zz net {_n[0]}"}
    body.update(over)
    r = call(ADMIN, "POST", "/api/orgs", body)
    assert r.status == 200, r
    return r.json["slug"]


def make_kiosk(**over):
    _n[0] += 1
    body = {"name": f"zz kiosk {_n[0]}",
            "kiosk": {"sandbox": False, "credits": 10}}
    body.update(over)
    r = call(ADMIN, "POST", "/api/orgs", body)
    assert r.status == 200, r
    return r.json["slug"]


def write_defaults(**kv):
    p = os.path.join(store.DATA_ROOT, "defaults.json")
    cur = {}
    if os.path.exists(p):
        cur = json.load(open(p, encoding="utf-8"))
    cur.update(kv)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(cur, fh)


def clear_defaults():
    p = os.path.join(store.DATA_ROOT, "defaults.json")
    if os.path.exists(p):
        os.remove(p)


# ===================================================================== §1
def sec_mint() -> None:
    print("\n§1  the mint — shape, derivation, minted ONCE")

    def _shape():
        org = store.load_org(make_org())
        i = org.d["net_identity"]
        assert re.fullmatch(r"[0-9a-f]{32}", i["secret"]), i["secret"]
        assert i["fingerprint"] == hashlib.sha256(i["secret"].encode()).hexdigest()
        assert re.fullmatch(r"[0-9a-f]{64}", i["fingerprint"])
        assert i["minted_at"] and "T" in i["minted_at"]
    check("secret is 32 hex; fingerprint is sha256 OF THAT SECRET", _shape)

    def _slug_shape():
        slug = make_org()
        org = store.load_org(slug)
        i = org.d["net_identity"]
        parts = i["slug"].split(".")
        assert len(parts) == 3, f"the address must have exactly 3 parts: {i['slug']}"
        assert parts[0] == slug, parts
        assert parts[2] == i["fingerprint"][:6], parts
    check("the address is org.username.fp[:6]", _slug_shape)

    def _unique():
        a = store.load_org(make_org()).d["net_identity"]
        b = store.load_org(make_org()).d["net_identity"]
        assert a["secret"] != b["secret"] and a["fingerprint"] != b["fingerprint"]
        assert a["slug"] != b["slug"]
    check("two orgs never share a secret, a fingerprint or an address", _unique)

    def _idempotent():
        org = store.load_org(make_org())
        first = dict(org.d["net_identity"])
        again = net.mint_identity(org)
        assert again == first, "a second mint must return the SAME identity"
        assert org.d["net_identity"] == first
    check("mint_identity is idempotent — it never re-mints", _idempotent)

    def _survives_reload():
        slug = make_org()
        first = dict(store.load_org(slug).d["net_identity"])
        for _ in range(3):
            o = store.load_org(slug)
            store.save_org(o)
        assert store.load_org(slug).d["net_identity"] == first, \
            "a save/load round trip must not disturb the identity"
    check("the identity survives repeated load/save cycles", _survives_reload)

    def _never_recomputed():
        # THE POINT OF THE WHOLE DESIGN: the address is what other machines
        # write to, so it must not follow anything mutable. Move the org (its
        # own slug changes) and the address must stay exactly as minted.
        slug = make_org()
        org = store.load_org(slug)
        before = dict(org.d["net_identity"])
        org.d["slug"] = "moved-somewhere-else"
        got = net.mint_identity(org)
        assert got == before, "the identity was re-derived from the org slug"
        assert got["slug"].split(".")[0] == slug, \
            f"the address followed the rename: {got['slug']}"
    check("the address is NEVER recomputed from the org's current name",
          _never_recomputed)

    def _not_from_name_collision():
        # two orgs whose slugs collide after a delete+recreate still differ:
        # the fingerprint suffix is the uniqueness, not the name
        s1 = make_org(name="Same Name")
        i1 = dict(store.load_org(s1).d["net_identity"])
        call(ADMIN, "DELETE", f"/api/orgs/{s1}")
        s2 = make_org(name="Same Name")
        i2 = store.load_org(s2).d["net_identity"]
        assert i1["slug"] != i2["slug"], \
            "a recreated org with the same name reused the old address"
    check("a recreated org with the same name gets a DIFFERENT address",
          _not_from_name_collision)


# ===================================================================== §2
def sec_kiosk() -> None:
    print("\n§2  kiosks mint nothing — absence, not filtering")
    # V2 scope note: kiosk orgs were REMOVED from the desktop product (user
    # decision 2026-09-07), so the strongest form of "a kiosk has no
    # identity" now holds by construction — a kiosk cannot exist at all.
    # These checks pin (a) that the refusal really stands at the door, and
    # (b) that net.mint_identity keeps its own kiosk guard anyway, so a doc
    # that ever ARRIVES with a kiosk marker (an import, a hand edit) still
    # mints nothing.

    def _kiosks_cannot_exist():
        _n[0] += 1
        r = call(ADMIN, "POST", "/api/orgs",
                 {"name": f"zz kiosk {_n[0]}",
                  "kiosk": {"sandbox": False, "credits": 10}})
        assert r.status != 200, (
            "a kiosk org was CREATED — the desktop product removed kiosks, "
            "and every kiosk-seal property in this suite assumes the door "
            "is closed")
    check("kiosk creation is refused at the door (V2 removed kiosks)",
          _kiosks_cannot_exist)

    def _mint_returns_none():
        org = store.load_org(make_org())
        org.d.pop("net_identity", None)        # in-memory only: the shape of
        org.d["kiosk"] = {"token": "zz"}       # an imported/hand-edited doc
        assert net.mint_identity(org) is None
        assert "net_identity" not in org.d
    check("mint_identity refuses a kiosk-marked doc and leaves it alone",
          _mint_returns_none)


# ===================================================================== §3
def sec_hubs() -> None:
    print("\n§3  hub entries — ids, blanks, and no names at birth")

    def _local_only_under_autoconnect():
        on = net.hub_entries(True, [])
        assert [h["id"] for h in on] == [net.LOCAL_HUB_ID]
        assert on[0]["address"] == net.DEFAULT_HUB_ADDRESS and on[0]["enabled"]
        assert net.hub_entries(False, []) == [], \
            "opting out of autoconnect must leave NO local entry"
    check("the local entry exists only under autoconnect", _local_only_under_autoconnect)

    def _local_id_is_stable():
        # per-hub state keys on the id, so the address may be edited freely —
        # that only works while the local id is a constant, not derived
        hubs = net.hub_entries(True, [], "http://example.test:9999")
        assert hubs[0]["id"] == "local" == net.LOCAL_HUB_ID
        assert hubs[0]["address"] == "http://example.test:9999"
    check("the local hub's id is the constant 'local', whatever its address",
          _local_id_is_stable)

    def _remote_ids():
        hubs = net.hub_entries(True, ["http://a.test", "http://b.test"])
        rem = [h for h in hubs if h["id"] != net.LOCAL_HUB_ID]
        assert len(rem) == 2
        for h in rem:
            assert re.fullmatch(r"[0-9a-f]{8}", h["id"]), h
        assert rem[0]["id"] != rem[1]["id"], "ids must be unique per entry"
        assert [h["address"] for h in rem] == ["http://a.test", "http://b.test"]
    check("each remote hub gets its own minted id", _remote_ids)

    def _blank_and_whitespace():
        hubs = net.hub_entries(True, ["", "   ", "\t", "http://real.test"])
        rem = [h for h in hubs if h["id"] != net.LOCAL_HUB_ID]
        assert len(rem) == 1 and rem[0]["address"] == "http://real.test", hubs
    check("blank and whitespace-only addresses are dropped", _blank_and_whitespace)

    def _addresses_stripped():
        hubs = net.hub_entries(False, ["  http://spaced.test  "])
        assert hubs[0]["address"] == "http://spaced.test"
        assert net.hub_entries(True, [], "   ")[0]["address"] \
            == net.DEFAULT_HUB_ADDRESS, \
            "a blank local address falls back to the default, never empty"
    check("addresses are stripped; a blank local address falls back",
          _addresses_stripped)

    def _no_names_at_birth():
        for h in net.hub_entries(True, ["http://a.test"]):
            assert "name" not in h, (
                "hub NAMES are discovered on connect (user ruling) — writing "
                "one at creation would present a guess as a fact")
    check("no hub carries a name at creation", _no_names_at_birth)

    def _through_the_api():
        slug = make_org(net_hubs=["http://one.test", "", "http://two.test"])
        d = store.load_org(slug).d
        assert d["net_autoconnect"] is True
        ids = [h["id"] for h in d["net_hubs"]]
        assert ids[0] == "local" and len(ids) == 3, d["net_hubs"]
        r = call(ADMIN, "GET", f"/api/orgs/{slug}/net")
        assert r.json["hubs"] == d["net_hubs"] and r.json["autoconnect"] is True
    check("creation wires the typed hubs through to the doc and the endpoint",
          _through_the_api)

    def _opt_out_through_the_api():
        slug = make_org(net_autoconnect=False)
        d = store.load_org(slug).d
        assert d["net_autoconnect"] is False and d["net_hubs"] == []
        assert d.get("net_identity"), (
            "opting out of the local hub must not skip the identity — the org "
            "still has an address, it just joins nothing yet")
    check("opting out of autoconnect still mints an identity",
          _opt_out_through_the_api)


# ===================================================================== §4
def sec_defaults() -> None:
    print("\n§4  the defaults plumbing — shapes the entry, never lands in a doc")

    def _shapes_the_local_entry():
        write_defaults(net_hub_address="http://hub.lan:7370")
        try:
            slug = make_org()
            hubs = store.load_org(slug).d["net_hubs"]
            assert hubs[0]["id"] == "local"
            assert hubs[0]["address"] == "http://hub.lan:7370", hubs
        finally:
            clear_defaults()
    check("net_hub_address in defaults shapes the local entry's address",
          _shapes_the_local_entry)

    def _never_raw_in_the_doc():
        # `dflt` is `org.d.update()`d wholesale, so a key that is CONFIG rather
        # than org state has to be popped before that line or it becomes a
        # permanent, meaningless field on every org ever created.
        write_defaults(net_hub_address="http://hub.lan:7370")
        try:
            d = store.load_org(make_org()).d
            assert "net_hub_address" not in d, (
                "net_hub_address landed raw in the org doc — it is creation "
                "CONFIG, translated into the local hub entry; a copy in the "
                "doc is a second source of truth that nothing updates")
        finally:
            clear_defaults()
    check("net_hub_address NEVER lands raw in an org doc", _never_raw_in_the_doc)

    def _pop_is_still_there():
        # drift guard: the pop and the update are one line apart, and dropping
        # the pop is invisible — every org just quietly grows the key
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "engine", "backend", "orgtree",
                                "api.py"),
                   encoding="utf-8").read()
        i = src.find("def orgs_create")
        assert i > 0
        window = src[i:i + 12000]      # V2's orgs_create is longer than V1's
        assert 'dflt.pop("net_hub_address"' in window, (
            "orgs_create no longer POPS net_hub_address out of the defaults "
            "before org.d.update(dflt) — re-read §4 of this suite")
        assert window.index('dflt.pop("net_hub_address"') \
            < window.index("org.d.update(dflt)"), \
            "the pop must happen BEFORE the doc update, not after"
    check("the pop-before-update is still in orgs_create (drift guard)",
          _pop_is_still_there)

    def _defaults_endpoint():
        clear_defaults()
        r = call(ADMIN, "GET", "/api/defaults")
        assert r.json["net_hub_address"] == net.DEFAULT_HUB_ADDRESS, r.json
        r = call(ADMIN, "POST", "/api/defaults",
                 {"net_hub_address": "  http://typed.test:1234  "})
        assert r.json["net_hub_address"] == "http://typed.test:1234", r.json
        r = call(ADMIN, "POST", "/api/defaults", {"net_hub_address": "   "})
        assert r.json["net_hub_address"] == net.DEFAULT_HUB_ADDRESS, \
            "blanking the field restores the default rather than storing ''"
        clear_defaults()
    check("the defaults endpoint reads, strips and blank-restores the address",
          _defaults_endpoint)


# ===================================================================== §5
def sec_hygiene() -> None:
    print("\n§5  secret hygiene — one endpoint, loopback only")

    def _the_one_endpoint():
        slug = make_org()
        secret = store.load_org(slug).d["net_identity"]["secret"]
        r = call(ADMIN, "GET", f"/api/orgs/{slug}/net")
        assert r.status == 200 and r.json["identity"]["secret"] == secret
    check("GET …/net returns the secret to the loopback admin", _the_one_endpoint)

    def _nowhere_else():
        slug = make_org()
        ident = store.load_org(slug).d["net_identity"]
        secret, fp = ident["secret"], ident["fingerprint"]
        surfaces = [
            "/api/orgs", f"/api/orgs/{slug}", "/api/defaults", "/api/host",
            f"/api/orgs/{slug}/events", f"/api/orgs/{slug}/inbox",
            f"/api/orgs/{slug}/audiences", "/api/charters", "/api/mcp-servers",
        ]
        for p in surfaces:
            r = call(ADMIN, "GET", p)
            assert secret not in r.text, f"THE SECRET LEAKED into {p}"
            assert fp not in r.text, f"the fingerprint leaked into {p}"
    check("no other admin payload carries the secret or the fingerprint",
          _nowhere_else)

    def _not_in_the_tree_object():
        # the tree payload is what reaches the browser AND what shapes an
        # agent's view of its org — checked on the object, not just the route
        slug = make_org()
        ident = store.load_org(slug).d["net_identity"]
        blob = json.dumps(store.load_org(slug).tree())
        assert ident["secret"] not in blob and ident["fingerprint"] not in blob
        assert "net_identity" not in blob
    check("Org.tree() carries no identity at all", _not_in_the_tree_object)

    def _public_gateway_404s():
        # V2 removed kiosks, so no real public token can exist — the door
        # is closed by construction. The gateway CLASS still stands, so pin
        # the belt too: even a presented token (valid-shaped, unknown) gets
        # a 404 with no identity material in the body, for its own org path
        # or anyone else's.
        victim = make_org()
        for path in (f"/k/{'f' * 32}/api/orgs/zz-any/net",
                     f"/k/{'f' * 32}/api/orgs/{victim}/net"):
            r = call(PUBLIC, "GET", path)
            assert r.status == 404, r
            assert "identity" not in r.text and "secret" not in r.text
        assert store.load_org(victim).d["net_identity"]["secret"] \
            not in r.text
    check("☞ the public gateway never reaches …/net (kiosks removed; the "
          "gateway itself still 404s)", _public_gateway_404s)

    def _lazy_backfill():
        # an org created before F-06 has no identity; the first reveal mints
        # one and PERSISTS it (a mint that is not saved would hand out a new
        # address every time the panel is opened)
        slug = make_org()
        with store.DOC_LOCK:
            o = store.load_org(slug)
            o.d.pop("net_identity", None)
            store.save_org(o)
        assert "net_identity" not in store.load_org(slug).d
        r = call(ADMIN, "GET", f"/api/orgs/{slug}/net")
        first = r.json["identity"]
        assert first and first["secret"], r.json
        assert store.load_org(slug).d["net_identity"] == first, \
            "the lazily minted identity was not saved"
        r2 = call(ADMIN, "GET", f"/api/orgs/{slug}/net")
        assert r2.json["identity"] == first, (
            "a second reveal minted a DIFFERENT identity — the address must "
            "be stable from the moment it first exists")
    check("a pre-F-06 org backfills once, on first reveal", _lazy_backfill)

    def _bridge_gateway_closed():
        # the OTHER door out of loopback: V2 removed sandboxed orgs (user
        # decision 2026-09-07), so no org can ever hold a bridge secret —
        # by construction, no bridge caller exists. The gateway CLASS still
        # stands; pin the belt: a bridge-marked request with any secret is
        # refused at …/net and no identity material rides the refusal.
        slug = make_org()
        ident = store.load_org(slug).d["net_identity"]
        got = call(api.BridgeGateway(api.app), "GET",
                   f"/api/orgs/{slug}/net",
                   headers=[("x-orgtree-bridge", "f" * 32)])
        assert got.status in (403, 404), got
        assert ident["secret"] not in got.text, \
            "THE SECRET LEAKED THROUGH THE BRIDGE GATEWAY"
    check("☞ the sandbox bridge never reaches …/net either (sandboxes "
          "removed; the gateway itself still refuses)",
          _bridge_gateway_closed)

    def _unknown_org():
        r = call(ADMIN, "GET", "/api/orgs/zz-no-such-org/net")
        assert r.status == 404, r
    check("an unknown org is a 404, not a mint", _unknown_org)

    def _backfill_leaves_no_hubs():
        # promoted from gap() 2026-08-05: the lazy backfill now writes the
        # FULL default config — identity AND the hub list (chatq precedent:
        # existing orgs join automatically; the opt-out lives in settings).
        # A pre-F-06 org therefore reveals with a usable local entry instead
        # of autoconnect=True over an empty list.
        slug = make_org()
        with store.DOC_LOCK:
            o = store.load_org(slug)
            for k in ("net_identity", "net_hubs", "net_autoconnect"):
                o.d.pop(k, None)
            store.save_org(o)
        r = call(ADMIN, "GET", f"/api/orgs/{slug}/net")
        assert not (r.json["autoconnect"] and not r.json["hubs"]), (
            f"autoconnect={r.json['autoconnect']} with hubs={r.json['hubs']}: "
            f"the org reports that it joins the local hub automatically while "
            f"carrying no entry for it (doc net_hubs present: "
            f"{'net_hubs' in store.load_org(slug).d})")
        d = store.load_org(slug).d
        assert d.get("net_hubs") and d["net_hubs"][0]["id"] == "local", \
            "the doc must persist the backfilled local entry"
        assert d.get("net_autoconnect") is True
    check("a pre-F-06 org backfills identity AND hubs consistently",
          _backfill_leaves_no_hubs)


# ===================================================================== §6
def sec_bundled_hub_sync() -> None:
    """The ONE integration seam this repo adds to the V1 client (itemized in
    the mail-hub ticket): the engine hosts the local hub and names its real
    address in ORGTREE_LOCAL_HUB_ADDRESS. A doc whose implicit local entry
    points elsewhere — a dynamic-port V2 install, an edited port — is
    rewritten to the engine's address, and V1's own address-mismatch
    reconciliation then resets that hub's per-address state (registration
    re-earned, dedupe ring dropped: the ratified bounded-duplicate trade)."""
    print("\n§8  the bundled-hub seam (engine-hosted local hub)")

    def _local_entry_follows_the_engine():
        slug = make_org()
        with store.DOC_LOCK:
            o = store.load_org(slug)
            hubs = [h for h in (o.d.get("net_hubs") or [])]
            assert any(h.get("id") == "local" for h in hubs), \
                "fixture: the org must have an implicit local entry"
            for h in hubs:
                if h.get("id") == "local":
                    h["address"] = "http://127.0.0.1:59999"   # a dead port
            o.d["net_state"] = {"local": {
                "registered_at": "2026-09-01T00:00:00Z",
                "address": "http://127.0.0.1:59999",
                "seen_ids": ["stale-1"]}}
            store.save_org(o)
        os.environ["ORGTREE_LOCAL_HUB_ADDRESS"] = "http://127.0.0.1:7411"
        try:
            net._participants()
            d = store.load_org(slug).d
            local = next(h for h in d["net_hubs"] if h.get("id") == "local")
            assert local["address"] == "http://127.0.0.1:7411", local
            # the state cell described the OLD address; V1's reconciliation
            # must have dropped it so registration is re-earned at the new one
            assert "local" not in (d.get("net_state") or {}), d.get("net_state")
        finally:
            os.environ.pop("ORGTREE_LOCAL_HUB_ADDRESS", None)
    check("a stale local-entry address is rewritten to the engine's, and "
          "that hub's per-address state resets", _local_entry_follows_the_engine)

    def _default_address_honors_the_engine():
        # an EXPLICIT defaults.json address still wins (user config outranks
        # the engine); clear it so this measures the seam itself
        write_defaults(net_hub_address="")
        os.environ["ORGTREE_LOCAL_HUB_ADDRESS"] = "http://127.0.0.1:7412"
        try:
            assert net._default_address() == "http://127.0.0.1:7412"
        finally:
            os.environ.pop("ORGTREE_LOCAL_HUB_ADDRESS", None)
    check("_default_address prefers the engine's bundled-hub address over "
          "the built-in default", _default_address_honors_the_engine)


def sec_username() -> None:
    print("\n§6  username sanitization — the address keeps three parts")

    def _sanitize():
        assert net._sanitize_user("Alice") == "alice"
        assert net._sanitize_user("first.last") == "first-last", \
            "a dot in the username would add a fourth part to the address"
        assert net._sanitize_user("a b/c\\d:e") == "a-b-c-d-e"
        assert net._sanitize_user("keep_me-1") == "keep_me-1"
        assert net._sanitize_user("--edges--") == "edges"
        for empty in ("", "   ", "...", "!!!", "----"):
            assert net._sanitize_user(empty) == "user", empty
    check("dots and specials collapse to '-', empty falls back to 'user'",
          _sanitize)

    def _three_parts_whatever_the_user():
        import getpass
        real = getpass.getuser
        for uname in ("first.last", "WEIRD USER!", "", "a.b.c.d.e", "ünïcodé"):
            getpass.getuser = lambda u=uname: u
            try:
                org = Org.create(f"zz uname {abs(hash(uname)) % 9999}",
                                 dirs=["E:/work"])
                i = net.mint_identity(org)
                assert i is not None
                assert len(i["slug"].split(".")) == 3, \
                    f"username {uname!r} produced {i['slug']!r}"
                assert i["slug"].split(".")[1] == net._sanitize_user(uname)
            finally:
                getpass.getuser = real
    check("any host username still yields a three-part address",
          _three_parts_whatever_the_user)

    def _slug_is_lowercase_and_safe():
        import getpass
        real = getpass.getuser
        getpass.getuser = lambda: "MiXeD.Case"
        try:
            org = Org.create("zz case org", dirs=["E:/work"])
            i = net.mint_identity(org)
            assert i is not None and i["slug"] == i["slug"].lower()
            assert re.fullmatch(r"[a-z0-9_.-]+", i["slug"]), i["slug"]
        finally:
            getpass.getuser = real
    check("the address is lowercase and URL-safe throughout",
          _slug_is_lowercase_and_safe)


def main() -> int:
    print("orgtree · @net Phase A — identity + hub configuration (F-06)")
    sec_mint()
    sec_kiosk()
    sec_hubs()
    sec_defaults()
    sec_hygiene()
    sec_username()
    sec_bundled_hub_sync()

    print()
    if GAPS:
        print("known gaps (asserted as failing on purpose — promote when fixed):")
        for label, why, saw in GAPS:
            print(f"  ⚑ {label}\n      why: {why}\n      saw: {saw}")
        print()
    if FAIL:
        for label, tb in FAIL:
            print(f"\n✗ {label}\n{tb}")
        print(f"net-identity: {PASS} passed · {len(FAIL)} FAILED · {len(GAPS)} gaps")
        return 1
    print(f"net-identity: all {PASS} checks passed"
          + (f" · {len(GAPS)} known gaps" if GAPS else ""))
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    sys.exit(rc)
