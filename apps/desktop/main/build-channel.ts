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
 *  identity, and no updater. Unpackaged keeps today's values exactly. */
export function desktopIdentity(packaged: boolean, channel: BuildChannel): DesktopIdentity {
  const dev = packaged && channel === 'dev'
  return {
    appId: dev ? DEV_APP_ID : RELEASE_APP_ID,
    name: dev ? 'Orgtree v2 Dev' : 'Orgtree v2',
    appUserModelId: packaged && !dev ? RELEASE_APP_ID : DEV_APP_ID,
    displayName: dev ? 'Orgtree Dev' : 'Orgtree',
    updatesSupported: packaged && !dev,
  }
}
