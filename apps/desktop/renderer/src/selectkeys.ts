// selectkeys.ts — THE KEYS AND THE PRIVACY OF AN IN-PAGE DROPDOWN LIST.
//
// Every single-choice <select> draws its option list inside the window (styles.css: `appearance: base-select` on the
// select and its picker; user 2026-11-19 m6a2395ab50fb "Everywhere", after the OS pop-up of a native select took 0 of
// 20 controller clicks on the Steam Frame). The list is Chromium's own, so opening, the highlight, type-ahead, Enter
// and Escape are the browser's. Two things are not what a native Windows select does, and this module restores them.
//
// 1. KEYS ON A CLOSED CONTROL. In-page, Up and Down OPEN the list and Home/End do nothing; natively they change the
//    value. Here Up/Down/Home/End/Page Up/Page Down change the value, pass over what cannot be chosen, and fire one
//    `input` and one `change` as a native select does, so every React `onChange` runs as before. Plain Enter opens the
//    list (the user's ruling, look choice 6), except in a <form>, where Enter stays the form's, and except when the
//    page consumed the key (a dialog that confirms on Enter).
//
// 2. THE OPEN LIST OWNS ITS INPUT, AS THE OS POP-UP DID. A native list is another OS window: the page never saw a key,
//    a wheel turn or a press while it was open. In-page, the options are ordinary elements INSIDE the select, so every
//    one of those events bubbles through the select's ancestors: Escape would close the panel behind the list (useEsc
//    listens on the window), a wheel turn over a long list would zoom the canvas, Tab would run a focus trap with the
//    focus on an <option> it does not know. So while a list is open its keys and wheel, and every press on its
//    options, stop HERE, at the window, before anything else. They are never `preventDefault`ed: the browser still acts
//    on them. ⚠ This is why the install must be the window's FIRST capture listener (main.tsx installs it before React;
//    popout.tsx before a surface is mounted in the new window).
//
//    Tab is the one key the browser does less with than a native select: it closes the list and leaves focus on the
//    control, without taking the highlighted choice. Here Tab takes the highlighted choice, and once the browser has
//    closed the list the page is offered that Tab once more FROM THE CONTROL (a synthetic keydown), so a focus trap
//    handles it exactly as a Tab on a closed select; if nothing takes it, focus goes to the next tab stop. A script
//    cannot make the browser perform its own Tab, and a synthetic click on an option does not choose it (both measured
//    in Electron 44.11.3, 2026-11-19).
//
// A `multiple` or sized select is an in-page list box with its own keys and no pop-up: nothing here touches it.
// jsdom has no `:open` and no in-page list; selectkeys.test.ts states "open" itself, and selectinpage.capture.cjs
// measures the real thing in a real window.

const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const
/** what a press on an option would otherwise hand to the select's ancestors */
const PRESS_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const
const TAB_STOPS = 'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]'

/** The single-choice select an event belongs to: the target itself or the one whose list the target is part of.
 *  Tag names, never `instanceof`: a popped-out window's elements belong to another realm's classes. */
function ownerSelect(target: EventTarget | null): HTMLSelectElement | null {
  const node = target as Node | null
  const element = node?.nodeType === 1 ? node as Element : null
  const select = element?.closest?.('select') as HTMLSelectElement | null | undefined
  return select && !select.multiple && select.size <= 1 ? select : null
}

function listOpen(select: HTMLSelectElement): boolean {
  try { return select.matches(':open') } catch { return false }   // an engine without the in-page list has none open
}

const usable = (option: HTMLOptionElement) => !option.disabled
  && !(option.parentElement?.localName === 'optgroup' && (option.parentElement as HTMLOptGroupElement).disabled)

/** Change the value as the user's own choice: `input` then `change`, bubbling, once, and only for a real change. */
function choose(select: HTMLSelectElement, option: HTMLOptionElement | undefined): void {
  if (!option || option.selected) return
  option.selected = true
  const view = select.ownerDocument.defaultView ?? window
  select.dispatchEvent(new view.Event('input', { bubbles: true }))
  select.dispatchEvent(new view.Event('change', { bubbles: true }))
}

