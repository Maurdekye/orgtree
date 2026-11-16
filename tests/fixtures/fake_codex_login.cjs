// Test double for `codex login`, used only by tests/providerlogin.test.mjs
// (ported from fake_codex_login.py, 4.6.1).
//
// Unlike Claude's CLI, the real `codex login` takes NO stdin input at all: it
// waits for its own local redirect server, then exits on its own. This double
// mirrors exactly that: it never reads stdin, only prints a couple of lines
// and exits according to $FIXTURE_MODE.
//   success   prints the CLI's own "Starting local login server"/"Open this
//             link" lines, writes a fake auth.json to $FIXTURE_CODEX_HOME
//             (the `tokens` shape), exits 0.
//   hang      never exits on its own ("still waiting for the browser
//             redirect"), for cancel/timeout/repeated-start dedup.
//   no_write  exits 0 WITHOUT writing anything: the positive control for
//             "exit code alone is not proof".
//   crash     exits 2 immediately.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const mode = process.env.FIXTURE_MODE || 'success'
if (process.env.FIXTURE_PROFILE_PROBE) {
  const probe = {}
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) probe[key] = process.env[key] ?? null
  fs.writeFileSync(process.env.FIXTURE_PROFILE_PROBE, JSON.stringify(probe), 'utf8')
}

if (mode === 'crash') {
  fs.writeSync(2, 'fixture: simulated codex login crash\n')
  process.exit(2)
}

fs.writeSync(1, 'Starting local login server on http://127.0.0.1:1/\n')
fs.writeSync(1, '1. Open this link in your browser and sign in to your account\n')

if (mode === 'hang') {
  setTimeout(() => process.exit(0), 3600 * 1000)
} else if (mode === 'no_write') {
  process.exit(0)
} else {
  const home = process.env.FIXTURE_CODEX_HOME
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: 'a.b.c' } }), 'utf8')
  fs.writeSync(1, 'Successfully logged in.\n')
  process.exit(0)
}
