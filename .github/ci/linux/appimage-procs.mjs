// The processes running from one AppImage, one per line: "<pid> <ppid> <role> <version>".
// The AppImage runtime mounts the image and starts the app with APPIMAGE (the file) and
// APPDIR (its mount) set, so the mounts of this AppImage are the APPDIRs of processes
// whose APPIMAGE is this file; every process whose executable lies inside one of those
// mounts runs from it, whether or not it inherited those variables. The role comes from
// the executable: the Electron app ("desktop", or "host" when it runs as the background
// engine's host with ELECTRON_RUN_AS_NODE), "engine", "mailhub", "postgres" or "other";
// Chromium's own child processes (--type=...) are left out. The version is the
// build-info.json in that mount, which is what tells two builds of one engine apart.
// The file keeps its path across an in-place update, so old and new show up side by side.
//   node .github/ci/linux/appimage-procs.mjs <AppImage path>
import fs from 'node:fs'
import path from 'node:path'

const appImage = process.argv[2]
if (!appImage) { console.error('usage: appimage-procs.mjs <AppImage path>'); process.exit(2) }
const roles = { orgtree: 'desktop', 'orgtree-engine': 'engine', 'orgtree-mailhub': 'mailhub', postgres: 'postgres' }
const read = (file, encoding = 'utf8') => { try { return fs.readFileSync(file, encoding) } catch { return null } }
const procs = []
for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
  let exe
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`) } catch { continue }  // gone, or not ours
  const env = new Map((read(`/proc/${pid}/environ`) ?? '').split('\0').filter(Boolean)
    .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
  // Chromium rewrites its children's argv into one space-separated string, so look for
  // --type= anywhere in the raw command line, not only as a separate argument.
  const chromiumChild = /(^|[\s\0])--type=/.test(read(`/proc/${pid}/cmdline`) ?? '')
  const ppid = /^\d+ \(.*\) \S+ (\d+)/s.exec(read(`/proc/${pid}/stat`) ?? '')?.[1] ?? '?'
  procs.push({ pid, ppid, exe, env, chromiumChild })
}
const mounts = new Set(procs.filter(p => p.env.get('APPIMAGE') === appImage && p.env.get('APPDIR')
  && p.exe.startsWith(p.env.get('APPDIR') + '/')).map(p => p.env.get('APPDIR')))
const versions = new Map([...mounts].map(dir => {
  try { return [dir, JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'build-info.json'), 'utf8')).version] } catch { return [dir, '?'] }
}))
for (const p of procs) {
  const mount = [...mounts].find(dir => p.exe.startsWith(dir + '/'))
  if (!mount || p.chromiumChild) continue
  let role = roles[path.basename(p.exe)] ?? 'other'
  if (role === 'desktop' && p.env.get('ELECTRON_RUN_AS_NODE') === '1') role = 'host'
  console.log(`${p.pid} ${p.ppid} ${role} ${versions.get(mount)}`)
}
