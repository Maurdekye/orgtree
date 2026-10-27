// canvas/refmarks.tsx — the icon a mention wears on its left, telling its kind
// at a glance the way an agent mention's model badge does (USER 2026-10-27
// m6d0cdc7a2be6 "style the mention uniquely ... like how agent mentions are
// styled", m33e4a043b457 "tickets / presentations ... with an icon to the left").
//
// Agents keep their model badge and projects their folder mark (identity.tsx).
// Every other kind gets one of these. The React chip and the DOM chip that the
// Markdown walk builds draw the SAME element, so both carry the path data of
// the app's own MUI icons rather than the icon components.

/** The MUI icon of each kind, as path data: the one the app already shows for
 *  it, and for a panel the outlined window. */
export const REF_MARK_PATHS = {
  // DocketIcon (AssignmentOutlined): the docket and the @ list's ticket rows
  item: 'M7 15h7v2H7zm0-4h10v2H7zm0-4h10v2H7zm12-4h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-.14 0-.27.01-.4.04-.39.08-.74.28-1.01.55-.18.18-.33.4-.43.64-.1.23-.16.49-.16.77v14c0 .27.06.54.16.78s.25.45.43.64c.27.27.62.47 1.01.55.13.02.26.03.4.03h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-7-.25c.41 0 .75.34.75.75s-.34.75-.75.75-.75-.34-.75-.75.34-.75.75-.75M19 19H5V5h14z',
  // DocIcon (DescriptionOutlined): presentations and the Documents button
  doc: 'M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z',
  // AppsIcon (Apps): the Apps button and every app row
  app: 'M4 8h4V4H4zm6 12h4v-4h-4zm-6 0h4v-4H4zm0-6h4v-4H4zm6 0h4v-4h-4zm6-10v4h4V4zm-6 4h4V4h-4zm6 6h4v-4h-4zm0 6h4v-4h-4z',
  // WebAssetOutlined: one window of an app
  panel: 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2m0 14H5V8h14z',
} as const
export type RefMarkKind = keyof typeof REF_MARK_PATHS

export const hasRefMark = (kind: string): kind is RefMarkKind => kind in REF_MARK_PATHS

const SVG = 'http://www.w3.org/2000/svg'

/** The mark as DOM, for chips built outside React. Never parses markup. */
export function createRefMarkEl(doc: Document, kind: RefMarkKind): HTMLElement {
  const span = doc.createElement('span')
  span.className = `ref-mark ref-mark-${kind}`
  span.setAttribute('aria-hidden', 'true')
  const svg = doc.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'MuiSvgIcon-root MuiSvgIcon-fontSizeInherit')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('width', '1em')
  svg.setAttribute('height', '1em')
  const path = doc.createElementNS(SVG, 'path')
  path.setAttribute('d', REF_MARK_PATHS[kind])
  svg.appendChild(path)
  span.appendChild(svg)
  return span
}

/** The same mark in React. */
export function RefMark({ kind }: { kind: RefMarkKind }) {
  return (
    <span className={`ref-mark ref-mark-${kind}`} aria-hidden="true">
      <svg className="MuiSvgIcon-root MuiSvgIcon-fontSizeInherit" focusable="false" aria-hidden="true"
        viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
        <path d={REF_MARK_PATHS[kind]} />
      </svg>
    </span>
  )
}
