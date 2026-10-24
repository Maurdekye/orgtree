import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { assertCanonicalAncestorQuery, lockedAncestorRowsQuery } from '../proofs/deep-project-nesting-queries.mjs'

const source = fs.readFileSync(new URL('../../../engine/rs/orgtree-engine/src/domain/projects.rs', import.meta.url), 'utf8')

test('the named chain probe matches the canonical helper and binds its identity', () => {
  assert.doesNotThrow(() => assertCanonicalAncestorQuery(source))
  const query = lockedAncestorRowsQuery(123)
  assert.doesNotMatch(query, /\$\d+/)
  assert.match(query, /WHERE id=123\b/)
  assert.match(query, /SELECT a\.id FROM/)
  assert.match(query, /ORDER BY r\.depth FOR UPDATE OF a$/)
})

test('layout changes and unrelated adjacent SQL cannot redirect the named probe', () => {
  assert.doesNotThrow(() => assertCanonicalAncestorQuery(source.replaceAll('\r\n', '\n').replaceAll('  ', '    ')))
  const start = source.indexOf('async fn locked_ancestor_rows('), end = source.indexOf('\n}', start)
  const moved = source.slice(0, start) + source.slice(start, end).replace('WHERE id=$1', 'WHERE id=$2') + source.slice(end)
  assert.throws(() => assertCanonicalAncestorQuery(moved + '\n' + source), /query or binds changed/)
  assert.throws(() => assertCanonicalAncestorQuery(source.replace('&[&id]', '&[]')), /query or binds changed/)
})

test('invalid identities cannot become SQL in the raw psql probe', () => {
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1; DROP TABLE ot.agents']) {
    assert.throws(() => lockedAncestorRowsQuery(id), /identity required/)
  }
})