function closedKey(event: KeyboardEvent, select: HTMLSelectElement): void {
  if (event.altKey || event.ctrlKey || event.metaKey || select.disabled) return
  const choices = [...select.options].filter(usable)
  const at = choices.indexOf(select.selectedOptions[0] as HTMLOptionElement)
  let to: HTMLOptionElement | undefined
  switch (event.key) {
    case 'ArrowDown': to = choices[Math.min(choices.length - 1, at + 1)]; break
    // from a current choice that cannot itself be chosen (a disabled placeholder), Up goes nowhere, as natively
    case 'ArrowUp': to = at < 0 ? undefined : choices[Math.max(0, at - 1)]; break
    case 'Home': case 'PageUp': to = choices[0]; break
    case 'End': case 'PageDown': to = choices[choices.length - 1]; break
    default: return
  }
  // consumed even at either end: left alone, the browser would open the list on Up and Down
  event.preventDefault()
  choose(select, to)
}

/** Visible to the keyboard, asked in the element's own document (a popped-out window's layout is its own). */
function reachable(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false
  const view = element.ownerDocument.defaultView
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = view?.getComputedStyle(current)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
  }
  return true
}

const offered = new WeakSet<Event>()

/** After the browser closed the list on Tab: let the page handle a Tab from the control, else go to the next stop. */
function moveOn(select: HTMLSelectElement, backward: boolean): void {
  const doc = select.ownerDocument, view = doc.defaultView
  // only while the browser left focus where a Tab in an open list leaves it; anything else took focus on purpose
  if (!view || !select.isConnected || doc.activeElement !== select || listOpen(select)) return
  const tab = new view.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: backward, bubbles: true, cancelable: true })
  offered.add(tab)
  select.dispatchEvent(tab)
  if (tab.defaultPrevented || doc.activeElement !== select) return   // a focus trap, or whoever else owns Tab here
  const stops = [...doc.querySelectorAll<HTMLElement>(TAB_STOPS)].filter(stop => stop === select || reachable(stop))
  const at = stops.indexOf(select)
  if (at < 0 || stops.length < 2) return
  stops[(at + (backward ? -1 : 1) + stops.length) % stops.length]!.focus()
}

const installed = new WeakMap<Window, { count: number; remove: () => void }>()

/** Install for one window (the main one, or a popped-out one). Counted: a second install on the same window adds
 *  nothing, and the handling stays until every install has been undone. */
export function installSelectKeys(win: Window): () => void {
  let entry = installed.get(win)
  if (!entry) {
    const capture = (event: Event) => {
      if (offered.has(event)) return
      const select = ownerSelect(event.target)
      if (!select) return
      const open = listOpen(select)
      const key = event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
      if (open) {
        // a press on the control itself (it closes the list) stays the page's, as a press on a select always was
        if (!key && event.type !== 'wheel' && event.target === select) return
        event.stopImmediatePropagation()
        const pressed = event as KeyboardEvent
        if (event.type === 'keydown' && pressed.key === 'Tab' && !pressed.altKey && !pressed.ctrlKey && !pressed.metaKey) {
          const highlighted = (event.target as Element).closest('option') as HTMLOptionElement | null
          if (highlighted && usable(highlighted)) choose(select, highlighted)
          // a later task: after the browser's own handling of this key has closed the list
          win.setTimeout(() => moveOn(select, pressed.shiftKey), 0)
        }
        return
      }
      if (event.type === 'keydown' && event.target === select && !event.defaultPrevented) closedKey(event as KeyboardEvent, select)
    }
    // Enter is decided LAST, in the bubble phase: whoever in the page consumes Enter keeps it
    const enter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
        || event.repeat || event.isComposing) return
      const select = ownerSelect(event.target)
      if (!select || event.target !== select || select.disabled || select.form || listOpen(select)) return
      const picker = (select as HTMLSelectElement & { showPicker?: () => void }).showPicker
      if (typeof picker !== 'function') return
      event.preventDefault()
      try { picker.call(select) } catch { /* not allowed right now: nothing opens, as before */ }
    }
    for (const type of [...KEY_EVENTS, ...PRESS_EVENTS, 'wheel']) win.addEventListener(type, capture, true)
    win.addEventListener('keydown', enter as EventListener)
    entry = { count: 0, remove: () => {
      for (const type of [...KEY_EVENTS, ...PRESS_EVENTS, 'wheel']) win.removeEventListener(type, capture, true)
      win.removeEventListener('keydown', enter as EventListener)
    } }
    installed.set(win, entry)
  }
  entry.count++
  const mine = entry
  let done = false
  return () => {
    if (done) return
    done = true
    if (--mine.count === 0) { mine.remove(); if (installed.get(win) === mine) installed.delete(win) }
  }
}
