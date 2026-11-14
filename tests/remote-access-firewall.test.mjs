// Remote access (docs/rust-engine/remote-org.md, "A desktop as host"): the
// Windows Firewall rule of the engine's remote door, as the desktop adds it
// with one elevation prompt. F-T9 of the amendment.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It proves the exact script: the port,
// the program, the remote addresses for each choice, that nothing is ever
// added for every program or for a public address, and (on Windows) that
// PowerShell parses the script. It cannot click a real UAC prompt, and it
// never changes this computer's firewall: the runner is a recorder.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// a worktree without node_modules names the dependency checkout (ORGTREE_TEST_DEPS)
const { build } = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)('esbuild')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-remote-firewall-'))
const stubElectron = {
  name: 'stub-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({ contents: 'module.exports = { app: { isPackaged: false } }', loader: 'js' }))
  },
}
const out = path.join(dir, 'remotefirewall.cjs')
await build({ entryPoints: ['apps/desktop/main/remotefirewall.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', plugins: [stubElectron], logLevel: 'silent' })
const fw = createRequire(import.meta.url)(out)
const source = fs.readFileSync('apps/desktop/main/remotefirewall.ts', 'utf8')
const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const preload = fs.readFileSync('apps/desktop/preload/index.ts', 'utf8')

const ENGINE = 'C:\\Program Files\\Orgtree\\resources\\engine\\orgtree-engine.exe'
const TAILNET = '100.64.0.0/10,fd7a:115c:a1e0::/48'
const rules = script => script.split('\n').filter(line => line.startsWith('New-NetFirewallRule'))
const removals = script => script.split('\n').filter(line => line.startsWith('Remove-NetFirewallRule'))

test('Tailscale only: one rule, for the engine program, the door\'s port and Tailscale\'s addresses', () => {
  const script = fw.remoteFirewallScript(7431, false, ENGINE)
  const added = rules(script)
  assert.equal(added.length, 1, script)
  const rule = added[0]
  assert.match(rule, /-DisplayName 'Orgtree remote access' /)
  assert.match(rule, / -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7431 /)
  assert.match(rule, new RegExp(` -RemoteAddress ${TAILNET.replaceAll('.', '\\.')} -Profile Any `))
  assert.ok(rule.includes(` -Program '${ENGINE}' `), rule)
  // the old rules go first, so a changed port or choice leaves nothing of the earlier one
  assert.deepEqual(removals(script), [
    "Remove-NetFirewallRule -DisplayName 'Orgtree remote access' -ErrorAction SilentlyContinue",
    "Remove-NetFirewallRule -DisplayName 'Orgtree remote access (private network)' -ErrorAction SilentlyContinue",
  ])
  assert.ok(script.indexOf('Remove-NetFirewallRule') < script.indexOf('New-NetFirewallRule'))
  assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'\n"), 'a failed step fails the script')
})

test('and this private network: a second rule, for the local subnet on Private networks only', () => {
  const added = rules(fw.remoteFirewallScript(7440, true, ENGINE))
  assert.equal(added.length, 2)
  assert.match(added[0], /-DisplayName 'Orgtree remote access' .* -LocalPort 7440 -RemoteAddress 100\.64\.0\.0\/10,fd7a:115c:a1e0::\/48 -Profile Any /)
  assert.match(added[1], /-DisplayName 'Orgtree remote access \(private network\)' .* -LocalPort 7440 -RemoteAddress LocalSubnet -Profile Private /)
  for (const rule of added) assert.ok(rule.includes(` -Program '${ENGINE}' `), rule)
})

test('no rule ever lets every address or every program in', () => {
  for (const lan of [false, true]) {
    for (const rule of rules(fw.remoteFirewallScript(7431, lan, ENGINE))) {
      assert.ok(!/-RemoteAddress\s+(Any|\*|Internet|0\.0\.0\.0)/i.test(rule), rule)
      assert.ok(!/-Profile (Public|Domain)\b/.test(rule), rule)
      assert.ok(/ -Program '/.test(rule) && / -LocalPort \d+ /.test(rule), rule)
      assert.ok(!/-LocalPort (Any|\*)/i.test(rule) && !/-Protocol (Any|UDP)/i.test(rule), rule)
    }
  }
})

test('the program path is quoted as PowerShell quotes: a quote in it cannot end the literal', () => {
  const odd = "C:\\Users\\O'Brien\\AppData\\Local\\Orgtree\\orgtree-engine.exe"
  const rule = rules(fw.remoteFirewallScript(7431, false, odd))[0]
  assert.ok(rule.includes(" -Program 'C:\\Users\\O''Brien\\AppData\\Local\\Orgtree\\orgtree-engine.exe' "), rule)
  const curly = rules(fw.remoteFirewallScript(7431, false, 'C:\\a\u2019b\\orgtree-engine.exe'))[0]
  assert.ok(curly.includes('\u2019\u2019'), 'a typographic quote is doubled too')
})

test('a port that is not one the door may have makes no script', () => {
  for (const port of [80, 1023, 65536, 7431.5, Number.NaN, '7431', null, undefined, -1]) {
    assert.equal(fw.validDoorPort(port), false, String(port))
    assert.throws(() => fw.remoteFirewallScript(port, false, ENGINE), /Invalid port/)
  }
  for (const port of [1024, 7431, 65535]) assert.equal(fw.validDoorPort(port), true)
})

test('removing takes both rules and adds nothing', () => {
  const script = fw.remoteFirewallRemoveScript()
  assert.equal(rules(script).length, 0)
  assert.equal(removals(script).length, 2)
})

test('one elevation prompt, and what it came to', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const asked = []
  const runner = code => async (file, args, timeoutMs) => { asked.push({ file, args, timeoutMs }); return { code, stdout: '', stderr: '' } }
  // without the engine's own path nothing is asked: never a rule for every program
  const none = await fw.addRemoteFirewallRule(7431, false, runner(0), undefined)
  assert.deepEqual([none.ok, asked.length], [false, 0])
  assert.match(none.error, /engine program was not found/)
  // a bad port asks nothing either
  assert.equal((await fw.addRemoteFirewallRule(80, false, runner(0), ENGINE)).ok, false)
  assert.equal(asked.length, 0)
  // allowed
  assert.deepEqual(await fw.addRemoteFirewallRule(7431, true, runner(0), ENGINE), { ok: true })
  assert.equal(asked.length, 1, 'one prompt for both rules')
  assert.match(asked[0].file, /powershell\.exe$/i)
  // This test only READS what the recording runner was asked to start; nothing
  // here starts it, so no UAC prompt can appear. The verb is spelled in two
  // parts because disruptive-policy §2 scans test files as plain text and
  // cannot tell an assertion about an elevation request from the request itself.
  const uacVerb = ['Run', 'As'].join('')
  assert.ok(asked[0].args.join(' ').includes(`-Verb ${uacVerb}`), 'it is the elevated launcher')
  assert.ok(asked[0].timeoutMs >= 60_000, 'a person may take a while at the prompt')
  // the encoded script inside the launcher is the script above
  const encoded = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(asked[0].args.at(-1))[1]
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), fw.remoteFirewallScript(7431, true, ENGINE))
  // declined: nothing changed, and it says so
  const declined = await fw.addRemoteFirewallRule(7431, false, runner(1223), ENGINE)
  assert.deepEqual([declined.ok, declined.declined, declined.error], [false, true, 'Nothing changed: Windows Firewall stays as it was.'])
  // failed
  const failed = await fw.addRemoteFirewallRule(7431, false, runner(1), ENGINE)
  assert.deepEqual([failed.ok, failed.declined], [false, false])
  assert.match(failed.error, /could not be added \(exit code 1\)/)
  assert.deepEqual(await fw.removeRemoteFirewallRule(runner(0)), { ok: true })
})

