// Named proof projection of projects::locked_ancestor_rows. Keep product code
// untouched; fail closed if its canonical query or parameter contract changes.
export const LOCKED_ANCESTOR_ROWS_SQL = `WITH RECURSIVE up(id,parent_id) AS (
           SELECT id,parent_id FROM ot.agents WHERE id=$1
           UNION SELECT a.id,a.parent_id FROM ot.agents a JOIN up u ON a.id=u.parent_id),
         root_first(id,depth) AS (
           SELECT id,0 FROM up WHERE parent_id IS NULL
           UNION ALL SELECT u.id,r.depth+1 FROM up u JOIN root_first r ON u.parent_id=r.id)
         SELECT a.id FROM ot.agents a JOIN root_first r ON a.id=r.id
         ORDER BY r.depth FOR UPDATE OF a`

export function assertCanonicalAncestorQuery(source) {
  const start = source.indexOf('async fn locked_ancestor_rows(')
  const end = start < 0 ? -1 : source.indexOf('\n}', start)
  if (end < 0) throw Error('Canonical locked_ancestor_rows helper is missing; recheck instrument')
  const normalized = value => value.replace(/\s+/g, ' ').trim()
  const body = normalized(source.slice(start, end))
  const template = normalized(LOCKED_ANCESTOR_ROWS_SQL.replace('SELECT a.id FROM', 'SELECT {columns} FROM'))
  if (!body.includes('"' + template + '"') || !body.includes('&[&id]')) {
    throw Error('Canonical locked_ancestor_rows query or binds changed; recheck instrument')
  }
}

export function lockedAncestorRowsQuery(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw Error('Positive safe integer ancestor identity required')
  return LOCKED_ANCESTOR_ROWS_SQL.replace(/\$(\d+)\b/g, (_, index) => {
    if (index !== '1') throw Error('Unexpected canonical ancestor query parameter $' + index)
    return String(id)
  })
}
