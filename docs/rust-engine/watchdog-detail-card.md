# Watchdog detail explanations

The detail card leads with the watchdog's type and a sentence describing its
target, trigger and owner (user, 2026-10-18 07:54–07:55Z). Silence is an attribute,
not another type. The existing expanded target/pattern, state, progress, history
and management controls remain available.

| Stored kind | Shown type | Trigger |
|---|---|---|
| `command` | Periodic command listener | Runs each interval; matching output or a 60-second timeout |
| `file` | File listener | New matching appended lines; checks each interval |
| `process` | Process listener | Observed up-to-down transition; checks each interval, ignores regex |
| `stream` | Stream listener | One long-lived command's matching output; exit diagnostic is separate |
| `activity` | Activity listener | An agent's pushed turn/tool-call activity |
| `event` | Orgtree event listener, with event name/prefix | Pushed filtered engine events; count thresholds fire on crossings |
| `fair_queue` | Mail queue listener | Waiting project mail assigned to one eligible listener, least recently served first |
| `slot` | Slot claim | Joins the project's line; fires once when granted a slot |

Slot claims show their ordinal place from the current shared watchdog snapshot,
using the slots desktop's queue ordering. A grant shows its slot number and lease
from the engine projection, with `spent` after firing. Paused claims say they are
out of the line and resume at the back; absent fields are never invented. The
card does not fetch a separate queue or change slot admission.

Event-mode stream/activity/event intervals are minimum alert gaps, not polling
cadences. Project mail dispatch has no polling cadence. Listener counts are not
in the card snapshot: the card explains fair sharing without inventing a count.
Original passive project messages stay passive even on a listener that normally
wakes. The saved watchdog `memo.notice` is now carried through the desktop
projection; old snapshots without it use the existing default wake behavior.

Silence describes the absence of matching input, not general inactivity. For a
process it means no observed down transition. Matching events and quiet fires
reset the timer. A quiet stream can remain armed after exit. An event-mode
stream's exit diagnostic does not spend a one-shot; its matching-output alert
does. Paused/exited/departing state remains separate from the definition.

Lead sentences shorten very long targets/patterns to 160 characters; the fields
below retain the complete expanded text. No scheduler, regex, permission, mail
dispatch or watchdog lifecycle semantics are changed.

## Focused verification

`watchdog-description.test.tsx` mounts the real detail panel for all seven kinds,
silence, delivery, thresholds, stream one-shot exceptions and existing controls.
`domain::watchdogs::tests` checks passive-delivery projection and legacy defaults.
Existing watchdog silence/schedule suites cover adjacent countdown behavior.

`tools/watchdog-card-smoke.mjs` bundles against provisioned dependencies without
installing or linking them. Its synthetic Electron capture includes project mail,
periodic command, activity silence and count-event cards in dark/light themes.
`visual-red` uses frozen baseline `3255bf9` panel source and CSS; the ordinary
visual mode requires the new type and explanation. The pixel guard composites
the overlay shade over the body color before comparing the actual screenshot.
The first red capture's body-only guard failed; that failed receipt is retained.
Prepared fixtures and syntax checks alone do not establish runtime passes; see
the docket's raw measured receipts for the current verdicts.

During phase 1 (user 2026-10-18 09:25Z), run only the focused description file
and one representative capture (`visual-quick`), rather than the old multi-suite
and before/after theme matrix. Wider checks wait for hardening.
