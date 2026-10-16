---
name: orgtree-tool-session
description: Ask where your turns run on this computer, Session 0 or one of the user's signed-in sessions, and choose where they run.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_session

With Run on boot, Orgtree's engine runs in Windows Session 0, which has no desktop. There you cannot see or use the user's desktop and apps: GUI programs, screenshots and anything else that needs the user's interactive session do not work. While the user is signed in, Orgtree's sign-in helper starts each agent's CLI in one of their sessions instead, from the agent's next turn, never during one. `orgtree_session` tells you where you run, lists the sessions you could run in, and lets you choose.

## When to use it

- **Before work that needs the user's desktop or apps**: opening a GUI program, taking a screenshot or screen capture, or showing the user a window. If `this_turn` is `"session0"` and `next_turn_moves` is `true`, finish the current step and end your turn at a safe point, with no background work running, or end it at once with [`orgtree_interrupt`](../tool-interrupt/SKILL.md) on yourself with `restart: true`: the new turn starts in the signed-in session. If `signed_in` is `false`, do not retry desktop work: say what is blocked, and wait for the sign-in (a watchdog on `session.signed_in`, below).
- When something that needs the desktop fails in a way that suggests there is none.
- After a session notice (`[ORGTREE SESSION NOTICE]`, `[ORGTREE SIGN-IN NOTICE]`, `[ORGTREE SIGN-OUT NOTICE]`) or the restart notice's "Session access at start" line, when you need the state now.

Without arguments it only reads, and is cheap.

## Parameters

| Parameter | Meaning |
|---|---|
| `prefer` | Optional. Your preference, kept in your settings (the user sees it in Agent settings as "Desktop session"): `signed-in` (the default: any of the user's sessions, an active one first), `console`, `remote`, `session0` (always Session 0), or an ordered list of kinds such as `"remote,console"`. Session 0 is always the fallback. It applies from your next turn. |
| `use` | Optional. A session id from `sessions` for your **next turn only**; `0` is Session 0. It lapses if that session has gone by then. |

With either, end your turn (or restart it with `orgtree_interrupt`) to apply it at once.

## What it returns

| Field | Meaning |
|---|---|
| `signed_in` | `true` when the engine's Windows user has a signed-in session (at the console, remote, or disconnected but still signed in); `false` when signed out; `null` when Windows could not say, or this is not Windows. |
| `this_turn`, `this_session` | Where your CLI runs now: `"session0"` or `"signed-in"`, and the Windows session id (0: Session 0). `null` while no CLI runs for you. |
| `next_turn`, `next_session` | Where your next turn's CLI will run if that turn starts now. |
| `next_turn_moves` | `true` when your next turn runs in another session than this one. |
| `sign_in_helper` | `true` while at least one sign-in helper is connected. |
| `preference` | Your stored preference (`"signed-in"` when you never set one). |
| `use` | The session you picked for your next turn, if any. |
| `sessions` | Session 0 (always), then each session of the engine's Windows user where a sign-in helper runs: `id`, `kind` (`console` or `remote`; `session0`), `state` (`active` or `disconnected`) and `user`. Other Windows users' sessions are never listed or used. |
| `summary` | The same in a few sentences. |

The answers come from the engine itself: your own runtime says where your CLI runs and where your next turn's will, by the rule it applies when that turn starts, and Windows says who is signed in where.

- A move happens only when a turn starts. If the user signs in during your turn, that turn stays in Session 0.
- A CLI that is still running background work when your next turn starts stays where it is and moves at a later turn.
- If the user is signed in but `sign_in_helper` is `false`, turns start in Session 0. The engine starts the helper again by itself after 30 seconds, then less and less often.
- A disconnected session counts as signed in; it runs apps, but nothing is shown there, so screenshots fail. An active session is chosen before a disconnected one.
- When the engine itself runs in the user's session (a per-user install, or an engine the desktop app started), every turn runs there.
- On macOS and Linux there is no Session 0: your CLI runs in the engine's own session, and `signed_in` is `null`.

## Sign-in and sign-out

When the user signs in (a sign-in helper connects), every agent is told once, with an `[ORGTREE SIGN-IN NOTICE]` line saying where its next turn will run; a running turn gets it at its next tool boundary, an idle agent with its next turn, without being woken. When the user signs out (the last helper stops), an `[ORGTREE SIGN-OUT NOTICE]` follows the same way. An engine restart while the user stays signed in sends neither. The watchdog events `session.signed_in` and `session.signed_out` fire at the same moments: an agent waiting for the desktop can keep a one-shot [watchdog](../../watchdogs/tool-watchdog/SKILL.md) on `session.signed_in`. At sign-in, an agent that reported `working`, owes docket work and is idle in Session 0 gets its checkup at once rather than up to 20 minutes later.

## If the user signs out during your turn

Signing out ends the sign-in helper and every CLI it started. A turn running there stops with "the user's Windows session ended", and a new turn starts at once in Session 0, the way a turn cut off by an engine restart is resumed. It carries "The user's Windows session ended while you were working, so your turn stopped. Continue where you left off." and the session notice. No mail is lost: if the stopped turn had produced nothing yet, its mail is handed to the new turn. A turn that had been interrupted, halted or ended on purpose is not resumed. The engine logs the end and writes it to its kill record as `codex-session-ended`.

## Delivery and permissions

Like `orgtree_status`, this tool has no Orgtree tool-group prerequisite: every agent has it on every harness, whatever its tool groups. It reports on and sets only you; it has no `node` argument.

Refusals: an unknown preference ("session must be signed-in, session0, console, remote, or an ordered list…"); a `use` id with no sign-in helper ("session N has no sign-in helper…"); a stopping runtime ("the agent's runtime is stopping") or one that did not answer within 30 seconds ("the agent did not answer in time").

## Examples

```json
{}
```

```json
{"prefer": "remote,console"}
```

```json
{"use": 0}
```

An answer during a turn that started before the user signed in:

```json
{"signed_in": true, "this_turn": "session0", "this_session": 0, "next_turn": "signed-in", "next_session": 2, "next_turn_moves": true,
 "sign_in_helper": true, "preference": "signed-in", "use": null,
 "sessions": [{"id": 0, "kind": "session0", "state": "active", "user": "ada"}, {"id": 2, "kind": "console", "state": "active", "user": "ada"}],
 "summary": "The user is signed in to this computer. This turn runs in Windows Session 0, which has no desktop: you cannot see or use the user's desktop and apps. Your next turn moves to the user's signed-in session."}
```

## See also

- [orgtree-halts-and-restarts](../halts-and-restarts/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-turn-envelope](../turn-envelope/SKILL.md)
