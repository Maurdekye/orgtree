/*
 * Bounded, change-aware Windows release verification.
 *
 * The selector is deliberately data-only: callers can print the plan before
 * running it, and receipts can be checked without executing a suite again.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const RELEASE_VERIFICATION_SCHEMA = 'orgtree.windows-release-verification/v1'
export const RELEASE_VERIFICATION_PROFILE = 'focused-release-v1'

// ⚠ NEITHER of these may be a raw `npm test` / `npm run test:renderer`.
//
// A raw suite runner has no concept of a test that was ALREADY failing, so one
// unowned failure anywhere in 638 tests blocked release verification for every
// commit touching a path the focused profiles do not name — and the agent it
// blocked had no way to tell that the block had nothing to do with its change.
// That is the same defect as the bare-`python` receipt gate below: a check
// reporting on something other than what it claims.
//
// `compare` runs the same suite and then splits NEW failures from pre-existing
// ones against docs/test-baseline.json, exiting 0 only when the run introduced
// none. So a known failure is acquitted BY NAME and a regression still blocks.
//
// ⚠ ONE GATE PER SUITE, and never a bare `compare`. A bare `compare` runs all
// three registered suites, and `python-backend` alone takes 9.9 minutes
// (measured; recorded in the baseline's own duration_ms), which puts the single
// command past the 600s ceiling this harness kills a foreground command at —
// four agents lost a day to that. Split per suite it is 63s + 80s, measured
// 2026-09-17 on 5f3a172. Adding a third gate here without timing it first is how
// that ceiling comes back.
//
// The suites named here are exactly the two the raw commands ran: this changed
// how failures are CLASSIFIED, not what is covered. `python-backend` was never
// in the full profile and is not added.
const BASELINE_GATE = ['node', 'tools/test-baseline.mjs', 'compare']
// `--require-usable`, not `--require-fresh`: a release verification runs on a
// commit past the one the baseline was recorded at, by construction, so
// `--require-fresh` refuses every time. `--require-usable` still refuses a
// baseline from another machine, an unreachable commit, a dirty measurement or
// one carrying no timestamp — cases where the acquittals cannot be trusted.
const BASELINE_TRUST = ['--max-age-days', '7', '--require-usable']
const FULL = [
  ['full-node', [...BASELINE_GATE, '--suite', 'node-root', ...BASELINE_TRUST]],
  ['full-renderer', [...BASELINE_GATE, '--suite', 'renderer', ...BASELINE_TRUST]],
]
const RELEASE = [
  // `tests/release-verification.test.mjs` is in this list because the focused
  // profile used to verify everything about a release EXCEPT the verifier that
  // decides whether the release is verified. Changing this file classified as
  // `release`, and the `release` profile did not run this file's own tests — so
  // a change could break them and still be waved through green. That is exactly
  // how the bare-`python` fix below reached `main` with a passing gate.
  // `tests/test-baseline.test.mjs` joined this list when the full profile above
  // started running `tools/test-baseline.mjs`: that tool now decides whether a
  // release is verified, so it is release tooling, and the lesson of `ed152e5`
  // is that release tooling whose own tests are not in this gate can break them
  // and still be waved through green.
  ['source', ['node', '--test', 'tests/release-windows.test.mjs', 'tests/runtime-layout.test.mjs', 'tests/release-verification.test.mjs', 'tests/test-baseline.test.mjs']],
  // ⚠ NEVER run this gate as a bare `python -m unittest`. Orgtree spawns an
  // agent CLI with PYTHONPATH prepended by its own installed backend so the
  // child can import it, so a bare `python` resolves `import orgtree` to
  // C:\Program Files\Orgtree\resources\engine\backend — the SHIPPED build,
  // ahead of the checkout. This gate was that bare invocation, which means it
  // verified the installed app instead of the release candidate for as long as
  // it existed, and reported green for doing it. The runner launches modules
  // with -I (isolated mode ignores PYTHONPATH) and selects the bundled
  // engine/runtime/python.exe, so it measures the tree being released.
  // Exit status is unchanged: 0 iff the module passed.
  ['receipt', ['python', 'tools/run-python-verification.py', 'tests/test_work_evidence_receipts.py']],
]
const INSTALLER = [
  ['installer', ['node', '--test', 'tests/installer-elevation.test.mjs', 'tests/installer-upgrade.test.mjs']],
  ['release', ['node', '--test', 'tests/release-windows.test.mjs', 'tests/runtime-layout.test.mjs']],
]

const VERSION_PATHS = new Set(['package.json', 'package-lock.json'])
const RELEASE_NOTES_PATH = /^docs\/release-notes-[^/]+\.md$/
const RELEASE_PATHS = [
  /^tools\/release-windows\.mjs$/,
  /^tools\/release-verification\.mjs$/,
  /^tools\/runtime-layout\.mjs$/,
  /^tools\/stage-runtime\.mjs$/,
  /^tools\/verification-receipt\.py$/,
  // Release tooling since the full profile started running it. Note what is
  // deliberately ABSENT: `docs/test-baseline.json`, the acquittal list itself.
  // Editing that decides which failures the gate forgives, so it stays
  // unclassified and escalates to `full` — the fail-safe, applied to the one
  // file that could otherwise be used to wave a failure through.
  /^tools\/test-baseline\.mjs$/,
  /^tests\/test-baseline\.test\.mjs$/,
  /^engine\/backend\/orgtree\/workevidence\.py$/,
  /^tests\/release-windows\.test\.mjs$/,
  /^tests\/runtime-layout\.test\.mjs$/,
  /^tests\/release-verification\.test\.mjs$/,
  /^tests\/test_work_evidence_receipts\.py$/,
  /^docs\/windows-release\.md$/,
  RELEASE_NOTES_PATH,
]
const INSTALLER_PATHS = [
  /^tools\/installer-/,
  /^tests\/installer-/,
  /^tests\/test-installer-/,
  /^build\/installer\.nsh$/,
]
const BROAD_PATHS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tools\/build\.mjs$/,
  /^tools\/package-/,
  /^apps\/desktop\//,
  /^engine\//,
]

function normalizeFiles(files) {
  return [...new Set((files || []).map(String).map(file => file.replaceAll('\\', '/').replace(/^\.\//, '')))].sort()
}

export function gitChangedFiles({ root = process.cwd(), base, candidate = 'HEAD', git = execFileSync } = {}) {
  const left = base || `${candidate}^`
  return git('git', ['diff', '--name-only', `${left}...${candidate}`], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).split(/\r?\n/).filter(Boolean).map(file => file.replaceAll('\\', '/')).sort()
}

function gitJson(root, ref, file, git = execFileSync) {
  return JSON.parse(git('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true }))
}

function withoutVersion(pathname, value) {
  const copy = JSON.parse(JSON.stringify(value))
  if (pathname === 'package.json') delete copy.version
  if (pathname === 'package-lock.json') {
    delete copy.version
    if (copy.packages?.['']) delete copy.packages[''].version
  }
  return copy
}

export function isVersionOnlyChange(files, { root, base, candidate = 'HEAD', git = execFileSync } = {}) {
  const changedFiles = normalizeFiles(files)
  const packageFiles = changedFiles.filter(file => VERSION_PATHS.has(file))
  const metadataFiles = changedFiles.filter(file => !VERSION_PATHS.has(file))
  if (!root || !base || !packageFiles.length || metadataFiles.some(file => !RELEASE_NOTES_PATH.test(file))) return false
  try {
    return packageFiles.every(file => JSON.stringify(withoutVersion(file, gitJson(root, base, file, git))) === JSON.stringify(withoutVersion(file, gitJson(root, candidate, file, git))))
  } catch { return false }
}

export function classifyReleaseChanges(files, options = {}) {
  const changedFiles = normalizeFiles(files)
  if (!changedFiles.length) return { area: 'release', changedFiles, reason: 'no source changes were supplied; run the release safety profile' }
  if (isVersionOnlyChange(changedFiles, options)) {
    return { area: 'release', changedFiles, versionOnly: true, reason: 'package version surfaces changed only in their authoritative version fields' }
  }
  if (changedFiles.some(file => BROAD_PATHS.some(pattern => pattern.test(file)))) {
    return { area: 'full', changedFiles, reason: 'application, engine, package, or build inputs changed; broad behavior may be affected' }
  }
  if (changedFiles.some(file => INSTALLER_PATHS.some(pattern => pattern.test(file)))) {
    return { area: 'installer', changedFiles, reason: 'installer or upgrade behavior changed; retain installer and release safety checks' }
  }
  if (changedFiles.every(file => RELEASE_PATHS.some(pattern => pattern.test(file)))) {
    return { area: 'release', changedFiles, reason: 'only release tooling, receipts, release fixtures, or release documentation changed' }
  }
  return { area: 'full', changedFiles, reason: 'a changed path has no authoritative focused profile; escalate to the full suite' }
}

export function selectReleaseVerification(files, options = {}) {
  const classification = classifyReleaseChanges(files, options)
  const checks = classification.area === 'full' ? FULL.map(([gate, command]) => ({ gate, command }))
    : (classification.area === 'installer' ? INSTALLER : RELEASE).map(([gate, command]) => ({ gate, command }))
  return {
    schema: RELEASE_VERIFICATION_SCHEMA,
    profile: RELEASE_VERIFICATION_PROFILE,
    area: classification.area,
    changedFiles: classification.changedFiles,
    reason: classification.reason,
    escalation: classification.area === 'full',
    versionOnly: classification.versionOnly === true,
    checks,
    gates: ['source', 'version', 'build', 'artifact', 'publication'].map(gate => ({
      gate,
      action: gate === 'source' ? (classification.area === 'full' ? 'full-suite' : 'focused-suite')
        : gate === 'version' ? 'validate-version-and-lockfile'
          : gate === 'build' ? 'validate-build-provenance'
            : gate === 'artifact' ? 'validate-canonical-artifacts'
              : 'validate-public-release',
      reuse: gate !== 'source',
    })),
  }
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export function sourceFingerprint(files, { root = process.cwd(), fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') } = {}) {
  const normalized = normalizeFiles(files)
  return digest(normalized.map(file => {
    try { return [file, fileHash(file)] }
    catch (error) { if (error?.code === 'ENOENT') return [file, '<missing>']; throw error }
  }))
}

export function testedSourceFiles(plan, { trackedFiles = [] } = {}) {
  if (!plan || plan.area === 'full') return []
  const patterns = plan.area === 'installer' ? [...RELEASE_PATHS, ...INSTALLER_PATHS] : RELEASE_PATHS
  return normalizeFiles(trackedFiles).filter(file => patterns.some(pattern => pattern.test(file)) && !VERSION_PATHS.has(file) && !RELEASE_NOTES_PATH.test(file))
}

export function testedSourceFingerprint(plan, options = {}) {
  const files = testedSourceFiles(plan, options)
  return { files, fingerprint: sourceFingerprint(files, options) }
}

export function createVerificationReceipt({ plan, candidate, base = null, source, sourceFiles = [], results, startedAt, finishedAt = new Date().toISOString() }) {
  if (!plan || plan.schema !== RELEASE_VERIFICATION_SCHEMA) throw new Error('receipt requires a release verification plan')
  const receipt = {
    schema: RELEASE_VERIFICATION_SCHEMA,
    profile: plan.profile,
    candidate: String(candidate || ''),
    base: base ? String(base) : null,
    area: plan.area,
    changedFiles: plan.changedFiles,
    sourceFingerprint: source,
    sourceFiles: [...sourceFiles],
    commands: plan.checks.map(check => ({ gate: check.gate, command: [...check.command] })),
    results: (results || []).map(result => ({ ...result })),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
  }
  receipt.green = receipt.results.length > 0 && receipt.results.every(result => result.status === 0 || result.reused === true)
  receipt.fingerprint = digest(receipt)
  return receipt
}

export function reusableReceipt(receipt, { candidate, source, sourceFiles, profile = RELEASE_VERIFICATION_PROFILE, commands, allowCandidateChange = false, baseCandidate } = {}) {
  if (!receipt || receipt.schema !== RELEASE_VERIFICATION_SCHEMA || receipt.profile !== profile) return false
  if (candidate && receipt.candidate !== candidate && (!allowCandidateChange || receipt.candidate !== baseCandidate)) return false
  if (receipt.sourceFingerprint !== source || receipt.green !== true) return false
  if (sourceFiles && JSON.stringify(receipt.sourceFiles) !== JSON.stringify(sourceFiles)) return false
  if (commands && JSON.stringify(receipt.commands) !== JSON.stringify(commands)) return false
  const fingerprint = receipt.fingerprint
  if (!fingerprint) return false
  const copy = { ...receipt }
  delete copy.fingerprint
  return fingerprint === digest(copy)
}

function gitCandidate(root, candidate, git = execFileSync) {
  if (candidate !== 'HEAD') return candidate
  return git('git', ['rev-parse', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

function gitCommit(root, ref, git = execFileSync) {
  const revision = ref.endsWith('^') ? ref : `${ref}^{commit}`
  return git('git', ['rev-parse', revision], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

export function resolveVerificationPlan({ root = process.cwd(), files, base, candidate = 'HEAD', git = execFileSync } = {}) {
  const resolvedCandidate = gitCandidate(root, candidate, git)
  const resolvedBase = gitCommit(root, base || `${resolvedCandidate}^`, git)
  const derivedFiles = gitChangedFiles({ root, base: resolvedBase, candidate: resolvedCandidate, git })
  const selectedFiles = files?.length ? normalizeFiles(files) : derivedFiles
  if (JSON.stringify(selectedFiles) !== JSON.stringify(derivedFiles)) throw new Error('explicit changed paths must exactly match the Git diff; omit the list to derive it safely')
  return {
    candidate: resolvedCandidate, base: resolvedBase,
    plan: selectReleaseVerification(selectedFiles, {
      root, base: resolvedBase, candidate: resolvedCandidate, git,
    }),
  }
}

export function runVerification({ root = process.cwd(), files, base, candidate = 'HEAD', receiptPath, jsonOutput, runner = spawnSync, git = execFileSync, now = () => new Date().toISOString() } = {}) {
  const { candidate: resolvedCandidate, base: resolvedBase, plan } = resolveVerificationPlan({ root, files, base, candidate, git })
  const trackedFiles = git('git', ['ls-files'], { cwd: root, encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean)
  const sourceScope = testedSourceFingerprint(plan, { root, trackedFiles })
  const source = sourceScope.fingerprint
  const scopeFiles = sourceScope.files
  if (receiptPath && fs.existsSync(receiptPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      if (reusableReceipt(previous, { candidate: resolvedCandidate, source, sourceFiles: scopeFiles,
        allowCandidateChange: plan.versionOnly, baseCandidate: resolvedBase,
        commands: plan.checks.map(check => ({ gate: check.gate, command: check.command })) })) {
        const reused = { ...previous, candidate: resolvedCandidate, base: resolvedBase,
          changedFiles: plan.changedFiles, reused: true, reusedFrom: previous.candidate, reusedAt: now() }
        delete reused.fingerprint
        reused.fingerprint = digest(reused)
        if (jsonOutput) fs.writeFileSync(jsonOutput, JSON.stringify(reused, null, 2) + '\n')
        return reused
      }
    } catch {
      // A partial receipt from an interrupted run is evidence of no verdict;
      // rerun the selected checks instead of failing before the safety gate.
    }
  }
  const startedAt = now()
  const results = []
  for (const check of plan.checks) {
    const started = Date.now()
    const command = process.platform === 'win32' && check.command[0] === 'npm'
      ? [process.execPath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...check.command.slice(1)]
      : check.command
    const result = runner(command[0], command.slice(1), {
      cwd: root, stdio: 'pipe', encoding: 'utf8', windowsHide: true,
    })
    results.push({ gate: check.gate, command, status: result.status ?? 1, durationMs: Date.now() - started,
      stdout: String(result.stdout || '').slice(-65536), stderr: String(result.stderr || '').slice(-65536) })
    if ((result.status ?? 1) !== 0) break
  }
  const receipt = createVerificationReceipt({ plan, candidate: resolvedCandidate, base: resolvedBase, source, sourceFiles: scopeFiles, results, startedAt, finishedAt: now() })
  if (receiptPath) fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  if (jsonOutput) fs.writeFileSync(jsonOutput, JSON.stringify(receipt, null, 2) + '\n')
  return receipt
}

export function main(argv = process.argv.slice(2)) {
  const root = process.cwd()
  let base
  let candidate = 'HEAD'
  let receiptPath
  let jsonOutput
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--plan') continue
    if (arg === '--base') base = argv[++index]
    else if (arg === '--candidate') candidate = argv[++index]
    else if (arg === '--receipt') receiptPath = argv[++index]
    else if (arg === '--json-output') jsonOutput = argv[++index]
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else files.push(arg)
  }
  const selected = resolveVerificationPlan({ root, files, base, candidate })
  const plan = selected.plan
  if (argv.includes('--plan')) {
    console.log(JSON.stringify(plan, null, 2))
    return 0
  }
  console.log(`Selected ${plan.profile} (${plan.area}); ${plan.reason}`)
  const receipt = runVerification({ root, files: plan.changedFiles, base: selected.base, candidate: selected.candidate, receiptPath, jsonOutput })
  console.log(JSON.stringify(receipt, null, 2))
  return receipt.green ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main()
