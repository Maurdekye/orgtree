"""Classification vocabulary for the all-operation census (`census.py`).

WHAT THIS MODULE IS FOR. The shipped timing instrument can say that an
operation took 4.9 s and that it was called `orgtree_work`. It cannot say
whether that call was a `get` or an `assign` — a read of one item versus a
transfer of ownership across two agents — because `api._access_emit` validates
exactly one non-numeric field, the TOOL NAME, against `_profile_tool_names()`
and carries no action, subtype or target at all. That single gap is why 57.5%
of the architect's timed sample is unclassifiable and why `orgtree_work`, its
second-largest group at 176 rows, mixes plain reads with spanning authority
changes under one label (see the operation-census work item, and the
architect's OPERATION-CENSUS.md §"Every observed group with timed
acquisition"). Naming the ACTION and the ownership SCOPE is the whole reason
the census is worth building.

⚠ THE SAFETY ARGUMENT, because this module is the one that widens what a
record may contain. `api._access_emit` admits the tool verb on the grounds
that membership in `mcptool.TOOLS` is a closed, finite set of `[a-z_]` ASCII
names, so the field is either one of ~46 fixed strings or absent — it cannot
carry a prompt, a mail id or a credential no matter what the caller sends.
This module generalises that argument and nothing more:

    A catalogue property declared `{"type": "string", "enum": [...]}` has a
    closed, finite, ASCII vocabulary that the CATALOGUE ITSELF defines.
    Recording a value that is a member of that enum is exactly as safe as
    recording the tool name, and for exactly the same reason.

So every non-numeric value this module produces is one of:
  * a member of a catalogue enum, checked by `in` against the set the
    catalogue declares for that property (`validated_action`, `validated_sub`);
  * a member of a census-local literal set defined below (`RW`, `SCOPE`,
    `SCOPE_SRC`, `OUTCOME`, `METHOD`);
  * a route TEMPLATE, which `api._route_label` reads off the route table.

Anything that fails its membership check is DROPPED and COUNTED, never
recorded and never guessed. There is no field here that a slug, node id, mail
id, seat id, token, path, argument or body can reach. Adding one would mean
adding a name to a set in this file.

⚠ THIS MODULE MUST NOT IMPORT `orgtree` AT MODULE SCOPE. `census` is reached
from `api`'s middleware, which is imported by everything; `mcptool` is pulled
in lazily inside `_vocabulary()` for the same reason `api._profile_tool_names`
does it — there is no reason for the classification table to drag the tool
catalogue into import time.
"""
from __future__ import annotations

from typing import Any

#: Schema-visible literal sets. These are the ONLY non-catalogue strings a
#: record may carry, and every one of them is written by census code from a
#: literal below — never derived from request text.
RW = ("read", "write", "mixed", "unknown")
#: ⚠ `self` AND `other_agent` ARE DEFINED END-TO-END, NOT PER TRANSACTION
#: (architect constraint relayed 2026-09-20, decision seq 3 on the census
#: item). The failure mode this definition exists to prevent is a record
#: landing in `self` because the ONE transaction the census happened to
#: observe was local, while the logical operation it belonged to was not:
#:
#:   self        the CALLING agent's own state and nothing else, end to end.
#:               Not "the commit we watched stayed local" — every synchronous
#:               mutation and receipt the operation performs must stay in the
#:               caller's own store.
#:   other_agent at least one other agent's state, with no organization-level
#:               coordinator. ⚠ ORDINARY A→B MAIL IS `other_agent`, NEVER
#:               `self`, even though the sender's commit is local and an
#:               outbox design means no single transaction spans both: it
#:               touches two agent stores sequentially. The architect's words:
#:               "source+receiver commits do not count as one-store merely
#:               because each is local."
#:   subtree     spans a subtree the caller owns.
#:   org         touches organization-level state shared beyond one subtree.
#:   resource    a shared resource whose conflict key is not an agent.
#:   external    leaves the organization — the user, another org, a provider.
#:   none        no organization state at all.
#:   unknown     not established. COUNTED, never guessed into a bucket.
#:
#: Every `self` entry in `TABLE` below carries a source-verified reason.
#: `unknown` is a legitimate answer and is always preferred to a flattering
#: one — an operation whose locality cannot be settled from a single record is
#: a REAL LIMIT OF THIS INSTRUMENT, to be reported as such rather than papered
#: over with a table entry.
#:
#: ⚠ "Lock-free reads" is read off `rw == "read"`, NOT off `scope`. Never fold
#: reads into a scope bucket when reporting proportions: they are a different
#: axis and collapsing them double-counts.
SCOPE = ("self", "other_agent", "subtree", "org", "resource", "external",
         "none", "unknown")
