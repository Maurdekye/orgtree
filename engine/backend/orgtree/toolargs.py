# pyright: strict
"""Refuse a tool call whose arguments do not match the tool's card, LOUDLY.

WHY THIS EXISTS (orgtree-message-send-notice-silently-send-an-emp). On
2026-09-28 the coordinator sent about nine mails with the text under `message`
instead of `body`. Nothing validated the arguments: the handler read
`a.get("body", "")`, found nothing, and delivered an EMPTY mail with no error.
Several agents then sat idle waiting for instructions that never arrived.

The rule here: a call naming a field its tool does not declare is refused
before anything is sent, and the refusal names every unknown field and, when
one is an obvious misnaming, the field that was meant. `orgtree_message` and
`orgtree_send_notice` also refuse a missing or blank `body`.

Dependency-free on purpose: `mcptool` imports it, and the sandboxed lane runs
`mcptool` by file path with nothing but this package beside it.
"""

from __future__ import annotations

import difflib
from typing import Any, Mapping

#: Tools whose whole effect is delivering `body`. A blank one is refused.
BODY_TOOLS = frozenset({"orgtree_message", "orgtree_send_notice"})

#: The misnamings seen or likely for a text field, checked before the fuzzy
#: match so `message` -> `body` is suggested even though the two words share
#: no letters a similarity ratio would reward.
_TEXT_ALIASES = ("message", "text", "content", "msg", "body_text", "note")

#: Fields a handler reads although its card does not advertise them — older
#: spellings agents may still have written down. Accepted rather than refused
#: so this check changes nothing that used to work; they stay undocumented.
ACCEPTED_UNDECLARED: Mapping[str, frozenset[str]] = {
    # the review/verdict branches read `sha` beside `candidate`/`candidate_sha`
    # and pass `evidence` through (api._work_call)
    "orgtree_work": frozenset({"sha", "evidence"}),
    # api.new_hire_harness: an explicit harness choice for an OpenRouter hire
    "orgtree_hire": frozenset({"harness"}),
    "orgtree_staff": frozenset({"harness"}),
    # only `one_shot` is accepted; anything else is refused by the handler
    "orgtree_restart_wake": frozenset({"mode"}),
}


def _suggest(key: str, declared: list[str]) -> str | None:
    if key.lower() in _TEXT_ALIASES and "body" in declared:
        return "body"
    close = difflib.get_close_matches(key, declared, n=1, cutoff=0.75)
    return close[0] if close else None


def refusal(tool: str, schema: Mapping[str, Any] | None,
            args: Mapping[str, Any]) -> str | None:
    """The error text for a call that must not run, or None when it may.

    `schema` is the tool's `inputSchema`; None (a verb with no card) checks
    only the body rule."""
    problems: list[str] = []
    declared: list[str] = []
    if schema is not None:
        declared = [str(k) for k in (schema.get("properties") or {})]
        extra = ACCEPTED_UNDECLARED.get(tool, frozenset())
        unknown = [k for k in args if k not in declared and k not in extra]
        for key in unknown:
            hint = _suggest(str(key), declared)
            problems.append(f"unknown field `{key}`"
                            + (f" — did you mean `{hint}`?" if hint else ""))
        for key in schema.get("required") or ():
            if args.get(key) is None:
                problems.append(f"required field `{key}` is missing")
    if tool in BODY_TOOLS and "required field `body` is missing" not in problems:
        body = args.get("body")
        if not isinstance(body, str) or not body.strip():
            problems.append("`body` is empty — put the text of the mail in "
                            "`body`")
    if not problems:
        return None
    accepts = (f" This tool accepts: {', '.join(declared)}."
               if declared else "")
    return (f"{tool}: this call was NOT made and nothing was sent — "
            + "; ".join(problems) + "." + accepts)


def server_refusal(tool: str, args: Mapping[str, Any]) -> str | None:
    """The backend's check: only the mail verbs, against their own cards.
    Other verbs are left to their handlers here, because internal callers
    (the scale harness, tests, the send-file transport) post to the agent
    door directly; the MCP client checks every verb before posting."""
    if tool not in BODY_TOOLS:
        return None
    from . import mcptool
    card = next((t for t in mcptool.TOOLS if t.get("name") == tool), None)
    return refusal(tool, card.get("inputSchema") if card else None, args)


def strict_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """The card's schema with `additionalProperties: false`, so a client that
    validates against it refuses an unknown field before it reaches us."""
    return {**schema, "additionalProperties": False}
