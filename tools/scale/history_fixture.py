"""Offline matched-history bundles. No engine, provider or database is started.

The input is one frozen, prepared logical org document and optional current
transcript files. It is shared byte-for-byte by both arms. Generated rows are
older than the fixed tails and restored BEFORE those tails, never after them.
Large bundles are streamed; only the fixed base and one history row are resident.
"""
from __future__ import annotations

import argparse
import copy
from dataclasses import asdict, dataclass
import hashlib
import json
import math
import os
import shutil
from pathlib import Path, PurePosixPath
import time
import uuid

FORMAT = "orgtree.history-pair/v1"
FAMILIES = ("retired_agents", "archived_items", "read_mail", "old_transcripts")
OLD = "2000-01-01T00:00:00.000Z"
PREFIX = "hist-"
# A common fixture choice, made before freezing active state. Historical
# ordinals below it cannot alter the next assigned ordinal between arms.
MAIL_FLOOR = 1_000_000_000
HISTORY_ORDINAL = 500_000_000
NS = uuid.UUID("834dd39e-9a8e-427e-b70c-684d7ab2e17c")


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(compact(value).encode("utf-8")).hexdigest()


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_relative(name):
    if not isinstance(name, str):
        raise ValueError("unsafe relative file path")
    path = PurePosixPath(name)
    if (not name or str(path) != name or path.is_absolute() or
            any(p in ("..", ".") for p in path.parts) or "\\" in name or ":" in name):
        raise ValueError("unsafe relative file path")
    return path


def regular_file(path):
    path = Path(path)
    safe_root(path.parent)
    if path.is_symlink() or not path.is_file():
        raise ValueError("fixture input must be a regular file")
    return path


def safe_root(path, *, new=False):
    path = Path(path)
    if not path.is_absolute() or path == Path(path.anchor):
        raise ValueError("fixture root must be an absolute, owned directory")
    resolved = path.resolve()
    for env in ("APPDATA", "LOCALAPPDATA"):
        folder = os.environ.get(env)
        if folder:
            for product in ("Orgtree", "Orgtree v2"):
                live = (Path(folder) / product).resolve()
                if resolved == live or live in resolved.parents:
                    raise ValueError("live Orgtree tree is not a fixture root")
    for ancestor in (path, *path.parents):
        if ancestor.exists() and (ancestor.is_symlink() or
                bool(getattr(ancestor, "is_junction", lambda: False)())):
            raise ValueError("fixture path traverses a reparse point")
    if new and path.exists() and any(path.iterdir()):
        raise ValueError("output must be new or empty; never overwrite a fixture")
    return path


@dataclass(frozen=True)
class Recipe:
    retired_agents: int = 1000
    archived_items: int = 2000
    read_mail: int = 100000
    old_transcripts: int = 1000
    multiplier: int = 10
    seed: int = 1
    # Fixed sizes support tiny controls. The default uses the existing scale
    # seed's measured quantiles with an independent deterministic 100-row cycle.
    payload_profile: str = "live_quantiles"
    node_chars: int = 4096
    item_chars: int = 13331
    mail_chars: int = 4210
    transcript_chars: int = 262144

    def validate(self):
        if self.payload_profile not in ("fixed", "live_quantiles"):
            raise ValueError("unknown payload profile")
        for field in FAMILIES:
            n = getattr(self, field)
            if type(n) is not int or not 1 <= n <= 10_000_000:
                raise ValueError("history counts must be positive bounded integers")
        if type(self.multiplier) is not int or not 10 <= self.multiplier <= 100:
            raise ValueError("history multiplier must be at least ten and at most100")
        if self.old_transcripts > self.retired_agents:
            raise ValueError("each old transcript needs its own retired identity")
        if type(self.seed) is not int:
            raise ValueError("seed must be an integer")
        for field in ("node_chars", "item_chars", "mail_chars", "transcript_chars"):
            if type(getattr(self, field)) is not int or not 128 <= getattr(self, field) <= 1_000_000:
                raise ValueError("row payload outside the bounded range")