#: Where `rw`/`scope` came from. ⚠ NEVER COLLAPSE THIS INTO THE VALUE ITSELF.
#: `table` is a SOURCE-BASED CANDIDATE CLASSIFICATION, not measured behaviour
#: — the architect's own words about the classification this table is seeded
#: from. A proportion computed without splitting on this field is not a
#: defensible number, and this field is what lets a reader check.
#:
#: ⚠ AND `declared` IS STILL NOT AN OBSERVATION. It means the handler that
#: authorized the call said so, which outranks a static table and is not a
#: measured storage contact. Nothing in schema 2 measures a contact; see
#: `census.snapshot`'s `provenance` block, which publishes the split and the
#: coverage rather than leaving a reader to assume.
SCOPE_SRC = ("declared", "table", "route_shape", "unknown")
OUTCOME = ("ok", "client_error", "auth_denied", "not_found", "server_error",
           "unknown")

#: ⚠ SCHEMA 2: THE METHOD IS A CLOSED SET, and that is a privacy mechanism,
#: not tidiness. Schema 1 recorded `scope["method"]` RAW, which made it a
#: FIFTH kind of value in a module whose contract says there are exactly four.
#: An ASGI server admits any RFC 9110 token as a method, so a caller that can
#: reach the port could place an arbitrary ASCII token into an agent-readable
#: sink. Every method outside this list is recorded as `other` and counted.
METHOD = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE",
          "CONNECT", "other")
_METHODS = frozenset(METHOD)


def validated_method(method: "Any") -> str:
    """A member of `METHOD`, never the caller's own token."""
    if not isinstance(method, str):
        return "other"
    upper = method.upper()
    return upper if upper in _METHODS and upper != "other" else "other"


#: At most this many validated enum fields ride along in a record's `sub`.
#: A bound rather than a promise: the vocabulary is finite today, and a
#: catalogue that grows a dozen new enum properties must not silently grow
#: the record.
MAX_SUB_FIELDS = 8

# --------------------------------------------------------------- vocabulary

#: {tool_name: {property_name: frozenset(values)}}, built once from the
#: catalogue. Lazy for the same reason `api._profile_tool_names` is lazy.
_VOCAB: "dict[str, dict[str, frozenset[str]]] | None" = None

#: Dispatchable verbs deliberately absent from `mcptool.TOOLS`, mirroring
#: `api._PROFILE_EXTRA_TOOL_VERBS`. Kept as a separate name rather than
#: imported from `api`, because `api` imports this module's caller.
_EXTRA_TOOL_VERBS = ("orgtree_send_file_once", "orgtree_self_update",
                     "orgtree_op_call", "orgtree_operation_census")


def _schema_enums(tool: "dict[str, Any]") -> "dict[str, frozenset[str]]":
    """The closed string enums one catalogue card declares."""
    props = (tool.get("inputSchema") or {}).get("properties") or {}
    fields: "dict[str, frozenset[str]]" = {}
    for prop, spec in props.items():
        if not isinstance(spec, dict):
            continue
        values = spec.get("enum")
        # `type == "string"` matters: an enum of numbers or of objects is not
        # a closed ASCII vocabulary and has no business in a record.
        if spec.get("type") == "string" and isinstance(values, list):
            members = frozenset(str(v) for v in values if isinstance(v, str) and v)
            if members:
                fields[str(prop)] = members
    return fields


