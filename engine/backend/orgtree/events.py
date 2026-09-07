# pyright: strict
"""Canonical typed messages — the runtime half of the generator (design:
feature-fable/typed-message-architecture-backend.md VERSION 5, approved 2026-09-06).

`events_table.py` is the ONE declarative source. This module turns it into:
  * strict recursive validators for every leaf (private `Event`) and its visitor
    projection (`PublicEvent`);
  * `mint()` — the ONLY constructor; validates BEFORE anything is written;
  * the row codec (`encode_row_ev` / `decode_row_ev`) that elides a body the row
    already holds, and the bare codec (`encode_ev` / `decode_ev`) that never elides;
  * the lenient decoder used by every reader (`decode`) — legacy / ok / unsupported /
    malformed, with a STATIC error (code, path, expected), never a value;
  * the public projection (`public_event`) and its validator;
  * `FAMILY_OF`, the manifest, and the text emitters consumed by tools/gen_events.py.

Nothing here parses `body`/`text`. Nothing here imports the ledger (the ledger imports
this), so `EventInvalid` is a plain ValueError; the API boundary catches it beside
LedgerError.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Mapping
from typing import Any, Final

from . import events_table as T

EVENT_V: Final = T.EVENT_V
FAMILIES: Final = T.FAMILIES
DISPOSITIONS: Final = ("both", "human_only", "model_only", "internal")
PUBLIC_OK_DISPOSITIONS: Final = ("both", "human_only")
ERROR_CODES: Final = ("unknown_version", "unknown_variant", "missing_field", "extra_field",
                      "wrong_type", "min_length", "bad_ref", "bad_literal", "not_finite",
                      "bad_structure")


class EventInvalid(ValueError):
    """Refused at mint or at a strict decode. `code`, `path`, `expected` are STATIC —
    never the offending value (a key path can be shown to an operator; a value must not
    reach anyone the event was not for)."""

    def __init__(self, code: str, path: str, expected: str) -> None:
        assert code in ERROR_CODES, code
        super().__init__(f"{code} at {path or '<root>'} (expected {expected})")
        self.code = code
        self.path = path
        self.expected = expected

    def public(self) -> dict[str, str]:
        return {"code": self.code}

    def admin(self) -> dict[str, str]:
        return {"code": self.code, "path": self.path, "expected": self.expected}


class TableInvalid(RuntimeError):
    """The declarative table itself is malformed. Raised at import (the generator refuses
    to emit anything) — this refusal IS the visitor boundary (design §4)."""


# ============================================================================ type specs
_LIT = re.compile(r"^L\[(.+)\]$")
_LIST = re.compile(r"^\[(.+)\](?:\{(\d+)\})?$")


def parse_type(spec: str) -> dict[str, Any]:
    """`str` `int` `float` `bool` `<T>?` `[<T>]` `[<T>]{n}` `L[a|b]` `R:Name` `N:Name`
    `U:Name` `E:Event` → a small tree. Refuses anything else."""
    nullable = False
    if spec.endswith("?"):
        nullable, spec = True, spec[:-1]
    m = _LIST.match(spec)
    if m:
        inner, mn = m.group(1), m.group(2)
        return {"k": "list", "of": parse_type(inner), "min": int(mn) if mn else 0,
                "null": nullable}
    m = _LIT.match(spec)
    if m:
        return {"k": "lit", "vals": tuple(m.group(1).split("|")), "null": nullable}
    if spec in ("str", "int", "float", "bool", "null"):
        return {"k": spec, "null": nullable}
    for pfx, k in (("R:", "ref"), ("N:", "rec"), ("U:", "union"), ("E:", "event")):
        if spec.startswith(pfx):
            return {"k": k, "name": spec[len(pfx):], "null": nullable}
    raise TableInvalid(f"unparseable type spec {spec!r}")


def _type_name(t: Mapping[str, Any]) -> str:
    k = t["k"]
    if k == "list":
        return f"list[{_type_name(t['of'])}]" + (f"{{min {t['min']}}}" if t["min"] else "")
    if k == "lit":
        return "literal[" + "|".join(t["vals"]) + "]"
    if k in ("ref", "rec", "union", "event"):
        return str(t["name"])
    return str(k)


# ========================================================================= table checks
def _check_fields(owner: str, fields: Mapping[str, Any], *, structural: frozenset[str]) -> None:
    for name, f in fields.items():
        if not isinstance(f, dict):
            raise TableInvalid(f"{owner}.{name}: field spec must be a dict")
        fd: dict[str, Any] = f
        for key in ("t", "d", "p"):
            if key not in fd:
                raise TableInvalid(f"{owner}.{name}: missing '{key}' — every field declares "
                                   f"type, disposition AND public visibility; there is no default")
        if fd["d"] not in DISPOSITIONS:
            raise TableInvalid(f"{owner}.{name}: disposition {fd['d']!r} not in {DISPOSITIONS}")
        if not isinstance(fd["p"], bool):
            raise TableInvalid(f"{owner}.{name}: public must be a bool")
        if fd["p"] and fd["d"] not in PUBLIC_OK_DISPOSITIONS:
            raise TableInvalid(f"{owner}.{name}: public:true on a {fd['d']} field — a visitor "
                               f"may only see what a human renderer may show")
        if "x" in fd and not fd["p"]:
            raise TableInvalid(f"{owner}.{name}: public_exempt on a non-public field")
        if name in structural and not fd["p"]:
            raise TableInvalid(f"{owner}.{name}: structural key must be public (by rule)")
        if name in structural and "x" in fd:
            raise TableInvalid(f"{owner}.{name}: structural key must not carry public_exempt")
        t = parse_type(str(fd["t"]))
        _check_type_refs(owner + "." + name, t)


def _check_type_refs(where: str, t: Mapping[str, Any]) -> None:
    k = t["k"]
    if k == "list":
        _check_type_refs(where, t["of"])
    elif k == "ref" and t["name"] not in T.REFS:
        raise TableInvalid(f"{where}: unknown ref {t['name']!r}")
    elif k == "rec" and t["name"] not in T.RECORDS and t["name"] != "Actor":
        raise TableInvalid(f"{where}: unknown record {t['name']!r}")
    elif k == "union" and t["name"] not in T.UNIONS:
        raise TableInvalid(f"{where}: unknown union {t['name']!r}")
    elif k == "event" and t["name"] != "Event":
        raise TableInvalid(f"{where}: only E:Event is recursive")


def check_table(table: Any = T) -> None:
    """Refuse a malformed table. Run at import; the tests also run it over deliberately
    broken tables (B15 positive controls)."""
    kind_only = frozenset({"kind"})
    for rname, rf in table.REFS.items():
        if "kind" not in rf:
            raise TableInvalid(f"ref {rname} lacks the structural 'kind'")
        _check_fields("ref " + rname, rf, structural=kind_only)
    for rname, rf in table.RECORDS.items():
        _check_fields("record " + rname, rf, structural=frozenset())
    for uname, members in table.UNIONS.items():
        for mname in members:
            if mname not in table.RECORDS or "kind" not in table.RECORDS[mname]:
                raise TableInvalid(f"union {uname}: member {mname} must be a record with 'kind'")
            kf = table.RECORDS[mname]["kind"]
            if not kf["p"] or parse_type(kf["t"])["k"] != "lit":
                raise TableInvalid(f"union {uname}: {mname}.kind must be a public literal")
    _check_fields("envelope", table.ENVELOPE, structural=frozenset({"v", "variant"}))
    _check_fields("actor", table.ACTOR, structural=kind_only)
    for variant, spec in table.LEAVES.items():
        if not re.fullmatch(r"[a-z_]+\.[a-z_]+", variant):
            raise TableInvalid(f"leaf {variant!r}: name must be <group>.<leaf>")
        if spec["family"] not in table.FAMILIES:
            raise TableInvalid(f"leaf {variant}: family {spec['family']!r} not in FAMILIES")
        obj = spec["object"]
        if obj is not None and obj not in table.REFS:
            raise TableInvalid(f"leaf {variant}: object ref {obj!r} unknown")
        for reserved in ("v", "variant", "actor", "object", "engine_authored", "projection"):
            if reserved in spec["fields"]:
                raise TableInvalid(f"leaf {variant}: field {reserved!r} is an envelope key")
        _check_fields("leaf " + variant, spec["fields"], structural=frozenset())


check_table()

FAMILY_OF: Final[dict[str, str]] = {v: s["family"] for v, s in T.LEAVES.items()}
VARIANTS: Final[tuple[str, ...]] = tuple(T.LEAVES)


def leaf_fields(variant: str) -> dict[str, dict[str, Any]]:
    """The complete field map of a leaf: envelope + object + its own fields, in wire order."""
    spec = T.LEAVES[variant]
    obj = spec["object"]
    out: dict[str, dict[str, Any]] = dict(T.ENVELOPE)
    out["object"] = T.F(f"R:{obj}" if obj else "null", "both", True)
    out.update(spec["fields"])
    return out


# ============================================================================ validation
def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_float(v: Any) -> bool:
    return (isinstance(v, float) or _is_int(v)) and not isinstance(v, bool)


def _validate(value: Any, t: Mapping[str, Any], path: str, *, public: bool) -> None:
    if value is None:
        if t.get("null") or t["k"] == "null":
            return
        raise EventInvalid("wrong_type", path, _type_name(t))
    k = t["k"]
    if k == "null":
        raise EventInvalid("wrong_type", path, "null")
    if k == "str":
        if not isinstance(value, str):
            raise EventInvalid("wrong_type", path, "str")
    elif k == "int":
        if not _is_int(value):
            raise EventInvalid("wrong_type", path, "int")
    elif k == "float":
        if not _is_float(value):
            raise EventInvalid("wrong_type", path, "float")
        if not math.isfinite(float(value)):
            raise EventInvalid("not_finite", path, "finite float")
    elif k == "bool":
        if not isinstance(value, bool):
            raise EventInvalid("wrong_type", path, "bool")
    elif k == "lit":
        if not isinstance(value, str) or value not in t["vals"]:
            raise EventInvalid("bad_literal", path, _type_name(t))
    elif k == "list":
        if not isinstance(value, list):
            raise EventInvalid("wrong_type", path, _type_name(t))
        items: list[Any] = value
        if len(items) < int(t["min"]):
            raise EventInvalid("min_length", path, f"≥{t['min']} items")
        for i, item in enumerate(items):
            _validate(item, t["of"], f"{path}[{i}]", public=public)
    elif k == "ref":
        _validate_record(value, T.REFS[t["name"]], path, str(t["name"]), public=public)
    elif k == "rec":
        fields = T.ACTOR if t["name"] == "Actor" else T.RECORDS[t["name"]]
        _validate_record(value, fields, path, str(t["name"]), public=public)
    elif k == "union":
        if not isinstance(value, dict):
            raise EventInvalid("wrong_type", path, str(t["name"]))
        d: dict[str, Any] = value
        member = next((m for m in T.UNIONS[t["name"]]
                       if d.get("kind") in parse_type(T.RECORDS[m]["kind"]["t"])["vals"]), None)
        if member is None:
            raise EventInvalid("bad_literal", path + ".kind",
                               "|".join(T.UNIONS[t["name"]]))
        _validate_record(d, T.RECORDS[member], path, member, public=public)
    elif k == "event":
        if public:
            validate_public_event(value, path)
        else:
            validate_event(value, path)
    else:  # pragma: no cover — parse_type refuses unknown kinds
        raise TableInvalid(f"unknown kind {k}")


def _validate_record(value: Any, fields: Mapping[str, Mapping[str, Any]], path: str,
                     name: str, *, public: bool) -> None:
    if not isinstance(value, dict):
        raise EventInvalid("wrong_type", path, name)
    d: dict[str, Any] = value
    want = {n: f for n, f in fields.items() if (f["p"] if public else True)}
    for n in want:
        if n not in d:
            raise EventInvalid("missing_field", f"{path}.{n}" if path else n, name)
    for n in d:
        if n not in want:
            raise EventInvalid("extra_field", f"{path}.{n}" if path else n, name)
    for n, f in want.items():
        _validate(d[n], parse_type(str(f["t"])), f"{path}.{n}" if path else n, public=public)


def validate_event(ev: Any, path: str = "") -> str:
    """Strict: raises EventInvalid. Returns the variant."""
    if not isinstance(ev, dict):
        raise EventInvalid("wrong_type", path, "Event")
    d: dict[str, Any] = ev
    v = d.get("v")
    if not _is_int(v):
        raise EventInvalid("wrong_type", f"{path}.v" if path else "v", "int")
    if v > EVENT_V:
        raise EventInvalid("unknown_version", f"{path}.v" if path else "v", f"≤{EVENT_V}")
    if v < EVENT_V:
        raise EventInvalid("unknown_version", f"{path}.v" if path else "v", str(EVENT_V))
    variant = d.get("variant")
    if not isinstance(variant, str) or variant not in T.LEAVES:
        raise EventInvalid("unknown_variant", f"{path}.variant" if path else "variant", "Event")
    if "projection" in d:
        raise EventInvalid("extra_field", f"{path}.projection" if path else "projection", variant)
    _validate_record(d, leaf_fields(variant), path, variant, public=False)
    if T.LEAVES[variant]["object"] is None and d.get("object") is not None:
        raise EventInvalid("bad_ref", f"{path}.object" if path else "object", "null")
    actor: dict[str, Any] = d["actor"]
    if d["engine_authored"] != (actor["kind"] == "system"):
        raise EventInvalid("bad_structure", f"{path}.engine_authored" if path else
                           "engine_authored", "actor.kind == system")
    return variant


def validate_public_event(ev: Any, path: str = "") -> str:
    if not isinstance(ev, dict):
        raise EventInvalid("wrong_type", path, "PublicEvent")
    d: dict[str, Any] = ev
    if d.get("projection") != "public":
        raise EventInvalid("bad_structure", f"{path}.projection" if path else "projection",
                           "public")
    v = d.get("v")
    if not _is_int(v) or v != EVENT_V:
        raise EventInvalid("unknown_version", f"{path}.v" if path else "v", str(EVENT_V))
    variant = d.get("variant")
    if not isinstance(variant, str) or variant not in T.LEAVES:
        raise EventInvalid("unknown_variant", f"{path}.variant" if path else "variant",
                           "PublicEvent")
    fields = {n: f for n, f in leaf_fields(variant).items()}
    fields["projection"] = T.F("L[public]", "both", True)
    _validate_record(d, fields, path, variant, public=True)
    return variant


# ================================================================================= mint
def _leaf_object_type(variant: str) -> str | None:
    return T.LEAVES[variant]["object"]


def mint(variant: str, actor: Mapping[str, Any], object: Mapping[str, Any] | None,
         **fields: Any) -> dict[str, Any]:
    """THE ONLY CONSTRUCTOR. `variant` must be a string literal at every call site (the
    coverage test enforces it by AST); the result is validated before it is returned, so
    a producer that gets an EventInvalid has written nothing."""
    if variant not in T.LEAVES:
        raise EventInvalid("unknown_variant", "variant", "Event")
    a = dict(actor)
    ev: dict[str, Any] = {"v": EVENT_V, "variant": variant, "actor": a,
                          "object": dict(object) if object is not None else None,
                          "engine_authored": a.get("kind") == "system"}
    ev.update(fields)
    validate_event(ev)
    return ev


# ================================================================================ codecs
def encode_ev(ev: Mapping[str, Any]) -> dict[str, Any]:
    """A BARE event — journal segments, span snapshots, digest members, API rows: always
    serialised IN FULL (design §5, Opus E1)."""
    validate_event(ev)
    return json.loads(json.dumps(ev))


def decode_ev(raw: Any) -> dict[str, Any]:
    validate_event(raw)
    return json.loads(json.dumps(raw))


def encode_row_ev(ev: Mapping[str, Any], row: Mapping[str, Any]) -> dict[str, Any]:
    """The ROW encoder: for leaves whose `body` is by definition the row's body, the
    duplicate is elided; `decode_row_ev` restores it from the frozen row text."""
    out = encode_ev(ev)
    for name in T.ELIDED_FIELDS.get(str(ev["variant"]), ()):
        body_key = "text" if "text" in row and "body" not in row else "body"
        if out.get(name) != row.get(body_key):
            raise EventInvalid("bad_structure", name, f"== row.{body_key}")
        del out[name]
    return out


def decode_row_ev(raw: Mapping[str, Any], row: Mapping[str, Any]) -> dict[str, Any]:
    d = json.loads(json.dumps(raw))
    variant = d.get("variant")
    if isinstance(variant, str):
        for name in T.ELIDED_FIELDS.get(variant, ()):
            if name not in d:
                body_key = "text" if "text" in row and "body" not in row else "body"
                d[name] = row.get(body_key)
    validate_event(d)
    return d


# ======================================================================= lenient decode
def decode(raw: Any, row: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Every READER's decoder. Never raises. Returns
    {status: legacy|ok|unsupported|malformed, ev?, error?} where `error` is the STATIC
    admin error {code, path, expected}."""
    if raw is None:
        return {"status": "legacy"}
    try:
        ev = decode_row_ev(raw, row) if row is not None else decode_ev(raw)
    except EventInvalid as e:
        st = "unsupported" if e.code in ("unknown_version", "unknown_variant") else "malformed"
        return {"status": st, "error": e.admin()}
    except Exception:                                            # noqa: BLE001
        return {"status": "malformed", "error": {"code": "bad_structure", "path": "",
                                                  "expected": "Event"}}
    return {"status": "ok", "ev": ev}