def prepare_base(document):
    """Declare a shared ordinal floor before freezing; never modify the input."""
    base = copy.deepcopy(document)
    nodes = base.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        raise ValueError("base must contain active nodes")
    for nid, node in nodes.items():
        if not isinstance(nid, str) or nid.startswith(PREFIX) or node.get("state") != "live":
            raise ValueError("base must be live-only with disjoint history identities")
        if node.get("id", nid) != nid or (node.get("parent") and node["parent"] not in nodes):
            raise ValueError("invalid base topology")
        floor = node.get("mail_seq", 0)
        if type(floor) is not int or floor < 0 or floor >= MAIL_FLOOR:
            raise ValueError("base receive ordinal exceeds the reserved history domain")
        node["mail_seq"] = MAIL_FLOOR
    if base.get("work_items_archive"):
        raise ValueError("start with an active docket; archive is generated independently")
    for row in base.get("work_items", []):
        if row.get("slug", "").startswith(PREFIX):
            raise ValueError("history slug collides with active docket")
    for rows in (base.get("mail_log") or {}).values():
        for row in rows:
            if row.get("id", "").startswith(PREFIX):
                raise ValueError("history mail identity collision")
    for family in ("mail", "mail_log"):
        for rows in (base.get(family) or {}).values():
            for row in rows:
                if "recv_seq" in row and (type(row["recv_seq"]) is not int or
                        not 1 <= row["recv_seq"] < HISTORY_ORDINAL):
                    raise ValueError("base mail overlaps reserved history ordinals")
    for batches in (base.get("delivering") or {}).values():
        for batch in batches:
            for row in batch.get("mail", []):
                if "recv_seq" in row and (type(row["recv_seq"]) is not int or
                        not 1 <= row["recv_seq"] < HISTORY_ORDINAL):
                    raise ValueError("delivery overlaps reserved history ordinals")
    compact(base)  # Reject NaN and unsupported values before writing anything.
    return base


def validate_base(base):
    check = copy.deepcopy(base)
    for node in check.get("nodes", {}).values():
        if node.get("mail_seq") != MAIL_FLOOR:
            raise ValueError("shared receive ordinal floor missing or changed")
        node["mail_seq"] = 0
    prepare_base(check)


def baseline_counts(base):
    # Fixed recent/read archive tails stay identical and count towards BOTH
    # count and byte ratios. They are not quietly excluded as active data.
    result = {name: {"count": 0, "bytes": 0} for name in FAMILIES}
    for rows in (base.get("mail_log") or {}).values():
        for row in rows:
            result["read_mail"]["count"] += 1
            result["read_mail"]["bytes"] += len(compact(row).encode())
    return result


def identity(kind, index):
    return f"{PREFIX}{kind}-{index:012d}"


def text(seed, family, index, size):
    token = hashlib.sha256(f"{seed}:{family}:{index}".encode()).hexdigest() + " "
    return (token * math.ceil(size / len(token)))[:size]


