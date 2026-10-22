# Transcript history retries and false failures

2026-10-07; docket `4-0-0-transcript-retries-loading-earlier-message`.

The user reported history failures after returning from another window, with an
immediate successful manual retry. The engine was returning successful pages;
the renderer could mistake a moving tail for stalled history. History now uses
cursor pages where available, with five-second retries for genuine failures.

## Measured cause and limits

- Coordinator's read-only alpha.6 log audit: coordinator-opus chat requests
  returned HTTP 200 within milliseconds; older loads used `last=N`, with no
  `before=` requests. Incremental replies have `before:null, has_older:false`.
- Mounted reproduction: cache rows 292–299, append ten rows while the view is
  away, then request a 16-row viewport tail. The successful reply starts at 294,
  so `olderPageProgress` finds nothing older than cached row 292. The renderer
  announces a failed page despite a usable HTTP 200. Increasing the window on
  manual retry can then cross the old boundary and appear to fix it.
- Source check: incremental trimming replaced the retained history cursor with
  the delta's `before:null`. That forced future older loads back through tail
  expansion. Rust `runtime::convo::read` defines `before` as the oldest row's
  decimal sequence; `http::nodes::chat` identifies this conversation as `a<id>`.
- Focus invokes a refresh; it does not deliberately abort chat fetches. The API
  ceiling is 45 seconds and uses `TimeoutError`. Native window event timing was
  not captured; the reproduced client defect is consistent with the log evidence,
  rather than proof of the exact event sequence on the user's screen.

## Renderer rules

Viewport fill and scroll-up use the available `before` cursor. Incremental tail
trimming recreates the Rust cursor from the retained oldest row, instead of
taking pagination metadata from a delta. Paging retains the current read range
from request start, so a focus delta cannot cut a hole while the first page is
in flight. Incremental responses cannot settle a pending full-window growth.
The window-growth route remains for responses without cursor support.

The conversation store owns one five-second retry timer per watched agent and
shares in-flight cursor fetches. A failed page retains its cursor or window and
existing rows. Each visible reader captures its row anchor synchronously before
the retry starts. Hidden retained hosts unsubscribe; detached desks stay active.
Closing the last view cancels retries and invalidates its page callbacks.

Fetch or response-body `AbortError` cancellation does not become a failed page.
Cancelled first loads can retry silently; replaced/stale errors cannot overwrite
the active request. Timeout and HTTP failures retain the normal five-second
retry and the small retrying status.

## Returning from history (2026-10-22)

Returning to the live tail or closing the last desk discards older cached rows.
The retained window must then advertise older history again, even when the
previous window had reached the true start. Its Rust cursor is the oldest
retained sequence, including zero or imported negative sequences. If no rows
were discarded, keep the existing pagination metadata. An opaque legacy cursor
cannot be moved to a new boundary, so a trimmed legacy tail refreshes in full.

Previously both trimming paths kept `has_older=false` from an exhausted history
and cleared `before`. A subsequent event-driven incremental response preserved
those fields, so scrolling back stopped without loading the discarded history.
The taller-tail case also displayed the false start-of-conversation marker.
This is a shared renderer defect, reported on an Antigravity seat; the API pages
by unique sequence and does not filter by harness, timestamp or visible content.

`historytrim.test.tsx` reproduces both paths against the Rust page/delta contract,
with mixed thought/tool/empty/user rows, equal timestamps and negative/zero
sequences. It checks complete reload without gaps, a true short conversation,
an unchanged zero cursor and legacy cursor compatibility. The reproduction is
synthetic; the affected installed seat was not read because the API requires a
desktop token. A real-seat recheck remains separate from this source diagnosis.

## Verification

`npm run typecheck` and the mounted synthetic smoke pass. The smoke covers first
loads, repeated cursor failures, held requests, duplicate prevention, reader-row
and pixel-offset preservation, close/switch/hidden cleanup, event-driven desks,
legacy window growth, gap reconciliation, the hidden-window burst reproduction,
incremental cursor trimming, and a focus delta racing a held first page. Fetch
and JSON-body cancellations stay silent, while a real timeout recovers after
five seconds. The reproduction fails before the follow-up. Layout is modelled
in jsdom; native Chromium/popout behavior is source-inferred.