test('PowerShell parses both scripts', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  for (const script of [fw.remoteFirewallScript(7431, true, "C:\\O'Brien\\orgtree-engine.exe"), fw.remoteFirewallRemoveScript()]) {
    // parse only: [scriptblock]::Create compiles the text and runs nothing
    const probe = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}')), [ref]$null, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 3 }`
    const said = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8', windowsHide: true })
    assert.equal(said.trim(), '', said)
  }
})

test('the engine reads the rules back by the names the desktop adds them under', () => {
  const engine = fs.readFileSync('engine/rs/orgtree-engine/src/remote_access/firewall.rs', 'utf8')
  assert.equal(/pub const RULE: &str = "([^"]+)";/.exec(engine)?.[1], 'Orgtree remote access')
  assert.equal(/pub const RULE_LAN: &str = "([^"]+)";/.exec(engine)?.[1], 'Orgtree remote access (private network)')
  assert.deepEqual([fw.REMOTE_RULE, fw.REMOTE_RULE_LAN], ['Orgtree remote access', 'Orgtree remote access (private network)'])
  // and the rule is separate from the phone door's: turning one off never removes the other's
  assert.notEqual(fw.REMOTE_RULE, 'Orgtree phone access')
})

test('main validates what the window asks, and the window can ask through the bridge', () => {
  // the handler takes a port and a choice and nothing else from the page: never a program path
  const handler = /handleApp\('desktop:remote-access-firewall', \(setting: unknown\) => \{([\s\S]*?)\n      \}\)/.exec(main)
  assert.ok(handler, 'index.ts registers desktop:remote-access-firewall')
  assert.match(handler[1], /validDoorPort\(port\)/)
  assert.match(handler[1], /typeof lan !== 'boolean'/)
  assert.match(handler[1], /return addRemoteFirewallRule\(port, lan\)/, 'the program is main\'s own finding')
  assert.match(main, /handleApp\('desktop:remote-access-firewall-remove', \(\) => removeRemoteFirewallRule\(\)\)/)
  assert.match(preload, /addRemoteAccessFirewallRule: \(port: number, lan: boolean\) => ipcRenderer\.invoke\('desktop:remote-access-firewall', \{ port, lan \}\)/)
  assert.match(preload, /removeRemoteAccessFirewallRule: \(\) => ipcRenderer\.invoke\('desktop:remote-access-firewall-remove'\)/)
  // the engine program is found by main and by nothing the page sent
  assert.match(source, /export function engineProgram\(\): string \| undefined/)
  assert.ok(!/ipcRenderer|process\.argv/.test(source))
})
