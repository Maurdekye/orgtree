# Orgtree 2.1.10-beta.0

A bugfix batch, nothing more. Five fixes that were each started on their own
branch, tested, independently reviewed, landed on main and then built together
so you can try them in one sitting. One of them is a behaviour change you will
notice immediately — removing a signed-in account no longer demands that you
move its agents by hand first — and the other four are things that were quietly
wrong: your canvas position when you switched organizations, the send-as-notice
toggle leaking between chat windows, the floating neighbor cards ignoring a
right-click, and the window controls drifting off the corner.

## Installing this build

**This is a private prerelease. It is not published to the update channel, so
the tray's Update now will not offer it and no existing installation can
discover it.** You install it by running the installer file you were sent, by
hand.

The installer closes Orgtree and waits for every agent to stop before it
replaces any files. It does not force anything — it waits — but every agent's
current turn ends, and that cannot be undone. Pick a moment when losing
in-flight work is acceptable.

Nothing was published, tagged, deployed, installed or restarted in producing
this build.

## Removing a secondary account now moves its agents for you

Before this build, the remove button on a signed-in account was dead whenever
anything was bound to it: "reassign its agents before removing this account".
That made the control unusable in practice, because the bindings you had to
clear included ones no screen showed you — an archived knowledge bearer keeps
its account binding, and gets it back if you ever rehire it.

Removing an account is now one operation. It finds every agent bound to that
account across every organization — live, idle, halted, frozen, and archived
bearers alike — moves them all to that provider's default account, and only
then removes the account. It also moves the things that are not agents but
still name the account: a queued account change that has not been applied yet,
a queued model switch that named that account, and the organization's default
account for new hires. The button now tells you how many agents will move
before you press it, and says how many moved after.

It is one operation in the strict sense: if any part of it cannot be done
safely, nothing happens at all and the account stays. That includes an
organization file that cannot be read — if we cannot tell whether it binds the
account, we refuse rather than guess.

**Agents that are mid-turn.** A running turn is never interrupted. Where the
provider allows it, the agent is moved immediately: the turn it is running
finishes on the account it started with, and its next turn uses the default
account. Where the provider requires a fresh session to change accounts — Codex
and Antigravity, or any agent holding a live Codex thread — that cannot be done
to a running turn, so the removal is refused and names the agents that are
busy. Wait for their turns to end and press remove again.

**The default account is now explicitly unremovable**, with the button disabled
and a reason on it. It is what everything else gets moved back to.

## Each organization keeps its own canvas position again

Switching organizations did not preserve where you were on the canvas. The
organization you opened came up at the camera of the one you just left, and its
own saved position was gone for good — and switching on through a third one
carried the same camera forward again.

The cause was a race with loading. The canvas is the same component across an
organization switch: the new organization's name arrived immediately while its
contents took anywhere from 11 to 38 seconds to load, and the camera's
auto-save fired inside that gap, writing the camera of the organization you
were leaving into the slot belonging to the one you were opening. The restore
then faithfully restored exactly that.

The save is now tied to the loaded organization rather than the requested one,
so a camera is only ever written under the organization it was actually taken
in. Panning during the load window is still saved, and still to the right
place. Within a single organization nothing changes.

## Send-as-notice is per chat window again

The switchboard's send-as-notice toggle was shared: arming it in one chat
window armed it everywhere, and disarming it anywhere disarmed it everywhere.
Each chat window now owns its own toggle, and arming one leaves the others
alone.

The review of this fix caught something worth mentioning: the first version
kept a compatibility path for callers that did not name a chat, and one of its
fallbacks reported "armed" if *any* chat was armed — the exact bug being fixed,
one careless call away from returning. That path is gone entirely rather than
left unreachable, so the compiler now refuses a call that does not name a chat.

## The floating neighbor cards answer a right-click

The floating edge cards — one per off-screen live sibling, drawn at the window
edge while you have an agent desk focused — did nothing at all on right-click.
Not a reduced menu; no menu. They now open the same agent menu you get from
that agent's row in the Agents List, with the same entries in the same order.
Left-clicking one still jumps to the agent exactly as before.

## The window controls sit on the corner

Minimize, maximize and close are anchored to the top and right edges with
proper corner hit targets, so the corner is clickable where you expect it to
be, including on the error screen that replaces a window that failed to load.

## What is in this build

| Fix | Commit |
|---|---|
| Per-chat send-as-notice toggles | `055d3f5` |
| Per-organization canvas state | `3a12991` |
| Agent menu from floating neighbor cards | `49fd4b7` |
| Window controls on the top-right edge | `81e320a` |
| Remove an account by rebinding its agents | `395614e` |

Every one of them was independently reviewed as an exact commit before it
landed, and each landed without its commit being rewritten, so what is in this
build is what was reviewed.

## Known limits, stated rather than discovered

* Removing an account across **several organizations at once** is atomic up to
  the point of writing. If saving one organization fails after another has
  already been written, the account is kept and the error names which
  organizations were moved; those agents are on the default account and
  working, and pressing remove again finishes the rest. The single-organization
  case — almost always what you have — is fully atomic. The one genuinely bad
  outcome, an account removed while an agent still points at it, cannot happen:
  the account is removed last, only after every move has been saved.
* Removing an account while a Codex or Antigravity agent bound to it is
  mid-turn is refused until that turn ends. This is deliberate, not a
  limitation being worked around: the alternative would either corrupt the
  running session or delete the account while an agent still named it.
