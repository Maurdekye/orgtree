---
name: orgtree-tool-session
description: Ask where your turns run on this computer, Session 0 or the user's signed-in session, and whether your next turn moves.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_session

With Run on boot, Orgtree's engine runs in Windows Session 0, which has no desktop. There you cannot see or use the user's desktop and apps: GUI programs, screenshots and anything else that needs the user's interactive session do not work. While the user is signed in, Orgtree's sign-in helper starts each agent's CLI in their session instead, from the agent's next turn, never during one. `orgtree_session` tells you which of these situations you are in, before you try something that needs the desktop.

## When to use it

- Before work that needs the user's desktop or apps: opening a GUI program, taking a screenshot or screen capture, or showing the user a window.
- When something that needs the desktop fails in a way that suggests there is none.
- After a session notice (`[ORGTREE SESSION NOTICE]`) or the restart notice's "Session access at start" line, when you need the state now rather than at that turn's start.

It is read-only and cheap: calling it changes nothing, so you need no reason beyond wanting to know.

## Parameters

None.

## What it returns

| Field | Meaning |
|---|---|
| `signed_in` | `true` when the engine's Windows user has a signed-in session (at the console, remote, or disconnected but still signed in); `false` when they are signed out; `null` when Windows could not say, or this is not Windows. |
| `this_turn` | Where your CLI runs now: `"session0"` or `"signed-in"`; `null` while no CLI runs for you. |
| `next_turn` | Where your next turn's CLI will run if that turn starts now: `"session0"` or `"signed-in"`. |
| `next_turn_moves` | `true` when `next_turn` differs from `this_turn`: your next turn moves, and a session notice tells you so in that turn. |
| `sign_in_helper` | `true` while Orgtree's sign-in helper is connected; only then can a turn start in the signed-in session. |
| `summary` | The same in a few sentences. |

The answers come from the engine itself. Your own runtime says where your CLI runs and where your next turn's will, by the rule it applies when that turn starts, and Windows says whether the user is signed in.

- A move happens only when a turn starts. If the user signs in during your turn, that turn stays in Session 0: `this_turn` is `"session0"`, `next_turn` is `"signed-in"` and `next_turn_moves` is `true`. If the work needs the desktop, end the turn at a natural point and continue in the next one.
- A CLI that is still running background work when your next turn starts stays where it is, and moves at a later turn. The summary says so.
- If the user is signed in but `sign_in_helper` is `false`, turns start in Session 0 until the helper connects. The summary says this too.
- When the engine itself runs in the user's session (a per-user install, or an engine the desktop app started), every turn runs there: `this_turn` and `next_turn` are both `"signed-in"`.
- On macOS and Linux there is no Session 0: your CLI runs in the engine's own session, and `signed_in` is `null`.

## If the user signs out during your turn

Signing out ends the sign-in helper and every CLI it started. A turn running there stops with "the user's Windows session ended", and a new turn starts at once in Session 0, the way a turn cut off by an engine restart is resumed. It carries "The user's Windows session ended while you were working, so your turn stopped. Continue where you left off." and the session notice. No mail is lost: if the stopped turn had produced nothing yet, its mail is handed to the new turn. A turn that had been interrupted, halted or ended on purpose is not resumed. The engine logs the end and writes it to its kill record as `codex-session-ended`.

## Delivery and permissions

Like `orgtree_status`, this tool has no Orgtree tool-group prerequisite: every agent has it on every harness, whatever its tool groups. It reports only on you and has no `node` argument.

If your runtime is stopping, the call is refused with "the agent's runtime is stopping"; if it does not answer within 30 seconds, with "the agent did not answer in time". Try again later.

## Example

```json
{}
```

An answer during a turn that started before the user signed in:

```json
{"signed_in": true, "this_turn": "session0", "next_turn": "signed-in", "next_turn_moves": true, "sign_in_helper": true,
 "summary": "The user is signed in to this computer. This turn runs in Windows Session 0, which has no desktop: you cannot see or use the user's desktop and apps. Your next turn moves to the user's signed-in session."}
```

## See also

- [orgtree-halts-and-restarts](../halts-and-restarts/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-turn-envelope](../turn-envelope/SKILL.md)
