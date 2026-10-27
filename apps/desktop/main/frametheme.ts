import { frameThemeCss, isFrameTheme } from '../../../packages/contracts/frame-theme'

/** What the keeper uses of a viewer's webContents. */
export interface ThemedContents {
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  isDestroyed(): boolean
  on(event: 'dom-ready', listener: () => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

/** HTML presentation windows ("Open in a new window") get the colors the
 *  inline reader posts into its frame (USER 2026-10-27 m4e1fae02a0ca,
 *  m164909566caf). The viewer has no bridge or preload and its page keeps the
 *  engine's sandbox CSP; an inserted stylesheet needs neither. The renderer
 *  reports each change (desktop:set-frame-theme); every open viewer's sheet is
 *  replaced in place, so the presentation keeps its own state. */
export function artifactThemeKeeper() {
  let css: string | null = null
  // load counts the viewer's documents (0: none yet); key and sheet belong to the current one.
  const viewers = new Map<ThemedContents, { load: number; key?: string; sheet?: string; chain: Promise<void> }>()
  const paint = (contents: ThemedContents) => {
    const viewer = viewers.get(contents)
    if (!viewer) return
    // One insertion at a time per viewer, so an older sheet never lands last.
    viewer.chain = viewer.chain.then(async () => {
      const sheet = css, load = viewer.load
      if (sheet === null || !load || sheet === viewer.sheet || contents.isDestroyed() || viewers.get(contents) !== viewer) return
      const key = await contents.insertCSS(sheet)
      if (load !== viewer.load) return // that document is gone; its load paints the new one
      const previous = viewer.key
      viewer.key = key
      viewer.sheet = sheet
      if (previous) await contents.removeInsertedCSS(previous)
    }).catch(() => { /* a closing viewer; the next load paints again */ })
  }
  return {
    /** Validates the renderer's report; an unchanged sheet does nothing. */
    set(value: unknown): void {
      if (!isFrameTheme(value)) throw new Error('Unknown frame theme')
      const next = frameThemeCss(value)
      if (next === css) return
      css = next
      for (const contents of viewers.keys()) paint(contents)
    },
    /** Before the viewer loads: each new document starts without our sheet. */
    follow(contents: ThemedContents): void {
      viewers.set(contents, { load: 0, chain: Promise.resolve() })
      contents.on('dom-ready', () => {
        const viewer = viewers.get(contents)
        if (!viewer) return
        viewer.load++
        viewer.key = undefined
        viewer.sheet = undefined
        paint(contents)
      })
      contents.once('destroyed', () => { viewers.delete(contents) })
    },
  }
}
