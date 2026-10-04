"""The ``nodes`` section: one ``agents`` row per legacy node (design §3.0 rev 6, Appendix A.2).

Each node is split across three one-to-one tables, as Appendix A.2 lays out:

  agents          the columns queries use (tree, state, lineage, session, accounts, mailbox,
                  scope, usage, status, runtime markers), plus the derived columns below
  agent_texts     the charters (large texts out of the hot row, §2.9)
  agent_runtime   shapeless provider payloads, one JSON column each (Q1)

and child tables: folder grants, MCP servers, the last denials and approvals, the recent
turns, carriers waiting in the halt queue (with their tokens and mail ids) and the mail-drain
ids. ``last_turn_mcp_tools`` (71,000 names over 1,045 agents on the live copy, 40 distinct
lists) is stored once per distinct list in ``tool_lists``.

Derived columns, recomputed from the record and never read back as data:

  name            the node's id (the dict key); unique among rows that are not tombstones
  ord             the node's position in the document (today's walks depend on it)
  parent_id, predecessor_id, successor_id
                  the agent rows those names point at; a name no node carries points at a
                  tombstone (§3.0, Q6). The record keeps only a null or misfit value; a name
                  is read back from the row it points at
  tool_list_id    the shared list holding ``last_turn_mcp_tools``
  is_frozen, is_halted, is_inflight, is_remote_controlled, has_pending_switch
                  presence flags for the partial indexes of Appendix A.2: ``bool(value)``,
                  the test the engine itself applies to these fields

Tombstone rows (``tombstone`` true) carry only a name: they are what a by-agent section's key,
or a parent, names when no node does. They are never nodes.

The frozen 0002 layout keeps a separate recent-turn table and JSON estimate tuples.
The current mapper uses explicit recent membership in ``agent_turns`` (Appendix A.2
rev 7.7): pre-log turns are list-only payloads, and matching log/recent occurrences
share one row. Estimates keep their integer or compensated float state in typed
columns without recomputation. Denials and approvals still use separate tables,
and scope columns keep a ``scope_`` prefix. Migration 0009 adds enum CHECKs; an
unsupported legacy member stays exact in extra, with a NULL typed column.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from typing import Any, Callable, Mapping

from .. import codec
from .. import enum_values as V
from .. import turns
from ..codec import Field, Rows, ShapeError, Spec
from ..sections import Context, Section, Table

F = Field


def _status(prefix: str) -> Field:
    return F(prefix, "obj", spec=Spec("", (
        F("status", "text", values=('working', 'blocked', 'idle')),
        F("summary", "text"), F("at", "ts"))))


TURN = Spec("agent_recent_turns", (
    F("n", "int"), F("at", "ts"), F("cost", "float"), F("ms", "int", nullable=True),
    F("toks", "int"), F("denials", "int"), F("approvals", "int"), F("ran_as", "text"),
    F("killed", "bool"), F("estimated", "bool"), F("cost_complete", "bool"),
    F("cost_source", "text"), F("cost_unknown_fields", "json"), F("route", "json"),
    F("reported", "json"), F("model_usage_key", "json"),
))

PROMPT_FIELDS = (F("tool", "text"), F("arg", "text"), F("cwd", "text"))

CARRIER = Spec("agent_carriers", (
    F("_halt_id", "text", col="halt_id"), F("text", "text"), F("view", "text"),
    F("ping", "bool"), F("ping_reason", "text", nullable=True), F("from", "text", col="from_node"),
    F("at", "float"), F("delivery_id", "text"),
    F("toks", "list", item="text", table="agent_carrier_tokens"),
    F("mail_ids", "list", item="text", table="agent_carrier_mail"),
    F("claim", "json"),
))

HOT = Spec("agents", (
    F("seat_id", "text", col="lineage_born"),
    F("generation", "int"),
    F("parent", "text", nullable=True),
    F("ui_order", "num"),
    F("created", "ts"),
    F("archived_at", "ts", nullable=True),
    F("rescinded_at", "ts", nullable=True),
    F("state", "text", values=('live', 'archived', 'unrecoverable')),
    F("title", "text"),
    F("model", "text"),
    F("grant", "num", col="credit_grant"),
    F("lineage", "text"),
    F("predecessor", "text", nullable=True),
    F("successor", "text", nullable=True),
    F("bearer_state", "text", nullable=True, values=('knowledge', 'preserving', 'lost')),
    F("lost_reason", "text"),
    F("session_id", "text"),
    F("transcript_incarnation", "text"),
    F("reply_incarnation", "text"),
    F("pid", "int", nullable=True),
    F("session_began_at", "ts"),
    F("session_unrun", "bool"),
    F("cheap_compacted", "bool"),
    F("compacted_unrun", "bool"),
    F("account", "text"),
    F("account_primary", "bool"),
    F("codex_account", "text"),
    F("codex_thread", "text"),
    F("codex_native_home", "text"),
    F("antigravity_account", "text"),
    F("antigravity_conversation", "text"),
    F("mailbox_id", "text"),
    F("mail_seq", "int"),
    F("scope", "obj", spec=Spec("", (
        F("permission_mode", "text", values=V.PERMISSION),
        F("org_visibility", "text", values=V.VISIBILITY),
        F("effort", "text", values=V.EFFORT),
        F("model_version", "text"),
        F("prefer_reserve", "bool"),
        F("account_fallback", "bool"),
        F("tools", "obj", spec=Spec("", (
            F("bash", "bool"), F("web", "bool"), F("edit", "bool"), F("subagents", "bool"),
            F("mcp", "list", item="text", table="agent_mcp_servers"),
        ))),
        F("add_dirs", "list", spec=Spec("agent_dir_grants", (F("path", "text"),
                                                              F("mode", "text", values=V.DIR_MODE)))),
    ))),
    F("cost_usd", "num"),
    F("cost_usd_unknown", "bool"),
    F("context_window", "int"),
    F("occupancy", "int", nullable=True),
    F("occupancy_est", "bool"),
    F("cli_compactions", "int", nullable=True),
    F("cli_boundary_offset", "int"),
    F("turn_seq", "int"),
    F("turn_est_cost", "json"),
    F("turn_est_toks", "json"),
    _status("last_status"),
    _status("prev_status"),
    F("limit_locked", "bool"),
    F("config_seq", "int"),
    F("hard_fail_run", "int"),
    F("limit_run", "int"),
    F("net_fail_run", "int"),
    F("net_fail_since", "ts"),
    F("untrusted_limit_run", "int"),
    F("docket_reminder_at", "ts"),
    F("working_activity_at", "ts"),
    F("cache_keepalive_at", "ts"),
    F("last_turn_mcp_tool_count", "int"),
    F("last_turn_mcp_fingerprint", "text"),
    F("last_denials", "list", spec=Spec("agent_tool_denials", PROMPT_FIELDS)),
    F("last_approvals", "list", spec=Spec("agent_tool_approvals", PROMPT_FIELDS)),
    F("turns", "list", spec=TURN),
    F("halt_queue", "list", spec=CARRIER),
))

TEXTS = Spec("agent_texts", (
    F("charter", "text", nullable=True),
    F("team_charter", "text", nullable=True),
))

RUNTIME = Spec("agent_runtime", (
    F("frozen", "json", nullable=True),
    F("halt", "json", nullable=True),
    F("inflight", "json", nullable=True),
    F("turn_ended", "json", nullable=True),
    F("pending_switch", "json", nullable=True),
    F("remote_controlled", "json", nullable=True),
    F("admit_once", "json", nullable=True),
    F("unstuck", "json", nullable=True),
    F("last_wall", "json", nullable=True),
    F("cache_continuity", "json", nullable=True),
    F("envelope", "json", nullable=True),
    F("codex_route_last", "json", nullable=True),
    F("codex_usage_total", "json", nullable=True),
    F("codex_usage_reset", "json", nullable=True),
    F("desktop_import", "json", nullable=True),
    F("mail_drain", "obj", spec=Spec("", (
        F("ids", "list", item="text", table="agent_mail_drain"),
        F("retry_at", "int"), F("failures", "int"), F("suspended", "bool"),
    ))),
))

REFS = ("parent", "predecessor", "successor")
TOOL_KEY = "last_turn_mcp_tools"
FLAGS = {"frozen": "is_frozen", "halt": "is_halted", "inflight": "is_inflight",
         "remote_controlled": "is_remote_controlled", "pending_switch": "has_pending_switch"}

AGENTS = Table(
    HOT, (("id", "bigint"),), {"id": "agent_id"},
    ("id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
     '"name" text NOT NULL',
     "ord bigint",
     "tombstone boolean NOT NULL DEFAULT false",
     "parent_id bigint REFERENCES orgtree.agents (id)",
     "predecessor_id bigint REFERENCES orgtree.agents (id)",
     "successor_id bigint REFERENCES orgtree.agents (id)",
     "tool_list_id bigint REFERENCES orgtree.tool_lists (id)",
     "is_frozen boolean NOT NULL DEFAULT false",
     "is_halted boolean NOT NULL DEFAULT false",
     "is_inflight boolean NOT NULL DEFAULT false",
     "is_remote_controlled boolean NOT NULL DEFAULT false",
     "has_pending_switch boolean NOT NULL DEFAULT false",
     "row_version bigint NOT NULL DEFAULT 0"),
    (
        'CREATE UNIQUE INDEX agents_name ON orgtree.agents ("name") WHERE NOT tombstone',
        "CREATE UNIQUE INDEX agents_ord ON orgtree.agents (ord) WHERE NOT tombstone",
        "CREATE INDEX agents_children ON orgtree.agents (parent_id, ui_order, created, ord)",
        "CREATE INDEX agents_live ON orgtree.agents (ord) WHERE state = 'live' AND NOT tombstone",
        "CREATE INDEX agents_retired ON orgtree.agents (parent_id, ui_order, created, ord) "
        "WHERE state = 'archived' AND successor_id IS NULL AND NOT tombstone",
        "CREATE INDEX agents_predecessor ON orgtree.agents (predecessor_id)",
        "CREATE INDEX agents_successor ON orgtree.agents (successor_id)",
        "CREATE INDEX agents_lineage ON orgtree.agents (lineage_born)",
        "CREATE INDEX agents_session ON orgtree.agents (session_id)",
        "CREATE UNIQUE INDEX agents_mailbox ON orgtree.agents (mailbox_id) "
        "WHERE mailbox_id IS NOT NULL",
        "CREATE INDEX agents_account ON orgtree.agents (account) "
        "WHERE state = 'live' AND account IS NOT NULL",
        "CREATE INDEX agents_frozen ON orgtree.agents (id) WHERE is_frozen",
        "CREATE INDEX agents_halted ON orgtree.agents (id) WHERE is_halted",
        "CREATE INDEX agents_inflight ON orgtree.agents (id) WHERE is_inflight",
        "CREATE INDEX agents_remote ON orgtree.agents (id) WHERE is_remote_controlled",
        "CREATE INDEX agents_switching ON orgtree.agents (id) WHERE has_pending_switch",
    ),
)
TEXTS_T = Table(TEXTS, (("agent_id", "bigint"),), {"agent_id": "agent_id"},
                ("agent_id bigint PRIMARY KEY REFERENCES orgtree.agents (id) ON DELETE CASCADE",))
RUNTIME_T = Table(RUNTIME, (("agent_id", "bigint"),), {"agent_id": "agent_id"},
                  ("agent_id bigint PRIMARY KEY REFERENCES orgtree.agents (id) ON DELETE CASCADE",))

TOOL_LISTS_DDL = (
    """CREATE TABLE orgtree.tool_lists (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  sha256 text NOT NULL UNIQUE
);""",
    """CREATE TABLE orgtree.tool_list_items (
  list_id bigint NOT NULL REFERENCES orgtree.tool_lists (id) ON DELETE CASCADE,
  pos integer NOT NULL,
  tool text NOT NULL,
  PRIMARY KEY (list_id, pos)
);""",
    "CREATE INDEX tool_list_items_tool ON orgtree.tool_list_items (tool)",
)

# Frozen 0002 definitions: runtime estimates change only in the later schema
# migration, including for an org that has already run the alpha build.
LEGACY_HOT, LEGACY_AGENTS = HOT, AGENTS
HOT = Spec('agents', tuple(F(f.key, 'sum') if f.key in ('turn_est_cost', 'turn_est_toks') else
                          F('turns', 'membership') if f.key == 'turns' else
                          f
                          for f in LEGACY_HOT.fields))
NODE_BODY = Spec('agents', tuple(f for f in HOT.fields if f.key != 'turns'))
# The physical row also holds internal stamped tombstones. Authored nodes keep
# the original three-state enum: a legacy 'deleted' value stays exact in extra.
TOMBSTONE_HOT = Spec('agents', tuple(replace(f, values=f.values + ('deleted',))
                                   if f.key == 'state' else f for f in HOT.fields))
AGENTS = replace(LEGACY_AGENTS, spec=TOMBSTONE_HOT)
AGENTS = replace(AGENTS, indexes=AGENTS.indexes + (
    "CREATE INDEX agents_current_tombstone ON orgtree.agents(name,lineage_born,generation,id) "
    "WHERE tombstone AND state='deleted'",
))

_HOT_KEYS = frozenset(f.key for f in HOT.fields)
_TEXT_KEYS = frozenset(f.key for f in TEXTS.fields)
_RUNTIME_KEYS = frozenset(f.key for f in RUNTIME.fields)


def _list_sha(tools: list[str]) -> str:
    return hashlib.sha256(json.dumps(tools, ensure_ascii=False).encode("utf-8")).hexdigest()


class Nodes(Section):
    keys = ("nodes",)
    tables = (AGENTS, TEXTS_T, RUNTIME_T)
    migration_tables = (LEGACY_AGENTS, TEXTS_T, RUNTIME_T)
    before_ddl = TOOL_LISTS_DDL

    def encode(self, doc: Mapping[str, Any], ctx: Context, out: Rows) -> None:
        nodes = doc.get("nodes")
        if nodes is None:
            return
        if not isinstance(nodes, dict):
            raise ShapeError("nodes: expected an object keyed by node id")
        for name in nodes:                    # every node's id first: references go both ways
            if not codec.fits("text", name):
                raise ShapeError("nodes: a node id no text column can hold")
            ctx.add_node(name, nodes[name] if isinstance(nodes[name], dict) else None)
        lists: dict[str, int] = {}

        def list_id(sha: str, tools: list[str], out: Rows) -> int:
            lid = lists.get(sha)
            if lid is None:
                lid = lists[sha] = len(lists) + 1
                out.setdefault("tool_lists", []).append({"id": lid, "sha256": sha})
                items = out.setdefault("tool_list_items", [])
                items.extend({"list_id": lid, "pos": p, "tool": t} for p, t in enumerate(tools))
            return lid

        for i, (name, rec) in enumerate(nodes.items()):
            if not isinstance(rec, dict):
                raise ShapeError(f"nodes[{name}]: expected an object")
            encode_node(name, ctx.ids[name], i, rec, ctx, out, list_id)

    def finish(self, ctx: Context, out: Rows) -> None:
        """Tombstone rows for the names other sections minted (after every section ran)."""
        turns.merge_recent(ctx.recent_turns, out)
        records = [(ctx.ids[name], name, {}) for name in ctx.tombstones]
        records += [(aid, ctx.names[aid], record) for aid, record in ctx.current_tombstones.items()]
        for aid, name, record in records:
            encode_tombstone(name, aid, record, out)

    def decode(self, rows, ctx, present, doc) -> None:
        agents = rows.get("agents", [])
        for r in agents:
            ctx.names[r["id"]] = r["name"]
            ctx.ids.setdefault(r["name"], r["id"]) if not r["tombstone"] else None
        if "nodes" not in present:
            return
        tool_lists: dict[int, list[tuple[int, str]]] = {}
        for it in rows.get("tool_list_items", []):
            tool_lists.setdefault(it["list_id"], []).append((it["pos"], it["tool"]))
        ch_hot = self._children(rows, AGENTS)
        ch_rt = self._children(rows, RUNTIME_T)
        texts = {r["agent_id"]: r for r in rows.get("agent_texts", [])}
        runtime = {r["agent_id"]: r for r in rows.get("agent_runtime", [])}
        recent = turns.recent_values(rows)
        nodes: dict[str, Any] = {}
        for r in sorted((r for r in agents if not r["tombstone"]), key=lambda r: r["ord"]):
            nodes[r["name"]] = decode_node(r, ch_hot, ch_rt, texts[r["id"]], runtime[r["id"]],
                                           tool_lists, ctx.name, recent=recent.get(r['id'], []))
        doc["nodes"] = nodes


def encode_tombstone(name: str, aid: int, record: Mapping[str, Any], out: Rows) -> None:
    codec.encode(TOMBSTONE_HOT, dict(record), {'id': aid}, out, link=AGENTS.link)
    out['agents'][-1].update(name=name, ord=None, tombstone=True,
                           parent_id=None, predecessor_id=None, successor_id=None,
                           tool_list_id=None, **{c: False for c in FLAGS.values()})


def encode_node(name: str, aid: int, ord_: int, rec: dict[str, Any], ctx: Context, out: Rows,
                list_id: Callable[[str, list[str], Rows], int]) -> None:
    """One node's rows (``agents`` + ``agent_texts`` + ``agent_runtime`` and their children)
    under agent id ``aid``. ``ctx.agent`` gives the id a reference names (a tombstone for a
    name no node carries); ``list_id(sha, tools, out)`` the shared tool list's id, adding its
    rows when the list is new."""
    hot = {k: v for k, v in rec.items() if k not in _TEXT_KEYS and k not in _RUNTIME_KEYS}
    derived: dict[str, Any] = {}
    for ref in REFS:
        v = hot.get(ref)
        if isinstance(v, str) and codec.fits("text", v):
            derived[f"{ref}_id"] = ctx.agent(v)
            del hot[ref]
        else:
            derived[f"{ref}_id"] = None
    tools = hot.get(TOOL_KEY)
    derived["tool_list_id"] = None
    if isinstance(tools, list) and all(codec.fits("text", t) for t in tools):
        derived["tool_list_id"] = list_id(_list_sha(tools), tools, out)
        del hot[TOOL_KEY]
    for key, col in FLAGS.items():
        derived[col] = bool(rec.get(key))
    codec.encode(HOT, hot, {"id": aid}, out, link=AGENTS.link)
    if out['agents'][-1]['turns_is'] == codec.SHAPE_LIST:
        ctx.recent_turns[aid] = rec['turns']
    row = out["agents"][-1]
    row.update({"name": name, "ord": ord_, "tombstone": False, **derived})
    codec.encode(TEXTS, {k: rec[k] for k in _TEXT_KEYS if k in rec}, {"agent_id": aid}, out,
                 link=TEXTS_T.link)
    codec.encode(RUNTIME, {k: rec[k] for k in _RUNTIME_KEYS if k in rec}, {"agent_id": aid},
                 out, link=RUNTIME_T.link)


def decode_node(r: Mapping[str, Any], ch_hot: codec.Children, ch_rt: codec.Children,
                text_row: Mapping[str, Any], runtime_row: Mapping[str, Any],
                tool_lists: Mapping[int, list[tuple[int, str]]],
                name_of: Callable[[int], str], *, recent: list[dict] | None = None) -> dict[str, Any]:
    """The node ``encode_node`` was given, from its rows: ``r`` its ``agents`` row, the
    children of the agents and runtime tables, its ``agent_texts`` and ``agent_runtime``
    rows, ``tool_lists`` {list id: [(pos, tool)]} and ``name_of`` for the references."""
    rec = codec.decode(NODE_BODY, r, ch_hot, (r["id"],))
    if r.get('turns_is') == codec.SHAPE_LIST:
        if recent is None:
            raise ValueError('turns: the membership reader must supply the records')
        rec['turns'] = recent
    elif r.get('turns_is') == codec.SHAPE_NULL:
        rec['turns'] = None
    for ref in REFS:
        if r[f"{ref}_id"] is not None:
            rec[ref] = name_of(r[f"{ref}_id"])
    if r["tool_list_id"] is not None:
        rec[TOOL_KEY] = [t for _, t in sorted(tool_lists.get(r["tool_list_id"], []))]
    rec.update(codec.decode(TEXTS, text_row, None, (r["id"],)))
    rec.update(codec.decode(RUNTIME, runtime_row, ch_rt, (r["id"],)))
    return rec
