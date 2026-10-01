import type { BrowserWindow } from 'electron'

export function appUserModelId(packaged: boolean): string {
  return packaged ? 'com.maurdekye.orgtree' : 'com.maurdekye.orgtree.dev'
}

export function configureTaskbar(window: BrowserWindow, executable: string, icon: string,
                                 appId = appUserModelId(true), displayName = 'Orgtree'): void {
  window.setAppDetails({
    appId, appIconPath: icon, appIconIndex: 0,
    relaunchCommand: `"${executable}"`, relaunchDisplayName: displayName,
  })
}

/** One-image .ico wrapping PNG bytes, so a recoloured eye can be handed to the
 *  shell as a file. A size of 256 or more is stored as 0, as the format wants. */
export function icoFromPng(png: Buffer, width: number, height: number): Buffer {
  const head = Buffer.alloc(22)
  head.writeUInt16LE(1, 2)                       // type: icon
  head.writeUInt16LE(1, 4)                       // one image
  head[6] = width >= 256 ? 0 : width
  head[7] = height >= 256 ? 0 : height
  head.writeUInt16LE(1, 10)                      // colour planes
  head.writeUInt16LE(32, 12)                     // bits per pixel
  head.writeUInt32LE(png.length, 14)
  head.writeUInt32LE(22, 18)                     // image data offset
  return Buffer.concat([head, png])
}
