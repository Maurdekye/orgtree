import type { AppFeedState } from '../../../packages/contracts/app-feed'

export type TaskbarTarget = { kind: 'homepage' | 'create' } | { kind: 'org'; slug: string }
  | { kind: 'attention'; org: string; id: string }
export type TaskbarOrg = { slug: string; name: string; logo?: string }
export type TaskbarIcons = { home?: string; create?: string; mail?: string; ticket?: string; mention?: string; orgs?: Record<string, string> }
export type TaskbarAttentionItem = { org: string; id: string; title: string; icon: 'mail' | 'ticket' | 'mention' }
const PREFIX = '--orgtree-taskbar='
const SLUG = /^[a-z0-9@-]+$/

/** One argument, never a URL, shell command or renderer script. */
export function taskbarTarget(argv: readonly string[]): TaskbarTarget | null {
  const args = argv.filter(arg => arg.startsWith(PREFIX))
  if (args.length !== 1) return null
  const target = args[0].slice(PREFIX.length)
  if (target === 'home') return { kind: 'homepage' }
  if (target === 'new') return { kind: 'create' }
  if (target.startsWith('org:') && SLUG.test(target.slice(4))) return { kind: 'org', slug: target.slice(4) }
  if (target.startsWith('attention:') && target.length <= 2000 && /^[A-Za-z0-9_-]+$/.test(target.slice(10))) {
    try {
      const value: unknown = JSON.parse(Buffer.from(target.slice(10), 'base64url').toString('utf8'))
      if (!Array.isArray(value) || value.length !== 2) return null
      const [org, id] = value
      if (typeof org === 'string' && org.length <= 128 && SLUG.test(org)
          && typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\x00-\x1f]/.test(id))
        return { kind: 'attention', org, id }
    } catch { /* malformed shell arguments never become navigation */ }
  }
  return null
}

/** The same complete, current inventory as the badge. No banner preference,
 * renderer-local dismissal or notification history may hide a waiting item. */
export function taskbarAttentionItems(state: Pick<AppFeedState, 'allNotices'>): TaskbarAttentionItem[] {
  const seen = new Set<string>(), out: TaskbarAttentionItem[] = []
  for (const raw of state.allNotices()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const n = raw as Record<string, unknown>
    if (typeof n.org !== 'string' || n.org.length > 128 || !SLUG.test(n.org)
        || typeof n.id !== 'string' || !n.id || n.id.length > 200 || /[\x00-\x1f]/.test(n.id)) continue
    let icon: TaskbarAttentionItem['icon']
    if (n.kind === 'question' || n.kind === 'mention') {
      if (typeof n.agent !== 'string' || !n.agent) continue
      icon = n.kind === 'question' ? 'mail' : 'mention'
    } else if (n.kind === 'work-attention') {
      if (typeof n.item !== 'string' || !n.item) continue
      icon = 'ticket'
    } else if (['routine', 'urgent-mail', 'terminal-failure'].includes(n.kind as string)) icon = 'mail'
    else continue
    const key = JSON.stringify([n.org, n.id])
    if (seen.has(key)) continue
    seen.add(key)
    const title = typeof n.title === 'string' && n.title ? n.title : 'Needs your attention'
    out.push({ org: n.org, id: n.id, title: `${n.org}: ${title}`.replace(/[\x00-\x1f]/g, ' ').slice(0, 200), icon })
  }
  return out
}

/** Same slug order as the org switcher; trashed orgs are absent. Until its
 * summary arrives, a new org has the same slug fallback as the homepage. */
export function taskbarOrgs(state: AppFeedState): TaskbarOrg[] {
  return (state.registry?.records ?? []).filter(({ body }) => body.state === 'active' && SLUG.test(body.slug))
    .map(({ body }) => {
      const summary = state.summary(body)
      const logo = summary?.logo_sha256
      return { slug: body.slug, name: summary?.name || body.slug,
        ...(typeof logo === 'string' && /^[a-f0-9]{64}$/.test(logo) ? { logo } : {}) }
    })
    .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
}

/** Explicit custom category, followed by Windows' fixed Tasks section.
 * Names stay display text; only the validated slug goes into arguments. */
export function taskbarTasks(orgs: readonly TaskbarOrg[], exe: string, appPath?: string, icons: TaskbarIcons = {}, attention: readonly TaskbarAttentionItem[] = []): Electron.JumpListCategory[] {
  // Windows paths cannot contain quotes. Escape trailing slashes before the
  // closing quote for development's `electron.exe "<app path>"` invocation.
  const appArg = appPath ? `"${appPath.replace(/(\\+)$/, '$1$1')}" ` : ''
  const task = (title: string, target: string, description: string, iconPath = exe): Electron.JumpListItem => ({
    type: 'task', program: exe, args: appArg + PREFIX + target, title, description: description.slice(0, 260),
    iconPath, iconIndex: 0,
  })
  const items = [task('Home', 'home', 'Open the Orgtree homepage', icons.home),
    task('New org', 'new', 'Create a new organization', icons.create)]
  const current = orgs.filter(org => SLUG.test(org.slug))
  const recent = current.map(org => task(org.name || org.slug, `org:${org.slug}`, `Open ${org.name || org.slug}`,
    typeof icons.orgs?.[org.slug] === 'string' ? icons.orgs[org.slug] : undefined))
  const waiting = attention.map(entry => task(entry.title,
    'attention:' + Buffer.from(JSON.stringify([entry.org, entry.id])).toString('base64url'),
    `Open ${entry.title}`, icons[entry.icon]))
  return [...(waiting.length ? [{ type: 'custom' as const, name: 'Needs attention', items: waiting }]
    : recent.length ? [{ type: 'custom' as const, name: 'Recent', items: recent }] : []), { type: 'tasks', items }]
}
