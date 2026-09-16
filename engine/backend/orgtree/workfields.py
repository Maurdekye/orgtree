# pyright: strict
"""THE ONE FIELD CONTRACT for everything an agent writes onto a docket item.

ONE module, imported by every docket writer and every docket renderer, so the
question "what happens to text that is too long?" has exactly one answer and
cannot drift between `work_update`, `work_evidence`, a review decision and the
mail that reports it. (Packages W01/W03/W04 share this contract by importing
it rather than restating its numbers.)

THE PROBLEM IT EXISTS TO FIX. Docket prose used to end in a bare `[:N]` slice.
A slice is the worst of the three possible behaviours: the caller is told it
succeeded, the stored record READS as complete, and the missing half surfaces
much later — when somebody tries to build from a spec that stops mid-sentence,
or reads an approval note that ends at `rerun focused/full r`. Agents reported
this from six directions: an attention reason silently cut after the warning
had already been written, review notes clipped in the mail that delivered them
and clipped again in `history[].note`, evidence notes cut inside a filename,
progress-list entries losing their tails.

SO THERE ARE EXACTLY TWO BEHAVIOURS HERE, AND NO THIRD:

  LOSSLESS (`prose`)   the field has no length limit. Whitespace at the ends
                       is trimmed and nothing else is touched. Used for the
                       fields that carry meaning by the paragraph — the
                       description, and every `note`. A long one is FOLDED by
                       the reader, never cut by the writer.

  BOUNDED (`bounded`)  the field keeps a deliberate limit (a title is a title;
                       a ref is a path, not prose), and text over it REFUSES
                       THE WHOLE CALL before anything is written — no item
                       change, no history row, no mail. The refusal states the
                       submitted length, the limit and the overage, so the
                       caller fixes it in ONE round trip instead of bisecting
                       its way down (one agent needed five attempts, watching
                       a countdown go 636 → 25 → 6 → 2 → 1 → 1 → 0).

A PREVIEW IS NOT A THIRD BEHAVIOUR. Mail bodies and notifications may show a
shortened copy of a lossless field, but only through `excerpt`, which SAYS it
is an excerpt, gives the full length, and names the call that returns the
whole thing. A silent cut in a notification is the same failure in a smaller
place.

AND A DIAGNOSTIC ECHOES WHAT WAS ACTUALLY SUBMITTED (`echo`). A refusal that
prints `'b390277706c7977c1853'…` for a 40-character sha hides the very typo
the caller is hunting for. `echo` prints the value exactly up to a generous
bound, and past that says how long it really was rather than pretending the
short form is the whole of it.

COUNTING IS UNICODE CODE POINTS, as `len()` counts them, AFTER the ends are
trimmed. An em dash, an ellipsis and an ASCII letter are one character each;
no encoding, escaping or normalisation happens first. Said out loud because
an agent that counts differently from the product cannot fix an over-length
field without guessing.

AND EVERY LIMIT IS AUDITED AGAINST ITS OWN FIELD'S BRIEF. Refusing instead of
slicing fixed the silent half of the problem but not the loud half: a field
whose tool card asks for three substantive things and then caps the answer at
500 characters is incoherent whatever it does at the boundary, and twelve
agents hit that on `attention_reason` alone — one of them spending four round
trips shaving 183, 48, 10 and then 4 characters off a single sentence, each
attempt re-sending a 4,000-character payload. A refusal that is cheap to act
on is still a refusal that should not have happened.

So the rule for every row in `LIMITS` is: THE LIMIT MUST FIT WHAT THE FIELD'S
OWN BRIEF ASKS FOR. Where the brief asks for one handle or one sentence, a
small limit is the brief being enforced and it stays. Where the brief asks
for several substantive things, the limit is sized to hold them. The audit
that set the current numbers is recorded per row in `LIMITS` below, so a later
reader can see which of the two answers each field got and why, rather than
re-deriving it from the number.

ONE LIMIT IS DERIVED FROM ANOTHER, and it is called out because it is not
obvious: when the user dismisses an attention flag, the product COMPOSES the
item's `blocked_reason` out of the agent's `attention_reason` plus a wrapper
sentence. That composed string is written whole — it is built from a value the
contract already bounded, so there is nothing to re-check and nothing that may
be cut. But it means `blocked_reason`'s limit must be large enough to hold a
maximal `attention_reason` and the wrapper, or the documented cap would be a
number the product itself routinely writes past. `assert_composition_fits()`
pins that relationship so raising one limit can never silently invalidate the
other.
"""

from __future__ import annotations

from typing import Any, Final

#: What a field's limit is FOR — the audited verdict, kept beside the number.
#:
#:   HANDLE     the brief asks for one handle, name or testable sentence. The
#:              limit IS the brief; a long value is a sign the text wanted a
#:              different field, and the advice says which one.
#:   ENTRY      a list of individually scannable entries. The brief asks for
#:              ONE thing per entry, and the limit already exceeds what one
#:              thing needs — raising it would fight the brief, not serve it.
#:   REF        a path, url, sha or log name. Not prose at any length.
#:   EXPLAINS   the brief asks for several substantive things, so the limit is
#:              sized to hold them. These are the rows the 2026-09-16 audit
#:              RAISED; the number is chosen from the brief, not from what the
#:              field happened to be capped at before.
#:   RETIRED    no live writer. Left exactly as it was.
HANDLE: Final = "handle"
ENTRY: Final = "entry"
REF: Final = "ref"
EXPLAINS: Final = "explains"
RETIRED: Final = "retired"

