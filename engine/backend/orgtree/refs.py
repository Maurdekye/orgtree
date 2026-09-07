"""Canonical references — the one place a link to a thing is spelled.

User request 2026-09-05: agents must be able to link directly to a specific
mail, presented document or docket item, embedded in ordinary prose. These are
the tokens they emit, and the tokens the UI resolves.

    @item:<org>/<slug>
    @doc:<org>/<did>
    @agent:<org>/<node>
    @mail:<org>/user/<id>
    @mail:<org>/org/<id>
    @mail:<org>/node/<node>/<id>

⚠ THE ORG SEGMENT IS NOT DECORATION. Prose gets copied — between orgs, out of
a transcript, into a report. Two orgs can hold the same item slug, the same
agent name, even the same mail id, and a token without an org would resolve
against whichever org happened to be on screen and open something unrelated
while looking exactly right (Astra review 2026-09-05, correcting my first
draft, which claimed same-org scope was structural).

⚠ THE DELIMITERS ARE SAFE BY MEASUREMENT, NOT BY HOPE. Every identity that can
appear in a token is `[a-z0-9-]+`: org slugs and node ids come from
`ledger.slugify` (`[^a-z0-9]+` → `-`), item slugs from `Org._work_slugify`, and
document and mail ids are hex with at most a leading `d`. So neither `:` nor
`/` occurs inside any segment, and splitting on `/` cannot be ambiguous.
`token_shape_is_still_safe` in the tests re-derives that from the real
functions rather than trusting this paragraph.

⚠ AND A MALFORMED TOKEN IS REFUSED, NOT GUESSED. `@mail:org/node/abc123` has
three segments with a box of `node`, which is the four-segment shape missing
its node — it parses as nothing at all rather than as a mail somewhere
plausible. Guessing is how a reference opens the wrong thing.
"""
from __future__ import annotations

import re
from typing import Any

#: org slugs, item slugs, document ids and mail ids — all of them come from
#: `ledger.slugify`, `Org._work_slugify` or a hex mint, so none can carry a
#: delimiter.
SEG = r"[a-z0-9-]+"

#: ⚠ A NODE ID IS A WIDER DOMAIN THAN A SLUG. A knowledge bearer is
#: `<name>@<generation>` (`ledger.py`: `pred_id = f"{nid}@{gen}"`), so
#: `codex-checklist@4` is a real, addressable agent. A parser that "recovered"
#: by truncating at the `@` would address the LIVE agent instead of the bearer,
#: which is the wrong-target failure this format exists to prevent — the
#: generation is part of the segment, never something to cut off.
NODE = r"[a-z0-9-]+(?:@[0-9]+)?"

#: ⚠ A TOKEN ENDS AT A BOUNDARY, or it is not a token. Without this a
#: malformed token does not fail, it TRUNCATES, and the prefix that survives
#: is a valid reference to something ELSE — the same wrong-target failure the
#: org segment prevents, reached from the other side:
#:
#:     @agent:org/alpha@bad   -> agent `alpha`
#:     @agent:org/alpha@12x   -> bearer `alpha@12`
#:     @item:org/alpha/extra  -> item `alpha`
#:
#: Two continuations are refused: anything that could have been part of the id,
#: and a bare `@` unless it opens another canonical token, because
#: `…/alpha@item:org/beta` is two adjacent references.
END = r"(?![A-Za-z0-9_/-])(?!@(?!(?:item|doc|agent|mail):))"

#: the whole family, for a matcher that has to find these inside prose. The
#: node positions are the only ones that admit `@`, and only as `@<digits>` —
#: so a following `@item:…` can never be swallowed into one.
TOKEN_RE = re.compile(
    r"@(?:(item|doc):(" + SEG + r"/" + SEG + r")"
    r"|(agent):(" + SEG + r"/" + NODE + r")"
    r"|(mail):(" + SEG + r"/(?:user|org)/" + SEG
    + r"|" + SEG + r"/node/" + NODE + r"/" + SEG + r"))" + END)

KINDS = ("item", "doc", "agent", "mail")
MAIL_BOXES = ("user", "org", "node")


def item(org: str, slug: str) -> str:
    return f"@item:{org}/{slug}"


def doc(org: str, did: str) -> str:
    return f"@doc:{org}/{did}"


def agent(org: str, nid: str) -> str:
    return f"@agent:{org}/{nid}"


def mail(org: str, delivered: str, mid: str) -> str | None:
    """The reference for a mail that was actually delivered somewhere local.

    ⚠ `delivered` IS THE DELIVERY RECORD'S OWN VALUE, and the three cases are
    exactly the three `post_mail` returns — the user's inbox, the org inbox
    (which is where an EXTERNAL send is logged, so it has a local id after
    all), or a node's box. Anything else returns None rather than inventing a
    box: a reference to a mail that is not in a box we can open is worse than
    no reference (Astra 2026-09-05).
    """
    d = str(delivered or "")
    m = str(mid or "")
    if not d or not m:
        return None
    if d == "user_inbox":
        return f"@mail:{org}/user/{m}"
    if d.startswith("@"):
        return f"@mail:{org}/org/{m}"
    if re.fullmatch(NODE, d):
        return f"@mail:{org}/node/{d}/{m}"
    return None


#: ⚠ AND A TOKEN STARTS AT A BOUNDARY TOO. `x@agent:org/alpha` inside an
#: ordinary word is not a reference somebody wrote; matching the right target
#: does not make arbitrary embedded text intentional.
#:
#: Not a lookbehind: two canonical tokens written with nothing between them put
#: an id character immediately before the second, and `re` has no
#: variable-length lookbehind to say "unless a whole token ends here". The scan
#: carries the end of the last ACCEPTED token instead.
LEAD = re.compile(r"[A-Za-z0-9_@-]")


def find_all(text: str) -> list[tuple[str, str]]:
    """Every token in `text`, as `(kind, rest)` pairs, in order, boundaries
    applied.

    The regex uses an alternation so the node positions can admit `@<gen>`,
    which makes its group numbering an implementation detail. Callers — and
    the cross-language fixture — use this instead of reading groups."""
    s = str(text or "")
    out: list[tuple[str, str]] = []
    end = -1                        # end of the last ACCEPTED token
    i = 0
    while i <= len(s):
        m = TOKEN_RE.search(s, i)
        if not m:
            break
        at = m.start()
        if at != 0 and at != end and LEAD.fullmatch(s[at - 1]):
            i = at + 1              # embedded in a word: keep looking after it
            continue
        kind = m.group(1) or m.group(3) or m.group(5)
        rest = m.group(2) or m.group(4) or m.group(6)
        out.append((str(kind), str(rest)))
        end = m.end()
        i = end
    return out


def parse(token: str) -> dict[str, Any] | None:
    """A token to its parts, or None when it is not one. Never a guess."""
    m = TOKEN_RE.fullmatch(str(token or ""))
    if not m:
        return None
    kind = m.group(1) or m.group(3) or m.group(5)
    rest = (m.group(2) or m.group(4) or m.group(6)).split("/")
    if kind in ("item", "doc", "agent"):
        return {"kind": kind, "org": rest[0], "id": rest[1]}
    if len(rest) == 3:
        return {"kind": "mail", "org": rest[0], "box": rest[1], "id": rest[2]}
    return {"kind": "mail", "org": rest[0], "box": "node",
            "node": rest[2], "id": rest[3]}
