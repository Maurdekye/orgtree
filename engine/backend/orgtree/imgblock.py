"""FR-28 · Inlining attached images into an agent's turn (D-167).

User request 2026-08-27, verbatim: "if i send any images in a message, they
should be immediately loaded into context if under a certain reasonable max
size".

Before this, an image the user attached rendered for THEM in the chat and the
receiving agent got a filename. The agent could open it with `Read`, but only
if it thought to — and nothing told it the file was worth opening. This module
turns a user-attached image into a real `image` content block on the turn.

═══════════════════════════════════════════════════════════════════════════
⚠ THE COST MODEL, because the obvious one is WRONG and produces a wrong cap
═══════════════════════════════════════════════════════════════════════════
The intuition "a big image eats a lot of context, so cap the bytes" is false.
Claude DOWNSCALES an image before processing it, and the visual-token cost is
`ceil(w/28) * ceil(h/28)` — HARD CAPPED per model:

    high-resolution tier (Claude 4.7+ — fable-5, opus-5, sonnet-5)
        long edge 2576 px, max 4784 visual tokens
    standard tier (everything else here — haiku-4.5)
        long edge 1568 px, max 1568 visual tokens

So a 9 MB photograph and a 400 KB screenshot cost THE SAME once either is past
the downscale threshold. **Byte size does not predict context cost. COUNT
does.** That is why the context control below is `INLINE_IMAGE_MAX_COUNT` and
not `INLINE_IMAGE_MAX_BYTES`; the byte caps are guarding entirely different
things (the API's own ceiling, request size, memory, latency).

⚠ WHICH HALF OF THIS IS MEASURED, AND WHICH IS READ (D-158 applied to a
documented fact rather than to a test). A future reader must know which half
to re-check when something changes:
  · MEASURED here, 2026-08-27: that an `image` content block fed to the pinned
    CLI over `--input-format stream-json` actually reaches the model. A 64x64
    blue PNG went in through orgtree's exact flags and the model answered
    "blue". The MECHANISM is verified end to end.
  · READ from Anthropic's published vision documentation, NOT measured here:
    every number above and below — the 28x28 patch rule, the 4784/1568 token
    ceilings, the 2576/1568 long edges, the 10 MB base64 per-image limit, the
    32 MB request limit, the format list, and first-frame-only for animations.
    If Anthropic changes these, this file is stale and nothing in our test
    suite will notice — the suite pins OUR behaviour, not their limits.
"""

from __future__ import annotations

import base64
import os
from typing import Any

# ── the three caps ────────────────────────────────────────────────────────
# Three constants and not one, deliberately (ruling, coordinator 2026-08-27):
# they guard three DIFFERENT things, and one number carrying all three would
# be exactly the undocumented magic number the one-constant instruction was
# written to prevent.

#: Per image, RAW bytes on disk. ⚠ NOT a context control — see the cost model
#: above; this guards the API ceiling and the machine.
#: Anthropic's hard limit is 10 MB BASE64, and base64 inflates by 4/3, so the
#: real raw ceiling is ~7.5 MB. 5 MB leaves headroom for that inflation plus
#: the JSON envelope, and still covers every realistic screenshot and phone
#: photo. Above it we ANNOUNCE rather than inline — the user is told to resize
#: or send a link, which is a thing they can act on.
INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024

#: Per TURN. ⭐ THIS IS THE CONTEXT CONTROL — the one cap that actually bounds
#: what an image batch costs, for the reason set out in the cost model above.
#: Worst case 8 x 4784 = 38,272 visual tokens on the high-resolution tiers:
#: ~4% of a 1M-token window, ~19% of Haiku 4.5's 200K one. Generous for real
#: use (people send one to three screenshots) while bounding the pathological
#: case of someone dragging in thirty. The overflow is announced, never
#: dropped, so nothing is lost by the limit being low.
INLINE_IMAGE_MAX_COUNT = 8

#: Per TURN, RAW bytes summed. Guards REQUEST SIZE, which the per-image cap
#: alone does not: 8 x 5 MB would be 40 MB raw / 53 MB base64, well past
#: Anthropic's 32 MB request ceiling, and the turn would fail as a whole
#: rather than degrade. 12 MB raw is ~16 MB base64 — half the ceiling, leaving
#: the other half for the conversation the images arrived in.
INLINE_IMAGE_TURN_MAX_BYTES = 12 * 1024 * 1024

