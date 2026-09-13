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

const FULL = [
  ['full-node', ['npm', 'test']],
  ['full-renderer', ['npm', 'run', 'test:renderer']],
]
const RELEASE = [
  ['source', ['node', '--test', 'tests/release-windows.test.mjs']],
  ['receipt', ['python', '-m', 'unittest', 'tests.test_work_evidence_receipts']],
]
const INSTALLER = [
  ['installer', ['node', '--test', 'tests/installer-elevation.test.mjs', 'tests/installer-upgrade.test.mjs']],
  ['release', ['node', '--test', 'tests/release-windows.test.mjs']],
]

const RELEASE_PATHS = [
  /^tools\/release-windows\.mjs$/,
  /^tools\/release-verification\.mjs$/,
  /^tools\/verification-receipt\.py$/,
  /^engine\/backend\/orgtree\/workevidence\.py$/,
  /^tests\/release-windows\.test\.mjs$/,
  /^tests\/test_work_evidence_receipts\.py$/,
  /^docs\/windows-release\.md$/,
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

export function classifyReleaseChanges(files) {
  const changedFiles = normalizeFiles(files)
  if (!changedFiles.length) return { area: 'release', changedFiles, reason: 'no source changes were supplied; run the release safety profile' }
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

export function selectReleaseVerification(files) {
  const classification = classifyReleaseChanges(files)
  const checks = classification.area === 'full' ? FULL.map(([gate, command]) => ({ gate, command }))
    : (classification.area === 'installer' ? INSTALLER : RELEASE).map(([gate, command]) => ({ gate, command }))
  return {
    schema: RELEASE_VERIFICATION_SCHEMA,
    profile: RELEASE_VERIFICATION_PROFILE,
    area: classification.area,
    changedFiles: classification.changedFiles,
    reason: classification.reason,
    escalation: classification.area === 'full',
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

export function createVerificationReceipt({ plan, candidate, base = null, source, results, startedAt, finishedAt = new Date().toISOString() }) {
  if (!plan || plan.schema !== RELEASE_VERIFICATION_SCHEMA) throw new Error('receipt requires a release verification plan')
  const receipt = {
    schema: RELEASE_VERIFICATION_SCHEMA,
    profile: plan.profile,
    candidate: String(candidate || ''),
    base: base ? String(base) : null,
    area: plan.area,
    changedFiles: plan.changedFiles,
    sourceFingerprint: source,
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

export function reusableReceipt(receipt, { candidate, source, profile = RELEASE_VERIFICATION_PROFILE, commands } = {}) {
  if (!receipt || receipt.schema !== RELEASE_VERIFICATION_SCHEMA || receipt.profile !== profile) return false
  if (receipt.candidate !== candidate || receipt.sourceFingerprint !== source || receipt.green !== true) return false
  if (commands && JSON.stringify(receipt.commands) !== JSON.stringify(commands)) return false
  const fingerprint = receipt.fingerprint
  if (!fingerprint) return false
  const copy = { ...receipt }
  delete copy.fingerprint
  return fingerprint === digest(copy)
}

function gitFiles(root, base) {
  const args = base ? ['diff', '--name-only', `${base}...HEAD`] : ['diff', '--name-only', 'HEAD^', 'HEAD']
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean)
}

function gitCandidate(root, candidate) {
  if (candidate !== 'HEAD') return candidate
  return execFileSync('git', ['rev-parse', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

export function runVerification({ root = process.cwd(), files, base, candidate = 'HEAD', receiptPath, jsonOutput, runner = spawnSync, now = () => new Date().toISOString() } = {}) {
  const changedFiles = files || gitFiles(root, base)
  const plan = selectReleaseVerification(changedFiles)
  const source = sourceFingerprint(plan.changedFiles, { root })
  candidate = gitCandidate(root, candidate)
  if (receiptPath && fs.existsSync(receiptPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      if (reusableReceipt(previous, { candidate, source, commands: plan.checks.map(check => ({ gate: check.gate, command: check.command })) })) {
        const reused = { ...previous, reused: true, reusedAt: now() }
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
  const receipt = createVerificationReceipt({ plan, candidate, base, source, results, startedAt, finishedAt: now() })
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
  const plan = selectReleaseVerification(files.length ? files : gitFiles(root, base))
  if (argv.includes('--plan')) {
    console.log(JSON.stringify(plan, null, 2))
    return 0
  }
  console.log(`Selected ${plan.profile} (${plan.area}); ${plan.reason}`)
  const receipt = runVerification({ root, files: plan.changedFiles, base, candidate, receiptPath, jsonOutput })
  console.log(JSON.stringify(receipt, null, 2))
  return receipt.green ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main()
