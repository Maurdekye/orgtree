"""HTTP demand from App/usePolled/convo hooks, not renderer or paint timing."""
from dataclasses import dataclass, replace
import threading
import time
from urllib.parse import quote

WINDOWS = ("docket", "desk", "attention", "org-chooser")


@dataclass(frozen=True)
class Hook:
    name: str
    url: str
    period: float
    mode: str = "overlap"
    live: bool = True
    conditional: bool = False
    request_serial: int = 0


def hooks(slug, watch, window):
    base = f"/api/orgs/{slug}"
    rows = [Hook("org_tree", base + "?view=delta", 6, "trailing", False, True)]
    kind = WINDOWS[window % len(WINDOWS)]
    if kind == "org-chooser":
        rows += [Hook("org_list", "/api/orgs", 3, "dedupe", False)]
    else:
        rows += [Hook("work_items", base + "/work-items-foreground?backlogged=0&archive_limit=0",
                      15 if kind == "desk" else 5,
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
        self.issued = {h.name: 0 for h in specs}
        self.chat_installed = 0
        self.chat_inflight = False
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
            inflight = self.chat_inflight if name == "chat" else self.active[name]
            if inflight and h.mode != "overlap" and not forced_chat:
                if h.mode == "trailing":
                    self.counts["trailing"] += name not in self.pending
                    self.pending.add(name)
                else:
                    self.counts["deduped"] += 1
                continue
            self.active[name] += 1
            self.issued[name] += 1
            if name == "chat":
                self.chat_inflight = True
            output.append((replace(h, request_serial=self.issued[name]), at))
        return output

    def complete(self, name, payload=None, request_serial=None):
        self.active[name] -= 1
        if name == "chat":
            serial = self.issued[name] if request_serial is None else request_serial
            if serial == self.issued[name]:
                self.chat_inflight = False
            # convo installs any usable answer until a newer answer has been
            # installed, then refuses an older forced read's late response.
            if isinstance(payload, dict) and serial >= self.chat_installed:
                self.chat_installed = serial
                self.busy = bool(payload.get("busy"))


class Conditional:
    def __init__(self, expected_format=None):
        self.etag = self.revision = None
        self.body = None
        self.expected_format = expected_format

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
        if self.expected_format and (not isinstance(body, dict) or body.get("format") != self.expected_format):
            raise ValueError("unexpected foreground work format")
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


FOREGROUND_FORMAT = "orgtree.foreground-tree/v1"


class ForegroundControl(Exception):
    def __init__(self, kind, inferred=False):
        super().__init__(kind)
        self.kind, self.inferred = kind, inferred


def foreground_answer(response):
    """foregroundtree.ts `answer`: route-less or non-foreground servers are compatibility."""
    if response.status_code == 404:
        raise ForegroundControl("compatibility", True)
    try:
        body = response.json()
    except ValueError:
        if response.is_success:
            raise ForegroundControl("compatibility", True)
        raise RuntimeError(f"foreground request failed ({response.status_code})")
    if response.status_code == 409 and isinstance(body, dict) and body.get("kind") in ("reset", "compatibility"):
        raise ForegroundControl(body["kind"])
    response.raise_for_status()
    if not isinstance(body, dict) or "format" not in body:
        raise ForegroundControl("compatibility", True)
    if body["format"] != FOREGROUND_FORMAT:
        raise ValueError("invalid foreground tree boundary")
    return body


def visible_parents(snapshot):
    """treeview.ts `visibleParents` with no saved fronts: the LAST retired sibling fronts each pile."""
    out, nodes = [], snapshot["nodes"]
    stack = [(snapshot["roots"], "", snapshot["header"].get("hidden_retired_roots", 0))]
    while stack:
        ids, parent, omitted = stack.pop()
        rows = [nodes[i] for i in ids]
        retired = [row for row in rows if row.get("state") == "archived"]
        if omitted + len(retired) > 0:
            out.append(parent)
        front = retired[-1] if retired else None
        stack += [(row.get("children", []), row["id"], row.get("hidden_retired_children", 0))
                  for row in reversed(rows) if row.get("state") != "archived" or row is front]
    return out


class ForegroundTree:
    """App's tree read since e1be6a2: api.getAppTree -> TreeViewReader -> ForegroundTreeReader.

    Selection is the saved desk identity only, hideRetired off (the product
    default), no saved fronts, no browse. A (re)plan costs one first-child and
    one last-child page per visible pile parent, then a re-read; later reads are
    one conditional GET while the catalog holds. A compatibility answer falls
    back to the legacy conditional full read for 30 s (inferred) or 600 s.
    """
    def __init__(self, slug, include=()):
        self.base = f"/api/orgs/{slug}/foreground-tree"
        self.include = set(include)
        self.plan = None                                # (include, catalog)
        self.unavailable_until = 0.
        self.invalidate()

    def invalidate(self):                               # invalidateTreeCache: reader cache only
        self.etag = self.snapshot = self.key = None

    def get(self, send, include, full):
        """ForegroundTreeReader.get. Returns None once it has fallen back to `full`
        (getCompleteTree): a compatibility answer, or two failed attempts."""
        names = sorted(set(include))
        key, hit = tuple(names), self.key == tuple(names)
        for _ in range(2):
            query = "&".join("include=" + quote(i, safe="") for i in names)
            response = send("org_tree", self.base + ("?" + query if query else ""), self.etag if hit else None)
            if response.status_code == 304:
                catalog = response.headers.get("x-orgtree-catalog-rev")
                if hit and self.snapshot and not (catalog and catalog != self.snapshot["catalog_revision"]):
                    return self.snapshot
                hit = False
                continue
            try:
                body = foreground_answer(response)
            except ForegroundControl as exc:
                if exc.kind == "compatibility":
                    self.unavailable_until = time.time() + (30 if exc.inferred else 600)
                    break
                hit = False
                continue
            if body.get("kind") == "delta":
                base = self.snapshot if hit else None
                if not base or base["revision"] != body.get("base"):
                    hit = False
                    continue
                nodes = dict(base["nodes"])
                for i in body["removed"]:
                    nodes.pop(i, None)
                for i, patch in body["nodes"].items():
                    nodes[i] = {k: v for k, v in {**nodes.get(i, {}), **patch["set"]}.items() if k not in patch["unset"]}
                header = {k: v for k, v in {**base["header"], **body["header"]["set"]}.items()
                          if k not in body["header"]["unset"]}
                body = {**body, "kind": "snapshot", "nodes": nodes, "header": header}
            elif body.get("kind") != "snapshot":
                raise ValueError("unexpected foreground tree response")
            etag = response.headers.get("etag")
            self.etag, self.snapshot, self.key = (etag, body, key) if etag else (None, None, None)
            return body
        full()
        return None

    def page(self, send, parent, edge=None):
        url = f"{self.base}/children?parent={quote(parent, safe='')}&limit=1" + ("&edge=last" if edge else "")
        return foreground_answer(send("org_tree_page", url, None))

    def read(self, send, full, held):
        """getAppTree -> TreeViewReader.get. `full` is getCompleteTree: an uncached
        whole-history read. `held` is the conditional getTree used only while a
        compatibility answer is remembered."""
        if time.time() < self.unavailable_until:
            return held()

        def full_view():                                # TreeViewReader.full drops its plan
            self.plan = None
            return full()
        plan = self.plan
        for attempt in range(2):
            try:
                requested = set(self.include)
                if len(requested) > 128:
                    return full_view()
                answer = self.get(send, plan[0] if attempt == 0 and plan else requested, full)
                if answer is None:
                    return None
                if attempt == 0 and plan and plan[1] == answer["catalog_revision"]:
                    return answer
                if attempt == 0 and plan:
                    answer = self.get(send, requested, full)
                    if answer is None:
                        return None
                catalog, resolved = answer["catalog_revision"], set()
                while True:
                    for parent in [p for p in visible_parents(answer) if p not in resolved]:
                        resolved.add(parent)
                        for edge in (None, "last"):
                            page = self.page(send, parent, edge)
                            if page["catalog_revision"] != catalog:
                                raise ForegroundControl("reset")
                            requested.update(page["matches"])
                    if len(requested) > 128:
                        return full_view()
                    answer = self.get(send, requested, full)
                    if answer is None:
                        return None
                    if answer["catalog_revision"] != catalog:
                        raise ForegroundControl("reset")
                    if all(p in resolved for p in visible_parents(answer)):
                        break
                self.plan = (sorted(requested), catalog)
                return answer
            except ForegroundControl as exc:
                if exc.kind == "compatibility":         # from a page read: no hold is set there
                    return full_view()
        return full_view()                              # catalog churn across both attempts

class WindowDriver:
    def __init__(self, slug, watch, window, origin, headers, rec, stop, *, workers=16):
        from control import BoundedPool
        import httpx
        self.watch, self.window, self.origin = watch, window, origin
        self.headers, self.rec, self.stop = headers, rec, stop
        self.clock = HookClock(hooks(slug, watch, window))
        self.lock = threading.Lock()
        self.pool = BoundedPool(workers)
        self.cache = {h.name: Conditional("orgtree.work-foreground/v1" if h.name == "work_items" else None)
                      for h in self.clock.specs.values() if h.conditional}
        # App reads the selected tree. The captured 59c57f8 renderer sent no include
        # even with a desk open (no pins, saved windows or piles), so neither do we.
        self.tree_view = ForegroundTree(slug)
        self.started = 0
        # Chromium's HTTP/1 per-origin connection budget applies to all
        # independent hooks in a window, not a fresh pool for every worker.
        self.client = httpx.Client(base_url=origin, timeout=30,
            limits=httpx.Limits(max_connections=6, max_keepalive_connections=6))

    def event(self, frame):
        with self.lock:
            if frame.get("type") == "node_stream" and frame.get("kind") in (
                    "cache_forecast", "mcp_tool_count", "mcp_readiness"):
                self.cache["org_tree"] = Conditional()
                self.tree_view.invalidate()
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
                            self.clock.complete(h.name, request_serial=h.request_serial)
                        self.rec.write("overload", {"driver": "ui", "w": self.window,
                                                   "route": h.name, "t": due})
                self.stop.wait(.01)
        finally:
            self.pool.shutdown(cancel_pending=self.stop.is_set())
            self.client.close()

    def fetch_tree(self, hook, due):
        """One App tree read: every HTTP request it costs is its own `ui` row."""
        mark = [due]

        def send(route, url, etag):
            headers = dict(self.headers, **{"X-Scale-Kind": "ui:" + route})
            if etag:
                headers["If-None-Match"] = etag
            begun, status, err, size, wire = time.time(), None, None, 0, 0
            try:
                response = self.client.get(url, headers=headers)
                status, size, wire = response.status_code, len(response.content), response.num_bytes_downloaded
                if status not in (200, 304) and not (route != "org_tree_legacy" and status in (404, 409)):
                    err = response.text[:200]
                return response
            except Exception as exc:
                err = f"{type(exc).__name__}: {exc}"[:200]
                raise
            finally:
                ended = time.time()
                self.rec.write("ui", {"t": begun - self.started, "w": self.window, "route": route,
                    "url": url, "status": status, "bytes": size, "wire_bytes": wire, "err": err,
                    "ms": (ended - begun) * 1000, "late_ms": (begun - mark[0]) * 1000,
                    "total_ms": (ended - mark[0]) * 1000})
                mark[0] = ended

        def full():
            # api.getCompleteTree: getTree (conditional only if a held read left a
            # cache entry) and then treeCache.delete in finally, so the NEXT read -
            # full or held - carries no If-None-Match and pays the whole history.
            try:
                return send("org_tree_legacy", hook.url, self.cache["org_tree"].etag)
            finally:
                self.cache["org_tree"] = Conditional()

        def held():
            cache = self.cache["org_tree"]
            response = send("org_tree_legacy", hook.url, cache.etag)
            body = response.json() if response.status_code == 200 else None
            cache.accept(response.status_code, response.headers, body)
            return body

        try:
            self.tree_view.read(send, full, held)
        except Exception as exc:
            # A read the App would not accept fails the run; never a silent pass.
            self.rec.write("ui", {"t": time.time() - self.started, "w": self.window,
                "route": "org_tree", "url": "<tree read>", "status": None, "bytes": 0,
                "wire_bytes": 0, "err": f"{type(exc).__name__}: {exc}"[:200],
                "ms": 0, "late_ms": 0, "total_ms": (time.time() - due) * 1000})
        finally:
            with self.lock:
                self.clock.complete(hook.name, None, hook.request_serial)

    def fetch(self, hook, due):
        if hook.name == "org_tree":
            return self.fetch_tree(hook, due)
        begun = time.time()
        status, err, size, wire, payload = None, None, 0, 0, None
        headers = dict(self.headers)
        headers["X-Scale-Kind"] = "ui:" + hook.name
        url = hook.url
        cache = self.cache.get(hook.name)
        if cache and cache.etag:
            headers["If-None-Match"] = cache.etag
        try:
            response = self.client.get(url, headers=headers)
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
                        "route": hook.name, "url": url, "status": status,
                        "bytes": size, "wire_bytes": wire, "err": err,
                        "ms": (time.time()-begun)*1000, "late_ms": (begun-due)*1000,
                        "total_ms": (time.time()-due)*1000})
                    begun = due = time.time()
                    url = hook.url + f"?offset={offset}"
                    response = self.client.get(url, headers=headers)
                    response.raise_for_status()
                    status, size, wire = response.status_code, len(response.content), response.num_bytes_downloaded
                    payload = response.json()
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"[:200]
        finally:
            ended = time.time()
            with self.lock:
                self.clock.complete(hook.name, payload if not err else None, hook.request_serial)
            self.rec.write("ui", {"t": begun - self.started, "w": self.window,
                "route": hook.name, "url": url, "status": status, "bytes": size,
                "wire_bytes": wire, "err": err, "ms": (ended - begun) * 1000,
                "late_ms": (begun - due) * 1000, "total_ms": (ended - due) * 1000})
