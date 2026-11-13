// tools/rig/steps.mjs: what a proof with a window half needs beside the page
// script: the Windows session it runs in (a window opens in Session 0 only),
// and a small control server through which the page script asks the proof to
// do one thing to the engines while its window stays open.

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'

/** The Windows session this process runs in (tasklist), or null. */
export function sessionId() {
  if (process.platform !== 'win32') return null
  const r = spawnSync('tasklist', ['/FI', `PID eq ${process.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  const n = Number((r.stdout ?? '').trim().split('\n')[0]?.match(/"([^"]*)"/g)?.[3]?.slice(1, -1))
  return Number.isInteger(n) ? n : null
}

/** Steps the page script asks for while its window stays open: POST <url><name>.
 *  The address carries a random key, and the server listens on loopback only. */
export function control(handlers) {
  const key = crypto.randomBytes(8).toString('hex')
  const server = http.createServer(async (req, res) => {
    const name = req.url.startsWith(`/${key}/`) ? req.url.slice(key.length + 2) : ''
    const fn = handlers[name]
    if (req.method !== 'POST' || !fn) { res.writeHead(404).end(); return }
    try {
      const out = await fn()
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out ?? { ok: true }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(e?.message ?? e) }))
    }
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/${key}/`,
    close: () => new Promise(done => { server.close(() => done()); server.closeAllConnections?.() }),
  })))
}
