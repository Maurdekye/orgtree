// The primary-click tray org list (user spec 2026-09-10): clicking the tray
// icon lists every organization as one row of aligned columns — an activity
// spinner (only while that org has agents executing a turn), the org name,
// and an always-visible n/m count where n = agents active right now and
// m = currently hired agents. Selecting a row opens that org in the main
// window, which restores the org's own saved pins, popouts and camera.
//
// A native Windows context menu cannot render an animated spinner or true
// columns (one proportional-font label per item), so the list is a small
// frameless always-on-top popup window. Its document is built HERE, as a
// complete data: URL — static HTML + CSS only, no scripts, no preload, no
// bridge: the popup never gets any capability beyond looking like a list.
// Row selection travels as a link navigation to a reserved .invalid origin
// that the main process intercepts and cancels (nothing is ever fetched);
// everything in this module is pure so the whole surface is testable
// without Electron.

export interface OrgActivityRow { slug: string; name: string; working: number; live: number }
export interface Rect { x: number; y: number; width: number; height: number }

// the backend's own org path-segment alphabet (api.py route patterns)
const SLUG_RE = /^[a-z0-9@-]+$/

/** Validate GET /api/orgs into tray rows, or null when the payload is not a
 *  well-formed listing (same all-or-nothing rule as Engine.stats): a half
 *  parsed list would silently drop organizations, and "some rows" is
 *  indistinguishable from "all rows" on screen. `working` is
 *  supervisor.working_count() and present on every admin row; it is still
 *  defaulted (not required) so a row deliberately built without it — the
 *  public listing shape — reads as idle rather than poisoning the list. */
export function orgActivityRows(raw: unknown): OrgActivityRow[] | null {
  if (!Array.isArray(raw)) return null
  const out: OrgActivityRow[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    if (typeof row.slug !== 'string' || !SLUG_RE.test(row.slug)) return null
    if (typeof row.name !== 'string') return null
    if (!Number.isInteger(row.live) || (row.live as number) < 0) return null
    const working = Number.isInteger(row.working) && (row.working as number) >= 0
      ? row.working as number : 0
    out.push({ slug: row.slug, name: row.name || row.slug, working, live: row.live as number })
  }
  return out
}

/** A reserved, non-resolvable origin (.invalid, RFC 2606): row hrefs are
 *  `<prefix><slug>`, the will-navigate/window-open interceptors cancel the
 *  navigation unconditionally and act only on URLs this parser accepts. */
export const TRAY_NAV_PREFIX = 'https://orgtree-tray.invalid/open/'
export function trayNavigationSlug(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith(TRAY_NAV_PREFIX)) return null
  const slug = url.slice(TRAY_NAV_PREFIX.length)
  return SLUG_RE.test(slug) ? slug : null
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const TRAY_ROW_H = 28
export const TRAY_LIST_W = 288
const TRAY_LIST_PAD = 12

/** The popup's complete document. One CSS grid holds every cell and the rows
 *  are `display: contents`, so all three columns align ACROSS rows (a grid
 *  per row would size its own columns). The spinner cell exists in every row
 *  — the animation only when that org is active — so names start flush. */
export function trayListHtml(rows: OrgActivityRow[] | null): string {
  const body = rows === null
    ? '<div class="empty">The organization list is unavailable.</div>'
    : rows.length === 0
      ? '<div class="empty">No organizations yet.</div>'
      : '<div class="list">' + rows.map(r =>
        `<a class="row" href="${TRAY_NAV_PREFIX}${escapeHtml(r.slug)}"` +
        ` title="${escapeHtml(r.name)} — ${r.working} active / ${r.live} hired">` +
        `<span class="act">${r.working > 0 ? '<span class="spin"></span>' : ''}</span>` +
        `<span class="name">${escapeHtml(r.name)}</span>` +
        `<span class="ct">${r.working}/${r.live}</span></a>`).join('') + '</div>'
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<style>' +
    ':root{color-scheme:dark}*{box-sizing:border-box;margin:0;padding:0}' +
    'html,body{background:#181818;color:#dedede;overflow-x:hidden}' +
    'body{font:13px \'Segoe UI\',system-ui,sans-serif;border:1px solid #333;padding:5px}' +
    `.list{display:grid;grid-template-columns:18px minmax(0,1fr) max-content;align-items:center;line-height:${TRAY_ROW_H - 10}px}` +
    '.row{display:contents;color:inherit;text-decoration:none;cursor:default}' +
    '.row>span{padding:5px 5px;white-space:nowrap}' +
    '.row:hover>span{background:#2c2c2c}' +
    '.name{overflow:hidden;text-overflow:ellipsis}' +
    '.ct{text-align:right;font-variant-numeric:tabular-nums;color:#9a9a9a}' +
    '.act{display:inline-flex;align-items:center;justify-content:center}' +
    '.spin{display:inline-block;width:10px;height:10px;border:2px solid #4f8aef;border-top-color:transparent;border-radius:50%;animation:s .9s linear infinite}' +
    '@keyframes s{to{transform:rotate(360deg)}}' +
    '.empty{padding:9px 7px;color:#9a9a9a}' +
    '</style></head><body>' + body + '</body></html>'
}

/** Where the popup goes: horizontally centred on the tray icon, above it when
 *  the taskbar is at the bottom (the normal case), below when there is no
 *  room above — always clamped inside the icon's display work area. */
export function popupBounds(anchor: Rect, workArea: Rect, rowCount: number): Rect {
  const height = Math.min(
    Math.max(rowCount, 1) * TRAY_ROW_H + TRAY_LIST_PAD,
    Math.max(TRAY_ROW_H + TRAY_LIST_PAD, Math.round(workArea.height * 0.6)))
  const width = TRAY_LIST_W
  let x = Math.round(anchor.x + anchor.width / 2 - width / 2)
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))
  let y = anchor.y - height - 4
  if (y < workArea.y) y = anchor.y + anchor.height + 4
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))
  return { x, y: Math.round(y), width, height }
}
