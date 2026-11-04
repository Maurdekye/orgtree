# UI stall diagnostics

Item `ui-freezes-intermittently-for-several-seconds-at`; spec `ui-stall-tooling-spec` rev 1.3 (user 2026-11-04 19:00:43Z "we need to build tooling into the frontend to determine the cause"). Code: `apps/desktop/renderer/src/stallwatch.ts` (+ `stallhook.ts`, `streamerstats.ts`, `stallfixture.ts`), `apps/desktop/main/stall-log.ts`, `stall-probe.ts`, `stall-worker-source.ts`, `packages/contracts/stall.ts`. Tests: `renderer/tests/stallwatch.test.tsx`, `tests/stall-log.test.mjs`, `tests/stall-probe.test.mjs`, `tests/stall-fixture.test.mjs`.

**Add `data-stall-id` to every new text input** (value from a fixed set: `desk-composer`, `quickchat`, `mail-reply`, `mail-compose`, `docket-field`, `hubchat-composer`, `search`, `settings-field`, `ask-answer`). A stall record names the typing target by it, never by text or name.

## What is written

`<data root>/diagnostics/ui-stalls.jsonl`, written ONLY by main (`stall-log.ts`), one JSON object per line, `v:1`. Rotates past 2 MB to `.1` then `.2` (three files, at most 6 MB). A line is at most 16 KB (stacks are cut first: 40 frames of 200 characters, then scripts, then whole arrays; `truncated:true`). At most 30 lines a minute per process; the overflow is counted in the next line's `dropped`. Best effort: a write error is swallowed. Nothing is written while nothing stalls. `ORGTREE_STALLWATCH=0` switches the whole tooling off (no observers, interval, worker, ping, header or command-line switch; the preload gets `--orgtree-stallwatch=0`).

Common fields: `at` (ISO UTC of the stall start), `src`, `ms`, `window` (the window-events id), `org_window`, `app` (version and short commit), `dropped`, `truncated`.

| `src` | Found by | Body |
| --- | --- | --- |
| `renderer-loaf` | a `long-animation-frame` entry of 500 ms or more (shorter ones only bump `loaf_50_500`) | `loaf{blocking,render_start,style_layout_start,scripts[]}` (top 10 scripts: invoker, fn, app-relative url, position, ms, forced style/layout ms), `input[]` (Event Timing entries overlapping the stall: type, input_delay, processing, presentation, `target`), `keys_2s`, `field_len` (focused field, rounded down to 100), `fetch[]` (unsettled engine calls, route and age), `ws{frames,bytes}`, `react{commits_in,commits_2s}`, `ctx{screen,panel,popout}`, `selectionchange{in,before_2s}`, `counts{agents,projects,watchdogs,open_panels,dom_nodes,text_nodes,max_depth,dom_partial,heap_mb,highlight_ranges,draft_saves_10s}`, `streamer{...scans and masks overlapping the stall...}`, `loaf_50_500`, `capture_ms` |
| `renderer-ping` | main pings each visible org window every 500 ms over a MessagePort answered from the preload (on the renderer's main thread); no pong 400 ms after a ping is a stall | `blocked_ms`, `stacks[]` (the renderer's JS stack at 400 ms and again at 2000 ms, at most twice; `unavailable:<reason>` if the API fails), `ipc[]` |
| `renderer-unresponsive` | Chromium's own `unresponsive` event | as `renderer-ping`, one stack |
| `main-lag` | a 100 ms main interval whose tick is 500 ms or more late | `lag_ms`, `ipc[]` (handlers pending or running in the window), `main_stack` (a worker thread pauses main through an inspector session, at most once a minute, never leaves the debugger enabled; `unavailable:<reason>` on any failure) |
| `sync-ipc` | a `sendSync` handler that took 100 ms or more | `channel` |

## How to read a stall

Join lines by `window` and overlapping time: a `renderer-loaf` says WHICH script and which input; a `renderer-ping` from the same window says what the renderer was running while it was blocked; `main-lag` and `sync-ipc` say whether main (or a synchronous IPC) held the window. `input[].input_delay` large with `processing` small means the thread was already busy when the key arrived. `streamer.scans_in` and `max_scan_ms_in` show whether the streamer scan was running during the stall; `counts` show what had grown.

**Function names are minified or empty** (production builds minify; most listeners are anonymous). The attribution path is the `app:/` `line:col` of a ping stack frame, plus the LoAF `sourceCharPosition`, mapped through the sourcemap of the SAME build (UI stall spec rev 1.5). To map: load that build's renderer `.map` (for example with the `source-map` package: `new SourceMapConsumer(map).originalPositionFor({ line, column: col - 1 })`; stack-frame lines and columns are 1-based and the library's `column` is 0-based, hence `col - 1`; a `sourceCharPosition` is a character offset into the bundle, so convert it to line/column first) and read the original file and function. A log without its build's sourcemap names only minified functions.

## Redaction (an allowlist, applied in main before writing)

Only schema fields are written; unknown keys are dropped; an enum value outside its enum becomes `other`. Script paths: the app origin or install folder becomes `app:/`, no query or fragment, any other absolute path is redacted. Fetch routes: `/api/orgs/<org>`, and every segment after `agents|projects|mail|work|watchdogs|files|apps` is `<id>`. Every other free string (function names, frames, channels, reasons) goes through `packages/contracts/streamer.ts` with all types on, whatever the user's switches say, each match becoming `<redacted:kind>`. Never recorded: message, mail, transcript or docket bodies, request or response bodies, WebSocket data, key values, field contents, clipboard, titles, agent or org names (counts only).

## Test-only fixture

`ORGTREE_STALL_FIXTURE=busy` at build time defines `__ORGTREE_STALL_FIXTURE__` and compiles in `stallfixture.ts`: a keydown in the desk composer spins 1500 ms in `stallFixtureBusy`, for rig proof RP1. A normal build defines `''` and the bundler drops it (`tests/stall-fixture.test.mjs`).

## Streamer evidence

The streamer scan counters come from `streamerScanStats()` in `streamer-boundary.ts` (added by the streamer freeze fix; `streamerstats.ts` reads it through a namespace import, so a build without it records `streamer:{on:false}`).
