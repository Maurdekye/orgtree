// Test double for `claude auth login`, used only by tests/providerlogin.test.mjs
// (ported from fake_claude_auth_login.py, 4.6.1).
//
// Speaks the same stdout-prompt / stdin-code contract as the real CLI (a
// verification-code prompt with NO trailing newline, waited for on stdin) so
// providerlogin.ts's process/handshake logic can be exercised without ever
// starting a real login, opening a real browser or touching a real account.
//
// Mode is read from $FIXTURE_MODE:
//   success       prompts for a code, then (whatever was typed) writes a fake
//                 oauthAccount block to $FIXTURE_CONFIG_PATH and exits 0,
//                 exactly what a real successful `claude auth login` does to
//                 ~/.claude.json.
//   invalid_code  prompts for a code, then exits 1 without writing anything.
//   no_write      prompts for a code, then exits 0 WITHOUT writing anything:
//                 the positive control for "exit code alone is not proof".
//   crash         exits 2 immediately, before ever asking for a code.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const PROMPT = 'Paste code here if prompted > '
const mode = process.env.FIXTURE_MODE || 'success'
if (process.env.FIXTURE_PROFILE_PROBE) {
  const probe = {}
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) probe[key] = process.env[key] ?? null
  fs.writeFileSync(process.env.FIXTURE_PROFILE_PROBE, JSON.stringify(probe), 'utf8')
}

if (mode === 'crash') {
  fs.writeSync(2, 'fixture: simulated CLI crash before any prompt\n')
  process.exit(2)
}

fs.writeSync(1, `pid:${process.pid}\n`)
fs.writeSync(1, 'Visit https://example.invalid/authorize?state=fixture in your browser to continue.\n')
fs.writeSync(1, PROMPT)

// One line from stdin (or EOF); the code itself is deliberately never echoed.
let buffered = ''
let done = false
const finish = () => {
  if (done) return
  done = true
  process.stdin.pause()
  if (mode === 'invalid_code') {
    fs.writeSync(1, '\nAuthentication failed: Invalid authorization code\n')
    process.exit(1)
  }
  if (mode === 'no_write') process.exit(0)
  const configPath = process.env.FIXTURE_CONFIG_PATH
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-uuid-1', emailAddress: 'fixture@example.invalid' } }), 'utf8')
  fs.writeSync(1, '\nSign-in complete.\n')
  process.exit(0)
}
process.stdin.on('data', chunk => { buffered += chunk; if (buffered.includes('\n')) finish() })
process.stdin.on('end', finish)
process.stdin.on('error', finish)
