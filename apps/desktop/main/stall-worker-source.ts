/** The worker thread that takes the MAIN thread's stack when main stops answering (spec ui-stall-tooling-spec, M5).
 *  Main writes Date.now() into a SharedArrayBuffer every 100 ms (the MainLagProbe tick). The worker checks every 100 ms; a value
 *  500+ ms old means main is blocked, so it opens an inspector session ON THE MAIN THREAD, pauses it, reads the call frames
 *  (top 30) and resumes. At most one capture a minute. The debugger is NEVER left enabled; on any failure the worker posts
 *  `unavailable:<reason>`. Kept as source text and started with `new Worker(source, { eval: true })`: no second bundle file,
 *  and nothing for the asar archive to get in the way of. Same logic as captureMainStack in stall-probe.ts (which the tests drive). */
export const MAIN_STACK_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const view = new Float64Array(workerData.sab)
const STALE = workerData.staleMs || 500, EVERY = workerData.everyMs || 60000
let last = -Infinity, busy = false
const reason = (e) => 'unavailable:' + String((e && e.message) || e || 'unknown').replace(/\\s+/g, ' ').slice(0, 80)
function capture() {
  busy = true
  const at = Date.now()
  let session, enabled = false, done = false
  const finish = (value) => {
    if (done) return
    done = true
    const end = () => { try { session && session.disconnect() } catch (e) {} busy = false; parentPort.postMessage({ at, stack: value }) }
    if (!enabled) return end()
    session.post('Debugger.resume', {}, () => session.post('Debugger.disable', {}, end))
  }
  try {
    const inspector = require('node:inspector')
    session = new inspector.Session()
    session.connectToMainThread()
    session.on('Debugger.paused', (m) => finish(m.params.callFrames.slice(0, 30).map((f) =>
      (f.functionName || '(anonymous)') + ' (' + f.url + ':' + (f.lineNumber + 1) + ':' + (f.columnNumber + 1) + ')')))
    session.post('Debugger.enable', {}, (err) => {
      if (err) return finish(reason(err))
      enabled = true
      session.post('Debugger.pause', {}, (e) => { if (e) finish(reason(e)) })
    })
  } catch (e) { finish(reason(e)) }
}
setInterval(() => {
  const now = Date.now()
  if (busy || now - view[0] < STALE || now - last < EVERY) return
  last = now
  capture()
}, 100)
`
