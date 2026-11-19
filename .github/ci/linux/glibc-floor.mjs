// The glibc floor of a packaged Linux app: the newest GLIBC_x.y symbol version any of
// its programs and libraries asks for, which is the oldest glibc the app can start on.
// Also proves the architecture: every ELF file in the folder must be built for <arch>.
//   node .github/ci/linux/glibc-floor.mjs <unpacked app dir> <x64|arm64> <max glibc, e.g. 2.35> <report.json>
// Reads each ELF file's header itself (class, machine) and its dynamic symbols with
// `objdump -T`. Prints one row per file, writes the same as JSON, adds a table to the
// run summary, and fails when a file needs a newer glibc than <max> or is built for
// another architecture. A file with no GLIBC_ symbols (static, or no libc) has no floor.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const [dir, arch, max, report] = process.argv.slice(2)
const machines = { x64: [62, 'x86-64'], arm64: [183, 'aarch64'] }
if (!dir || !machines[arch] || !/^\d+\.\d+$/.test(max ?? '') || !report) {
  console.error('usage: glibc-floor.mjs <unpacked app dir> <x64|arm64> <max glibc> <report.json>'); process.exit(2)
}
const [wantMachine, wantName] = machines[arch]
const machineName = code => Object.values(machines).find(([c]) => c === code)?.[1] ?? `e_machine ${code}`
const newer = (a, b) => { const [x, y] = [a, b].map(v => v.split('.').map(Number)); return x[0] - y[0] || x[1] - y[1] || (x[2] ?? 0) - (y[2] ?? 0) }

const files = []
const walk = folder => {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.isFile()) files.push(file)   // not symlinks: each real file once
  }
}
walk(dir)

const rows = []
for (const file of files.sort()) {
  const head = Buffer.alloc(20)
  const fd = fs.openSync(file, 'r')
  const read = fs.readSync(fd, head, 0, 20, 0)
  fs.closeSync(fd)
  if (read < 20 || head.readUInt32BE(0) !== 0x7f454c46) continue   // not ELF
  const little = head[5] === 1
  const machine = little ? head.readUInt16LE(18) : head.readUInt16BE(18)
  let symbols = ''
  try { symbols = execFileSync('objdump', ['-T', file], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { /* no dynamic symbol table */ }
  const versions = [...new Set(symbols.match(/GLIBC_\d+(?:\.\d+)+/g) ?? [])].map(v => v.slice(6)).sort(newer)
  rows.push({ file: path.relative(dir, file).split(path.sep).join('/'), machine: machineName(machine), glibc: versions.at(-1) ?? null })
}
if (!rows.length) { console.log(`::error::no ELF file under ${dir}`); process.exit(1) }

const problems = []
for (const row of rows) {
  if (row.machine !== wantName) problems.push(`${row.file} is built for ${row.machine}, not ${wantName}`)
  if (row.glibc && newer(row.glibc, max) > 0) problems.push(`${row.file} needs glibc ${row.glibc}, newer than ${max}`)
}
const floor = rows.map(row => row.glibc).filter(Boolean).sort(newer).at(-1) ?? null
// The parts the app is made of, each with the newest glibc any of its files needs.
const parts = [
  ['Electron (the app binary and its libraries)', row => !row.file.startsWith('resources/')],
  ['engine', row => row.file === 'resources/engine/orgtree-engine'],
  ['mail hub', row => row.file === 'resources/engine/orgtree-mailhub'],
  ['PostgreSQL (programs and libraries)', row => row.file.startsWith('resources/engine/postgresql/')],
  ['other', row => row.file.startsWith('resources/') && !row.file.startsWith('resources/engine/')],
].map(([part, has]) => {
  const own = rows.filter(has)
  return { part, files: own.length, glibc: own.map(row => row.glibc).filter(Boolean).sort(newer).at(-1) ?? null }
}).filter(part => part.files)

const width = Math.max(...rows.map(row => row.file.length))
for (const row of rows) console.log(`${row.file.padEnd(width)}  ${row.machine.padEnd(8)}  ${row.glibc ? `GLIBC_${row.glibc}` : '(none)'}`)
console.log('')
for (const part of parts) console.log(`${part.part}: ${part.files} ELF file(s), needs glibc ${part.glibc ?? '(none)'}`)
console.log(`glibc floor of the ${arch} app: ${floor ?? '(none)'} (allowed: up to ${max}); ${rows.length} ELF files, all must be ${wantName}`)

fs.mkdirSync(path.dirname(path.resolve(report)), { recursive: true })
fs.writeFileSync(report, JSON.stringify({ arch, machine: wantName, max, floor, parts, files: rows, problems }, null, 2) + '\n')
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### glibc floor of the Linux ${arch} app: ${floor ?? '(none)'} (allowed: up to ${max})`, '',
    '| part | ELF files | newest glibc needed |', '|---|---:|---|',
    ...parts.map(part => `| ${part.part} | ${part.files} | ${part.glibc ?? '(none)'} |`), '',
    `All ${rows.length} ELF files are ${wantName}: ${problems.some(p => p.includes('built for')) ? 'NO' : 'yes'}.`, '',
  ].join('\n'))
}
if (problems.length) {
  for (const problem of problems) console.log(`::error::${problem}`)
  process.exit(1)
}
