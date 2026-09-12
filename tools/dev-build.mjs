/** Pure decisions for the LOCAL DEVELOPMENT packaging channel: what a dev
 *  build is called, how it is versioned, and how its electron-builder config
 *  differs from the release one. Everything here is deliberately free of I/O
 *  so the regression tests can hold the channel-separation invariants —
 *  distinct appId, product name, output directory, no publish configuration —
 *  against the real release config without packaging anything. */

export const DEV_APP_ID = 'com.maurdekye.orgtree.dev'
export const DEV_PRODUCT_NAME = 'Orgtree Dev'
export const DEV_OUTPUT_DIR = 'release-dev'
export const DEV_NSIS_INCLUDE = 'build/installer-dev.nsh'

/** The version a development build installs and reports as, e.g.
 *  `2.0.9-dev.gab12cd34ef` or `...dirty`. The commit is embedded so the
 *  installed build names its exact source; the `g` prefix keeps the identifier
 *  alphanumeric — a bare hex short hash can be all digits with a leading zero,
 *  which is not a valid semver prerelease identifier. */
export function devVersion(base, commit, dirty) {
  if (typeof base !== 'string' || !/^\d+\.\d+\.\d+$/.test(base)) {
    throw new Error('Development versioning expects a plain x.y.z base version, got: ' + base)
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new Error('A development build needs a git commit to identify its source. Build from a git checkout.')
  }
  return `${base}-dev.g${commit.slice(0, 10)}${dirty ? '.dirty' : ''}`
}

/** Rewrites a fresh release-channel build-info as the development channel.
 *  The commit/dirty provenance the build recorded is kept as it stands; only
 *  the channel and the reported version change. */
export function devBuildInfo(info) {
  return { ...info, channel: 'dev', version: devVersion(info.version, info.commit, info.dirty) }
}

/** The development electron-builder config, derived from the release `build`
 *  section of package.json so packaging behavior (files, extraResources, NSIS
 *  settings) cannot drift between the channels. Every identity the installed
 *  release owns is CHANGED, and the change is asserted rather than assumed:
 *  sharing any one of appId (uninstall registry key), product name (install
 *  directory, shortcuts), or output directory is what would let a local build
 *  overwrite or impersonate the published artifact. */
export function devPackagingConfig(build, version) {
  if (!build || typeof build !== 'object') throw new Error('package.json has no build configuration')
  const config = structuredClone(build)
  config.appId = DEV_APP_ID
  config.productName = DEV_PRODUCT_NAME
  config.directories = { ...config.directories, output: DEV_OUTPUT_DIR }
  config.nsis = { ...config.nsis, shortcutName: DEV_PRODUCT_NAME, menuCategory: DEV_PRODUCT_NAME, include: DEV_NSIS_INCLUDE }
  // No publish configuration at all: nothing to upload, and electron-builder
  // then writes no app-update.yml either, so the packaged app has no update
  // feed to even point at.
  delete config.publish
  if (config.win) delete config.win.publish
  // electron-builder stamps this version into the packed package.json, so the
  // running app reports it via app.getVersion().
  config.extraMetadata = { ...config.extraMetadata, version }
  const overlaps = [
    [config.appId === build.appId, 'appId'],
    [config.productName === (build.productName ?? ''), 'productName'],
    [(config.directories?.output ?? '') === (build.directories?.output ?? ''), 'output directory'],
    [(config.nsis?.include ?? '') === (build.nsis?.include ?? ''), 'NSIS include'],
  ].filter(([overlap]) => overlap).map(([, name]) => name)
  if (overlaps.length) throw new Error('Development packaging must not share release identity: ' + overlaps.join(', '))
  if (!version.includes('-dev.')) throw new Error('Development packaging requires a -dev. prerelease version, got: ' + version)
  return config
}
