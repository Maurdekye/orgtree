/** Existing renderer-owned routes; executable artifacts are never app documents. */
export function isAppPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html' || /^\/o\/[a-z0-9@-]+$/.test(pathname)
}
