# pyright: strict
"""Raw tool-call framing markup that leaked into a docket field.

THE DEFECT, AND WHERE IT ACTUALLY IS. A model writes the value of one tool
argument, then emits what it believes is the closing tag for that argument and
the opening tag for the NEXT one -- in a form the harness's tool-call framing
parser does not recognise as structure. The parser therefore treats those tags,
AND the whole payload of the argument that was meant to follow, as ordinary text
belonging to the argument still open. One argument arrives holding

    <the real description> <a closing tag> <an opening tag> <the next payload>

and every layer below faithfully stores it. The decisive evidence that this
happens at EMISSION and not in transit is that the leaked text contains invented
tags -- a close tag named after the argument (``objective``, ``question``) rather
than the generic parameter close the wire format actually uses. No decoder can
invent a tag name, and none can splice in the correct content of a different
argument in the order the model would have written it.

SO THIS MODULE CANNOT CURE THE BUG. Nothing on this side of the boundary can:
the text is already malformed when it arrives. What it can do is stop the docket
storing it in silence. That is the same call the length limits make -- refuse,
say exactly what was submitted, and let the caller send it again -- and it is
worth making, because a refused agent retries and the retry is usually clean,
whereas a silently stored description is damaged permanently. `freeze-provenance`
reported this three times and deliberately did not repair the text, because
re-typing a specification to fix an encoding bug risks changing the
specification. That was right, and it is why this module's repair is a
MECHANICAL STRIP rather than an edit.

⚠ WHY EVERY TOKEN BELOW IS BUILT BY CONCATENATION. Writing one of these tokens
as a single literal in a source file is not safe: the namespaced closing token
ends the enclosing tool-call parameter, so the file is written truncated at that
byte and the call still reports success. The first draft of the probe for this
ticket died exactly that way -- 608 bytes, no error. Assembling the tokens from
pieces is not decoration; it is the only way this file can describe the thing it
detects. Do not "tidy" these back into literals.

THE FALSE-REFUSAL PROBLEM IS THE HARD HALF, and it is not hypothetical: the
docket item that reports this bug quotes the fragment in its own description, so
a naive substring test refuses the bug report about the bug. Descriptions here
routinely carry Markdown code fences, XML snippets and quoted tool output, and a
filter that mangles a legitimate code block is worse than the leak it prevents.
So detection runs only over PROSE: fenced code blocks and inline code spans are
masked out first, and framing vocabulary inside them is ignored completely. That
also gives the refusal a one-step fix -- put it in backticks -- which the message
says out loud.

KNOWN LIMIT, STATED RATHER THAN HIDDEN. Indented (four-space) code blocks are
NOT masked. Telling an indented code block from an ordinary indented list
continuation needs the surrounding block structure, and guessing wrong in the
masking direction would blind the detector on live prose. Framing vocabulary
inside a four-space block is therefore refused, and the advice names the fix.
"""

from __future__ import annotations

import re
from typing import Any, Final, NamedTuple

__all__ = [
    "MarkupLeakError",
    "Span",
    "FRAMING_TOKENS",
    "find_leaks",
    "assert_clean",
    "strip_leaks",
    "mask_code",
]

# ⚠ Assembled, never written whole -- see the module docstring. `_NS` is the
# namespace the wire format puts on its own tags; the bare forms are the ones a
# model emits when it drops the namespace, and they are the ones that survive
# into storage as text (the namespaced close instead truncates the argument).
_LT: Final = "<"
_NS: Final = "ant" + "ml:"


def _tags(local: str) -> tuple[str, ...]:
    """Both spellings of one framing tag -- bare and namespaced."""
    return (_LT + local, _LT + _NS + local)


