"""Produce or check the op-receipt-codec parity vectors from current Python source.

Every expected value comes from calling the real functions of
`engine/backend/orgtree/opreceipts.py`: `parse_key`, `_canonical`,
`fingerprint`, `find`, `fp_node`, `classify`, `schema_ahead`, `watermark`,
`admit`, `append` and `row`, plus `hashlib.sha256`, `repr`, `json.dumps` and
the interpreter's own Unicode tables. The module's source hash and the exact
rule text it reproduces are anchored, so a changed rule fails `--check`.

Run with the engine runtime, never system Python (its Unicode data and float
formatting are part of the contract):

    engine/runtime/python.exe engine/native/op-receipt-codec/oracle/generate_vectors.py --check

It writes nothing but the vectors file. It never calls the custody functions
(`custody`, `witness`, `new_epoch`), reads no clock for any expected value,
and uses no live data, network, provider or listener.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import struct
import sys
import unicodedata
from pathlib import Path

SCHEMA = "orgtree.op-receipt-codec-vectors/v1"
HERE = Path(__file__).resolve().parent
CRATE = HERE.parent
DEFAULT_VECTORS = CRATE / "vectors" / "op-receipt-vectors.json"
REQUIRED_PYTHON = (3, 13)
ANCHOR_FILES = ("engine/backend/orgtree/opreceipts.py",)
REQUIRED_SOURCE = {
    "engine/backend/orgtree/opreceipts.py": [
        'KEY_RE = re.compile(r"^(\\d{13,14})-([0-9a-f]{24})$")',
        "HORIZON_MS = 900_000",
        "SKEW_MS = 60_000",
        "CEILING = 500",
        "TRIM_TO = 400",
        "SCHEMA = 1",
        "COVERAGE = 1",
        'return json.dumps(obj, sort_keys=True, separators=(",", ":"),',
        "ensure_ascii=False, default=str)",
        'm["from_ms"] = max(int(m.get("from_ms") or 0), hi + 1)',
    ],
}
NOW = 1_758_000_000_000
I64_MAX = 2**63 - 1
# Python's default `str(int)` limit. Integers are exact at any width; a vector
# integer longer than this is written as a decimal string (see `encode_ints`).
INT_DIGITS = 4300
BIG = 10**INT_DIGITS - 1  # the widest int `str()` still renders
# `(ms - mint) / 1000` overflows a float from exactly this age on.
AGE_OVERFLOW = 1000 * (int(sys.float_info.max) + 2**970)


def exc_name(e: BaseException) -> str:
    return type(e).__name__


class ContainerStr(Exception):
    """`str()` of a list or dict: Python's repr of containers is outside the
    crate's parity domain."""


def guard_fp_node(op):
    """Wrap the real `fp_node` so that a call that would `str()` a container
    is reported as outside the parity domain. Every other call is the real
    function's answer."""
    real = op.fp_node

    def guarded(row):
        if isinstance(row.get("fp_node") or row.get("node") or "", (list, dict)):
            raise ContainerStr
        return real(row)

    op.fp_node = guarded
    return real


def outcome(fn):
    """Python's answer, or the exception it raises. AttributeError only comes
    from a malformed document shape, which the crate declares outside its
    parity domain, as is `str()` of a container."""
    try:
        return {"value": fn()}
    except (AttributeError, ContainerStr):
        return {"outside": True}
    except (ValueError, TypeError, OverflowError, UnicodeEncodeError) as e:
        return {"raises": exc_name(e)}


def key(mint, h=0xABC) -> str:
    return f"{mint}-{h:024x}"


def section_tables():
    zeros = [c for c in range(0x110000) if chr(c).isdecimal() and unicodedata.decimal(chr(c)) == 0]
    runs_ok = all(unicodedata.decimal(chr(z + i), -1) == i for z in zeros for i in range(10))
    count = sum(1 for c in range(0x110000) if chr(c).isdecimal())
    if not runs_ok or count != 10 * len(zeros):
        raise SystemExit("decimal digits are no longer ten-digit runs; the Rust table shape is wrong")
    space = [c for c in range(0x110000) if chr(c).isspace()]
    return [{"name": "decimal_zeros", "values": zeros}, {"name": "space", "values": space}]


