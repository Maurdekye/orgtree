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
"""

from __future__ import annotations

from typing import Any, Final

#: Every BOUNDED docket field: its limit, and where the long version belongs.
#: The advice is not decoration — a refusal that only says "too long" leaves
#: the caller to invent a home for the text it just had rejected.
LIMITS: Final[dict[str, tuple[int, str]]] = {
    "title": (200, "a title is a handle, not a summary — the long form is the "
                   "description (`objective`), which has no limit"),
    "acceptance": (300, "an acceptance condition is one testable sentence; the "
                        "reasoning behind it belongs in the description "
                        "(`objective`), which has no limit"),
    "attention_reason": (500, "state the decision and the confirmation you "
                              "want here, and put the supporting detail in the "
                              "description (`objective`) or in `evidence` — "
                              "both of which have no limit"),
    "blocked_reason": (500, "name what is stuck, who can unblock it and how you "
                            "will hear of it; the analysis belongs in "
                            "`evidence` (no limit)"),
    "waiting_reason": (500, "this state was retired — use `blocked` with a "
                            "blocked_reason"),
    "dropped_reason": (500, "say plainly whether it was cancelled or failed, "
                            "who decided, and what would make it worth "
                            "resuming; the detail belongs in `evidence` (no "
                            "limit)"),
    "done_so_far": (500, "each entry is ONE completed thing, kept scannable — "
                         "the detail belongs in `evidence` (no limit)"),
    "working_on_next": (500, "each entry is ONE next step, kept scannable — "
                             "the detail belongs in `evidence` (no limit)"),
    "ref": (500, "a ref is a path, url, sha or log name — prose goes in `note`, "
                 "which has no limit"),
    "evidence_ref": (500, "a ref is a path, url, sha or log name — prose goes "
                          "in `note`, which has no limit"),
    "finding_title": (200, "a finding's title is the handle a disposition is "
                           "recorded against — one line naming the defect; the "
                           "diagnosis, the reproduction and the argument go in "
                           "`detail`, which has no limit"),
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
