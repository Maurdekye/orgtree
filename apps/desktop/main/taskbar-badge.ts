import { addAttentionDot } from './tray-dot'

export interface BadgeWindow<Image> {
  isDestroyed(): boolean
  setOverlayIcon(image: Image | null, description: string): void
}
export interface BadgeOptions<Image> {
  platform: string
  windows(): readonly BadgeWindow<Image>[]
  dot(): Image
  dockBadge?(text: string): void
  badgeCount?(count: number): void
}
export interface BadgeFeed {
  attentionTotal(): number
  allNotices(): readonly unknown[]
}
/** The existing attention summary includes unseen mentions too. Notice mail
 * is the complete unread user-inbox inventory, independent of toast settings. */
export function needsTaskbarDot(feed: BadgeFeed): boolean {
  if (feed.attentionTotal() > 0) return true
  return feed.allNotices().some(notice => {
    if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return false
    const kind = (notice as { kind?: unknown }).kind
    return kind === 'routine' || kind === 'urgent-mail' || kind === 'terminal-failure'
      || kind === 'question' || kind === 'work-attention' || kind === 'mention'
  })
}

/** Crop the existing tray dot to a centered 16px Windows overlay, retaining
 * its red fill, light rim and transparent corners. Bitmap format is BGRA. */
export function taskbarDotBitmap(): Buffer {
  const source = addAttentionDot(Buffer.alloc(32 * 32 * 4), 32, 32)
  const bitmap = Buffer.alloc(16 * 16 * 4)
  for (let y = 0; y < 16; y++) source.copy(bitmap, y * 16 * 4, (y * 32 + 16) * 4, (y * 32 + 32) * 4)
  return bitmap
}

/** Persistent app-wide state, separate from the arrival/focus taskbar pulse.
 * Native writes happen only on a boolean transition or for a new window. */
export class TaskbarDot<Image> {
  private active = false
  private published: boolean | undefined
  private image: Image | undefined
  private windows = new WeakMap<BadgeWindow<Image>, boolean>()
  constructor(private options: BadgeOptions<Image>) {}

  set(active: boolean): void {
    this.active = active
    if (this.options.platform === 'win32') {
      for (const window of this.options.windows()) this.apply(window)
    } else if (this.published !== active) {
      try {
        if (this.options.platform === 'darwin') this.options.dockBadge?.(active ? '•' : '')
        else if (this.options.platform === 'linux') this.options.badgeCount?.(active ? 1 : 0)
      } catch { return } // An unavailable platform badge must not break app-feed delivery.
    }
    this.published = active
  }

  apply(window: BadgeWindow<Image>): void {
    if (this.options.platform !== 'win32' || window.isDestroyed()
        || this.windows.get(window) === this.active) return
    try {
      const image = this.active ? (this.image ??= this.options.dot()) : null
      window.setOverlayIcon(image, this.active ? 'Unread messages or items need your attention' : '')
      this.windows.set(window, this.active)
    } catch {
      // A window may close between the destroyed check and the native write.
      // Leave it uncached so a surviving window can retry on the next feed.
    }
  }
}
