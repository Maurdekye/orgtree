// bootgate.ts — the organization's tree goes out before the window's side
// readouts.
//
// ⚠ A BROWSER OPENS AT MOST SIX CONNECTIONS TO ONE ORIGIN. Measured
// 2026-09-30 on a copy of the orgtree org (window-open item): an org window's
// first render fired /api/providers, the four /api/*/usage/peek readouts and
// /api/host — six requests — before the tree read, and the tree (the one
// request the window waits on to show anything) queued until one of them
// answered. In every measured open the tree read started the moment
// /api/providers returned, and the live engine logs /api/providers at 1.4 s
// typical and up to 25 s. None of those six is needed to draw the window.
//
// So they wait here: until the window's FIRST tree read settles (answered or
// failed), or at once in a window with no organization, and never longer than
// BOOT_DEFER_MAX_MS whatever happens. Only their first call waits; once the
// gate is open every later call goes straight through.
export const BOOT_DEFER_MAX_MS = 3000

let release: (() => void) | null = null
let gate: Promise<void> | null = null
let cap: ReturnType<typeof setTimeout> | null = null

function pending(): Promise<void> {
  if (!gate) {
    gate = new Promise<void>((resolve) => { release = resolve })
    cap = setTimeout(openBootGate, BOOT_DEFER_MAX_MS)
  }
  return gate
}

/** The window's first tree read settled, or the window has no organization. */
export function openBootGate(): void {
  pending()
  release?.()
  release = null
  if (cap !== null) { clearTimeout(cap); cap = null }
}

/** `fetcher`, held until the gate opens. */
export const afterBootGate = <T,>(fetcher: () => Promise<T>) =>
  (): Promise<T> => pending().then(fetcher)

/** Tests only: a fresh, closed gate. */
export function resetBootGate(): void {
  if (cap !== null) { clearTimeout(cap); cap = null }
  gate = null
  release = null
}