# ====================================================================== public projection
def _project(value: Any, t: Mapping[str, Any]) -> Any:
    if value is None:
        return None
    k = t["k"]
    if k == "list":
        items: list[Any] = value
        return [_project(x, t["of"]) for x in items]
    if k == "ref":
        return _project_record(value, T.REFS[t["name"]])
    if k == "rec":
        return _project_record(value, T.ACTOR if t["name"] == "Actor" else T.RECORDS[t["name"]])
    if k == "union":
        d: dict[str, Any] = value
        member = next(m for m in T.UNIONS[t["name"]]
                      if d.get("kind") in parse_type(T.RECORDS[m]["kind"]["t"])["vals"])
        return _project_record(d, T.RECORDS[member])
    if k == "event":
        return public_event(value)
    return value


def _project_record(d: Mapping[str, Any], fields: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    return {n: _project(d[n], parse_type(str(f["t"]))) for n, f in fields.items() if f["p"]}


def public_event(ev: Mapping[str, Any]) -> dict[str, Any]:
    """The visitor projection: a complete PublicEvent (own validator), never a private leaf
    with holes. Validates the input first and its own output last — a public shape that
    fails its own schema is an error, never a leak (design §6 mechanic ii)."""
    variant = validate_event(ev)
    out: dict[str, Any] = {"projection": "public"}
    out.update(_project_record(ev, leaf_fields(variant)))
    # wire order: v, variant, projection, then the rest
    ordered: dict[str, Any] = {"v": out.pop("v"), "variant": out.pop("variant"),
                               "projection": out.pop("projection")}
    ordered.update(out)
    validate_public_event(ordered)
    return ordered


# ======================================================================== wire helpers
SEGMENT_KINDS: Final = ("notices", "mail", "state", "drive", "text")
DELIVERY_MODES: Final = ("turn", "steer", "boundary", "reconcile", "rehire", "idle_only")

#: Step 4 (design §8): the qualified reply target a client may send — identity keys
#: ONLY. Mirrors the `ReplyTarget` union emitted to events.ts; `parse_reply_target`
#: is the one validator (the routes call it, the TS type is generated beside it).
REPLY_TARGET_KINDS: Final = ("mail", "document", "work_item")
REPLY_TARGET_BOXES: Final = ("user", "org", "node")
_REPLY_TARGET_KEYS: Final[dict[str, tuple[str, ...]]] = {
    "mail": ("org", "box", "id"), "document": ("org", "id"), "work_item": ("org", "slug")}


def parse_reply_target(raw: Any) -> dict[str, str]:
    """Strict shape check of a client `target` (design §8 / B12): a mapping with
    `kind` in the closed enum, exactly the identity keys of that kind (plus `node`
    iff box == "node"), every value a non-empty string. No title, gist, sender or
    at — a client that sends one is refused, never silently stripped. Refusal is an
    EventInvalid with a static {code, path, expected}; the route turns it into 422."""
    if not isinstance(raw, Mapping):
        raise EventInvalid("bad_structure", "target", "object")
    kind = raw.get("kind")
    if kind not in REPLY_TARGET_KINDS:
        raise EventInvalid("bad_literal", "target.kind", "|".join(REPLY_TARGET_KINDS))
    want = set(_REPLY_TARGET_KEYS[kind]) | {"kind"}
    if kind == "mail":
        box = raw.get("box")
        if box not in REPLY_TARGET_BOXES:
            raise EventInvalid("bad_literal", "target.box", "|".join(REPLY_TARGET_BOXES))
        if box == "node":
            want.add("node")
    extra = sorted(set(raw) - want)
    if extra:
        raise EventInvalid("extra_field", f"target.{extra[0]}", "absent")
    missing = sorted(want - set(raw))
    if missing:
        raise EventInvalid("missing_field", f"target.{missing[0]}", "str")
    out: dict[str, str] = {}
    for k in sorted(want):
        v = raw[k]
        if not isinstance(v, str) or not v.strip():
            raise EventInvalid("wrong_type", f"target.{k}", "non-empty str")
        out[k] = v
    return out


def wire_row(row: Mapping[str, Any], *, public: bool) -> dict[str, Any]:
    """The WIRE projection of one stored mail / notice / user-inbox row (design §6):
    the stored `ev` is ROW-ENCODED (an ordinary body is elided) and never crosses the
    wire in that form. Emits, for the operator, `ev` = the FULL event (or `ev_raw` +
    static `ev_error`; nothing on a legacy row); for a visitor, `ev_public` = the
    PublicEvent (or `ev_error` = {code}); never both, never `ev`/`ev_raw` publicly.
    body/text are untouched."""
    out = {k: v for k, v in row.items() if k != "ev"}
    raw = row.get("ev")
    if raw is None:
        return out
    r = decode(raw, row)
    if r["status"] == "ok":
        if public:
            out["ev_public"] = public_event(r["ev"])
        else:
            out["ev"] = encode_ev(r["ev"])
    else:
        if public:
            out["ev_error"] = {"code": r["error"]["code"]}
        else:
            out["ev_raw"] = raw
            out["ev_error"] = r["error"]
    return out


def journal_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """A row as a journal/projection SEGMENT stores it: the FULL event (bare codec —
    these copies must outlive the mail_log cap, Opus E1)."""
    return wire_row(row, public=False)


def wire_segments(segments: list[Mapping[str, Any]] | None, *,
                  public: bool) -> list[dict[str, Any]] | None:
    """Project a stored segment list for the wire. Segments store FULL events; the
    operator gets them as stored, a visitor gets PublicEvent / withheld."""
    if segments is None:
        return None
    out: list[dict[str, Any]] = []
    for seg in segments:
        k = str(seg.get("kind") or "")
        if k in ("notices", "mail"):
            rows = [dict(r) for r in seg.get("rows") or []]
            if public:
                proj: list[dict[str, Any]] = []
                for r in rows:
                    ev = r.pop("ev", None)
                    r.pop("ev_raw", None)
                    err = r.pop("ev_error", None)
                    if ev is not None:
                        try:
                            r["ev_public"] = public_event(ev)
                        except EventInvalid as e:
                            r["ev_error"] = e.public()
                    elif err is not None:
                        r["ev_error"] = {"code": str(err.get("code") or "bad_structure")}
                    proj.append(r)
                rows = proj
            out.append({"kind": k, "rows": rows})
        elif k in ("state", "drive"):
            ev = seg.get("event")
            item: dict[str, Any] = {"kind": k, "text": str(seg.get("text") or "")}
            if ev is not None:
                try:
                    item["event_public" if public else "event"] = (
                        public_event(ev) if public else encode_ev(ev))
                except EventInvalid as e:
                    item["ev_error"] = e.public() if public else e.admin()
            out.append(item)
        elif k == "text":
            out.append({"kind": "text", "text": str(seg.get("text") or "")})
    return out


# ============================================================================ manifest
def human_hidden_variants() -> list[str]:
    """Leaves whose EVERY own field is model_only/internal — the machine-state and
    instruction segments (coordinator ruling 2026-09-06 21:35Z): they keep their
    canonical event and agent rendering, but a human transcript shows NO card for them
    (not a heading-only stub). Derived from the dispositions, so it is typed policy —
    a leaf becomes hidden by declaring every field model_only, never by name, and a
    leaf with one human-visible field is shown. Leaves with no own fields are NOT
    hidden: their variant is their content (e.g. policy.unstuck)."""
    out: list[str] = []
    for v in VARIANTS:
        own = T.LEAVES[v]["fields"]
        if own and all(f["d"] in ("model_only", "internal") for f in own.values()):
            out.append(v)
    return out


def manifest() -> dict[str, Any]:
    """Every field of every leaf/ref/record with its type, disposition, public flag and
    exemption — the reviewable table (design §4, B16 packet table)."""
    def fmap(fields: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        return {n: {"type": f["t"], "disposition": f["d"], "public": f["p"],
                    **({"public_exempt": f["x"]} if "x" in f else {})}
                for n, f in fields.items()}
    return {
        "v": EVENT_V,
        "families": list(FAMILIES),
        "structural": sorted(T.STRUCTURAL),
        "actor": fmap(T.ACTOR),
        "refs": {n: fmap(f) for n, f in T.REFS.items()},
        "records": {n: fmap(f) for n, f in T.RECORDS.items()},
        "unions": {n: list(m) for n, m in T.UNIONS.items()},
        "leaves": {v: {"family": FAMILY_OF[v], "object": T.LEAVES[v]["object"],
                       "fields": fmap(leaf_fields(v))} for v in VARIANTS},
        "elided_row_fields": {k: list(v) for k, v in T.ELIDED_FIELDS.items()},
        "human_hidden": human_hidden_variants(),
    }


def public_string_fields(variant: str) -> list[tuple[str, str | None]]:
    """(path, exemption) for every TABLE-marked public string field of a leaf, recursively —
    the domain of the B16 disclosure invariant. Structural keys are excluded by
    construction (they are public by rule, not by the column)."""
    out: list[tuple[str, str | None]] = []

    def walk(fields: Mapping[str, Mapping[str, Any]], prefix: str, structural: frozenset[str]) -> None:
        for n, f in fields.items():
            if not f["p"] or n in structural:
                continue
            path = f"{prefix}.{n}" if prefix else n
            t = parse_type(str(f["t"]))
            base = t["of"] if t["k"] == "list" else t
            if base["k"] == "str":
                out.append((path, f.get("x")))
            elif base["k"] == "ref":
                walk(T.REFS[base["name"]], path, frozenset({"kind"}))
            elif base["k"] == "rec":
                walk(T.ACTOR if base["name"] == "Actor" else T.RECORDS[base["name"]], path,
                     frozenset({"kind"}) if base["name"] == "Actor" else frozenset())
            elif base["k"] == "union":
                for m in T.UNIONS[base["name"]]:
                    walk(T.RECORDS[m], path, frozenset({"kind"}))
            # literals, numbers, bools, recursive events: outside the invariant's scope
    walk(leaf_fields(variant), "", frozenset({"v", "variant"}))
    return out


# =========================================================================== rendering
RENDERERS: dict[str, Callable[[Mapping[str, Any]], str]] = {}


def renderer(variant: str) -> Callable[[Callable[[Mapping[str, Any]], str]],
                                        Callable[[Mapping[str, Any]], str]]:
    """Register the ONE deterministic agent-text renderer for a leaf (events_render.py)."""
    if variant not in T.LEAVES:
        raise TableInvalid(f"renderer for unknown leaf {variant!r}")

    def deco(fn: Callable[[Mapping[str, Any]], str]) -> Callable[[Mapping[str, Any]], str]:
        if variant in RENDERERS:
            raise TableInvalid(f"duplicate renderer for {variant}")
        RENDERERS[variant] = fn
        return fn
    return deco


def render_agent(ev: Mapping[str, Any]) -> str:
    """The deterministic agent-text projection of a validated event. Called ONCE at mint
    by the producer paths (the row body is frozen thereafter — design I1)."""
    variant = validate_event(ev)
    fn = RENDERERS.get(variant)
    if fn is None:
        raise TableInvalid(f"no renderer registered for {variant}")
    return fn(ev)


from . import events_render as _render_module  # noqa: E402,F401  (registers RENDERERS)

_missing = [v for v in VARIANTS if v not in RENDERERS]
if _missing:
    raise TableInvalid(f"{len(_missing)} leaves have no renderer: {_missing[:5]}…")


# ============================================================================ emitters
def _ts_type(t: Mapping[str, Any], public: bool) -> str:
    k = t["k"]
    base: str
    if k == "null":
        return "null"
    if k == "str":
        base = "string"
    elif k in ("int", "float"):
        base = "number"
    elif k == "bool":
        base = "boolean"
    elif k == "lit":
        base = " | ".join(json.dumps(v) for v in t["vals"])
    elif k == "list":
        base = f"Array<{_ts_type(t['of'], public)}>"
    elif k in ("ref", "rec", "union"):
        base = ("Public" if public else "") + str(t["name"])
    elif k == "event":
        base = "PublicEvent" if public else "Event"
    else:  # pragma: no cover
        raise TableInvalid(k)
    return f"{base} | null" if t.get("null") else base


def _ts_iface(name: str, fields: Mapping[str, Mapping[str, Any]], public: bool) -> str:
    lines = [f"export interface {('Public' if public else '')}{name} {{"]
    for n, f in fields.items():
        if public and not f["p"]:
            continue
        lines.append(f"  {n}: {_ts_type(parse_type(str(f['t'])), public)};")
    lines.append("}")
    return "\n".join(lines)


def _ts_leaf_name(variant: str) -> str:
    return "".join(p.capitalize() for p in re.split(r"[._]", variant))


def emit_typescript() -> str:
    out: list[str] = ["// GENERATED by tools/gen_events.py from backend/orgtree/events_table.py",
                      "// — DO NOT EDIT. The backend table is the only source of truth.",
                      f"export const EVENT_V = {EVENT_V} as const;",
                      "export const FAMILIES = " + json.dumps(list(FAMILIES)) + " as const;",
                      "export type Family = (typeof FAMILIES)[number];", ""]
    for public in (False, True):
        pfx = "Public" if public else ""
        out.append(f"// ---- {'PUBLIC (visitor) projection' if public else 'PRIVATE (operator) shape'}")
        out.append(_ts_iface("Actor", T.ACTOR, public))
        for n, f in T.REFS.items():
            out.append(_ts_iface(n, f, public))
        for n, f in T.RECORDS.items():
            out.append(_ts_iface(n, f, public))
        for n, m in T.UNIONS.items():
            out.append(f"export type {pfx}{n} = " + " | ".join(pfx + x for x in m) + ";")
        names: list[str] = []
        for v in VARIANTS:
            fields = leaf_fields(v)
            if public:
                fields = {**fields, "projection": T.F("L[public]", "both", True)}
            lf = _ts_leaf_name(v)
            names.append(pfx + lf)
            lines = [f"export interface {pfx}{lf} {{", f"  v: {EVENT_V};",
                     f"  variant: {json.dumps(v)};"]
            if public:
                lines.append('  projection: "public";')
            for n, f in fields.items():
                if n in ("v", "variant", "projection") or (public and not f["p"]):
                    continue
                lines.append(f"  {n}: {_ts_type(parse_type(str(f['t'])), public)};")
            lines.append("}")
            out.append("\n".join(lines))
        out.append(f"export type {pfx}Event =\n  | " + "\n  | ".join(names) + ";")
        out.append("")
    out.append("""// ---- WIRE rows, segments and the delivery envelope (design §6)
export type EvError = { code: string; path: string; expected: string };
export type PublicEvError = { code: string };
export interface WireMailRow {
  id?: string; from: string; kind: string; body: string; at: string;
  relationship?: string | null; attachments?: unknown[]; attachments_missing?: string[];
  reply_to?: Record<string, unknown>; model_only?: boolean; retracted?: boolean;
  delivering?: boolean; via?: string; stage?: string; ref?: string;
  ev?: Event; ev_raw?: unknown; ev_error?: EvError;
}
export interface PublicWireMailRow {
  id?: string; from: string; kind: string; body: string; at: string;
  relationship?: string | null; attachments?: unknown[]; attachments_missing?: string[];
  reply_to?: Record<string, unknown>; retracted?: boolean; delivering?: boolean;
  via?: string; stage?: string; ref?: string;
  ev_public?: PublicEvent; ev_error?: PublicEvError;
}
export interface WireNoticeRow { at: string; text: string; ev?: Event; ev_raw?: unknown; ev_error?: EvError; }
export interface PublicWireNoticeRow { at: string; text: string; ev_public?: PublicEvent; ev_error?: PublicEvError; }
export type Segment =
  | { kind: "notices"; rows: WireNoticeRow[] }
  | { kind: "mail"; rows: WireMailRow[] }
  | { kind: "state"; event?: Event; text: string; ev_error?: EvError }
  | { kind: "drive"; event?: Event; text: string; ev_error?: EvError }
  | { kind: "text"; text: string };
export type PublicSegment =
  | { kind: "notices"; rows: PublicWireNoticeRow[] }
  | { kind: "mail"; rows: PublicWireMailRow[] }
  | { kind: "state"; event_public?: PublicEvent; text: string; ev_error?: PublicEvError }
  | { kind: "drive"; event_public?: PublicEvent; text: string; ev_error?: PublicEvError }
  | { kind: "text"; text: string };
export const DELIVERY_MODES = ["turn","steer","boundary","reconcile","rehire","idle_only"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export interface Delivery { mode: DeliveryMode; via: "turn" | "steer"; attempt: number; at: string; }
// ---- STEP 4: the qualified reply target (design §8). IDENTITY KEYS ONLY — the server
// resolves the object and fills the Ref (title/sender/at) itself; any other key is refused.
// Exactly one of `target` / legacy `reply_to` per send.
export const REPLY_TARGET_KINDS = ["mail","document","work_item"] as const;
export type ReplyTarget =
  | { kind: "mail"; org: string; box: "user" | "org" | "node"; node?: string; id: string }
  | { kind: "document"; org: string; id: string }
  | { kind: "work_item"; org: string; slug: string };
// what a typed send returns beside today's result fields: the delivered mail id, its
// `@mail:` ref and the minted event in the caller's projection (never both).
export interface TypedReplyReceipt { id: string; ref: string; ev?: Event; ev_public?: PublicEvent; }
""")
    out.append("export const FAMILY_OF: Record<Event['variant'], Family> = "
               + json.dumps(FAMILY_OF, indent=2) + ";")
    out.append("export const VARIANTS = " + json.dumps(list(VARIANTS), indent=2) + " as const;")
    out.append("export const STRUCTURAL_KEYS = " + json.dumps(sorted(T.STRUCTURAL)) + " as const;")
    out.append("// Machine-only segments (every own field model_only/internal): a human transcript\n"
               "// renders NO card for these — the event and its agent text are kept untouched.\n"
               "// Derived from MANIFEST dispositions; typed policy, never a body pattern.\n"
               "export const HUMAN_HIDDEN_VARIANTS = "
               + json.dumps(human_hidden_variants(), indent=2) + " as const;")
    out.append("export const ELIDED_ROW_FIELDS: Record<string, readonly string[]> = "
               + json.dumps({k: list(v) for k, v in T.ELIDED_FIELDS.items()}, indent=2) + ";")
    out.append("export const MANIFEST = " + json.dumps(manifest(), separators=(",", ":")) + " as const;")
    return "\n".join(out) + "\n"


def _js_type(t: Mapping[str, Any], public: bool) -> dict[str, Any]:
    k = t["k"]
    s: dict[str, Any]
    if k == "null":
        return {"type": "null"}
    if k == "str":
        s = {"type": "string"}
    elif k == "int":
        s = {"type": "integer"}
    elif k == "float":
        s = {"type": "number"}
    elif k == "bool":
        s = {"type": "boolean"}
    elif k == "lit":
        s = {"enum": list(t["vals"])}
    elif k == "list":
        s = {"type": "array", "items": _js_type(t["of"], public)}
        if t["min"]:
            s["minItems"] = t["min"]
    elif k in ("ref", "rec", "union"):
        s = {"$ref": f"#/$defs/{'Public' if public else ''}{t['name']}"}
    elif k == "event":
        s = {"$ref": f"#/$defs/{'Public' if public else ''}Event"}
    else:  # pragma: no cover
        raise TableInvalid(k)
    return {"anyOf": [s, {"type": "null"}]} if t.get("null") else s


def _js_obj(fields: Mapping[str, Mapping[str, Any]], public: bool,
            extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    props: dict[str, Any] = dict(extra or {})
    for n, f in fields.items():
        if public and not f["p"]:
            continue
        props[n] = _js_type(parse_type(str(f["t"])), public)
    return {"type": "object", "properties": props, "required": list(props),
            "additionalProperties": False}


def emit_json_schema() -> dict[str, Any]:
    defs: dict[str, Any] = {}
    for public in (False, True):
        pfx = "Public" if public else ""
        defs[pfx + "Actor"] = _js_obj(T.ACTOR, public)
        for n, f in T.REFS.items():
            defs[pfx + n] = _js_obj(f, public)
        for n, f in T.RECORDS.items():
            defs[pfx + n] = _js_obj(f, public)
        for n, m in T.UNIONS.items():
            defs[pfx + n] = {"oneOf": [{"$ref": f"#/$defs/{pfx}{x}"} for x in m]}
        leaves: list[dict[str, Any]] = []
        for v in VARIANTS:
            fields = leaf_fields(v)
            extra: dict[str, Any] = {"v": {"const": EVENT_V}, "variant": {"const": v}}
            if public:
                extra["projection"] = {"const": "public"}
            fields = {n: f for n, f in fields.items() if n not in ("v", "variant")}
            defs[pfx + _ts_leaf_name(v)] = _js_obj(fields, public, extra)
            leaves.append({"$ref": f"#/$defs/{pfx}{_ts_leaf_name(v)}"})
        defs[pfx + "Event"] = {"oneOf": leaves}
    return {"$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "orgtree-events-v1", "$defs": defs,
            "oneOf": [{"$ref": "#/$defs/Event"}, {"$ref": "#/$defs/PublicEvent"}]}
