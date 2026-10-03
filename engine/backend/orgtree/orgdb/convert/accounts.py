"""``accounts-registry.json`` into the app database and the orgs' own databases (design §2.10,
§5.2 "Accounts").

The registry (registry.py, registry_migration.py) is one JSON document:

  version            1
  accounts           [row]: id, provider, harness, label, credential {kind, path or token_ref,
                     default_config}, identity {...}, auth, mode, enabled, marks {pool: {until,
                     window, observed_at, provenance}}, spend {usd_total, turns, since,
                     updated_at}, tint_ordinal, created_at, registered_from, origin_org
  aliases            {alias: account id}
  id_counters        {provider: the last id number allocated}   (ids are never reused)
  tint_counters      {provider: the last tint ordinal allocated}
  apikey_cutover_at  epoch seconds (registry_migration.run_apikey_cutover)
  migrated_at        epoch seconds (registry_migration.mark_migrated)
  mark_audit         [the last 200 manual mark clears] (registry.clear_mark)

The machine-wide rows (no origin_org) go to the app database: ``accounts``, ``account_marks``,
``account_spend``, with ``account_aliases``, ``account_counters``, ``account_mark_audit`` and the
``app_settings`` columns (accounts_version, apikey_cutover_at, accounts_migrated_at). A row
restricted to one org (origin_org: bindable only there, registry.validate_binding) goes to that
org's own database instead (``org_accounts``, ``org_account_marks``, ``org_account_spend``:
``OrgAccounts``), with no trace in the app database (rev 4, f7).

Exact, like every conversion: rows go through the codec, so an unknown field, or a value of
another shape than its column's, is kept in the row's ``extra`` JSON (§3.0), and the report
names the rows that needed it. ``account_registry_keys`` records the document's top-level keys
in order, each held by its table or column ('v'), null ('n'), or kept whole in ``val`` ('x': a
key this schema does not know, or a container of another shape). The two epoch stamps are
``timestamptz`` to the microsecond, and their ``_text`` columns keep the stored number's exact
JSON text (§3.0: the original text is kept when it is not the canonical form).

``convert_accounts`` writes the machine-wide part in the caller's transaction, reads it back
with ``read_accounts`` and refuses unless it equals the file's machine-wide part. An account
row that is not an object with a text id, or two rows with one id, is a shape no writer makes:
it raises ShapeError, and the design refuses the start on a fault in the accounts (§5.2, §9).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import math
from dataclasses import replace
from typing import Any, Callable, Iterable, Mapping

from .. import codec
from ..codec import Field as F, Rows, ShapeError, Spec
from ..sections import Context, Section, Table, check

REGISTRY_FILE = "accounts-registry.json"

CREDENTIAL = Spec("", (F("kind", "text"), F("path", "text"), F("token_ref", "text"),
                       F("default_config", "bool")))
_ACCOUNT_FIELDS = (
    F("provider", "text"), F("harness", "text"), F("label", "text"),
    F("credential", "obj", spec=CREDENTIAL),
    F("identity", "json"),            # the provider's account description: shapeless (Q1)
    F("auth", "text"), F("mode", "text"), F("enabled", "bool"),
    F("tint_ordinal", "int"), F("created_at", "float"), F("registered_from", "text"),
)
_MARK_FIELDS = (F("until", "float"), F("window", "text"), F("observed_at", "float"),
                F("provenance", "text"))
_SPEND_FIELDS = (F("usd_total", "float"), F("turns", "int"), F("since", "float"),
                 F("updated_at", "float"))

ACCOUNT = Spec("accounts", _ACCOUNT_FIELDS)
MARK = Spec("account_marks", _MARK_FIELDS)
SPEND = Spec("account_spend", _SPEND_FIELDS)
_ORG_CREDENTIAL = replace(CREDENTIAL, fields=tuple(
    replace(f, values=('imported', 'managed', 'token', 'apikey')) if f.key == 'kind' else f
    for f in CREDENTIAL.fields))
_ORG_ENUMS = {'provider': ('claude', 'openai', 'google'),
              'auth': ('authenticated', 'unauthenticated', 'unobserved'),
              'mode': ('subscription', 'apikey')}
ORG_ACCOUNT = Spec("org_accounts", tuple(
    replace(f, values=_ORG_ENUMS[f.key]) if f.key in _ORG_ENUMS else
    replace(f, spec=_ORG_CREDENTIAL) if f.key == 'credential' else f
    for f in _ACCOUNT_FIELDS) + (F("origin_org", "text"),))
ORG_MARK = Spec("org_account_marks", tuple(
    replace(f, values=('observed', 'inferred')) if f.key == 'provenance' else f
    for f in _MARK_FIELDS))
ORG_SPEND = Spec("org_account_spend", _SPEND_FIELDS)
ALIAS = Spec("account_aliases", (F("account_id", "text"),))
ORG_ALIAS = Spec("org_account_aliases", (F("account_id", "text"),))
COUNTER = Spec("account_counters", (F("id_counter", "int"), F("tint_counter", "int")))
_AUDIT_FIELDS = (
    F("at", "float"), F("actor", "text"), F("org", "text"), F("via", "text"),
    F("account", "text"), F("source", "text"), F("pool", "text"),
    F("cleared", "json"), F("kept", "json"),       # the marks as they were: whole snapshots
    F("reason", "text"),
)
AUDIT = Spec("account_mark_audit", _AUDIT_FIELDS)
ORG_AUDIT = Spec("org_account_mark_audit", tuple(
    replace(f, values=('registry',)) if f.key == 'source' else f
    for f in _AUDIT_FIELDS))

def _checked(t: Table) -> Table:
    check(t)
    return t


def _account_table(spec: Spec) -> Table:
    """An account row: its id and file position, the state of its two containers (NULL absent,
    'n' null, 'o' held by the marks / spend table, 'x' kept whole in extra), and the runtime's
    ``removing`` flag (registry.set_removing keeps it in memory today: never in the file)."""
    return _checked(Table(spec, (("id", "text"), ("ord", "integer")), {"id": "account_id"}, (
        "id text PRIMARY KEY CHECK (id <> '')",
        "ord integer NOT NULL UNIQUE",
        "marks_is char(1) CHECK (marks_is IN ('n', 'o', 'x'))",
        "spend_is char(1) CHECK (spend_is IN ('n', 'o', 'x'))",
        "removing boolean NOT NULL DEFAULT false",
        "row_version bigint NOT NULL DEFAULT 0")))


def _marks_table(spec: Spec, parent: str) -> Table:
    return _checked(Table(spec, (("account_id", "text"), ("pool", "text")),
                          {"account_id": "account_id"}, (
        f"account_id text NOT NULL REFERENCES orgtree.{parent} (id) ON DELETE CASCADE",
        "pool text NOT NULL")))


def _spend_table(spec: Spec, parent: str) -> Table:
    return _checked(Table(spec, (("account_id", "text"),), {"account_id": "account_id"}, (
        f"account_id text PRIMARY KEY REFERENCES orgtree.{parent} (id) ON DELETE CASCADE",)))


ACCOUNTS = _account_table(ACCOUNT)
MARKS = _marks_table(MARK, "accounts")
SPENDS = _spend_table(SPEND, "accounts")
ORG_ACCOUNTS = _account_table(ORG_ACCOUNT)
ORG_MARKS = _marks_table(ORG_MARK, "org_accounts")
ORG_SPENDS = _spend_table(ORG_SPEND, "org_accounts")
def _alias_table(spec: Spec) -> Table:
    """{alias: account id}, in the file's order (ord). No foreign key: the registry keeps an
    alias exactly as written."""
    return _checked(Table(spec, (("alias", "text"), ("ord", "integer")), {"alias": "alias"},
                          ("alias text PRIMARY KEY", "ord integer NOT NULL UNIQUE")))


def _audit_table(spec: Spec) -> Table:
    return _checked(Table(spec, (("ord", "integer"),), {"ord": "ord"}, ("ord integer PRIMARY KEY",)))


ALIASES = _alias_table(ALIAS)
ORG_ALIASES = _alias_table(ORG_ALIAS)
COUNTERS = _checked(Table(COUNTER, (("provider", "text"),), {"provider": "provider"},
                          ("provider text PRIMARY KEY",)))
AUDITS = _audit_table(AUDIT)
ORG_AUDITS = _audit_table(ORG_AUDIT)
KEYS_TABLE = "account_registry_keys"

# the app database's account tables, parents first (the order COPY writes them in)
APP_TABLES = ("accounts", "account_marks", "account_spend", "account_aliases",
              "account_counters", "account_mark_audit", KEYS_TABLE)
ORG_TABLES = ("org_accounts", "org_account_marks", "org_account_spend", "org_account_aliases",
              "org_account_mark_audit")

# registry key -> app_settings column (a timestamptz plus its _text)
EPOCHS = {"apikey_cutover_at": "apikey_cutover_at", "migrated_at": "accounts_migrated_at"}
SETTINGS_COLUMNS = ("accounts_version", "apikey_cutover_at", "apikey_cutover_at_text",
                    "accounts_migrated_at", "accounts_migrated_at_text")
_EPOCH = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)


class AccountsMismatch(ValueError):
    """The accounts read back from the app database differ from the file's machine-wide part."""


