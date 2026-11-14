// The rule that decides whether the attach descriptor may be trusted exists
// twice: in the window (verifyDescriptorTrust, apps/desktop/main/policy.ts)
// and in the installer's close helper (Get-DescriptorDistrust,
// tools/installer-upgrade.ps1). Both walk every folder above the descriptor up
// to the drive's root and refuse a folder another account can replace.
//
// Windows puts "Authenticated Users: Modify, this folder only" on the root of
// a newly formatted data drive. Modify carries DELETE, and the rule counted
// it, so a data folder on such a drive was refused although nobody can delete
// or rename a drive's root folder (user ruling 2026-11-14, docket
// data-folder-on-a-second-drive-drive-root-delete-r). This file pins the rule
// both copies must keep: DELETE on a drive letter's root is not distrust;
// every other right there, and every right on every other folder, is judged
// as before. "Any drive letter" (user ruling 2026-11-14 08:00Z): a letter made
// with SUBST and a mapped network drive are roots for this rule too.
//
// Nothing here reads or changes a real permission. Get-Acl is replaced, in the
// PowerShell process each copy runs in, by a function that answers from a
// table of security descriptors (a function is found before a cmdlet). The
// folders named are never made, and no drive is asked anything.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const windows = process.platform === 'win32'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-trust-root-'))
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))
const req = createRequire(import.meta.url)
const childProcess = req('node:child_process')

const AUTHENTICATED_USERS = 'S-1-5-11', EVERYONE = 'S-1-1-0'
// {ME} becomes the current user's SID when the fake Get-Acl answers.
const OWN_FOLDER = 'O:{ME}G:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{ME})'
const OWN_FILE = 'O:{ME}G:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})'
// Read from S:\ and H:\ of the computer this was written on (2026-11-14): what
// Windows gives the root of a formatted data drive.
const DATA_DRIVE_ROOT = 'O:SYG:SYD:(A;OICIIO;SDGXGWGR;;;AU)(A;;0x1301bf;;;AU)(A;;FA;;;SY)(A;OICIIO;GA;;;SY)(A;OICIIO;GA;;;BA)(A;;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)'
// The same for the system drive: other accounts hold nothing on the root
// itself but "create folders", and an inherit-only entry.
const SYSTEM_DRIVE_ROOT = 'O:SYG:SYD:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'
const rootWith = entry => 'O:SYG:SYD:(A;;FA;;;SY)(A;;FA;;;BA)' + entry
const DELETE = '0x10000', DELETE_CHILD = '0x40', WRITE_DAC = '0x40000', WRITE_OWNER = '0x80000', GENERIC_ALL = '0x10000000'

const systemRoot = (process.env.SystemDrive || 'C:') + '\\'
// A drive letter nothing is mounted at. To the mount manager it is no volume,
// which is also what a SUBST letter and a mapped network drive are (measured
// 2026-11-14: `mountvol X:\ /L` refuses all three alike).
const unused = [...'ZYXWVUTRQPON'].map(letter => letter + ':\\').find(root => !fs.existsSync(root))

/** One case: the folder chain from the drive's root down to the descriptor,
 *  each with its security descriptor, and what both copies must answer.
 *  `refused` is { folder, by, how } with how = 'above' (a folder above the
 *  data folder can be replaced) or 'folder' (the data folder can be written). */
function chain(name, root, rootAcl, folders, refused) {
  const acls = { [root]: rootAcl }
  let at = root
  for (const [folder, acl] of folders) { at = at.endsWith('\\') ? at + folder : at + '\\' + folder; acls[at] = acl }
  const file = (at.endsWith('\\') ? at : at + '\\') + 'engine-attach.json'
  acls[file] = OWN_FILE
  return { name, file, acls, refused }
}
const own = (...names) => names.map(folder => [folder, OWN_FOLDER])
const above = (folder, by) => ({ folder, by, how: 'above' })

