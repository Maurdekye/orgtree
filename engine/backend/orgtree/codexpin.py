# pyright: strict
"""The Codex CLI pin — the version a deploy installs, and the decision about
whether to install it. The Codex half of what `clipin` is for Claude.

WHY THIS EXISTS AT ALL (2026-09-04). Nothing in this repo ever refreshed the
Codex pin: `update.ps1`, `update.sh` and `tools/install-autostart.ps1` had no
codex step, so `<data-root>/codex` sat at whatever version a human last
installed by hand — 28 August, on this machine. On 4 September that cost
hours. OpenAI's ``model/list`` gates rollout models on the REPORTING CLIENT
VERSION, so the stale pin returned 9 model ids while a newer CLI returned the
same 9 plus ``gpt-6-astra`` — same account, same auth, same code. The tier was
invisible, and the refusal said the ACCOUNT did not offer the model.

WHY THIS IS ITS OWN MODULE, and why it imports nothing but `re`: both update
scripts read `PIN` out of here at a point in the deploy where nothing else
about the install is known to be healthy, exactly as they read `clipin.PIN` —

    python -c "import sys; sys.path.insert(0, 'backend'); \
               from orgtree import codexpin; print(codexpin.PIN)"

— so it must import when the rest of the package cannot. No `providers`, no
`ledger`, no filesystem, no environment.

⚠ WHY A CODE-DECLARED FLOOR AND NOT ``@latest``. Installing whatever the
registry has newest on every deploy would fix the drift and create a worse
problem: two deploys of the SAME COMMIT would produce different agent
runtimes. This script's own Claude pin already argues the point — a caret
range means "the version a re-install lands on drifts with the registry — the
opposite of a pin" — and the Codex CLI is not a leaf dependency, it is the
process that RUNS every codex agent's turn. An unreviewed CLI arriving
automatically can change turn behaviour for reasons unrelated to the commit
being deployed, and this repo has already shipped fixes for codex app-server
sandbox mode, stream ordering and MCP approval. So: a deploy enforces a FLOOR
that a human chose and review saw, and every install converges on it through
an ordinary `git pull` — which is the actual defect, since the old scheme
converged on nothing at all. What a deploy must never do is silently adopt a
runtime nobody has looked at.

⚠ AND IT IS A FLOOR, NOT AN EQUALITY. A pin NEWER than `PIN` is left exactly
where it is and merely reported. An operator who installed something ahead of
us did so on purpose, and a deploy that silently rolls a machine backwards is
worse than one that says nothing. Same rule as the Claude pin.
"""

from __future__ import annotations

import re

#: The npm package a deploy installs to get the CLI.
PACKAGE = "@openai/codex"

#: The version a deploy installs into ``<data-root>/codex``.
#:
#: ⚠ MUST BE INSTALLED WITH AN EXPLICIT ``@<version>`` AND ``--save-exact``.
#: The hand-run `npm install --prefix <data>/codex @openai/codex` from the
#: setup guide writes a CARET range, and a caret on a ``0.x`` version permits
#: PATCH updates only — so `^0.150.1` could never reach 0.153.x and a re-run
#: reported "up to date" while doing nothing. That is how the pin sat still
#: for a week while looking maintained.
PIN = "0.153.3"

#: The oldest CLI observed to be offered the ``gpt-6-astra`` rollout model.
#:
#: ⚠ THIS IS A BRACKET, NOT AN EXACT BOUNDARY, and unlike `clipin`'s
#: `FABLE_5_1_MIN` it was NOT established by testing each published build.
#: MEASURED 2026-09-04 on one signed-in account, by calling `model/list`
#: through orgtree's own inventory code and changing ONLY the executable:
#: 0.150.1 → 9 ids, no astra; 0.153.0 → the same 9 plus ``gpt-6-astra``.
#: Everything between 0.150.2 and 0.153.0 is UNTESTED. The true boundary is
#: somewhere in that range; this records the newest version known to be too
#: old and the oldest known to be new enough, and nothing finer.
#:
#: It is deliberately NOT used to gate anything. `providers` decides astra by
#: EXACT MEMBERSHIP in a live inventory, never by a version number — a version
#: floor would be a second, staler answer to a question the account already
#: answers. This constant exists to explain the pin, not to enforce it.
ROLLOUT_OBSERVED_ABSENT = "0.150.1"
ROLLOUT_OBSERVED_PRESENT = "0.153.0"


def ver_tuple(v: str) -> tuple[int, ...]:
    """``"0.153.3-win32-x64"`` → ``(0, 153, 3)``.

    Digits only, padded to three, so a platform suffix — which is exactly what
    the pin's own package.json carries — cannot make a comparison raise.
    """
    return tuple(int(x) for x in (re.findall(r"\d+", v or "")
                                  + ["0", "0", "0"])[:3])


def parses(v: str | None) -> bool:
    """Is `v` a version we may reason about at all?

    A string with no leading digit group is not a version, and `ver_tuple`
    would flatten it to ``(0, 0, 0)`` — which compares as older than
    everything and would authorise an upgrade on the strength of a typo.
    """
    return bool(v) and re.match(r"^\D*\d", v or "") is not None


def decide(installed: str | None, floor: str = PIN) -> dict[str, str]:
    """Should a deploy install the Codex pin, and why?

    THE DECISION LIVES HERE, not in the shell, because there are two update
    scripts of ~800 lines each and a rule implemented twice is a rule that
    disagrees with itself on one platform. `update.ps1` and `update.sh` call
    this and execute the answer; this is what the tests exercise.

    `installed` is the version currently in the pin directory, or ``None``
    when the pin is absent or its package.json could not be read.

    Returns ``{"action", "reason"}`` where action is one of:

    * ``install`` — nothing usable is there; put `floor` in.
    * ``upgrade`` — what is there is OLDER than `floor`.
    * ``keep``    — what is there is at or above `floor`; do nothing.
    * ``unknown`` — the FLOOR itself is unreadable. Do nothing and say so:
      guessing a version is how a machine ends up running one thing and
      reporting another. This is the only branch that is about OUR data being
      broken rather than the machine's, so it must never fall through to an
      install.
    """
    if not parses(floor):
        return {"action": "unknown",
                "reason": f"the pinned version {floor!r} is not a version — "
                          "leaving the Codex CLI alone"}
    if installed is None or not parses(installed):
        what = "not installed" if installed is None else f"unreadable ({installed})"
        return {"action": "install",
                "reason": f"Codex CLI {what} — installing {floor}"}
    have, want = ver_tuple(installed), ver_tuple(floor)
    if have < want:
        return {"action": "upgrade",
                "reason": f"Codex CLI {installed} is older than {floor}"}
    if have > want:
        return {"action": "keep",
                "reason": f"Codex CLI {installed} is NEWER than this build's "
                          f"{floor} — left as it is"}
    return {"action": "keep", "reason": f"Codex CLI {installed} — already current"}
