---
name: orgtree-usage-screens
description: Explain account cards, quota readings, refresh states, history charts and exported observations.
---
Up: [orgtree-providers](../SKILL.md)

# Usage and Usage history

Usage is the current account snapshot; Usage history is the recorded timeline. Open them from the Orgtree menu. An org window defaults to its allowed accounts, with the other accounts behind “Show all accounts”; opening from Home is app-wide. That UI choice does not widen agent-tool account access or change recording.

## Usage cards

Cards group accounts by provider, keeping native and registered identities distinct without duplicating native-home rows. Native Claude/Codex/Antigravity/Muse cards show reported bars and observation freshness; OpenRouter cards show each key's spending/cap and account balance. Local servers show local/no-provider-limit and their concurrency cap. API-key accounts use local metering.

Read status/error and observation date with the bars; unavailable is not zero. Structured credential rejection can expose Sign in again. That uses the same native desktop sign-in component as Providers, with terminal-opened versus verified-success distinguished. A provider/network error alone is not evidence that sign-in is required.

Refresh buttons can be pending, disabled by recent attempts/cooldown, or fail while retaining dated old observations. Do not interpret click success as newly measured capacity. The detailed window definitions belong in `orgtree-usage-windows` (orgtree-working › accounts), and agent refresh rules in `orgtree-tool-usage` there.

Claude usage-service waits can leave recent bars quietly visible with their original date, or show a dim unavailable card saying `usage updates paused; next retry in N s`. This pause is distinct from a real authentication or refresh error. The exact age/wait thresholds, shared attempt floor and retry timing live in `orgtree-usage-windows` (orgtree-working › accounts). Concurrent desktop refreshes for the same key await the shared result; the agent tool retains its explicit status response rather than the desktop waiting behavior.

Muse Refresh remains visible, dimmed and disabled because Muse supplies observations during/after turns rather than an independent fresh query. At landed source `4447424`, its last-good reading survives engine restarts with the original observation date. After a reported reset, the card shows `reset; awaiting reading` without a percentage bar or badge; the original reset/date remain visible and capacity is unknown. The exact retention/freshness contract lives in `orgtree-usage-windows` (orgtree-working › accounts). Source: `apps/desktop/renderer/src/canvas/accounts.tsx:255`, `apps/desktop/renderer/src/usagerefreshpolicy.ts`, `engine/rs/orgtree-engine/src/usage.rs:638`.

## Usage history

The compact header and its period controls stay sticky above the charts while you scroll; the filters occupy their own row. The initial period is seven days; buttons offer 24 hours, 7, 30 and 90 days. Provider, Account, Window and Model scope filters narrow the displayed series. Account choices include the provider name before the account name. Each chart is one account/window/model-scope series, grouped by account, with its own percent or monetary units.

Actual retained readings form the line. Missing observations are omitted and neighboring valid points can be connected; they are not zero consumption. Recorded resets break the line and have solid markers. The shaded right-hand future pane contains a dashed, labeled trend projection and dotted reported reset marker. A projection is a fit to recorded points, not a promised exhaustion time.

The header's “Projected ahead” slider sets how much of each chart's width is the future pane, from 0 % to 100 % (default 20 %). The time scale is fixed: every chart's plot spans exactly the chosen period, and the “now” line sits that share in from the right edge. Raising the share slides the now line left and pushes the oldest history off the left edge, cropped and not squeezed; at 0 % the whole period of history fills the chart with no future pane or projection, and at 100 % only the projection shows. The slider's thumb mirrors the now line, so dragging it left moves the line left (more projection) and the rightmost position is 0 %; assistive text and the readout state the ahead percentage. The projection reaches as far as the pane does, dragging re-lays out the charts without refetching, and the choice is remembered in the renderer's local storage on that machine (not per org). Source: `apps/desktop/renderer/src/usagehistory.tsx` (`aheadAxis`, `useAheadShare`).

Changing the period keeps the previous charts in place and dimmed until the new data arrives, preserving the current scroll position. No-history, no-series-in-period, unavailable-account and no-filter-match states are explicit. The view states retained date bounds/retention and truncation when returned. Changing display filters does not change stored observations.

CSV/JSONL exports on a series save the recorded points supplied for that chart and their metadata, rather than its projection or aggregate statistics. The history response can be downsampled; this is not a promise of a complete raw observation archive. Reading-history refreshes while the window is open; an engine not running cannot backfill provider observations it never recorded.

For sign-in/activation advise [Providers](../providers-tab/SKILL.md) or [account registry](../accounts-registry/SKILL.md) changes only when the actual status supports that diagnosis.

## See also

- See `orgtree-usage-windows` (orgtree-working › accounts).
- See `orgtree-tool-usage` (orgtree-working › accounts).
