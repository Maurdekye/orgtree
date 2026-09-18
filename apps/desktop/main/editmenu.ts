// main/editmenu.ts — THE EDITING CONTEXT MENU (user request 2026-09-18: "i
// should be able to copy cut and paste using the context menu in textboxes
// throughout the app").
//
// WHY THIS LIVES IN THE MAIN PROCESS and not in `canvas/contextmenu.tsx` with
// every other menu in the app. The renderer already declines editable fields on
// purpose — `nativeMenuPreferred` returns true for them and `open` returns
// without `preventDefault`, handing the press to the native menu. That was the
// right rule and it landed on nothing, because Electron shows no context menu
// of its own unless the main process pops one. This is the menu it was
// deferring to. Measured before writing any of it, in Electron 44.2.0: a
// `webContents` carries zero `context-menu` listeners until something adds one.
//
// The renderer COULD NOT do this job. `configureEngineSession` in windows.ts
// permits exactly one permission, `clipboard-sanitized-write`, and denies
// clipboard READS outright — so `navigator.clipboard.readText()` is refused in
// every app document, and Chromium blocks `document.execCommand('paste')` for
// web content regardless. A renderer menu could offer a Paste item that could
// never paste.
//
// ENABLEMENT IS CHROMIUM'S, NOT OURS. `params.editFlags` is measured state, not
// a guess, and the two gates the ticket asks for both come from it:
//   * `canPaste` is FALSE when the clipboard holds no text and true when it
//     does — Blink consults the clipboard itself;
//   * `canSelectAll` is FALSE in an empty field and true in a filled one;
//   * `canCut`/`canCopy` are false without a selection;
//   * `isEditable` is FALSE for readonly and for disabled inputs, which is the
//     "those two offer no Cut and no Paste" rule for free.
// Re-derive none of that here. A flag we computed ourselves would be a second
// opinion about the field Chromium is already looking at.
//
// THE TEMPLATE IS A PURE FUNCTION so the rules can be tested without standing
// up Electron (tests/edit-menu.test.mjs), and the wiring is proven separately
// against the real thing (tests/electron.probe.ts, `npm run test:electron`),
// where Paste is shown to put actual characters into an actual field.

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** The slice of Electron's `context-menu` params the rules below read. */
export interface EditMenuParams {
  isEditable: boolean
  selectionText: string
  editFlags: {
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

/** The four operations, taken from the webContents the press came from rather
 *  than from a menu `role`. A role acts on whatever window Electron considers
 *  focused; a popout menu must act on the popout that was clicked in, and this
 *  is how it is said explicitly instead of assumed. */
export interface EditTarget {
  cut(): void
  copy(): void
  paste(): void
  selectAll(): void
}

/** The menu for one press, or `null` for no menu at all.
 *
 *  TWO CASES, and deliberately no third:
 *   - an EDITABLE field gets the full set. Every entry is present so the menu
 *     has a stable shape, and each is enabled only where Chromium says the
 *     operation would do something;
 *   - a press with a LIVE SELECTION outside an editable field gets Copy alone.
 *     `nativeMenuPreferred` defers a selection to the native menu for the same
 *     reason it defers a field, so that deferral was dead in the same way. Only
 *     Copy: Select All on a non-editable document selects the whole page, which
 *     is not a thing anyone right-clicked a paragraph to ask for.
 *
 *  Anything else opens nothing, which leaves an ordinary right-click on the
 *  canvas, a card or a desk row exactly as it is today — those surfaces have
 *  their own menus and prevent the event long before it reaches us. */
export function editMenuTemplate(params: EditMenuParams, target: EditTarget): MenuItemConstructorOptions[] | null {
  const flags = params.editFlags
  if (params.isEditable) {
    return [
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', registerAccelerator: false, enabled: flags.canCut, click: () => target.cut() },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, enabled: flags.canCopy, click: () => target.copy() },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', registerAccelerator: false, enabled: flags.canPaste, click: () => target.paste() },
      { type: 'separator' },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', registerAccelerator: false, enabled: flags.canSelectAll, click: () => target.selectAll() },
    ]
  }
  if (params.selectionText) {
    return [
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, enabled: flags.canCopy, click: () => target.copy() },
    ]
  }
  return null
}

/** Give `window` the editing menu. Called once per window from
 *  `configureWindow`, which already recurses into every popout — so this covers
 *  the main window and each popped-out surface with no registry of its own.
 *
 *  ⚠ NOTHING CONVERTS COORDINATES, for the same reason `contextmenu.tsx` says
 *  it about the renderer's menus: `params.x`/`params.y` are client coordinates
 *  in the pressed window's own viewport and `popup` takes them in that window,
 *  so a second monitor at another DPI cancels out. Screen-space arithmetic here
 *  is what WOULD break mixed DPI.
 *
 *  A keyboard raise — Shift+F10, the ContextMenu key — arrives as the same
 *  `context-menu` event carrying the focused element's own coordinates, so it
 *  needs no separate path and gets the identical menu. */
export function attachEditMenu(window: BrowserWindow): void {
  const contents = window.webContents
  contents.on('context-menu', (_event, params) => {
    const template = editMenuTemplate(params, contents)
    if (!template || window.isDestroyed()) return
    Menu.buildFromTemplate(template).popup({ window, x: params.x, y: params.y })
  })
}
