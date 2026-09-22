// Shared by the private packager and every public release entry point.
export const PRIVATE_ALPHA_VERSION = '3.0.0-alpha.0'
export const PRIVATE_ALPHA_CHANNEL = 'private-alpha'
export const PRIVATE_ALPHA_APP_ID = 'com.maurdekye.orgtree.private-alpha'
export const PRIVATE_ALPHA_PRODUCT = 'Orgtree Private Alpha'
export const PRIVATE_ALPHA_OUTPUT = 'release-private-alpha'
export const PRIVATE_ALPHA_INSTALLER = `Orgtree-Private-Setup-${PRIVATE_ALPHA_VERSION}.exe`
export const PRIVATE_ALPHA_MARKER = 'ORGTREE-PRIVATE-ALPHA-BUILD:enabled'

export function assertPublicReleaseAllowed(version, info = {}) {
  if (version === PRIVATE_ALPHA_VERSION || info?.version === PRIVATE_ALPHA_VERSION
      || info?.channel === PRIVATE_ALPHA_CHANNEL) {
    throw new Error(`${PRIVATE_ALPHA_VERSION} is private-only; use package:private-alpha. Public tags, releases and updater assets are forbidden.`)
  }
}

export function privateAlphaConfig(build) {
  if (!build || typeof build !== 'object') throw new Error('Missing build configuration')
  const config = structuredClone(build)
  config.extends = null
  config.appId = PRIVATE_ALPHA_APP_ID
  config.productName = PRIVATE_ALPHA_PRODUCT
  config.directories = { ...config.directories, output: PRIVATE_ALPHA_OUTPUT }
  config.artifactName = PRIVATE_ALPHA_INSTALLER
  // null is intentional: omission allows electron-builder to infer a provider
  // from GH_TOKEN/GITHUB_TOKEN, even with --publish never.
  config.publish = null
  config.win = { ...config.win, target: ['nsis'], publish: null }
  config.nsis = { ...config.nsis, publish: null, artifactName: PRIVATE_ALPHA_INSTALLER,
    include: 'build/installer-dev.nsh', perMachine: false, runAfterFinish: false,
    shortcutName: PRIVATE_ALPHA_PRODUCT, menuCategory: PRIVATE_ALPHA_PRODUCT }
  config.extraMetadata = { ...config.extraMetadata, version: PRIVATE_ALPHA_VERSION }
  config.generateUpdatesFilesForAllChannels = false
  config.npmRebuild = false
  return config
}
