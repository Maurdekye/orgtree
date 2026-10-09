// The loopback update feed for update-test.sh: serves the files of one folder on
// 127.0.0.1 only, answers single-range requests the way GitHub's download servers do
// (the GitHub provider never asks for several ranges at once), and logs every request
// with the bytes it sent, so the test can tell a differential download from a full one.
//   node .github/ci/linux/update-feed.mjs <folder> <port> <log.jsonl>
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const [folder, port, log] = process.argv.slice(2)
if (!folder || !port || !log) { console.error('usage: update-feed.mjs <folder> <port> <log.jsonl>'); process.exit(2) }
const root = path.resolve(folder)
const record = entry => fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')

http.createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://feed').pathname).replace(/^\/+/, '')
  const entry = { method: request.method, path: '/' + name, range: request.headers.range ?? null }
  const refuse = (status, headers = {}) => { response.writeHead(status, headers).end(); record({ ...entry, status, bytes: 0 }) }
  const file = path.join(root, name)
  // Plain file names in the folder only: no subfolders, no dot files.
  if (!['GET', 'HEAD'].includes(request.method)) return refuse(405)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return refuse(404)
  const size = fs.statSync(file).size
  let start = 0, end = size - 1, status = 200
  if (request.headers.range) {
    const single = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range)
    if (!single || single[1] + single[2] === '') return refuse(416, { 'Content-Range': `bytes */${size}` })
    if (single[1] === '') start = Math.max(0, size - Number(single[2]))
    else { start = Number(single[1]); if (single[2] !== '') end = Math.min(Number(single[2]), size - 1) }
    if (start > end) return refuse(416, { 'Content-Range': `bytes */${size}` })
    status = 206
  }
  const headers = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' }
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  response.writeHead(status, headers)
  if (request.method === 'HEAD') { response.end(); record({ ...entry, status, bytes: 0 }); return }
  fs.createReadStream(file, { start, end }).pipe(response)
    .on('finish', () => record({ ...entry, status, bytes: end - start + 1 }))
    .on('error', error => record({ ...entry, status, error: error.message }))
}).listen(Number(port), '127.0.0.1', () => console.log(`update feed on http://127.0.0.1:${port}/ serving ${root}`))