def _vocabulary() -> "dict[str, dict[str, frozenset[str]]]":
    """Every verb an agent can actually be dispatched, under EITHER deployment
    policy.

    ⚠ SCHEMA 2: `mcptool.TOOLS` IS NOT THE SET OF VERBS AN AGENT IS OFFERED,
    and schema 1's assumption that it was left two real verbs permanently
    unclassifiable. On a desktop-managed install `mcptool.available_tools()`
    runs `_desktop_relaunch_catalogue`, which SUBSTITUTES the two cards
    `orgtree_self_relaunch` / `orgtree_prime_relaunch` for
    `orgtree_self_restart` / `orgtree_prime_restart` — and `api` dispatches the
    relaunch names for real. Building from `TOOLS` alone filed both of them as
    `tool_unknown`/`unclassified_tool` on the profile this organization
    actually runs, and the exhaustiveness test could not see it because it
    iterated the same incomplete set.

    So the union is deliberate and it is policy-independent: the cards from
    `TOOLS`, the two desktop replacement cards, and the dispatchable-but-
    uncatalogued extras. A record must classify the same way whichever
    catalogue the process happens to serve, because the DISPATCH accepts both.
    """
    global _VOCAB
    if _VOCAB is None:
        vocab: "dict[str, dict[str, frozenset[str]]]" = {}
        try:
            from . import mcptool
            cards: "list[dict[str, Any]]" = list(mcptool.TOOLS)
            # The replacement surface, added rather than swapped: both names
            # are dispatchable somewhere, so both must classify here.
            cards.extend(getattr(mcptool, "_DESKTOP_RELAUNCH_CARDS", ()))
            for tool in cards:
                name = str(tool.get("name") or "")
                if not name:
                    continue
                vocab[name] = _schema_enums(tool)
        except Exception:                                      # noqa: BLE001
            # A classifier may never be the reason a request fails. An empty
            # vocabulary degrades every record to `action: absent` and
            # `unclassified_action`, which is COUNTED and therefore visible —
            # unlike a silent partial answer.
            vocab = {}
        for extra in _EXTRA_TOOL_VERBS:
            vocab.setdefault(extra, {})
        _VOCAB = vocab
    return _VOCAB


def tool_names() -> "frozenset[str]":
    """The closed set a `tool` field value must belong to."""
    return frozenset(_vocabulary())


def _reset_vocabulary_for_tests() -> None:
    """Drop the memoised catalogue. Tests only."""
    global _VOCAB
    _VOCAB = None


# ------------------------------------------------------------ discriminator

#: The property whose value distinguishes what a call actually DID, per tool.
#:
#: For most tools it is literally `action`. The two that matter most are the
#: two the architect named as unclassifiable, and neither uses that name:
#:   orgtree_status — `status`, because "working/idle is self-local; done/
#:                    blocked also notifies parent" and the value IS the
#:                    locality distinction (71 rows, 15.1% of the timed sample)
#:   orgtree_message — `kind`, the only closed vocabulary the call carries
#: Anything not listed falls back to `action`, which is absent for most tools
#: and therefore yields `unclassified_action` — counted, not guessed.
_DISCRIMINATOR: "dict[str, str]" = {
    "orgtree_status": "status",
    "orgtree_message": "kind",
    "orgtree_send_notice": "kind",
}
_DEFAULT_DISCRIMINATOR = "action"


def discriminator_field(tool: str) -> str:
    return _DISCRIMINATOR.get(tool, _DEFAULT_DISCRIMINATOR)


def validated_action(tool: str, args: "dict[str, Any]") -> "tuple[str | None, str | None]":
    """`(value, property_name)` for this tool's discriminator, or `(None, None)`.

    Membership in the catalogue's own enum for that property is the WHOLE
    check — a value outside it is dropped, exactly as an uncatalogued tool
    verb is dropped by `api._access_emit`.
    """
    fields = _vocabulary().get(tool)
    if not fields:
        return None, None
    prop = discriminator_field(tool)
    members = fields.get(prop)
    if not members:
        return None, None
    raw = args.get(prop)
    if isinstance(raw, str) and raw in members:
        return raw, prop
    return None, None


