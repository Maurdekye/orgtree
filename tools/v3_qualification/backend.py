"""Production HTTP/ASGI adapter on a runner-owned synthetic SQLite root.

Only fixture construction and generation revocation use the store directly.
All observations and measured mutations cross TokenGate and /api/agent. No
lifespan is started, so this does not launch providers, workers or a listener.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import sys
import threading
import time
from pathlib import Path

from .evidence import check_append, check_control, check_recovery, distribution


class Backend:
    def __init__(self, repo: Path, root: Path):
        # Imports deliberately follow the runner's environment/root guard.
        from assert_repo_import import assert_repo_import
        self.provenance = assert_repo_import(str(repo)).receipt()
        # The established provenance helper runs read-only git commands.
        # From this point onward, no product import or operation may spawn.
        from .runner import forbid_external_process
        sys.addaudithook(forbid_external_process)
        from fastapi.testclient import TestClient
        from engine.launch import TokenGate
        from orgtree import agentauth, api, ledger, opreceipts, stateprobe, store
        if Path(store.DATA_ROOT).resolve() != (root / "data").resolve():
            raise RuntimeError("store escaped the synthetic data root")
        self.auth, self.ledger, self.receipts = agentauth, ledger, opreceipts
        self.store, self.probe = store, stateprobe
        agentauth.enable()
        self.client = TestClient(TokenGate(api.app, "qualification-only"), raise_server_exceptions=False)
        self.slug = "qualification-synthetic"
        self.tokens = {}
        self.actor = "worker-0"
        self.checkpoint = root / "reopen.json"

    def close(self):
        self.client.close()
        self.store._POOL.close_all(self.slug)

    def fixture(self, actors: int):
        org = self.store.create_org(self.slug)
        # ledger.hire creates inert fixture records, never a provider seat.
        for i in range(actors):
            org.hire(self.ledger.USER, None, "haiku", 0, f"worker-{i}",
                     charter="inert synthetic fixture", add_dirs=[],
                     tools={"bash": False, "edit": False, "web": False, "subagents": False, "mcp": []},
                     org_visibility="self")
        self.store.save_org(org)
        for i in range(actors):
            name = f"worker-{i}"
            self.tokens[name] = self.auth.child_env(self.slug, name)["ORGTREE_AGENT_TOKEN"]

    def request(self, tool, args, *, actor=None, token=None):
        actor = actor or self.actor
        return self.client.post("/api/agent", json={"org": self.slug, "node": actor,
            "tool": tool, "args": args}, headers={"X-Orgtree-Agent-Token": token or self.tokens[actor]})

    def call(self, tool, args, **kw):
        response = self.request(tool, args, **kw)
        if response.status_code != 200:
            raise RuntimeError(f"{tool}: HTTP {response.status_code}: {response.text[:800]}")
        result = response.json()
        if result.get("state") == "running":
            raise RuntimeError("nonterminal response cannot count as completed")
        return result

    def work(self, action, **args):
        return self.call("orgtree_work", {"action": action, **args})

    def item(self, title, actors=1):
        # Grant participation using the real work_create API, not fixture fields.
        result = self.work("create", title=title, objective="Synthetic qualification fixture.",
                           participants=[f"worker-{i}" for i in range(1, actors)])
        slug = result["created"]
        return slug, self.work("get", slug=slug)["item"]

    def keyed(self, args, key, epoch, **kw):
        return self.request("orgtree_op_call", {"tool": "orgtree_work", "args": args,
                            "op_key": key, "op_epoch": epoch}, **kw)

    def workload(self, mode, concurrency, operations, rate):
        slug, before = self.item(f"{mode} {concurrency} {rate}", concurrency)
        refs = [f"operation-{i}" for i in range(operations)]
        samples = []
        guard = threading.Lock()
        queued = active = max_queued = max_active = 0
        self.probe.snapshot(reset=True)
        start = time.perf_counter()

        def one(i, due, enqueued):
            nonlocal queued, active, max_active
            begun = time.perf_counter()
            with guard:
                queued -= 1
                active += 1
                max_active = max(max_active, active)
            error, status, nonterminal = None, None, False
            try:
                response = self.request("orgtree_work", {"action": "evidence", "slug": slug,
                    "kind": "note", "ref": refs[i], "note": "Synthetic append"},
                    actor=f"worker-{i % concurrency}")
                status = response.status_code
                nonterminal = status == 200 and response.json().get("state") == "running"
                if status != 200 or nonterminal:
                    error = f"HTTP {status}: {response.text[:500]}"
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
            ended = time.perf_counter()
            with guard:
                active -= 1
                samples.append({"id": i, "status": status, "error": error, "nonterminal": nonterminal,
                    "arrival_lag_ms": (enqueued-due)*1000,
                    "executor_queue_ms": (begun-enqueued)*1000,
                    "http_asgi_ms": (ended-begun)*1000,
                    "offered_to_complete_ms": (ended-due)*1000})

        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = []
            for i in range(operations):
                due = start if mode == "fixed-work" else start + i / rate
                delay = due - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
                enqueued = time.perf_counter()
                with guard:
                    queued += 1
                    max_queued = max(max_queued, queued)
                futures.append(pool.submit(one, i, due, enqueued))
            for future in futures:
                future.result()
        duration = time.perf_counter() - start
        # Snapshot before the correctness read so diagnostics cover the workload only.
        probe = self.probe.snapshot(reset=True)
        after = self.work("get", slug=slug)["item"]
        failed = sum(s["error"] is not None for s in samples)
        observed = {"expected_refs": refs, "actual_refs": sorted(r["ref"] for r in after["evidence"]),
                    "initial_rev": before["rev"], "final_rev": after["rev"],
                    "completed": len(samples)-failed, "failed": failed}
        errors = check_append(observed)
        return {"id": f"backend.{mode}.{concurrency}.{rate}", "level": "composed",
            "boundary": "TokenGate + HTTP/ASGI + agent dispatcher + SQLite; no socket or lifespan",
            "classification": "passed" if not errors else "failed", "errors": errors,
            "workload": {"mode": mode, "concurrency": concurrency, "operations": operations,
                         "offered_rate_per_s": rate if mode == "fixed-demand" else None,
                         "mix": {"work.evidence": operations}, "temperature": "warm after fixture create/get"},
            "counts": {"offered": operations, "submitted": operations, "completed": len(samples)-failed,
                       "accepted": sum(s["status"] == 200 for s in samples),
                       "failed": failed, "refused": sum(s["status"] in (403,409,422) for s in samples),
                       "nonterminal": sum(s["nonterminal"] for s in samples), "dropped": 0, "backlog_at_end": queued+active,
                       "max_executor_queue": max_queued, "max_in_flight": max_active},
            "duration_s": duration, "completed_per_s": (len(samples)-failed)/duration,
            "latency": {metric: distribution([s[metric] for s in samples]) for metric in
                        ("arrival_lag_ms", "executor_queue_ms", "http_asgi_ms", "offered_to_complete_ms")},
            "samples": sorted(samples, key=lambda s:s["id"]), "observed": observed,
            "stateprobe": {"operations": probe["operations"], "lazy_materializations": probe["lazy_materializations"]}}

    def controls(self):
        slug, _ = self.item("Transport and ordering controls")
        args = {"action": "evidence", "slug": slug, "kind": "note", "ref": "original-key", "note": "one intent"}
        epoch = self.call("orgtree_op_epoch", {})["epoch"]
        key = self.receipts.mint_key()
        # Concurrent transport attempts use one key and payload. Count attempts separately.
        start = threading.Barrier(4)
        def retry(_):
            start.wait(timeout=10)
            return self.keyed(args,key,epoch)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(retry, range(4)))
        if any(r.status_code != 200 for r in responses):
            raise RuntimeError(f"retry positive control: {[(r.status_code,r.text[:250]) for r in responses]}")
        changed = self.keyed({**args, "note": "different intent"}, key, epoch)
        after = self.work("get", slug=slug)["item"]
        retry_effects = sum(r["ref"] == "original-key" for r in after["evidence"])
        stale_rev = after["rev"]
        ordered = []
        for value in ("first", "second"):
            current = self.work("get", slug=slug)["item"]
            self.work("update", slug=slug, expected_rev=current["rev"],
                      done_so_far=[value], working_on_next=[])
            ordered.append(self.work("get", slug=slug)["item"]["done_so_far"][0])
        stale = self.request("orgtree_work", {"action":"update", "slug":slug,
            "expected_rev":stale_rev, "done_so_far":["stale"], "working_on_next":[]})
        after_stale = self.work("get", slug=slug)["item"]
        value_after = after_stale["done_so_far"][0]
        old_token = self.tokens[self.actor]
        # Fixture fault transition only: no real seat/session lifecycle is run.
        with self.store.write_org(self.slug) as org:
            org.node(self.actor)["generation"] += 1
            self.store.save_org(org)
        revoked = self.request("orgtree_work", {**args,"ref":"revoked"}, token=old_token)
        self.tokens[self.actor] = self.auth.child_env(self.slug,self.actor)["ORGTREE_AGENT_TOKEN"]
        fresh = self.request("orgtree_work", {"action":"get", "slug":slug})
        if fresh.status_code != 200:
            raise RuntimeError(f"fresh authorization positive control: {fresh.text}")
        after = fresh.json()["item"]
        observed = {"retry_attempts":4, "retry_effects":retry_effects,
            "replayed_attempts":sum(r.json().get("replayed") is True for r in responses),
            "changed_payload_status":changed.status_code,"changed_payload_detail":changed.json().get("detail", ""),
            "stale_authorization_status":revoked.status_code,"stale_authorization_detail":revoked.json().get("detail", ""),
            "fresh_authorization_status":fresh.status_code,
            "revoked_effects":sum(r["ref"] == "revoked" for r in after["evidence"]),
            "ordered_values":ordered, "stale_revision_status":stale.status_code,
            "stale_revision_detail":stale.json().get("detail", ""), "value_after_stale":value_after,
            "expected_control_rev":stale_rev+2,"actual_control_rev":after["rev"]}
        errors = check_control(observed)
        checkpoint = {"slug":slug,"args":args,"key":key,"epoch":epoch,"before_pid":os.getpid(),
            "expected_refs":[r["ref"] for r in after["evidence"]],"expected_rev":after["rev"]}
        self.checkpoint.write_text(json.dumps(checkpoint),encoding="utf-8")
        return {"id":"backend.retry-authority-order", "level":"composed",
                "classification":"passed" if not errors else "failed", "errors":errors, "observed":observed,
                "limits":["generation revocation is a fixture transition", "retry proves durable insertion, not mail delivery",
                          "ordering is sequential read-after-write and stale CAS refusal, not feed commit ordering"]}

    def reopen(self):
        before = json.loads(self.checkpoint.read_text(encoding="utf-8"))
        self.tokens[self.actor] = self.auth.child_env(self.slug,self.actor)["ORGTREE_AGENT_TOKEN"]
        item = self.work("get",slug=before["slug"])["item"]
        receipt = self.call("orgtree_op_lookup", {"for_tool":"orgtree_work", "for_args":before["args"],
                "op_key":before["key"],"op_epoch":before["epoch"]})
        refused = self.keyed({**before["args"],"ref":"old-epoch-new-intent"},
                             self.receipts.mint_key(), before["epoch"])
        after_refusal = self.work("get",slug=before["slug"])["item"]
        observed = {"before_pid":before["before_pid"],"after_pid":os.getpid(),
                    "actual_refs":[r["ref"] for r in item["evidence"]],"actual_rev":item["rev"],
                    "expected_refs":before["expected_refs"],"expected_rev":before["expected_rev"],
                    "receipt_state":receipt.get("state"),"unknown_old_epoch_status":refused.status_code,
                    "unknown_old_epoch_detail":refused.json().get("detail", ""),
                    "refs_after_refusal":[r["ref"] for r in after_refusal["evidence"]],
                    "rev_after_refusal":after_refusal["rev"]}
        errors = check_recovery(observed)
        return {"id":"backend.process-reopen", "level":"composed",
                "classification":"passed" if not errors else "failed", "errors":errors,"observed":observed,
                "limits":["clean synthetic worker process exit/reopen; not kill, power loss or installed application restart"]}
