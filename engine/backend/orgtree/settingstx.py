"""PG-3f: whole-org settings writers on org_tx.

THE PROBLEM. `org_settings` and `org_kiosk` change one or more settings
sections AND sweep every node (a folder revoke, an rw→ro downgrade, the kiosk
ceiling clamp, a freeze clear). Under DOC_LOCK the sweep saw every node that
existed. Under row locks a node inserted after we listed the node rows is a
PHANTOM: the sweep would miss it.

THE RULE (PYPG decision 12). Every writer that DECIDES from an org setting
(hire, staffing: `staffdoor.HIRE_SETTINGS`) holds that settings section FOR
SHARE, and the settings writers here take it FOR UPDATE. So once we hold the
settings rows, no hire can commit a new node. A hire that committed BETWEEN
our node listing and our lock is caught by re-listing inside the transaction:
we refuse before the body runs, and retry with the grown list. Nothing is
written by a refused attempt.

Until PG-0 offers `nodes=ALL`, this is how "every node row of the org, in key
order" is named.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TypeVar

from . import orgtx

T = TypeVar("T")

#: the kiosk writer's rows: the kiosk section and the spend-freeze flag it
#: clears, the mailbox sections the ceiling sweep notifies through, and the
#: logs the sweep and the freeze clear append to
KIOSK_SECTIONS = ("kiosk", "spend_frozen", "notices")
KIOSK_SHARE = ("tiers", "deleted_cost_usd", "mail")
KIOSK_LOGS = ("events", "notice_log")

#: every doc section POST /settings may write (api._org_settings_apply and
#: the ledger methods it calls: set_hire_defaults, clear_fable_lock,
#: revoke_dir's notices). Locked FOR UPDATE on every call: a settings save is
#: rare, and the lock set must not depend on which knobs a body happens to
#: carry for the phantom rule to hold.
SETTINGS_SECTIONS = (
    "dirs", "max_top_grant", "default_top_grant", "compact_at", "fable_lock",
    "fable_limit_policy", "fable_filter_policy", "fable_filter_model",
    "default_tools", "default_visibility", "permission_mode",
    "default_account", "default_effort", "account_fallback_default",
    "auto_resume", "auto_resume_compact", "org_inbox_multi_holder",
    "external_inbox_multi_holder", "cascade_hire", "cascade_alloc",
    "auto_cheap_compact", "headless", "net_autoconnect", "net_hubs",
    "net_spool", "net_state", "notices")
#: read for a decision, never written: the kiosk (ceiling, headless refusal,
#: net sealing) and the audiences the multi-holder refusal counts
SETTINGS_SHARE = ("kiosk", "audiences")
SETTINGS_LOGS = ("events", "notice_log")
#: Org.heal_plan_stamps (the startup one-shot): its migration mark and the
#: org default it heals (plus every node row)
HEAL_SECTIONS = ("_migrations", "permission_mode")
#: what POST /defaults writes (Org.set_hire_defaults)
DEFAULTS_SECTIONS = ("default_tools", "default_visibility", "permission_mode",
                     "default_account")

#: how often a hire may slip in between the listing and the lock before we
#: give up (each retry re-lists; one retry is already rare)
RETRIES = 5


class NodesGrew(orgtx.OrgTxError):
    """New nodes kept appearing between the listing and the lock."""


def _node_ids(slug: str) -> frozenset[str]:
    return frozenset(orgtx.org_read(slug).nodes)


def whole_org_tx(slug: str, fn: Callable[[orgtx.OrgTx], T], *,
                 sections: Iterable[str] = (),
                 share_sections: Iterable[str] = (),
                 logs: Iterable[orgtx.LogName] = (),
                 retries: int = RETRIES) -> T:
    """Run `fn(tx)` in one org_tx that locks `sections` FOR UPDATE, every
    node row of the org FOR UPDATE, and `share_sections` FOR SHARE. `fn`
    runs once, on a transaction whose node set is complete. An exception
    from `fn` rolls everything back, exactly like the old discard."""
    sections = tuple(sections)
    share = tuple(share_sections)
    logs = tuple(logs)
    for _ in range(retries + 1):
        ids = _node_ids(slug)
        with orgtx.org_tx(slug, sections=sections, share_sections=share,
                          nodes=sorted(ids), logs=logs) as tx:
            if not frozenset(tx.org.nodes) - ids:
                return fn(tx)
        # a node appeared after the listing: fn never ran, the commit was
        # empty; list again
    raise NodesGrew(f"{slug!r}: nodes kept appearing while locking the org; "
                    "retry the request")


def settings_tx(slug: str, fn: Callable[[orgtx.OrgTx], T], *, all_nodes: bool,
                sections: Iterable[str] = (),
                share_sections: Iterable[str] = (),
                logs: Iterable[orgtx.LogName] = ()) -> T:
    """`whole_org_tx` when the body sweeps the fleet, else one org_tx on the
    named sections alone (node rows are then only READ, for warnings)."""
    if all_nodes:
        return whole_org_tx(slug, fn, sections=sections,
                            share_sections=share_sections, logs=logs)
    with orgtx.org_tx(slug, sections=sections, share_sections=share_sections,
                      logs=logs) as tx:
        return fn(tx)