def section_key(op):
    arabic = "".join(chr(0x660 + int(d)) for d in "1758000000000")
    fullwidth = "".join(chr(0xFF10 + int(d)) for d in "1758000000000")
    bold = "".join(chr(0x1D7CE + int(d)) for d in "17580000000001")
    mixed = "1758" + "".join(chr(0x966 + int(d)) for d in "000000000")
    superscript = "¹" + "758000000000"
    h = "0123456789abcdef01234567"
    cases = [
        key(NOW), "1758000000000" + "-" + h, "17580000000001-" + h, "175800000000-" + h,
        "175800000000011-" + h, "0000000000001-" + h, "99999999999999-" + h,
        "1758000000000-" + h.upper(), "1758000000000-" + h[:23], "1758000000000-" + h + "0",
        "1758000000000-" + h[:23] + "g", arabic + "-" + h, fullwidth + "-" + h, bold + "-" + h,
        mixed + "-" + h, superscript + "-" + h, "1758000000000-" + h + "\n",
        "1758000000000-" + h + "\n\n", "1758000000000-" + h + "\r\n", "1758000000000-" + h + " ",
        " 1758000000000-" + h, "1758000000000_" + h, "1758000000000--" + h, "", "-", "\n",
        "+758000000000-" + h, "1758000000000-" + h + " ",
    ]
    return [{"key": k, "mint": op.parse_key(k)} for k in cases]


INT_CASES = [
    None, "null", "0", '""', "false", "true", "5", "-3", "-0", '"12"', '" 12 "', '"1_000"', '"1__0"',
    '"_1"', '"1_"', '"+7"', '"-0"', '"\\u0661\\u0662"', '"\\u2003 7 \\u3000"', '"\\u00a07\\u0085"',
    '"7.0"', '"abc"', '"0x10"', '"\\u00b9"', '"- 1"', '"1 2"', "2.9", "-2.9", "0.0", "-0.0", "1e300",
    "NaN", "Infinity", "-Infinity", "[]", "[1]", "{}", '{"a": 1}', "9223372036854775807",
    "-9223372036854775808", "9223372036854775808", '"9223372036854775808"',
    '"' + "1" * 4300 + '"', '"' + "1" * 4301 + '"', '"' + "0" * 4301 + '"', "1e18", "9.3e18",
    "18446744073709551616", "-18446744073709551617", "9" * 4300, "-" + "9" * 4300, '"' + "9" * 4300 + '"',
    '"-' + "9" * 30 + '"', '" 1_000_000_000_000_000_000_000 "', "1e19", "-1.7976931348623157e308",
    "1.2345678901234567e29", "5e-324", "-9223372036854775809", '"' + chr(0xFF11) + "0" * 25 + '"',
]


def section_py_int(op):
    """`int(x or 0)` exercised through the real `watermark`, which is
    exactly `int(meta.get("from_ms") or 0)`."""
    rows = []
    for text in INT_CASES:
        meta = {} if text is None else {"from_ms": json.loads(text)}
        res = outcome(lambda: op.watermark({op.META: meta}))
        rows.append({"json": text, **res})
    return rows


FP_NODE_CASES = [
    '{"node": "alpha"}', '{"node": "alpha", "fp_node": "old"}', '{"node": "alpha", "fp_node": ""}',
    '{"node": "alpha", "fp_node": null}', '{"fp_node": 0, "node": "b"}', '{}', '{"node": 7}',
    '{"node": -0}', '{"node": true}', '{"node": false, "fp_node": false}', '{"node": 1.5}',
    '{"node": 1e16}', '{"node": 1e-05}', '{"node": -0.0, "fp_node": "x"}', '{"node": NaN}',
    '{"node": Infinity}', '{"node": -Infinity}', '{"node": 123456789012345678901234567890}',
    '{"node": []}', '{"node": [1]}', '{"node": {"a": 1}}', '{"node": "\\u00e9\\ud83d\\ude00"}',
]