def validated_sub(tool: str, args: "dict[str, Any]",
                  skip: "str | None" = None) -> "dict[str, str]":
    """Every OTHER catalogue enum property this call carries a valid member of.

    Sorted and capped at `MAX_SUB_FIELDS` so the record stays bounded and two
    identical calls produce byte-identical records.
    """
    fields = _vocabulary().get(tool)
    if not fields:
        return {}
    out: "dict[str, str]" = {}
    for prop in sorted(fields):
        if prop == skip or len(out) >= MAX_SUB_FIELDS:
            continue
        raw = args.get(prop)
        if isinstance(raw, str) and raw in fields[prop]:
            out[prop] = raw
    return out


# ------------------------------------------------------ the classification

#: `(tool, discriminator value or None) -> (rw, scope)`.
#:
#: ⚠ WHAT THIS TABLE IS. A SOURCE-BASED CANDIDATE CLASSIFICATION — what the
#: code appears to touch, read off the dispatch in `api.agent_call` and seeded
#: from the architect's L/C/S/R/Q assignment in OPERATION-CENSUS.md. It is NOT
#: measured behaviour of the calls it describes, and any record classified
#: from it carries `scope_src: "table"` so a reader can separate the two. The
#: architect's own closing sentence on that classification is "These are
#: source-based candidate classifications, not measured behavior of a new
#: implementation", and this comment exists so that caveat survives the copy.
#:
#: A `None` key is the tool's fallback when its discriminator is absent or
#: uncatalogued; a specific key always wins over it.
#:
#: ⚠ EVERY `self` ENTRY BELOW CARRIES A SOURCE-VERIFIED REASON, and that is a
#: rule rather than a courtesy (decision seq 3): `self` is the one value a
#: mistake in this table makes flattering, because it is the value the whole
#: per-agent-database question turns on. A verb whose locality I did not read
#: in the dispatch gets `unknown`, not `self`.
TABLE: "dict[tuple[str, str | None], tuple[str, str]]" = {}


def _put(tool: str, rw: str, scope: str,
         actions: "tuple[str, ...] | None" = None) -> None:
    if actions is None:
        TABLE[(tool, None)] = (rw, scope)
        return
    for action in actions:
        TABLE[(tool, action)] = (rw, scope)


# --- pure reads -------------------------------------------------------------
# No document is saved and no supervisor/provider path runs — api.py's own
# comment on the shared-gateway diagnostics family says so in those words.
# ⚠ `rw="read"` is the load-bearing field for all of these; the `scope` beside
# it says WHAT WAS READ, and a reader must not fold the two axes together.
_put("orgtree_capabilities", "read", "self")
_put("orgtree_state_inspect", "read", "subtree")
_put("orgtree_preview", "read", "subtree")
_put("orgtree_chart", "read", "org")
_put("orgtree_list_tiers", "read", "none")        # a catalogue, not org state
_put("orgtree_list_orgs", "read", "external")     # spans organizations
_put("orgtree_read_scratch", "read", "subtree")   # filesystem, downward only
_put("orgtree_read_transcript", "read", "subtree")

