"""Separate the measured window from continuous warmup without restarting UI."""
import json
from collections import defaultdict


def memory_floor(points, bucket_s=60.0, flat_pct=5.0):
    """Judge memory on its per-minute FLOOR and report the peak beside it.

    ``points`` are ``(t_seconds, bytes)``. Attempt 6's raw slope read as
    "climbing 16-21 MB/min", but the series swung 430 <-> 640 MB (a periodic
    archive decode) over flat lows. Its high phases sometimes lasted 55-119 s,
    so two whole minutes had no trough; coordinator-opus ruled those count
    (memory the engine really holds), with the 2-minute figure beside. Each
    ``bucket_s`` bucket whose samples cover at least 90 % of it keeps its
    minimum; a partial bucket is dropped because it may miss the trough.
    ``floor_flat`` holds when the
    least-squares floor trend, projected over the judged span, grows by at
    most ``flat_pct`` percent of the first floor (None with < 2 buckets).
    """
    if not points:
        return None
    t0 = points[0][0]
    floors, span = {}, {}
    for t, b in points:
        k = int((t - t0) // bucket_s)
        floors[k] = min(b, floors.get(k, b))
        first, last = span.get(k, (t, t))
        span[k] = (min(first, t), max(last, t))
    # A bucket counts when its samples cover at least 90 % of it.
    mb = [floors[k] / 2 ** 20 for k in sorted(floors) if span[k][1] - span[k][0] >= 0.9 * bucket_s]
    out = dict(bucket_s=bucket_s, floors_mb=[round(x, 1) for x in mb],
               peak_mb=round(max(b for _, b in points) / 2 ** 20, 1),
               floor_slope_mb_per_min=None, floor_growth_pct=None, floor_flat=None, flat_pct=flat_pct)
    if len(mb) >= 2:
        xs = range(len(mb))
        mx, my = sum(xs) / len(mb), sum(mb) / len(mb)
        per_bucket = sum((x - mx) * (y - my) for x, y in zip(xs, mb)) / sum((x - mx) ** 2 for x in xs)
        growth = 100 * per_bucket * (len(mb) - 1) / mb[0] if mb[0] else None
        out.update(floor_slope_mb_per_min=round(per_bucket * 60 / bucket_s, 2),
                   floor_growth_pct=round(growth, 2) if growth is not None else None,
                   floor_flat=growth is not None and growth <= flat_pct)
    return out


def summarize_window(folder, config):
    from load import pct
    begin, end = config["warmup_s"], config["duration_s"]
    def rows(name):
        path = folder / (name + ".jsonl")
        if path.exists():
            with path.open(encoding="utf-8") as source:
                for line in source:
                    yield json.loads(line)
    def inside(row):
        return begin <= row["t"] < end
    def group(source, key):
        groups = defaultdict(list)
        for row in source:
            if inside(row):
                groups[key(row)].append(row)
        return groups
    tools = group(rows("calls"), lambda r: r["tool"] + ":" + (r.get("action") or ""))
    routes = group(rows("ui"), lambda r: r["route"])
    def timings(groups):
        return {name: dict(count=len(values), errors=sum(bool(r["err"]) for r in values),
            reused_resets=sum(bool(r.get("reused_reset")) for r in values),
            total_ms=pct([r["total_ms"] for r in values]),
            successful_total_ms=pct([r["total_ms"] for r in values if not r["err"]]),
            http_ms=pct([r.get("http_ms", r.get("ms", 0)) for r in values]),
            queue_ms=pct([r.get("lag_ms", r.get("late_ms", 0)) for r in values]),
            wire_bytes=pct([r["wire_bytes"] for r in values if "wire_bytes" in r]),
            decoded_bytes=pct([r["bytes"] for r in values if "bytes" in r]),
            status={str(s): sum(r["status"] == s for r in values) for s in {r["status"] for r in values}})
            for name, values in groups.items()}
    # A planned marker the client never sent is a DEMAND failure, not a drop:
    # attempt 5 counted 2340 unsent markers per window as missing. Delivery is
    # judged on the markers actually sent (markers.jsonl carries plan IDs in
    # renderer-hooks mode); planned_not_sent is reported beside it, never
    # folded into expected, and the feed passes only when both are zero.
    # Attempt 6 failed the feed on ONE frame due 0.25 s before the close: its
    # agent's previous request was still in flight. split_unsent() tells that
    # close cutoff apart from a real backlog; only the backlog fails the feed,
    # and both are reported.
    from streaming import split_unsent
    plan = [r for r in rows("stream-plan") if inside(r)]
    expected = {r["m"] for r in plan}
    sent = {r["m"] for r in rows("markers")} & expected
    close_cutoff, backlog = split_unsent(plan, sent, config.get("stream_catchup_max", 1))
    seen = defaultdict(dict)
    for row in rows("feed-receipts"):
        if row["m"] in sent:
            seen[row["w"]][row["m"]] = (row["receive"] - row["emit"]) * 1000
    feed = {w: dict(expected=len(expected), sent=len(sent), planned_not_sent=len(expected - sent),
        planned_not_sent_close_cutoff=close_cutoff, planned_not_sent_backlog=backlog,
        received=len(seen[w]),
        missing_after_5s=len(sent)-sum(ms <= 5000 for ms in seen[w].values()),
        over_1s=sum(ms > 1000 for ms in seen[w].values()), latency_ms=pct(list(seen[w].values())))
        for w in range(config["windows"])}
    submits = [r for r in rows("stream") if inside(r)]
    feed_send = dict(requests=len(submits), errors=sum(bool(r["err"]) for r in submits),
        late_ms=pct([r["late_ms"] for r in submits]), frames_per_request=pct([r["frames"] for r in submits]),
        http_ms=pct([r["ms"] for r in submits]))
    feed_pass = bool(expected) and not any(f["planned_not_sent_backlog"] or f["missing_after_5s"] for f in feed.values())
    mem = [r for r in rows("guard") if inside(r)]
    samples = [r for r in rows("samples") if inside(r)]
    half = [r for r in mem if r["t"] >= (begin+end)/2]
    slope = None
    if len(half) >= 3:
        mt = sum(r["t"] for r in half)/len(half)
        my = sum(r["engine_private"] for r in half)/len(half)
        slope = sum((r["t"]-mt)*(r["engine_private"]-my) for r in half)/sum((r["t"]-mt)**2 for r in half)
    return dict(begin_s=begin, end_s=end, tools=timings(tools), routes=timings(routes), feed=feed, feed_send=feed_send, feed_pass=feed_pass,
        offered_tools=sum(inside(r) for r in rows("plan")), offered_steer=sum(inside(r) for r in rows("steer-plan")),
        memory=dict(samples=len(mem), start_bytes=mem[0]["engine_private"] if mem else None,
            end_bytes=mem[-1]["engine_private"] if mem else None,
            peak_bytes=max((r["engine_private"] for r in mem), default=None),
            last_half_bytes_per_second=slope,
            floor=memory_floor([(r["t"], r["engine_private"]) for r in mem]),
            floor_2min=memory_floor([(r["t"], r["engine_private"]) for r in mem], bucket_s=120.0)),  # context only
        cpu_percent=pct([r["cpu"] for r in samples if "cpu" in r]),
        pg_sessions=pct([r["pg_conns"] for r in samples if "pg_conns" in r]))
