import type { BrowserWindow, WebContentsView } from 'electron'
import { nativeStreamerOn, watchNativeStreamer } from './streamer-native'

const DISMISS = 'https://streamer-dismiss.invalid/'
const PAGE = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{height:100%;margin:0;background:#292929;color:white;font:14px system-ui}body{display:flex;align-items:center;justify-content:center;gap:16px}a{color:white;border:1px solid #888;padding:6px 12px;text-decoration:none}</style><span>Hidden in Streamer mode</span><a href="'+DISMISS+'" aria-label="Dismiss cover for this surface">×</a>'
/** Native artifact windows have no app bridge. A separate, inert compositor
 * view covers them without changing their DOM, capabilities or running content. */
export function protectOpaqueWindow(window: BrowserWindow, create: () => WebContentsView) {
  let cover: WebContentsView | null = null, dismissed = false, wasOn = nativeStreamerOn()
  const remove = () => {
    if (!cover) return
    const previous = cover; cover = null
    if (!window.isDestroyed()) window.contentView.removeChildView(previous)
    if (!previous.webContents.isDestroyed()) previous.webContents.close()
  }
  const fit = () => { if (cover && !window.isDestroyed()) { const [width,height] = window.getContentSize(); cover.setBounds({x:0,y:0,width,height}) } }
  const update = () => {
    const on = nativeStreamerOn()
    if (!on || on !== wasOn) dismissed = false
    wasOn = on
    if (!on || dismissed || window.isDestroyed()) { remove(); return }
    if (cover) return
    cover = create(); cover.setBackgroundColor('#292929')
    // The opaque background is installed synchronously, before underlying content loads.
    window.contentView.addChildView(cover); fit()
    cover.webContents.setWindowOpenHandler(() => ({action:'deny'}))
    cover.webContents.on('will-navigate', (event, url) => { event.preventDefault(); if (url === DISMISS) { dismissed = true; remove() } })
    cover.webContents.on('will-redirect', event => event.preventDefault())
    cover.webContents.setAudioMuted(true)
    void cover.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE)).catch(() => { /* opaque background stays in place */ })
  }
  const stop = watchNativeStreamer(update)
  const dispose = () => { stop(); window.removeListener('resize', fit); remove() }
  window.on('resize', fit)
  window.on('closed', dispose)
  update()
  return dispose
}
/** Red-test scaffold: the holding-page cover is not yet tied to its document. */
export const protectOpaqueDocument = protectOpaqueWindow
