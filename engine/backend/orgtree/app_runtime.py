"""One host producer per app value; clients subscribe instead of polling.

Provider readers retain their existing caches, fetch rules and manual refresh
doors. A slow provider cannot delay publication by the other producers.
"""
from __future__ import annotations

import asyncio
import inspect
import time


class Publishers:
    def __init__(self, publish, error, *, period=60.0, sleep=asyncio.sleep,
                 monotonic=time.monotonic):
        self.publish, self.error = publish, error
        self.period, self.sleep, self.monotonic = period, sleep, monotonic
        self.tasks = []

    def add(self, key, read, *, period=None):
        async def run():
            cadence = self.period if period is None else period
            while True:
                started = self.monotonic()
                try:
                    value = await read() if inspect.iscoroutinefunction(read) else await asyncio.to_thread(read)
                    self.publish(key, value)
                except Exception as exc:
                    self.error(exc)
                # Each producer has one in-flight read. Long reads never
                # cause a queue of catch-up work or a zero-delay retry loop.
                await self.sleep(max(.1, cadence - (self.monotonic() - started)))
        self.tasks.append(asyncio.create_task(run()))

    async def close(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks.clear()


def start(publish, error):
    # Late import: the API owns these established projections, while mounting
    # the app router must remain inert (no processes, readers or imports of a
    # half-initialized api module).
    from . import api, accountusage, registry, supervisor
    result = Publishers(publish, error)
    readers = {
        'usage': api.claude_usage,
        'codex_usage': api.codex_usage,
        'antigravity_usage': api.antigravity_usage,
        'openrouter_usage': api.openrouter_usage,
        'usage_peek': api.claude_usage_peek,
        'codex_usage_peek': api.codex_usage_peek,
        'antigravity_usage_peek': api.antigravity_usage_peek,
        'openrouter_usage_peek': api.openrouter_usage_peek,
        'providers': api.providers_info,
        'accounts': api.accounts_list,
        'account_readout': api.accounts_readout,
        'account_usage': api.accounts_usage_all,
        'defaults': api.defaults_get,
        'openrouter': api.openrouter_status,
    }
    for key, read in readers.items():
        result.add(key, read)

    async def registered_usage():
        def read():
            # These are account IDs, never credentials or the key-store body.
            rows = registry.list_accounts()
            return {row['id']: accountusage.view(row, allow_fetch=True) for row in rows}
        return await asyncio.to_thread(read)
    result.add('registered_usage', registered_usage)
    result.add('prefer_reserve_default', lambda: api.defaults_get()['prefer_reserve'])
    result.add('primed_restart', supervisor.primed_restart, period=1.0)
    return result