def section_fp_node(op):
    rows = []
    for text in FP_NODE_CASES:
        row = json.loads(text)
        rows.append({"row_json": text, **outcome(lambda: op.fp_node(row))})
    return rows


def bits(x: float) -> str:
    return struct.pack(">d", x).hex()


def float_corpus(rng: random.Random):
    fixed = [0.0, -0.0, 1.0, -1.0, 0.1, 0.2, 0.30000000000000004, 1.5, 100.0, 1e15, 1e16, 1e17,
             9999999999999998.0, 1234567890123456.7, 12345678901234567.0, 1e-4, 1e-5, 0.00012345,
             1.2345e-5, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 123.456, -9.99,
             2.0 ** 53, 2.0 ** 63, 2.0 ** 64, 1 / 3, 2 / 3, 1e22, 1e21, 1e23, 4.35, 0.5, 0.05]
    out = fixed[:]
    for _ in range(400):
        x = struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))[0]
        if x == x and abs(x) != float("inf"):
            out.append(x)
    for _ in range(150):
        out.append(round(rng.uniform(-1e6, 1e6), rng.randint(0, 8)))
    for e in range(-8, 24):
        out.append(10.0 ** e)
        out.append(-(1.5 * 10.0 ** e))
    return out


def section_float(rng):
    return [{"bits": bits(x), "repr": repr(x), "json": json.dumps(x)} for x in float_corpus(rng)]


CANONICAL_CASES = [
    "{}", "[]", "null", "true", "false", "0", "-0", "-0.0", "1.0", "1E2", "1e16", "1e-05", "0.1",
    "1e400", "-1e400", "NaN", "Infinity", "-Infinity", "123456789012345678901234567890",
    '"plain"', '"q\\"b\\\\s/"', '"\\u0000\\u0001\\b\\t\\n\\u000b\\f\\r\\u001f\\u007f\\u0080"',
    '"\\u2028\\u2029\\u00e9\\u4e2d\\ud83d\\ude00"', '{"b": 1, "a": 2, "c": {"z": [3, {"y": 0, "x": 1}]}}',
    '{"\\uffff": 1, "\\ud83d\\ude00": 2, "\\ue000": 3, "z": 4, "\\u00e9": 5, "E": 6}',
    '{"a": 1, "a": 2}', '{"a": {"k": 1}, "a": {"k": 2, "j": 3}}', '{"x": [1.5, -0.0, 1e100, NaN]}',
    '{"to": "beta", "body": "hi", "kind": "request", "urgent": false, "n": null}',
    '["\\ud800"]', '{"\\udfff": 1}', '[[[[[]]]]]', '{"": ""}', '[1, "1", true, 1.0]',
]


def section_canonical(op):
    rows = []
    for text in CANONICAL_CASES:
        value = json.loads(text)
        dumped = op._canonical(value)
        try:
            dumped.encode("utf-8")
        except UnicodeEncodeError:
            rows.append({"args_json": text, "outside": True})
            continue
        rows.append({"args_json": text, "canonical": dumped})
    return rows


