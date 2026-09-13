/** The private command-line handoff used by the NSIS upgrade helper. */
export const INSTALLER_UPGRADE_ARG = '--installer-upgrade'

export function hasInstallerUpgradeRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === INSTALLER_UPGRADE_ARG)
}