def payload_size(family, index, recipe):
    field = dict(retired_agents="node_chars", archived_items="item_chars",
                 read_mail="mail_chars", old_transcripts="transcript_chars")[family]
    if recipe.payload_profile == "fixed" or family == "old_transcripts":
        return getattr(recipe, field)
    quantiles = {"retired_agents": (1036, 3867, 5620, 6106),
                 "archived_items": (13331, 80359, 487770, 910613),
                 "read_mail": (1083, 4210, 16061, 200000)}[family]
    # A permutation visits every quantile bucket once per 100 rows; varying
    # counts never advances an active-data RNG or alters an earlier record.
    u = (((index * 37 + recipe.seed) % 100) + .5) / 100
    points = [(0., max(1, quantiles[0] // 8)), (.5, quantiles[0]),
              (.9, quantiles[1]), (.99, quantiles[2]), (1., quantiles[3])]
    for (lo, a), (hi, b) in zip(points, points[1:]):
        if u <= hi:
            return int(a + (b - a) * (u - lo) / (hi - lo))
    raise AssertionError("quantile outside range")


def history_row(family, index, base, recipe, live=None):
    live = live if live is not None else sorted(base["nodes"])
    owner = live[index % len(live)]
    sid = str(uuid.uuid5(NS, f"{recipe.seed}:session:{index}"))
    nid = identity("node", index)
    if family == "retired_agents":
        # Copy the real active-node shape, but never copy a pending runtime,
        # predecessor chain, mutable grant or watcher into retired history.
        row = copy.deepcopy(base["nodes"][owner])
        row.update(id=nid, name=nid, title=nid, lineage=nid, parent=owner, state="archived", grant=0, model="haiku",
                   generation=0, seat_id=identity("seat", index), session_id=sid,
                   charter=text(recipe.seed, family, index, payload_size(family, index, recipe)),
                   created=OLD, archived_at=OLD, cost_usd=0, turns=[], pid=None,
                   last_status=dict(status="idle", summary="retired history", at=OLD),
                   reply_incarnation=identity("incarnation", index), mail_seq=0,
                   mailbox_id=identity("mailbox", index))
        for key in ("predecessor", "successor", "frozen", "halted", "cache_keepalive_at"):
            row.pop(key, None)
        return row
    if family == "archived_items":
        return dict(slug=identity("work", index), title=f"Closed history {index:012d}",
                    kind="code", owner={"node": owner, "generation": 0},
                    status="done", archived=True, archived_at=OLD, updated_at=OLD,
                    created_at=OLD, objective="Completed historical work", participants=[],
                    attention=False, manual_attention=None, holders=[],
                    evidence=[dict(kind="note", ref="old", note=text(recipe.seed, family, index, payload_size(family, index, recipe)))])
    if family == "read_mail":
        # Use a disjoint older ordinal domain, below the fixed active floor.
        seq = HISTORY_ORDINAL + index // len(live) + 1
        if seq >= MAIL_FLOOR:
            raise ValueError("history exhausted the reserved ordinal domain")
        return dict(id=identity("mail", index), **{"from": live[(index + 1) % len(live)], "to": owner},
                    at=OLD, kind="message", read=True, recv_seq=seq,
                    body=text(recipe.seed, family, index, payload_size(family, index, recipe)))
    if family == "old_transcripts":
        user_id = str(uuid.uuid5(NS, f"{sid}:user"))
        reply_id = str(uuid.uuid5(NS, f"{sid}:assistant"))
        return dict(node=nid, session=sid, records=[
            dict(type="user", uuid=user_id, parentUuid=None, timestamp=OLD,
                 sessionId=sid, cwd=base.get("workspace", ""), isSidechain=False, userType="external",
                 message=dict(role="user", content="Historical request")),
            dict(type="assistant", uuid=reply_id, parentUuid=user_id, timestamp=OLD,
                 sessionId=sid, cwd=base.get("workspace", ""), isSidechain=False, userType="external",
                 message=dict(id="msg_" + reply_id.replace("-", ""), type="message", role="assistant",
                              model="claude-haiku-4-5", content=[dict(type="text", text=text(
                                  recipe.seed, family, index, recipe.transcript_chars))],
                              stop_reason="end_turn", usage=dict(input_tokens=100, output_tokens=100)))])
    raise ValueError("unknown history family")


def write_family(path, family, base, recipe, count, target_bytes=0, guard=lambda: None):
    h, total, i = hashlib.sha256(), 0, 0
    live = sorted(base["nodes"])
    with path.open("xb") as stream:
        while i < count or total < target_bytes:
            if i % 64 == 0:
                guard()
            row = history_row(family, i, base, recipe, live)
            encoded = (compact(row) + "\n").encode("utf-8")
            stream.write(encoded)
            h.update(encoded)
            total += len(encoded)
            i += 1
    return dict(count=i, bytes=total, sha256=h.hexdigest())


def estimate(base, recipe=Recipe(), current_bytes=0):
    """Offline planning estimate, not an allocation or a large fixture build.

    Sample a complete quantile cycle across at most 1000 active templates.
    Database/index/WAL factors are explicit conservative planning allowances;
    the small restore receipt supplies actual measurements, not these factors.
    """
    recipe.validate()
    validate_base(base)
    live = sorted(base["nodes"])
    fixed = baseline_counts(base)
    rows, families = max(100, min(1000, len(live))), {}
    for family in FAMILIES:
        mean = sum(len((compact(history_row(family, i, base, recipe, live)) + "\n").encode())
                   for i in range(rows)) / rows
        small = getattr(recipe, family)
        large = max(recipe.multiplier * (small + fixed[family]["count"]) - fixed[family]["count"],
                    math.ceil((recipe.multiplier * (small * mean + fixed[family]["bytes"]) -
                               fixed[family]["bytes"]) / mean))
        families[family] = dict(sampled_mean_bytes=mean, small_count=small, large_count=large,
                                small_bytes=math.ceil(small * mean), large_bytes=math.ceil(large * mean))
    base_bytes = len(compact(base).encode())
    bundle = base_bytes + current_bytes + sum(f["small_bytes"] + f["large_bytes"] for f in families.values())
    large_sql = base_bytes + sum(families[k]["large_bytes"] for k in FAMILIES if k != "old_transcripts")
    restored_files = current_bytes + families["old_transcripts"]["large_bytes"]
    reserve = math.ceil(1.2 * (bundle + restored_files + 6 * large_sql)) + 2 * 1024**3
    return dict(families=families, base_bytes=base_bytes, current_file_bytes=current_bytes,
                pair_bundle_bytes=bundle, largest_sql_input_bytes=large_sql,
                largest_restored_file_bytes=restored_files, suggested_free_disk_bytes=reserve,
                assumptions="20% sizing margin; 3x SQL for heap/indexes plus 3x for WAL/temp; 2GiB spare; one restored arm at a time",
                limit="sampled size estimate; no latency, memory or full-fixture build-time measurement")


def build_pair(base, output, recipe=Recipe(), current_files=None, guard=lambda: None):
    """Write complete marker last. Failure leaves an explicitly incomplete bundle."""
    recipe.validate()
    validate_base(base)
    output = safe_root(output, new=True)
    output.mkdir(parents=True, exist_ok=True)
    planning = estimate(base, recipe, sum(regular_file(p).stat().st_size for p in (current_files or {}).values()))
    if shutil.disk_usage(output).free < planning["suggested_free_disk_bytes"]:
        raise ValueError("insufficient disk reserve for bundle and one restored arm")
    started = time.perf_counter()
    (output / "PREPARING").write_text(FORMAT, encoding="utf-8")
    base_path = output / "base.json"
    base_path.write_text(compact(base), encoding="utf-8")
    files = {}
    for name, source in sorted((current_files or {}).items()):
        rel = safe_relative(name)
        source = Path(source)
        safe_root(source.parent)
        if source.is_symlink() or not source.is_file():
            raise ValueError("current transcript must be a regular frozen file")
        target = output / "current-files" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as src, target.open("xb") as dst:
            while block := src.read(1024 * 1024):
                guard()
                dst.write(block)
        files[name] = dict(bytes=target.stat().st_size, sha256=sha_file(target))
    fixed = baseline_counts(base)
    arms = {}
    for arm in ("small", "large"):
        folder = output / arm
        folder.mkdir()
        rows = {}
        for family in FAMILIES:
            count, goal = getattr(recipe, family), 0
            if arm == "large":
                small = arms["small"][family]
                count = recipe.multiplier * (small["count"] + fixed[family]["count"]) - fixed[family]["count"]
                goal = recipe.multiplier * (small["bytes"] + fixed[family]["bytes"]) - fixed[family]["bytes"]
            # Transcript identities must all have a corresponding retired row.
            if family == "old_transcripts" and count > rows["retired_agents"]["count"]:
                raise ValueError("transcript count exceeds retired identities")
            rows[family] = write_family(folder / (family + ".jsonl"), family, base, recipe, count, goal, guard)
            if family == "old_transcripts" and rows[family]["count"] > rows["retired_agents"]["count"]:
                raise ValueError("transcript byte target exceeds retired identities")
        arms[arm] = rows
    manifest = dict(format=FORMAT, recipe=asdict(recipe), planning=planning, base_sha256=sha_file(base_path),
                    active_sha256=digest(base), current_files=files, baseline_history=fixed,
                    arms=arms, build_seconds=time.perf_counter() - started,
                    statistics_state="not_materialized", ordinal_floor=MAIL_FLOOR,
                    limits=["offline fixture; no latency or memory qualification",
                            "synthetic contents; live_quantiles reuse the 2026-09-26 seed profile, not a new fleet sample"])
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    verify_pair(output)
    (output / "COMPLETE").write_text(sha_file(output / "manifest.json"), encoding="ascii")
    (output / "PREPARING").unlink()
    return manifest


def read_rows(path):
    with regular_file(path).open("rb") as stream:
        while line := stream.readline(8 * 1024 * 1024 + 1):
            if len(line) > 8 * 1024 * 1024:
                raise ValueError("history row exceeds bounded record size")
            yield json.loads(line)


def verify_pair(output, *, require_complete=False):
    """Recompute streams and semantics, not just hashes supplied by the writer."""
    output = safe_root(output)
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") != FORMAT:
        raise ValueError("unknown fixture format")
    recipe = Recipe(**manifest["recipe"])
    recipe.validate()
    if require_complete and (not (output / "COMPLETE").is_file() or
            (output / "COMPLETE").read_text() != sha_file(output / "manifest.json") or
            (output / "PREPARING").exists()):
        raise ValueError("incomplete or changed fixture")
    base = json.loads((output / "base.json").read_text(encoding="utf-8"))
    live = sorted(base["nodes"])
    validate_base(base)
    if digest(base) != manifest["active_sha256"] or sha_file(output / "base.json") != manifest["base_sha256"]:
        raise ValueError("active base changed")
    if baseline_counts(base) != manifest["baseline_history"]:
        raise ValueError("fixed history count changed")
    for name, expected in manifest["current_files"].items():
        path = output / "current-files" / safe_relative(name)
        safe_root(path.parent)
        if path.is_symlink() or path.stat().st_size != expected["bytes"] or sha_file(path) != expected["sha256"]:
            raise ValueError("current transcript tail changed")
    for arm in ("small", "large"):
        for family in FAMILIES:
            path = output / arm / (family + ".jsonl")
            expected = manifest["arms"][arm][family]
            count = 0
            for i, row in enumerate(read_rows(path)):
                # Deterministic comparison also verifies references, archived /
                # settled state, old timestamps and unmodified active inputs.
                if row != history_row(family, i, base, recipe, live):
                    raise ValueError(f"invalid {arm} {family} row {i}")
                count += 1
            if count != expected["count"] or path.stat().st_size != expected["bytes"] or sha_file(path) != expected["sha256"]:
                raise ValueError("history stream incomplete or altered")
            minimum = getattr(recipe, family)
            if count < minimum:
                raise ValueError("insufficient small history")
            if family == "old_transcripts" and count > manifest["arms"][arm]["retired_agents"]["count"]:
                raise ValueError("old transcript has no retired identity")
            if arm == "large":
                for metric in ("count", "bytes"):
                    fixed = manifest["baseline_history"][family][metric]
                    if expected[metric] + fixed < recipe.multiplier * (manifest["arms"]["small"][family][metric] + fixed):
                        raise ValueError(f"insufficient history {metric} ratio")
    allowed = {"base.json", "manifest.json", "PREPARING", "COMPLETE"}
    allowed.update(f"{arm}/{family}.jsonl" for arm in ("small", "large") for family in FAMILIES)
    allowed.update("current-files/" + name for name in manifest["current_files"])
    for path in output.rglob("*"):
        if path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)()):
            raise ValueError("fixture inventory contains a reparse point")
        if path.is_file() and path.relative_to(output).as_posix() not in allowed:
            raise ValueError("undeclared fixture file")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    build = sub.add_parser("build")
    build.add_argument("--base", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--recipe", type=Path, required=True)
    build.add_argument("--current-files", type=Path, help="JSON map of relative home paths to frozen source files")
    check = sub.add_parser("verify")
    check.add_argument("--output", type=Path, required=True)
    plan = sub.add_parser("estimate")
    plan.add_argument("--base", type=Path, required=True)
    plan.add_argument("--recipe", type=Path, required=True)
    plan.add_argument("--current-bytes", type=int, default=0)
    args = parser.parse_args()
    if args.action == "estimate":
        print(json.dumps(estimate(prepare_base(json.loads(args.base.read_text(encoding="utf-8"))),
                                  Recipe(**json.loads(args.recipe.read_text())), args.current_bytes), indent=2))
        return
    if args.action == "build":
        # CLI preparation is guarded independently of any future engine run.
        from control import free_commit_gb
        def guard():
            if free_commit_gb() < 10:
                raise RuntimeError("free commit below10GiB; preparation stopped")
        doc = json.loads(args.base.read_text(encoding="utf-8"))
        files = json.loads(args.current_files.read_text()) if args.current_files else {}
        result = build_pair(prepare_base(doc), args.output, Recipe(**json.loads(args.recipe.read_text())), files, guard=guard)
    else:
        result = verify_pair(args.output, require_complete=True)
    print(json.dumps(dict(active_sha256=result["active_sha256"], arms=result["arms"],
                          build_seconds=result["build_seconds"], statistics_state=result["statistics_state"])))


if __name__ == "__main__":
    main()