def section_sha256(rng):
    msgs = [(b"", 1), (b"abc", 1), (b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 1),
            (b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu", 1),
            (b"a", 1_000_000)]
    for n in (1, 55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 1000):
        msgs.append((bytes(rng.getrandbits(8) for _ in range(n)), 1))
    return [{"hex": m.hex(), "repeat": r, "digest": hashlib.sha256(m * r).hexdigest()} for m, r in msgs]


def section_fingerprint(op):
    rows = []
    calls = [("orgtree_message", "alpha", 0), ("orgtree_message", "alpha", 1), ("orgtree_hire", "alpha", 3),
             ("orgtree_work", "é中-\U0001F600", -2), ("", "", 0), ("t", "n", I64_MAX),
             ("orgtree_Message", "alpha", 1), ("orgtree_message ", "alpha", 1)]
    for i, text in enumerate(CANONICAL_CASES):
        tool, node, gen = calls[i % len(calls)]
        args = json.loads(text)
        res = outcome(lambda: op.fingerprint(tool, node, gen, args))
        if res.get("raises") == "UnicodeEncodeError":
            res = {"outside": True}
        rows.append({"tool": tool, "node": node, "generation": gen, "args_json": text, **res})
    for gen in BIG_GENERATIONS:
        res = outcome(lambda: op.fingerprint(TOOL, "alpha", gen, dict(ARGS)))
        rows.append({"tool": TOOL, "node": "alpha", "generation": gen, "args_json": json.dumps(ARGS), **res})
    return rows


# Generations beyond i64, up to and past the widest `str()` renders.
BIG_GENERATIONS = [2**63, -(2**63) - 1, 2**64, 10**40, -(10**40), BIG, -BIG, BIG + 1, -(BIG + 1)]


TOOL = "orgtree_message"
ARGS = {"to": "beta", "body": "hi"}
REMOVE = object()


def mkrow(op, n, *, node="alpha", gen=1, k=None, mint=NOW, tool=TOOL, args=ARGS, result="applied", edit=None):
    """A receipt row built by the real `opreceipts.row`, then edited the way a
    legacy or damaged document might hold it (edits never re-fingerprint)."""
    r = op.row(op_id=f"r{n:04d}", node=node, generation=gen, key=k or key(mint), mint_ms=mint,
               tool=tool, args=args, cls="tx", outcome=result, at="2026-09-22T00:00:00Z")
    for f, v in (edit or {}).items():
        if v is REMOVE:
            r.pop(f, None)
        else:
            r[f] = v
    return r


def doc(op, rows=None, meta=None):
    d = {"slug": "oracle"}
    if rows is not None:
        d[op.SECTION] = rows
    if meta is not None:
        d[op.META] = meta
    return d


def row_index(d, op, info):
    r = info.get("row")
    if r is None:
        return None
    return next(i for i, x in enumerate(d[op.SECTION]) if x is r)


def admission_cases(op):
    K, other = key(NOW), dict(ARGS, body="bye")
    fenced = mkrow(op, 1, result="fenced")
    renamed = doc(op, [mkrow(op, 2)])
    op.rekey_nodes(renamed, {"alpha": "gamma"})
    renamed2 = doc(op, [mkrow(op, 3)])
    op.rekey_nodes(renamed2, {"alpha": "gamma"})
    op.rekey_nodes(renamed2, {"gamma": "delta"})
    arabic = "".join(chr(0x660 + int(d)) for d in str(NOW)) + "-" + "0" * 24
    base = dict(node="alpha", generation=1, key=K, tool=TOOL, args=ARGS, now_ms=NOW, epoch_ok=True)
    c = []

    def add(d, **kw):
        c.append((d, dict(base, **kw)))

    add(doc(op), key="")
    add(doc(op), key="", epoch_ok=False)
    add(doc(op, [mkrow(op, 4)]), key="1758000000000-ABC", epoch_ok=False)
    add(doc(op), epoch_ok=False)
    add(doc(op, [mkrow(op, 5)]), epoch_ok=False)
    add(doc(op, [fenced]), epoch_ok=False)
    add(doc(op, [mkrow(op, 6, args=other)]), epoch_ok=False)
    add(doc(op, [mkrow(op, 7, gen=4)]), epoch_ok=False)
    add(doc(op, [mkrow(op, 8)]), key=key(NOW + 60_000 + 1000), now_ms=NOW + 1000, epoch_ok=False)
    for delta in (60_001, 60_000, 59_999):
        add(doc(op), key=key(NOW + delta))
    for delta in (900_001, 900_000, 899_999):
        add(doc(op), key=key(NOW - delta))
    add(doc(op, [mkrow(op, 9, mint=NOW + 60_001, k=key(NOW + 60_001))]), key=key(NOW + 60_001))
    add(doc(op, [mkrow(op, 10, tool="orgtree_hire")]))
    add(doc(op, [mkrow(op, 11, args=other)]))
    add(doc(op, [mkrow(op, 12, result="fenced", gen=3)]))
    add(doc(op, [mkrow(op, 13, gen=3)]))
    add(doc(op, [mkrow(op, 14)]))
    add(doc(op, [mkrow(op, 15, gen=0)]), generation=0)
    add(doc(op, [mkrow(op, 16, gen=2, edit={"gen": "2"})]), generation=2)
    add(doc(op, [mkrow(op, 17, gen=2, edit={"gen": 2.7})]), generation=2)
    add(doc(op, [mkrow(op, 18, gen=1, edit={"gen": True})]))
    add(doc(op, [mkrow(op, 19, gen=0, edit={"gen": REMOVE})]), generation=0)
    add(doc(op, [mkrow(op, 20, gen=0, edit={"gen": None})]), generation=1)
    add(doc(op, [mkrow(op, 21, edit={"gen": "x"})]))
    add(doc(op, [mkrow(op, 22, edit={"gen": "x"})]), epoch_ok=False)
    add(doc(op, [mkrow(op, 23), mkrow(op, 24, args=other)]))
    add(doc(op, [mkrow(op, 25, args=other), mkrow(op, 26)]))
    add(doc(op, [mkrow(op, 27, gen=1), mkrow(op, 28, gen=2)]), generation=1)
    add(doc(op, [mkrow(op, 29, node="beta")]))
    add(doc(op, [mkrow(op, 30, k=key(NOW, 0xDEF))]))
    add(renamed, node="gamma")
    add(renamed, node="alpha")
    add(renamed2, node="delta")
    add(doc(op, [mkrow(op, 31, edit={"fp_node": 5, "node": "alpha"})]))
    add(doc(op, [mkrow(op, 32, node="5", edit={"node": "alpha", "fp_node": 5})]))
    add(doc(op, [mkrow(op, 33, edit={"tool": None})]))
    add(doc(op, [mkrow(op, 34, edit={"fp": 12})]))
    add(doc(op, [mkrow(op, 35, edit={"key": 17})]))
    add(doc(op, [mkrow(op, 36, edit={"outcome": "fenced"})]))
    add(doc(op, [mkrow(op, 37, edit={"node": ["alpha"]})]))
    add(doc(op, [mkrow(op, 38, edit={"fp_node": ["x"]})]))
    for meta in ({"schema": 2}, {"schema": "2"}, {"coverage": 2}, {"schema": 1, "coverage": 1},
                 {"schema": 0.5, "coverage": 2.0}, {"schema": "x"}, {"schema": float("nan")},
                 {"from_ms": NOW}, {"from_ms": NOW + 1}, {"from_ms": str(NOW + 1)}, {"from_ms": NOW - 1},
                 {"from_ms": float(NOW) + 0.5}, {"schema": 2, "from_ms": NOW + 1}, {}, [], "x"):
        add(doc(op, meta=meta))
    add(doc(op, [mkrow(op, 39)], meta={"schema": 2}))
    add(doc(op, [mkrow(op, 40)], meta={"from_ms": NOW + 5}))
    add(doc(op, meta=None) | {op.META: None})
    add(doc(op), key=arabic, now_ms=NOW)
    add(doc(op), key=K + "\n")
    add(doc(op, [mkrow(op, 41, k=K + "\n")]), key=K + "\n")
    add(doc(op, [mkrow(op, 42)]), key=K + "\n")
    add(doc(op, [mkrow(op, 43, args={"n": 1.0})]), args={"n": 1})
    add(doc(op, [mkrow(op, 44, args={"b": 1, "a": 2})]), args={"a": 2, "b": 1})
    add(doc(op, [mkrow(op, 45)]), node="alpha", generation=1, now_ms=NOW + 900_000)
    # Integers beyond i64 are exact: generations, clocks and metadata.
    g64 = 2**64
    add(doc(op, [mkrow(op, 46, gen=g64)]), generation=g64)
    add(doc(op, [mkrow(op, 47, gen=g64)]), generation=g64 + 1)
    add(doc(op, [mkrow(op, 48, gen=g64, edit={"gen": str(g64)})]), generation=g64)
    add(doc(op, [mkrow(op, 49, gen=10**20, edit={"gen": 1e20})]), generation=10**20)
    add(doc(op, [mkrow(op, 50, gen=-(2**70))]), generation=-(2**70))
    add(doc(op, [mkrow(op, 51, gen=BIG)]), generation=BIG)
    add(doc(op, [mkrow(op, 52, gen=BIG)]), generation=BIG - 1)
    add(doc(op, [mkrow(op, 53)]), generation=BIG)
    add(doc(op, [mkrow(op, 54)]), generation=BIG + 1)
    add(doc(op, [mkrow(op, 55, result="fenced")]), generation=BIG + 1)
    add(doc(op), generation=BIG + 1)
    add(doc(op, [mkrow(op, 56, edit={"gen": "1" * 4301})]))
    add(doc(op, [mkrow(op, 57, gen=int("9" * 4300), edit={"gen": "9" * 4300})]), generation=int("9" * 4300))
    add(doc(op), now_ms=10**20)
    add(doc(op), now_ms=-(10**20))
    add(doc(op), now_ms=10**400, epoch_ok=False)
    add(doc(op), now_ms=NOW + AGE_OVERFLOW - 1)
    add(doc(op), now_ms=NOW + AGE_OVERFLOW)
    add(doc(op), now_ms=NOW - AGE_OVERFLOW + 1)
    add(doc(op), now_ms=NOW - AGE_OVERFLOW)
    add(doc(op), now_ms=-BIG)
    for meta in ({"from_ms": 10**30}, {"from_ms": "-" + "9" * 40}, {"schema": 10**30}, {"schema": -(10**30)},
                 {"coverage": "9" * 50}, {"from_ms": 1e300}, {"from_ms": BIG}, {"schema": -BIG, "from_ms": -BIG}):
        add(doc(op, meta=meta))
    return c


def section_admission(op):
    rows = []
    for d, kw in admission_cases(op):
        text = json.dumps(d)
        d = json.loads(text)  # the crate sees exactly what json.loads gives

        def call():
            decision, info = op.admit(d, kw["node"], kw["generation"], kw["key"], kw["tool"],
                                      copy.deepcopy(kw["args"]), kw["now_ms"], epoch_ok=kw["epoch_ok"])
            return {"decision": decision, "reason": info.get("reason"), "row": row_index(d, op, info),
                    "row_state": info.get("row_state"), "mint_ms": info.get("mint_ms")}

        res = outcome(call)
        rows.append({"doc_json": text, "node": kw["node"], "generation": kw["generation"], "key": kw["key"],
                     "tool": kw["tool"], "args_json": json.dumps(kw["args"]), "now_ms": kw["now_ms"],
                     "epoch_ok": kw["epoch_ok"], **res})
    return rows


def section_find(op):
    K = key(NOW)
    docs = [doc(op), doc(op, []), doc(op, [mkrow(op, 50)]),
            doc(op, [mkrow(op, 51, gen=1), mkrow(op, 52, gen=5), mkrow(op, 53, node="beta")]),
            doc(op, [mkrow(op, 54, args={"x": 1}), mkrow(op, 55), mkrow(op, 56, k=key(NOW, 1))]),
            doc(op, [mkrow(op, 57, result="fenced"), mkrow(op, 58, tool="orgtree_hire")])]
    rows = []
    for d in docs:
        text = json.dumps(d)
        for node in ("alpha", "beta", "gamma"):
            for k in (K, key(NOW, 1)):
                d2 = json.loads(text)

                def call():
                    r = op.find(d2, node, k)
                    idx = None if r is None else next(i for i, x in enumerate(d2[op.SECTION]) if x is r)
                    return {"find": idx, "state": op.classify(r, TOOL, dict(ARGS))}

                rows.append({"doc_json": text, "node": node, "key": k, "tool": TOOL,
                             "args_json": json.dumps(ARGS), **outcome(call)})
    return rows


def log_spec_rows(spec):
    rows = [{"mint_ms": spec["base"] + i * spec["step"]} for i in range(spec["n"])]
    for o in spec.get("overrides", []):
        if o.get("absent"):
            rows[o["i"]].pop("mint_ms")
        else:
            rows[o["i"]]["mint_ms"] = json.loads(o["json"])
    return rows


def section_append(op):
    cases = [
        ({"n": 0, "base": NOW, "step": 1}, None, None),
        ({"n": 0, "base": NOW, "step": 1}, "absent", None),
        ({"n": 0, "base": NOW, "step": 1}, None, "null"),
        ({"n": 0, "base": NOW, "step": 1}, None, "{}"),
        ({"n": 3, "base": NOW, "step": 1}, None, '{"seq": "4", "from_ms": 9}'),
        ({"n": 499, "base": NOW, "step": 10}, None, '{"seq": 499, "from_ms": 0}'),
        ({"n": 500, "base": NOW, "step": 10}, None, '{"seq": 500, "from_ms": 0}'),
        ({"n": 500, "base": NOW, "step": 10}, None, None),
        ({"n": 501, "base": NOW, "step": 10}, None, '{"seq": 501}'),
        ({"n": 600, "base": NOW, "step": 1}, None, '{"seq": 7, "evicted": "3"}'),
        ({"n": 500, "base": NOW, "step": 10, "overrides": [{"i": 3, "json": str(NOW + 120_000)}]}, None, "{}"),
        ({"n": 500, "base": NOW, "step": -10}, None, "{}"),
        ({"n": 500, "base": NOW, "step": 10}, None, '{"from_ms": ' + str(NOW + 10**9) + "}"),
        ({"n": 500, "base": NOW, "step": 10}, None, '{"from_ms": "' + str(NOW + 10**9) + '"}'),
        ({"n": 500, "base": NOW, "step": 1, "overrides": [{"i": 0, "absent": True}, {"i": 1, "json": "null"},
                                                          {"i": 2, "json": '"5"'}, {"i": 3, "json": "2.5"}]}, None, "{}"),
        ({"n": 500, "base": 0, "step": 0, "overrides": [{"i": 0, "absent": True}]}, None, "{}"),
        ({"n": 500, "base": NOW, "step": 1, "overrides": [{"i": 50, "json": '"x"'}]}, None, "{}"),
        ({"n": 500, "base": NOW, "step": 1, "overrides": [{"i": 450, "json": '"x"'}]}, None, "{}"),
        ({"n": 3, "base": NOW, "step": 1}, None, '{"from_ms": "abc"}'),
        ({"n": 3, "base": NOW, "step": 1}, None, '{"seq": "abc"}'),
        ({"n": 3, "base": NOW, "step": 1}, "null", "{}"),
        ({"n": 3, "base": NOW, "step": 1}, None, "[]"),
        ({"n": 500, "base": NOW, "step": 1}, None, '{"from_ms": NaN}'),
        ({"n": 3, "base": NOW, "step": 1}, None, '{"seq": ' + "9" * 4300 + "}"),
        ({"n": 3, "base": NOW, "step": 1}, None, '{"seq": -' + "9" * 30 + ', "from_ms": -' + "9" * 30 + "}"),
        ({"n": 500, "base": NOW, "step": 1}, None, '{"from_ms": ' + str(10**30) + ', "evicted": ' + "9" * 4300 + "}"),
        ({"n": 500, "base": NOW, "step": 10, "overrides": [{"i": 3, "json": "1e30"}]}, None, "{}"),
        ({"n": 500, "base": NOW, "step": 10, "overrides": [{"i": 7, "json": '"' + "9" * 40 + '"'}]}, None, "{}"),
        ({"n": 500, "base": NOW, "step": 10, "overrides": [{"i": 9, "json": "9" * 4300}]}, None, "{}"),
        ({"n": 500, "base": NOW, "step": 10, "overrides": [{"i": 0, "json": "-" + "9" * 40}]},
         None, '{"from_ms": -' + "9" * 50 + "}"),
        ({"n": 500, "base": NOW, "step": 1}, None, '{"evicted": "-' + "9" * 40 + '"}'),
    ]
    out = []
    for spec, section, meta_text in cases:
        d = {"slug": "oracle"}
        if section is None:
            d[op.SECTION] = log_spec_rows(spec)
        elif section == "null":
            d[op.SECTION] = None
        if meta_text is not None:
            d[op.META] = json.loads(meta_text)
        created = d.get(op.META) is None
        before = len(d.get(op.SECTION) or [])

        def call():
            op.append(d, {"mint_ms": NOW}, now_ms=NOW)
            cut = before + 1 - len(d[op.SECTION])
            return {"created_meta": created, "seq": op.seq(d), "len": len(d[op.SECTION]), "cut": cut,
                    "watermark": op.watermark(d), "evicted": d[op.META]["evicted"] if cut else None}

        res = outcome(call)
        out.append({"log": spec, "section": section or "list", "meta_json": meta_text, **res})
    return out


def section_meta(op):
    rows = []
    for text in (None, "null", "{}", "[]", '"x"', "0", '{"schema": 1}', '{"schema": 2}', '{"schema": "2"}',
                 '{"schema": 1.9}', '{"schema": 2.0}', '{"coverage": 2}', '{"coverage": "x"}',
                 '{"schema": 2, "coverage": "x"}', '{"schema": true}', '{"schema": [2]}',
                 '{"from_ms": 5, "schema": 0}', '{"schema": 100000000000000000000}',
                 '{"coverage": "99999999999999999999"}', '{"schema": -100000000000000000000, "coverage": 1}',
                 '{"from_ms": -1e300}', '{"from_ms": ' + "9" * 4300 + "}", '{"from_ms": "-' + "9" * 4300 + '"}',
                 '{"schema": "\\u0662"}'):
        d = {"slug": "oracle"} if text is None else {"slug": "oracle", op.META: json.loads(text)}
        rows.append({"meta_json": text,
                     "schema_ahead": outcome(lambda: op.schema_ahead(d) != ""),
                     "watermark": outcome(lambda: op.watermark(d))})
    return rows


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
    backend = str(repo / "engine" / "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)
    from orgtree import opreceipts as op  # noqa: PLC0415

    rng = random.Random(20260923)
    real_fp_node = guard_fp_node(op)
    try:
        return sections(op, rng, repo)
    finally:
        op.fp_node = real_fp_node


def sections(op, rng, repo: Path) -> dict:
    return {
        "schema": SCHEMA,
        "oracle": {"python": ".".join(map(str, sys.version_info[:3])),
                   "unicode": unicodedata.unidata_version,
                   "anchors": anchors(repo)},
        "limits": "Synthetic inputs only. Expected values are current Python behavior, not a new contract.",
        "tables": section_tables(),
        "key": section_key(op),
        "py_int": section_py_int(op),
        "fp_node": section_fp_node(op),
        "float": section_float(rng),
        "canonical": section_canonical(op),
        "sha256": section_sha256(rng),
        "fingerprint": section_fingerprint(op),
        "find": section_find(op),
        "meta": section_meta(op),
        "admission": section_admission(op),
        "append": section_append(op),
    }


def encode_ints(v):
    """Integers are exact at any width. One longer than Python's default
    `str()` limit cannot be a JSON number that `json.loads` (or the Rust
    reader) accepts, so it is written as its decimal string."""
    if isinstance(v, dict):
        return {k: encode_ints(x) for k, x in v.items()}
    if isinstance(v, list):
        return [encode_ints(x) for x in v]
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > BIG:
        old = sys.get_int_max_str_digits()
        sys.set_int_max_str_digits(0)
        try:
            return str(v)
        finally:
            sys.set_int_max_str_digits(old)
    return v


def render(doc: dict) -> str:
    return json.dumps(encode_ints(doc), ensure_ascii=True, indent=1) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo-root", type=Path, default=CRATE.parents[2])
    ap.add_argument("--vectors", type=Path, default=DEFAULT_VECTORS)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = ap.parse_args()
    text = render(build(args.repo_root.resolve()))
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
