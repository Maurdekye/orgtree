// Runs inside the fake hosted CLI. Every subprocess is the rig engine adapter
// or a compiled offline fixture; no native Git/gh/config/store lookup is used.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const [engine, out, phase] = process.argv.slice(2)
const root = process.env.RIG_BROKER_FIXTURE
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const gh = process.env.PATH.split(path.delimiter).map(d => path.join(d, 'gh.exe')).find(p => fs.existsSync(p))
if (!root || !gh || !gh.includes('credential-adapters') || hash(gh) !== hash(engine) ||
    path.resolve(process.env.ORGTREE_REAL_GH || '') !== path.join(root, 'bin', 'gh.exe') ||
    process.env.GH_HOST !== 'rig-proof.example') throw Error('hosted child did not receive isolated bridge adapters')
const plan = [
  { exe: gh, args: ['auth', 'status', '--hostname', 'rig-proof.example'] },
  ...['rig-proof.example', 'rig-failure.example'].map(host => ({ exe: engine, args: ['credential-helper', 'get'], stdin: 'protocol=https\nhost=' + host + '\n\n' })),
  { exe: engine, args: ['credential-helper', 'get'], invalidCapability: true },
]
// Persist only non-secret planned arguments before the first subprocess.
fs.writeFileSync(path.join(out, phase + '-commands.json'), JSON.stringify({ plan, nativeGh: process.env.ORGTREE_REAL_GH, home: process.env.HOME }, null, 2))
const run = (entry, input) => {
  const r = spawnSync(entry.exe, entry.args, {
    env: entry.invalidCapability ? { ...process.env, ORGTREE_CREDENTIAL_AUTH: 'synthetic-invalid-capability' } : process.env,
    input: input ?? entry.stdin, encoding: 'utf8', timeout: 20000, windowsHide: true,
  })
  if (r.error || r.signal) throw Error('synthetic child spawn failed')
  return { status: r.status, present: /^password=rig-proof-synthetic-token$/m.test(r.stdout), stderr: r.stderr,
    // gh fixture emits only a fixed success/fallback label, never the token.
    label: entry.exe === gh ? r.stdout.trim() : undefined }
}
const result = {
  capability: !!process.env.ORGTREE_CREDENTIAL_AUTH,
  gh: run(plan[0]),
  synthetic: run(plan[1]),
  failure: run(plan[2]),
  denied: run(plan[3], 'protocol=https\nhost=rig-proof.example\n\n'),
}
fs.writeFileSync(path.join(out, phase + '.json'), JSON.stringify(result, null, 2))
fs.writeFileSync(path.join(out, phase + '-done.txt'), 'done')