# --- the self-only writes, each with the reason it earns `self` ------------
# ⚠ THIS IS THE ONLY BLOCK THAT MAY SAY `self`, and every line of it was read
# in the dispatch rather than assumed.
#
# orgtree_status working/idle — VERIFIED at api.py's status branch: it writes
#   `org.node(body.node)["last_status"]` and `working_activity_at` and NOTHING
#   else; the `post_mail` to the parent is inside `if status in ("done",
#   "blocked")`. This is exactly the distinction the architect could not make
#   ("working/idle is self-local; done/blocked also notifies parent", 71 rows,
#   15.1% of the timed sample) and it is now read off the value, not guessed.
_put("orgtree_status", "write", "self", ("working", "idle"))
_put("orgtree_status", "write", "other_agent", ("done", "blocked"))
_put("orgtree_status", "write", "unknown")
#   VERIFIED: `org.self_restart_gate(body.node)` plus a durable request for
#   the caller's own runtime. No other node's state is written.
_put("orgtree_self_restart", "write", "self")
_put("orgtree_prime_restart", "read", "self", ("status",))
_put("orgtree_prime_restart", "write", "self")
_put("orgtree_restart_wake", "read", "self", ("status",))
_put("orgtree_restart_wake", "write", "self")
#   ⚠ SCHEMA 2, AND THIS IS THE D05 HOLE CLOSED. On a desktop-managed install
#   these two names REPLACE the two above in the catalogue an agent is
#   offered, and `api` dispatches them for real (`_desktop_relaunch_args`,
#   `agent_call`'s relaunch branch). Schema 1 classified only the `*_restart`
#   spellings, so on the profile this organization actually runs BOTH of the
#   real verbs were `unclassified_tool`. Same locality as the names they
#   replace, for the same source-verified reason: a relaunch request is a
#   durable request for the CALLER's own runtime and writes no other node.
_put("orgtree_self_relaunch", "write", "self")
_put("orgtree_prime_relaunch", "read", "self", ("status",))
_put("orgtree_prime_relaunch", "write", "self")
#   A watchdog is the caller's own pet: `list` reads its own, and create/
#   pause/resume/remove write its own. It wakes the OWNER when it fires, so
#   the FIRING is somebody else's operation, not this one.
_put("orgtree_watchdog", "read", "self", ("list",))
_put("orgtree_watchdog", "write", "self")

# --- two-party and upward writes: `other_agent`, never `self` --------------
# ⚠ EVERY ONE OF THESE IS A→B, so end-to-end locality is two stores even
# where each commit is local (decision seq 3). A `self` entry here would be
# the exact error that ruling exists to prevent.
_put("orgtree_request_credits", "write", "other_agent")   # own row + superior
_put("orgtree_request_scope", "write", "other_agent")     # own row + superior
#   VERIFIED: authority is retool's — "strictly downward, never yourself" —
#   so the target is always a DESCENDANT, and it performs a live provider
#   read between gate and write.
_put("orgtree_continue_on", "write", "other_agent")
#   VERIFIED in ledger.withdraw_ask: it mutates the ORG-LEVEL `asks`,
#   `credit_requests` and `scope_requests` collections, not a per-node record,
#   and the card it takes down is on the user's desk. Not self.
_put("orgtree_withdraw_ask", "write", "org")

# --- mail and delivery: `other_agent` by construction ----------------------
# ⚠ Sender and receiver are two stores. The architect: "source+receiver
# commits do not count as one-store merely because each is local." `external`
# when the target is the user or an outside address, which is decided from the
# target's SHAPE at call time (`target_shape`) and overrides this entry.
_put("orgtree_message", "write", "other_agent")
_put("orgtree_send_notice", "write", "other_agent")
_put("orgtree_ask", "write", "external")            # reaches the user
_put("orgtree_present", "write", "external")
_put("orgtree_submit_report", "write", "other_agent")
_put("orgtree_send_file", "write", "other_agent")

# --- docket -----------------------------------------------------------------
# The group the census exists to split: 176 slow rows under one label, mixing
# `get` with `assign`. Reads first, then item writes, then the spanning
# transitions that move ownership or authority between agents.
_put("orgtree_work", "read", "subtree",
     ("list", "get", "receipts", "review_grants", "artifact_read"))
_put("orgtree_work", "write", "subtree",
     ("create", "update", "addendum", "evidence", "decision", "claim",
      "check", "accept", "archive", "finding", "dispose", "artifact",
      "receipt", "rangediff", "verify", "participants", "move", "delete",
      "supersede"))
