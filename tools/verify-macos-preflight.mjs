// Static pre-flight gate for the process-lifecycle blockers a real macOS
// agent turn depends on. No live process spawning: three source checks
// against files already read and cited in the Phase 5 plan, so this is
// runnable on any checkout regardless of Phase 1-4 status.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function checkProviderProcessTree(relativePath, { popenLabel, killLabel }) {
  const source = read(relativePath)
  const blockers = []
  if (!/start_new_session\s*=\s*\(?\s*os\.name\s*!=\s*['"]nt['"]/.test(source)) {
    blockers.push(`${relativePath}: ${popenLabel} does not pass start_new_session=(os.name != "nt")`)
  }
  if (!/os\.killpg\(/.test(source)) {
    blockers.push(`${relativePath}: ${killLabel} does not kill the POSIX process group via os.killpg(...)`)
  }
  return blockers
}

// 1. engine/backend/orgtree/codexrun.py — app-server Popen + process-tree kill.
const codexBlockers = checkProviderProcessTree('engine/backend/orgtree/codexrun.py', {
  popenLabel: 'the app-server subprocess.Popen(...) call', killLabel: 'close()',
})

// 2. engine/backend/orgtree/antigravityrun.py — launch() Popen + kill_tree().
const antigravityBlockers = checkProviderProcessTree('engine/backend/orgtree/antigravityrun.py', {
  popenLabel: 'launch()\'s subprocess.Popen(...) call', killLabel: 'kill_tree()',
})

// 3. engine/process_lifetime.py — arm_process_lifetime must not unconditionally
// raise for every non-Windows platform; a real POSIX branch must exist.
const lifetimeSource = read('engine/process_lifetime.py')
const lifetimeBlockers = []
const hardRaise = /raise\s+RuntimeError\(\s*["']process ownership is currently supported on Windows only/
if (hardRaise.test(lifetimeSource)) {
  lifetimeBlockers.push('engine/process_lifetime.py: arm_process_lifetime unconditionally raises RuntimeError for os.name != "nt" (PROC-03/Phase 2 owns this fix; unassigned as of this writing for the engine-cannot-boot case)')
} else if (!/if\s+os\.name\s*==\s*['"]nt['"]:/.test(lifetimeSource) || !/start_new_session\s*=\s*os\.name\s*!=\s*['"]nt['"]/.test(lifetimeSource)) {
  lifetimeBlockers.push('engine/process_lifetime.py: arm_process_lifetime has no real POSIX branch for guardian startup')
}

const blockers = [
  ...codexBlockers.map(reason => ({ owner: 'PROC-03/Phase 2', reason })),
  ...antigravityBlockers.map(reason => ({ owner: 'PROC-03/Phase 2', reason })),
  ...lifetimeBlockers.map(reason => ({ owner: 'unassigned as of this writing', reason })),
]

if (blockers.length) {
  console.log(JSON.stringify({ status: 'FAIL', blockers }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ status: 'PASS' }, null, 2))
  process.exitCode = 0
}
