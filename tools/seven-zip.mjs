/*
 * Read-only access to a built NSIS installer's payload through the dependency
 * tree's own 7-Zip. Shared by the release command (tools/release-windows.mjs)
 * and the private-alpha packager (tools/private-alpha.mjs), so both inspect
 * the bytes a user's machine receives without ever running the installer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export class SevenZipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SevenZipError'
  }
}

function fail(message) {
  throw new SevenZipError(message)
}

function requireFile(file, label) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    fail(`Missing ${label}: ${file}`)
  }
  if (!stat.isFile()) fail(`${label} must be a regular file: ${file}`)
}

function requireDir(directory, label) {
  let stat
  try {
    stat = fs.lstatSync(directory)
  } catch {
    fail(`Missing ${label}: ${directory}`)
  }
  if (!stat.isDirectory()) fail(`${label} must be a directory: ${directory}`)
}

/** The dependency tree's own 7-Zip, which reads NSIS installers. Kept inside
 *  node_modules so the extraction check needs nothing from the host. */
export function bundledSevenZip(root) {
  const vendor = path.join(root, 'node_modules', 'electron-winstaller', 'vendor')
  const exe = path.join(vendor, process.arch === 'arm64' ? '7z-arm64.exe' : '7z-x64.exe')
  requireFile(exe, 'bundled 7-Zip')
  return exe
}

function runSevenZip(sevenZip, args, spawnSyncImpl) {
  const result = spawnSyncImpl(sevenZip, args, { encoding: 'utf8', windowsHide: true, timeout: 600000 })
  if (result.error) fail(`Could not start 7-Zip: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`7-Zip ${args[0]} failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 2000)}`)
  }
  return result
}

/**
 * Extract the built installer's OWN `resources/engine` — not win-unpacked,
 * the bytes a user's machine would receive — into `workDir`.
 *
 * Two hops, both read-only on the installer: the NSIS container yields
 * `$PLUGINSDIR/app-64.7z`, and that archive yields `resources/engine/**`.
 * The installer is never executed.
 */
export function extractInstallerEngine({ root, installer, workDir, spawnSyncImpl = spawnSync }) {
  requireFile(installer, 'Windows installer')
  const sevenZip = bundledSevenZip(root)
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })
  const containerDir = path.join(workDir, 'nsis')
  runSevenZip(sevenZip, ['x', '-y', `-o${containerDir}`, installer, '$PLUGINSDIR/app-64.7z'], spawnSyncImpl)
  const appArchive = path.join(containerDir, '$PLUGINSDIR', 'app-64.7z')
  requireFile(appArchive, 'installer payload app-64.7z')
  const payloadDir = path.join(workDir, 'payload')
  runSevenZip(sevenZip, ['x', '-y', `-o${payloadDir}`, appArchive, 'resources/engine/*'], spawnSyncImpl)
  const engine = path.join(payloadDir, 'resources', 'engine')
  requireDir(engine, 'extracted payload resources/engine')
  return { engine, payloadDir }
}
