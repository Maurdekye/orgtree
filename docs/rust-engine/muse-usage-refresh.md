# Muse usage refresh button

User request 2026-10-14 23:05UTC, ticket
`muse-usage-greyed-out-refresh-arrow-with-an-expl`: leave Muse's usage refresh
button visible, disable and grey it, and explain on hover:
"Muse usage only arrives at the end of a Muse turn."

The main Usage modal shares one Refresh head across the native Muse account and
registered Muse accounts. Both now carry the disabled policy explicitly from
the canonical provider ID, even before the reading arrives. Account IDs and
labels do not decide the policy. The button remains in its existing row, with
its icon, accessible name and dated reading. A wrapper also carries the tooltip
so hovering a disabled button still has a target. Its disabled style uses the
dim colour, 0.45 opacity and ordinary cursor; other providers retain their styles.

The reusable `AccountUsagePanel` has a text Refresh button and follows the same
policy from the returned provider. The source audit found no other per-account
usage refresh controls: `UsageBars` only renders readings, account identity
refresh is a separate action, and usage history has no account Refresh action.
Existing Sign in/retry actions and automatic cached/pushed reads stay intact.

This is UI only. The engine's `usage::muse_read` can still request metadata when
forced and return its last saved reading, or explicit unavailability when no
reading is saved. No deterministic refresh-click error was found in that source
path, and no live provider was probed. Engine/tool refresh behavior is unchanged.

## Verification recipe (not yet executed)

Under rig-sol's shared build lock and contained batch, use
`apps/desktop/renderer/tests/usagerefresh-check.mjs` with arguments
`<combined root> <authorized C output> <rust-engine node_modules> <mode> [suites]`.

- Red: set `UI_REFRESH_BASE=a47bb1692b40cf5612ca7b76505c3ffd5862530c`;
  set `UI_REFRESH_SCOPE=muse`; `tests museusagerefresh`. The runner overlays exact
  baseline `App.tsx` and `accountusage.tsx`, keeping the composed `api.ts` and
  `canvas/accounts.tsx` while retaining the new
  fixtures. Expected five tests: three Muse failures (host/registered with dated
  bars, host/registered unavailable, reusable panel) and two non-Muse controls.
  Report measured names and counts, rather than treating this recipe as proof.
- Green: unset `UI_REFRESH_BASE` and `UI_REFRESH_SCOPE`; `tests museusagerefresh usagerefresh usagehead
  usageaccounts appsettings`, then `typecheck` (root). Include tests tsconfig in
  the normal batch check. The new suite checks visibility, disabled state,
  tooltip, no request through native/synthetic clicks, retained bars/date,
  host/registered non-Muse force refresh and the reusable panel's policy.
  A Claude account with a Muse-looking ID must remain refreshable.

No packaging, installation, live provider operation or push. Native tooltip
rendering and pixel appearance are not measured by the synthetic DOM tests;
the CSS and hover wrapper are source-reviewed. Coordinator integrates the
checked hand-in. Execution remains pending at source hand-in.

Round445 runner correction: the first red did not execute any tests. It overlaid
an unrelated baseline `api.ts`, which lacks the new MCP item's `refreshMcpServers`
export. `UI_REFRESH_SCOPE=muse` restricts the overlay to this item's changed
existing production modules, preserving composed API and bars dependencies. The
default `all` scope retains the earlier usage-refresh recipe. Rig reported
31/31 green and root typecheck 0 before this runner-only correction; committed
scoped red execution still awaits its result.
