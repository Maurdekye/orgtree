// The built-in documentation guard deliberately uses only Node built-ins.
import fs from 'node:fs'
import path from 'node:path'

export const rendererRoot = 'apps/desktop/renderer/src'
const privateRendererRoot = `${rendererRoot}/epic/`

export function filesUnder(repo, dir) {
  return fs.readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`
    return entry.isDirectory() ? filesUnder(repo, relative) : [relative]
  }).sort()
}

// Read a complete opening JSX tag. A > inside an arrow callback or quoted hint
// is not the end of the tag; a regex ending at the first > misses those rows.
function settingLabels(text) {
  const rows = []
  for (const match of text.matchAll(/<(SetRow|SetToggle|SetBlock|LimitRow)\b/g)) {
    let depth = 0, quote = '', escaped = false, end = match.index + match[0].length
    for (; end < text.length; end++) {
      const c = text[end]
      if (quote) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    const tag = text.slice(match.index, end + 1)
    const literal = tag.match(/\slabel\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*"([^"]+)"\s*\}|\{\s*'([^']+)'\s*\}|\{<\w+\b[^>]*>([^<{}]+)<\/\w+>\})/)
    if (literal) rows.push({ label: literal.slice(1).find(value => value !== undefined), line: text.slice(0, match.index).split('\n').length })
  }
  return rows
}

export function sourceInventory(repo) {
  const components = [], labels = []
  for (const file of filesUnder(repo, rendererRoot).filter(file => file.endsWith('.tsx') && !file.startsWith(privateRendererRoot))) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    // React components start with a capital. This excludes exported helpers such
    // as pinModal/openPhonePanel/useContextMenu that happen to share a suffix.
    for (const match of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Z]\w*(?:Panel|Modal|Dialog|View|Page|Sheet|Desk|Menu|Picker))\b/g)) {
      components.push(`${file}#${match[1]}`)
    }
    labels.push(...settingLabels(text).map(row => ({ file, ...row })))
  }
  // Notification rows are generated from this shared contract, not JSX literals.
  const notifications = 'packages/contracts/notifications.ts'
  for (const match of fs.readFileSync(path.join(repo, notifications), 'utf8').matchAll(/\{ key: '[^']+', label: '([^']+)', default: (?:true|false) \}/g)) {
    labels.push({ file: notifications, label: match[1] })
  }
  return { components: components.sort(), labels }
}
