// Where the root tests find the small native executables they drive, now that
// no test reaches Win32 through Python (4.6.1 phase 2).
//
//   orgtree-installer-relaunch.exe  the shipped post-Setup relaunch helper,
//                                   engine/rs/orgtree-installer-relaunch
//   orgtree-test-native.exe         TEST-ONLY helpers, tools/test-native
//                                   (never packaged)
//
// Each is found by an explicit environment variable first, then in the cargo
// target directory its build would use (CARGO_TARGET_DIR when set). Nothing is
// built here: building is heavy work that needs a build-slot permit.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

function firstExisting(candidates) {
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) ?? null
}

function targets(defaultTarget) {
  const target = process.env.CARGO_TARGET_DIR || defaultTarget
  return [path.join(target, 'debug'), path.join(target, 'release')]
}

export function relaunchHelperPath() {
  return firstExisting([
    process.env.ORGTREE_RELAUNCH_HELPER,
    ...targets(path.join(root, 'engine', 'rs', 'target')).map(dir => path.join(dir, 'orgtree-installer-relaunch.exe')),
  ])
}

export function testNativePath() {
  return firstExisting([
    process.env.ORGTREE_TEST_NATIVE,
    ...targets(path.join(root, 'tools', 'test-native', 'target')).map(dir => path.join(dir, 'orgtree-test-native.exe')),
  ])
}

export const RELAUNCH_HELPER_MISSING = 'orgtree-installer-relaunch.exe is not built: run `cargo build -p orgtree-installer-relaunch` in engine/rs (under a build-slot permit), or set ORGTREE_RELAUNCH_HELPER'
export const TEST_NATIVE_MISSING = 'orgtree-test-native.exe is not built: run `cargo build --manifest-path tools/test-native/Cargo.toml` (under a build-slot permit), or set ORGTREE_TEST_NATIVE'

// For tests that cannot run at all without the test helpers. They FAIL with
// this message rather than skip: these cases ran on every machine while they
// used Python, so a missing helper is a setup error, not an environment limit.
export function requireTestNative() {
  const found = testNativePath()
  if (!found) throw new Error(TEST_NATIVE_MISSING)
  return found
}
