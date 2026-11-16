// Archive-selection controls for tools/provision-postgres.mjs; no downloads,
// native execution or data access. Ported from tests/test_provision_postgres.py
// (4.6.1), case for case.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { NOTICES, TOOLS, assemble, extractRuntime, files, selectedMember } from '../tools/provision-postgres.mjs'

/** A minimal stored (uncompressed) ZIP. `entries`: [{ name, data, external?, madeBy? }]. */
function writeZip(file, entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), data = Buffer.from(entry.data)
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(entry.madeBy ?? 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((entry.external ?? 0) >>> 0, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]))
  return file
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-provision-pg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function archive(folder, extra = []) {
  const names = [...TOOLS.map(tool => `bin/${tool}`), ...NOTICES, 'lib/pgoutput.dll', 'share/postgres.bki', 'pgAdmin 4/unused.exe', ...extra]
  return writeZip(path.join(folder, 'fixture.zip'), names.map(name => ({ name: 'pgsql/' + name, data: name })))
}

test('selection keeps runtime and notices only', () => {
  for (const name of ['bin/postgres.exe', 'lib/pgoutput.dll', 'share/postgres.bki', ...NOTICES]) assert.equal(selectedMember('pgsql/' + name), name)
  for (const name of ['pgsql/pgAdmin 4/a.exe', 'pgsql/StackBuilder/a.exe', 'pgsql/include/a.h', 'pgsql/doc/index.html']) assert.equal(selectedMember(name), null)
})

test('traversal, absolute, ADS and backslash refuse', () => {
  for (const name of ['pgsql/bin/../../escape', '/pgsql/bin/a', 'pgsql/bin/a:stream', 'pgsql\\bin\\a', 'C:/pgsql/bin/a']) {
    assert.throws(() => selectedMember(name), /Unsafe archive member/, name)
  }
})

test('extract preserves the required tree without admin tools', t => {
  const folder = scratch(t), target = path.join(folder, 'out')
  extractRuntime(archive(folder), target)
  assert.ok(fs.statSync(path.join(target, 'lib/pgoutput.dll')).isFile())
  assert.equal(fs.existsSync(path.join(target, 'pgAdmin 4')), false)
  assert.equal(Object.keys(files(target)).length, 9)
})

test('a duplicate case-folded path refuses', t => {
  const folder = scratch(t)
  assert.throws(() => extractRuntime(archive(folder, ['bin/POSTGRES.exe']), path.join(folder, 'out')), /Duplicate/)
})

test('a missing runtime tool refuses', t => {
  const folder = scratch(t)
  const zip = writeZip(path.join(folder, 'fixture.zip'), [{ name: 'pgsql/bin/postgres.exe', data: 'placeholder' }])
  assert.throws(() => extractRuntime(zip, path.join(folder, 'out')), /regular file/)
})

test('a wrong archive pin refuses before writing anything', t => {
  const folder = scratch(t)
  const root = path.join(folder, 'repo')
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  assert.throws(() => assemble(archive(folder), { root }), /size\/SHA-256/)
  assert.deepEqual(fs.readdirSync(path.join(root, 'engine')), [], 'nothing may be written before the pin check')
  assert.equal(fs.existsSync(path.join(root, 'artifacts')), false)
})

test('an archive symlink refuses', t => {
  const folder = scratch(t)
  const zip = writeZip(path.join(folder, 'linked.zip'), [{ name: 'pgsql/bin/postgres.exe', data: '../elsewhere', madeBy: (3 << 8) | 20, external: 0o120777 * 0x10000 }])
  assert.throws(() => extractRuntime(zip, path.join(folder, 'out')), /linked/)
})

test('a corrupted member fails its CRC instead of being written', t => {
  const folder = scratch(t)
  const zip = archive(folder)
  const bytes = fs.readFileSync(zip)
  const at = bytes.indexOf(Buffer.from('bin/postgres.exe', 'utf8'), bytes.indexOf(Buffer.from('pgsql/bin/postgres.exe')) + 22)
  bytes[at] ^= 0xff // the first byte of the member's DATA (its content is its own name)
  fs.writeFileSync(zip, bytes)
  assert.throws(() => extractRuntime(zip, path.join(folder, 'out')), /CRC-32/)
})
