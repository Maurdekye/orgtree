// shellbridge.tsx — install and remove a fake `window.orgtreeDesktop` for the
// v3 shell suites.
//
// Every shell suite needs the same two lines and gets them wrong in the same
// way if each writes its own: the property must be `configurable` (otherwise
// the second test in a file cannot replace it) and it must be REMOVED rather
// than set to `undefined` at the end, because `desktop()` reads the property
// and a lingering `undefined` is indistinguishable from a browser only by
// accident. One helper, so a suite that forgets is impossible.

/** A bridge with the members today's shipped preload has and none of the v3
 *  ones — the negative control for "is this a v3 window?". */
export const EMPTY_ISH = {
  getAppVersion: async () => '2.1.10',
  getPreferences: async () => ({}),
  onEvent: () => () => {},
}

export interface FakeBridge { [k: string]: unknown }

export function installBridge(bridge: FakeBridge): FakeBridge {
  const value = { ...EMPTY_ISH, ...bridge }
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value })
  return value
}

export function removeBridge(_bridge?: FakeBridge): void {
  delete (window as unknown as Record<string, unknown>).orgtreeDesktop
}