#: Regexes matching one complete framing construct each. Every pattern is
#: anchored on vocabulary the wire format owns, so a match is a tag and not a
#: sentence that happens to contain an angle bracket. ORDER IS SIGNIFICANT: two
#: patterns can cover the same bytes, and `find_leaks` keeps the earlier entry,
#: so the most specific owner of a construct is listed first.
#:
#: Each entry is (label, pattern). The label is what the refusal names, so it is
#: written for the agent reading the error, not for this file.
_PATTERNS: Final[tuple[tuple[str, "re.Pattern[str]"], ...]] = tuple(
    (label, re.compile(pattern))
    for label, pattern in (
        # An opening parameter tag. THE signature of the leak: in every
        # specimen recovered from the live store, the argument that was
        # supposed to come next announces itself with one of these.
        ("an opening parameter tag",
         "|".join(re.escape(t) + r'\s+name\s*=\s*"[^"\n]*"\s*>?'
                  for t in _tags("parameter"))),
        # The generic parameter close, both spellings.
        ("a parameter closing tag",
         "|".join(re.escape(_LT + "/" + t.lstrip(_LT)) + ">"
                  for t in _tags("parameter"))),
        # An opening invoke tag -- one level up in the same vocabulary.
        ("an opening invoke tag",
         "|".join(re.escape(t) + r'\s+name\s*=\s*"[^"\n]*"\s*>?'
                  for t in _tags("invoke"))),
        ("an invoke closing tag",
         "|".join(re.escape(_LT + "/" + t.lstrip(_LT)) + ">"
                  for t in _tags("invoke"))),
        ("a function-calls block tag",
         "|".join(re.escape(_LT + p + t.lstrip(_LT)) + ">"
                  for t in _tags("function_calls") for p in ("", "/"))),
        # The INVENTED close tag: a model that drops the namespace also tends
        # to name the close after the argument rather than after the element --
        # `</objective>`, `</question>` -- which is the single clearest proof
        # that the text was malformed at emission, since the wire format has no
        # such element. On its own `</anything>` is ordinary XML a description
        # may legitimately discuss, so this fires ONLY where the next thing is
        # an opening parameter tag, which is the shape the defect always takes.
        # The match covers the close tag alone; the parameter tag after it is
        # matched by its own pattern, so a repair removes both. ⚠ This pattern
        # OVERLAPS the generic close above -- `</parameter>` followed by an
        # opening parameter tag fits both -- which is the commonest real
        # specimen. `find_leaks` resolves that overlap; see its docstring.
        ("an invented argument closing tag",
         r"</[A-Za-z_][\w.:-]*>(?=\s*(?:%s)\s+name\s*=\s*\")"
         % "|".join(re.escape(t) for t in _tags("parameter"))),
    )
)


class Span(NamedTuple):
    """One leaked construct: what it is and exactly which bytes it occupies.

    `start`/`end` index the ORIGINAL text, so a caller can both report the leak
    and prove a repair touched nothing else.
    """

    label: str
    text: str
    start: int
    end: int


class MarkupLeakError(ValueError):
    """A docket field carried tool-call framing markup -- AND NOTHING WAS
    WRITTEN.

    Mirrors `workfields.FieldLimitError`: the whole call is refused before it
    touches the item, and the message says what was submitted rather than
    describing it, so the caller fixes it in one round trip. The leaks are
    carried as an attribute too, so a test can assert on them without parsing
    prose.
    """

    def __init__(self, field: str, leaks: list[Span]) -> None:
        self.field: str = field
        self.leaks: list[Span] = leaks
        first = leaks[0]
        more = ("" if len(leaks) == 1
                else f" (and {len(leaks) - 1} more further on)")
        super().__init__(
            f"`{field}` contains raw tool-call framing markup: {first.label}, "
            f"{first.text!r}, at character {first.start}{more}. NOTHING WAS "
            f"WRITTEN -- the whole call was refused before it touched the item, "
            f"so there is no partial update, no history row and no mail to "
            f"undo.\n"
            f"WHAT HAPPENED. Text like this reaches the docket when a tool call "
            f"closes one argument and opens the next in a form the caller's own "
            f"framing parser does not recognise, so the tags and the whole "
            f"payload of the argument that should have followed end up inside "
            f"THIS argument as ordinary text. Check the tail of what you sent: "
            f"the value you meant to pass in the next argument is probably "
            f"sitting at the end of this one, and that argument is probably "
            f"missing. Send the call again with each argument in its own field.\n"
            f"IF YOU MEANT IT LITERALLY -- writing about this markup is a "
            f"legitimate thing to do -- put it in a Markdown code span or a "
            f"fenced code block. Framing vocabulary inside backticks or a fence "
            f"is ignored completely, which is how this very defect is quoted in "
            f"the ticket that reports it.")


#: A fenced code block: a run of three or more backticks or tildes at the start
#: of a line (up to three leading spaces, per CommonMark), through the matching
#: closing run of at least the same length, or the end of the text.
_FENCE: Final = re.compile(
    r"(?m)^(?P<indent> {0,3})(?P<fence>`{3,}|~{3,})[^\n]*\n"
    r"(?P<body>.*?)"
    r"(?:^ {0,3}(?P=fence)`*~*[ \t]*$|\Z)",
    re.DOTALL)

#: An inline code span: a run of N backticks closed by the next run of exactly
#: N backticks (CommonMark). Applied AFTER fences are masked.
_CODE_SPAN: Final = re.compile(r"(?P<ticks>`+)(?:(?!(?P=ticks)`).)*?(?P=ticks)",
                               re.DOTALL)


def mask_code(text: str) -> str:
    """`text` with every code region blanked to spaces, same length.

    Same length so every offset found in the masked copy is a real offset in the
    original -- the detector reports positions in the text the caller actually
    submitted, and the repair removes bytes from that same text. Newlines are
    kept so line-anchored patterns still see the real line structure.
    """

    def blank(match: "re.Match[str]") -> str:
        return "".join(ch if ch == "\n" else " " for ch in match.group(0))

    return _CODE_SPAN.sub(blank, _FENCE.sub(blank, text))


