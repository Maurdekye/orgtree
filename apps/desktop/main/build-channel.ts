import fs from 'node:fs'

/** The published application's identity. The uninstall registry GUID, the
 *  AppUserModelID and the userData directory all derive from these values, so
 *  the development channel must differ in EVERY one of them: sharing any
 *  single value is what would let a locally built install collide with or
 *  impersonate the installed release. */
export const RELEASE_APP_ID = 'com.maurdekye.orgtree'
export const DEV_APP_ID = 'com.maurdekye.orgtree.dev'

export type BuildChannel = 'release' | 'dev'

/** The packaged build's channel, read from the build-info.json that packaging
 *  places beside the app (resources/build-info.json). Published artifacts
 *  predate the field, so only an explicit 'dev' is the development channel —
 *  a missing file, unreadable JSON or absent field is the release channel.
 *  Failing toward 'dev' instead would flip an installed release onto the dev
 *  identity (fresh empty data directory, updater off) over a corrupt file. */
export function readBuildChannel(file: string, io: Pick<typeof fs, 'readFileSync'> = fs): BuildChannel {
  try {
    const parsed: unknown = JSON.parse(io.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).channel === 'dev' ? 'dev' : 'release'
  } catch { return 'release' }
}

export interface DesktopIdentity {
  /** What electron-builder derived the uninstall registry key from. */
  appId: string
  /** app.setName — the userData directory and the single-instance lock. */
  name: string
  appUserModelId: string
  /** Explorer's relaunch name for taskbar pins. */
  displayName: string
  /** electron-updater is wired only here: a dev build ships no update feed at
   *  all, and unpackaged development never had one. Everything update-shaped
   *  in the main process gates on this rather than on app.isPackaged. */
  updatesSupported: boolean
}

/** One place deciding who this process is. A packaged dev-channel build is a
 *  THIRD identity, distinct from both the installed release and unpackaged
 *  development: its own data directory ('Orgtree v2 Dev'), its own shell
 *  identity, and normally no updater. Unpackaged keeps today's values exactly.
 *
 *  ⚠ `updateFixtureComposed` EXISTS TO CLOSE A COMPOSITION GAP, and the gap was
 *  found by review rather than reasoned about in advance. The harmless update
 *  fixture is meant to let the IN-APP upgrade entry be rehearsed privately, but
 *  every identity that could run it was excluded: unpackaged and packaged-dev
 *  builds have no updater at all, the only identity with one is packaged
 *  release, and release packaging correctly refuses a build composed with the
 *  fixture. The mechanism was therefore unreachable a second time, one level up
 *  from the first.
 *
 *  So a build composed WITH the fixture keeps the DEV identity in every other
 *  respect — its own appId and uninstall key, its own data directory, its own
 *  shell identity — and gains only the updater wiring. It cannot impersonate
 *  the installed release, cannot share its data, and cannot probe its install
 *  scope, which is what the dev identity was protecting in the first place.
 *  What it gains is the ability to reach its own Update path and hand off to
 *  the fixture instead of to a downloaded installer.
 *
 *  ⚠ THIS DOES NOT BY ITSELF PRODUCE AN UPDATE OFFER. Enabling the wiring makes
 *  the entry EXIST; something still has to answer "an update is available"
 *  before the button appears, and that remains the open feed question. This
 *  closes the composition half of it and no more. */
export function desktopIdentity(
  packaged: boolean, channel: BuildChannel, updateFixtureComposed = false): DesktopIdentity {
  const dev = packaged && channel === 'dev'
  return {
    appId: dev ? DEV_APP_ID : RELEASE_APP_ID,
    name: dev ? 'Orgtree v2 Dev' : 'Orgtree v2',
    appUserModelId: packaged && !dev ? RELEASE_APP_ID : DEV_APP_ID,
    displayName: dev ? 'Orgtree Dev' : 'Orgtree',
    updatesSupported: packaged && (!dev || updateFixtureComposed),
  }
}
