// Observation only, injected before the production bundle. No React/state/API substitute.
// Stringified into the browser; keep every dependency inside this function.
export function installHookTrace() {
  const now = () => performance.timeOrigin + performance.now()
  const native = { fetch: window.fetch, json: Response.prototype.json, ws: window.WebSocket,
    timeout: window.setTimeout, interval: window.setInterval,
    clearTimeout: window.clearTimeout, clearInterval: window.clearInterval }
  const responses = new WeakMap(), timers = new Map(), stacks = new Map()
  const rows = [], errors = []
  let sequence = 0, request = 0, socket = 0, timer = 0, context = null, totalBytes = 0
  const counts = {}
  function record(kind, fields = {}) {
    if (errors.length) return
    const row = { seq: ++sequence, at: now(), kind, ...fields }
    const bytes = new TextEncoder().encode(JSON.stringify(row)).length
    if (rows.length >= 100000 || totalBytes + bytes > 256 * 1024 * 1024) {
      errors.push('hook trace exceeded its row/256MiB budget'); return
    }
    totalBytes += bytes; counts[kind] = (counts[kind] || 0) + 1; rows.push(row)
  }
  function stack() {
    const text = new Error().stack || ''
    let id = stacks.get(text)
    if (!id) { id = stacks.size + 1; stacks.set(text, id); record('stack', { id, text }) }
    return id
  }
  function url(value) {
    const u = new URL(value, location.href)
    for (const key of [...u.searchParams.keys()]) if (/token|password|secret|key/i.test(key)) u.searchParams.set(key, '<redacted>')
    return u.pathname + u.search
  }
  window.fetch = function(input, init) {
    const id = ++request, path = url(typeof input === 'string' || input instanceof URL ? input : input.url)
    record('http-start', { id, path, method: init?.method || input?.method || 'GET', context, stack: stack() })
    return native.fetch.apply(this, arguments).then(response => {
      responses.set(response, id)
      record('http-response', { id, status: response.status, etag: response.headers.get('etag'),
        sync_rev: response.headers.get('x-orgtree-sync-rev'), org_rev: response.headers.get('x-orgtree-org-rev') })
      return response
    }, error => { record('http-error', { id, error: String(error) }); throw error })
  }
  Response.prototype.json = function() {
    const id = responses.get(this)
    return native.json.apply(this, arguments).then(body => {
      if (id) record('http-json', { id, ...(body && typeof body === 'object' ? {
        busy: body.busy, sync_rev: body.sync_rev, revision: body.revision,
        format: body.format, truncated: body.truncated, next_offset: body.next_offset } : {}) })
      return body
    }, error => { if (id) record('http-json-error', { id, error: String(error) }); throw error })
  }
  window.WebSocket = class extends native.ws {
    constructor(...args) {
      super(...args)
      const id = ++socket
      record('ws-create', { id, path: url(args[0]) })
      this.addEventListener('open', () => record('ws-open', { id }))
      this.addEventListener('close', e => record('ws-close', { id, code: e.code, reason: e.reason }))
      this.addEventListener('error', () => record('ws-error', { id }))
      this.addEventListener('message', e => {
        if (typeof e.data !== 'string') { errors.push('non-text WS frame cannot be replayed'); return }
        // Retain the complete frame, including ignored mail and non-target nodes.
        record('ws-frame', { id, data: e.data })
      })
    }
  }
  function schedule(repeat, callback, delay, ...args) {
    const id = ++timer, creator = stack(), parent = context
    // String callbacks are untouched, and explicitly invalidate the replay.
    if (typeof callback !== 'function') {
      errors.push('string timer callback cannot be traced')
      return (repeat ? native.interval : native.timeout).call(window, callback, delay, ...args)
    }
    let handle
    const wrapped = function(...values) {
      const previous = context
      context = { timer: id }
      record('timer-fire', { id })
      try { return callback.apply(this, values) }
      finally {
        record('timer-return', { id }); context = previous
        if (!repeat) timers.delete(handle)
      }
    }
    handle = (repeat ? native.interval : native.timeout).call(window, wrapped, delay, ...args)
    timers.set(handle, id)
    record('timer-create', { id, delay: Number(delay) || 0, repeat, stack: creator, parent })
    return handle
  }
  window.setTimeout = (callback, delay, ...args) => schedule(false, callback, delay, ...args)
  window.setInterval = (callback, delay, ...args) => schedule(true, callback, delay, ...args)
  for (const name of ['clearTimeout', 'clearInterval']) window[name] = function(handle) {
    const id = timers.get(handle)
    if (id) { record('timer-clear', { id }); timers.delete(handle) }
    return native[name].call(window, handle)
  }
  document.addEventListener('visibilitychange', () => record('visibility', { hidden: document.hidden }))
  window.__hookTrace = {
    mark: (name, detail = {}) => record('phase', { name, detail }),
    drain: () => ({ rows: rows.splice(0), errors: [...errors], counts: { ...counts }, totalBytes, lastSequence: sequence }),
  }
  record('installed', { hidden: document.hidden, href: url(location.href) })
}