#: How many substantive things each EXPLAINS field's own brief asks for, and
#: therefore how its limit was sized. Sizing is `things × ROOM_PER_THING`,
#: rounded up to a round number — a substantive thing is one to three
#: sentences, and 500 characters holds three comfortably in any language the
#: product is written in.
ROOM_PER_THING: Final = 500

#: Every BOUNDED docket field: its limit, its audited role, and where the long
#: version belongs. The advice is not decoration — a refusal that only says
#: "too long" leaves the caller to invent a home for the text it just rejected.
#:
#: ⚠ THE NUMBERS ARE AUDITED, NOT INHERITED. Each row below says which of the
#: two possible answers it got — the limit rose to fit the brief, or the brief
#: was already what the limit enforces — because the pair being incoherent is
#: itself the defect, independently of whether the boundary refuses or slices.
LIMITS: Final[dict[str, tuple[int, str]]] = {
    # HANDLE — "short concrete title". 200 is the brief.
    "title": (200, "a title is a handle, not a summary — the long form is the "
                   "description (`objective`), which has no limit"),
    # HANDLE — "one testable sentence each". 300 is the brief.
    "acceptance": (300, "an acceptance condition is one testable sentence; the "
                        "reasoning behind it belongs in the description "
                        "(`objective`), which has no limit"),
    # EXPLAINS ×3 — RAISED 500 → 1500 (audit 2026-09-16). The brief asks for
    # what was asked against what was built, the exact decision/edge case/
    # definition added beyond the spec, AND the confirmation wanted. That is
    # three substantive things, and 500 characters is one of them; the field
    # the user reads to know what they are approving cannot be the field that
    # makes an agent delete two thirds of the answer to fit. Twelve agents
    # reported this pair, more than any other single complaint in the release.
    "attention_reason": (3 * ROOM_PER_THING,
                         "state what was asked against what was built, the "
                         "exact decision or edge case you added, and the "
                         "confirmation you want — the supporting detail "
                         "belongs in the description (`objective`) or in "
                         "`evidence`, both of which have no limit"),
    # EXPLAINS ×4, AND DERIVED — RAISED 500 → 2000 (audit 2026-09-16). The
    # brief asks for what is stuck, what would unblock it, who can act and how
    # you will hear of it. It is ALSO the field the dismissal route composes
    # out of a whole `attention_reason` plus a wrapper, so its limit must hold
    # that too — see `assert_composition_fits()`, which is what keeps these
    # two numbers honest with each other.
    "blocked_reason": (4 * ROOM_PER_THING,
                       "name what is stuck, what would unblock it, who can act "
                       "and how you will hear of it; the analysis belongs in "
                       "`evidence` (no limit)"),
    # RETIRED — the state is gone; no live writer reaches this row.
    "waiting_reason": (500, "this state was retired — use `blocked` with a "
                            "blocked_reason"),
    # EXPLAINS ×3 — RAISED 500 → 1500 (audit 2026-09-16). Cancelled or failed,
    # who decided, and what would have to change for it to be worth resuming.
    "dropped_reason": (3 * ROOM_PER_THING,
                       "say plainly whether it was cancelled or failed, who "
                       "decided, and what would make it worth resuming; the "
                       "detail belongs in `evidence` (no limit)"),
    # ENTRY — "each entry is ONE completed thing, kept scannable". 500 for one
    # scannable thing is already generous; the brief is the constraint here,
    # not the number, so this row was audited and deliberately LEFT ALONE.
    "done_so_far": (500, "each entry is ONE completed thing, kept scannable — "
                         "the detail belongs in `evidence` (no limit)"),
    # ENTRY — same verdict, same reason.
    "working_on_next": (500, "each entry is ONE next step, kept scannable — "
                             "the detail belongs in `evidence` (no limit)"),
    # REF — a path, url, sha or log name. 500 holds any real one.
    "ref": (500, "a ref is a path, url, sha or log name — prose goes in `note`, "
                 "which has no limit"),
    # REF — same.
    "evidence_ref": (500, "a ref is a path, url, sha or log name — prose goes "
                          "in `note`, which has no limit"),
    # HANDLE — "one line naming the defect"; the argument goes in `detail`.
    "finding_title": (200, "a finding's title is the handle a disposition is "
                           "recorded against — one line naming the defect; the "
                           "diagnosis, the reproduction and the argument go in "
                           "`detail`, which has no limit"),
}

#: The audited role of every bounded field, so the audit is machine-readable
#: and a new row cannot be added without stating which answer it got.
ROLES: Final[dict[str, str]] = {
    "title": HANDLE,
    "acceptance": HANDLE,
    "attention_reason": EXPLAINS,
    "blocked_reason": EXPLAINS,
    "waiting_reason": RETIRED,
    "dropped_reason": EXPLAINS,
    "done_so_far": ENTRY,
    "working_on_next": ENTRY,
    "ref": REF,
    "evidence_ref": REF,
    "finding_title": HANDLE,
}

