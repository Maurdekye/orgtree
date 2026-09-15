import fs from 'node:fs'

/** The published application's identity. The uninstall registry GUID, the
 *  AppUserModelID and the userData directory all derive from these values, so
 *  the development channel must differ in EVERY one of them: sharing any
 *  single value is what would let a locally built install collide with or
 *  impersonate the installed release. */
export const RELEASE_APP_ID = 'com.maurdekye.orgtree'
export const DEV_APP_ID = 'com.maurdekye.orgtree.dev'

export type BuildChannel = 'release' | 'dev'

/** ⚠ THE PRERELEASE LABEL IS A CHANNEL NAME, NOT DECORATION, and getting it
 *  wrong is what stranded 2.1.5-RC3.
 *
 *  electron-updater's GitHub provider derives a channel from the FIRST
 *  dot-separated component of the version's prerelease label, and will only
 *  accept a release whose own label matches. `2.1.5-RC3` has the single
 *  component `RC3`, so its channel is literally "RC3" — and the only release
 *  that ever matches "RC3" is 2.1.5-RC3 itself. Measured: such a build is
 *  offered ITSELF, finds that is not newer, and never updates again. It could
 *  see neither 2.1.5-RC4 (channel "RC4") nor stable 2.1.5 (no channel).
 *
 *  The library treats exactly two channel names as a prerelease LINE that also
 *  moves up to stable: `alpha` and `beta`. A build labelled `2.1.5-beta.4`
 *  therefore receives newer betas AND takes stable 2.1.5 when it appears. Any
 *  other label — `RC3`, and equally a tidy-looking `rc.4` — is a private
 *  channel that can only ever see its own line. */
export const PRERELEASE_CHANNELS = ['alpha', 'beta'] as const

/** The channel a version belongs to: its first prerelease component, or null
 *  for a stable release. This is the same rule electron-builder uses to name
 *  the update manifest it publishes, which is why both sides agree. */
export function updateChannelOf(version: string): string | null {
  const label = /^\d+\.\d+\.\d+-(.+)$/.exec(String(version ?? '').trim())?.[1]
  return label ? label.split('.')[0] : null
}

/** ⚠ WHETHER AN INSTALLED BUILD ACCEPTS A PRERELEASE — exported, rather than
 *  written as a literal at the call site, because it decides which release
 *  every installation is offered and a test can only drive the real updater
 *  with it if it can import it.
 *
 *  A prerelease build tracks its own line and can move up to stable. A stable
 *  build takes stable releases only, and is never offered a prerelease.
 *
 *  This mirrors electron-updater's own constructor default deliberately rather
 *  than relying on it: the previous code overrode it to `true` for EVERY build,
 *  which is what would have offered a release candidate to stable
 *  installations. Saying it out loud is what stops that returning. */
export function allowPrereleaseUpdates(version: string): boolean {
  return updateChannelOf(version) !== null
}

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
