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
  const rows = [], dynamic = []
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
    const line = text.slice(0, match.index).split('\n').length
    if (literal) rows.push({ label: literal.slice(1).find(value => value !== undefined), line })
    else {
      const start = /\slabel\s*=\s*\{/.exec(tag)
      if (start) {
        let nest = 1, quoted = '', escape = false, cursor = start.index + start[0].length
        const from = cursor
        for (; cursor < tag.length && nest; cursor++) {
          const c = tag[cursor]
          if (quoted) {
            if (escape) escape = false
            else if (c === '\\') escape = true
            else if (c === quoted) quoted = ''
          } else if (c === '"' || c === "'" || c === '`') quoted = c
          else if (c === '{') nest++
          else if (c === '}') nest--
        }
        if (nest) throw new Error(`unclosed setting label near line ${line}`)
        const functions = [...text.slice(0,match.index).matchAll(/^(?:export\s+)?(?:default\s+)?(?:function|class)\s+([A-Z]\w*)\b/gm)]
        const component = functions.at(-1)?.[1]
        if (!component) throw new Error(`setting label has no component near line ${line}`)
        dynamic.push({ component, label: tag.slice(from,cursor-1).replace(/\s+/g,' ').trim(), line })
      }
    }
  }
  return { rows, dynamic }
}

export function sourceInventory(repo) {
  const components = [], labels = [], dynamicLabels = []
  for (const file of filesUnder(repo, rendererRoot).filter(file => file.endsWith('.tsx') && !file.startsWith(privateRendererRoot))) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    // React components start with a capital. This excludes exported helpers such
    // as pinModal/openPhonePanel/useContextMenu that happen to share a suffix.
    for (const match of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Z]\w*(?:Panel|Modal|Dialog|View|Page|Sheet|Desk|Menu|Picker))\b/g)) {
      components.push(`${file}#${match[1]}`)
    }
    const setting = settingLabels(text)
    labels.push(...setting.rows.map(row => ({ file, ...row })))
    dynamicLabels.push(...setting.dynamic.map(row => ({ file, ...row })))
  }
  // The same generated Orgtree-group controls serve agent settings and hire
  // defaults. Enumerate their source labels so a new group needs a skill home.
  const groupFile = `${rendererRoot}/canvas/modals.tsx`
  const groupSource = fs.readFileSync(path.join(repo, groupFile), 'utf8')
  const groups = groupSource.match(/const ORGTREE_GROUPS[^=]*=\s*\[([\s\S]*?)\n\]/)?.[1]
  if (!groups) throw new Error('cannot locate Orgtree tool-group controls')
  for (const match of groups.matchAll(/\['[^']+',\s*'([^']+)'/g)) {
    labels.push({ file: groupFile, label: match[1] })
  }
  // Notification rows are generated from this shared contract, not JSX literals.
  const notifications = 'packages/contracts/notifications.ts'
  for (const match of fs.readFileSync(path.join(repo, notifications), 'utf8').matchAll(/\{ key: '[^']+', label: '([^']+)', default: (?:true|false) \}/g)) {
    labels.push({ file: notifications, label: match[1] })
  }
  // Activity sound controls use their own generated preference options.
  const activitySounds = 'packages/contracts/activity-sounds.ts'
  for (const match of fs.readFileSync(path.join(repo, activitySounds), 'utf8').matchAll(/\{ key: '[^']+', label: '([^']+)'/g)) {
    labels.push({ file: activitySounds, label: match[1] })
  }
  return { components: components.sort(), labels, dynamicLabels }
}
