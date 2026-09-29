// Shared by the private packager and every public release entry point.
export const PRIVATE_ALPHA_VERSION = '3.0.0-alpha.0'
export const PRIVATE_ALPHA_CHANNEL = 'private-alpha'
// The first v3 build REPLACES 2.1.12 (user decision 2026-09-28): it installs
// over it as the normal app. These are 2.1.12's own values (tag v2.1.12,
// package.json build), and the packager refuses a config that drifted from
// them, because a different appId is a different NSIS GUID, and so a second
// app beside 2.1.12 instead of an upgrade.
export const RELEASE_IDENTITY = Object.freeze({
  appId: 'com.maurdekye.orgtree', productName: 'Orgtree',
  nsis: Object.freeze({ perMachine: false, shortcutName: 'Orgtree', menuCategory: 'Orgtree',
    include: 'build/installer.nsh', createStartMenuShortcut: true, deleteAppDataOnUninstall: false,
    oneClick: false, allowToChangeInstallationDirectory: true }),
})
export const PRIVATE_ALPHA_OUTPUT = 'release-private-alpha'
export const PRIVATE_ALPHA_INSTALLER = `Orgtree-Setup-${PRIVATE_ALPHA_VERSION}.exe`
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
  const drift = [['appId', config.appId, RELEASE_IDENTITY.appId], ['productName', config.productName, RELEASE_IDENTITY.productName],
    ...Object.entries(RELEASE_IDENTITY.nsis).map(([k, v]) => [`nsis.${k}`, config.nsis?.[k], v])]
    .filter(([, got, want]) => got !== want)
  if (drift.length) throw new Error(`The 3.0.0-alpha.0 build must install over 2.1.12 with its identity; package.json build differs: ${drift.map(([k, got, want]) => `${k}=${JSON.stringify(got)} (want ${JSON.stringify(want)})`).join(', ')}`)
  config.extends = null
  config.directories = { ...config.directories, output: PRIVATE_ALPHA_OUTPUT }
  config.artifactName = PRIVATE_ALPHA_INSTALLER
  // null is intentional: omission allows electron-builder to infer a provider
  // from GH_TOKEN/GITHUB_TOKEN, even with --publish never.
  config.publish = null
  config.win = { ...config.win, target: ['nsis'], publish: null }
  // 2.1.12's NSIS settings as they are (stable installer.nsh: the in-place
  // upgrade, the all-users boot-engine task, shortcuts), INCLUDING its launch:
  // an accepted Upgrade starts Orgtree by itself once Setup closes, and a fresh
  // install keeps the ticked "Run Orgtree" box on the Finish page. Both launch
  // through StdUtils.ExecShellAsUser, which starts Orgtree as the signed-in
  // user rather than with the installer's elevation (PostgreSQL refuses to run
  // as an administrator). The user asked for this on 2026-09-29, after the
  // first v3 build (built with runAfterFinish: false) stopped on a Finish page
  // without starting Orgtree.
  // runAfterFinish is left as package.json has it (unset, like 2.1.12: the
  // default true), so HIDE_RUN_AFTER_FINISH is not defined.
  config.nsis = { ...config.nsis, publish: null, artifactName: PRIVATE_ALPHA_INSTALLER }
  config.extraMetadata = { ...config.extraMetadata, version: PRIVATE_ALPHA_VERSION }
  config.generateUpdatesFilesForAllChannels = false
  config.npmRebuild = false
  return config
}
