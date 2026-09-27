"""HTTP demand from App/usePolled/convo hooks, not renderer or paint timing."""
from dataclasses import dataclass
import threading
import time

WINDOWS = ("docket", "desk", "attention", "org-chooser")


@dataclass(frozen=True)
class Hook:
    name: str
    url: str
    period: float
    mode: str = "overlap"
    live: bool = True
    conditional: bool = False


def hooks(slug, watch, window):
    base = f"/api/orgs/{slug}"
    rows = [Hook("org_tree", base + "?view=delta", 6, "trailing", False, True)]
    kind = WINDOWS[window % len(WINDOWS)]
    if kind == "org-chooser":
        rows += [Hook("org_list", "/api/orgs", 3, "dedupe", False)]
    else:
        rows += [Hook("work_items", base + "/work-items-view", 15 if kind == "desk" else 5,
                      "dedupe", True, True)]
    if kind == "desk":
        rows += [Hook("chat", f"{base}/nodes/{watch}/chat?last=8", 7, "dedupe", False)]
    if kind == "attention":
        rows += [Hook("inbox", base + "/inbox", 5)]
    rows += [Hook("providers", "/api/providers", 60, "dedupe")]
    rows += [Hook(name, url, 60) for name, url in (
        ("usage", "/api/usage/peek"), ("codex_usage", "/api/codex/usage/peek"),
        ("agy_usage", "/api/antigravity/usage/peek"),
        ("openrouter_usage", "/api/openrouter/usage/peek"))]
    # The global notification owner is declared once, not once per surface.
    if window == 0:
        rows += [Hook("notifications", "/api/desktop/notifications", 5, "trailing")]
    return rows


class HookClock:
    """Independent clocks; one slow response cannot suppress other hooks."""
    def __init__(self, specs):
        self.specs = {h.name: h for h in specs}
        self.due = {h.name: 0. for h in specs}
        self.active = {h.name: 0 for h in specs}
        self.pending = set()
        self.live_at = self.chat_at = None
        self.busy = False
        self.chat_first = True
        self.last_rev = None
        self.counts = dict(deduped=0, trailing=0)

    def event(self, frame, now, watch):
        kind = frame.get("type")
        if kind == "mail":
            return
        rev = frame.get("rev")
        if isinstance(rev, (int, float)):
            if self.last_rev is not None and rev != self.last_rev + 1:
                self.pending.add("org_tree")
            self.last_rev = max(rev, self.last_rev or rev)
        if kind == "node_stream":
            row = frame.get("assistant_row") or {}
            if frame.get("node") == watch and (row.get("assistant_materialized") or
                    row.get("assistant_state") == "complete" or frame.get("kind") not in (
                    "delta", "thinking", "thinking_start", "cache_forecast", "mcp_tool_count", "mcp_readiness")):
                if self.chat_at is None:
                    self.chat_at = now + .2
            return
        self.pending.add("org_tree")
        if kind == "node_event" and frame.get("node") == watch:
            self.pending.add("chat")
        if self.live_at is None:
            self.live_at = now + .12

    def ready(self, now):
        signals, self.pending = self.pending, set()
        if self.live_at is not None and now >= self.live_at:
            self.live_at = None
            signals.update(h.name for h in self.specs.values() if h.live)
        if self.chat_at is not None and now >= self.chat_at:
            self.chat_at = None
            signals.add("chat")
        output = []
        for name, h in self.specs.items():
            tick = now >= self.due[name]
            at = self.due[name] if tick else now
            if tick:
                period = h.period
                if name == "chat":
                    period = 2.5 if self.chat_first or self.busy else 7
                    self.chat_first = False
                self.due[name] += period
            if not tick and name not in signals:
                continue
            # convo's node_event and 200ms nudge use force:true; only the
            # heartbeat shares the in-flight gate.
            forced_chat = name == "chat" and name in signals
            if self.active[name] and h.mode != "overlap" and not forced_chat:
                if h.mode == "trailing":
                    self.counts["trailing"] += name not in self.pending
                    self.pending.add(name)
                else:
                    self.counts["deduped"] += 1
                continue
            self.active[name] += 1
            output.append((h, at))
        return output

    def complete(self, name, payload=None):
        self.active[name] -= 1
        if name == "chat" and isinstance(payload, dict):
            self.busy = bool(payload.get("busy"))


class Conditional:
    def __init__(self):
        self.etag = self.revision = None
        self.body = None

    def invalidate(self):
        self.etag = self.revision = self.body = None

    def accept(self, status, headers, body):
        if status == 304:
            if not self.etag:
                raise ValueError("304 without a cached base")
            self.watermarks(headers)
            return
        if status != 200:
            return
        if isinstance(body, dict):
            delta = "delta" in body or (body.get("format") == "orgtree.tree/v1" and "tree" not in body)
            if delta and (not self.revision or body.get("base") != self.revision):
                raise ValueError("delta does not match cached revision")
            if "delta" in body:
                merged = {**self.body, **{k: v for k, v in body.items() if k not in ("base", "delta")}}
                for group, change in body["delta"].items():
                    rows = {row["slug"]: row for row in self.body.get(group, [])}
                    rows.update({row["slug"]: row for row in change["upsert"]})
                    try:
                        merged[group] = [rows[key] for key in change["order"]]
                    except KeyError as exc:
                        raise ValueError("docket delta missing row") from exc
                self.body = merged
            elif body.get("format") == "orgtree.tree/v1":
                self.body = body["tree"] if "tree" in body else tree_delta(self.body, body)
            else:
                self.body = body
            self.revision = body.get("revision") or headers.get("etag")
        self.etag = headers.get("etag")
        self.watermarks(headers)

    def watermarks(self, headers):
        if not isinstance(self.body, dict):
            return
        for header, key in (("x-orgtree-sync-rev", "sync_rev"), ("x-orgtree-org-rev", "org_rev")):
            try:
                value = int(headers.get(header, ""))
            except ValueError:
                continue
            if 0 <= value <= 2**53 - 1:
                self.body = {**self.body, key: value}


