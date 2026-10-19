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
/** USER 2026-10-19: taskbar dot and menu count attention-seeking items only.
 * Failure toast kind alone says nothing about urgency or a user mention. */
export function isTaskbarAttentionNotice(notice: unknown): boolean {
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return false
  const { kind, attention } = notice as { kind?: unknown; attention?: unknown }
  return kind === 'urgent-mail' || kind === 'question' || kind === 'work-attention'
    || kind === 'mention' || (kind === 'terminal-failure' && attention === true)
}

/** The existing summary already counts only questions, flags, urgent mail
 * and mentions. Notice rows cover updates before their summary arrives. */
export function needsTaskbarDot(feed: BadgeFeed): boolean {
  return feed.attentionTotal() > 0 || feed.allNotices().some(isTaskbarAttentionNotice)
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
      window.setOverlayIcon(image, this.active ? 'Items need your attention' : '')
      this.windows.set(window, this.active)
    } catch {
      // A window may close between the destroyed check and the native write.
      // Leave it uncached so a surviving window can retry on the next feed.
    }
  }
}
