# pyright: strict
"""The Claude Code CLI pin (D-222) — the version orgtree installs, and the
version floors that decide what a resolved CLI may be ASKED to do.

WHY THIS IS ITS OWN MODULE, and why it imports nothing. `update.ps1` and
`update.sh` have to know which version to install, and the one thing worse
than a pin is a pin written down twice: a shell literal and a Python literal
drift, and the symptom is a machine that reports the version it installed
while running a different one. Both scripts therefore READ `PIN` out of here —

    python -c "import sys; sys.path.insert(0, 'backend'); \
               from orgtree import clipin; print(clipin.PIN)"

— at a point in the deploy where nothing else about the install is yet known
to be healthy. So this module must be importable when the rest of the package
is not: no `providers`, no `ledger`, no `supervisor`, no filesystem, no
environment. If you are tempted to add an import here, add the thing that
needs it to `supervisor` instead.

⚠ THE THREE NUMBERS ARE NOT THE SAME NUMBER, and collapsing them breaks a
different install each way:

* `PIN` is what a deploy INSTALLS. Moving it forward is cheap.
* `supervisor._CLI_MIN` is the CAPABILITY floor — below it a turn is degraded
  (no `--effort`, no headless tool hooks). It stays where it is; raising it to
  match `PIN` would declare every machine that has not yet run the new deploy
  incapable, which is the opposite of a migration.
* `FABLE_5_1_MIN` is a MODEL-ID floor: the oldest CLI whose model registry
  contains `claude-fable-5-1` at all. A CLI below it is perfectly healthy — it
  simply has never heard of that id, so it must be handed the 5.0 id instead.
"""

from __future__ import annotations

import re


#: The version a deploy installs into ``<data-root>/cli`` (see
#: ``supervisor._PIN``). Latest published at the time of writing.
PIN = "2.1.258"

#: The npm package a deploy installs to get it.
PACKAGE = "@anthropic-ai/claude-code"

#: The Fable tier's two model ids. Named rather than spelled inline because
#: three modules and two update scripts have to agree about them.
FABLE_5 = "claude-fable-5"
FABLE_5_1 = "claude-fable-5-1"

#: The oldest CLI that knows ``claude-fable-5-1``.
#:
#: MEASURED, not assumed (2026-09-02, by grepping each published build's native
#: ``bin/claude.exe`` for the literal id): 2.1.220 → absent, 2.1.251 → absent,
#: 2.1.252 → absent, **2.1.257 → present**, 2.1.258 → present. 2.1.253–256 were
#: never published, so 2.1.257 is exact, not a bracket. In 2.1.258 the entry
#: reads ``{id: "claude-fable-5-1", family: "fable", display_name: "Fable 5.1",
#: knowledge_cutoff: "June 2026"}`` and the fable family's own default is
#: ``claude-fable-5-1``.
#:
#: ⚠ A CLI below this floor does NOT refuse the id — measured on 2.1.220,
#: ``--model claude-fable-5-1`` and ``--model totally-bogus-model-xyz`` both get
#: past argv parsing and go to the network. There is no loud local failure to
#: rely on, which is exactly why `supervisor.claude_model_for` downgrades
#: rather than trusting the CLI to complain.
FABLE_5_1_MIN = (2, 1, 257)


def ver_tuple(v: str) -> tuple[int, ...]:
    """``"2.1.258 (Claude Code)"`` → ``(2, 1, 258)``.

    Digits only, padded to three, so a build suffix or the CLI's parenthesised
    name cannot make a comparison raise. An unparseable string becomes
    ``(0, 0, 0)`` — callers that must not act on ignorance check for the
    ``"unknown"`` sentinel BEFORE comparing (see `supervisor.cli_capable`).
    """
    return tuple(int(x) for x in (re.findall(r"\d+", v or "")
                                  + ["0", "0", "0"])[:3])


def knows_fable_5_1(version: str) -> bool:
    """Does a CLI reporting `version` have ``claude-fable-5-1`` in its registry?

    ⚠ FAILS CLOSED on an unreadable version, and that is the OPPOSITE of
    `supervisor.cli_capable`'s rule — deliberately, because the two questions
    have opposite costs. Being wrong about CAPABILITY degrades a turn that
    would have worked, so ignorance must not degrade it. Being wrong HERE sends
    a model id to a CLI that may not know it, and the fallback (Fable 5.0) is a
    working model rather than a broken turn. Cheap to be wrong one way, not the
    other.
    """
    return version != "unknown" and ver_tuple(version) >= FABLE_5_1_MIN