_put("orgtree_work", "write", "other_agent",
     ("assign", "handoff", "review", "verdict", "candidate_verdict",
      "integration_verdict", "review_verdict", "review_request",
      "review_grant", "review_revoke", "grant", "revoke"))
_put("orgtree_work", "write", "unknown")

# --- lifecycle and funding: spanning transitions ---------------------------
# The architect's S class — "seat creation, parent funding and authority/
# catalog span owners".
for _tool in ("orgtree_hire", "orgtree_rehire", "orgtree_retire",
              "orgtree_staff", "orgtree_cheap_compact",
              "orgtree_self_subjugate", "orgtree_switch_model",
              "orgtree_retool", "orgtree_rename"):
    _put(_tool, "write", "subtree")
_put("orgtree_move", "write", "org")          # re-parents across the tree
_put("orgtree_swap", "write", "org")
_put("orgtree_dissolve", "write", "org")
_put("orgtree_reallocate", "write", "org")    # moves credit between seats

# --- runtime control --------------------------------------------------------
_put("orgtree_halt", "write", "other_agent")
_put("orgtree_unhalt", "write", "other_agent")
_put("orgtree_interrupt", "write", "other_agent")
_put("orgtree_unstick", "write", "other_agent")
_put("orgtree_audience", "write", "other_agent")
_put("orgtree_audience", "read", "subtree", ("request",))

# --- shared resources: the architect's R class ------------------------------
# "Conflict key is a shared resource, not requesting agent."
_put("orgtree_reservation", "read", "resource", ("list", "overlap", "landing"))
_put("orgtree_reservation", "write", "resource")
_put("orgtree_resource_reservation", "write", "resource")

# --- the census's own read surface -----------------------------------------
# Process-wide diagnostics. `none` is the SCOPE (no org document is the
# subject); the read still loads the org to authenticate the caller through
# the shared gateway, which is a cost, not a scope.
_put("orgtree_operation_census", "read", "none")

# --- the dispatchable-but-uncatalogued verbs -------------------------------
# `api._PROFILE_EXTRA_TOOL_VERBS`, classified so they are not silently
# unknown. `orgtree_op_call` is DELIBERATELY absent: it is a wrapper, and
# `toolwait.tool_name` unwraps it to the verb it carries before this table is
# consulted — so a record that reaches here still named `orgtree_op_call` is
# one whose inner verb could not be read, and `unknown` is the true answer.
_put("orgtree_self_update", "write", "subtree")      # deprecated retool alias
_put("orgtree_send_file_once", "write", "other_agent")   # internal transport

del _tool


def classify_tool(tool: str, action: "str | None") -> "tuple[str, str, str]":
    """`(rw, scope, scope_src)` from the static table. `scope_src` is
    `"table"` on a hit and `"unknown"` on a miss — a miss is never guessed."""
    hit = TABLE.get((tool, action))
    if hit is None and action is not None:
        hit = TABLE.get((tool, None))
    if hit is None:
        return "unknown", "unknown", "unknown"
    return hit[0], hit[1], "table"


# ------------------------------------------------------------- target shape

#: Argument names that carry a NODE REFERENCE. Used ONLY to count them and to
#: compare them against the caller; the values themselves are discarded inside
#: `target_shape` and never reach a record. A name not in this set is not
#: inspected at all.
_NODE_ARGS = ("to", "node", "owner", "reviewer", "agent", "next_actor",
              "target_node", "parent")
_NODE_LIST_ARGS = ("nodes", "add", "remove", "grant_to", "participants")

#: A `to` value with one of these shapes leaves the organization. Matched on
#: the SHAPE only — the address itself is never recorded.
_EXTERNAL_PREFIXES = ("@org:", "@mcp:", "@net:")
_EXTERNAL_EXACT = ("user",)