def tree_delta(base, wire):
    def fields(old, patch):
        return {k: v for k, v in {**old, **patch["set"]}.items() if k not in patch["remove"]}
    nodes = {}
    def flatten(node):
        nodes[node["id"]] = {**node, "children": [c["id"] for c in node["children"]]}
        for child in node["children"]:
            flatten(child)
    for root in base["roots"]:
        flatten(root)
    for key in wire["removed"]:
        nodes.pop(key, None)
    for key, patch in wire["nodes"].items():
        nodes[key] = fields(nodes.get(key, {}), patch)
    top = fields({**base, "roots": [n["id"] for n in base["roots"]]}, wire["top"])
    seen = set()
    def rebuild(key):
        if key in seen or key not in nodes or nodes[key].get("id") != key:
            raise ValueError("tree delta cycle, duplicate or missing node")
        seen.add(key)
        return {**nodes[key], "children": [rebuild(k) for k in nodes[key]["children"]]}
    top["roots"] = [rebuild(k) for k in top["roots"]]
    if len(seen) != len(nodes):
        raise ValueError("tree delta unreachable node")
    return top


class WindowDriver:
    def __init__(self, slug, watch, window, origin, headers, rec, stop, *, workers=16):
        from control import BoundedPool
        self.watch, self.window, self.origin = watch, window, origin
        self.headers, self.rec, self.stop = headers, rec, stop
        self.clock = HookClock(hooks(slug, watch, window))
        self.lock = threading.Lock()
        self.pool = BoundedPool(workers)
        self.cache = {h.name: Conditional() for h in self.clock.specs.values() if h.conditional}
        self.started = 0
        self.cache_generation = 0
        self.local = threading.local()
        self.clients = []

    def event(self, frame):
        with self.lock:
            if frame.get("type") == "node_stream" and frame.get("kind") in (
                    "cache_forecast", "mcp_tool_count", "mcp_readiness"):
                self.cache_generation += 1
                self.cache["org_tree"] = Conditional()
            if self.started:
                self.clock.event(frame, time.time() - self.started, self.watch)

    def run(self, started, duration):
        self.started = started
        try:
            while not self.stop.is_set() and time.time() < started + duration:
                with self.lock:
                    ready = self.clock.ready(time.time() - started)
                for h, due in ready:
                    if not self.pool.submit(self.fetch, h, started + due):
                        with self.lock:
                            self.clock.complete(h.name)
                        self.rec.write("overload", {"driver": "ui", "w": self.window,
                                                   "route": h.name, "t": due})
                self.stop.wait(.01)
        finally:
            self.pool.shutdown(cancel_pending=self.stop.is_set())
            for client in self.clients:
                client.close()

    def fetch(self, hook, due):
        import httpx
        begun = time.time()
        status, err, size, wire, payload = None, None, 0, 0, None
        headers = dict(self.headers)
        cache = self.cache.get(hook.name)
        if cache and cache.etag:
            headers["If-None-Match"] = cache.etag
        try:
            client = getattr(self.local, "client", None)
            if client is None:
                client = self.local.client = httpx.Client(base_url=self.origin, timeout=30)
                with self.lock:
                    self.clients.append(client)
            response = client.get(hook.url, headers={**headers, "X-Scale-Kind": "ui:" + hook.name})
            status, size = response.status_code, len(response.content)
            wire = response.num_bytes_downloaded
            if status == 200:
                payload = response.json()
            elif status != 304:
                err = response.text[:200]
            if cache:
                cache.accept(status, response.headers, payload)
                # A metadata frame can invalidate the tree while HTTP is in
                # flight. That answer still has its captured base; it cannot
                # replace the new cache, matching getTree's generation check.
            if hook.name == "notifications" and status == 200:
                offset = 0
                while payload.get("truncated") and payload.get("next_offset") is not None and payload["next_offset"] > offset:
                    offset = payload["next_offset"]
                    self.rec.write("ui", {"t": begun-self.started, "w": self.window,
                        "route": hook.name, "url": hook.url, "status": status,
                        "bytes": size, "wire_bytes": wire, "err": err,
                        "ms": (time.time()-begun)*1000, "late_ms": (begun-due)*1000,
                        "total_ms": (time.time()-due)*1000})
                    begun = due = time.time()
                    response = client.get(hook.url + f"?offset={offset}", headers=headers)
                    response.raise_for_status()
                    status, size, wire = response.status_code, len(response.content), response.num_bytes_downloaded
                    payload = response.json()
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"[:200]
        finally:
            ended = time.time()
            with self.lock:
                self.clock.complete(hook.name, payload)
            self.rec.write("ui", {"t": begun - self.started, "w": self.window,
                "route": hook.name, "url": hook.url, "status": status, "bytes": size,
                "wire_bytes": wire, "err": err, "ms": (ended - begun) * 1000,
                "late_ms": (begun - due) * 1000, "total_ms": (ended - due) * 1000})
