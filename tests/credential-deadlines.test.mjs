import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { transformSync } from 'esbuild'
import { testOutput } from './helpers/test-output.mjs'

// Run the whole broker module and its real authenticated pipe, with a
// synthetic executable seam. No native gh, keyring, engine or live auth.
async function fixture(t, mode) {
  const output = testOutput('CREDENTIAL_DEADLINE_TEST_TMP', 'credential-deadline-')
  const home = output.directory, bin = path.join(home, 'bin'), fakeGh = path.join(bin, 'gh.exe')
  fs.mkdirSync(bin); fs.writeFileSync(fakeGh, 'inert executable lookup fixture')
  const script = path.join(home, 'credential.cjs')
  fs.writeFileSync(script, `
    const mode=process.argv[2];
    if(mode==='late')setTimeout(()=>process.stdout.write('synthetic-ok'),6500);
    else if(mode==='timeout')setTimeout(()=>{},60000);
    else if(mode==='failure'){process.stderr.write('private-synthetic-stderr');process.exit(7)}
    else if(mode==='empty')process.exit(0);
    else process.stdout.write('synthetic-ok');
  `)
  const children = [], calls = [], pipeTimeouts = []
  const fakeEnv = { SystemRoot: process.env.SystemRoot, PATH: bin, USERPROFILE: home,
    HOME: home, APPDATA: home, TEMP: home, TMP: home, GH_CONFIG_DIR: home }
  const native = (exe, args, options, done) => {
    assert.equal(exe, fakeGh)
    assert.deepEqual([...args], ['auth', 'token', '--hostname', 'synthetic.example'])
    assert.equal(options.cwd, home); assert.equal(options.windowsHide, true)
    assert.equal(options.maxBuffer, 65536)
    assert.equal(options.env.GH_PROMPT_DISABLED, '1')
    assert.equal(options.env.ORGTREE_CREDENTIAL_AUTH, undefined)
    calls.push({ timeout: options.timeout })
    const child = execFile(process.execPath, [script, mode], {
      ...options, timeout: mode === 'timeout' ? 100 : options.timeout,
    }, done)
    children.push(child); return child
  }
  const module = { exports: {} }
  const source = fs.readFileSync('apps/desktop/main/credential-bridge.ts', 'utf8')
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const builtin = {
    'node:child_process': { execFile: native }, 'node:fs': fs, 'node:path': path,
    'node:os': { homedir: () => home },
    'node:net': { createServer: handler => net.createServer(socket => { handler(socket); pipeTimeouts.push(socket.timeout) }) },
  }
  vm.runInNewContext(code, { module, exports: module.exports, process: { env: fakeEnv, platform: process.platform, pid: process.pid },
    Buffer, URL, Error, setTimeout, clearTimeout, AbortSignal,
    require: id => id === './policy' ? { TOKEN_HEADER: 'synthetic-desktop-token' }
      : builtin[id] ?? (id === 'node:crypto' ? { randomBytes: size => Buffer.alloc(size, 1), timingSafeEqual: (a,b) => a.equals(b) } : (() => { throw Error('Unexpected dependency '+id) })()),
  })
  const broker = new module.exports.CredentialBridge()
  broker.pipe = process.platform === 'win32' ? '\\\\.\\pipe\\orgtree-credential-test-'+randomUUID() : path.join(home, 'broker.sock')
  await broker.start()
  t.after(async () => {
    await new Promise(resolve => broker.server.close(resolve))
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'every synthetic child has exited')
    output.cleanup()
  })
  const request = secret => new Promise((resolve,reject) => {
    const socket = net.createConnection(broker.pipe), chunks = []
    socket.on('connect', () => socket.write(JSON.stringify({ secret, diagnostics: 1, kind: 'gh', host: 'synthetic.example' })+'\n'))
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()))
  })
  return { request: () => request(broker.secret), denied: () => request('wrong-secret'), children, calls, pipeTimeouts }
}

test('credential deadline accepts a synthetic answer just past the former six-second cutoff', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'late')
  const answer = await f.request()
  assert.equal(answer, 'synthetic-ok', 'a valid slow lookup must survive the former cutoff')
  assert.equal(f.calls[0].timeout, 20000)
  assert.deepEqual(f.pipeTimeouts, [25000])
})

test('credential deadline kills a timed-out synthetic child and returns only its fixed code', async t => {
  const f = await fixture(t, 'timeout')
  assert.equal(await f.request(), 'orgtree-credential-error gh-timeout\n')
  assert.equal(f.calls[0].timeout, 20000, 'fixture accelerates child time only; production budget remains bounded')
  for (const child of f.children) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
})

for (const [mode, code] of [['failure','gh-exit-7'],['empty','gh-empty']]) test(`credential deadline keeps ${mode} errors coarse`, async t => {
  const f = await fixture(t, mode)
  assert.equal(await f.request(), `orgtree-credential-error ${code}\n`)
})

test('credential deadline preserves authentication before executable lookup', async t => {
  const f = await fixture(t, 'fast')
  assert.equal(await f.denied(), '')
  assert.equal(f.calls.length, 0)
})