const CASES = [
  // the two this change is for
  chain('a data drive as Windows formats it', systemRoot, DATA_DRIVE_ROOT, own('orgtree-fake-1', 'data'), null),
  chain('DELETE alone on the root', systemRoot, rootWith(`(A;;${DELETE};;;AU)`), own('orgtree-fake-2', 'data'), null),
  // every other right on a root still counts
  chain('Modify and "delete subfolders and files" on the root', systemRoot, rootWith('(A;;0x1301ff;;;AU)'), own('orgtree-fake-3', 'data'), above(systemRoot, AUTHENTICATED_USERS)),
  chain('"delete subfolders and files" alone on the root', systemRoot, rootWith(`(A;;${DELETE_CHILD};;;AU)`), own('orgtree-fake-4', 'data'), above(systemRoot, AUTHENTICATED_USERS)),
  chain('"change permissions" on the root', systemRoot, rootWith(`(A;;${WRITE_DAC};;;AU)`), own('orgtree-fake-5', 'data'), above(systemRoot, AUTHENTICATED_USERS)),
  chain('"take ownership" on the root', systemRoot, rootWith(`(A;;${WRITE_OWNER};;;AU)`), own('orgtree-fake-6', 'data'), above(systemRoot, AUTHENTICATED_USERS)),
  chain('generic all on the root', systemRoot, rootWith(`(A;;${GENERIC_ALL};;;AU)`), own('orgtree-fake-7', 'data'), above(systemRoot, AUTHENTICATED_USERS)),
  chain('full control for Everyone on the root', systemRoot, rootWith('(A;;FA;;;WD)'), own('orgtree-fake-8', 'data'), above(systemRoot, EVERYONE)),
  // the root's exemption is the root's alone
  chain('a folder below the root that others may modify', systemRoot, DATA_DRIVE_ROOT,
    [['orgtree-fake-9', 'O:{ME}G:SYD:(A;OICIID;0x1301bf;;;AU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)'], ['data', OWN_FOLDER]],
    above(systemRoot + 'orgtree-fake-9', AUTHENTICATED_USERS)),
  chain('the data folder is the root itself', systemRoot, DATA_DRIVE_ROOT, [], { folder: systemRoot, by: AUTHENTICATED_USERS, how: 'folder' }),
  // any drive letter: one that is no volume (SUBST, a mapped network drive) is a root too
  ...(unused ? [
    chain('a drive letter that is no volume, DELETE alone', unused, rootWith(`(A;;${DELETE};;;AU)`), own('orgtree-fake-10', 'data'), null),
    chain('a drive letter that is no volume, as a data drive is formatted', unused, DATA_DRIVE_ROOT, own('orgtree-fake-13', 'data'), null),
    chain('a drive letter that is no volume, "delete subfolders and files"', unused, rootWith(`(A;;${DELETE_CHILD};;;AU)`), own('orgtree-fake-14', 'data'), above(unused, AUTHENTICATED_USERS)),
  ] : []),
  // a path without a drive letter keeps the old rule
  chain('a network share', '\\\\orgtree-fake\\share', rootWith(`(A;;${DELETE};;;AU)`), own('data'), above('\\\\orgtree-fake\\share', AUTHENTICATED_USERS)),
  // unchanged acceptances
  chain('a system drive as Windows installs it', systemRoot, SYSTEM_DRIVE_ROOT, own('orgtree-fake-11', 'data'), null),
  chain('nobody else holds anything', systemRoot, 'O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', own('orgtree-fake-12', 'data'), null),
]

const quote = value => `'${value.replace(/'/g, "''")}'`
const tableOf = acls => '@{' + Object.entries(acls).map(([folder, acl]) => `${quote(folder)}=${quote(acl)}`).join(';') + '}'
// A function named Get-Acl is found before the cmdlet. It answers with a real
// security object built from the table's text, attached to no file.
const FAKE_GET_ACL = 'function Get-Acl{[CmdletBinding()]param([Parameter(Mandatory=$true)][string]$LiteralPath);' +
  "if(-not $orgtreeFakeAcls.ContainsKey($LiteralPath)){throw ('the fake Get-Acl has no entry for '+$LiteralPath)};" +
  '$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;' +
  '$security=New-Object System.Security.AccessControl.DirectorySecurity;' +
  "$security.SetSecurityDescriptorSddlForm(([string]$orgtreeFakeAcls[$LiteralPath]).Replace('{ME}',$me));" +
  'return $security};'

/** What a copy answered, in one shape: null when trusted. */
function mismatches(answers) {
  const wrong = []
  for (const [index, entry] of CASES.entries()) {
    const want = entry.refused, got = answers[index]
    const same = want === null ? got === null
      : got !== null && got.how === want.how && got.by === want.by && got.folder.toLowerCase() === want.folder.toLowerCase()
    if (!same) wrong.push(`${entry.name}: expected ${want ? JSON.stringify(want) : 'trusted'}, got ${got ? JSON.stringify(got) : 'trusted'}`)
  }
  return wrong
}