def find_leaks(text: Any) -> list[Span]:
    """Every framing construct in `text` that is live prose, in position order.

    The spans are DISJOINT and ascending: one run of bytes is reported once,
    however many patterns matched it. That is not tidiness, it is what makes the
    two things built on this function true. The refusal counts these spans, so a
    construct listed twice makes the diagnostic overstate what it found; and
    `strip_leaks` promises that re-inserting them reconstructs the input byte for
    byte, which is the repair's proof that it edited nobody's specification, and
    a duplicate re-inserts the same bytes twice and breaks it.

    Overlap is NORMAL here rather than exotic: the generic parameter close is
    matched both by the pattern that owns it and by the invented-close pattern,
    whose close-tag-named-after-an-argument shape also fits the real close when
    an opening parameter tag follows. That is exactly the commonest specimen in
    the live store, so it is the case to get right.

    Where two patterns cover the same start the LONGER match wins, and ties go
    to the earlier entry in `_PATTERNS` -- which is why the generic close keeps
    its own accurate label instead of being reported as an invented tag.

    ⚠ NO TEST PINS THE `-end` HALF OF THAT KEY, and that is deliberate rather
    than an oversight. With the patterns as they stand the overlap is always
    exact: an invented close and the generic close match the same start AND the
    same end, because the invented pattern's greedy run stops at the same `>`.
    Swapping the key for `(start, end)` was checked against 2496 generated
    overlap shapes and changed nothing, so it is an equivalent mutant and a test
    for it would assert nothing. The `-end` is kept as the correct rule for a
    future pattern whose match is longer at a shared start; if you add one, that
    is the moment this becomes testable and should get a test.

    Returns `[]` for anything not a string, so a caller may hand this whatever
    it was given without pre-checking.
    """
    if not isinstance(text, str) or not text:
        return []
    prose = mask_code(text)
    found: list[Span] = []
    for label, pattern in _PATTERNS:
        for match in pattern.finditer(prose):
            # sliced from the ORIGINAL: the mask is a stencil for where to
            # look, never the bytes reported or removed
            found.append(Span(label, text[match.start():match.end()],
                              match.start(), match.end()))
    # Stable sort: equal (start, -end) keeps `_PATTERNS` order, so the label a
    # construct is reported under is the pattern that most specifically owns it.
    found.sort(key=lambda span: (span.start, -span.end))
    disjoint: list[Span] = []
    cursor = 0
    for span in found:
        if span.start >= cursor:
            disjoint.append(span)
            cursor = span.end
    return disjoint


def assert_clean(field: str, text: Any) -> Any:
    """Raise `MarkupLeakError` if `text` carries framing markup; else return it.

    ⚠ CALL THIS BEFORE THE FIRST MUTATION, for the reason `ledger._bounded`
    gives at length: the promise that a refusal leaves no item change, no
    history row and no mail is a promise about WHERE the check runs.
    """
    leaks = find_leaks(text)
    if leaks:
        raise MarkupLeakError(field, leaks)
    return text


def strip_leaks(text: str) -> tuple[str, list[Span]]:
    """Remove the framing constructs from `text`; change nothing else.

    Returns `(repaired, removed)`. THE ONLY bytes that leave are the ones
    `removed` names, and `removed` carries each span's exact offsets in the
    ORIGINAL, so re-inserting them reconstructs the input byte for byte. That
    reconstruction is the repair's proof, and the suite asserts it: the
    constraint on this path is absolute, because the text being repaired is
    somebody's specification and re-typing it is how a specification silently
    changes.

    That proof rests entirely on `find_leaks` returning DISJOINT spans, and it
    was briefly false because two patterns could report the same run of bytes
    twice -- on the commonest specimen shape, at that. The suite now pins the
    reconstruction on the overlapping shape specifically, not only on a fixture
    that happens to match one pattern each.

    Note what is deliberately NOT removed: the payload of the argument that
    leaked in. It is content its author wrote, merely in the wrong field, and
    deleting it would lose the very thing the mechanical-strip rule exists to
    protect. The tags go; the words stay, for a human to move.
    """
    leaks = find_leaks(text)
    if not leaks:
        return text, []
    out: list[str] = []
    cursor = 0
    for span in leaks:
        out.append(text[cursor:span.start])
        cursor = span.end
    out.append(text[cursor:])
    return "".join(out), leaks


#: The framing tokens, exposed for documentation and for tests that need to
#: build a damaged fixture without writing one as a literal either.
FRAMING_TOKENS: Final[dict[str, str]] = {
    "parameter_open": _LT + "parameter name=",
    "parameter_open_ns": _LT + _NS + "parameter name=",
    "parameter_close": _LT + "/parameter>",
    "parameter_close_ns": _LT + "/" + _NS + "parameter>",
    "invoke_open": _LT + "invoke name=",
    "invoke_close": _LT + "/invoke>",
    "function_calls_open": _LT + "function_calls>",
    "function_calls_close": _LT + "/function_calls>",
}
