"""Consume startup mail through ordinary messages and real simulated turns.

Untimed, identically ordered preparation in each restored arm. Nothing deletes
mail or drives supervisor internals. Each acknowledged primer is checked with
the same independent committed-row oracle used during load.
"""
import concurrent.futures
import json
import time


def prime(root, timeout):
    import httpx
    from baseline_oracle import WriteOracle
    desc = json.loads((root / "scale-descriptor.json").read_text(encoding="utf-8"))
    started = time.monotonic()
    deadline = started + timeout
    headers = {"X-Orgtree-Desktop-Token": desc["token"]}
    with httpx.Client(base_url=desc["origin"], headers=headers, timeout=30) as client:
        tokens = client.get("/scale/tokens").raise_for_status().json()
        metadata = client.get("/scale/workload").raise_for_status().json()
        before = client.get("/scale/settlement").raise_for_status().json()
        parents = metadata["parents"]
        plan = []
        for target in desc["live_agents"]:
            actor = parents.get(target) or next(n for n, p in parents.items() if p == target)
            plan.append(dict(actor=actor, tool="orgtree_message", args=dict(to=target,
                kind="message", body="[baseline-primer] Complete this synthetic readiness turn.")))
        oracle = WriteOracle(desc)
        try:
            def send(job):
                if time.monotonic() >= deadline:
                    raise TimeoutError("ordinary-mail primer deadline expired")
                response = client.post("/api/agent", json=dict(org=desc["org"], node=job["actor"],
                    tool=job["tool"], args=job["args"]), headers={
                        "X-Orgtree-Agent-Token": tokens[job["actor"]], "X-Scale-Kind": "primer"})
                response.raise_for_status()
                check = oracle.check(job["actor"], job["tool"], job["args"], response.json())
                if not check or not check["passed"]:
                    raise ValueError("ordinary-mail primer was not verified")
                return check
            # At most 16 requests/futures, including an eventual N1000 primer.
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                for start in range(0, len(plan), 16):
                    checks = list(pool.map(send, plan[start:start+16]))
                    if len(checks) != len(plan[start:start+16]):
                        raise ValueError("incomplete primer acknowledgements")
            while time.monotonic() < deadline:
                after = client.get("/scale/settlement").raise_for_status().json()
                activity = after["activity"]
                provider = activity.get("provider", {})
                if not any(after[k] for k in ("mail", "delivering", "inflight", "busy", "queued")):
                    if (provider.get("completed", 0) - before["activity"].get("provider", {}).get("completed", 0)
                            < len(plan) or provider.get("failed") or provider.get("failed_bookings")
                            or provider.get("booked") != provider.get("completed")
                            or activity["started"] != activity["finished"]):
                        raise ValueError("primer did not complete and book every target turn")
                    return dict(verified=True, before=before, after=after, plan=plan,
                                writes=dict(oracle.counts), seconds=time.monotonic()-started)
                time.sleep(.2)
            raise TimeoutError("ordinary-mail primer did not settle")
        finally:
            oracle.close()
