// Stands in for the managed engine: holds an open write handle inside the
// install directory until it is asked, on stdin, to stop. It never installs a
// signal handler that would let a terminate look like a graceful stop.
const fs = require('fs')

const lock = process.argv[2]
const handle = fs.openSync(lock, 'w')
fs.writeSync(handle, String(process.pid))

const keepAlive = setInterval(() => {}, 1000)
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8')
  if (!buffer.includes('stop')) return
  clearInterval(keepAlive)
  try { fs.closeSync(handle) } catch { /* already closed */ }
  try { fs.unlinkSync(lock) } catch { /* nothing to remove */ }
  process.exit(0)
})
process.stdin.on('end', () => { clearInterval(keepAlive); try { fs.closeSync(handle) } catch { /* already closed */ } process.exit(0) })
