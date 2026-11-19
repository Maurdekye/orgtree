// The agents image reads GitHub's SSH host keys from https://api.github.com/meta while
// it is built. Without a token that request is counted against the runner's address, and
// GitHub answers 403 once the address is over its limit: a release run failed that way on
// 2026-11-19 (run 44482893173, job standalone-agents) and passed on a re-run. The build
// must send the workflow's token as a BuildKit secret (never a build argument or ENV: those
// stay in the image's history) and still work without one, as on a developer's machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = file => fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8').replace(/\r/g, '')
const dockerfile = read('standalone/agents/Dockerfile')
const workflow = read('.github/workflows/build-standalone-agents.yml')
// one instruction per entry: whole-line comments dropped (Docker drops them inside a
// continued instruction too), then continuation lines joined
const instructions = dockerfile.split('\n').filter(line => !/^\s*#/.test(line)).join('\n').replace(/\\\n/g, ' ').split('\n').filter(line => /^[A-Z]+ /.test(line))
const fetching = instructions.filter(line => line.includes('https://api.github.com/meta'))

test('the host-key fetch reads its token from an optional BuildKit secret', () => {
  assert.equal(fetching.length, 1, 'one instruction fetches api.github.com/meta')
  const [run] = fetching
  const mount = /^RUN --mount=type=secret,id=([a-z_]+)(,[^ ]*)? /.exec(run)
  assert.ok(mount, 'the RUN that fetches mounts a secret')
  assert.doesNotMatch(mount[2] ?? '', /required(=true)?(,|$)/, 'the secret is optional: a build without it still works')
  const file = `/run/secrets/${mount[1]}`
  // curl reads the header from the file itself, so the token is never an argument (set -x prints arguments)
  const curl = /curl ([^|]*)https:\/\/api\.github\.com\/meta/.exec(run)?.[1] ?? ''
  assert.ok(run.includes(`-H @${file}`) || run.includes(`-H @$`), 'curl takes the header from the secret file (-H @file)')
  assert.ok(run.includes(`[ -s ${file} ]`) || run.includes(`[ -s "${file}" ]`) || /\[ -s "\$\w+" \]/.test(run), 'the header is used only when the secret is there')
  assert.match(curl, /--retry \d/, 'a failed request is tried again')
  assert.doesNotMatch(run, /cat \/run\/secrets|\$\(<\s*\/run\/secrets/, 'the token is never expanded into the command line')
})

test('the RUN that can read the secret does nothing but fetch the keys', () => {
  // A mounted secret is readable by everything the instruction runs. apt runs package
  // scripts and npm runs lifecycle scripts, so none of that may share the instruction.
  const mounted = instructions.filter(line => line.includes('--mount=type=secret'))
  assert.equal(mounted.length, 1, 'one instruction mounts a secret')
  assert.equal(mounted[0], fetching[0], 'and it is the one that fetches')
  const body = mounted[0].replace(/^RUN --mount=\S+ /, '')
  assert.doesNotMatch(body, /\b(apt|apt-get|dpkg|npm|npx|pip|pip3|yarn|pnpm|corepack|make|sh|bash|install)\b/, 'no package manager, installer or shell script in it')
  // every command in it, by its first word: set, an assignment, curl | python3, test
  const commands = body.replace(/'[^']*'/g, "''").split(/;|\|/).map(part => part.trim().split(/\s+/)[0]).filter(Boolean)
  assert.deepEqual([...new Set(commands)].sort(), ['auth=/run/secrets/github_api_header', 'curl', 'python3', 'set', 'test'])
  // it comes after the installs: nothing installed later can have been swapped in before it
  const at = instructions.indexOf(mounted[0])
  const installs = instructions.map((line, index) => /\b(apt-get install|npm (install|ci))\b/.test(line) ? index : -1).filter(index => index >= 0)
  assert.ok(installs.length > 0 && installs.every(index => index < at), 'every apt and npm install is in an earlier instruction')
})

test('no token reaches the image through a build argument or ENV', () => {
  for (const line of instructions.filter(line => /^(ARG|ENV) /.test(line))) assert.doesNotMatch(line, /TOKEN|AUTHORI[SZ]ATION|GITHUB_API/i, line)
})

test('the workflow hands the build its own token as that secret', () => {
  const id = /--mount=type=secret,id=([a-z_]+)/.exec(dockerfile)?.[1]
  assert.ok(id, 'the Dockerfile names a secret')
  const env = new RegExp(`--secret id=${id},env=([A-Z_]+)`).exec(workflow)?.[1]
  assert.ok(env, `docker buildx build is given --secret id=${id},env=<VAR>`)
  assert.match(workflow, new RegExp(`\\n\\s+${env}: 'Authorization: Bearer \\$\\{\\{ github\\.token \\}\\}'\\n`), `${env} is the Authorization header with the workflow's token`)
  assert.doesNotMatch(workflow, /--build-arg [A-Z_]*TOKEN/, 'never a build argument')
})
