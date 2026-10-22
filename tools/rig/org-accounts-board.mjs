// Synthetic org-accounts oracle: replay displayed windows, never search the
// entire prompt for an account that may be named by a removal notice.
export function replayUsageBoards(prompts) {
  let seq, full, accounts, current, tier
  let rows = new Map(), removed = [], fulls = 0, deltas = 0
  const errors = []
  for (const prompt of prompts) {
    const block = prompt.match(/\[PROVIDER USAGE([^\]\n]*)\](?:\r?\n([\s\S]*?)\[END PROVIDER USAGE\])?/)
    if (!block) { errors.push('missing usage block'); continue }
    const [, header, body = ''] = block
    const delta = / DELTA /.test(header), reference = /unchanged since/.test(header)
    const number = Number(header.match(/#(\d+)/)?.[1])
    if (delta || reference) {
      const since = Number(header.match(/since #(\d+)/)?.[1])
      const lastFull = Number(header.match(/last full #(\d+)/)?.[1])
      if (!fulls || since !== seq || lastFull !== full) errors.push('missing or mismatched baseline')
      if (delta) deltas++
    } else {
      full = number; rows = new Map(); accounts = undefined; current = undefined; tier = undefined; fulls++
    }
    seq = number
    removed = []
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('[ACCOUNTS] ')) {
        accounts = line.slice('[ACCOUNTS] '.length).split(' · ').map(a => a.split(' ')[0])
      } else if (line.startsWith('Removed: ')) {
        const label = line.slice('Removed: '.length), parts = label.split('|')
        if (parts.length < 2) { errors.push('unexpected non-window removal'); continue }
        const key = `${parts[0]}|${parts.at(-1)}`
        if (!rows.delete(key)) errors.push(`removal has no baseline row: ${label}`)
        removed.push(label)
      } else {
        const cells = line.split(' | ')
        if (cells.length === 7 && cells[0] !== 'account') {
          const account = cells[0].replace(/\*$/, '')
          rows.set(`${account}|${cells[1]}`, { account, window: cells[1], text: line })
        }
      }
    }
    const route = body.match(/Your turns run on (\S+) \(tier ([^)]+)\)/)
      ?? header.match(/turn account (\S+), tier ([^;\]]+)/)
    if (route) { current = route[1]; tier = route[2] }
    if (!accounts?.length || !current || !tier) errors.push('missing active-account or route data')
    if (accounts && new Set(accounts).size !== accounts.length) errors.push('duplicate active account')
    if (accounts?.some(id => ![...rows.values()].some(row => row.account === id))) errors.push('active account has no window data')
    if (accounts && [...rows.values()].some(row => !accounts.includes(row.account))) errors.push('window account absent from active roster')
  }
  return { valid: errors.length === 0 && fulls > 0, errors, seq, full, fulls, deltas,
    accounts: accounts ?? [], current, provider: current?.split(/[/-]/)[0], tier,
    rows: [...rows.values()], removed }
}

export const hasAccountData = (board, account) => board.rows.some(row => row.account === account)
