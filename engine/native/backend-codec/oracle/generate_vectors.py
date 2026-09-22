"""Produce or check the backend-codec parity vectors from current Python source.

The expected values come from calling the backend's own functions:
`ledger._q`, `openrouter.seat_for`, `ledger.slugify`, `Org._work_slugify`,
`Org._WORK_OLD_ID`, `Org.hire`, `agentauth.child_env` and `agentauth.verify`,
plus `json.loads` itself. Where a rule cannot be called in isolation (the
API door's `int(caller.get("generation", 0))`), the exact source text is
required to still be present, so a change to it fails `--check`.

Run with the engine runtime, never system Python (its Unicode data and float
formatting are part of the contract):

    engine/runtime/python.exe engine/native/backend-codec/oracle/generate_vectors.py --check

It writes nothing outside the vectors file and a temporary ORGTREE_DATA
directory it deletes. No live data, network, provider or listener is used.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import hmac
import json
import math
import os
import random
import re
import struct
import sys
import tempfile
import unicodedata
import uuid
from decimal import Decimal
from pathlib import Path

SCHEMA = "orgtree.backend-codec-vectors/v1"
HERE = Path(__file__).resolve().parent
CRATE = HERE.parent
DEFAULT_VECTORS = CRATE / "vectors" / "backend-codec-vectors.json"
REQUIRED_PYTHON = (3, 13)
PARITY_MAX_HUNDREDTHS = 999_999_999_999_999
ANCHOR_FILES = (
    "engine/backend/orgtree/ledger.py",
    "engine/backend/orgtree/openrouter.py",
    "engine/backend/orgtree/agentauth.py",
    "engine/backend/orgtree/api.py",
)
# Source text that the vectors reproduce but cannot call on its own.
REQUIRED_SOURCE = {
    "engine/backend/orgtree/api.py": [
        'int(caller.get("generation", 0)) != identity[2]',
    ],
    "engine/backend/orgtree/ledger.py": [
        "return round(x, CREDIT_PLACES)",
        "if grant < 0 or grant != int(grant):",
        'slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")',
        's = re.sub(r"[^a-z0-9]+", "-", str(title or "").lower()).strip("-")',
        '_WORK_OLD_ID = re.compile(r"^w[0-9a-f]{8}$")',
        'USER: Final = "@user"',
        'SYSTEM: Final = "@system"',
        'EXTERN: Final = "@extern"',
    ],
}


def bits(x: float) -> str:
    return struct.pack(">d", x).hex()


def from_bits(h: str) -> float:
    return struct.unpack(">d", bytes.fromhex(h))[0]


def exc_name(e: BaseException) -> str:
    return "LedgerError" if type(e).__name__ == "LedgerError" else type(e).__name__


def render(v):
    """A language-neutral rendering of a decoded Python JSON value."""
    if v is None:
        return ["null"]
    if isinstance(v, bool):
        return ["bool", v]
    if isinstance(v, int):
        return ["int", str(v)]
    if isinstance(v, float):
        return ["float", bits(v)]
    if isinstance(v, str):
        return ["str", v]
    if isinstance(v, list):
        return ["list", [render(x) for x in v]]
    if isinstance(v, dict):
        return ["dict", [[k, render(x)] for k, x in v.items()]]
    raise TypeError(type(v))


def has_lone_surrogate(v) -> bool:
    if isinstance(v, str):
        return any(0xD800 <= ord(c) <= 0xDFFF for c in v)
    if isinstance(v, list):
        return any(has_lone_surrogate(x) for x in v)
    if isinstance(v, dict):
        return any(has_lone_surrogate(k) or has_lone_surrogate(x) for k, x in v.items())
    return False


def float_corpus(rng: random.Random) -> list[float]:
    fixed = [0.0, -0.0, 0.1, 0.2, 0.125, 0.375, 0.005, 0.015, 0.025, 2.675, 1.005,
             -0.001, -0.004, -0.005, -0.006, -2.675, 1e-300, 5e-324, -5e-324,
             0.994999, 0.995, 0.999, 1.0, 1.5, 2.0, 4.0, 10.0, 0.105, 0.115,
             1030000.555, 1030000.005, 9999999999999.99, 9999999999999.996,
             1e13, 1e15, 1e300, 123456789.125, 0.30000000000000004,
             float("nan"), float("inf"), float("-inf")]
    rand = [round(rng.uniform(-1000, 1000), rng.randint(0, 6)) for _ in range(150)]
    rand += [rng.uniform(0, 2e6) for _ in range(100)]
    rand += [rng.randint(0, 10**8) / 1000 + 0.0005 for _ in range(50)]
    rand += [from_bits("%016x" % rng.getrandbits(64)) for _ in range(50)]
    return fixed + rand


def section_py_round2(ledger, rng):
    out = []
    for x in float_corpus(rng):
        q = ledger._q(x)
        row = {"bits": bits(x), "python_repr": json.dumps(q)}
        if not math.isfinite(q):
            row["rust"] = {"error": "not_finite"}
        else:
            h = int(Decimal(repr(q)) * 100)
            if abs(h) > PARITY_MAX_HUNDREDTHS:
                row["rust"] = {"error": "out_of_range"}
            else:
                row["rust"] = {"hundredths": h, "negative_zero": math.copysign(1.0, q) < 0 and q == 0}
        out.append(row)
    return out


def section_seat_for(openrouter, rng):
    inputs = [0.0, -0.0, 0.02, 0.1, 0.104, 0.105, 0.106, 0.2, 0.75, 0.995, 0.9999999,
              1.0, 1.5, 2.0, 2.9999999999, 2.999999999, 3.0, 4.0, 5.0, 30.0, 1e12,
              -5.0, float("nan"), float("inf"), float("-inf"), 1e300]
    inputs += [rng.uniform(0, 1) for _ in range(60)] + [rng.uniform(1, 100) for _ in range(40)]
    out = []
    for p in inputs:
        row = {"bits": bits(p)}
        try:
            s = openrouter.seat_for(p)
            row["python_repr"] = json.dumps(s)
            if math.isfinite(s) and abs(int(Decimal(repr(s)) * 100)) <= PARITY_MAX_HUNDREDTHS:
                row["rust"] = {"hundredths": int(Decimal(repr(s)) * 100)}
            else:
                row["rust"] = {"outside_parity": True}
        except Exception as e:  # noqa: BLE001 - the exception class is the vector
            row["python_raises"] = exc_name(e)
        out.append(row)
    return out


def exact_expectation(lexeme: str):
    d = Decimal(lexeme)
    h = d * 100
    if h != h.to_integral_value():
        return {"error": "precision"}
    h = int(h)
    if abs(h) > PARITY_MAX_HUNDREDTHS:
        return {"error": "out_of_range"}
    return {"hundredths": h}


def section_parse_exact(ledger):
    lexemes = ["0", "-0", "0.0", "-0.00", "1", "10", "0.1", "0.10", "0.25", "0.125", "0.005",
               "1.23", "1.230", "1.2300000", "1e2", "1E2", "1e-2", "1.5e-1", "1.55e-1", "1.5e+1",
               "12.345", "-12.34", "1030000.55", "9999999999999.99", "10000000000000",
               "10000000000000.00", "0.30000000000000004", "123456789012345678901234567890",
               "1e400", "1e-400", "0e999999", "5e-3", "0.009999999999999999999"]
    out = []
    for lx in lexemes:
        v = json.loads(lx)
        row = {"lexeme": lx, "rust": exact_expectation(lx)}
        try:
            row["python_q_json"] = json.dumps(ledger._q(v))
        except Exception as e:  # noqa: BLE001
            row["python_q_raises"] = exc_name(e)
        row["python_type"] = type(v).__name__
        out.append(row)
    return out


def section_hire_grant(ledger):
    texts = ["0", "3", "-0", "-1", "3.0", "-0.0", "2.5", "-2.5", "1e2", "1e-2", "true",
             "false", "null", '"3"', "[]", "{}", "NaN", "Infinity", "-Infinity",
             "9007199254740993", "1e15", "99999999999999999999999"]
    base = ledger.Org.create("oracle-grant")
    # 0 means uncapped (ledger._check_top_grant), so only the grant's own
    # type/sign check can refuse these synthetic hires.
    base.d["max_top_grant"] = 0
    out = []
    for t in texts:
        g = json.loads(t)
        org = copy.deepcopy(base)
        row = {"json": t}
        try:
            org.hire(ledger.USER, None, "haiku", g, "probe")
            stored = org.node("probe")["grant"]
            row["python_stored_json"] = json.dumps(stored)
            if abs(stored) > 2**63 - 1:
                row["rust_outside_parity"] = True
        except Exception as e:  # noqa: BLE001
            name = exc_name(e)
            if name == "LedgerError" and "grant must be a non-negative integer" not in str(e):
                raise RuntimeError(f"hire({t}) refused for a reason other than the grant: {e}")
            row["python_raises"] = name
        out.append(row)
    return out


JSON_TEXTS = [
    '{}', '[]', 'null', 'true', '0', '-0', '1.5', '"x"', '{"a":1,"b":null}',
    '{"a":1,"a":2}', '{"a":1,"b":2,"a":3}', '{"a":{"x":1,"x":2}}',
    '[NaN]', '[Infinity, -Infinity]', '[nan]', '[-NaN]', '[+1]', '[01]', '[1.]', '[.5]',
    '[1e]', '[1e+]', '[1.5e3]', '[-1E-2]', '["\\ud83d\\ude00"]', '["\\ud800"]',
    '["\\udc00"]', '["\\ud800\\u0041"]', '["a\\u0000b"]', '["tab\there"]', '["\\x"]',
    '["\\/"]', '["éK"]', '{"k" : [1 , 2] }', ' \t\r\n[1]\n', '[1] [2]',
    '[1,]', '{"a":1,}', '{a:1}', "{'a':1}", '﻿[1]', '', ' ', '[', '"unterminated',
    '["\x7f"]', '[1e400]', '[-1e400]', '[123456789012345678901234567890]',
    '[' + '1' * 4300 + ']', '[' + '1' * 4301 + ']', '[' + '9' * 30 + '.5]',
    '[true, false, null, "s", {"n": [[], {}]}]',
]


def section_json():
    out = []
    for t in JSON_TEXTS:
        row = {"text": t}
        dup = []
        nonfinite = []

        def pairs(items):
            keys = [k for k, _ in items]
            if len(set(keys)) != len(keys):
                dup.append(True)
            return dict(items)

        def constant(c):
            nonfinite.append(c)
            return float(c.replace("Infinity", "inf").replace("NaN", "nan"))

        try:
            v = json.loads(t)
            json.loads(t, object_pairs_hook=pairs, parse_constant=constant)
        except (ValueError, RecursionError) as e:
            row["python"] = "error"
            row["python_error"] = type(e).__name__
            row["strict"] = "error"
        else:
            if has_lone_surrogate(v):
                row["python"] = "outside_parity"
                row["strict"] = "lone_surrogate"
            else:
                row["python"] = "ok"
                row["python_value"] = render(v)
                row["strict"] = ("duplicate_key" if dup else "nonfinite_constant" if nonfinite else "ok")
        out.append(row)
    return out


def section_presence():
    cases = [('{}', "k"), ('{"k":null}', "k"), ('{"k":0}', "k"), ('{"k":false}', "k"),
             ('{"k":""}', "k"), ('{"k":[]}', "k"), ('{"K":1}', "k"), ('{"k ":1}', "k"),
             ('{"a":{"k":1}}', "k")]
    out = []
    for t, key in cases:
        d = json.loads(t)
        kind = "absent" if key not in d else "null" if d[key] is None else "present"
        out.append({"json": t, "key": key, "python": kind})
    return out


def section_generation(agentauth):
    texts = ['{}', '{"generation":null}', '{"generation":0}', '{"generation":3}',
             '{"generation":-0}', '{"generation":-1}', '{"generation":true}',
             '{"generation":false}', '{"generation":1.9}', '{"generation":-0.5}',
             '{"generation":2.0}', '{"generation":1e2}', '{"generation":"2"}',
             '{"generation":[]}', '{"generation":{}}', '{"generation":NaN}',
             '{"generation":Infinity}', '{"generation":1e400}',
             '{"generation":9223372036854775807}', '{"generation":9223372036854775808}']
    out = []
    for t in texts:
        caller = json.loads(t)
        row = {"json": t}
        try:
            # api.py _agent_identity; REQUIRED_SOURCE pins this exact text.
            row["api_value"] = int(caller.get("generation", 0))
            if isinstance(caller.get("generation"), str):
                row["api_rust_outside_parity"] = True
            elif abs(row["api_value"]) > 2**63 - 1:
                row["api_rust_outside_parity"] = True
        except Exception as e:  # noqa: BLE001
            row["api_raises"] = exc_name(e)
        # Strict expectation derived from child_env's own acceptance test.
        if "generation" not in caller:
            row["strict"] = {"absent": True}
        elif caller["generation"] is None:
            row["strict"] = {"error": "null"}
        else:
            g = caller["generation"]
            try:
                agentauth.child_env("o", "n", generation=g)
                row["strict"] = ({"value": g} if g <= 2**63 - 1 else {"error": "out_of_range"})
            except ValueError:
                row["strict"] = {"error": "negative" if type(g) is int else "not_integer"}
        out.append(row)
    return out


def section_slugs(ledger, rng):
    names = ["Alice", "  alice  ", "Hello, World!", "a--b", "-a-", "---", "", "   ", "@user",
             "user", "system", "İstanbul", "İx", "Kelvin", "ΣΑΣ", "ＡＢＣ", "café crème",
             "Ǆemal", "ß", "ﬁle", "xİy", "İ", "a_b", "a.b", "1-2-3", "😀 agent",
             "tab\there", "line\nbreak", " nbsp ", " sep", "W12345678",
             "Opus 5.5 reviewer", "a" * 60, "Ab" * 30 + "!", "x" * 47 + "-yy", "x" * 48 + "-y"]
    alphabet = "aZ09 -_.@İKΣßé😀\ṫ"
    names += ["".join(rng.choice(alphabet) for _ in range(rng.randint(0, 20))) for _ in range(120)]
    slug, work = [], []
    for n in names:
        try:
            slug.append({"input": n, "python": ledger.slugify(n)})
        except Exception as e:  # noqa: BLE001
            slug.append({"input": n, "python_raises": exc_name(e)})
        work.append({"input": n, "python": ledger.Org._work_slugify(n)})
    work.append({"input": None, "python": ledger.Org._work_slugify(None)})
    return slug, work


def section_lower_table():
    table = []
    for c in range(0x110000):
        if 0xD800 <= c <= 0xDFFF or c < 0x80:
            continue
        lo = chr(c).lower()
        if re.search("[a-z0-9]", lo):
            table.append([c, lo])
    return table


def section_retired_shape(ledger):
    refs = ["w12345678", "w1234567", "w123456789", "W12345678", "w1234567g", "w12345678\n",
            "w12345678\n\n", "\nw12345678", "w12345678 ", "wabcdef01", "w1234abcd-x", ""]
    return [{"input": r, "python": bool(ledger.Org._WORK_OLD_ID.match(r))} for r in refs]


def section_actor(ledger):
    inputs = ["@user", "@system", "@extern", "@User", "@org:x", "@", "user", "system",
              "agent-1", "Agent-1", "a--b", "-a", "a-", "", "a b", "é", "v3-model-review-opus55"]
    out = []
    for s in inputs:
        if s in (ledger.USER, ledger.SYSTEM, ledger.EXTERN):
            exp = {"kind": {ledger.USER: "user", ledger.SYSTEM: "system", ledger.EXTERN: "extern"}[s]}
        elif s.startswith("@"):
            exp = {"error": "unknown_sentinel"}
        else:
            try:
                ok = ledger.slugify(s) == s
            except Exception:  # noqa: BLE001
                ok = False
            exp = {"kind": "agent"} if ok else {"error": "not_canonical_key"}
        out.append({"input": s, "expected": exp})
    return out


def section_new_work_name(ledger, rng):
    titles = ["Build a Rust backend codec foundation", "", None, "İ", "x" * 80, "--!!--",
              "W12345678", "Include recent model releases in private v3"]
    out = []
    for t in titles:
        raw = bytearray(rng.getrandbits(8) for _ in range(16))
        u = uuid.UUID(bytes=bytes(raw), version=4)
        token = base64.b32encode(u.bytes).decode("ascii").lower().rstrip("=")
        out.append({"title": t, "uuid": u.bytes.hex(),
                    "expected": ledger.Org._work_slugify(t) + "--" + token,
                    "provenance": "v6 DATA-PLACEMENT format; current source does not mint these yet"})
    return out


def section_credentials(agentauth):
    agentauth.enable()
    key = agentauth._key
    enc = []
    for org, node, g in [("wire-actions", "caller", 0), ("o", "n", 1), ("org", "agent-2", 12345),
                         ("é", "K", 7), ("q\"uote", "back\\slash", 0), ("", "", 0),
                         ("o", "n", -1), ("o", "n", 2**62), ("😀", "tab\t", 3)]:
        row = {"org": org, "node": node, "generation": g}
        try:
            row["python_payload"] = agentauth.child_env(org, node, generation=g)["ORGTREE_AGENT_TOKEN"].split(".")[0]
        except ValueError as e:
            row["python_raises"] = exc_name(e)
        enc.append(row)

    def b64(text: str) -> str:
        return base64.urlsafe_b64encode(text.encode("utf-8")).decode().rstrip("=")

    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    def set_unused_bits(p: str) -> str:
        """Same decoded bytes, but a nonzero unused bit in the last character."""
        assert len(p) % 4 in (2, 3)
        return p[:-1] + alphabet[alphabet.index(p[-1]) | 1]

    payloads = [b64('["o","n",1]'), b64('["o","n",-1]'), b64('["o","n",-0]'), b64('["o","n",1.0]'),
                b64('["o","n",true]'), b64('["o","n",1e2]'), b64('[ "o" , "n" , 1 ]'),
                b64('["o","n"]'), b64('["o","n",1,2]'), b64('"abc"'), b64('{"a":1,"b":2,"c":3}'),
                b64('["o","n","1"]'), b64('["o",null,1]'), b64('3'), b64('not json'), b64(''),
                b64('["\\u00e9","n",1]'), b64('["é","n",1]'), b64('["o","n",NaN]'),
                b64('["o","n",99999999999999999999]'), b64('["o","n",' + '1' * 4301 + ']'),
                set_unused_bits(b64('["o","n",1]')), set_unused_bits(b64('["o","n",123]')),
                b64('["o","n",1]')[:-1], b64('["o","n",1]') + "A", "YQ", "YR", "YWI", "YWJ",
                "Y", "YW*Jj", "YW+J", "YW=J"]
    dec = []
    for p in payloads:
        sig = hmac.new(key, p.encode(), hashlib.sha256).hexdigest()
        got = agentauth.verify(p + "." + sig)
        row = {"payload": p}
        row["python"] = {"claim": list(got)} if got is not None else "rejected"
        if not re.fullmatch(r"[A-Za-z0-9_-]*", p):
            row["legacy_outside_parity"] = True
        elif got is not None and abs(got[2]) > 2**63 - 1:
            row["legacy_outside_parity"] = True
        canonical = False
        # The canonical decoder is bounded to i64, like every Rust integer here.
        if got is not None and 0 <= got[2] <= 2**63 - 1:
            canonical = agentauth.child_env(got[0], got[1], generation=got[2])[
                "ORGTREE_AGENT_TOKEN"].split(".")[0] == p
        row["canonical_ok"] = canonical
        dec.append(row)
    return enc, dec


def anchors(repo: Path):
    out = []
    for rel in ANCHOR_FILES:
        data = (repo / rel).read_bytes()
        out.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest()})
    for rel, needles in REQUIRED_SOURCE.items():
        text = (repo / rel).read_text(encoding="utf-8")
        for n in needles:
            if n not in text:
                raise SystemExit(f"source anchor missing from {rel}: {n!r}")
    return out


def build(repo: Path) -> dict:
    if sys.version_info[:2] != REQUIRED_PYTHON:
        raise SystemExit(f"run with the engine runtime Python {REQUIRED_PYTHON}, not {sys.version}")
    sys.path.insert(0, str(repo / "engine" / "backend"))
    from orgtree import agentauth, ledger, openrouter  # noqa: PLC0415

    rng = random.Random(20260923)
    slug, work = section_slugs(ledger, rng)
    enc, dec = section_credentials(agentauth)
    return {
        "schema": SCHEMA,
        "oracle": {"python": ".".join(map(str, sys.version_info[:3])),
                   "unicode": unicodedata.unidata_version,
                   "anchors": anchors(repo)},
        "limits": "Synthetic inputs only. Expected values are current Python behavior, not a new contract.",
        "py_round2": section_py_round2(ledger, rng),
        "seat_for": section_seat_for(openrouter, rng),
        "parse_exact": section_parse_exact(ledger),
        "hire_grant": section_hire_grant(ledger),
        "json": section_json(),
        "presence": section_presence(),
        "generation": section_generation(agentauth),
        "slugify": slug,
        "work_slugify": work,
        "lower_table": section_lower_table(),
        "retired_shape": section_retired_shape(ledger),
        "actor": section_actor(ledger),
        "new_work_name": section_new_work_name(ledger, rng),
        "credential_encode": enc,
        "credential_decode": dec,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo-root", type=Path, default=CRATE.parents[2])
    ap.add_argument("--vectors", type=Path, default=DEFAULT_VECTORS)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="orgtree-codec-oracle-") as data:
        os.environ["ORGTREE_DATA"] = data
        doc = build(args.repo_root.resolve())
    text = json.dumps(doc, ensure_ascii=True, indent=1) + "\n"
    if args.write:
        args.vectors.parent.mkdir(parents=True, exist_ok=True)
        args.vectors.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {args.vectors} ({len(text)} bytes)")
        return 0
    current = args.vectors.read_text(encoding="utf-8")
    if current != text:
        print(f"MISMATCH: {args.vectors} differs from vectors regenerated from current source")
        return 1
    print(f"matches: {args.vectors} ({len(text)} bytes, sha256 {hashlib.sha256(text.encode()).hexdigest()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
