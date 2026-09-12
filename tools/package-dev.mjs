// The LOCAL DEVELOPMENT packaging path: `npm run package:dev`.
//
// Produces a Windows installer for an in-development build WITHOUT publishing
// anything — no GitHub release, no update feed — and with an identity fully
// separate from the published application: 'Orgtree Dev',
// com.maurdekye.orgtree.dev, its own install directory, shortcuts and
// uninstall entry, and (at runtime) its own data directory. Installing it can
// therefore never overwrite or impersonate a published Orgtree install, and
// both can run side by side. See docs/dev-builds.md, including how to return
// to a published build.
//
// Unlike the release preflight this does NOT require a clean committed tree:
// testing uncommitted work is the point. The tree state is recorded instead —
// the installed version string carries the commit and a '.dirty' marker.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { assertPackageInputsPresent } from './preflight-lib.mjs'
import { devBuildInfo, devPackagingConfig } from './dev-build.mjs'

assertPackageInputsPresent()
const info = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'))
const dev = devBuildInfo(info)
// The packed copy of dist/build-info.json (resources/build-info.json in the
// installed app) is what tells the running app it is the dev channel.
fs.writeFileSync('dist/build-info.json', JSON.stringify(dev, null, 2) + '\n')
const config = devPackagingConfig(JSON.parse(fs.readFileSync('package.json', 'utf8')).build, dev.version)
fs.mkdirSync('dist', { recursive: true })
fs.writeFileSync('dist/electron-builder-dev.json', JSON.stringify(config, null, 2) + '\n')
console.log(`Packaging development build ${dev.version}` + (dev.dirty ? ' (working tree has uncommitted changes)' : ''))

const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [cli, '--win', 'nsis', '--config', 'dist/electron-builder-dev.json', '--publish', 'never'],
  { stdio: 'inherit', windowsHide: true })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Development installer written to ${config.directories.output}/ — it is local-only and must never be uploaded to a release.`)
