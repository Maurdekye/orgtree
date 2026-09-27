"""Synthetic provider transport for scale qualification, never installed by the product.

The real supervisor owns admission, bounded slots, drain, confirmation and finish.
Only its Codex provider leg is replaced. Output size and service time are declared
assumptions; CLI parsing, inference and external process memory are not measured.
"""
from __future__ import annotations

from collections import deque
import json
from pathlib import Path
import threading
import time
import uuid


class SimulatedProvider:
    def __init__(self, supervisor, halt, *, slug, nodes, seconds=.25, output_bytes=256, log=None):
        if not 0 <= seconds <= 60 or not 1 <= output_bytes <= 65536:
            raise ValueError("simulation service time/output outside bounded range")
        self.sup, self.halt = supervisor, halt
        self.slug, self.nodes = slug, frozenset(nodes)
        self.seconds, self.output_bytes, self.log = seconds, output_bytes, log
        self.lock = threading.Lock()
        self.started = self.accepted = self.completed = self.failed = self.active = self.peak = 0
        self.recent = deque(maxlen=32)

    def snapshot(self):
        with self.lock:
            return dict(started=self.started, accepted=self.accepted, completed=self.completed,
                        failed=self.failed, active=self.active, peak_active=self.peak,
                        seconds=self.seconds, output_bytes=self.output_bytes,
                        recent=list(self.recent),
                        boundary="simulated Codex leg; real supervisor admission and completion")

    def __call__(self, slug, nid, org, st, text, toks, images=None, turn_view="", **kw):
        if slug != self.slug or nid not in self.nodes or org.node(nid).get("model") != "luna":
            raise RuntimeError("simulated provider called outside declared fixture")
        begun = time.monotonic()
        receipt = dict(id=uuid.uuid4().hex, node=nid, at=time.time(), tokens=len(toks), outcome="failed")
        with self.lock:
            self.started += 1
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            self.halt.check(slug, nid)
            # This is the simulated transport's acceptance boundary. Keep the
            # production durable confirmation, rather than deleting mailbox rows.
            self.sup._confirm_delivered(slug, nid, toks)
            with self.lock:
                self.accepted += 1
            sid = str(org.node(nid).get("session_id") or "")
            if not sid:
                raise RuntimeError("simulated fixture has no transcript session")
            incarnation = self.sup._transcript_incarnation(org, nid)
            self.sup._record_prompt_view(slug, sid, text, turn_view,
                at=self.sup.now_iso(), spans=kw.get("view_spans"),
                segments=kw.get("view_segments"), incarnation=incarnation)
            self.sup._codex_journal(slug, sid, [{"type": "user", "timestamp": self.sup.now_iso(),
                "message": {"role": "user", "content": text}}], incarnation=incarnation)
            deadline = begun + self.seconds
            while time.monotonic() < deadline:
                time.sleep(min(.05, max(0, deadline - time.monotonic())))
                self.halt.check(slug, nid)
            self.halt.check(slug, nid)
            body = ("Synthetic completed turn. " * (self.output_bytes // 25 + 2))[:self.output_bytes]
            self.sup.stream(slug, nid, {"kind": "delta", "text": body,
                                      "assistant_id": "scale-" + receipt["id"]})
            self.sup._codex_journal(slug, sid, [{"type": "assistant", "timestamp": self.sup.now_iso(),
                "message": {"role": "assistant", "content": [{"type": "text", "text": body}]}}],
                incarnation=incarnation)
            receipt["outcome"] = "provider-completed"
            with self.lock:
                self.completed += 1
            # The caller's unchanged _after_turn books this result. Completion
            # here alone is NOT proof that its durable finish was committed.
            return ({"status": "completed", "is_error": False, "result": body,
                     "total_cost_usd": 0, "duration_ms": (time.monotonic() - begun) * 1000,
                     "usage": {"input_tokens": 128, "output_tokens": 64},
                     "_cost_complete": True, "_cost_source": "scale-simulated"}, 128)
        except BaseException:
            with self.lock:
                self.failed += 1
            raise
        finally:
            receipt["elapsed_ms"] = (time.monotonic() - begun) * 1000
            with self.lock:
                self.active -= 1
                self.recent.append(receipt)
                if self.log:
                    with Path(self.log).open("a", encoding="utf-8") as target:
                        target.write(json.dumps(receipt) + "\n")


def install(root, supervisor, halt):
    """Requires a fixture manifest; cannot silently convert arbitrary live data."""
    manifest = json.loads((root / "simulated-provider.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "scale-simulated-provider-v1":
        raise RuntimeError("missing synthetic fixture identity")
    adapter = SimulatedProvider(supervisor, halt, slug=manifest["org"], nodes=manifest["nodes"],
                                seconds=manifest["seconds"], output_bytes=manifest["output_bytes"],
                                log=root / "metrics" / "simulated-turns.jsonl")
    supervisor._codex_leg = adapter
    return adapter
