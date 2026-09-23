/*
 * electron-builder afterPack hook: ad-hoc-signs every file electron-builder's
 * own signing pass never reaches — the bundled Python runtime under
 * Contents/Resources/engine/runtime, staged there by the `extraResources`
 * config in package.json rather than by electron-builder's packaged app
 * bundle. Without this, AMFI refuses to load those Mach-O binaries at
 * runtime even though the top-level .app itself is signed.
 *
 * The walk is scoped strictly to the resolved runtime directory under
 * appOutDir (both build-time constants from electron-builder's own context
 * object) and never accepts externally-influenced path input.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function walkFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const runtimeDir = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'engine',
    'runtime'
  )
  if (!fs.existsSync(runtimeDir)) return

  for (const file of walkFiles(runtimeDir, [])) {
    try {
      execFileSync('codesign', ['--force', '--sign', '-', file])
    } catch {
      // A stray non-Mach-O file (.py/.json/.txt) failing to sign must not
      // abort the rest of the runtime signing pass.
    }
  }
}