test('the window: DELETE on a real drive root is not distrust, and nothing else about the rule moved', { skip: !windows && 'Windows only', timeout: 180000 }, async () => {
  const out = path.join(temp, 'policy.cjs')
  await build({ entryPoints: ['apps/desktop/main/policy.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  const policy = req(out)
  // The window's own function runs, with its own script and its own
  // PowerShell: only Get-Acl is put in front of it.
  const real = childProcess.execFile
  let table = ''
  childProcess.execFile = (file, args, ...rest) => {
    const at = Array.isArray(args) ? args.indexOf('-Command') : -1
    if (table && at >= 0) args = [...args.slice(0, at + 1), `$orgtreeFakeAcls=${table};${FAKE_GET_ACL}${args[at + 1]}`, ...args.slice(at + 2)]
    return real(file, args, ...rest)
  }
  const answers = []
  try {
    for (const entry of CASES) {
      table = tableOf(entry.acls)
      const verdict = await policy.verifyDescriptorTrust(entry.file)
      if (verdict.ok) { answers.push(null); continue }
      const aboveIt = /^path replaceable via ancestor (.*?)=(S-1-[0-9-]+)(?:[,;]|$)/.exec(verdict.detail)
      const folder = /^descriptor directory writable by (S-1-[0-9-]+)/.exec(verdict.detail)
      assert.ok(aboveIt || folder, `${entry.name}: an answer this test does not know: ${verdict.detail}`)
      answers.push(aboveIt ? { folder: aboveIt[1], by: aboveIt[2], how: 'above' } : { folder: path.dirname(entry.file), by: folder[1], how: 'folder' })
    }
  } finally { childProcess.execFile = real }
  assert.deepEqual(mismatches(answers), [])
})

/** One top-level function of the helper, cut from its source: from its
 *  `function` line to the first line that closes it at the same indent. */
function cut(lines, name, optional = false) {
  const start = lines.findIndex(line => new RegExp(`^\\s*function ${name}\\b`).test(line))
  if (start < 0) { assert.ok(optional, `tools/installer-upgrade.ps1 has no function ${name}`); return '' }
  const indent = /^\s*/.exec(lines[start])[0]
  const end = lines.findIndex((line, index) => index > start && line === indent + '}')
  assert.ok(end > start, `function ${name} has no closing line`)
  return lines.slice(start, end + 1).join('\r\n')
}

test('the installer helper: the same rule, in the 64-bit and the 32-bit Windows PowerShell', { skip: !windows && 'Windows only', timeout: 180000 }, () => {
  const lines = fs.readFileSync('tools/installer-upgrade.ps1', 'utf8').split(/\r?\n/)
  // Test-DriveRoot is the helper's own name for "a volume's root"; it does not
  // exist before the rule knows roots.
  const functions = [cut(lines, 'Test-SamePath'), cut(lines, 'Test-Blank'), cut(lines, 'Get-ForeignWriters'),
    cut(lines, 'Test-DriveRoot', true), cut(lines, 'Get-DescriptorDistrust')]
  const script = [
    // as the helper sets them
    'Set-StrictMode -Version Latest', "$ErrorActionPreference = 'Stop'",
    FAKE_GET_ACL, ...functions,
    ...CASES.map((entry, index) => `$orgtreeFakeAcls=${tableOf(entry.acls)}; Write-Output ('${index}|' + (Get-DescriptorDistrust ${quote(entry.file)}))`),
  ].join('\r\n')
  const file = path.join(temp, 'helper-rule.ps1')
  fs.writeFileSync(file, '\ufeff' + script)
  const windowsFolder = process.env.SystemRoot || 'C:\\Windows'
  // The installer starts the helper from a 32-bit process.
  const hosts = ['System32', 'SysWOW64'].map(folder => path.join(windowsFolder, folder, 'WindowsPowerShell', 'v1.0', 'powershell.exe')).filter(host => fs.existsSync(host))
  assert.ok(hosts.length, 'Windows PowerShell 5.1 was not found')
  for (const host of hosts) {
    const output = childProcess.execFileSync(host, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', windowsHide: true, timeout: 120000 })
    const answers = CASES.map(() => undefined)
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [, index, text] = /^(\d+)\|(.*)$/.exec(line) ?? []
      assert.ok(index !== undefined, `${host}: a line this test does not know: ${line}`)
      const aboveIt = /^a folder above it \((.*)\) can be replaced by (S-1-[0-9-]+)/.exec(text)
      const folder = /^its folder can be written by (S-1-[0-9-]+)/.exec(text)
      assert.ok(text === '' || aboveIt || folder, `${host}: an answer this test does not know: ${text}`)
      answers[Number(index)] = text === '' ? null
        : aboveIt ? { folder: aboveIt[1], by: aboveIt[2], how: 'above' } : { folder: path.dirname(CASES[Number(index)].file), by: folder[1], how: 'folder' }
    }
    assert.ok(answers.every(answer => answer !== undefined), `${host}: not every case was answered:\n${output}`)
    assert.deepEqual(mismatches(answers), [], host)
  }
})