#: The only formats Claude accepts (read from the vision docs, not measured).
#: An extension outside this set is announced with its type named, because
#: "we cannot show this to you" is information the agent can act on and a
#: silent omission is not.
INLINE_IMAGE_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def human_bytes(n: int) -> str:
    """Sizes the way the rest of the mail block writes them."""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def is_image_name(name: str) -> bool:
    """Does this filename claim to be an image we could inline?

    Extension only — deliberately. This is the CHEAP gate that decides whether
    a file is worth opening at all; `load_image_block` does the real work and
    is the only thing allowed to conclude that a file IS an image."""
    return os.path.splitext(str(name or ""))[1].lower() in INLINE_IMAGE_TYPES


def _probe(path: str) -> tuple[str | None, tuple[int, int] | None, str | None]:
    """Decode-validate `path`. Returns (media_type, (w, h), problem).

    ⚠ THIS IS WHY PILLOW IS A DECLARED DEPENDENCY. Without a real decode, a
    truncated or mislabelled file reaches the API and the API rejects the
    whole request — which kills the TURN, not just the image. That is the one
    outcome this feature must not produce: the user attaches a broken file and
    the agent's turn dies with an error that names nothing they can fix.

    Pillow missing is not an error either: the caller routes it to the SAME
    announce path as an oversized image. One degrade route, exercised by every
    oversized attachment, rather than a second branch that only ever runs in
    an emergency and is therefore known to compile rather than known to work.
    """
    try:
        from PIL import Image                                # noqa: PLC0415
    except Exception:                                        # noqa: BLE001
        return None, None, "this build cannot decode images (Pillow missing)"
    try:
        with Image.open(path) as im:
            im.verify()             # detects truncation/corruption
        # ⚠ verify() leaves the file object unusable — Pillow's own rule — so
        # size and format come from a SECOND open. Reading them off the
        # verified handle returns stale or empty values.
        with Image.open(path) as im2:
            fmt = (im2.format or "").upper()
            w, h = im2.size
            animated = bool(getattr(im2, "n_frames", 1) > 1)
    except FileNotFoundError:
        return None, None, "the file is missing from your uploads/ folder"
    except Exception as e:                                   # noqa: BLE001
        # Pillow raises a zoo of types for a bad file; the agent needs to know
        # it was unreadable, not which exception class said so.
        return None, None, f"it is not a decodable image ({type(e).__name__})"
    media = {"PNG": "image/png", "JPEG": "image/jpeg",
             "GIF": "image/gif", "WEBP": "image/webp"}.get(fmt)
    if media is None:
        return None, None, f"the format is {fmt or 'unrecognised'}, which " \
                           f"Claude cannot read (JPEG, PNG, GIF or WebP only)"
    if animated:
        # Not a refusal — the first frame is genuinely useful. But an agent
        # that describes one frame while believing it saw the animation is
        # wrong in a way it cannot detect, so this rides along with the image.
        return media, (w, h), "ANIMATED — only the first frame is visible"
    return media, (w, h), None


def load_image_block(path: str, budget_left: int) -> tuple[
        dict[str, Any] | None, str | None]:
    """Turn a file into an `image` content block, or explain why not.

    Returns (block, note). EXACTLY ONE of them is None-ish in the failure
    case: a None block ALWAYS comes with a note saying why, because the whole
    point of this feature's error handling is that an image the sender
    attached can never vanish without the agent being told it existed.
    A block MAY also come with a note (the animated-GIF case).

    `budget_left` is the turn's remaining raw-byte allowance.
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return None, "the file is missing from your uploads/ folder"

    if size > INLINE_IMAGE_MAX_BYTES:
        return None, (
            f"{human_bytes(size)} exceeds the "
            f"{human_bytes(INLINE_IMAGE_MAX_BYTES)} per-image inline limit — "
            f"ask the sender to resize it or send a link, or open it "
            f"yourself with Read")
    if size > budget_left:
        return None, (
            f"{human_bytes(size)} does not fit this turn's remaining "
            f"{human_bytes(max(0, budget_left))} image budget — open it "
            f"yourself with Read if you need it")

    media, _dims, problem = _probe(path)
    if media is None:
        return None, f"{problem} — open it with Read if you want to try"

    try:
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
    except OSError as e:
        return None, f"it could not be read ({e.strerror or 'I/O error'})"

    block = {"type": "image",
             "source": {"type": "base64", "media_type": media, "data": data}}
    # ⚠ ON SUCCESS THE NOTE IS THE PROBLEM OR NOTHING — never a description of
    # what worked (user ruling 2026-08-28: "the agent already knows its in its
    # context, it can see the image"). This used to prepend "{w}x{h}", which
    # made `note` non-None for EVERY successful image and gave the caller no
    # way to distinguish "here are its dimensions" from "there is something
    # wrong with this image you cannot see for yourself". The dimensions were
    # the redundant half: a model looking at an image can see how big it is.
    # The animated-GIF warning is the load-bearing half and still rides here.
    return block, problem