class AccountsAlreadyConverted(RuntimeError):
    """The app database holds converted accounts already."""


def canon(v: Any) -> str:
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def _digest(v: Any) -> dict[str, Any]:
    n = len(v) if isinstance(v, (list, dict)) else 1
    return {"count": n, "sha256": hashlib.sha256(canon(v).encode("utf-8")).hexdigest()}


# ---------------------------------------------------------------- the document

def read_registry(path: str) -> dict[str, Any] | None:
    """The registry document exactly as stored, or None when there is no file. A file that
    cannot be read or parsed raises (OSError, ValueError): unlike registry.load's readers, the
    conversion never reads a damaged registry as blank."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return None
    doc = json.loads(data)
    if not isinstance(doc, dict):
        raise ShapeError(f"{REGISTRY_FILE}: expected an object, got {type(doc).__name__}")
    return doc


def restricted_to(row: Mapping[str, Any]) -> str | None:
    """The org an account row is restricted to (registry.validate_binding's rule: a non-empty
    origin_org), or None for a machine-wide row."""
    scope = row.get("origin_org")
    return str(scope) if scope else None


def _check_rows(rows: Iterable[Any]) -> None:
    seen: set[str] = set()
    for row in rows:
        rid = row.get("id") if isinstance(row, dict) else None
        if not codec.fits("text", rid) or not rid:
            raise ShapeError(f"{REGISTRY_FILE}: an account that is not an object with a text id")
        if rid in seen:
            raise ShapeError(f"{REGISTRY_FILE}: two accounts with the id {rid!r}")
        seen.add(rid)


def org_part() -> dict[str, Any]:
    """One org's part of the registry: its restricted account rows, the aliases naming them
    ({alias: account id}) and the manual mark-clear audit entries about them, in file order."""
    return {"accounts": [], "aliases": {}, "mark_audit": []}


def split_registry(doc: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """(the machine-wide document, {org slug: that org's part (``org_part``)}).

    An account restricted to one org (origin_org) goes to that org together with every alias
    that names it and every manual mark-clear audit entry about it (registry.clear_mark writes
    the clearing org, actor and a free-text reason): the app database keeps no trace of it
    (design §2.10, decisions 10-11, review f19). Everything else stays machine-wide, in order,
    including an alias or audit entry that names no account of the file: those are listed in
    the report, never guessed. A container of another shape stays whole in the machine-wide
    part (``accounts`` that is not a list: today's engine reads no account from it)."""
    accounts = doc.get("accounts")
    machine = dict(doc)
    if not isinstance(accounts, list):
        return machine, {}
    _check_rows(accounts)
    parts: dict[str, dict[str, Any]] = {}
    owner: dict[str, str] = {}
    for row in accounts:
        org = restricted_to(row)
        if org is not None:
            parts.setdefault(org, org_part())["accounts"].append(row)
            owner[row["id"]] = org
    machine["accounts"] = [r for r in accounts if restricted_to(r) is None]
    aliases = doc.get("aliases")
    if owner and _text_keyed(aliases):
        kept: dict[str, Any] = {}
        for alias, target in aliases.items():
            org = owner.get(target) if isinstance(target, str) else None
            if org is None:
                kept[alias] = target
            else:
                parts[org]["aliases"][alias] = target
        machine["aliases"] = kept
    audit = doc.get("mark_audit")
    if owner and isinstance(audit, list) and all(isinstance(e, dict) for e in audit):
        kept_audit = []
        for entry in audit:
            account = entry.get("account")
            org = owner.get(account) if isinstance(account, str) else None
            if org is None:
                kept_audit.append(entry)
            else:
                parts[org]["mark_audit"].append(entry)
        machine["mark_audit"] = kept_audit
    return machine, parts


def claude_profiles(doc: Mapping[str, Any]) -> list[str]:
    """The profile folders of the Claude accounts (supervisor._account_transcript_root): where
    their agents' transcripts are."""
    rows = doc.get("accounts") if isinstance(doc.get("accounts"), list) else []
    out = []
    for row in rows:
        if not isinstance(row, dict) or row.get("provider") != "claude":
            continue
        cred = row.get("credential")
        if (isinstance(cred, dict) and cred.get("kind") in ("managed", "imported")
                and isinstance(cred.get("path"), str)):
            out.append(cred["path"])
    return out


# ---------------------------------------------------------------- one account

def _take(rec: dict[str, Any], key: str, fits: Callable[[Any], bool]) -> tuple[str | None, Any]:
    """The state of a container field of an account (NULL absent, 'n' null, 'o' held by its
    table, 'x' kept whole in extra) and its value when its table holds it. Only 'x' leaves the
    key in ``rec``, where the codec keeps it in extra as a key it does not know."""
    if key not in rec:
        return None, None
    v = rec[key]
    if v is None:
        del rec[key]
        return "n", None
    if fits(v):
        del rec[key]
        return "o", v
    return "x", None


def _marks_fit(v: Any) -> bool:
    return isinstance(v, dict) and all(codec.fits("text", p) and isinstance(m, dict)
                                       for p, m in v.items())


def _encode_account(account: Spec, mark: Spec, spend: Spec, row: Mapping[str, Any], ord_: int,
                    out: Rows) -> None:
    rid = row["id"]
    rec = {k: v for k, v in row.items() if k != "id"}
    marks_is, marks = _take(rec, "marks", _marks_fit)
    spend_is, spent = _take(rec, "spend", lambda v: isinstance(v, dict))
    codec.encode(account, rec, {"id": rid, "ord": ord_}, out, link={"id": "account_id"})
    out[account.table][-1].update(marks_is=marks_is, spend_is=spend_is)
    if marks_is == "o":
        for pool, m in marks.items():
            codec.encode(mark, m, {"account_id": rid, "pool": pool}, out)
    if spend_is == "o":
        codec.encode(spend, spent, {"account_id": rid}, out)


def _decode_accounts(account: Spec, mark: Spec, spend: Spec,
                     rows: Mapping[str, list[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    marks: dict[str, list[Mapping[str, Any]]] = {}
    for m in rows.get(mark.table, []):
        marks.setdefault(m["account_id"], []).append(m)
    spends = {s["account_id"]: s for s in rows.get(spend.table, [])}
    out = []
    for r in sorted(rows.get(account.table, []), key=lambda r: r["ord"]):
        acc = {"id": r["id"], **codec.decode(account, r, None, ())}
        if r["marks_is"] == "n":
            acc["marks"] = None
        elif r["marks_is"] == "o":
            acc["marks"] = {m["pool"]: codec.decode(mark, m, None, ())
                            for m in sorted(marks.get(r["id"], []), key=lambda m: m["pool"])}
        if r["spend_is"] == "n":
            acc["spend"] = None
        elif r["spend_is"] == "o":
            s = spends.get(r["id"])
            acc["spend"] = codec.decode(spend, s, None, ()) if s is not None else {"$missing": True}
        out.append(acc)
    return out


# ---------------------------------------------------------------- the machine-wide part

def _int4(v: Any) -> bool:
    return type(v) is int and -2 ** 31 <= v < 2 ** 31


def _instant(v: Any) -> _dt.datetime | None:
    """Epoch seconds as an instant (microseconds), or None for anything else."""
    if type(v) not in (int, float) or not math.isfinite(v):
        return None
    try:
        return _EPOCH + _dt.timedelta(seconds=v)
    except (OverflowError, ValueError):
        return None


def _text_keyed(v: Any) -> bool:
    return isinstance(v, dict) and all(codec.fits("text", k) for k in v)


def encode_registry(doc: Mapping[str, Any]
                    ) -> tuple[Rows, dict[str, list[dict[str, Any]]], dict[str, Any]]:
    """(rows of the app database's account tables, plus ``app_settings``: one row of its
    account columns; {org slug: restricted rows}; the report)."""
    machine, restricted = split_registry(doc)
    out: Rows = {t: [] for t in APP_TABLES}
    settings: dict[str, Any] = {c: None for c in SETTINGS_COLUMNS}
    counters: dict[str, Mapping[str, Any]] = {}
    for i, (k, v) in enumerate(machine.items()):
        if not codec.fits("text", k):
            raise ShapeError(f"{REGISTRY_FILE}: a top-level key no text column can hold")
        state = "v"
        if v is None:
            state = "n"
        elif k == "accounts" and isinstance(v, list):
            for n, row in enumerate(v):
                _encode_account(ACCOUNT, MARK, SPEND, row, n, out)
        elif k == "aliases" and _text_keyed(v):
            for n, (alias, target) in enumerate(v.items()):
                codec.encode(ALIAS, {"account_id": target}, {"alias": alias, "ord": n}, out,
                             link=ALIASES.link)
        elif k in ("id_counters", "tint_counters") and _text_keyed(v):
            counters[k] = v
        elif k == "mark_audit" and isinstance(v, list) and all(isinstance(e, dict) for e in v):
            for n, entry in enumerate(v):
                codec.encode(AUDIT, entry, {"ord": n}, out, link=AUDITS.link)
        elif k == "version" and _int4(v):
            settings["accounts_version"] = v
        elif k in EPOCHS and _instant(v) is not None:
            settings[EPOCHS[k]] = _instant(v)
            settings[EPOCHS[k] + "_text"] = json.dumps(v)
        else:
            state = "x"
            if not codec.fits("json", v):
                raise ShapeError(f"{REGISTRY_FILE}: {k}: a value no JSON column can hold")
        out[KEYS_TABLE].append({"key": k, "ord": i, "state": state,
                                "val": codec.to_column("json", v) if state == "x" else None})
    ids, tints = counters.get("id_counters", {}), counters.get("tint_counters", {})
    for provider in dict.fromkeys([*ids, *tints]):
        rec = {}
        if provider in ids:
            rec["id_counter"] = ids[provider]
        if provider in tints:
            rec["tint_counter"] = tints[provider]
        codec.encode(COUNTER, rec, {"provider": provider}, out, link=COUNTERS.link)
    out["app_settings"] = [settings]
    accounts = machine.get("accounts") if isinstance(machine.get("accounts"), list) else []
    ids_restricted = {r["id"] for part in restricted.values() for r in part["accounts"]}
    known = {r["id"] for r in accounts} | ids_restricted
    aliases = machine.get("aliases") if isinstance(machine.get("aliases"), dict) else {}
    audit = machine.get("mark_audit") if isinstance(machine.get("mark_audit"), list) else []
    report = {
        "accounts": len(accounts) + len(ids_restricted),
        "machine_wide": len(accounts),
        "restricted": {org: len(part["accounts"]) for org, part in restricted.items()},
        "restricted_aliases": {org: len(part["aliases"]) for org, part in restricted.items()
                               if part["aliases"]},
        "restricted_mark_audit": {org: len(part["mark_audit"]) for org, part in restricted.items()
                                  if part["mark_audit"]},
        "aliases": len(out["account_aliases"]),
        "counters": len(out["account_counters"]),
        "mark_audit": len(out["account_mark_audit"]),
        "kept_whole": [r["key"] for r in out[KEYS_TABLE] if r["state"] == "x"],
        "rows_with_extra": {t: sum(1 for r in rs if r.get("extra") is not None)
                            for t, rs in out.items() if t != KEYS_TABLE and t != "app_settings"
                            and any(r.get("extra") is not None for r in rs)},
        # kept machine-wide because they name no account of the file (never guessed)
        "aliases_unresolved": sorted(a for a, t in aliases.items()
                                     if not (isinstance(t, str) and t in known)),
        "mark_audit_unattributed": [n for n, e in enumerate(audit) if not (
            isinstance(e, dict) and isinstance(e.get("account"), str) and e["account"] in known)],
    }
    return out, restricted, report


def decode_registry(rows: Mapping[str, list[Mapping[str, Any]]]) -> dict[str, Any]:
    """The machine-wide registry document back from the app database's rows ({} when no
    registry was converted)."""
    keys = sorted(rows.get(KEYS_TABLE, []), key=lambda r: r["ord"])
    settings = (rows.get("app_settings") or [{}])[0]
    counters = [(r["provider"], codec.decode(COUNTER, r, None, ()))
                for r in sorted(rows.get(COUNTER.table, []), key=lambda r: r["provider"])]
    doc: dict[str, Any] = {}
    for r in keys:
        k, state = r["key"], r["state"]
        if state == "n":
            doc[k] = None
        elif state == "x":
            doc[k] = codec.from_column("json", r["val"])
        elif k == "accounts":
            doc[k] = _decode_accounts(ACCOUNT, MARK, SPEND, rows)
        elif k == "aliases":
            doc[k] = {}
            for a in sorted(rows.get(ALIAS.table, []), key=lambda a: a["ord"]):
                rec = codec.decode(ALIAS, a, None, ())
                doc[k][a["alias"]] = rec.get("account_id")
        elif k in ("id_counters", "tint_counters"):
            col = "id_counter" if k == "id_counters" else "tint_counter"
            doc[k] = {p: rec[col] for p, rec in counters if col in rec}
        elif k == "mark_audit":
            doc[k] = [codec.decode(AUDIT, e, None, ())
                      for e in sorted(rows.get(AUDIT.table, []), key=lambda e: e["ord"])]
        elif k == "version":
            doc[k] = settings.get("accounts_version")
        elif k in EPOCHS:
            doc[k] = json.loads(settings[EPOCHS[k] + "_text"])
        else:
            raise ShapeError(f"{KEYS_TABLE}: {k!r} is held by no table")
    return doc


def read_accounts(app_conn: Any) -> dict[str, Any]:
    """The machine-wide registry document, rebuilt from the app database (``app_conn``: a psycopg
    connection to it; inside a transaction it sees that transaction's own rows)."""
    from . import rowio                             # noqa: PLC0415
    rows = rowio.read(app_conn, order=list(APP_TABLES))
    found = app_conn.execute(f"SELECT {', '.join(SETTINGS_COLUMNS)} FROM orgtree.app_settings"
                             ).fetchone()
    rows["app_settings"] = [dict(zip(SETTINGS_COLUMNS, found))] if found is not None else []
    return decode_registry(rows)


def convert_accounts(app_conn: Any, registry_path: str) -> dict[str, Any]:
    """Write the machine-wide accounts of ``registry_path`` into the app database, on
    ``app_conn`` (a psycopg connection the caller has in a transaction, and commits), then read
    them back and refuse (AccountsMismatch) unless they equal the file's machine-wide part.
    Returns {"machine_wide": n, "restricted": {org slug: [account rows]}, "report": {...}}: the
    restricted rows are for each org's ``OrgAccounts`` (an unavailable org's in its retry).
    The file is only read."""
    taken = app_conn.execute(f"SELECT EXISTS (SELECT 1 FROM orgtree.{KEYS_TABLE}) "
                             "OR EXISTS (SELECT 1 FROM orgtree.accounts)").fetchone()[0]
    if taken:
        raise AccountsAlreadyConverted("the app database already holds converted accounts")
    doc = read_registry(registry_path)
    if doc is None:
        return {"machine_wide": 0, "restricted": {},
                "report": {"file": str(registry_path), "present": False}}
    rows, restricted, report = encode_registry(doc)
    settings = rows.pop("app_settings")[0]
    from . import rowio                             # noqa: PLC0415
    written = rowio.write(app_conn, rows, order=list(APP_TABLES))
    app_conn.execute("UPDATE orgtree.app_settings SET "
                     + ", ".join(f"{c} = %s" for c in SETTINGS_COLUMNS)
                     + ", row_version = row_version + 1",
                     tuple(settings[c] for c in SETTINGS_COLUMNS))
    want = split_registry(doc)[0]
    got = read_accounts(app_conn)
    if canon(want) != canon(got):
        differs = sorted(k for k in set(want) | set(got)
                         if canon(want.get(k)) != canon(got.get(k)) or (k in want) != (k in got))
        raise AccountsMismatch(f"the accounts read back differ from {REGISTRY_FILE} at {differs}")
    report.update({"file": str(registry_path), "present": True, "rows_written": written,
                   "verified": {"source": _digest(want), "dest": _digest(got)}})
    return {"machine_wide": report["machine_wide"], "restricted": restricted, "report": report}


# ---------------------------------------------------------------- an org's own accounts

def _part(part: Mapping[str, Any] | None) -> dict[str, Any]:
    part = part or {}
    return {"accounts": list(part.get("accounts") or ()), "aliases": dict(part.get("aliases") or {}),
            "mark_audit": list(part.get("mark_audit") or ())}


class OrgAccounts(Section):
    """One org's part of the registry (``split_registry(doc)[1][slug]``, ``org_part``): its
    restricted accounts into ``org_accounts``, ``org_account_marks`` and ``org_account_spend``,
    the aliases naming them into ``org_account_aliases`` and the manual mark-clear audit entries
    about them into ``org_account_mark_audit``, each in file order. ``decode`` leaves the part
    it reads back in ``read_back``."""
    keys: tuple[str, ...] = ()
    tables = (ORG_ACCOUNTS, ORG_MARKS, ORG_SPENDS, ORG_ALIASES, ORG_AUDITS)

    def __init__(self, part: Mapping[str, Any] | None = None) -> None:
        self.part = _part(part)
        _check_rows(self.part["accounts"])
        self.read_back: dict[str, Any] = org_part()

    def encode(self, doc: Mapping[str, Any], ctx: Context, out: Rows) -> None:
        for i, row in enumerate(self.part["accounts"]):
            _encode_account(ORG_ACCOUNT, ORG_MARK, ORG_SPEND, row, i, out)
        for n, (alias, target) in enumerate(self.part["aliases"].items()):
            codec.encode(ORG_ALIAS, {"account_id": target}, {"alias": alias, "ord": n}, out,
                         link=ORG_ALIASES.link)
        for n, entry in enumerate(self.part["mark_audit"]):
            codec.encode(ORG_AUDIT, entry, {"ord": n}, out, link=ORG_AUDITS.link)

    def decode(self, rows, ctx, present, doc) -> None:
        self.read_back = decode_org_accounts(rows)


def decode_org_accounts(rows: Mapping[str, list[Mapping[str, Any]]]) -> dict[str, Any]:
    """The org's part of the registry back from its database's rows, in file order."""
    aliases = {}
    for a in sorted(rows.get(ORG_ALIAS.table, []), key=lambda a: a["ord"]):
        aliases[a["alias"]] = codec.decode(ORG_ALIAS, a, None, ()).get("account_id")
    return {"accounts": _decode_accounts(ORG_ACCOUNT, ORG_MARK, ORG_SPEND, rows),
            "aliases": aliases,
            "mark_audit": [codec.decode(ORG_AUDIT, e, None, ())
                           for e in sorted(rows.get(ORG_AUDIT.table, []), key=lambda e: e["ord"])]}


def check_org_accounts(source: Mapping[str, Any] | None,
                       rows: Mapping[str, list[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    """[] when the org database holds exactly the org's part ``source``; else the mismatch."""
    want, got = _part(source), decode_org_accounts(rows)
    if canon(got) == canon(want):
        return []
    have = {canon(g) for g in got["accounts"]}
    wanted = {canon(r) for r in want["accounts"]}
    return [{"path": "side/org_accounts", "want": _digest(want), "got": _digest(got),
             "missing": [r.get("id") for r in want["accounts"] if canon(r) not in have][:5],
             "unexpected": [g.get("id") for g in got["accounts"] if canon(g) not in wanted][:5],
             "aliases_differ": canon(got["aliases"]) != canon(want["aliases"]),
             "mark_audit_differs": canon(got["mark_audit"]) != canon(want["mark_audit"])}]
