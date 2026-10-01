// attention/dom.ts — the one DOM helper both Attention panels need.
//
// Its own file rather than a shared export from either panel: the queue panel
// must not pull the Desk's module graph in just to move focus.

/** Move focus to the element carrying `attr="value"`, by SCANNING rather than
 *  by building a selector.
 *
 *  ⚠ NOT `CSS.escape`. An agent id and a row key are data, so neither can be
 *  interpolated into a selector unescaped — and `CSS` is a host object that is
 *  simply ABSENT in some environments (it is not on jsdom's global, which is
 *  where this renderer's suites run). A missing global there is a thrown
 *  ReferenceError inside a keydown handler: keyboard navigation that dies
 *  silently, on the machine least able to report it. Scanning has neither
 *  problem, and the lists it walks are a screenful.
 *
 *  ⚠ MEASURED, not assumed: attentiondesk.test.tsx's first run threw
 *  `ReferenceError: CSS is not defined` four times out of the list's own arrow
 *  keys while the assertions still passed, because the throw happened after
 *  the selection had already moved. A helper that only breaks the FOCUS is
 *  exactly the kind that gets shipped. */
export function focusByAttr(root: Element | null, attr: string, value: string): void {
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    if (el.getAttribute(attr) === value) { el.focus(); return }
  }
}
