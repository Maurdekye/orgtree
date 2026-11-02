import { nativeScreenText } from '../../../packages/contracts/streamer'

// Unknown at startup is protected until saved preferences have been read.
let enabled = true
const changed = new Set<() => void>()
const notices = new Set<{ close(): void }>()
export function trackStreamerNotice<T extends { close(): void; on(event: 'close', listener: () => void): unknown }>(notice: T): T {
  notices.add(notice); notice.on('close', () => notices.delete(notice)); return notice
}
export const nativeStreamerOn = () => enabled
export function setNativeStreamer(on: boolean) {
  if (on && !enabled) { for (const notice of notices) { try { notice.close() } catch { /* OS already removed it */ } } notices.clear() }
  enabled = on; for (const fn of changed) fn()
}

const safeActions = /^(?:OK|Cancel|Yes|No|Retry|Close|Back|Next|Continue|Open|Save|Discard|Quit|Restart|Undo|Redo|Cut|Copy|Paste|Paste as plain text|Delete|Select All|Add to dictionary|Check for updates|Automatic updates|Exit on close|Notifications|Harness setup|Quit Orgtree|Crash reports\.\.\.|Connect your phone…|Run as admin(?: \(changing…\))?|Run on (?:boot|sign-in)(?: \(changing…\))?|Restart engine)$/i
export function nativeMenuLabel(value: string): string { return enabled && !safeActions.test(value) ? nativeScreenText(value, true) : value }
export function nativeDialogOptions<T extends Record<string, unknown>>(value: T): T {
  if (!enabled) return value
  const result: Record<string, unknown> = { ...value }
  for (const key of ['title', 'message', 'detail', 'checkboxLabel']) if (typeof result[key] === 'string') result[key] = nativeScreenText(result[key], true)
  if (Array.isArray(result.buttons)) result.buttons = result.buttons.map((button, i) => typeof button === 'string' && safeActions.test(button) ? button : `Action ${i + 1}`)
  return result as T
}
/** One sink for application-owned dialogs. OS open/save pickers are explicitly excluded. */
export function protectNativeDialogs<T extends object>(api: T): T {
  return new Proxy(api, { get(target, key, receiver) {
    const fn = Reflect.get(target, key, receiver)
    if (typeof fn !== 'function' || !['showMessageBox', 'showMessageBoxSync', 'showErrorBox'].includes(String(key))) return fn
    return (...args: unknown[]) => {
      if (key === 'showErrorBox') return Reflect.apply(fn, target, args.map(v => typeof v === 'string' ? nativeScreenText(v, enabled) : v))
      const last = args.length - 1, value = args[last]
      if (value && typeof value === 'object') args[last] = nativeDialogOptions(value as Record<string, unknown>)
      return Reflect.apply(fn, target, args)
    }
  } })
}
/** Labels change at menu-will-show too: tray status refreshes can mutate built items. */
export function protectNativeMenus<T extends object>(api: T): T {
  return new Proxy(api, { get(target, key, receiver) {
    const fn = Reflect.get(target, key, receiver)
    if (key !== 'buildFromTemplate' || typeof fn !== 'function') return fn
    return (...args: unknown[]) => {
      const menu = Reflect.apply(fn, target, args) as { items: { label: string; submenu?: unknown }[]; on(event: string, fn: () => void): void }
      const originals = new Map<{ label: string }, string>()
      const restore = () => { for (const [item, text] of originals) if (item.label === nativeScreenText(text, true)) item.label = text; originals.clear() }
      const mask = () => {
        restore()
        if (!enabled) return
        const visit = (m: typeof menu) => { for (const item of m.items) {
          const text = item.label, safe = nativeMenuLabel(text)
          if (safe !== text) { originals.set(item, text); item.label = safe }
          if (item.submenu) visit(item.submenu as typeof menu)
        } }
        visit(menu)
      }
      menu.on('menu-will-show', mask); menu.on('menu-will-close', restore)
      return menu
    }
  } })
}
interface TitleWindow {
  isDestroyed(): boolean; getTitle(): string; setTitle(title: string): void
  on(event: 'page-title-updated', listener: (event: { preventDefault(): void }, title: string) => void): unknown
  on(event: 'closed', listener: () => void): unknown
}
export function protectNativeTitle(window: TitleWindow) {
  let original = window.getTitle()
  const apply = () => { if (!window.isDestroyed()) window.setTitle(enabled ? 'Orgtree — Streamer mode' : original) }
  window.on('page-title-updated', (event, title) => { original = title; if (enabled) { event.preventDefault(); apply() } })
  changed.add(apply); window.on('closed', () => changed.delete(apply)); apply()
}
