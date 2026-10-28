// A numbered migration never changes (4.5.0 high D13, review alpha2
// 9e69071e6651 F1).
//
// The engine records each applied migration's checksum and refuses to start
// when the text of an applied migration has changed
// (engine/rs/orgtree-engine/src/migrate.rs: "checksum drift"). 0063 was edited
// after it was numbered (9e69071, 2026-10-26), so a database that applied the
// earlier text could not start. Every installer from 4.5.0-alpha.2 on carries
// the edited 0063, so 0063 stays as shipped. This test pins the checksum of
// every registered migration, computed the way migrate.rs computes it, so an
// edit after numbering fails here instead of on someone's database. Fix
// forward with a new migration. A new migration adds its pin line when it is
// numbered, and an existing line never changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ENGINE = path.join(ROOT, 'engine', 'rs', 'orgtree-engine')
const MIGRATIONS = path.join(ENGINE, 'migrations')
const PINS = path.join(MIGRATIONS, 'pinned-checksums.txt')
const PINS_NAME = path.relative(ROOT, PINS).split(path.sep).join('/')

/** migrate.rs's checksum(): SHA-256, hex, of the text with CRLF read as LF. */
const checksum = text => crypto.createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex')

const migrateSource = () => fs.readFileSync(path.join(ENGINE, 'src', 'migrate.rs'), 'utf8')

/** The registered migrations, in the order the engine applies them. */
function registered() {
  const list = /const MIGRATIONS: &\[\(&str, &str\)\] = &\[([\s\S]*?)\r?\n\];/.exec(migrateSource())?.[1]
  assert.ok(list, 'migrate.rs no longer declares const MIGRATIONS the way this test reads it')
  const rows = [...list.matchAll(/\(\s*"([^"]+)"\s*,\s*include_str!\("\.\.\/migrations\/([^"]+)"\)\s*\)/g)]
    .map(m => ({ name: m[1], file: m[2] }))
  // a syntax this test cannot read must fail, not shrink the list
  const entries = list.split(/\r?\n/).filter(line => line.trim().startsWith('("'))
  assert.equal(rows.length, entries.length, 'every MIGRATIONS entry is read')
  return rows
}

function pins() {
  return fs.readFileSync(PINS, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => {
    const m = /^(\S+) ([0-9a-f]{64})$/.exec(line)
    assert.ok(m, `malformed line in ${PINS_NAME}: ${line}`)
    return { name: m[1], sum: m[2] }
  })
}

test('the checksum pinned here is the one migrate.rs records and compares', () => {
  const source = migrateSource()
  assert.match(source, /fn checksum\(sql: &str\) -> String \{[\s\S]{0,200}?let normalised = sql\.replace\("\\r\\n", "\\n"\);\s*hex::encode\(Sha256::digest\(normalised\.as_bytes\(\)\)\)/,
    'migrate.rs changed how it computes a checksum; every pin (and every database) depends on it')
  assert.match(source, /let sum = checksum\(sql\);/)
  assert.match(source, /if have != sum \{\s*bail!\("migration \{name\} changed after it was applied \(checksum drift\)"\);/,
    'the engine still refuses an applied migration whose text changed')
  // the function itself: CRLF and LF copies hash alike, one changed byte does not
  assert.equal(checksum(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(checksum('a\r\nb\r\n'), checksum('a\nb\n'))
  assert.notEqual(checksum('a\nb\n'), checksum('a\nb \n'))
})

test('every registered migration keeps the text it had when it was numbered', () => {
  const rows = registered(), pinned = pins()
  assert.ok(rows.length >= 76 && pinned.length >= 76, `only ${rows.length} registered and ${pinned.length} pinned migrations were read`)
  const byName = new Map(pinned.map(pin => [pin.name, pin.sum]))
  const drift = [], unpinned = []
  for (const { name, file } of rows) {
    assert.equal(file, `${name}.sql`, `${name} is registered from ${file}`)
    const sum = checksum(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))
    if (!byName.has(name)) unpinned.push(`${name} ${sum}`)
    else if (byName.get(name) !== sum) drift.push(`${name}: pinned ${byName.get(name)}, now ${sum}`)
  }
  assert.deepEqual(drift, [], 'a numbered migration changed; the engine refuses every database that applied its earlier text. ' +
    'Restore it and fix forward with a new migration:\n  ' + drift.join('\n  '))
  assert.deepEqual(unpinned, [], `pin each new migration when it is numbered, by adding its line to ${PINS_NAME}:\n  ` + unpinned.join('\n  '))
  assert.deepEqual(pinned.map(pin => pin.name), rows.map(row => row.name),
    `${PINS_NAME} lists the registered migrations in the order the engine applies them; none is ever removed`)
})

test('every migration file is registered', () => {
  const rows = registered()
  const files = fs.readdirSync(MIGRATIONS).filter(file => file.endsWith('.sql'))
  assert.deepEqual(files.filter(file => !rows.some(row => row.file === file)), [], 'a migration file the engine never applies')
})
