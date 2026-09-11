"""Deterministic budgets for whole-fleet filesystem work.

Budgets cover the current synchronous pass on this thread, not concurrent work
on another thread. Decorate the actual walker, below any reuse/cache boundary.
Outside an explicit budget they impose no limit and retain no call history.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from functools import wraps
import threading

_local = threading.local()


class FleetWalkBudgetExceeded(RuntimeError):
    pass


@dataclass
class WalkBudget:
    name: str
    max_calls: int
    calls: int = 0


@contextmanager
def fleet_walk_budget(name: str, max_calls: int = 1):
    if max_calls < 0:
        raise ValueError("max_calls must be nonnegative")
    budget = WalkBudget(name, max_calls)
    previous = getattr(_local, "budgets", ())
    _local.budgets = (*previous, budget)
    try:
        yield budget
    finally:
        _local.budgets = previous


def fleet_walk(name: str):
    def decorate(walker):
        @wraps(walker)
        def counted(*args, **kwargs):
            for budget in getattr(_local, "budgets", ()):
                if budget.name == name:
                    budget.calls += 1
                    if budget.calls > budget.max_calls:
                        raise FleetWalkBudgetExceeded(
                            f"{name}: walk {budget.calls} exceeds pass budget "
                            f"{budget.max_calls} ({walker.__module__}.{walker.__name__})")
            return walker(*args, **kwargs)
        return counted
    return decorate
