import fs from 'node:fs'
import crypto from 'node:crypto'
import { assertPublicReleaseAllowed, PRIVATE_ALPHA_MARKER } from './private-alpha-policy.mjs'

/** Everything a packaged build cannot function without. Shared by the release
 *  preflight and the development packaging path: an installer of either channel
 *  with a missing engine or runtime installs an app that cannot start. */
export const REQUIRED_PACKAGE_INPUTS = ['engine/launch.py', 'engine/backend/orgtree/api.py', 'engine/runtime/python.exe', 'engine/runtime/python313.zip', 'engine/runtime/runtime-manifest.json', 'dist/renderer/index.html']

export function assertPackageInputsPresent(io = fs) {
  for (const file of REQUIRED_PACKAGE_INPUTS) {
    if (!io.existsSync(file)) throw new Error('Package is incomplete: ' + file + '. Provision the runtime and integrate the real engine first.')
  }
}

/** The release channel's provenance rules: a clean committed tree matching the
 *  build, and a build-info that says it was produced FOR release. The channel
 *  check is what keeps a development build out of the publishing path — its
 *  build-info says 'dev', so packaging it as a release refuses here even when
 *  someone bypasses `npm run package:win` and runs electron-builder by hand. */
/** A RELEASE MUST NOT BE ABLE TO SUBSTITUTE A FIXTURE INSTALLER, so a build
 *  composed with the update fixture never reaches packaging.
 *
 *  Both halves are checked, because they fail in opposite directions. The
 *  build-info disclosure is easy to read and easy to DELETE — it is a field in a
 *  JSON file. The sentinel is in the bundle that actually runs, so it is the
 *  authoritative one, and removing it means editing dist/main/index.cjs, whose
 *  sha256 this same build-info records and assertReleaseProvenance verifies
 *  below. Checking only the disclosure would be the same mistake the runtime
 *  guard already rejected: trusting mutable metadata to describe an executable.
 *
 *  This is defence in depth rather than the guard itself. The guard is that a
 *  published build has the substitution compiled OUT and cannot perform one at
 *  all; this exists so WE cannot publish a fixture build by accident. */
export function assertNoUpdateFixture(info, bundle = 'dist/main/index.cjs', io = fs) {
  assertPublicReleaseAllowed(info.version, info)
  if (info.updateFixture !== undefined) {
    throw new Error('Release packaging refuses a build that discloses the update '
      + 'fixture: rebuild with `npm run build` (without --update-fixture) before packaging a release')
  }
  if (io.readFileSync(bundle, 'utf8').includes(PRIVATE_ALPHA_MARKER)) {
    throw new Error('Release packaging refuses a compiled private-alpha build')
  }
  if (io.readFileSync(bundle, 'utf8').includes('ORGTREE-UPDATE-FIXTURE-BUILD' + ':enabled')) {
    throw new Error('Release packaging refuses ' + bundle + ': the update-fixture '
      + 'substitution is compiled into it. Rebuild with `npm run build` before packaging a release')
  }
}

/** The pinned orgtree-mailhub submodule must be PRESENT, CLEAN, and exactly
 *  what the build recorded — packaging must never fetch, guess, or silently
 *  ship a different hub than the reviewed pin (mail-hub ticket). `status`
 *  is `git submodule status -- engine/mailhub` output; `head` is the
 *  submodule checkout's actual HEAD. */
export function assertMailhubSubmodule(info, status, head, io = fs) {
  for (const probe of ['engine/mailhub/mailhub/app.py', 'engine/mailhub/mailhub/serve.py', 'engine/mailhub/hubtool.py']) {
    if (!io.existsSync(probe)) {
      throw new Error('Packaging refuses an absent or uninitialized orgtree-mailhub submodule ('
        + probe + ' is missing). Run: git submodule update --init')
    }
  }
  const marker = String(status)[0]
  if (marker !== ' ') {
    throw new Error('Packaging refuses the orgtree-mailhub submodule in state "' + marker
      + '": " " (clean, at the recorded pin) is required. "-" = uninitialized, "+" = checked out '
      + 'at a DIFFERENT commit than the pin — adopting a new hub revision is its own reviewed commit')
  }
  if (!info.mailhubCommit || info.mailhubCommit !== head) {
    throw new Error('Packaging requires build-info to record the exact orgtree-mailhub revision it '
      + 'packaged (recorded: ' + info.mailhubCommit + ', checkout: ' + head + '). Rebuild with `npm run build`')
  }
}

export function assertReleaseProvenance(info, head, porcelain, io = fs) {
  assertPublicReleaseAllowed(info.version, info)
  if (info.channel !== 'release') throw new Error('Release packaging refuses build channel "' + info.channel + '": rebuild with `npm run build` before packaging a release')
  if (!info.commit || info.dirty !== false || info.commit !== head || porcelain.trim()) {
    throw new Error('Release packaging requires a clean committed source tree matching the build')
  }
  for (const [file, expected] of Object.entries(info.sha256)) {
    if (crypto.createHash('sha256').update(io.readFileSync(file)).digest('hex') !== expected) throw new Error('Build input changed: ' + file)
  }
}