#: The fields that are LOSSLESS, listed so the contract can be read in one
#: place (and asserted in one place). Nothing here is ever sliced on write.
LOSSLESS: Final[frozenset[str]] = frozenset({
    "objective",        # the item's authoritative standalone specification
    "note",             # review decisions, acceptance, evidence, checks, claims
    "attachment_name",  # must match the file actually written to disk
    "artifact_name",    # same rule: the name of the bytes actually stored
    "finding_detail",   # the diagnosis a finding's disposition is decided from
})

#: How much of a lossless field a NOTIFICATION carries inline before it says
#: it is an excerpt. Previews only; storage and `orgtree_work get` are whole.
DESC_EXCERPT: Final = 600
NOTE_EXCERPT: Final = 800

#: past this an echoed diagnostic value says its length instead of printing it
ECHO_MAX: Final = 200


class FieldLimitError(ValueError):
    """A bounded docket field was over its limit — AND NOTHING WAS WRITTEN.

    Carries the three numbers as attributes as well as in the message, so a
    caller (or a test) can assert on them without parsing prose.
    """

    def __init__(self, field: str, submitted: int, limit: int,
                 advice: str = "") -> None:
        self.field: str = field
        self.submitted: int = submitted
        self.limit: int = limit
        self.over: int = submitted - limit
        super().__init__(
            f"`{field}` is {submitted} characters and the limit is {limit}, so "
            f"it is over by {self.over}. NOTHING WAS WRITTEN — the whole call "
            f"was refused before it touched the item, so there is no partial "
            f"update, no history row and no mail to undo. Shorten it by "
            f"{self.over} character(s) and send the same call again"
            + (f" — {advice}" if advice else "")
            + ". (Characters are Unicode code points, counted after the ends "
              "are trimmed: an em dash, an ellipsis and a letter each count 1.)")


def limit_of(field: str) -> int:
    """The limit for a bounded field. KeyError names the contract gap."""
    return LIMITS[field][0]


def role_of(field: str) -> str:
    """Which answer the audit gave this field. KeyError names the gap."""
    return ROLES[field]


def assert_composition_fits(outer: str, inner: str, wrapper: int) -> None:
    """`outer`'s limit must hold a maximal `inner` plus `wrapper` characters.

    For the one place the product COMPOSES a bounded field out of another one:
    the attention dismissal writes `blocked_reason` as a wrapper sentence
    around the whole `attention_reason`. That composed string is written
    entire — it is built from an already-bounded value, so there is nothing to
    re-check and nothing that may be cut — but the documented cap on the outer
    field would be a lie if the product itself wrote past it. Raising either
    limit without the other trips this, which is the entire point: it fails at
    import-adjacent call sites and in the suite, not in a stored record.
    """
    need = limit_of(inner) + wrapper
    if limit_of(outer) < need:
        raise AssertionError(
            f"`{outer}` is capped at {limit_of(outer)} but the product composes "
            f"it out of a whole `{inner}` ({limit_of(inner)}) plus {wrapper} "
            f"characters of wrapper, so it must be at least {need}. Raise "
            f"`{outer}` to {need} or more, or shorten what composes it — a cap "
            f"the product routinely writes past is not a cap.")


def bounded(field: str, value: Any, *, limit: int | None = None) -> str:
    """A BOUNDED field: trimmed, and refused whole if it is over its limit.

    `limit` overrides the table only for a field the table does not name
    (callers should prefer adding it to `LIMITS`).
    """
    text = ("" if value is None else str(value)).strip()
    cap, advice = LIMITS.get(field, (0, ""))
    if limit is not None:
        cap = limit
    if cap and len(text) > cap:
        raise FieldLimitError(field, len(text), cap, advice)
    return text


def prose(value: Any) -> str:
    """A LOSSLESS field: trimmed at the ends, and otherwise kept entire.

    Deliberately a function rather than an inline `.strip()`, so that the
    places which must never grow a `[:N]` are greppable and say so.
    """
    return ("" if value is None else str(value)).strip()


def excerpt(text: Any, limit: int, *, what: str, how: str) -> str:
    """A preview of a lossless field that SAYS it is one.

    `what` names the field in the reader's language ("description", "note")
    and `how` is the exact call that returns the whole of it.
    """
    s = "" if text is None else str(text)
    if len(s) <= limit:
        return s
    return (s[:limit]
            + f"… [EXCERPT — {len(s)} characters in full; this shows the first "
              f"{limit}. Read the whole {what} with {how}]")


def echo(value: Any, *, cap: int = ECHO_MAX) -> str:
    """The submitted value, EXACTLY, for a diagnostic that has to be acted on.

    A typo is invisible in a value that was itself truncated to make the error
    message tidy, which is precisely the failure this replaces.
    """
    s = "" if value is None else str(value)
    if len(s) <= cap:
        return repr(s)
    return f"{s[:cap]!r} (…{len(s)} characters submitted in full)"
