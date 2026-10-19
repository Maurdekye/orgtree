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
// Test checkpoint: the previous desktop has no persistent taskbar badge.
export function needsTaskbarDot(_feed: BadgeFeed): boolean { return false }
export class TaskbarDot<Image> {
  constructor(_options: BadgeOptions<Image>) {}
  set(_active: boolean): void {}
  apply(_window: BadgeWindow<Image>): void {}
}