def target_shape(args: "dict[str, Any]",
                 caller: "str | None") -> "tuple[int, bool, bool]":
    """`(n_targets, all_self, has_external)` — a COUNT and two booleans.

    The architect asks for "target cardinality/relationship" (OPERATION-CENSUS
    §"Minimal future complete census", item 2). Cardinality is a number and
    relationship is a category; NEITHER NEEDS THE IDENTITY. The comparison
    against `caller` happens here and both operands are dropped on return, so
    a node id is read and never stored.
    """
    seen: "set[str]" = set()
    external = False
    for name in _NODE_ARGS:
        raw = args.get(name)
        if isinstance(raw, str) and raw:
            if name == "to" and (raw in _EXTERNAL_EXACT
                                 or raw.startswith(_EXTERNAL_PREFIXES)):
                external = True
            else:
                seen.add(raw)
    for name in _NODE_LIST_ARGS:
        raw = args.get(name)
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, str) and item:
                    seen.add(item)
    # `all_self` is False for a call with no targets at all: "every target is
    # me" is vacuously true over an empty set and would read as a self-scoped
    # write on a call that named nobody. The honest answer there is `targets:
    # 0`, which the reader can see directly.
    all_self = bool(seen) and bool(caller) and seen == {caller}
    return len(seen), all_self, external


# -------------------------------------------------------------- route shape

def classify_route(method: str, route: str) -> "tuple[str, str, str]":
    """`(rw, scope, scope_src)` for a plain HTTP route, from the METHOD and
    the TEMPLATE's own shape. This is a structural derivation, not a table
    lookup and not a guess, so it gets its own `scope_src` value rather than
    borrowing `table`'s:

      * a template naming one node (`{nid}`) scopes to one agent;
      * a template naming an org but no node (`{slug}`) scopes to the org;
      * `/api/desktop/...` and `/api/diagnostics/...` touch no org document;
      * a template outside `/api/` is the app shell or a static asset and
        touches no organization state either;
      * anything else is `unknown`, and is COUNTED as such.

    ⚠ `<unmatched>` IS UNREACHABLE IN THIS APPLICATION, and the branch stays
    anyway. Measured 2026-09-20: a catch-all `GET|POST|PUT /{path:path}`
    serves the SPA, so every request matches SOMETHING — an unknown API path
    comes back as `GET /{path:path}` 200 or `POST /{path:path}` 405, never as
    `<unmatched>`. `api._route_label` still produces that string when
    `scope["route"]` is absent, so the branch is a real contract with that
    function rather than dead code, and a census reader who sees the value has
    learned something surprising rather than nothing.

    ⚠ `other` IS NOT A WRITE. Schema 2 maps an unrecognised method token to
    `other` (see `validated_method`), and `other` must fall through to
    `unknown` rather than being read as a mutation — an arbitrary token is
    exactly the case where the instrument does not know what happened.
    """
    verb = (method or "").upper()
    rw = "read" if verb in ("GET", "HEAD", "OPTIONS") else (
        "write" if verb in ("POST", "PUT", "PATCH", "DELETE") else "unknown")
    if not route or route == "<unmatched>":
        return rw, "unknown", "unknown"
    if "{nid}" in route or "{node}" in route:
        return rw, "other_agent", "route_shape"
    if "{slug}" in route or "{org}" in route:
        return rw, "org", "route_shape"
    if route.startswith("/api/desktop") or route.startswith("/api/diagnostics"):
        return rw, "none", "route_shape"
    if not route.startswith("/api/"):
        # The SPA shell and static assets. No organization document is read or
        # written, whatever the HTTP verb says — a 405 on the catch-all is not
        # a write of anything.
        return rw, "none", "route_shape"
    return rw, "unknown", "unknown"


def outcome_of(status: int) -> str:
    """HTTP status to the census outcome enum. `auth_denied` is split out from
    the rest of 4xx because a refusal is a different event from a malformed
    request and the two must not average together."""
    try:
        code = int(status)
    except (TypeError, ValueError):
        return "unknown"
    if code in (401, 403):
        return "auth_denied"
    if code == 404:
        return "not_found"
    if 200 <= code < 400:
        return "ok"
    if 400 <= code < 500:
        return "client_error"
    if code >= 500:
        return "server_error"
    return "unknown"
